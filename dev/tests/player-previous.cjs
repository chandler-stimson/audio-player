/* Node test: the Previous control of the real player page in the fake page
   world. The first track must keep Previous available for Shift+Click restart
   and for the regular backward action, while an empty or locked selection must
   stay disabled.

   Run: node dev/tests/player-previous.cjs */

const {makePlayerWorld, settleAll} = require('./player-world.cjs');

const previous = world => world.document.getElementById('previous');

const select = async (world, i) => {
  world.view.onchange({target: {selectedIndex: i + 1}});
  await settleAll();
};

/* the first and only track can be restarted without changing the selection */
const firstTrack = async () => {
  const world = makePlayerWorld();
  world.finishRestore([], -1);
  await settleAll();

  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  await world.add([A]);
  await settleAll();

  if (previous(world).disabled !== false) {
    throw Error('Previous is disabled for the first track');
  }

  world.audio.ready = true;
  world.audio.currentTime = 12.5;
  previous(world).dispatch('click', {shiftKey: true});
  if (world.audio.currentTime !== 0) {
    throw Error('Shift+Click did not restart the first track');
  }
  if (world.audio.started.length !== 1) {
    throw Error('Shift+Click reloaded the track instead of seeking to zero');
  }

  world.audio.currentTime = 8;
  previous(world).dispatch('click');
  await settleAll();
  if (world.audio.i !== 0 || world.audio.started.length !== 2 ||
      world.audio.started[1] !== A) {
    throw Error('regular Previous did not restart the first track');
  }
  console.log('first track ok: Previous restarts without leaving index zero');
};

/* a restored selection is readable before playback starts */
const restoredTrack = async () => {
  const world = makePlayerWorld();
  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  const B = {name: 'b.mp3', href: 'https://x/b.mp3'};
  world.finishRestore([A, B], 0);
  await settleAll();

  if (previous(world).disabled !== false) {
    throw Error('Previous stayed disabled for the restored first track');
  }
  console.log('restored track ok: the selected first track enables Previous');
};

/* deleting the current last track leaves the fallback first track available */
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
      world.audio.i !== 0 || previous(world).disabled !== false) {
    throw Error('the stopped fallback did not keep Previous available');
  }
  console.log('stopped fallback ok: the remaining first track enables Previous');
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
      world.audio.i !== 0 || previous(world).disabled !== false) {
    throw Error('the shifted first track did not enable Previous');
  }
  console.log('shifted track ok: deletion keeps Previous available at index zero');
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
      previous(world).disabled !== false) {
    throw Error('granting read access did not enable Previous');
  }
  console.log('locked track ok: Previous follows read access');
};

/* no selected track means there is nothing for Previous to restart */
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

  if (world.audio.files !== null || previous(world).disabled !== true) {
    throw Error('Previous did not disable after the playlist was emptied');
  }
  console.log('empty playlist ok: Previous has no restart target');
};

const run = async () => {
  await firstTrack();
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
