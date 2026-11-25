/* The fake page world of the player tests: the real v2/data/player/index.js
   is loaded into a fresh vm context against a purpose-built DOM and chrome
   stub. What the scenarios need is real, everything else is an inert stub:

     - the hidden select of the list view is mirrored by `rows` (option 0 is
       the hidden header, exactly like the real list view) so that the view
       rows and audio.files can be compared after every scenario
     - the handles of the test files carry gates: an isSameEntry comparison
       parks on a deferred that the test releases on demand (FIFO), so the
       exact interleavings that used to corrupt the playlist are scriptable
     - the drag callbacks, the message listener and the context-menu events
       of the page are captured, so every entry point of add() is drivable

   The decoder, the metadata dialog and the audio graph stay inert: play()
       records the track it was asked to start instead of decoding it. */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* the page under test; PLAYER_INDEX overrides it (used to check that the
   regression tests fail on the unfixed page) */
const INDEX = process.env.PLAYER_INDEX ?
  path.resolve(process.env.PLAYER_INDEX) :
  path.resolve(__dirname, '../../v2/data/player/index.js');

/* ------------------------------------------------------ deferred comparison gate */

/* a gate makes an async comparison park until the test releases it; every
   parked call remembers the value it must resolve with */
const makeGate = () => {
  const pending = [];

  return {
    wait: value => new Promise(resolve => pending.push({resolve, value})),
    // resolve the oldest parked call with the result it was created with; a
    // release without a parked call falls through
    release: () => {
      const p = pending.shift();
      if (p) {
        p.resolve(p.value);
      }
    },
    size: () => pending.length,
    // resolve everything that is parked right now, oldest first
    drain: () => {
      while (pending.length) {
        const p = pending.shift();
        p.resolve(p.value);
      }
    }
  };
};

/* ------------------------------------------------------------ inert DOM element */

const makeElement = (id = '') => {
  const el = {
    id,
    style: {},
    attrs: {},
    disabled: false,
    hidden: false,
    open: false,
    returnValue: '',
    textContent: '',
    title: '',
    value: '',
    listeners: {},

    addEventListener(type, fn) {
      (el.listeners[type] = el.listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const l = el.listeners[type] || [];
      const at = l.indexOf(fn);
      if (at !== -1) {
        l.splice(at, 1);
      }
    },
    // run the registered handlers of one event type
    dispatch(type, e = {}) {
      for (const fn of (el.listeners[type] || []).slice()) {
        fn(e);
      }
    },
    setAttribute(k, v) {
      el.attrs[k] = String(v);
    },
    getAttribute(k) {
      return el.attrs[k];
    },
    matches: () => false,
    contains: () => false,
    getBoundingClientRect: () => ({top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0}),
    showModal() {
      el.open = true;
    },
    close() {
      el.open = false;
    },
    focus() {},
    // a permissive sub-element: enough for the <title> tooltips and the menu
    // button lookup of openMenu
    querySelector: () => ({
      textContent: '',
      focus() {}
    })
  };

  return el;
};

/* --------------------------------------------------------------- the page world */

const makePlayerWorld = () => {
  /* the deferred that remember.restore() resolves with; the test decides
     when the remembered tracks come back and which ones they are */
  let restoreValue;
  const restored = new Promise(resolve => {
    restoreValue = resolve;
  });

  const remember = {
    saves: [],
    removes: [],
    currents: [],
    clears: 0,
    restore: () => restored,
    save: files => {
      remember.saves.push(files);
      return Promise.resolve();
    },
    remove: file => {
      remember.removes.push(file);
      return Promise.resolve();
    },
    clear: () => {
      remember.clears += 1;
      return Promise.resolve();
    },
    current: file => {
      remember.currents.push(file);
      return Promise.resolve();
    }
  };

  const drag = {
    cs: [],
    onDrag(c) {
      drag.cs.push(c);
    }
  };

  let launchConsumer = null;
  const launchQueue = {
    setConsumer(fn) {
      launchConsumer = fn;
    }
  };

  const onMessageListeners = [];
  const sentMessages = [];
  const chrome = {
    storage: {
      local: {
        get: async defaults => ({...defaults})
      },
      onChanged: {
        addListener() {}
      }
    },
    runtime: {
      onMessage: {
        addListener: fn => onMessageListeners.push(fn)
      },
      sendMessage(message, callback) {
        sentMessages.push(message);
        if (callback) {
          callback(true);
        }
      },
      lastError: null
    }
  };

  // the audio view; play() and friends record what they were asked to start
  const parentEl = makeElement('parent');
  const progressEl = makeElement('progress');
  const audio = {
    files: null,
    i: 0,
    volume: 0.7,
    skipPeriod: 10,
    source: null,
    ready: false,
    audioBuffer: null,
    session: 0,
    started: [],
    listeners: {},
    focusCount: 0,
    resetCount: 0,
    pauseCount: 0,

    addEventListener(type, fn) {
      (audio.listeners[type] = audio.listeners[type] || []).push(fn);
    },
    shadowRoot: {
      getElementById: id => (id === 'parent' ? parentEl : progressEl)
    },
    focus() {
      audio.focusCount += 1;
    },
    play() {
      audio.started.push(audio.files ? (audio.files[audio.i || 0] || null) : null);
      return Promise.resolve();
    },
    playDecoded() {
      return audio.play();
    },
    playStream() {
      return audio.play();
    },
    reset() {
      audio.resetCount += 1;
    },
    pause() {
      audio.pauseCount += 1;
    },
    // run the registered handlers of one event type (the page fires the
    // 'ended', 'error' and 'empty' events of the audio view this way)
    dispatch(type, e = {}) {
      for (const fn of (audio.listeners[type] || []).slice()) {
        fn(e);
      }
    }
  };

  // the list view; `rows` mirrors audio.files like the real hidden select
  const rows = [];
  const options = [{offsetTop: 0, offsetHeight: 0}]; // option 0: the header
  const select = {
    options,
    selectedIndex: 0,
    getBoundingClientRect: () => ({top: 0, left: 0, width: 400, height: rows.length * 20})
  };
  const makeDiv = () => {
    const div = makeElement();
    div.lastElementChild = {textContent: ''};
    return div;
  };
  const view = {
    rows,
    onchange: null,
    shadowRoot: {
      getElementById: () => select
    },
    option(parts, name, value, selected) {
      const row = {
        name,
        value,
        selected,
        parts,
        _internal: {div: makeDiv()},
        inserted: false,
        insert() {
          row.inserted = true;
          /* the real select re-lays its options out on every change, so the
             geometry of a row follows its live position, not the position
             it was inserted at */
          const o = {
            get offsetTop() {
              return Math.max(0, options.indexOf(o) - 1) * 20;
            },
            offsetHeight: 20
          };
          options.push(o);
          rows.push(row);
        }
      };
      return row;
    },
    // the page counts the hidden header row: removeIndex takes an option index
    removeIndex(n) {
      if (n >= 1 && n < options.length) {
        options.splice(n, 1);
        rows.splice(n - 1, 1);
      }
    },
    clear() {
      options.length = 1;
      rows.length = 0;
      select.selectedIndex = 0;
    },
    get selectedIndex() {
      return select.selectedIndex;
    },
    set selectedIndex(n) {
      select.selectedIndex = n;
    }
  };

  const elements = new Map();
  const documentListeners = {};
  const document = {
    title: '',
    activeElement: null,
    getElementById(id) {
      if (elements.has(id) === false) {
        elements.set(id, id === 'audio' ? audio : (id === 'view' ? view : makeElement(id)));
      }
      return elements.get(id);
    },
    createElement: () => makeElement(),
    addEventListener(type, fn) {
      (documentListeners[type] = documentListeners[type] || []).push(fn);
    },
    // run the registered document handlers of one event type
    dispatch(type, e = {}) {
      for (const fn of (documentListeners[type] || []).slice()) {
        fn(e);
      }
    }
  };

  // the whole-file play path reads the input with a FileReader
  class FileReader {
    readAsArrayBuffer(file) {
      queueMicrotask(() => {
        this.result = {byteLength: (file && file.size) || 0};
        if (this.onload) {
          this.onload();
        }
      });
    }
  }

  const sandbox = {
    console,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    document,
    location: {search: ''},
    localStorage: {
      getItem: () => null,
      setItem() {}
    },
    chrome,
    CSS: {supports: () => false},
    HTMLDialogElement: {prototype: {}},
    innerHeight: 1000,
    innerWidth: 1000,
    alert() {},
    FileReader,
    drag,
    launchQueue,
    /* the Web Lock that elects the copy answering a broadcast; the
       single copy of a test always wins it */
    navigator: {
      locks: {
        request(name, options, fn) {
          return fn({});
        }
      }
    },
    decoder: {cancel() {}},
    remember,
    htime: d => d
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(INDEX, 'utf8'), sandbox, {filename: INDEX});

  /* a local test track; `handle` gives it a comparable identity. The
     options of a handle:
     - gate: every isSameEntry comparison parks on it until the test
       releases it (FIFO; the parked call still resolves truthfully)
     - permission: the promise that requestPermission resolves with, so an
       unlock can be held open on demand
     - real: the file that getFile returns (the readable copy) */
  const makeHandle = (id, opts = {}) => {
    const real = opts.real || {
      name: 'readable',
      size: 100,
      lastModified: 1,
      type: 'audio/x-test'
    };

    return {
      id,
      isSameEntry: other => {
        const same = id === other.id;
        return opts.gate ? opts.gate.wait(same) : Promise.resolve(same);
      },
      requestPermission: () => opts.permission || Promise.resolve('granted'),
      getFile: async () => ({...real})
    };
  };

  const makeFile = (name, handle, extra = {}) => Object.assign({
    name,
    // below STREAM_LIMIT: the whole-file play path of play()
    size: 100,
    lastModified: 1,
    type: 'audio/x-test',
    handle
  }, extra);

  return {
    audio,
    view,
    document,
    drag,
    remember,
    sentMessages,
    gates: {makeGate},

    makeHandle,
    makeFile,

    // resolve the pending restore of the remembered tracks
    finishRestore: (files, index) => restoreValue({files, index}),

    // the four entry points of add()
    add: files => drag.cs[0](files),
    jobs: jobs => {
      let responded;
      for (const fn of onMessageListeners) {
        fn({method: 'jobs', jobs}, {}, r => {
          responded = r;
        });
      }
      return responded;
    },
    launch: files => launchConsumer({files}),

    // open the context menu on the row that covers `y` (rows are 20px high)
    openMenuAt: y => {
      document.dispatch('contextmenu', {
        composedPath: () => [document.getElementById('playlist')],
        preventDefault() {},
        clientX: 5,
        clientY: y
      });
    },
    clickMenu: id => document.getElementById(id).dispatch('click'),

    // the rows must always stay a mirror of audio.files
    checkMirrored: () => {
      const files = audio.files || [];
      if (rows.length !== files.length) {
        throw Error('the view has ' + rows.length + ' rows for ' + files.length + ' tracks');
      }
      for (let i = 0; i < files.length; i += 1) {
        if (rows[i].name !== files[i].name) {
          throw Error('row ' + i + ' shows ' + rows[i].name + ' while the track is ' + files[i].name);
        }
      }
    }
  };
};

module.exports = {makePlayerWorld};

/* let a few macrotask turns pass so that the promise chains of the page
   (the mutation queue, the FileReader reads, the restore) settle */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const settleAll = async rounds => {
  for (let i = 0; i < (rounds || 20); i += 1) {
    await settle();
  }
};

module.exports.settle = settle;
module.exports.settleAll = settleAll;
