/* Node test: the timeupdate reports of the real audio-view.js inside the
   fake audio world of the harness.

   The regression this file guards: a seek of a paused track moved the
   playhead without any event, so the reporters of the playback (the media
   session of session.js) kept the stale position until the next play or
   pause. The native scrubber of the OS media panel showed the old
   position and, once it became seekable itself, snapped back to it:

     - a paused seek (streaming and whole-file alike) reports the new
       playhead right away
     - a failed seek of a stream falls back to the previous position and
       reports the fallback, so a reporter that already showed the failed
       target learns the correction
     - the seek to the end enters the finished state (pause + ended) and
       reports the final playhead

   Run: node dev/tests/audio-view-timeupdate.cjs */

const {loadAudioView, makeAudioViewWorld} = require('./harness.cjs');

/* ------------------------------------------------------------------- world */

const makeWorld = () => {
  const world = makeAudioViewWorld();
  world.seekCalls = [];

  /* a fake streaming session: the pull never resolves, so the decoded
     window stays empty and every position is served by a re-cue; the seek
     parks on a deferred that the test resolves or rejects on demand (the
     control always belongs to the newest seek) */
  let resolveSeek = null;
  let rejectSeek = null;
  const makeSession = duration => ({
    meta: {
      'Sample Rate': 1000,
      'Channels': 1,
      ...(duration === undefined ? {} : {'Duration': duration})
    },
    onchunk: null,
    onstop: null,
    pullUntil() {
      return new Promise(() => {});
    },
    seek(to) {
      world.seekCalls.push(to);
      return new Promise((resolve, reject) => {
        resolveSeek = resolve;
        rejectSeek = reject;
      });
    },
    close() {
      return Promise.resolve();
    }
  });

  // the audio view reaches the fake context through the decoder stub, and
  // the scenario replaces its open with the session above
  const decoder = {
    context: () => world.context
  };
  const ctx = loadAudioView({decoder, world});

  return {
    world,
    ctx,
    makeSession,
    resolveSeek: () => resolveSeek(),
    rejectSeek: e => rejectSeek(e)
  };
};

/* ----------------------------------------------------------------------- run */

const settle = async () => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
};

const run = async () => {
  const {world, ctx, makeSession, resolveSeek, rejectSeek} = makeWorld();
  const el = new ctx.AudioViewClass();
  el.connectedCallback();

  const session = makeSession(60); // a 60 seconds track
  ctx.decoder.open = o => {
    session.onchunk = o.onchunk;
    session.onstop = o.onstop;
    return Promise.resolve(session);
  };

  /* a loaded stream whose window never decodes: the playhead is parked */
  await el.playStream({file: {}});
  await settle();
  el.pause();

  // a paused seek reports the new playhead right away
  {
    const from = world.events.length;
    el.currentTime = 30;
    await settle();
    if (world.events.slice(from).join(',') !== 'timeupdate') {
      throw Error('the paused seek produced ' + JSON.stringify(world.events.slice(from)));
    }
    if (el.currentTime !== 30) {
      throw Error('the paused seek moved the playhead to ' + el.currentTime);
    }
  }
  console.log('paused seek ok: the playhead of 30s is reported');

  // the re-cue completes without an event of its own
  resolveSeek();
  await settle();

  /* a seek that the input cannot serve falls back to the previous
     position; the fallback is reported too, so a reporter that already
     showed the failed target learns the correction */
  {
    const from = world.events.length;
    el.currentTime = 50;
    await settle();
    if (world.events.slice(from).join(',') !== 'timeupdate') {
      throw Error('the second seek produced ' + JSON.stringify(world.events.slice(from)));
    }
    rejectSeek(Error('SEEK_FAILED'));
    await settle();
    if (world.events.slice(from).join(',') !== 'timeupdate,timeupdate') {
      throw Error('the fallback produced ' + JSON.stringify(world.events.slice(from)));
    }
    if (el.currentTime !== 30) {
      throw Error('the fallback left the playhead at ' + el.currentTime);
    }
  }
  console.log('fallback ok: the restored playhead of 30s is reported');

  /* the seek to the end enters the finished state without the decoder and
     reports the final playhead after the pause and the ended signal */
  {
    const from = world.events.length;
    const seeks = world.seekCalls.length;
    el.currentTime = 90; // clamps to the end of the track
    await settle();
    if (world.events.slice(from).join(',') !== 'pause,ended,timeupdate') {
      throw Error('the end seek produced ' + JSON.stringify(world.events.slice(from)));
    }
    if (world.seekCalls.length !== seeks) {
      throw Error('the seek to the end asked the decoder: ' + JSON.stringify(world.seekCalls));
    }
    if (Math.abs(el.currentTime - 60) > 0.01) {
      throw Error('the seek to the end left the position at ' + el.currentTime);
    }
  }
  console.log('end seek ok: finished at 60s and reported');

  /* the whole-file path reports its paused seeks the same way */
  {
    const el2 = new ctx.AudioViewClass();
    el2.connectedCallback();
    await el2.playDecoded({
      context: world.context,
      audioBuffer: {duration: 10},
      meta: {}
    });
    el2.pause();

    const from = world.events.length;
    el2.currentTime = 4;
    if (world.events.slice(from).join(',') !== 'timeupdate') {
      throw Error('the buffer seek produced ' + JSON.stringify(world.events.slice(from)));
    }
    if (el2.currentTime !== 4) {
      throw Error('the buffer seek moved the playhead to ' + el2.currentTime);
    }
  }
  console.log('buffer seek ok: the playhead of 4s is reported');

  console.log('AUDIO-VIEW TIMEUPDATE TEST PASSED');
};

run().catch(e => {
  console.error('AUDIO-VIEW TIMEUPDATE TEST FAILED:', e.message);
  process.exit(1);
});
