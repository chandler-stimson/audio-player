/* Node test: drives the streaming session protocol of the real worker.js
   against the checked-in wasm decoder. What is verified:

     - open of a buffer input: meta with Duration / Sample Rate / Channels
     - pull until a horizon: the chunks carry contiguous positions and the
       coverage stops near the horizon instead of running to the track end
     - seek: the epoch changes and the decode continues from the target
     - the full drain reports done
     - close frees the session; a second open on the same worker works
     - the legacy whole-file (batch) message still decodes the input
     - a file input (Blob-like slices) feeds the decoder on demand
     - an unreadable input fails with the demuxer message

   Run: node dev/tests/worker-stream.cjs */

const {makeFile, startWorker} = require('./fake-worker.cjs');
const {expectedSample, makeWav} = require('./harness.cjs');

/* ----------------------------------------------------------------------- run */

const run = async () => {
  const wav = makeWav(3);
  const w = startWorker();

  /* open a buffer input */
  w.post({cmd: 'open', id: 1, arrayBuffer: wav.buffer.slice(0)});

  const metaMsg = await w.until(m => m.id === 1 && m.type === 'meta');
  if (metaMsg.meta['Sample Rate'] !== 44100 || metaMsg.meta['Channels'] !== 2) {
    throw Error('unexpected stream meta: ' + JSON.stringify(metaMsg.meta));
  }
  if (Math.abs(metaMsg.meta['Duration'] - 3) > 0.01) {
    throw Error('unexpected duration: ' + metaMsg.meta['Duration']);
  }
  console.log('open ok:', JSON.stringify(metaMsg.meta['Codec Name']), 'duration', metaMsg.meta['Duration']);

  /* pull a window: the coverage must stop near the horizon, not at the end */
  w.post({cmd: 'pull', id: 1, until: 1.5});
  const pulled = await w.until(m => m.id === 1 && m.type === 'pulled');

  if (pulled.covered < 1.5 || pulled.covered >= 3) {
    throw Error('a pull until 1.5s covered ' + pulled.covered);
  }
  const chunks1 = w.of('chunk');
  if (chunks1.length < 1) {
    throw Error('no chunks were posted');
  }
  let pos = 0;
  for (const c of chunks1) {
    if (Math.abs(c.pos - pos) > 0.01) {
      throw Error('chunk position ' + c.pos + ' does not continue at ' + pos);
    }
    if (c.channels.length !== 2 || c.channels[0].length !== c.samples) {
      throw Error('bad chunk shape: ' + c.samples + ' samples, ' + c.channels.length + ' channels');
    }
    // the first sample of the chunk must match the synthesized wave
    const want = expectedSample(Math.round(c.pos * 44100), 0);
    if (Math.abs(c.channels[0][0] - want) > 0.001) {
      throw Error('pcm mismatch at the chunk start: ' + c.channels[0][0] + ' vs ' + want);
    }
    pos = c.pos + c.samples / c.sampleRate;
  }
  console.log('window ok: covered', pulled.covered, 'in', chunks1.length, 'chunks, done =', pulled.done);

  /* seek into the middle: the epoch changes and the decode continues there */
  w.post({cmd: 'seek', id: 1, to: 2});
  const seeked = await w.until(m => m.id === 1 && m.type === 'seeked');
  if (seeked.epoch !== 1) {
    throw Error('expected epoch 1 after the first seek, got ' + seeked.epoch);
  }

  const before = w.messages.length;
  w.post({cmd: 'pull', id: 1, until: 3});
  const drained = await w.until(m => m.id === 1 && m.type === 'pulled' && m.done === true);
  const afterSeek = w.messages.slice(before).filter(({msg}) => msg.type === 'chunk').map(({msg}) => msg);
  if (!afterSeek.length) {
    throw Error('no chunks after the seek');
  }
  if (Math.abs(afterSeek[0].pos - 2) > 0.05) {
    throw Error('the first chunk after seek(2.0) starts at ' + afterSeek[0].pos);
  }
  if (Math.abs(drained.covered - 3) > 0.05) {
    throw Error('the drain covered ' + drained.covered);
  }
  console.log('seek ok: epoch', seeked.epoch, 'chunk at', afterSeek[0].pos.toFixed(3), 'drained to', drained.covered.toFixed(3));

  /* close and reopen the same worker */
  w.post({cmd: 'close', id: 1});
  await w.until(m => m.id === 1 && m.type === 'closed');
  console.log('close ok');

  /* a file input feeds the decoder through slices of the input */
  w.post({cmd: 'open', id: 10, file: makeFile(wav)});
  const meta10 = await w.until(m => m.id === 10 && m.type === 'meta');
  if (meta10.meta['Sample Rate'] !== 44100) {
    throw Error('file-input open failed: ' + JSON.stringify(meta10));
  }
  w.post({cmd: 'pull', id: 10, until: 0.5});
  const pulled10 = await w.until(m => m.id === 10 && m.type === 'pulled');
  if (pulled10.covered < 0.5 || pulled10.done) {
    throw Error('file-input pull covered ' + pulled10.covered + ' done ' + pulled10.done);
  }
  w.post({cmd: 'close', id: 10});
  await w.until(m => m.id === 10 && m.type === 'closed');
  console.log('file input ok: covered', pulled10.covered.toFixed(2));

  /* the legacy whole-file message still decodes (the small-input path) */
  w.post({name: 'input', binary: wav, id: 20});
  const batch = await w.until(m => m.id === 20 && (m.channels || m.error));
  if (batch.error) {
    throw Error('batch decode failed: ' + batch.error);
  }
  if (batch.channels.length !== 2 || batch.channels[0].length !== 3 * 44100) {
    throw Error('batch decode produced ' + batch.channels.length + ' channels of ' +
      (batch.channels[0] ? batch.channels[0].length : 0) + ' samples');
  }
  const s0 = batch.channels[0][100];
  const want0 = expectedSample(100, 0);
  if (Math.abs(s0 - want0) > 0.001) {
    throw Error('batch pcm mismatch: ' + s0 + ' vs ' + want0);
  }
  console.log('batch regression ok:', batch.channels[0].length, 'samples per channel');

  /* an unreadable input reports the demuxer failure */
  const garbage = new Uint8Array(1024);
  w.post({cmd: 'open', id: 30, arrayBuffer: garbage.buffer.slice(0)});
  const failed = await w.until(m => m.id === 30 && m.type === 'error');
  if (!failed.error) {
    throw Error('a garbage input opened: ' + JSON.stringify(failed));
  }
  console.log('failure path ok:', failed.error);

  console.log('WORKER STREAM TEST PASSED');
};

run().catch(e => {
  console.error('WORKER STREAM TEST FAILED:', e.message);
  process.exit(1);
});
