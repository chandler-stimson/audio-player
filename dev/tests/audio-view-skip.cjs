/* Node test: the skip seeking of the real audio-view.js inside a minimal
   DOM stub. A fake decoder session that reports a length but never decodes
   a chunk keeps every position out of the decoded window, so every skip
   re-cues the decoder and the recorded seek targets are the resolved skip
   sizes. The scenarios:

     - a plain number period: one period per arrow key
     - the bounds: no skip before the start and none past the end
     - the meta key: three periods
     - a fraction period ("1/60"): the period scales with the length
     - an unknown length: a fraction falls back to the plain default

   Run: node dev/tests/audio-view-skip.cjs */

const {loadAudioView, makeAudioViewWorld} = require('./harness.cjs');

/* --------------------------------------------------------------- fake world */

/* the scenario world of this test: the shared fake world plus a decoder
   session that reports a length but never decodes a chunk */
const makeWorld = () => {
  const world = makeAudioViewWorld();
  world.seekCalls = [];

  /* a fake streaming session: the pull never resolves, so the decoded
     window stays empty and every position is served by a re-cue that the
     session records */
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
      return Promise.resolve({epoch: 0, to});
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

  return {world, ctx, makeSession};
};

/* ----------------------------------------------------------------------- run */

/* dispatch a key event on the host; the fake element runs the listeners
   that the component registered on itself */
const key = (el, code, meta = false) => el.dispatchEvent({
  type: 'keydown',
  code,
  metaKey: meta,
  ctrlKey: meta,
  shiftKey: false
});

const settle = () => new Promise(resolve => setImmediate(resolve));

const run = async () => {
  const {world, ctx, makeSession} = makeWorld();
  const el = new ctx.AudioViewClass();
  el.connectedCallback();

  const session = makeSession(60); // a 60 seconds track
  ctx.decoder.open = o => {
    session.onchunk = o.onchunk;
    session.onstop = o.onstop;
    return Promise.resolve(session);
  };

  await el.playStream({file: {}});
  await settle();

  /* a plain number period skips one period per key; the empty window makes
     every target a decoder re-cue that the session records */
  el.skipPeriod = 10;
  key(el, 'ArrowRight');
  await settle();
  if (el.currentTime !== 10 || world.seekCalls[0] !== 10) {
    throw Error('the forward skip landed at ' + el.currentTime + ' (seek ' + world.seekCalls[0] + ')');
  }
  // the backward bound: a period that reaches before the start is ignored
  key(el, 'ArrowLeft');
  await settle();
  if (el.currentTime !== 10 || world.seekCalls.length !== 1) {
    throw Error('the skip at the start moved the playhead to ' + el.currentTime);
  }
  key(el, 'ArrowRight');
  await settle();
  key(el, 'ArrowLeft');
  await settle();
  if (el.currentTime !== 10 || world.seekCalls.join() !== '10,20,10') {
    throw Error('the plain period seeks ' + world.seekCalls.join() + ', expected 10,20,10');
  }
  console.log('plain period ok: 10 seconds per skip');

  /* the meta key skips three periods; the bound still applies */
  key(el, 'ArrowRight', true);
  await settle();
  if (el.currentTime !== 40 || world.seekCalls[3] !== 40) {
    throw Error('the meta skip landed at ' + el.currentTime + ' (seek ' + world.seekCalls[3] + ')');
  }
  console.log('meta key ok: three periods to', el.currentTime);

  /* a fraction period scales with the length of the track: 1/60 of a 60
     seconds track is a one second skip */
  el.skipPeriod = '1/60';
  if (el.skipSeconds !== 1) {
    throw Error('the fraction resolves to ' + el.skipSeconds + ' seconds');
  }
  key(el, 'ArrowRight');
  await settle();
  key(el, 'ArrowLeft', true);
  await settle();
  if (el.currentTime !== 38 || world.seekCalls.slice(4).join() !== '41,38') {
    throw Error('the fraction seeks ' + world.seekCalls.slice(4).join() + ', expected 41,38');
  }
  // the forward bound one fraction before the end
  el.currentTime = 59;
  await settle();
  world.seekCalls.length = 0;
  key(el, 'ArrowRight');
  await settle();
  if (el.currentTime !== 59 || world.seekCalls.length) {
    throw Error('the skip at the end moved the playhead to ' + el.currentTime);
  }
  key(el, 'ArrowLeft');
  await settle();
  if (el.currentTime !== 58 || world.seekCalls[0] !== 58) {
    throw Error('the backward fraction seeked to ' + el.currentTime);
  }
  console.log('fraction ok: 1 second of a 60 seconds track');

  /* an unknown length cannot scale a fraction; the plain default steps in
     so that the skip never goes dead */
  {
    const el2 = new ctx.AudioViewClass();
    el2.connectedCallback();

    const session2 = makeSession(); // a stream that cannot tell its length
    ctx.decoder.open = o => {
      session2.onchunk = o.onchunk;
      session2.onstop = o.onstop;
      return Promise.resolve(session2);
    };

    await el2.playStream({file: {}});
    await settle();

    el2.skipPeriod = '1/60';
    if (el2.skipSeconds !== 10) {
      throw Error('the unknown length resolves the fraction to ' + el2.skipSeconds + ' seconds');
    }
    world.seekCalls.length = 0;
    key(el2, 'ArrowRight');
    await settle();
    if (el2.currentTime !== 10 || world.seekCalls[0] !== 10) {
      throw Error('the fallback skip landed at ' + el2.currentTime + ' (seek ' + world.seekCalls[0] + ')');
    }
    console.log('unknown length ok: the fraction falls back to 10 seconds');
  }

  console.log('AUDIO-VIEW SKIP TEST PASSED');
};

run().catch(e => {
  console.error('AUDIO-VIEW SKIP TEST FAILED:', e.message);
  process.exit(1);
});
