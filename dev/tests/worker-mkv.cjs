/* Node test: Matroska seeking when the seek index (the cues) references the
   video track only. Real-world encodes keep their cues for one stream, while
   the player demuxes the first audio one; seeking through the audio stream
   then has no index entries and ffmpeg falls back to a search that lands far
   away from the target, decodes from near the file start and reports a false
   end of stream that stopped the playback in the middle of the file. The
   cues of a large file also sit at its end, where the deferred index parse
   of the first seek needs bytes that the decode window had long evicted.

   The sample is the IETF Matroska test file test5.mkv (an h264 video track
   beside an aac audio one), cached in /tmp/opencode/sample-mkv-test5.mkv.
   Its cues are rewritten in place to reference the video track only (a Void
   keeps every later offset of the file where it was), so the audio stream
   has no index entries and every seek has to go through the video one.

   What is verified:

      - the file opens and the audio stream is decoded
      - a mid-file seek re-cues the decode at the seek target (within the
        one second granularity of the rewritten cues), not near the origin
      - the pull after the seek covers the requested window and does not
        report a false end of stream (done stays false before the end)
      - the full drain after the seeks reports done only at the real end

   Run: node dev/tests/worker-mkv.cjs */

const fs = require('node:fs');
const https = require('node:https');
const {makeFile, startWorker} = require('./fake-worker.cjs');

const SAMPLE = '/tmp/opencode/sample-mkv-test5.mkv';
const SOURCE = 'https://raw.githubusercontent.com/ietf-wg-cellar/matroska-test-files/master/test_files/test5.mkv';

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

/* ------------------------------------------------------------- ebml helpers */

/* an element id or a size; ids keep their marker bit, sizes do not */
const readVint = (b, p, id = false) => {
  let len = 1, mask = 0x80;
  while (len <= 8 && !(b[p] & mask)) {
    mask >>= 1;
    len += 1;
  }
  if (len > 8) {
    throw Error('EBML_VINT_TOO_LONG');
  }
  let v = id ? b[p] : (b[p] & (mask - 1));
  for (let i = 1; i < len; i += 1) {
    v = v * 256 + b[p + i];
  }
  return {v, len};
};

/* the unsigned value of an already located element */
const readUInt = (b, e) => {
  let v = 0;
  for (let p = e.data; p < e.next; p += 1) {
    v = v * 256 + b[p];
  }
  return v;
};

const encodeSize = n => {
  for (let len = 1; len <= 8; len += 1) {
    const max = 2 ** (7 * len) - 1;
    if (n < max) {
      const b = Buffer.alloc(len);
      for (let i = len - 1; i >= 0; i -= 1) {
        b[i] = n & 255;
        n >>= 8;
      }
      b[0] |= 1 << (8 - len);
      return b;
    }
  }
  throw Error('EBML_SIZE_TOO_LARGE');
};

/* the shortest big-endian byte form of a value */
const uintBytes = n => {
  let len = 1;
  while (n >= 2 ** (8 * len)) {
    len += 1;
  }
  const b = Buffer.alloc(len);
  for (let i = len - 1; i >= 0; i -= 1) {
    b[i] = n & 255;
    n >>= 8;
  }
  return b;
};

const element = (id, data) => Buffer.concat([id, encodeSize(data.length), data]);

/* the direct children of [start, end) */
const children = (b, start, end) => {
  const out = [];
  let p = start;
  while (p < end) {
    const id = readVint(b, p, true);
    const size = readVint(b, p + id.len);
    const data = p + id.len + size.len;
    const next = data + size.v;
    if (next > end) {
      break; // a truncated tail (a probe window) ends the scan
    }
    out.push({id: id.v, start: p, data, next});
    p = next;
  }
  return out;
};

/* ------------------------------------------------ the rewritten test file */

/* rebuild test5.mkv with cues that reference the video track only; the new
   cues element replaces the original one in place and a Void fills whatever
   is left of its room, so every other offset of the file stays untouched */
const rewriteCuesToVideo = original => {
  let p = 0;
  const headerId = readVint(original, p, true);
  const headerSize = readVint(original, p + headerId.len);
  p += headerId.len + headerSize.len + headerSize.v; // the Segment id starts here
  const segSize = readVint(original, p + 4);
  const dataStart = p + 4 + segSize.len;
  const dataEnd = Math.min(dataStart + segSize.v, original.length);
  const top = children(original, dataStart, dataEnd);

  const tracks = top.find(e => e.id === 0x1654ae6b);
  const cues = top.find(e => e.id === 0x1c53bb6b);
  const clusters = top.filter(e => e.id === 0x1f43b675);
  if (!tracks || !cues || !clusters.length) {
    throw Error('sample without Tracks/Cues/Clusters');
  }

  // the video track number (TrackType 1)
  let videoTrack = null;
  for (const te of children(original, tracks.data, tracks.next).filter(e => e.id === 0xae)) {
    const cs = children(original, te.data, te.next);
    const type = cs.find(e => e.id === 0x83);
    if (type && readUInt(original, type) === 1) {
      const number = cs.find(e => e.id === 0xd7);
      videoTrack = number ? readUInt(original, number) : 1;
      break;
    }
  }
  if (!videoTrack) {
    throw Error('sample without a video track');
  }

  const clusterTimecode = cluster =>
    readUInt(original, children(original, cluster.data, cluster.next)
      .find(e => e.id === 0xe7));

  // a cue point per cluster (every `every` seconds), referencing the video
  // track only; the offsets are relative to the segment data
  const point = (timecode, at) => element(Buffer.from([0xbb]),
    Buffer.concat([
      element(Buffer.from([0xe7]), uintBytes(timecode)),
      element(Buffer.from([0xb7]), Buffer.concat([
        element(Buffer.from([0xf7]), uintBytes(videoTrack)),
        element(Buffer.from([0xcc]), uintBytes(at))
      ]))
    ]));
  let every = 1;
  let points = null;
  for (;; every += 1) {
    points = clusters
      .filter((c, i) => i % every === 0)
      .map(cluster => point(clusterTimecode(cluster), cluster.start - dataStart));
    const needed = 4 + encodeSize(points.reduce((n, q) => n + q.length, 0)).length +
      points.reduce((n, q) => n + q.length, 0);
    if (needed + 2 <= cues.next - cues.start) {
      break; // the Void after the cues needs at least two bytes
    }
    if (every > clusters.length) {
      throw Error('the rewritten cues do not fit in the place of the original ones');
    }
  }
  const cuesData = Buffer.concat(points);
  const newCues = element(Buffer.from([0x1c, 0x53, 0xbb, 0x6b]), cuesData);
  const room = cues.next - cues.start - newCues.length;
  const voidPad = room ? element(Buffer.from([0xec]), Buffer.alloc(room -
    (1 + encodeSize(room - 2).length))) : Buffer.alloc(0);
  if (newCues.length + voidPad.length !== cues.next - cues.start) {
    throw Error('padding mismatch: ' + newCues.length + ' + ' + voidPad.length);
  }

  return Buffer.concat([
    original.subarray(0, cues.start),
    newCues,
    voidPad,
    original.subarray(cues.next)
  ]);
};

/* ----------------------------------------------------------------------- run */

const untilAfter = async (w, from, pred, timeout = 90000) => {
  for (;;) {
    const hit = w.messages.slice(from).map(x => x.msg).find(pred);
    if (hit) {
      return hit;
    }
    await w.next(timeout);
  }
};

const run = async () => {
  let sample;
  try {
    sample = fs.readFileSync(SAMPLE);
  }
  catch (e) {
    console.log('sample missing; downloading it once from', SOURCE);
    sample = await download(SOURCE);
    fs.writeFileSync(SAMPLE, sample);
  }

  const mkv = rewriteCuesToVideo(sample);
  if (mkv.length !== sample.length) {
    throw Error('the rewritten file changed its size: ' + mkv.length +
      ' vs ' + sample.length);
  }
  console.log('rewritten file:', mkv.length, 'bytes (cues of the video track only)');

  const w = startWorker();

  w.post({cmd: 'open', id: 1, file: makeFile(mkv)});
  const opened = await w.until(
    m => m.id === 1 && (m.type === 'meta' || m.type === 'error'), 90000
  );
  if (opened.type === 'error') {
    throw Error('the decoder rejected the file: ' + opened.error);
  }
  const meta = opened.meta;
  if (meta['Codec Name'] !== 'aac') {
    throw Error('the audio stream is "' + meta['Codec Name'] + '", expected aac');
  }
  if (!meta['Duration']) {
    throw Error('the stream carries no duration: ' + JSON.stringify(meta));
  }
  console.log('open ok:', meta['Codec Name'], 'rate', meta['Sample Rate'],
    'channels', meta['Channels'], 'duration', meta['Duration'].toFixed(3));

  // decode the opening window
  let at = w.messages.length;
  w.post({cmd: 'pull', id: 1, until: 2});
  const first = await untilAfter(w, at, m => m.type === 'pulled' || m.type === 'error');
  if (first.type === 'error' || first.covered < 2 || first.done) {
    throw Error('the opening window failed: ' + JSON.stringify(first));
  }

  // mid-file seeks must land at the target through the video cues
  for (const fraction of [0.25, 0.5, 0.75]) {
    const target = meta['Duration'] * fraction;
    at = w.messages.length;
    w.post({cmd: 'seek', id: 1, to: target});
    const seeked = await untilAfter(w, at,
      m => m.type === 'seeked' || m.type === 'seekfailed' || m.type === 'error');
    if (seeked.type !== 'seeked') {
      throw Error('seek(' + target + ') reported ' + JSON.stringify(seeked));
    }

    at = w.messages.length;
    w.post({cmd: 'pull', id: 1, until: target + 3});
    const pulled = await untilAfter(w, at, m => m.type === 'pulled' || m.type === 'error');
    if (pulled.type === 'error') {
      throw Error('the pull after seek(' + target + ') failed: ' + pulled.error);
    }
    const chunks = w.messages.slice(at).map(x => x.msg).filter(m => m.type === 'chunk');
    const firstPos = chunks[0] ? chunks[0].pos : NaN;
    // one second of cue granularity plus the demuxer start time
    if (!(firstPos >= target - 1.5 && firstPos <= target + 0.5)) {
      throw Error('seek(' + target + ') decoded from ' + firstPos.toFixed(3) +
        ' instead of the target');
    }
    if (pulled.done) {
      throw Error('the pull after seek(' + target + ') reported a false end of stream: ' +
        JSON.stringify(pulled));
    }
    if (pulled.covered < target + 2.5) {
      throw Error('the pull after seek(' + target + ') covered only ' + pulled.covered);
    }
    console.log('seek ok:', fraction * 100 + '% →', firstPos.toFixed(3),
      ', covered', pulled.covered.toFixed(3), ', done', pulled.done);
  }

  // the drain after the seeks ends only at the real end of the track
  at = w.messages.length;
  w.post({cmd: 'pull', id: 1, until: meta['Duration']});
  const drained = await untilAfter(w, at, m => m.type === 'pulled' || m.type === 'error');
  if (drained.type === 'error') {
    throw Error('the drain failed: ' + drained.error);
  }
  if (!drained.done || Math.abs(drained.covered - meta['Duration']) > 1) {
    throw Error('the drain ended at ' + JSON.stringify(drained));
  }
  console.log('drain ok: done at', drained.covered.toFixed(3));

  w.post({cmd: 'close', id: 1});
  await w.until(m => m.id === 1 && m.type === 'closed');

  console.log('WORKER MKV TEST PASSED');
};

run().catch(e => {
  console.error('WORKER MKV TEST FAILED:', e.message);
  process.exit(1);
});
