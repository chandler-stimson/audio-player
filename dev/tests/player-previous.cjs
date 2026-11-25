/* Node test: the Previous and Next controls of the real player page in the
   fake page world. The buttons follow the bounds of the playlist: the first
   track has no previous one and the last track has no next one, while an
   empty or locked selection must stay disabled on both.

   Run: node dev/tests/player-previous.cjs */

const {makePlayerWorld, settleAll} = require('./player-world.cjs');

const previous = world => world.document.getElementById('previous');
const next = world => world.document.getElementById('next');

const select = async (world, i) => {
  world.view.onchange({target: {selectedIndex: i + 1}});
  await settleAll();
};

/* the first track has no previous one; Next is the only enabled direction */
const firstTrack = async () => {
  const world = makePlayerWorld();
  world.finishRestore([], -1);
  await settleAll();

  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  await world.add([A]);
  await settleAll();

  if (previous(world).disabled !== true) {
    throw Error('Previous is enabled for the first track');
  }
  if (next(world).disabled !== true) {
    throw Error('Next is enabled for the only track');
  }
  console.log('first track ok: Previous and Next are disabled at both bounds');
};

/* a middle track enables Previous and keeps Next available */
const middleTrack = async () => {
  const world = makePlayerWorld();
  world.finishRestore([], -1);
  await settleAll();

  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  const B = {name: 'b.mp3', href: 'https://x/b.mp3'};
  const C = {name: 'c.mp3', href: 'https://x/c.mp3'};
  await world.add([A, B, C]); // the first added track plays
  await settleAll();
  await select(world, 1); // B

  if (previous(world).disabled !== false || next(world).disabled !== false) {
    throw Error('the middle track did not enable both navigation buttons');
  }

  // Previous moves to the first track
  previous(world).dispatch('click');
  await settleAll();
  if (world.audio.i !== 0 || world.audio.started[world.audio.started.length - 1] !== A) {
    throw Error('Previous did not move to the first track');
  }
  if (previous(world).disabled !== true) {
    throw Error('Previous did not disable again on the first track');
  }

  // Next moves forward again
  next(world).dispatch('click');
  await settleAll();
  if (world.audio.i !== 1 || world.audio.started[world.audio.started.length - 1] !== B) {
    throw Error('Next did not move forward from the first track');
  }
  console.log('middle track ok: Previous and Next follow the playlist bounds');
};

/* the last track has no next one */
const lastTrack = async () => {
  const world = makePlayerWorld();
  world.finishRestore([], -1);
  await settleAll();

  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  const B = {name: 'b.mp3', href: 'https://x/b.mp3'};
  await world.add([A, B]);
  await settleAll();
  await select(world, 1); // B, the last one

  if (next(world).disabled !== true) {
    throw Error('Next is enabled for the last track');
  }
  if (previous(world).disabled !== false) {
    throw Error('Previous is disabled for the last track');
  }
  console.log('last track ok: Next is disabled and Previous stays available');
};

/* a restored selection follows the same bounds */
const restoredTrack = async () => {
  const world = makePlayerWorld();
  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  const B = {name: 'b.mp3', href: 'https://x/b.mp3'};
  world.finishRestore([A, B], 0);
  await settleAll();

  if (previous(world).disabled !== true) {
    throw Error('Previous stayed enabled for the restored first track');
  }
  if (next(world).disabled !== false) {
    throw Error('Next stayed disabled for the restored first track');
  }
  console.log('restored track ok: the restored selection follows the bounds');
};

/* deleting the current last track leaves the fallback first track disabled
   on Previous and on Next (it is the only one left) */
const stoppedFallback = async () => {
  const world = makePlayerWorld();
  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  const B = {name: 'b.mp3', href: 'https://x/b.mp3'};
  world.finishRestore([A, B], 1);
  await settleAll();
  await select(world, 1);

  world.openMenuAt(30); // the row of B
  world.clickMenu('delete-this');
  await settleAll();

  if (world.audio.files.length !== 1 || world.audio.files[0] !== A ||
      world.audio.i !== 0 || previous(world).disabled !== true ||
      next(world).disabled !== true) {
    throw Error('the stopped fallback did not follow the bounds');
  }
  console.log('stopped fallback ok: the remaining first track keeps both bounds');
};

/* deleting a row before the current track can shift it to index zero */
const removeBeforeCurrent = async () => {
  const world = makePlayerWorld();
  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  const B = {name: 'b.mp3', href: 'https://x/b.mp3'};
  world.finishRestore([A, B], 1);
  await settleAll();
  await select(world, 1);

  world.openMenuAt(10); // the row of A
  world.clickMenu('delete-this');
  await settleAll();

  if (world.audio.files.length !== 1 || world.audio.files[0] !== B ||
      world.audio.i !== 0 || previous(world).disabled !== true) {
    throw Error('the shifted first track did not disable Previous');
  }
  console.log('shifted track ok: deletion keeps Previous disabled at index zero');
};

/* a locked track becomes usable after its read permission is granted */
const lockedTrack = async () => {
  const world = makePlayerWorld();
  const handle = world.makeHandle(7, {
    real: {name: 'locked.mp3', size: 100, lastModified: 1, type: 'audio/x-test'}
  });
  const locked = world.makeFile('locked.mp3', handle, {locked: true});
  world.finishRestore([locked], 0);
  await settleAll();

  if (previous(world).disabled !== true) {
    throw Error('Previous is enabled for a locked track');
  }

  world.view.rows[0]._internal.div.dispatch('click');
  await settleAll();

  if (world.audio.files[0] === locked || world.audio.files[0].locked ||
      previous(world).disabled !== true) {
    throw Error('granting read access broke the bound of the first track');
  }
  console.log('locked track ok: the granted first track keeps Previous disabled');
};

/* no selected track means there is nothing for Previous to move to */
const emptyPlaylist = async () => {
  const world = makePlayerWorld();
  world.finishRestore([], -1);
  await settleAll();

  if (previous(world).disabled !== true) {
    throw Error('Previous is enabled for an empty playlist');
  }

  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  await world.add([A]);
  await settleAll();
  world.clickMenu('delete-all');
  const confirmation = world.document.getElementById('confirm');
  confirmation.returnValue = 'delete-all';
  confirmation.dispatch('close');
  await settleAll();

  if (world.audio.files !== null || previous(world).disabled !== true ||
      next(world).disabled !== true) {
    throw Error('the buttons did not disable after the playlist was emptied');
  }
  console.log('empty playlist ok: both buttons have no target');
};

const run = async () => {
  await firstTrack();
  await middleTrack();
  await lastTrack();
  await restoredTrack();
  await stoppedFallback();
  await removeBeforeCurrent();
  await lockedTrack();
  await emptyPlaylist();

  console.log('PLAYER-PREVIOUS TEST PASSED');
};

run().catch(e => {
  console.error('PLAYER-PREVIOUS TEST FAILED:', e.message);
  process.exit(1);
});
