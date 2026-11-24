/** FFmpeg-based audio decoder used by the Audio Player extension.
 *
 * Derived from https://github.com/chandler-stimson/decoder.js (0.1.2)
 *
 * Changes over the original:
 *   1. batch output is buffered; the original performed one `fwrite` per
 *      single 4-byte sample, which dominated the decode time of large files
 *      (a 1h stereo track issued ~300M tiny writes)
 *   2. an incremental streaming API (decoder_open / decoder_pull /
 *      decoder_seek / decoder_close) is fed through JS callbacks, so that
 *      playback can start long before the whole file is downloaded and
 *      decoded
 *   3. the use-after-free of `codecCtx` (its `channels` field was read after
 *      `avcodec_free_context`) and the missing `free(outFiles)` /
 *      PCM buffer releases were fixed
 *
 * JS contract of the streaming API (all callbacks are optional except
 * readInput/inputReady/onpcm):
 *   Module.readInput(ptr, size) -> int  number of bytes copied into the wasm
 *        heap at `ptr` (0 = nothing available right now, negative = EOF)
 *   Module.inputReady() -> bool    true when readInput can return bytes or
 *        the input reached EOF
 *   Module.seekInput(offset, whence) -> double   new position or negative;
 *        whence is SEEK_SET(0)/SEEK_CUR(1)/SEEK_END(2) or AVSEEK_SIZE
 *        (0x10000, must return the total size of the input)
 *   Module.onpcm(ptr, samples, channels)   a decoded chunk, laid out planar:
 *        [channel 0 x `samples` floats][channel 1 x `samples` floats]...
 *
 * The batch entry point `decoder(filename)` is kept for compatibility; it
 * reads a file from the emscripten file system and writes `channel_N` files
 * exactly like version 0.1.2 did, only much faster.
**/

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include <emscripten.h>

#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>

#define C_CAST(type, variable) ((type)variable)
#define REINTERPRET_CAST(type, variable) C_CAST(type, variable)
#define STATIC_CAST(type, variable) C_CAST(type, variable)

/* return codes of the streaming API */
#define DECODER_HAVE_PCM    1  /* a chunk was emitted through Module.onpcm   */
#define DECODER_NEED_INPUT  2  /* the input queue is starved; feed more bytes */
#define DECODER_DONE        3  /* end of stream; all frames were emitted     */

/* batch mode write buffering */
#define PCM_BUFFER_FLOATS 8192

FILE **outFiles = NULL;        /* batch mode: one output file per channel   */
static float **pcmBuffers = NULL;
static int pcmBufferUsed = 0;  /* floats used in every per-channel buffer   */
static int pcmBufferChannels = 0;

/* streaming mode state */
static int streaming = 0;
static int draining = 0;       /* the demuxer hit EOF; drain the decoder     */
static float *scratch = NULL;  /* frame buffer handed to Module.onpcm      */
static size_t scratchFloats = 0;
static AVFormatContext *formatCtx = NULL;
static AVCodecContext *codecCtx = NULL;
static AVFrame *frame = NULL;
static AVPacket packet;
static int audioStreamIndex = -1;
static int channels = 0;
static AVIOContext *io = NULL;

void done(int code, const char *msg) {
    EM_ASM({
      Module.meta['Exit Message'] = UTF8ToString($1);
      Module.meta['Exit Code'] = $0;
    }, code, msg);

    /* in streaming mode the worker must stay alive */
    if (!streaming && code != 0) {
        exit(code);
    }
}

/**
 * Extract a single sample and convert to float.
 */
float getSample(const AVCodecContext* codecCtx, uint8_t* buffer, int sampleIndex) {
    int64_t val = 0;
    float ret = 0;
    int sampleSize = av_get_bytes_per_sample(codecCtx->sample_fmt);
    switch(sampleSize) {
        case 1:
            // 8bit samples are always unsigned
            val = REINTERPRET_CAST(uint8_t*, buffer)[sampleIndex];
            // make signed
            val -= 127;
            break;

        case 2:
            val = REINTERPRET_CAST(int16_t*, buffer)[sampleIndex];
            break;

        case 4:
            val = REINTERPRET_CAST(int32_t*, buffer)[sampleIndex];
            break;

        case 8:
            val = REINTERPRET_CAST(int64_t*, buffer)[sampleIndex];
            break;

        default:
            done(8, "invalid sample size");
            return 0;
    }

    // Check which data type is in the sample.
    switch(codecCtx->sample_fmt) {
        case AV_SAMPLE_FMT_U8:
        case AV_SAMPLE_FMT_S16:
        case AV_SAMPLE_FMT_S32:
        case AV_SAMPLE_FMT_U8P:
        case AV_SAMPLE_FMT_S16P:
        case AV_SAMPLE_FMT_S32P:
            // integer => Scale to [-1, 1] and convert to float.
            ret = val / STATIC_CAST(float, ((1 << (sampleSize*8-1))-1));
            break;

        case AV_SAMPLE_FMT_FLT:
        case AV_SAMPLE_FMT_FLTP:
            // float => reinterpret
            ret = *REINTERPRET_CAST(float*, &val);
            break;

        case AV_SAMPLE_FMT_DBL:
        case AV_SAMPLE_FMT_DBLP:
            // double => reinterpret and then static cast down
            ret = STATIC_CAST(float, *REINTERPRET_CAST(double*, &val));
            break;

        default:
            done(9, "invalid sample format");
            return 0;
    }

    return ret;
}

/* ------------------------------------------------------------------ batch mode */

static void flushChannels(void) {
    if (pcmBufferUsed > 0) {
        for (int c = 0; c < pcmBufferChannels; ++c) {
            fwrite(pcmBuffers[c], sizeof(float), pcmBufferUsed, outFiles[c]);
        }
        pcmBufferUsed = 0;
    }
}

static void pushSample(int channel, float sample) {
    if (pcmBufferUsed >= PCM_BUFFER_FLOATS) {
        flushChannels();
    }
    pcmBuffers[channel][pcmBufferUsed++] = sample;
}

/**
 * Buffer the frame and write it to the per-channel output files in blocks
 * instead of issuing one fwrite per single sample.
 */
void handleFrame(const AVCodecContext* codecCtx, const AVFrame* frame) {
    const int ch = codecCtx->channels;
    if (av_sample_fmt_is_planar(codecCtx->sample_fmt) == 1) {
        // The data of each channel is in its own buffer.
        // => frame->extended_data[i] contains data for the i-th channel.
        for(int s = 0; s < frame->nb_samples; ++s) {
            for(int c = 0; c < ch; ++c) {
                pushSample(c, getSample(codecCtx, frame->extended_data[c], s));
            }
        }
    } else {
        // The data of all channels is in the same buffer.
        // => frame->extended_data[0] contains interleaved data.
        for(int s = 0; s < frame->nb_samples; ++s) {
            for(int c = 0; c < ch; ++c) {
                pushSample(c, getSample(codecCtx, frame->extended_data[0], s * ch + c));
            }
        }
    }
    // do not carry samples across frame boundaries
    flushChannels();
}

/* -------------------------------------------------------------- streaming mode */

static int readCallback(void *opaque, uint8_t *buf, int buf_size) {
    return EM_ASM_INT({
      return Module.readInput($0, $1);
    }, buf, buf_size);
}

static int64_t seekCallback(void *opaque, int64_t offset, int whence) {
    /* positions are exchanged as doubles; every realistic media file is far
       below the 2^53 precision limit */
    return (int64_t)EM_ASM_DOUBLE({
      return Module.seekInput($0, $1);
    }, (double)offset, whence);
}

/**
 * Convert the frame to planar float32 in the scratch buffer and hand it to
 * the JS side through Module.onpcm.
 */
static void handleFrameStreaming(const AVCodecContext* cc, const AVFrame* fr) {
    const int nb = fr->nb_samples;
    const int ch = cc->channels;
    const int planar = av_sample_fmt_is_planar(cc->sample_fmt) == 1;
    const size_t need = (size_t)nb * (size_t)ch;

    if (scratchFloats < need) {
        free(scratch);
        scratch = malloc(need * sizeof(float));
        scratchFloats = scratch ? need : 0;
    }
    if (scratch == NULL) {
        done(12, "cannot allocate the pcm buffer");
        return;
    }

    for (int c = 0; c < ch; ++c) {
        float *dst = scratch + (size_t)c * (size_t)nb;
        uint8_t *src = planar ? fr->extended_data[c] : fr->extended_data[0];
        for (int s = 0; s < nb; ++s) {
            dst[s] = getSample(cc, src, planar ? s : s * ch + c);
        }
    }

    EM_ASM({
      Module.onpcm($0, $1, $2);
    }, scratch, nb, ch);
}

/**
 * Find the first audio stream and returns its index. If there is no audio
 * stream returns -1.
 */
int findAudioStream(const AVFormatContext* formatCtx) {
    int audioStreamIndex = -1;
    for(size_t i = 0; i < formatCtx->nb_streams; ++i) {
        // Use the first audio stream we can find.
        // NOTE: There may be more than one, depending on the file.
        if(formatCtx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
            audioStreamIndex = i;
            break;
        }
    }
    return audioStreamIndex;
}

/*
 * Print information about the input file and the used codec.
 */
void printStreamInformation(const AVCodec* codec, const AVCodecContext* codecCtx, int audioStreamIndex) {
    EM_ASM({
      Module.meta['Codec ID'] = $0;
    }, codec->id);
    EM_ASM({
      Module.meta['Codec Name'] = UTF8ToString($0);
    }, codec->name);
    EM_ASM({
      Module.meta['Codec Long Name'] = UTF8ToString($0);
    }, codec->long_name);
    EM_ASM({
      Module.meta['Stream Index'] = $0;
    }, audioStreamIndex);
    EM_ASM({
      Module.meta['Sample Format'] = UTF8ToString($0);
    }, av_get_sample_fmt_name(codecCtx->sample_fmt));
    EM_ASM({
      Module.meta['Sample Rate'] = $0;
    }, codecCtx->sample_rate);
    EM_ASM({
      Module.meta['Sample Size'] = $0;
    }, av_get_bytes_per_sample(codecCtx->sample_fmt));
    EM_ASM({
      Module.meta['Channels'] = $0;
    }, codecCtx->channels);
}

/**
 * Receive as many frames as available and handle them.
 */
int receiveAndHandle(AVCodecContext* codecCtx, AVFrame* frame) {
    int err = 0;
    // Read the packets from the decoder.
    // NOTE: Each packet may generate more than one frame, depending on the codec.
    while((err = avcodec_receive_frame(codecCtx, frame)) == 0) {
        // Let's handle the frame in a function.
        handleFrame(codecCtx, frame);
        // Free any buffers and reset the fields to default values.
        av_frame_unref(frame);
    }
    return err;
}

/**
 * Set up the decoder for the first audio stream of an already opened
 * AVFormatContext. Returns 0 on success and a non-zero error code that
 * matches the batch mode `done` codes otherwise.
 */
static int openCodec(AVFormatContext *fc, int streamIndex) {
    AVCodec* codec = avcodec_find_decoder(fc->streams[streamIndex]->codecpar->codec_id);
    if (codec == NULL) {
        return 3;
    }

    codecCtx = avcodec_alloc_context3(codec);
    if (codecCtx == NULL) {
        return 4;
    }

    if (avcodec_parameters_to_context(codecCtx, fc->streams[streamIndex]->codecpar) != 0) {
        avcodec_free_context(&codecCtx);
        return 5;
    }

    // Explicitly request non planar data.
    codecCtx->request_sample_fmt = av_get_alt_sample_fmt(codecCtx->sample_fmt, 0);

    if (avcodec_open2(codecCtx, codec, NULL) != 0) {
        avcodec_free_context(&codecCtx);
        return 6;
    }

    channels = codecCtx->channels;

    // Print some interesting file information.
    printStreamInformation(codec, codecCtx, streamIndex);

    frame = av_frame_alloc();
    if (frame == NULL) {
        avcodec_free_context(&codecCtx);
        return 7;
    }

    return 0;
}

/* -------------------------------------------------------- streaming entry points */

int decoder_open(void) {
    int err;

    streaming = 1;
    draining = 0;

    EM_ASM({
      Module.meta = {};

      Module.meta['LIBAVCODEC Version'] = $0 + '.' + $1 + '.' + $2;
    }, LIBAVCODEC_VERSION_MAJOR, LIBAVCODEC_VERSION_MINOR, LIBAVCODEC_VERSION_MICRO);
    EM_ASM({
      Module.meta['LIBAVFORMAT Version'] = $0 + '.' + $1 + '.' + $2;
    }, LIBAVFORMAT_VERSION_MAJOR, LIBAVFORMAT_VERSION_MINOR, LIBAVFORMAT_VERSION_MICRO);

    /* the input is provided by the JS side through readInput/seekInput */
    uint8_t *buffer = (uint8_t*)av_malloc(4096);
    if (buffer == NULL) {
        return 4;
    }
    io = avio_alloc_context(buffer, 4096, 0, NULL, readCallback, NULL, seekCallback);
    if (io == NULL) {
        av_free(buffer);
        return 4;
    }

    formatCtx = avformat_alloc_context();
    if (formatCtx == NULL) {
        av_free(buffer);
        av_freep(&io);
        return 4;
    }
    formatCtx->pb = io;
    formatCtx->flags |= AVFMT_FLAG_CUSTOM_IO;

    // Open the stream and read the header. The demuxer pulls the initial
    // bytes through readInput, so Module.inputReady must be true here.
    if ((err = avformat_open_input(&formatCtx, "", NULL, NULL)) != 0) {
        // on failure avformat_open_input frees the context
        formatCtx = NULL;
        av_free(buffer);
        av_freep(&io);
        done(1, "cannot open input file");
        return 1;
    }

    avformat_find_stream_info(formatCtx, NULL);

    audioStreamIndex = findAudioStream(formatCtx);
    if (audioStreamIndex == -1) {
        done(2, "none of the available streams are audio streams");
        return 2;
    }

    err = openCodec(formatCtx, audioStreamIndex);
    if (err != 0) {
        switch (err) {
            case 3: done(3, "the codec is not supported"); break;
            case 4: done(4, "could not allocate a decoding context"); break;
            case 5: done(5, "cannot set codec context parameters"); break;
            case 6: done(6, "cannot initialize the decoder"); break;
            default: done(7, "cannot allocate frame"); break;
        }
        return err;
    }

    // Prepare the packet.
    av_init_packet(&packet);
    packet.data = NULL;
    packet.size = 0;

    return 0;
}

/**
 * Decode until one of these happens:
 *   DECODER_HAVE_PCM   a chunk was emitted through Module.onpcm; call again
 *   DECODER_NEED_INPUT the input queue is starved; push more bytes first
 *   DECODER_DONE       the stream ended and the decoder is fully drained
 */
int decoder_pull(void) {
    if (!streaming || !codecCtx) {
        return DECODER_DONE;
    }

    while (1) {
        int err = avcodec_receive_frame(codecCtx, frame);
        if (err == 0) {
            handleFrameStreaming(codecCtx, frame);
            av_frame_unref(frame);
            return DECODER_HAVE_PCM;
        }
        if (err == AVERROR_EOF) {
            return DECODER_DONE;
        }
        if (err != AVERROR(EAGAIN)) {
            done(10, "receive error");
            return DECODER_DONE;
        }

        // The decoder wants a new packet.
        // Never block the worker on a starved input queue.
        int ready = EM_ASM_INT({
            return Module.inputReady();
        });
        if (!ready) {
            return DECODER_NEED_INPUT;
        }

        int readErr = av_read_frame(formatCtx, &packet);
        if (readErr == AVERROR_EOF) {
            if (!draining) {
                draining = 1;
                // Some codecs buffer frames; sending NULL activates drain mode.
                if (avcodec_send_packet(codecCtx, NULL) != 0) {
                    done(11, "send error");
                    return DECODER_DONE;
                }
            }
            else {
                return DECODER_DONE;
            }
            continue;
        }
        if (readErr != 0) {
            // unreadable packet; skip it and keep going
            av_packet_unref(&packet);
            continue;
        }

        if (packet.stream_index == audioStreamIndex) {
            int sendErr = avcodec_send_packet(codecCtx, &packet);
            av_packet_unref(&packet);
            if (sendErr != 0 && sendErr != AVERROR(EAGAIN)) {
                // undecodable packet; skip it and keep going
                continue;
            }
            // AVERROR(EAGAIN) means the decoder still has frames to release;
            // the next loop iteration receives them before reading again.
        }
        else {
            // Does not belong to the audio stream.
            av_packet_unref(&packet);
        }
    }
}

int decoder_seek(double seconds) {
    if (!streaming || !formatCtx || audioStreamIndex == -1) {
        return -1;
    }
    if (avformat_seek_file(formatCtx, audioStreamIndex,
            INT64_MIN, (int64_t)(seconds * AV_TIME_BASE), INT64_MAX, 0) < 0) {
        return -1;
    }
    avcodec_flush_buffers(codecCtx);
    draining = 0;
    return 0;
}

void decoder_close(void) {
    if (frame != NULL) {
        av_frame_free(&frame);
    }
    if (codecCtx != NULL) {
        avcodec_close(codecCtx);
        avcodec_free_context(&codecCtx);
    }
    if (formatCtx != NULL) {
        // with a custom pb the io context belongs to us
        AVIOContext *customIO = formatCtx->pb;
        avformat_close_input(&formatCtx);
        if (customIO != NULL) {
            av_free(customIO->buffer);
            av_freep(&customIO);
        }
    }
    io = NULL;
    free(scratch);
    scratch = NULL;
    scratchFloats = 0;
    streaming = 0;
    draining = 0;
    audioStreamIndex = -1;
    channels = 0;
}

/* ------------------------------------------------------------ batch entry point */

/**
 * Decode a file from the emscripten file system in one call and write the
 * `channel_N` files (kept for compatibility with the released 0.1.2 binary).
 */
int decoder(const char *filename) {
    int err = 0;
    const int wasStreaming = streaming;

    streaming = 0;

    EM_ASM({
      Module.meta = {};

      Module.meta['LIBAVCODEC Version'] = $0 + '.' + $1 + '.' + $2;
    }, LIBAVCODEC_VERSION_MAJOR, LIBAVCODEC_VERSION_MINOR, LIBAVCODEC_VERSION_MICRO);
    EM_ASM({
      Module.meta['LIBAVFORMAT Version'] = $0 + '.' + $1 + '.' + $2;
    }, LIBAVFORMAT_VERSION_MAJOR, LIBAVFORMAT_VERSION_MINOR, LIBAVFORMAT_VERSION_MICRO);

    formatCtx = NULL;
    // Open the file and read the header.
    if ((err = avformat_open_input(&formatCtx, filename, NULL, 0)) != 0) {
        done(1, "cannot open input file");
    }

    // In case the file had no header, read some frames and find out which format and codecs are used.
    // This does not consume any data. Any read packets are buffered for later use.
    avformat_find_stream_info(formatCtx, NULL);

    // Try to find an audio stream.
    audioStreamIndex = findAudioStream(formatCtx);
    if(audioStreamIndex == -1) {
        avformat_close_input(&formatCtx);
        avformat_free_context(formatCtx);
        done(2, "none of the available streams are audio streams");
    }

    // Find the correct decoder for the codec.
    AVCodec* codec = avcodec_find_decoder(formatCtx->streams[audioStreamIndex]->codecpar->codec_id);
    if (codec == NULL) {
        avformat_close_input(&formatCtx);
        avformat_free_context(formatCtx);
        done(3, "the codec is not supported");
    }

    // Initialize codec context for the decoder.
    codecCtx = avcodec_alloc_context3(codec);
    if (codecCtx == NULL) {
        // Something went wrong. Cleaning up...
        avformat_close_input(&formatCtx);
        avformat_free_context(formatCtx);
        done(4, "could not allocate a decoding context");
    }

    // Fill the codecCtx with the parameters of the codec used in the read file.
    if ((err = avcodec_parameters_to_context(codecCtx, formatCtx->streams[audioStreamIndex]->codecpar)) != 0) {
        // Something went wrong. Cleaning up...
        avcodec_close(codecCtx);
        avcodec_free_context(&codecCtx);
        avformat_close_input(&formatCtx);
        avformat_free_context(formatCtx);
        done(5, "cannot set codec context parameters");
    }

    // Explicitly request non planar data.
    codecCtx->request_sample_fmt = av_get_alt_sample_fmt(codecCtx->sample_fmt, 0);

    // Initialize the decoder.
    if ((err = avcodec_open2(codecCtx, codec, NULL)) != 0) {
        avcodec_close(codecCtx);
        avcodec_free_context(&codecCtx);
        avformat_close_input(&formatCtx);
        avformat_free_context(formatCtx);
        done(6, "cannot initialize the decoder");
    }

    // Print some interesting file information.
    printStreamInformation(codec, codecCtx, audioStreamIndex);

    channels = codecCtx->channels;

    // initialize output buffers; each file stores PCM data of its channel
    outFiles = malloc(channels * sizeof(FILE *));
    pcmBuffers = malloc(channels * sizeof(float *));
    pcmBufferUsed = 0;
    pcmBufferChannels = channels;
    for(int c = 0; c < channels; ++c) {
        char name[20];
        sprintf(name, "channel_%d", c);
        outFiles[c] = fopen(name, "w+");
        pcmBuffers[c] = malloc(PCM_BUFFER_FLOATS * sizeof(float));
    }

    frame = av_frame_alloc();
    if (frame == NULL) {
        done(7, "cannot allocate frame");
    }

    // Prepare the packet.
    // Set default values.
    av_init_packet(&packet);
    packet.data = NULL;
    packet.size = 0;

    while ((err = av_read_frame(formatCtx, &packet)) != AVERROR_EOF) {
        if(err != 0) {
            break; // Don't return, so we can clean up nicely.
        }
        // Does the packet belong to the correct stream?
        if(packet.stream_index != audioStreamIndex) {
            // Free the buffers used by the frame and reset all fields.
            av_packet_unref(&packet);
            continue;
        }
        // We have a valid packet => send it to the decoder.
        if((err = avcodec_send_packet(codecCtx, &packet)) == 0) {
            // The packet was sent successfully. We don't need it anymore.
            // => Free the buffers used by the frame and reset all fields.
            av_packet_unref(&packet);
        }
        else {
            // Something went wrong.
            // EAGAIN is technically no error here but if it occurs we would need to buffer
            // the packet and send it again after receiving more frames. Thus we handle it as an error here.
            break; // Don't return, so we can clean up nicely.
        }

        // Receive and handle frames.
        // EAGAIN means we need to send before receiving again. So thats not an error.
        if((err = receiveAndHandle(codecCtx, frame)) != AVERROR(EAGAIN)) {
            // Not EAGAIN => Something went wrong.
            break; // Don't return, so we can clean up nicely.
        }
    }
    if (err == AVERROR_EOF) {
      err = 0;
    }

    // Drain the decoder.
    // NOTE: the drain result must not overwrite `err`; it is normalized to 0
    // above and is what `done` reports as the exit code.
    {
        int drainErr;
        if(avcodec_send_packet(codecCtx, NULL) == 0) {
            // Read the remaining packets from the decoder.
            drainErr = receiveAndHandle(codecCtx, frame);
            if(drainErr != AVERROR(EAGAIN) && drainErr != AVERROR_EOF) {
                // Neither EAGAIN nor EOF => Something went wrong.
                done(10, "receive error");
            }
        }
        else {
            // Something went wrong.
            done(11, "send error");
        }
    }

    // Flush what is left in the write buffers.
    flushChannels();

    // Free all data used by the frame.
    av_frame_free(&frame);

    // Close the context and free all data associated with it, but not the
    // context itself and free the context itself.
    avcodec_close(codecCtx);
    avcodec_free_context(&codecCtx);

    // We are done here. Close the input.
    avformat_close_input(&formatCtx);
    avformat_free_context(formatCtx);

    // Close the outfiles and release the write buffers.
    // NOTE: `channels` is a copy; codecCtx is already freed here.
    for (int c = 0; c < channels; ++c) {
        fclose(outFiles[c]);
        free(pcmBuffers[c]);
    }
    free(outFiles);
    free(pcmBuffers);
    outFiles = NULL;
    pcmBuffers = NULL;
    pcmBufferUsed = 0;
    pcmBufferChannels = 0;

    done(err, "NA");
    streaming = wasStreaming;
    return 0;
}
