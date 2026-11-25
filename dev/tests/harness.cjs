/* The shared harness of the node tests: the pieces that every test of the
   player needs but that are not specific to one scenario.

     - makeWav / expectedSample: a synthesized test tone
     - makeWorkerClass: the fake Worker that runs the real worker.js + wasm
       inside a vm context and bridges its messages both ways
     - loadWrapper: the real wrapper.js in a fresh context
     - makeAudioViewWorld: a fake DOM clock with a fake AudioContext
     - loadAudioView: the real audio-view.js bound to such a world

   The worker environment itself (the vm context that emulates a browser
   worker for the emscripten glue) lives in fake-worker.cjs. */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {startWorker, makeFile} = require('./fake-worker.cjs');

const DECODER_DIR = path.resolve(__dirname, '../../v2/data/player/decoder');
const AUDIO_VIEW = path.resolve(__dirname, '../../v2/data/player/components/audio-view.js');
const VOLUME_VIEW = path.resolve(__dirname, '../../v2/data/player/components/volume-view.js');

/* --------------------------------------------------- a tiny 44100 Hz stereo WAV */

/* the sample value that the synthesized wave carries at an index */
const expectedSample = (i, c = 0, rate = 44100) =>
  Math.round(30000 * Math.sin((i % rate) / rate * 2 * Math.PI * 440 * (c + 1))) / 32768;

const makeWav = (seconds, rate = 44100, channels = 2, fill = true) => {
  const samples = seconds * rate;
  const dataBytes = samples * channels * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);          // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  if (fill) {
    for (let i = 0; i < samples; i += 1) {
      for (let c = 0; c < channels; c += 1) {
        buffer.writeInt16LE(Math.round(30000 * Math.sin((i % rate) / rate * 2 * Math.PI * 440 * (c + 1))),
          44 + (i * channels + c) * 2);
      }
    }
  }
  return new Uint8Array(buffer);
};

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

/* --------------------------------------------------- the fake Worker of the wrapper */

/* a Worker whose script is the real worker.js inside a vm context; the
   postMessage of the worker side is bridged to onmessage like in a
   browser */
const makeWorkerClass = () => class Worker {
  constructor(url) {
    const self = this;
    this.onerror = null;
    this.onmessage = null;
    this.terminated = false;
    this.inner = startWorker({
      onpost(msg) {
        if (!self.terminated && self.onmessage) {
          self.onmessage({data: msg});
        }
      }
    });
  }
  postMessage(msg) {
    if (!this.terminated) {
      this.inner.post(msg);
    }
  }
  terminate() {
    this.terminated = true;
  }
};

/* ------------------------------------------------------------- the real wrapper */

/* loads the real wrapper.js into a fresh context; the AudioContext class is
   the only environment-specific part (the batch path builds its AudioBuffer
   through it) */
const loadWrapper = ({AudioContext}) => {
  const ctx = {
    console,
    Worker: makeWorkerClass(),
    AudioContext,
    window: {}
  };
  vm.createContext(ctx);
  new vm.Script(fs.readFileSync(path.join(DECODER_DIR, 'wrapper.js')), {
    filename: 'wrapper.js'
  }).runInContext(ctx);
  return ctx.window.decoder;
};

/* ------------------------------------------------------- the fake audio world */

/* a test-controlled clock with the fake AudioContext of the audio view: the
   sources that the component schedules are recorded, its timers only run
   when the test ticks, and its events are collected */
const makeAudioViewWorld = () => {
  const world = {
    ms: 0,
    timers: {},
    nextTimer: 1,
    scheduled: [],
    stopped: [],
    events: []
  };
  world.tick = ms => {
    world.ms += ms;
    for (const [id, t] of Object.entries(world.timers)) {
      if (t.at <= world.ms) {
        t.fn();
        if (t.interval) {
          t.at += t.interval;
        }
        else {
          delete world.timers[id];
        }
      }
    }
  };

  world.context = {
    get currentTime() {
      return world.ms / 1000;
    },
    state: 'running',
    resume() {},
    destination: {},
    createBuffer(channels, length, sampleRate) {
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        duration: length / sampleRate,
        copyToChannel() {}
      };
    },
    createBufferSource() {
      const source = {
        buffer: null,
        onended: null,
        started: null,
        connect() {},
        disconnect() {},
        stop() {
          world.stopped.push(source);
        },
        start(when, offset) {
          source.started = {when, offset: offset || 0};
          world.scheduled.push(source);
        }
      };
      return source;
    },
    createGain() {
      return {
        gain: {value: 1},
        connect() {},
        disconnect() {}
      };
    }
  };
  return world;
};

/* ------------------------------------------------------------------ stub DOM */

/* the fake element that the shadow queries of a loaded component return;
   it records the listeners, the seek calls and the attribute writes */
const makeElementFactory = () => {
  const elements = {};
  const element = id => {
    if (!elements[id]) {
      elements[id] = {
        handlers: {},
        textContent: '',
        percent: 0,
        volume: 0,
        addEventListener(type, fn) {
          this.handlers[type] = fn;
        },
        seek(pct) {
          this.percent = pct;
        },
        setAttribute(name, value) {
          (this.attributes || (this.attributes = {}))[name] = value;
        },
        getAttribute() {
          return null;
        },
        toggleMute() {}
      };
    }
    return elements[id];
  };
  return {element, elements};
};

/* the fake HTMLElement that a loaded component class extends; the events
   array of the caller collects every dispatch */
const makeHTMLElementClass = ({element, events}) => class HTMLElement {
  constructor() {
    this.handlers = {};
    const shadow = {
      set innerHTML(v) {},
      addEventListener() {},
      getElementById: element
    };
    this.attachShadow = () => shadow;
    this.shadowRoot = shadow;
  }
  addEventListener(type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
  }
  dispatchEvent(e) {
    events.push(e.type);
    for (const fn of this.handlers[e.type] || []) {
      fn(e);
    }
    return true;
  }
};

/* --------------------------------------------------------- the real audio view */

/* loads the real audio-view.js into a fresh context bound to a world; the
   decoder that it reads is the one of the caller */
const loadAudioView = ({decoder, world}) => {
  const {element} = makeElementFactory();
  const HTMLElement = makeHTMLElementClass({element, events: world.events});

  const ctx = {
    console,
    setTimeout(fn, ms) {
      world.timers[world.nextTimer] = {fn, at: world.ms + ms};
      return world.nextTimer++;
    },
    clearTimeout(id) {
      delete world.timers[id];
    },
    setInterval(fn, ms) {
      world.timers[world.nextTimer] = {fn, at: world.ms + ms, interval: ms};
      return world.nextTimer++;
    },
    clearInterval(id) {
      delete world.timers[id];
    },
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    CustomEvent: class {
      constructor(type, o) {
        this.type = type;
        this.detail = o && o.detail;
      }
    },
    HTMLElement,
    /* the audio view observes the mode attribute of its root to keep the
       play button label truthful; no test drives attribute writes
       through a real observer, so the stub only needs to exist */
    MutationObserver: class {
      observe() {}
    },
    document: undefined,
    window: {
      customElements: {
        define(name, cls) {
          ctx.AudioViewClass = cls;
        }
      }
    },
    decoder
  };
  ctx.self = ctx;
  vm.createContext(ctx);

  new vm.Script(fs.readFileSync(AUDIO_VIEW), {filename: 'audio-view.js'}).runInContext(ctx);

  return ctx;
};

/* --------------------------------------------------------- the real volume view */

/* loads the real volume-view.js into a fresh context; the shadow queries of
   the component return the generic stubs of the element factory */
const loadVolumeView = () => {
  const events = [];
  const {element, elements} = makeElementFactory();
  const HTMLElement = makeHTMLElementClass({element, events});

  const ctx = {
    console,
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    CustomEvent: class {
      constructor(type, o) {
        this.type = type;
        this.detail = o && o.detail;
      }
    },
    HTMLElement,
    document: undefined,
    window: {
      customElements: {
        define(name, cls) {
          ctx.VolumeViewClass = cls;
        }
      }
    }
  };
  ctx.self = ctx;
  vm.createContext(ctx);

  new vm.Script(fs.readFileSync(VOLUME_VIEW), {filename: 'volume-view.js'}).runInContext(ctx);

  return {VolumeViewClass: ctx.VolumeViewClass, element, elements, events};
};

module.exports = {
  DECODER_DIR,
  AUDIO_VIEW,
  VOLUME_VIEW,
  expectedSample,
  makeWav,
  makeFile,
  settle,
  makeWorkerClass,
  loadWrapper,
  makeAudioViewWorld,
  loadAudioView,
  loadVolumeView
};
