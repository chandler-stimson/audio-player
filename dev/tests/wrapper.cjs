/* Node test: the real wrapper.js end to end. The fake Worker class runs the
   real worker.js (which loads the real wasm) inside a vm context and
   bridges its messages to the wrapper exactly like a browser worker does.
   This is the layer that was missing coverage when the input descriptor of
   an open command got dropped on the way to the worker. What is verified:

     - decoder.open posts the input descriptor; the session resolves with
       its meta (the regression: this failed with EMPTY_INPUT)
     - pullUntil delivers the chunks through onchunk and reports coverage
     - seek changes the epoch; the chunks of the old epoch are dropped
     - close frees the slot; the worker serves a second session afterwards
     - the batch decode() still resolves an AudioBuffer
     - a new open preempts the running session: its pending commands reject
       with CANCELED and its onstop fires

   Run: node dev/tests/wrapper.cjs */

const {loadWrapper, makeWav} = require('./harness.cjs');

/* the AudioContext of the wrapper context records the AudioBuffers that the
   batch path builds, so the test can verify the copy */
const makeDecoder = () => {
  const buffers = [];
  class AudioContext {
    createBuffer(channels, length, sampleRate) {
      const buffer = {
        numberOfChannels: channels,
        length,
        sampleRate,
        duration: length / sampleRate,
        copied: [],
        copyToChannel(ch, c) {
          this.copied.push({c, length: ch.length});
        }
      };
      buffers.push(buffer);
      return buffer;
    }
  }
  const decoder = loadWrapper({AudioContext});
  return {decoder, buffers};
};

/* ----------------------------------------------------------------------- run */

const run = async () => {
  const wav = makeWav(3);
  const {decoder, buffers} = makeDecoder();

  /* open a streaming session: the descriptor must reach the worker */
  const chunks = [];
  const stopped = [];
  const session = await decoder.open({
    arrayBuffer: wav.buffer.slice(0),
    owner: 'user',
    onchunk: c => chunks.push(c),
    onstop: e => stopped.push(e.message)
  });

  if (!session.meta || session.meta['Sample Rate'] !== 44100 ||
      Math.abs(session.meta['Duration'] - 3) > 0.01) {
    throw Error('the open did not resolve with the stream meta: ' +
      JSON.stringify(session.meta));
  }
  console.log('open ok:', session.meta['Codec Name'], 'duration', session.meta['Duration']);

  /* pull a window through the session */
  const pulled = await session.pullUntil(2);
  if (pulled.covered < 2 || pulled.done) {
    throw Error('the pull covered ' + pulled.covered + ' done ' + pulled.done);
  }
  if (!chunks.length) {
    throw Error('no chunks were delivered through onchunk');
  }
  let pos = 0;
  for (const c of chunks) {
    if (Math.abs(c.pos - pos) > 0.01) {
      throw Error('chunk at ' + c.pos + ' does not continue at ' + pos);
    }
    pos = c.pos + c.samples / c.sampleRate;
  }
  console.log('pull ok:', chunks.length, 'chunks, covered', pulled.covered.toFixed(2));

  /* seek: the epoch changes and the stale chunks are dropped */
  const seeked = await session.seek(2);
  if (seeked.epoch !== 1) {
    throw Error('the seek reported epoch ' + seeked.epoch);
  }
  const stale = chunks.length;
  const drained = await session.pullUntil(3);
  if (!drained.done) {
    throw Error('the drain is not done: ' + JSON.stringify(drained));
  }
  if (chunks.length <= stale) {
    throw Error('the post-seek chunks were not delivered');
  }
  if (Math.abs(chunks[stale].pos - 2) > 0.05) {
    throw Error('the first post-seek chunk is at ' + chunks[stale].pos);
  }
  console.log('seek ok: epoch', seeked.epoch, 'resumed at', chunks[stale].pos.toFixed(3), 'drained to', drained.covered.toFixed(2));

  /* close frees the slot for the next session of the worker */
  await session.close();
  const second = await decoder.open({
    arrayBuffer: wav.buffer.slice(0),
    owner: 'user'
  });
  if (!second.meta || second.meta['Sample Rate'] !== 44100) {
    throw Error('the second open did not resolve: ' + JSON.stringify(second.meta));
  }
  await second.close();
  console.log('close + reopen ok');

  /* the batch decode still resolves an AudioBuffer */
  const decoded = await decoder.decode({
    name: 'input',
    arrayBuffer: wav.buffer.slice(0),
    owner: 'user'
  });
  if (!decoded.audioBuffer || decoded.audioBuffer.length !== 3 * 44100 ||
      decoded.audioBuffer.numberOfChannels !== 2) {
    throw Error('the batch decode produced ' + JSON.stringify(decoded.audioBuffer &&
      {length: decoded.audioBuffer.length, channels: decoded.audioBuffer.numberOfChannels}));
  }
  if (!buffers.some(b => b.length === 3 * 44100)) {
    throw Error('the batch result was not copied into an AudioBuffer');
  }
  console.log('batch ok:', decoded.audioBuffer.length, 'samples,',
    decoded.audioBuffer.numberOfChannels, 'channels');

  /* a new open preempts the running session: pending commands reject with
     CANCELED and its onstop fires */
  const aChunks = [];
  const aStopped = [];
  const a = await decoder.open({
    arrayBuffer: wav.buffer.slice(0),
    owner: 'user',
    onchunk: c => aChunks.push(c),
    onstop: e => aStopped.push(e.message)
  });
  // the rejection handler must be attached right away: the preemption that
  // cancels this pull happens while the next open is awaited
  let canceled = '';
  const aPull = a.pullUntil(3).then(() => {}, e => {
    canceled = e.message;
  });

  const b = await decoder.open({
    arrayBuffer: wav.buffer.slice(0),
    owner: 'user'
  });
  if (!b.meta) {
    throw Error('the superseding open did not resolve');
  }

  await aPull;
  if (canceled !== 'CANCELED') {
    throw Error('the preempted pull rejected with "' + canceled + '"');
  }
  if (!aStopped.length || aStopped[0] !== 'CANCELED') {
    throw Error('the preempted session did not report its stop: ' + JSON.stringify(aStopped));
  }
  await b.close();
  console.log('preempt ok: pull rejected "' + canceled + '", onstop fired');

  /* cancel(owner) drops a queued session without occupying the slot */
  const c = decoder.open({
    arrayBuffer: wav.buffer.slice(0),
    owner: 'meta'
  });
  decoder.cancel('meta');
  let cancelError = '';
  try {
    await c;
  }
  catch (e) {
    cancelError = e.message;
  }
  if (cancelError !== 'CANCELED') {
    throw Error('the canceled open rejected with "' + cancelError + '"');
  }
  console.log('cancel ok: open rejected "' + cancelError + '"');

  console.log('WRAPPER TEST PASSED');
};

run().catch(e => {
  console.error('WRAPPER TEST FAILED:', e.message);
  process.exit(1);
});
