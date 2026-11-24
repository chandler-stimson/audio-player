/* The shared fake-worker harness of the node tests: loads the real
   v2/data/player/decoder/worker.js inside a vm context that emulates the
   global scope of a browser worker (the emscripten glue sees the preset
   self.Module, importScripts runs the glue at "global" scope, the wasm
   loads from the disk). */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DECODER_DIR = path.resolve(__dirname, '../../v2/data/player/decoder');

/* a Blob-like file built from bytes; slice().arrayBuffer() reads on demand */
const makeFile = bytes => ({
  size: bytes.length,
  slice(from, to) {
    const view = bytes.subarray(from, Math.min(to, bytes.length));
    return {
      async arrayBuffer() {
        const copy = new Uint8Array(view.length);
        copy.set(view);
        return copy.buffer;
      }
    };
  }
});

const startWorker = ({fetch, onpost} = {}) => {
  const messages = [];
  const waiters = [];

  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    __dirname: DECODER_DIR,
    require,
    process,
    postMessage(msg, transfer) {
      messages.push({msg, transfer: transfer || []});
      if (onpost) {
        onpost(msg, transfer || []);
      }
      for (const w of waiters.splice(0)) {
        w();
      }
    },
    onmessage: null,
    importScripts(...files) {
      for (const f of files) {
        const source = fs.readFileSync(path.join(DECODER_DIR, f));
        new vm.Script(source, {filename: f}).runInContext(ctx);
      }
    }
  };
  if (fetch) {
    ctx.fetch = fetch;
  }
  ctx.self = ctx;
  vm.createContext(ctx);

  // worker.js itself: its top-level var/let/const attach to the context and
  // self.Module preset reaches the glue exactly like in a browser worker
  new vm.Script(fs.readFileSync(path.join(DECODER_DIR, 'worker.js')), {
    filename: 'worker.js'
  }).runInContext(ctx);

  return {
    post(msg) {
      ctx.onmessage({data: msg});
    },
    messages,
    /* resolve once the worker sent at least one more message */
    next(timeout = 10000) {
      const from = messages.length;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(Error('WORKER_TIMEOUT'));
        }, timeout);
        const check = () => {
          if (messages.length > from) {
            clearTimeout(timer);
            resolve();
            return;
          }
          waiters.push(check);
        };
        check();
      });
    },
    /* collect until a predicate matches a message */
    async until(pred, timeout = 10000) {
      const seen = [];
      for (;;) {
        const m = messages.filter(({msg}) => pred(msg) && seen.indexOf(msg) === -1)[0];
        if (m) {
          seen.push(m.msg);
          return m.msg;
        }
        await this.next(timeout);
      }
    },
    /* the messages of one type, in order */
    of(type) {
      return messages.filter(({msg}) => msg.type === type).map(({msg}) => msg);
    }
  };
};

module.exports = {DECODER_DIR, makeFile, startWorker};
