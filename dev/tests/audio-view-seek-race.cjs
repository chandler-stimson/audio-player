/* Node test: the seek ownership of the real audio-view.js during rapid
   scrubbing. Every chained seek captures the position it started from and
   its failure falls back to that position; only the seek that still owns
   the stream state may apply its fallback, or an older failure would jump
   the playhead backward while a newer seek already moved it (and replay
   audio from the stale location). The fake session defers its seek
   responses so that the test can interleave the settlements exactly like
   the ordered worker responses do.

   What is verified:

      - an older seek that fails behind a newer one restores nothing: the
        playhead stays at the newest target, the newest seek keeps the
        ownership and no pull is issued for the stale fallback
      - an older seek that succeeds behind a newer one writes nothing:
        its result must not land on the newer target's coverage
      - a pending seek that fails after a seek to the end took the state
        over (the revision bump) restores neither position nor coverage
      - a session that dies between two scrubbed seeks reports the failure
        once and the queued rejections of both seeks stay silent

   Run: node dev/tests/audio-view-seek-race.cjs */

const {loadAudioView, makeAudioViewWorld} = require('./harness.cjs');

/* --------------------------------------------------------------- fake world */

/* the scenario world of this test: the shared fake world plus a fake
   decoder session (mono 1000 Hz, one chunk per second) whose seeks settle
   only when the test resolves or rejects them */
const makeWorld = () => {
  const world = makeAudioViewWorld();
  world.seekCalls = [];
  world.pendingSeeks = [];
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
      /* a seek that answers later: the element chains the next seek behind
         it and only the newest one may write the stream state */
      seek(to) {
        world.seekCalls.push(to);
        const entry = {to};
        entry.done = new Promise((resolve, reject) => {
          entry.resolve = () => {
            // the worker re-cues the decoder only for a served seek
            session.epoch += 1;
            session.from = Math.floor(to);
            resolve({epoch: session.epoch, to});
          };
          entry.reject = reject;
        });
        world.pendingSeeks.push(entry);
        return entry.done;
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

const settle = async () => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
};

const run = async () => {
  const {world, ctx, context} = makeWorld();
  const el = new ctx.AudioViewClass();
  el.connectedCallback();

  const errors = [];
  el.addEventListener('error', e => errors.push(e.detail));

  const session = world.makeSession(60);
  ctx.decoder.open = o => {
    session.onchunk = o.onchunk;
    session.onstop = o.onstop;
    return Promise.resolve(session);
  };

  /* play: the first window decodes and the run starts at position zero */
  await el.playStream({file: {}});
  await settle();

  if (!el.stream || el.stream.duration !== 60) {
    throw Error('the stream state was not built');
  }
  if (!el.stream.wantPlay || world.scheduled.length < 10) {
    throw Error('the stream did not start playing');
  }

  /* an older seek that fails behind a newer one: the fallback of its stale
     position must not fire, or the playhead jumps backward and replays
     audio from the old location */
  el.currentTime = 55; // seek A, out of the decoded window
  el.currentTime = 58; // seek B, chains behind A
  await settle();
  if (world.seekCalls.join(',') !== '55,58') {
    throw Error('the scrubbing did not chain two seeks: ' + JSON.stringify(world.seekCalls));
  }
  if (!el.stream.seeking) {
    throw Error('the chained seek did not take the stream state');
  }
  const pullsBefore = world.pulls.length;
  const eventsBefore = world.events.length;
  world.pendingSeeks[0].reject(Error('SEEK_FAILED'));
  await settle();
  if (el.currentTime !== 58) {
    throw Error('the failed seek restored its stale position: ' + el.currentTime);
  }
  if (!el.stream.seeking) {
    throw Error('the failed seek stole the ownership of the newer one');
  }
  if (world.pulls.length !== pullsBefore) {
    throw Error('the stale fallback issued work: ' + JSON.stringify(world.pulls));
  }
  if (world.events.slice(eventsBefore).join(',')) {
    throw Error('the stale fallback dispatched ' + JSON.stringify(world.events.slice(eventsBefore)));
  }
  console.log('stale failure ok: the playhead stayed at', el.currentTime);

  /* the newest seek still owns the stream: its success re-cues the decode
     at its target and the run restarts there */
  world.scheduled.length = 0;
  world.pendingSeeks[1].resolve();
  await settle();
  if (!world.scheduled.length) {
    throw Error('the newest seek did not restart the run');
  }
  const restarted = world.scheduled[0].started;
  if (restarted.offset !== 0 ||
      Math.abs(restarted.when - context.currentTime - 0.05) > 0.001) {
    throw Error('the run restarted at ' + JSON.stringify(restarted) +
      ' instead of the newest target');
  }
  if (el.stream.covered < 58 || el.stream.chunks[0].pos !== 58) {
    throw Error('the newest seek did not re-cue the decode: ' +
      JSON.stringify({covered: el.stream.covered, at: el.stream.chunks[0] && el.stream.chunks[0].pos}));
  }
  console.log('newest seek ok: the run restarted at', el.stream.chunks[0].pos);

  /* an older seek that succeeds behind a newer one: its result must not
     land on the newer target's state either (only the newest seek of a
     chain writes the coverage) */
  el.currentTime = 40; // seek C, out of the [58,60) window
  el.currentTime = 45; // seek D, chains behind C
  await settle();
  const coveredBefore = el.stream.covered;
  const chunksBefore = el.stream.chunks.length;
  world.pendingSeeks[2].resolve(); // C succeeds while D owns the stream
  await settle();
  if (el.stream.covered !== coveredBefore) {
    throw Error('the superseded seek wrote the coverage: ' + el.stream.covered);
  }
  if (el.stream.chunks.length !== chunksBefore) {
    throw Error('the superseded seek voided the window');
  }
  if (el.currentTime !== 45) {
    throw Error('the superseded seek moved the playhead: ' + el.currentTime);
  }
  console.log('superseded success ok: the state of', coveredBefore, 'stood');

  /* the newest seek of the pair re-cues the decode at its target */
  world.scheduled.length = 0;
  world.pendingSeeks[3].resolve();
  await settle();
  const recued = world.scheduled[0].started;
  if (recued.offset !== 0 || el.stream.covered < 45 || el.stream.chunks[0].pos !== 45) {
    throw Error('the newest seek did not re-cue: ' + JSON.stringify({
      started: recued,
      covered: el.stream.covered,
      at: el.stream.chunks[0] && el.stream.chunks[0].pos
    }));
  }
  console.log('newest seek ok: the run restarted at', el.stream.chunks[0].pos);

  /* a pending seek that fails after a seek to the end took the state over:
     the revision bump must void its fallback too (the ended playhead must
     not jump back to the seek's origin) */
  world.scheduled.length = 0;
  el.currentTime = 20; // seek E, the window was left behind
  await settle();
  const eventsMid = world.events.length;
  const seeksMid = world.seekCalls.length;
  el.currentTime = 90; // clamps to the end; the finished state is entered directly
  await settle();
  if (world.seekCalls.length !== seeksMid) {
    throw Error('the seek to the end asked the decoder');
  }
  if (world.events.slice(eventsMid).join(',') !== 'pause,ended,timeupdate') {
    throw Error('the seek to the end produced ' + JSON.stringify(world.events.slice(eventsMid)));
  }
  const genAtEnd = el.stream.gen;
  world.pendingSeeks[4].reject(Error('SEEK_FAILED'));
  await settle();
  if (el.currentTime !== 60) {
    throw Error('the stale fallback jumped back from the end to ' + el.currentTime);
  }
  if (!el.stream.done || el.stream.covered !== 60) {
    throw Error('the stale fallback rewrote the finished state: ' +
      JSON.stringify({done: el.stream.done, covered: el.stream.covered}));
  }
  if (el.stream.gen !== genAtEnd) {
    throw Error('the stale fallback bumped the revision');
  }
  if (world.scheduled.length) {
    throw Error('the stale fallback scheduled a run');
  }
  console.log('end-seek race ok: the ended playhead stayed at', el.currentTime);

  /* a session that dies between two scrubbed seeks: the failure is
     reported once and the rejections of both queued seeks stay silent */
  const errorsBefore = errors.length;
  const eventsDeath = world.events.length;
  el.currentTime = 20; // seek F
  el.currentTime = 25; // seek G, chains behind F
  await settle();
  session.onstop(Error('DECODER_WORKER_CRASH'));
  await settle();
  world.pendingSeeks[5].reject(Error('SEEK_FAILED'));
  await settle();
  world.pendingSeeks[6].reject(Error('SEEK_FAILED'));
  await settle();
  if (errors.length !== errorsBefore + 1 || errors[errorsBefore] !== 'DECODER_WORKER_CRASH') {
    throw Error('the dead session reported ' + JSON.stringify(errors.slice(errorsBefore)));
  }
  if (el.currentTime !== 25) {
    throw Error('the dead session moved the playhead to ' + el.currentTime);
  }
  if (el.stream.failed === null || el.stream.wantPlay) {
    throw Error('the dead session left the stream playable');
  }
  if (el.stream.seeking !== null) {
    throw Error('the dead session left a seek behind');
  }
  if (world.scheduled.length || world.events.slice(eventsDeath).indexOf('play') !== -1) {
    throw Error('the dead session restarted the playback');
  }
  console.log('session death ok: frozen at', el.currentTime, 'with one error');

  console.log('AUDIO-VIEW SEEK RACE TEST PASSED');
};

run().catch(e => {
  console.error('AUDIO-VIEW SEEK RACE TEST FAILED:', e.message);
  process.exit(1);
});
