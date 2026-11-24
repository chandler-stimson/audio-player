/* Node test: the windowed playback scheduler of the real audio-view.js
   inside a minimal DOM stub. A fake AudioContext with a test-controlled
   clock and a fake decoder session (1000 Hz, 1s chunks) drive the component
   through:

     - the initial run: chained sources at contiguous context times
     - the pull cadence: the window is decoded ahead and not further
     - pause/ resume: the run restarts at the paused position
     - an in-window seek: the run restarts inside the covering chunk
     - an out-of-window seek: the decoder session is re-cued
     - the end of the stream: the last source reports ended
     - the play button after the end: the spent stream replays from the
       origin like the buffer mode does
     - starvation: the run stops where the audio ran out and recovers

   Run: node dev/tests/audio-view-scheduler.cjs */

const {loadAudioView, makeAudioViewWorld} = require('./harness.cjs');

/* --------------------------------------------------------------- fake world */

/* the scenario world of this test: the shared fake world plus a fake
   decoder session (mono 1000 Hz, one chunk per second) */
const makeWorld = () => {
  const world = makeAudioViewWorld();
  world.seekCalls = [];
  world.pulls = [];

  /* a fake streaming session: mono 1000 Hz, one chunk per second; the
     emissions happen on microtasks like the real worker round trips */
  world.makeSession = duration => {
    const session = {
      meta: {
        'Duration': duration,
        'Sample Rate': 1000,
        'Channels': 1
      },
      epoch: 0,
      from: 0,
      pending: null,
      onchunk: null,
      onstop: null,
      pullUntil(until) {
        world.pulls.push(until);
        if (session.pending) {
          return session.pending;
        }
        session.pending = (async () => {
          // defer to a microtask so that the caller registers its in-flight
          // pull before the chunks arrive (the real worker needs a round
          // trip for the same effect)
          await Promise.resolve();
          const end = Math.min(until, duration);
          for (let p = Math.floor(session.from); p < end; p += 1) {
            if (session.onchunk) {
              session.onchunk({
                epoch: session.epoch,
                pos: p,
                samples: 1000,
                sampleRate: 1000,
                channels: [new Float32Array(1000)]
              });
            }
          }
          session.from = Math.max(session.from, end);
          return {
            covered: session.from,
            done: session.from >= duration,
            stalled: false
          };
        })().then(r => {
          session.pending = null;
          return r;
        });
        return session.pending;
      },
      seek(to) {
        world.seekCalls.push(to);
        if (session.failSeeks) {
          return Promise.reject(Error('SEEK_FAILED'));
        }
        session.epoch += 1;
        // the fake session decodes in whole-second chunks
        session.from = Math.floor(to);
        session.pending = null;
        return Promise.resolve({epoch: session.epoch, to});
      },
      close() {
        return Promise.resolve();
      }
    };
    return session;
  };

  // the audio view reaches the fake context through the decoder stub, and
  // the scenario replaces its open with the session above
  const decoder = {
    context: () => world.context
  };
  const ctx = loadAudioView({decoder, world});

  return {world, ctx, context: world.context};
};

/* ----------------------------------------------------------------------- run */

const run = async () => {
  const {world, ctx, context} = makeWorld();
  const el = new ctx.AudioViewClass();
  el.connectedCallback();

  const session = world.makeSession(60);
  ctx.decoder.open = o => {
    session.onchunk = o.onchunk;
    session.onstop = o.onstop;
    return Promise.resolve(session);
  };

  /* play: the first window decodes and the run starts at position zero */
  await el.playStream({file: {}});

  // the fake session delivers synchronously; let the promise bookkeeping run
  await new Promise(resolve => setImmediate(resolve));

  if (!el.stream || el.stream.duration !== 60) {
    throw Error('the stream state was not built: ' + JSON.stringify(el.stream && el.stream.duration));
  }
  if (el.stream.chunks.length < 10) {
    throw Error('the window did not fill: ' + el.stream.chunks.length + ' chunks');
  }
  if (world.scheduled.length < 10) {
    throw Error('the run did not schedule the window: ' + world.scheduled.length + ' sources');
  }
  const first = world.scheduled[0].started;
  if (Math.abs(first.when - context.currentTime - 0.05) > 0.001 || first.offset !== 0) {
    throw Error('the first source starts at ' + JSON.stringify(first));
  }
  // the chain is sample-accurate: each source picks up where the previous
  // one ends
  for (let i = 1; i < world.scheduled.length; i += 1) {
    const prev = world.scheduled[i - 1].started;
    const cur = world.scheduled[i].started;
    if (Math.abs(cur.when - (prev.when + 1)) > 0.001) {
      throw Error('source ' + i + ' is not chained: ' + JSON.stringify({prev, cur}));
    }
  }
  if (world.events.indexOf('loadedmetadata') === -1 || world.events.indexOf('play') === -1) {
    throw Error('the metadata and play events did not fire: ' + JSON.stringify(world.events));
  }
  console.log('initial run ok:', world.scheduled.length, 'sources chained');

  /* the playhead follows the clock; the run was scheduled 50ms into the
     future, so the audible position lags the wall clock by that gap */
  world.tick(2500);
  if (Math.abs(el.currentTime - 2.45) > 0.001) {
    throw Error('the playhead is at ' + el.currentTime + ' after 2.5s');
  }

  /* pause and resume: the run restarts at the paused position */
  el.pause();
  if (!world.stopped.length || world.events[world.events.length - 1] !== 'pause') {
    throw Error('pause did not stop the run');
  }
  if (Math.abs(el.currentTime - 2.45) > 0.001) {
    throw Error('the paused position is ' + el.currentTime);
  }
  world.scheduled.length = 0;
  el.play();
  await new Promise(resolve => setImmediate(resolve));
  const resume = world.scheduled[0].started;
  // 2.45 lies inside the [2,3) chunk, so the run restarts at its 0.45s mark
  if (Math.abs(resume.offset - 0.45) > 0.001) {
    throw Error('the resume starts at offset ' + resume.offset);
  }
  console.log('pause/resume ok: offset', resume.offset, 'inside the [2,3) chunk');

  /* an in-window seek restarts inside the covering chunk without the decoder */
  world.seekCalls.length = 0;
  world.scheduled.length = 0;
  el.currentTime = 20.4;
  await new Promise(resolve => setImmediate(resolve));
  if (world.seekCalls.length) {
    throw Error('an in-window seek re-cued the decoder');
  }
  const seeked = world.scheduled[0].started;
  if (Math.abs(seeked.offset - 0.4) > 0.001) {
    throw Error('the in-window seek restarts at offset ' + seeked.offset);
  }
  // the run starts 50ms into the future; 100ms after the seek, 50ms of the
  // sought position have actually played
  world.tick(100);
  if (Math.abs(el.currentTime - 20.45) > 0.001) {
    throw Error('the playhead after the seek is ' + el.currentTime);
  }
  console.log('in-window seek ok: offset', seeked.offset, 'inside the chunk');

  /* an out-of-window seek re-cues the decoder session; the decoded window
     reaches a whole chunk past its horizon, so the target must clear that
     edge too */
  world.scheduled.length = 0;
  el.currentTime = 55;
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  if (world.seekCalls.length !== 1 || world.seekCalls[0] !== 55) {
    throw Error('the out-of-window seek did not re-cue the decoder: ' + JSON.stringify(world.seekCalls));
  }
  const recued = world.scheduled[0].started;
  if (Math.abs(recued.offset - 0) > 0.001) {
    throw Error('the re-cued run starts at offset ' + recued.offset);
  }
  console.log('out-of-window seek ok: re-cued to', world.seekCalls[0]);

  /* the end of the stream: the last source carries the ended signal; the
     clock advances to just before the scheduled end and the source fires
     it like a browser does at the natural end of a buffer */
  world.tick(5000);
  await new Promise(resolve => setImmediate(resolve));
  const last = world.scheduled[world.scheduled.length - 1];
  // the re-cued position leaves five seconds of the track
  if (world.scheduled.length < 5) {
    throw Error('the tail of the stream was not scheduled');
  }
  if (!last.onended) {
    throw Error('the final source does not carry the ended signal');
  }
  const eventsBefore = world.events.length;
  last.onended();
  if (world.events.slice(eventsBefore).join(',') !== 'pause,ended') {
    throw Error('the end produced ' + JSON.stringify(world.events.slice(eventsBefore)));
  }
  if (Math.abs(el.currentTime - 60) > 0.01) {
    throw Error('the playhead after the end is ' + el.currentTime);
  }
  console.log('end ok: pause + ended at', el.currentTime);

  /* the play button after the natural end: a fully consumed stream has no
     chunk left at its playhead (the window is half-open), so the resume
     must restart the track from its origin like the buffer mode does */
  {
    const seeks = world.seekCalls.length;
    const from = world.events.length;
    world.scheduled.length = 0;
    el.toggle();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    if (world.seekCalls.length !== seeks + 1 || world.seekCalls[seeks] !== 0) {
      throw Error('the ended stream was not re-cued to the origin: ' + JSON.stringify(world.seekCalls));
    }
    if (world.events.indexOf('play', from) === -1) {
      throw Error('the play button did not restart the ended stream: ' + JSON.stringify(world.events.slice(from)));
    }
    const replay = world.scheduled[0].started;
    if (replay.offset !== 0) {
      throw Error('the replay starts at chunk offset ' + replay.offset);
    }
    console.log('play-after-end ok: the ended stream replays from the origin');
  }

  /* starvation: the clock runs past the scheduled chain and the run
     recovers where the audio ran out */
  el.currentTime = 0;
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  world.scheduled.length = 0;
  world.stopped.length = 0;
  // jump the clock beyond everything that was scheduled
  world.tick(40000);
  world.tick(5000);
  world.tick(5000);
  await new Promise(resolve => setImmediate(resolve));
  if (!world.stopped.length) {
    throw Error('the starved run was not stopped');
  }
  // the position waits where the audio ran out (a whole-number chunk edge of
  // the fake session), lagged by the scheduling epsilon of the recovery run
  const lagged = (el.currentTime + 0.05) % 1;
  if (Math.abs(lagged) > 0.01 && Math.abs(lagged) < 0.99) {
    throw Error('the starved position is not on a chunk edge: ' + el.currentTime);
  }
  // the window keeps being requested even while the run is down
  if (!world.pulls.length) {
    throw Error('the starved run stopped decoding');
  }
  console.log('starvation ok: recovered at', el.currentTime.toFixed(2),
    'with', world.pulls.length, 'pull requests');

  /* a seek that the input cannot serve falls back to the previous position
     and keeps the track paused when it was paused */
  el.pause();
  await new Promise(resolve => setImmediate(resolve));
  const pausedAt = el.currentTime;
  world.scheduled.length = 0;
  session.failSeeks = true;
  el.currentTime = 90; // clamps to the end of the track, beyond the window
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  if (Math.abs(el.currentTime - pausedAt) > 0.001) {
    throw Error('the failed seek moved the position to ' + el.currentTime);
  }
  if (world.scheduled.length) {
    throw Error('the failed seek resumed the paused track');
  }
  if (el.stream.wantPlay) {
    throw Error('the failed seek left the playback intent on');
  }
  console.log('failed seek ok: paused at', pausedAt.toFixed(2), 'and unchanged');

  console.log('AUDIO-VIEW SCHEDULER TEST PASSED');
};

run().catch(e => {
  console.error('AUDIO-VIEW SCHEDULER TEST FAILED:', e.message);
  process.exit(1);
});
