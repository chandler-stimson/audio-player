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
    for (const e of parse.cache) {
      parse(e);
    }
  }
};

importScripts('decoder.js');

const parse = e => {
  const {name, binary, id} = e.data;

  // reset per job logs
  stdout = '';
  stderr = '';

  FS.writeFile(name, binary);

  try {
    M.cwrap('decoder', 'number', ['string'])(name);

    // FS.readFile returns an exact-size buffer, so a Float32Array view can be
    // wrapped around it directly and the underlying buffer can be transferred
    // to the main thread without being copied
    const channels = [...Array(M.meta['Channels']).keys()].map(c => {
      const filename = 'channel_' + c;
      const ch = FS.readFile(filename);
      FS.unlink(filename);
      return new Float32Array(ch.buffer);
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

onmessage = e => {
  if (ready) {
    parse(e);
  }
  else {
    parse.cache.push(e);
  }
};
