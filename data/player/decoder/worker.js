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
  FS.writeFile(name, binary);

  try {
    M.cwrap('decoder', 'number', ['string'])((name));

    postMessage({
      id,
      stdout,
      stderr,
      meta: M.meta,
      channels: [...Array(M.meta['Channels']).keys()].map(c => {
        const filename = 'channel_' + c;
        const ch = FS.readFile(filename);
        FS.unlink(filename);
        return new Float32Array(ch.buffer);
      })
    });
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
  FS.unlink(name);
  stdout = '';
  stderr = '';
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
