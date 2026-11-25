/* Node test: the Duration column of the real v2/data/player/index.js in the
   fake page world (player-world.cjs).

   The behaviors this file guards:

     - blank: every row is created with a blank duration; nothing is decoded
       when a track arrives, so nothing else can be shown yet
     - played: the decode of the playing track reports its length with
       loadedmetadata and the row of the current track follows it; the row
       keeps its length when another track becomes current
     - stream: a stream that cannot tell its length up front stays blank
       until the whole input was decoded (durationchange), then the row
       follows
     - prefetch: the background decode of the next track fills the row of
       that track while it is not playing
     - removed: a length that lands after a row was deleted is not written
       over the row that slid into its place
     - metadata: the stream header that the metadata dialog reads fills the
       row of the right-clicked track
     - unlock: the row of a locked track keeps working after its entry was
       replaced by the readable copy

   The world formats the lengths with an identity htime, so the cells show
   the plain seconds (as strings) that the page passes to the formatter.

   Run: node dev/tests/player-duration.cjs */

const {makePlayerWorld, settle, settleAll} = require('./player-world.cjs');

/* the duration cell of the row of a track; the rows mirror audio.files */
const cell = (world, i) => world.view.rows[i]._internal.div.lastElementChild.textContent;

/* ------------------------------------------------------------ the scenarios */

/* the rows of the added and of the restored tracks start blank */
const blank = async () => {
  const world = makePlayerWorld();
  const R = {name: 'r.mp3', href: 'https://x/r.mp3'};
  world.finishRestore([R], 0);
  await settleAll();

  if (cell(world, 0) !== '-') {
    throw Error('the restored row does not start with a blank duration');
  }

  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  await world.add([A]);
  await settleAll();

  if (cell(world, 1) !== '-') {
    throw Error('the added row does not start with a blank duration');
  }
  world.checkMirrored();
  console.log('blank ok: the rows start with a blank duration');
};

/* the decode of the playing track fills its row; the row keeps the length
   when another track becomes current */
const played = async () => {
  const world = makePlayerWorld();
  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  const B = {name: 'b.mp3', href: 'https://x/b.mp3'};
  world.finishRestore([], -1);
  await settleAll();

  await world.add([A, B]);
  await settleAll();
  if (world.audio.started[0] !== A) {
    throw Error('the first added track did not play');
  }

  // the decode of the playing track reports its length
  world.audio.audioBuffer = {duration: 185};
  world.audio.dispatch('loadedmetadata');
  if (cell(world, 0) !== '185') {
    throw Error('the row of the playing track shows ' + cell(world, 0) +
      ' instead of its length');
  }

  // the next track becomes current; the row of the first one keeps its length
  world.view.onchange({target: {selectedIndex: 2}});
  await settleAll();
  if (world.audio.started[1] !== B) {
    throw Error('the second track did not play after the selection');
  }
  world.audio.audioBuffer = {duration: 95};
  world.audio.dispatch('loadedmetadata');

  if (cell(world, 0) !== '185' || cell(world, 1) !== '95') {
    throw Error('the rows show [' + cell(world, 0) + ', ' + cell(world, 1) +
      '] instead of [185, 95]');
  }
  world.checkMirrored();
  console.log('played ok: the decode of a track fills its row');
};

/* a stream that cannot tell its length up front stays blank until the
   whole input was decoded, then durationchange fills the row */
const stream = async () => {
  const world = makePlayerWorld();
  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  world.finishRestore([], -1);
  await settleAll();

  await world.add([A]);
  await settleAll();

  // the stream reports no length with its header
  world.audio.stream = {duration: null};
  world.audio.dispatch('loadedmetadata');
  if (cell(world, 0) !== '-') {
    throw Error('the row was filled before the stream told its length');
  }

  // the whole input was decoded; the element reports the exact length now
  world.audio.stream.duration = 240;
  world.audio.dispatch('durationchange');
  if (cell(world, 0) !== '240') {
    throw Error('the row of the stream shows ' + cell(world, 0) +
      ' instead of its length');
  }
  world.checkMirrored();
  console.log('stream ok: the late length of a stream fills its row');
};

/* the background decode of the next track fills the row of that track */
const prefetch = async () => {
  const world = makePlayerWorld();
  const A = world.makeFile('a.mp3', world.makeHandle(1));
  const B = world.makeFile('b.mp3', world.makeHandle(2));
  world.finishRestore([], -1);
  await settleAll();

  await world.add([A, B]);
  await settleAll(); // A plays

  // the decode of the prefetch parks until the test releases it
  let decoded;
  world.decoder.decode = () => new Promise(resolve => {
    decoded = resolve;
  });
  world.audio.dispatch('play'); // the start of the playback prefetches B
  await settle();

  if (cell(world, 1) !== '-') {
    throw Error('the row was filled before the prefetch ended');
  }

  decoded({audioBuffer: {duration: 90, length: 1, numberOfChannels: 2}, meta: {}});
  await settleAll();

  if (cell(world, 0) !== '-') {
    throw Error('the playing track adopted the length of another track');
  }
  if (cell(world, 1) !== '90') {
    throw Error('the row of the prefetched track shows ' + cell(world, 1) +
      ' instead of its length');
  }
  world.checkMirrored();
  console.log('prefetch ok: the background decode fills the next row');
};

/* a length that lands after a row was deleted follows the track by its
   identity, not by the place its row used to hold */
const removed = async () => {
  const world = makePlayerWorld();
  const A = world.makeFile('a.mp3', world.makeHandle(1));
  const B = world.makeFile('b.mp3', world.makeHandle(2));
  world.finishRestore([], -1);
  await settleAll();

  await world.add([A, B]);
  await settleAll(); // A plays

  // the prefetch of B parks on the scripted decode
  let decoded;
  world.decoder.decode = () => new Promise(resolve => {
    decoded = resolve;
  });
  world.audio.dispatch('play');
  await settle();

  // the row of A is deleted while the decode is in flight; the row of B
  // slides into its place
  world.openMenuAt(10);
  world.clickMenu('delete-this');
  await settleAll();

  // the length lands now; it must fill the row of B
  decoded({audioBuffer: {duration: 90, length: 1, numberOfChannels: 2}, meta: {}});
  await settleAll();

  const files = world.audio.files;
  if (files.length !== 1 || files[0] !== B) {
    throw Error('the deletion while the decode ran changed the playlist');
  }
  if (cell(world, 0) !== '90') {
    throw Error('the sliding row shows ' + cell(world, 0) +
      ' instead of the length of its track');
  }
  world.checkMirrored();
  console.log('removed ok: the length follows its track, not its old place');
};

/* the stream header that the metadata dialog reads fills the row of the
   right-clicked track */
const metadata = async () => {
  const world = makePlayerWorld();
  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  const B = {name: 'b.mp3', href: 'https://x/b.mp3'};
  world.finishRestore([A, B], 1);
  await settleAll();

  // the metadata dialog of a link track reads the header of its stream only
  world.decoder.open = () => Promise.resolve({
    meta: {'Duration': 120},
    close: () => Promise.resolve()
  });

  world.openMenuAt(10); // the row of A
  world.clickMenu('show-metadata');
  await settleAll();

  if (world.document.getElementById('metadata').open !== true) {
    throw Error('the metadata dialog did not open');
  }
  if (cell(world, 0) !== '120') {
    throw Error('the row of the asked track shows ' + cell(world, 0) +
      ' instead of the length of its stream header');
  }
  if (cell(world, 1) !== '-') {
    throw Error('the row of another track adopted the length');
  }
  world.checkMirrored();
  console.log('metadata ok: the stream header fills the asked row');
};

/* the row of a locked track survives its replacement by the readable copy:
   the link cell reverts, the duration stays blank until a decode reports,
   and the decode of the unlocked copy fills the same row */
const unlock = async () => {
  const world = makePlayerWorld();
  const handle = world.makeHandle(1, {
    real: {name: 'locked.mp3', size: 100, lastModified: 1, type: 'audio/x-test'}
  });
  const L = world.makeFile('locked.mp3', handle, {locked: true});
  world.finishRestore([L], 0);
  await settleAll();

  // the locked row supplies the user action that grants the permission
  world.view.rows[0]._internal.div.dispatch('click');
  await settleAll();

  const real = world.audio.files[0];
  if (real === L || real.locked) {
    throw Error('the locked entry was not replaced by its readable file');
  }
  const div = world.view.rows[0]._internal.div;
  if (div.lastElementChild.previousElementSibling.textContent !== 'Local File') {
    throw Error('the unlocked row still asks for read permission');
  }
  if (div.lastElementChild.textContent !== '-') {
    throw Error('the unlocked row invented a length');
  }

  // the decode of the unlocked copy reports its length
  world.audio.audioBuffer = {duration: 185};
  world.audio.dispatch('loadedmetadata');
  if (div.lastElementChild.textContent !== '185') {
    throw Error('the row of the unlocked copy shows ' +
      div.lastElementChild.textContent + ' instead of its length');
  }
  world.checkMirrored();
  console.log('unlock ok: the replaced entry keeps filling its row');
};

/* ------------------------------------------------------------------- run */

const run = async () => {
  await blank();
  await played();
  await stream();
  await prefetch();
  await removed();
  await metadata();
  await unlock();

  console.log('PLAYER-DURATION TEST PASSED');
};

run().catch(e => {
  console.error('PLAYER-DURATION TEST FAILED:', e.message);
  process.exit(1);
});
