/* Node smoke test: loads decoder.js/decoder.wasm and drives the streaming
   API with a synthesized WAV input (a buffer input: the whole file in
   memory). Verifies:
     - decoder_open/pull/seek/close exports exist
     - meta carries Duration / Sample Rate / Channels / Start Time handling
     - pulling the whole file emits the exact PCM that the WAV contains
     - seek(1.0) repositions the decode to the ~44100th sample
   Run: node dev/tests/wasm-smoke.cjs [path-to-decoder.js] (the wasm must sit
   next to it; without an argument the checked-in binaries are verified) */

const path = require('node:path');
const {expectedSample, makeWav} = require('./harness.cjs');

const decoderJs = process.argv[2] ||
  path.resolve(__dirname, '../../v2/data/player/decoder/decoder.js');

/* ------------------------------------------------------------- the input feed */

const makeFeed = bytes => ({
  cursor: 0,
  readInto(ptr, size) {
    const Module = global.Module;
    if (this.cursor >= bytes.length) {
      return -1;
    }
    const n = Math.min(size, bytes.length - this.cursor);
    global.M.HEAPU8.set(bytes.subarray(this.cursor, this.cursor + n), ptr);
    this.cursor += n;
    return n;
  },
  ready() {
    // the whole input is in memory: every read can be served, and the end
    // is signalled with -1 so that the decoder drains to DONE
    return true;
  },
  seek(offset, whence) {
    if (whence & 0x10000) {
      return bytes.length;
    }
    const base = whence === 0 ? 0 : (whence === 1 ? this.cursor : bytes.length);
    const target = base + offset;
    if (target < 0 || target > bytes.length) {
      return -1;
    }
    this.cursor = target;
    return target;
  }
});

/* ----------------------------------------------------------------------- run */

const run = async () => {
  // In node the emscripten glue cannot see a preset global Module (CommonJS
  // wraps the script in a function scope), so the runtime object that the
  // require returns is configured afterwards; the wasm instantiation is
  // asynchronous even though the file read itself is not
  const M = require(decoderJs);
  global.M = M;

  await new Promise(resolve => {
    if (M.calledRun) {
      return resolve();
    }
    M.onRuntimeInitialized = () => {
      resolve();
    };
  });

  // the callbacks that the wasm side reads at call time
  M.readInput = (ptr, size) => global.feed.readInto(ptr, size);
  M.inputReady = () => global.feed.ready();
  M.seekInput = (offset, whence) => global.feed.seek(offset, whence);
  M.onpcm = (ptr, samples, channels, pts) => global.frame(ptr, samples, channels, pts);

  const api = {
    open: M.cwrap('decoder_open', 'number', []),
    pull: M.cwrap('decoder_pull', 'number', []),
    seek: M.cwrap('decoder_seek', 'number', ['number']),
    close: M.cwrap('decoder_close', null, [])
  };

  const bytes = makeWav(3);
  global.feed = makeFeed(bytes);

  // the sample value that the synthesized wave carries at an index comes
  // from the shared harness (expectedSample)

  let total = 0;
  let firstPos = -1;
  global.frame = (ptr, samples, channels, pts) => {
    if (firstPos < 0) {
      firstPos = pts;
    }
    const left = new Float32Array(M.HEAPU8.buffer, ptr, samples);
    for (let i = 0; i < samples; i += 1) {
      const want = expectedSample(total + i);
      if (Math.abs(left[i] - want) > 0.001) {
        throw Error('PCM mismatch at sample ' + (total + i) +
          ': got ' + left[i] + ', expected ' + want);
      }
    }
    total += samples;
  };

  if (api.open() !== 0) {
    throw Error('decoder_open failed: ' + (M.meta['Exit Message'] || 'unknown'));
  }

  const meta = Object.assign({}, M.meta);
  const checks = [
    ['Duration', 3, v => Math.abs(v - 3) < 0.01],
    ['Sample Rate', 44100, v => v === 44100],
    ['Channels', 2, v => v === 2]
  ];
  for (const [key, ref, ok] of checks) {
    if (!ok(meta[key])) {
      throw Error('meta["' + key + '"] is ' + meta[key] + ', expected ~' + ref);
    }
  }
  console.log('meta ok:', JSON.stringify(meta));

  // pull everything
  let rc;
  while ((rc = api.pull()) !== 3 /* DONE */) {
    if (rc !== 1 /* HAVE_PCM */) {
      throw Error('unexpected decoder_pull code ' + rc + ' (expected HAVE_PCM)');
    }
  }
  if (total !== 3 * 44100) {
    throw Error('decoded ' + total + ' samples, expected ' + 3 * 44100);
  }
  if (firstPos < -0.001 || firstPos > 0.001) {
    throw Error('first frame pts is ' + firstPos + ', expected 0');
  }
  console.log('full decode ok:', total, 'samples, first pts', firstPos);

  // seek into the middle and verify that the samples continue from there
  if (api.seek(1.0) !== 0) {
    throw Error('decoder_seek(1.0) failed');
  }
  total = 0;
  let seekPos = -1;
  global.frame = (ptr, samples, channels, pts) => {
    if (seekPos < 0) {
      seekPos = pts;
    }
    total += samples;
  };
  while ((rc = api.pull()) === 1) {
    // drain a second of audio
    if (total > 44100) {
      break;
    }
  }
  const target = Math.round(1.0 * 44100);
  const got = seekPos < 0 ? -1 : Math.round(seekPos * 44100);
  if (Math.abs(got - target) > 1024) {
    throw Error('seek(1.0) landed at sample ' + got + ', expected ~' + target);
  }
  console.log('seek ok: landed at ~' + got, '(target', target + ')');

  api.close();

  // reopen the same input to prove that close reset the decoder state
  global.feed = makeFeed(bytes);
  total = 0;
  firstPos = -1;
  global.frame = (ptr, samples, channels, pts) => {
    if (firstPos < 0) {
      firstPos = pts;
    }
    total += samples;
  };
  if (api.open() !== 0) {
    throw Error('decoder_open failed after close');
  }
  while ((rc = api.pull()) === 1) {}
  if (rc !== 3 || total !== 3 * 44100) {
    throw Error('reopened decode produced ' + total + ' samples, rc ' + rc);
  }
  api.close();
  console.log('reopen ok:', total, 'samples');

  console.log('WASM SMOKE TEST PASSED');
};

run().catch(e => {
  console.error('WASM SMOKE TEST FAILED:', e.message);
  process.exit(1);
});
