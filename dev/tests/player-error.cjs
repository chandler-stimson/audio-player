/* Node test: the error path of the real v2/data/player/index.js in the
   fake page world (player-world.cjs).

   The regression this file guards: a track that cannot be decoded used to
   run the advancement logic of a finished track, so an unreadable file was
   retried (and re-alerted) forever - in repeat-one mode, in repeat-all
   mode with a single track, and under shuffle. A failed track now stops
   the playback and reports its reason in the inline error bar instead:

     - no retry: the error schedules no new play attempt, in every repeat
       and shuffle mode
     - the report: the title names the track that cannot be played and the
       inline bar shows the decoder reason
     - dismissal: the close button hides the bar and restores the idle
       title
     - recovery: selecting another track retires the bar and plays the new
       track
     - a natural end still advances: the fix must not touch the
       advancement of a track that finished

   Run: node dev/tests/player-error.cjs
   (with PLAYER_INDEX on the unfixed page this fails: the retry that the
   old code schedules fires 500 ms after the error) */

const {makePlayerWorld, settleAll} = require('./player-world.cjs');

/* the advancement that the old code scheduled fires 500 ms after the
   error; the quiet spell must outlast it */
const quiet = () => new Promise(resolve => setTimeout(resolve, 650));

/* the page logs the error it reports; keep the test output clean */
const fail = (world, detail) => {
  const was = console.error;
  console.error = () => {};
  try {
    world.audio.dispatch('error', {detail});
  }
  finally {
    console.error = was;
  }
};

const setRepeat = (world, mode) =>
  world.document.getElementById('repeat').setAttribute('mode', mode);

/* select the row of the i-th track; its change handler starts it */
const select = async (world, i) => {
  world.view.onchange({target: {selectedIndex: i + 1}});
  await settleAll();
};

/* ------------------------------------------------------------ the scenarios */

/* repeat-one: the failed track stops the playback; the report is dismissed
   and another track starts */
const repeatOne = async () => {
  const world = makePlayerWorld();
  const bad = world.makeFile('bad.mp3', world.makeHandle(1));
  const good = world.makeFile('good.mp3', world.makeHandle(2));
  world.finishRestore([bad, good], -1);
  await settleAll();

  setRepeat(world, 'repeat-one');
  await select(world, 0); // the bad track starts
  if (world.audio.started.length !== 1) {
    throw Error('the selection did not start the bad track');
  }

  fail(world, 'DECODE_FAILED');
  await quiet();

  if (world.audio.started.length !== 1) {
    throw Error('the failed track was retried ' + (world.audio.started.length - 1) + ' time(s)');
  }
  if (world.audio.pauseCount !== 1) {
    throw Error('the player was not paused on the error');
  }
  if (world.document.title !== 'Cannot play: bad.mp3') {
    throw Error('the title is "' + world.document.title + '" instead of the error');
  }
  const bar = world.document.getElementById('error');
  if (bar.hidden !== false) {
    throw Error('the inline report stays hidden');
  }
  if (world.document.getElementById('error-text').textContent !== 'DECODE_FAILED') {
    throw Error('the inline report does not show the decoder reason');
  }
  world.checkMirrored();
  console.log('repeat-one ok: the failed track stops the playback');

  // dismissal: the bar closes and the idle title comes back
  world.document.getElementById('error-close').dispatch('click');
  if (bar.hidden !== true) {
    throw Error('the dismiss button does not close the report');
  }
  if (world.document.title !== '[1/2] bad.mp3 :: Audio Player') {
    throw Error('the title is "' + world.document.title + '" instead of the idle one');
  }
  console.log('dismiss ok: the report closes and the idle title returns');

  // recovery: another track retires the report and plays
  await select(world, 1);
  if (world.audio.started.length !== 2 || world.audio.started[1] !== good) {
    throw Error('the selection of the good track did not start it');
  }
  if (bar.hidden !== true) {
    throw Error('starting another track leaves the report open');
  }
  console.log('recover ok: another track starts and retires the report');
};

/* repeat-all with a single track: the failed track is not restarted */
const repeatAllSingle = async () => {
  const world = makePlayerWorld();
  const bad = world.makeFile('bad.mp3', world.makeHandle(1));
  world.finishRestore([bad], 0);
  await settleAll();

  setRepeat(world, 'repeat');
  // the play button of the empty player starts the selected track
  world.audio.dispatch('empty');
  await settleAll();
  if (world.audio.started.length !== 1) {
    throw Error('the empty player did not start the bad track');
  }

  fail(world, 'DECODE_FAILED');
  await quiet();

  if (world.audio.started.length !== 1) {
    throw Error('the single failed track was restarted');
  }
  console.log('repeat-all ok: a single failed track stops the playback');
};

/* shuffle in repeat-all mode with a single track: the failed track is not
   picked again */
const shuffleSingle = async () => {
  const world = makePlayerWorld();
  const bad = world.makeFile('bad.mp3', world.makeHandle(1));
  world.finishRestore([bad], 0);
  await settleAll();

  setRepeat(world, 'repeat');
  world.document.getElementById('shuffle').setAttribute('active', 'true');
  world.audio.dispatch('empty');
  await settleAll();

  fail(world, 'DECODE_FAILED');
  await quiet();

  if (world.audio.started.length !== 1) {
    throw Error('shuffle picked the failed track again');
  }
  console.log('shuffle ok: the failed track is not picked again');
};

/* the natural end of a track still advances; the fix must not touch it */
const naturalEnd = async () => {
  const world = makePlayerWorld();
  const one = world.makeFile('one.mp3', world.makeHandle(1));
  const two = world.makeFile('two.mp3', world.makeHandle(2));
  world.finishRestore([one, two], -1);
  await settleAll();

  setRepeat(world, 'repeat-one');
  await select(world, 0);
  world.audio.dispatch('ended');
  await quiet();

  if (world.audio.started.length !== 2) {
    throw Error('the finished track was not replayed');
  }
  console.log('ended ok: a finished track still advances');
};

/* ------------------------------------------------------------------- run */

const run = async () => {
  await repeatOne();
  await repeatAllSingle();
  await shuffleSingle();
  await naturalEnd();

  console.log('PLAYER-ERROR TEST PASSED');
};

run().catch(e => {
  console.error('PLAYER-ERROR TEST FAILED:', e.message);
  process.exit(1);
});
