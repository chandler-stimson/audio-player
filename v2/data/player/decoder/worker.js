/* global importScripts, FS */

let stdout = '';
let stderr = '';

let ready = false;

const M = self.Module = {
  print(text) {
    stdout += '\n' + text;
  },
  printErr(text) {
    stderr += '\n' + text;
  },
  onRuntimeInitialized() {
    ready = true;
    api = {
      open: M.cwrap('decoder_open', 'number', []),
      pull: M.cwrap('decoder_pull', 'number', []),
      seek: M.cwrap('decoder_seek', 'number', ['number']),
      close: M.cwrap('decoder_close', null, [])
    };
    for (const e of parse.cache) {
      parse(e);
    }
    for (const e of commands.cache) {
      commands.route(e);
    }
  }
};

importScripts('decoder.js');

/* the wrapped streaming entry points (set once the runtime is up) */
let api = null;

const post = (msg, transfer) => postMessage(msg, transfer || []);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ batch mode */

/* Decode a whole input that was posted as one binary; the small-input path
   of the player still uses it. The channel files are transferred to the main
   thread without being copied. */
const parse = e => {
  const {name, binary, id} = e.data;

  // reset per job logs
  stdout = '';
  stderr = '';

  FS.writeFile(name, binary);

  try {
    M.cwrap('decoder', 'number', ['string'])(name);

    // FS.readFile hands out a view of a capacity-doubled storage buffer
    // (the 0.1.2 glue returned an exact-size buffer), so the view is copied
    // into an exact-size one first; its buffer is then transferred to the
    // main thread without being copied
    const channels = [...Array(M.meta['Channels']).keys()].map(c => {
      const filename = 'channel_' + c;
      const ch = FS.readFile(filename);
      FS.unlink(filename);
      return new Float32Array(new Uint8Array(ch).buffer);
    });

    // transfer the channel buffers instead of letting postMessage clone them;
    // for a decoded track this is by far the largest payload of the pipeline
    postMessage({
      id,
      stdout,
      stderr,
      meta: M.meta,
      channels
    }, channels.map(c => c.buffer));
  }
  catch (e) {
    console.error(e);
    postMessage({
      id,
      stdout,
      stderr,
      error: M.meta && M.meta['Exit Message'] !== 'NA' ? M.meta['Exit Message'] : e.message
    });
  }

  // release the input from the wasm heap even when decoding failed
  try {
    FS.unlink(name);
  }
  catch (e) {}
};
parse.cache = [];

/* -------------------------------------------------------------- streaming mode */

/* the avio callback protocol of the wasm decoder */
const SEEK_SET = 0;
const SEEK_CUR = 1;
const SEEK_END = 2;
const AVSEEK_SIZE = 0x10000;

const HAVE_PCM = 1;
const NEED_INPUT = 2;
const DONE = 3;
const READ_ERROR = 4;

/* open ladder: [bytes of the head, bytes of the tail] that are pre-read
   before decoder_open tries to parse the input; a demuxer needs the head
   atoms and (for the formats that keep their index at the end) the tail */
const LADDER = [
  [2 * 1024 * 1024, 1024 * 1024],
  [16 * 1024 * 1024, 8 * 1024 * 1024],
  [64 * 1024 * 1024, 32 * 1024 * 1024],
  [256 * 1024 * 1024, 64 * 1024 * 1024]
];

/* the read-ahead that is kept available at the demuxer cursor */
const READAHEAD = {
  file: 16 * 1024 * 1024,
  href: 1024 * 1024
};

/* how far behind the byte position of a seek target the demuxer may land
   (its index granularity); this many bytes are pre-read around it */
const SEEK_BACK = 8 * 1024 * 1024;

/* the number of decoded seconds that one posted chunk carries */
const CHUNK_SECONDS = 1;

/* ---------------------------------------------------------------- input adapters */

const makeFileInput = file => ({
  kind: 'file',
  size: file.size,
  // a Blob slice is read on demand; the browser never holds more than the
  // requested window of the input in memory
  async readAt(pos, length) {
    if (pos >= file.size) {
      return null;
    }
    length = Math.min(length, file.size - pos);
    const ab = await file.slice(pos, pos + length).arrayBuffer();
    return {pos, bytes: new Uint8Array(ab)};
  }
});

const makeBufferInput = arrayBuffer => {
  const bytes = new Uint8Array(arrayBuffer);
  return {
    kind: 'buffer',
    size: bytes.length,
    async readAt(pos, length) {
      if (pos >= bytes.length) {
        return null;
      }
      length = Math.min(length, bytes.length - pos);
      return {pos, bytes: bytes.subarray(pos, pos + length)};
    }
  };
};

const makeHrefInput = async href => {
  const response = await fetch(href);
  if (!response.ok) {
    throw Error('HTTP_' + response.status);
  }
  const total = parseInt(response.headers.get('Content-Length'), 10) || -1;
  const reader = response.body.getReader();

  const input = {
    kind: 'href',
    size: total,
    streamEnded: false,
    frontier: 0,
    // the download is strictly sequential; readAt serves the next received
    // chunk and only at the frontier position
    async readAt(pos) {
      if (pos !== input.frontier || input.streamEnded) {
        return null;
      }
      const {done, value} = await reader.read();
      if (done || !value) {
        input.streamEnded = true;
        return null;
      }
      const region = {pos: input.frontier, bytes: value};
      input.frontier += value.length;
      return region;
    },
    cancel() {
      input.streamEnded = true;
      reader.cancel().catch(() => {});
    }
  };
  return input;
};

/* ---------------------------------------------------------------------- the feed */

/* The in-memory regions that the synchronous wasm callbacks serve. Regions
   are sorted by position and can be sparse (a pre-read tail next to the
   head). readInto returns -1 whenever the cursor sits outside every region:
   ffmpeg latches a local end-of-stream on that (a gap it cannot fill on its
   own), which the pull loop clears again by seeking once it refilled the
   cursor area. */
const makeFeed = input => ({
  input,
  regions: [],
  cursor: 0,
  // a downloaded stream is retained so that the demuxer can seek back
  retain: input.kind === 'href',

  reset() {
    this.regions = [];
    this.cursor = 0;
  },
  add(region) {
    if (!region || region.bytes.length === 0) {
      return;
    }
    const regions = this.regions;
    let i = 0;
    while (i < regions.length && regions[i].pos < region.pos) {
      i += 1;
    }
    const prev = regions[i - 1];
    const next = regions[i];
    if (prev && region.pos <= prev.pos + prev.bytes.length &&
        region.pos + region.bytes.length <= prev.pos + prev.bytes.length) {
      return; // fully covered already
    }
    if (next && next.pos === region.pos && region.bytes.length <= next.bytes.length) {
      return; // the new region is a subset of the existing one
    }
    regions.splice(i, 0, {pos: region.pos, bytes: region.bytes});
  },
  regionAt(pos) {
    for (const r of this.regions) {
      if (pos >= r.pos && pos < r.pos + r.bytes.length) {
        return r;
      }
    }
    return null;
  },
  eofAt(pos) {
    if (this.input.kind === 'href') {
      return this.input.streamEnded && pos >= this.input.frontier;
    }
    return pos >= this.input.size;
  },
  /* the read callback of the wasm decoder */
  readInto(ptr, size) {
    const r = this.regionAt(this.cursor);
    if (!r) {
      return -1;
    }
    const offset = this.cursor - r.pos;
    const n = Math.min(size, r.bytes.length - offset);
    M.HEAPU8.set(r.bytes.subarray(offset, offset + n), ptr);
    this.cursor += n;
    if (!this.retain && offset + n >= r.bytes.length) {
      // spent; the input can always read the area again on demand
      this.regions.splice(this.regions.indexOf(r), 1);
    }
    return n;
  },
  /* the ready check of the wasm decoder: only a cursor inside a region or
     the true end of the input lets a pull proceed */
  ready() {
    return Boolean(this.regionAt(this.cursor)) || this.eofAt(this.cursor);
  },
  /* the seek callback of the wasm decoder */
  seek(offset, whence) {
    const input = this.input;
    if (whence & AVSEEK_SIZE) {
      return input.size; // -1 when the input cannot tell (ffmpeg probes then)
    }
    if (whence === SEEK_END && input.size < 0) {
      return -1;
    }
    const base = whence === SEEK_SET ? 0 : (whence === SEEK_CUR ? this.cursor : input.size);
    const target = base + offset;
    if (target < 0 || (input.size >= 0 && target > input.size)) {
      return -1;
    }
    if (input.kind === 'href' && target > input.frontier) {
      return -1; // beyond what the download has reached so far
    }
    this.cursor = target;
    return target;
  }
});

/* -------------------------------------------------------------------- a session */

let current = null;

const makeSession = (msg, input) => {
  const session = {
    id: msg.id,
    input,
    feed: makeFeed(input),
    meta: null,
    epoch: 0,
    resyncs: 0,
    done: false,
    stalled: false,
    sampleRate: null,
    channels: null,
    duration: null,
    // the demuxer timestamp that content position zero corresponds to
    timeBase: undefined,
    // content position of the next sample that a chunk will carry
    expectedPos: 0,
    acc: null,
    covered: 0,

    // the content-position to demuxer-time correction of seeks
    seekBase() {
      const known = (session.meta && session.meta['Start Time'] !== undefined) ?
        session.meta['Start Time'] : 0;
      return (session.timeBase !== undefined ? session.timeBase : known) - known;
    },

    async topUp() {
      const feed = this.feed;
      if (feed.eofAt(feed.cursor)) {
        return false;
      }
      const r = feed.regionAt(feed.cursor);
      const have = r ? r.pos + r.bytes.length - feed.cursor : 0;
      const need = this.input.kind === 'href' ? READAHEAD.href : READAHEAD.file;
      if (have >= need) {
        return false;
      }
      const region = await this.input.readAt(feed.cursor, need);
      if (!region) {
        return false;
      }
      feed.add(region);
      return true;
    },

    /* a decoded frame arrived through Module.onpcm */
    onpcm(ptr, samples, ch, pts) {
      if (this.timeBase === undefined) {
        /* the content origin is the demuxer start time or, when the container
           does not tell, the first frame itself: a primed codec (the encoder
           delay of an aac track inside an mp4) reports its first samples
           slightly late, and those samples are position zero rather than a
           gap that no decoded chunk ever covers */
        this.timeBase = this.meta['Start Time'] !== undefined ? this.meta['Start Time'] :
          (pts >= 0 ? pts : 0);
      }

      let pos;
      if (this.acc) {
        pos = this.acc.pos + this.acc.samples / this.sampleRate;
        if (pts >= 0 && Math.abs(pts - this.timeBase - pos) > 0.05) {
          // the frames jumped (the demuxer seeked elsewhere); close the
          // pending chunk and rebase on the frame timestamp
          this.flush();
          pos = Math.max(0, pts - this.timeBase);
        }
      }
      else {
        pos = pts >= 0 ? Math.max(0, pts - this.timeBase) : this.expectedPos;
      }

      if (!this.acc) {
        this.acc = {pos, samples: 0, chans: []};
        for (let c = 0; c < ch; c += 1) {
          this.acc.chans.push([]);
        }
      }

      for (let c = 0; c < ch; c += 1) {
        // copy the frame out of the wasm heap; the heap can be reallocated
        // by a growing decode, so no view of it may survive the callback
        const view = new Float32Array(M.HEAPU8.buffer, ptr + c * samples * 4, samples);
        this.acc.chans[c].push(view.slice());
      }
      this.acc.samples += samples;
      this.covered = pos + samples / this.sampleRate;

      if (this.acc.samples >= this.sampleRate * CHUNK_SECONDS) {
        this.flush();
      }
    },

    /* post the pending samples as one chunk; the buffers are transferred */
    flush() {
      if (!this.acc) {
        return;
      }
      const {pos, samples, chans} = this.acc;
      const channels = chans.map(list => {
        const out = new Float32Array(samples);
        let o = 0;
        for (const v of list) {
          out.set(v, o);
          o += v.length;
        }
        return out;
      });
      this.acc = null;
      this.expectedPos = pos + samples / this.sampleRate;

      post({
        id: this.id,
        type: 'chunk',
        epoch: this.epoch,
        pos,
        samples,
        sampleRate: this.sampleRate,
        channels
      }, channels.map(c => c.buffer));
    },

    /* decide whether a reported DONE is premature: the input still has bytes
       and the requested coverage was not reached */
    canResync(until) {
      return this.done === false && this.resyncs < 2 && this.covered < until &&
        this.feed.eofAt(this.feed.cursor) === false;
    },

    async resync() {
      // a demuxer that ran into a local end-of-stream latch recovers by
      // seeking back to where its samples continue; the seek clears the
      // latch and the refilled cursor serves the reads again
      this.resyncs += 1;
      this.expectedPos = this.covered;
      api.seek(this.covered + this.seekBase());
    }
  };
  return session;
};

/* the wasm callbacks of the streaming API; they always act on the newest
   session (a superseded session never calls into the wasm again) */
M.readInput = (ptr, size) => current ? current.feed.readInto(ptr, size) : -1;
M.inputReady = () => current ? current.feed.ready() : false;
M.seekInput = (offset, whence) => current ? current.feed.seek(offset, whence) : -1;
M.onpcm = (ptr, samples, ch, pts) => {
  if (current && current.sampleRate) {
    current.onpcm(ptr, samples, ch, pts);
  }
};

/* seed the regions that decoder_open reads its header from */
const preRead = async (session, head, tail) => {
  const {input, feed} = session;
  feed.reset();
  if (input.kind === 'buffer') {
    feed.add(await input.readAt(0, input.size));
    return;
  }
  if (input.kind === 'href') {
    while (input.frontier < head && !input.streamEnded) {
      const region = await input.readAt(input.frontier, head - input.frontier);
      if (!region) {
        return;
      }
      feed.add(region);
    }
    return;
  }
  feed.add(await input.readAt(0, head));
  if (tail < input.size) {
    feed.add(await input.readAt(input.size - tail, tail));
  }
};

/* open a streaming session; the head/tail ladder widens on retry because a
   long input can carry a header (the moov atom of an mp4, the index of an
   mkv) that the first window did not cover */
const cmdOpen = async msg => {
  // abandon the session that this worker was serving (if any)
  if (current) {
    current.done = true; // the pull loop of the old session stops on this
    api.close();
    if (current.input.cancel) {
      current.input.cancel();
    }
  }

  const input = msg.file ? makeFileInput(msg.file) :
    msg.href ? await makeHrefInput(msg.href) :
    msg.arrayBuffer ? makeBufferInput(msg.arrayBuffer) : null;
  if (!input) {
    throw Error('EMPTY_INPUT');
  }

  // the session under construction: its feed already serves the wasm
  // callbacks while the ladder probes the input
  const session = makeSession(msg, input);
  current = session;

  let opened = null;
  let failure = null;
  let exhausted = false;

  for (const [head, tail] of LADDER) {
    await preRead(session, head, tail).catch(() => {});

    const rc = api.open();
    if (rc === 0) {
      opened = Object.assign({}, M.meta);
      break;
    }
    failure = Object.assign({}, M.meta);
    // the input cannot offer more than what this round already covered
    exhausted = (input.size >= 0 && head >= input.size && tail >= input.size) ||
      (input.kind === 'href' && input.streamEnded);
    if (exhausted) {
      break;
    }
    api.close();
  }

  if (!opened) {
    api.close();
    current = null;
    throw Error((failure && failure['Exit Message'] !== 'NA' && failure['Exit Message']) ||
      'CANNOT_OPEN_INPUT');
  }

  session.meta = opened;
  session.sampleRate = opened['Sample Rate'];
  session.channels = opened['Channels'];
  session.duration = opened['Duration'] !== undefined ? opened['Duration'] : null;
  session.timeBase = opened['Start Time'] !== undefined ? opened['Start Time'] : undefined;

  if (!session.sampleRate || !session.channels) {
    api.close();
    current = null;
    throw Error('NO_AUDIO_STREAM');
  }

  post({id: msg.id, type: 'meta', meta: opened});
};

/* decode until the coverage reaches `until` seconds (a content position);
   chunks are posted as they coalesce */
const cmdPull = async msg => {
  const session = current;
  if (!session || session.id !== msg.id) {
    return;
  }
  session.stalled = false;

  for (;;) {
    if (current !== session) {
      return; // a newer session owns this worker
    }

    const rc = api.pull();

    if (rc === HAVE_PCM) {
      // the horizon is reached; the end of the input is not a horizon: keep
      // pulling so that the drain reports the end of the stream
      if (session.covered >= msg.until && !session.feed.eofAt(session.feed.cursor)) {
        break;
      }
      continue;
    }

    if (rc === NEED_INPUT) {
      let progress = await session.topUp();
      for (let i = 0; i < 3 && !progress; i += 1) {
        // a download can catch up; a local input never gets here
        await sleep(250);
        if (current !== session) {
          return;
        }
        progress = await session.topUp();
      }
      if (!progress) {
        // the demuxer waits at a position that the input cannot fill yet;
        // resolve as stalled and let the host ask again
        session.stalled = session.feed.eofAt(session.feed.cursor) === false;
        break;
      }
      continue;
    }

    if (rc === DONE) {
      session.flush();
      if (session.canResync(msg.until)) {
        await session.resync();
        continue;
      }
      session.done = true;
      break;
    }

    if (rc === READ_ERROR) {
      session.flush();
      if (session.canResync(msg.until)) {
        await session.resync();
        continue;
      }
      throw Error('DEMUXER_READ_ERROR');
    }

    throw Error('UNKNOWN_PULL_CODE_' + rc);
  }

  post({
    id: session.id,
    type: 'pulled',
    covered: session.covered,
    done: session.done,
    stalled: session.stalled
  });
};

/* seek to a content position; the epoch of the session changes so that the
   chunks of the old position are dropped by the host */
const cmdSeek = async msg => {
  const session = current;
  if (!session || session.id !== msg.id) {
    return;
  }
  const to = Math.max(0, msg.to);
  const target = to + session.seekBase();

  if (session.input.kind === 'file') {
    // pre-read around the byte position that the target lands on so that
    // the probing reads of the demuxer are served synchronously
    const bytesPerSecond = session.duration && session.input.size > 0 ?
      session.input.size / session.duration : 0;
    const estimate = bytesPerSecond ?
      Math.min(Math.max(0, Math.round(target * bytesPerSecond)), session.input.size) : 0;
    if (estimate) {
      const from = Math.max(0, estimate - SEEK_BACK);
      const region = await session.input.readAt(from, Math.min(SEEK_BACK + READAHEAD.file, session.input.size - from));
      if (region) {
        session.feed.add(region);
      }
    }
  }

  session.flush();
  session.done = false;
  session.resyncs = 0;

  const rc = api.seek(target);
  if (rc !== 0) {
    post({id: session.id, type: 'seekfailed', to});
    return;
  }
  session.epoch += 1;
  session.expectedPos = to;
  session.covered = to;
  post({id: session.id, type: 'seeked', epoch: session.epoch, to});
};

const cmdClose = msg => {
  const session = current;
  if (!session || session.id !== msg.id) {
    post({id: msg.id, type: 'closed'});
    return;
  }
  session.flush();
  api.close();
  if (session.input.cancel) {
    session.input.cancel();
  }
  current = null;
  post({id: msg.id, type: 'closed'});
};

/* ------------------------------------------------------- command routing */

const commands = {
  // pull/seek/close serialize behind each other; an open abandons whatever
  // runs and starts immediately
  chain: Promise.resolve(),
  cache: [],
  route(e) {
    if (!ready) {
      commands.cache.push(e);
      return;
    }
    const msg = e.data;
    if (msg.cmd === 'open') {
      // the newest session must not wait behind a stalled pull of the old
      cmdOpen(msg).catch(err => post({id: msg.id, type: 'error', error: err.message}));
      return;
    }
    commands.chain = commands.chain.then(() => {
      const session = current;
      if (!session || session.id !== msg.id) {
        return; // the session was replaced or closed
      }
      if (msg.cmd === 'pull') {
        return cmdPull(msg);
      }
      if (msg.cmd === 'seek') {
        return cmdSeek(msg);
      }
      if (msg.cmd === 'close') {
        return cmdClose(msg);
      }
      throw Error('UNKNOWN_COMMAND');
    }).catch(err => post({id: msg.id, type: 'error', error: err.message}));
  }
};

onmessage = e => {
  if (e.data && e.data.cmd) {
    commands.route(e);
    return;
  }
  if (ready) {
    parse(e);
  }
  else {
    parse.cache.push(e);
  }
};
