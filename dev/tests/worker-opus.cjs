/* Node test: Opus audio inside a Matroska/WebM container must decode. This
   guards the codec set of the linked wasm build: a configure without
   libswresample silently drops every decoder that depends on it (Opus
   among them), which only surfaces as "the codec is not supported" when a
   file is opened while every other format keeps working.

   The sample is the Chromium media test clip (VP9 video + Opus audio); a
   real video stream stays in the file so that the stream selection has to
   pick the audio one out of two, like the user files that reported the
   regression. It is cached in /tmp/opencode/sample-opus.webm.

   Run: node dev/tests/worker-opus.cjs */

const fs = require('node:fs');
const https = require('node:https');
const {makeFile, startWorker} = require('./fake-worker.cjs');

const SAMPLE = '/tmp/opencode/sample-opus.webm';
const SOURCE = 'https://raw.githubusercontent.com/chromium/chromium/main/media/test/data/bear-vp9-opus.webm';

const download = (url, redirects = 3) => new Promise((resolve, reject) => {
  https.get(url, r => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects) {
      r.resume();
      return resolve(download(r.headers.location, redirects - 1));
    }
    if (r.statusCode !== 200) {
      r.resume();
      return reject(Error('HTTP_' + r.statusCode));
    }
    const chunks = [];
    r.on('data', c => chunks.push(c));
    r.on('end', () => resolve(Buffer.concat(chunks)));
  }).on('error', reject);
});

const run = async () => {
  let bytes;
  try {
    bytes = new Uint8Array(fs.readFileSync(SAMPLE));
  }
  catch (e) {
    try {
      console.log('sample missing; downloading it once from', SOURCE);
      bytes = new Uint8Array(await download(SOURCE));
      fs.mkdirSync('/tmp/opencode', {recursive: true});
      fs.writeFileSync(SAMPLE, bytes);
    }
    catch (e2) {
      console.log('cannot download the sample (' + e2.message + '); run first:');
      console.log('  curl -sL -o ' + SAMPLE + ' "' + SOURCE + '"');
      process.exit(2);
    }
  }

  const w = startWorker();

  /* open the webm as a file input (the dropped-file scenario) */
  w.post({cmd: 'open', id: 1, file: makeFile(bytes)});
  const opened = await w.until(
    m => m.id === 1 && (m.type === 'meta' || m.type === 'error'), 30000
  );
  if (opened.type === 'error') {
    throw Error('the decoder rejected the file: ' + opened.error);
  }

  const meta = opened.meta;
  if (meta['Codec Name'] !== 'opus') {
    throw Error('the audio stream is "' + meta['Codec Name'] + '", expected opus');
  }
  if (meta['Sample Rate'] !== 48000) {
    throw Error('unexpected opus sample rate: ' + meta['Sample Rate']);
  }
  if (!meta['Channels']) {
    throw Error('unexpected channel count: ' + JSON.stringify(meta));
  }
  if (!meta['Duration'] || Math.abs(meta['Duration'] - 2.736) > 0.5) {
    throw Error('unexpected duration: ' + meta['Duration']);
  }
  console.log('opus open ok:', meta['Codec Name'], 'rate', meta['Sample Rate'],
    'channels', meta['Channels'], 'duration', meta['Duration'].toFixed(3));

  /* pull the first two seconds; the chunks must tile the window without
     gaps and carry actual audio (not uniformly silent bytes) */
  w.post({cmd: 'pull', id: 1, until: 2});
  const pulled = await w.until(m => m.id === 1 && m.type === 'pulled', 30000);
  if (pulled.covered < 2) {
    throw Error('the pull covered only ' + pulled.covered);
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
  if (total < meta['Sample Rate']) {
    throw Error('only ' + total + ' samples decoded');
  }
  let peak = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.channels[0].length; i += 7) {
      peak = Math.max(peak, Math.abs(c.channels[0][i]));
    }
  }
  if (peak < 0.01) {
    throw Error('the decoded audio is silent (peak ' + peak + ')');
  }
  console.log('opus window ok:', chunks.length, 'chunks,', total, 'samples, peak', peak.toFixed(3));

  /* seek into the middle of the track; pull to the end of the track so
     that the pending coalescing chunk is flushed and the drain reports
     done (a pull stops at its coverage without posting its tail) */
  w.post({cmd: 'seek', id: 1, to: 1.0});
  const seeked = await w.until(m => m.id === 1 && m.type === 'seeked', 30000);
  if (seeked.epoch !== 1) {
    throw Error('the seek did not change the epoch');
  }
  w.post({cmd: 'pull', id: 1, until: meta['Duration']});
  const drained = await w.until(
    m => m.id === 1 && m.type === 'pulled' && m.done === true, 30000
  );
  const afterSeek = w.of('chunk').filter(c => c.epoch === 1);
  if (!afterSeek.length) {
    throw Error('no chunks after the seek');
  }
  /* the demuxer lands on the cue point at or below the target */
  if (Math.abs(afterSeek[0].pos - 1.0) > 0.06) {
    throw Error('seek(1.0) landed at ' + afterSeek[0].pos);
  }
  let p = afterSeek[0].pos + afterSeek[0].samples / afterSeek[0].sampleRate;
  for (const c of afterSeek.slice(1)) {
    if (Math.abs(c.pos - p) > 0.05) {
      throw Error('the post-seek chunks are not contiguous: ' + c.pos + ' after ' + p);
    }
    p = c.pos + c.samples / c.sampleRate;
  }
  if (Math.abs(drained.covered - meta['Duration']) > 0.25) {
    throw Error('the track drained to ' + drained.covered + ' instead of ' + meta['Duration']);
  }
  console.log('opus seek ok: landed at', afterSeek[0].pos.toFixed(3),
    ', drained to', drained.covered.toFixed(3));

  w.post({cmd: 'close', id: 1});
  await w.until(m => m.id === 1 && m.type === 'closed');

  console.log('WORKER OPUS TEST PASSED');
};

run().catch(e => {
  console.error('WORKER OPUS TEST FAILED:', e.message);
  process.exit(1);
});
