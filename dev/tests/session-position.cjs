/* Node test: the media session reporting of the real
   v2/data/player/session.js inside a minimal DOM stub.

   The regression this file guards: the session element of the page is a
   looping silence placeholder (v2/data/player/silence.mp3, 10.224s), and
   the media session rode on it without ever reporting the timeline of the
   real playback. The controls of the OS fell back to the length of the
   placeholder, so every track showed as a 10-second one:

     - loadedmetadata reports the duration of the track with the playhead
     - play, the 200ms progress loop and pause keep the position fresh
     - a track whose length is unknown yet reports nothing
     - the reported position never leaves the duration (nor zero)
     - a track change replaces the reported timeline
     - seekto moves the playhead of a loaded track and reports it right
       away; an unloaded track and a seek without a time do nothing
     - the placeholder still plays and pauses with the playback and the
       action handlers of the session stay registered

   Run: node dev/tests/session-position.cjs */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SESSION = path.resolve(__dirname, '../../v2/data/player/session.js');

/* ------------------------------------------------------------------- world */

const makeWorld = () => {
  const states = [];
  const dummy = {
    played: 0,
    paused: 0,
    play() {
      dummy.played += 1;
    },
    pause() {
      dummy.paused += 1;
    }
  };
  const elements = {dummy};
  const audio = {
    file: null,
    duration: 0,
    currentTime: 0,
    ready: false,
    listeners: {},
    addEventListener(type, fn) {
      (audio.listeners[type] = audio.listeners[type] || []).push(fn);
    },
    // run the registered handlers of one event type
    dispatch(type) {
      for (const fn of (audio.listeners[type] || []).slice()) {
        fn({type});
      }
    }
  };
  const handlers = {};
  const mediaSession = {
    metadata: null,
    setActionHandler(action, fn) {
      handlers[action] = fn;
    },
    setPositionState(state) {
      states.push(state);
    }
  };

  const sandbox = {
    document: {
      getElementById(id) {
        if (!elements[id]) {
          elements[id] = {disabled: false}; // the navigation buttons
        }
        return elements[id];
      }
    },
    audio,
    navigator: {mediaSession},
    MediaMetadata: class {
      constructor(init) {
        Object.assign(this, init);
      }
    },
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    KeyboardEvent: class {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init || {});
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SESSION, 'utf8'), sandbox, {
    filename: SESSION
  });

  return {audio, dummy, states, handlers};
};

/* --------------------------------------------------------------------- run */

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const last = states => states[states.length - 1];

const run = async () => {
  const {audio, dummy, states, handlers} = makeWorld();

  // the metadata of a played track is reported under its name
  audio.file = {name: 'track.mp3'};

  /* loadedmetadata reports the timeline of the track; this is the report
     that the old page never made, so the OS showed the 10 seconds of the
     placeholder instead */
  audio.duration = 300;
  audio.currentTime = 0;
  const n = states.length;
  audio.dispatch('loadedmetadata');
  if (states.length !== n + 1 ||
      same(last(states), {duration: 300, position: 0, playbackRate: 1}) === false) {
    throw Error('loadedmetadata reported ' + JSON.stringify(last(states)));
  }
  console.log('loadedmetadata ok: a 300s track is reported as 300s');

  // the play loop keeps the position fresh while the track plays
  audio.currentTime = 42.5;
  audio.dispatch('progress');
  if (same(last(states), {duration: 300, position: 42.5, playbackRate: 1}) === false) {
    throw Error('progress reported ' + JSON.stringify(last(states)));
  }
  console.log('progress ok: the playhead is reported at 42.5s');

  // play reports the resumed position and starts the placeholder
  audio.currentTime = 10;
  audio.dispatch('play');
  if (same(last(states), {duration: 300, position: 10, playbackRate: 1}) === false) {
    throw Error('play reported ' + JSON.stringify(last(states)));
  }
  if (dummy.played !== 1) {
    throw Error('the placeholder was started ' + dummy.played + ' times');
  }
  if (!handlers.play || !handlers.pause) {
    throw Error('the play and pause actions are not registered');
  }
  console.log('play ok: the resume position is reported, the placeholder plays');

  // pause freezes the position at its exact value
  audio.currentTime = 75;
  audio.dispatch('pause');
  if (same(last(states), {duration: 300, position: 75, playbackRate: 1}) === false) {
    throw Error('pause reported ' + JSON.stringify(last(states)));
  }
  if (dummy.paused !== 1) {
    throw Error('the placeholder was paused ' + dummy.paused + ' times');
  }
  console.log('pause ok: the position is frozen at 75s');

  // a track whose length is unknown yet (an ogg without a header index)
  // has no position state to report; neither has one that cannot tell
  audio.duration = null;
  {
    const before = states.length;
    audio.dispatch('progress');
    audio.dispatch('pause');
    if (states.length !== before) {
      throw Error('an unknown length reported ' + JSON.stringify(last(states)));
    }
    audio.duration = 0;
    audio.dispatch('pause');
    if (states.length !== before) {
      throw Error('an empty track reported ' + JSON.stringify(last(states)));
    }
  }
  console.log('unknown length ok: nothing is reported without a duration');

  // the reported position never leaves the duration
  audio.duration = 300;
  audio.currentTime = 500;
  audio.dispatch('pause');
  if (last(states).position !== 300) {
    throw Error('an overshooting playhead reported ' + JSON.stringify(last(states)));
  }
  // nor the zero
  audio.currentTime = -5;
  audio.dispatch('pause');
  if (last(states).position !== 0) {
    throw Error('a negative playhead reported ' + JSON.stringify(last(states)));
  }
  console.log('bounds ok: the position stays inside the duration');

  // a track change replaces the reported timeline
  audio.duration = 95;
  audio.currentTime = 0;
  audio.dispatch('loadedmetadata');
  if (same(last(states), {duration: 95, position: 0, playbackRate: 1}) === false) {
    throw Error('the track change reported ' + JSON.stringify(last(states)));
  }
  console.log('track change ok: the next track reports its own timeline');

  /* the absolute seek of the media panel: the playhead of the loaded track
     moves and the position state follows it right away */
  audio.duration = 300;
  audio.ready = true;
  audio.dispatch('loadedmetadata');
  {
    const before = states.length;
    handlers.seekto({seekTime: 120, fastSeek: false});
    if (audio.currentTime !== 120) {
      throw Error('the seekto left the playhead at ' + audio.currentTime);
    }
    if (states.length !== before + 1 ||
        same(last(states), {duration: 300, position: 120, playbackRate: 1}) === false) {
      throw Error('the seekto reported ' + JSON.stringify(last(states)));
    }
  }
  console.log('seekto ok: the playhead moved to 120s and the state follows');

  // an unloaded track and a seek without a time cannot move a playhead
  {
    const before = states.length;
    audio.ready = false;
    handlers.seekto({seekTime: 50});
    if (audio.currentTime !== 120) {
      throw Error('the unloaded seekto moved the playhead to ' + audio.currentTime);
    }
    audio.ready = true;
    handlers.seekto({});
    handlers.seekto();
    if (audio.currentTime !== 120 || states.length !== before) {
      throw Error('a seek without a time moved the playhead to ' + audio.currentTime +
        ' and reported ' + (states.length - before) + ' state(s)');
    }
  }
  console.log('seekto guards ok: nothing is sought without a track or a time');

  // the navigation and the seek actions of the session stay registered
  for (const action of ['play', 'pause', 'seekbackward', 'seekforward',
    'previoustrack', 'nexttrack', 'seekto']) {
    if (typeof handlers[action] !== 'function') {
      throw Error('the ' + action + ' action is not registered');
    }
  }
  console.log('actions ok: every media session action has its handler');

  console.log('SESSION POSITION TEST PASSED');
};

run().catch(e => {
  console.error('SESSION POSITION TEST FAILED:', e.message);
  process.exit(1);
});
