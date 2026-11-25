/* Node test: the time formatting of the real audio-view.js. The audio
   clock is fractional and the labels round to the nearest second, and a
   rounded second must carry into the greater units instead of rendering
   a ":60" tail (the 200ms play loop lands in the last half second of
   every minute); the smaller units of the multi-unit forms are padded.

   What is verified:

     - the boundaries: a tie rounds up, the carry crosses the minute,
       hour and day forms, and the values below the tie stay put
     - the padded minutes and hours of the multi-unit forms
     - the duration label of a whole-file playback and the current
       label of the play loop through the fake clock

   Run: node dev/tests/audio-view-time.cjs */

const vm = require('node:vm');
const {loadAudioView, makeAudioViewWorld} = require('./harness.cjs');

/* ----------------------------------------------------------------------- run */

const run = async () => {
  const world = makeAudioViewWorld();
  const ctx = loadAudioView({decoder: {}, world});

  /* the real formatter out of the vm context of the component; the
     classic scripts of the page share this very scope, index.js reads
     htime from it too */
  const htime = vm.runInContext('htime', ctx);

  const cases = [
    [0, '0:00'],
    [9.4, '0:09'],
    [59.4, '0:59'],             // below the tie: no carry
    [59.5, '1:00'],             // the tie rounds up and carries
    [119.9, '2:00'],            // the covered duration of a nominal 2:00
    [119.999, '2:00'],
    [3599.4, '59:59'],
    [3599.5, '1:00:00'],        // the carry crosses into the hours form
    [3660.2, '1:01:00'],        // the minutes of the hours form are padded
    [7259.7, '2:01:00'],
    [86399.7, '1:00:00:00'],    // the carry crosses into the days form
    [172799.5, '2:00:00:00']    // the full cascade
  ];
  for (const [delta, want] of cases) {
    const got = htime(delta);
    if (got !== want) {
      throw Error('htime(' + delta + ') is "' + got + '", expected "' + want + '"');
    }
  }
  console.log('boundaries ok:', cases.length, 'cases');

  /* the labels of the real component: a whole-file playback writes the
     duration label once, and the play loop writes the current label
     from the fractional audio clock */
  const el = new ctx.AudioViewClass();
  el.connectedCallback();
  await el.playDecoded({
    context: world.context,
    audioBuffer: {duration: 59.7},
    meta: {}
  });

  const label = id => el.shadowRoot.getElementById(id).textContent;
  if (label('duration') !== '1:00') {
    throw Error('the duration label is "' + label('duration') + '", expected "1:00"');
  }

  // one tick of the fake clock lands the 200ms loop at 59.7s, inside the
  // last half second of the first minute
  world.tick(59700);
  if (label('current') !== '1:00') {
    throw Error('the current label is "' + label('current') + '", expected "1:00"');
  }

  console.log('labels ok: a 59.7s track shows 1:00 while it plays');
  console.log('AUDIO-VIEW TIME TEST PASSED');
};

run().catch(e => {
  console.error('AUDIO-VIEW TIME TEST FAILED:', e.message);
  process.exit(1);
});
