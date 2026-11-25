/* Node test: the duration reports of the real audio-view.js inside the fake
   audio world of the harness.

   The behavior this file guards: the length of a track that a stream can
   only tell after the whole input was decoded (an ogg without a header
   index) is reported with a durationchange event when it becomes known, so
   the playlist column of the page can fill the row that stayed blank. The
   whole-file path knows its length at loadedmetadata and must not report
   durationchange on its own.

   Run: node dev/tests/audio-view-duration.cjs */

const {loadAudioView, makeAudioViewWorld} = require('./harness.cjs');

const settle = async () => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
};

const run = async () => {
  const world = makeAudioViewWorld();
  const decoder = {context: () => world.context};
  const ctx = loadAudioView({decoder, world});

  /* a stream whose header cannot tell the length; the pull completes and
     reports the covered length as the exact length of the track */
  {
    const el = new ctx.AudioViewClass();
    el.connectedCallback();

    ctx.decoder.open = o => Promise.resolve({
      meta: {'Sample Rate': 1000, 'Channels': 1},
      onchunk: o.onchunk,
      onstop: o.onstop,
      pullUntil() {
        return Promise.resolve({covered: 42, done: true});
      },
      seek() {
        return Promise.resolve();
      },
      close() {
        return Promise.resolve();
      }
    });

    await el.playStream({file: {}}); // loadedmetadata without a length
    await settle();

    if (world.events.join(',') !== 'loadedmetadata,durationchange') {
      throw Error('the completed stream reported ' + world.events.join(','));
    }
    if (!el.stream || el.stream.duration !== 42) {
      throw Error('the stream did not adopt the covered length');
    }
    console.log('stream ok: the late length of a stream is reported');
  }

  /* the whole-file path reports its length with loadedmetadata only */
  {
    world.events.length = 0;
    const el = new ctx.AudioViewClass();
    el.connectedCallback();

    await el.playDecoded({
      context: world.context,
      audioBuffer: {duration: 10},
      meta: {}
    });
    await settle();

    if (world.events.indexOf('durationchange') !== -1) {
      throw Error('the whole-file path reported durationchange (' +
        world.events.join(',') + ')');
    }
    console.log('buffer ok: the known length stays with loadedmetadata');
  }

  console.log('AUDIO-VIEW DURATION TEST PASSED');
};

run().catch(e => {
  console.error('AUDIO-VIEW DURATION TEST FAILED:', e.message);
  process.exit(1);
});
