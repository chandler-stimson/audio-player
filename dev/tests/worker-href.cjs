/* Node test: the streaming protocol over network inputs, served by a fake
   http layer that is injected into the worker context (no sockets).

   The media of the ladder cases is a wav whose header sits behind a junk
   chunk of several MiB: the demuxer has to seek over the junk, which the
   first probe window (2 MiB) cannot cover, so the open ladder has to climb
   to its wider rung. What is verified:

    - a small sequential wav opens from the first window and its pcm matches
    - the junk-chunk wav opens as a file input on the second rung (the
      control that this media really needs the wider window)
    - over a server that cannot re-serve a byte range the same wav opens on
      the second rung too: the bytes that the first rung downloaded stay in
      the feed, so the retry serves byte zero again (a reset that discarded
      them made every retry fail without the header)
    - over a range-capable server the input opens through the re-fetch
    - the pulled chunks of every open carry the synthesized tone

   Run: node dev/tests/worker-href.cjs */

const {startWorker} = require('./fake-worker.cjs');
const {expectedSample, makeWav} = require('./harness.cjs');

/* a wav with a junk chunk of several MiB in front of fmt/data; parsing it
   means seeking past the junk, so the header is out of reach of the first
   probe window */
const makeJunkWav = () => {
  const wav = Buffer.from(makeWav(8)); // ~2.82 MiB of pcm
  const junk = Buffer.alloc(2.5 * 1024 * 1024, 0);
  const out = Buffer.alloc(8 + 4 + 8 + junk.length + (wav.length - 12));
  let o = 0;
  const put = part => {part.copy(out, o); o += part.length;};
  put(Buffer.from('RIFF', 'ascii'));
  out.writeUInt32LE(36 + (wav.length - 44) + 8 + junk.length, o); o += 4;
  put(Buffer.from('WAVE', 'ascii'));
  put(Buffer.from('JUNK', 'ascii'));
  out.writeUInt32LE(junk.length, o); o += 4;
  put(junk);
  put(wav.subarray(12)); // fmt + data
  return new Uint8Array(out);
};

/* a Blob-like file that counts its slices: every pre-read of a ladder rung
   slices once for its head and once for its tail, so the count tells which
   rung opened the input */
const makeCountedFile = (bytes, counter) => ({
  size: bytes.length,
  slice(from, to) {
    counter.n += 1;
    return {
      async arrayBuffer() {
        return bytes.slice(from, Math.min(to, bytes.length)).buffer;
      }
    };
  }
});

/* a server whose download can only be consumed once: the body hands out
   forward-only chunks, no byte is ever served twice */
const sequentialFetch = bytes => () => Promise.resolve({
  ok: true,
  headers: {
    get: name => name === 'Content-Length' ? String(bytes.length) : null
  },
  body: {
    getReader() {
      let off = 0;
      return {
        async read() {
          if (off >= bytes.length) {
            return {done: true};
          }
          const n = Math.min(16 * 1024, bytes.length - off);
          const value = new Uint8Array(n); // a detached network chunk
          value.set(bytes.subarray(off, off + n));
          off += n;
          return {done: false, value};
        },
        cancel() {
          off = bytes.length;
          return Promise.resolve();
        }
      };
    }
  }
});

/* a server that re-serves any byte range on demand (Accept-Ranges) */
const rangeFetch = bytes => (href, init) => {
  const asked = init && init.headers && init.headers.Range;
  if (!asked) {
    // the initial request only probes the headers; the input cancels the
    // body without reading it
    return Promise.resolve({
      ok: true,
      headers: {
        get: name => name === 'Content-Length' ? String(bytes.length) :
          name === 'Accept-Ranges' ? 'bytes' : null
      },
      body: {cancel: () => Promise.resolve()}
    });
  }
  const m = /^bytes=(\d+)-(\d+)$/.exec(asked);
  const from = m ? Number(m[1]) : -1;
  const to = m ? Math.min(Number(m[2]), bytes.length - 1) : -1;
  if (from < 0 || from > to) {
    return Promise.reject(Error('BAD_FAKE_RANGE_' + asked));
  }
  const part = bytes.slice(from, to + 1);
  return Promise.resolve({
    ok: true,
    status: 206,
    headers: {
      get: name => name === 'Content-Range' ?
        'bytes ' + from + '-' + (from + part.length - 1) + '/' + bytes.length : null
    },
    arrayBuffer: () => Promise.resolve(part.buffer)
  });
};

/* open one input on a fresh worker, pull a window, verify the pcm of the
   chunks and close; `slices` (optional) is the slice count that must have
   been reached when the meta arrives */
const drive = async ({file, fetch, slices, duration}) => {
  const w = startWorker(fetch ? {fetch} : {});
  const counter = {n: 0};

  w.post(file ? {cmd: 'open', id: 1, file: makeCountedFile(file, counter)} :
    {cmd: 'open', id: 1, href: 'http://fake/tone.wav'});

  const meta = await w.until(m => m.id === 1 && (m.type === 'meta' || m.type === 'error'), 30000);
  if (meta.type === 'error') {
    throw Error('open failed: ' + meta.error);
  }
  if (meta.meta['Sample Rate'] !== 44100 ||
      Math.abs(meta.meta['Duration'] - duration) > 0.01) {
    throw Error('unexpected stream meta: ' + JSON.stringify(meta.meta));
  }
  if (slices !== undefined && counter.n !== slices) {
    // rung 1: head + tail (2 slices); rung 2: head only, the tail covers the
    // whole input already; a count below the expectation means the first
    // window opened the input and the media stopped forcing the retry
    throw Error('the open consumed ' + counter.n + ' slice(s) instead of ' + slices);
  }

  w.post({cmd: 'pull', id: 1, until: 1.5});
  const pulled = await w.until(m => m.id === 1 && m.type === 'pulled', 60000);
  if (pulled.covered < 1.5) {
    throw Error('the pull covered only ' + pulled.covered);
  }
  if (pulled.done || pulled.stalled) {
    throw Error('the pull ended done=' + pulled.done + ' stalled=' + pulled.stalled);
  }

  const chunks = w.of('chunk');
  if (!chunks.length) {
    throw Error('no chunks were posted');
  }
  let pos = 0;
  for (const c of chunks) {
    if (Math.abs(c.pos - pos) > 0.01) {
      throw Error('chunk position ' + c.pos + ' does not continue at ' + pos);
    }
    const want = expectedSample(Math.round(c.pos * 44100), 0);
    if (Math.abs(c.channels[0][0] - want) > 0.001) {
      throw Error('pcm mismatch at the chunk start: ' + c.channels[0][0] + ' vs ' + want);
    }
    pos = c.pos + c.samples / c.sampleRate;
  }

  w.post({cmd: 'close', id: 1});
  await w.until(m => m.id === 1 && m.type === 'closed', 30000);
  return {meta, pulled, chunks: chunks.length};
};

const run = async () => {
  /* a wav that fits the first window: the sequential download opens it
     without a retry */
  const small = await drive({fetch: sequentialFetch(new Uint8Array(makeWav(3))), duration: 3});
  console.log('small sequential ok: duration', small.meta.meta['Duration'],
    'covered', small.pulled.covered.toFixed(2), 'in', small.chunks, 'chunks');

  /* the control: as a file input the junk-chunk wav opens on the second
     rung (3 slices: rung 1 head + tail, rung 2 head only) */
  const control = await drive({file: makeJunkWav(), slices: 3, duration: 8});
  console.log('file rung 2 ok: opened after 3 slices, covered',
    control.pulled.covered.toFixed(2));

  /* the regression: the same bytes over the strictly sequential server; the
     first rung downloads its head, the retry must still see byte zero */
  const seq = await drive({fetch: sequentialFetch(makeJunkWav()), duration: 8});
  console.log('sequential rung 2 ok: covered', seq.pulled.covered.toFixed(2),
    'in', seq.chunks, 'chunks');

  /* the range-capable server re-fetches the wider head on the retry */
  const ranges = await drive({fetch: rangeFetch(makeJunkWav()), duration: 8});
  console.log('range re-fetch ok: covered', ranges.pulled.covered.toFixed(2),
    'in', ranges.chunks, 'chunks');

  console.log('WORKER HREF TEST PASSED');
};

run().catch(e => {
  console.error('WORKER HREF TEST FAILED:', e.message);
  process.exit(1);
});
