/* Node test: the streaming protocol against a real interleaved MP4 (H.264
   video + AAC audio). The audio packets sit between video packets in the
   file, so every decoded chunk exercises the demuxer's per-sample seeks,
   and the audio stream must be picked out of two streams.

   The sample is the Sintel trailer (Blender Foundation, cc-by 3.0); it is
   cached in /tmp/opencode/sample.mp4.

   Run: node dev/tests/worker-mp4.cjs */

const fs = require('node:fs');
const {makeFile, startWorker} = require('./fake-worker.cjs');

const SAMPLE = '/tmp/opencode/sample.mp4';
const SOURCE = 'https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4';

/* the AAC frames are 1024 samples long; a seek may land up to one frame
   before the target */
const SEEK_TOLERANCE = 1024 / 44100 + 0.05;
const run = async () => {
  let bytes;
  try {
    bytes = new Uint8Array(fs.readFileSync(SAMPLE));
  }
  catch (e) {
    console.log('sample missing (' + e.message + '); run the download first:');
    console.log('  curl -sL -o ' + SAMPLE + ' "' + SOURCE + '"');
    process.exit(2);
  }

  const w = startWorker();

  /* open the mp4 as a file input (the dropped-file scenario) */
  w.post({cmd: 'open', id: 1, file: makeFile(bytes)});
  const meta = await w.until(m => m.id === 1 && m.type === 'meta', 30000);

  const duration = meta.meta['Duration'];
  if (!duration || duration < 5) {
    throw Error('unexpected mp4 duration: ' + duration);
  }
  if (!meta.meta['Channels'] || !meta.meta['Sample Rate']) {
    throw Error('unexpected stream selection: ' + JSON.stringify(meta.meta));
  }
  const rate = meta.meta['Sample Rate'];
  console.log('mp4 open ok:', meta.meta['Codec Name'], 'duration', duration.toFixed(2),
    'rate', rate, 'channels', meta.meta['Channels']);

  /* pull the first seconds of audio out of the interleaved packets; the
     trailer begins with a fade-in, so the window must reach the music */
  w.post({cmd: 'pull', id: 1, until: 8});
  const pulled = await w.until(m => m.id === 1 && m.type === 'pulled', 30000);
  if (pulled.covered < 8) {
    throw Error('the mp4 pull covered only ' + pulled.covered);
  }
  const chunks = w.of('chunk');
  let pos = 0;
  let total = 0;
  for (const c of chunks) {
    if (Math.abs(c.pos - pos) > 0.05) {
      throw Error('chunk at ' + c.pos + ' does not continue at ' + pos);
    }
    pos = c.pos + c.samples / c.sampleRate;
    total += c.samples;
  }
  // a pull can leave the last coalescing chunk pending; the first chunk of
  // the window must have been delivered though
  if (total < rate) {
    throw Error('only ' + total + ' samples decoded in the first window');
  }
  // a synthesized test tone does not exist here; the decoded audio must
  // not be uniformly silent though (the sample carries a real soundtrack)
  let peak = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.channels[0].length; i += 97) {
      peak = Math.max(peak, Math.abs(c.channels[0][i]));
    }
  }
  if (peak < 0.01) {
    throw Error('the decoded audio is silent (peak ' + peak + ')');
  }
  console.log('mp4 window ok:', chunks.length, 'chunks,', total, 'samples, peak', peak.toFixed(3));

  /* seek into the second half */
  const target = Math.min(5, duration / 2);
  w.post({cmd: 'seek', id: 1, to: target});
  const seeked = await w.until(m => m.id === 1 && m.type === 'seeked', 30000);
  if (seeked.epoch !== 1) {
    throw Error('the seek did not change the epoch');
  }

  const before = w.messages.length;
  w.post({cmd: 'pull', id: 1, until: duration});
  const drained = await w.until(m => m.id === 1 && m.type === 'pulled' && m.done === true, 60000);
  const afterSeek = w.messages.slice(before).filter(({msg}) => msg.type === 'chunk').map(({msg}) => msg);
  if (!afterSeek.length) {
    throw Error('no chunks after the mp4 seek');
  }
  if (Math.abs(afterSeek[0].pos - target) > SEEK_TOLERANCE) {
    throw Error('seek(' + target + ') landed at ' + afterSeek[0].pos);
  }
  let p = afterSeek[0].pos + afterSeek[0].samples / afterSeek[0].sampleRate;
  for (const c of afterSeek.slice(1)) {
    if (Math.abs(c.pos - p) > 0.05) {
      throw Error('the post-seek chunks are not contiguous: ' + c.pos + ' after ' + p);
    }
    p = c.pos + c.samples / c.sampleRate;
  }
  if (Math.abs(drained.covered - duration) > 0.5) {
    throw Error('the mp4 drained to ' + drained.covered + ' instead of ' + duration);
  }
  console.log('mp4 seek ok: landed at', afterSeek[0].pos.toFixed(3), '(target', target +
    '), drained to', drained.covered.toFixed(2));

  w.post({cmd: 'close', id: 1});
  await w.until(m => m.id === 1 && m.type === 'closed');

  console.log('WORKER MP4 TEST PASSED');
};

run().catch(e => {
  console.error('WORKER MP4 TEST FAILED:', e.message);
  process.exit(1);
});
