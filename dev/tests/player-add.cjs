/* Node test: the playlist mutations of the real v2/data/player/index.js in
   the fake page world (player-world.cjs).

   The regression this file guards: add() awaits real filesystem identity
   checks (isSameEntry) while it works on the shared playlist, so two
   mutations in flight used to interleave their index arithmetic. Every
   scenario below drives the interleaving that the old code failed:

     - duplicates: two additions of the same track both append their copy
       because their old-entry scans interleave before either appends
     - wrong row: a deletion that lands while an addition is parked on a
       comparison shifts the rows, and the resumed scan removes an
       unrelated track
     - order: two additions apply in arrival order and the last one owns
       the current index
     - jobs: a track that the background passes during the startup restore
       waits for the restored rows (it plays as the newly added one)
     - unlock: a locked track whose permission is granted after its row
       was replaced does not write its readable copy over the new row
     - retry identity: a deletion under the parked unlock shifts the rows,
       and the retry must resume its readable replacement by identity and
       not restart the track that slid into its old place (driven once
       through the automatic retry and once through the Grant Access
       dialog)
     - unlocked row: the readable replacement inherits the row cleanup and
       keeps selection/navigation synchronized when it is deleted
     - menu: the context menu remembers its row by its entry, so a
       deletion after the playlist changed removes the right row (or
       nothing when the row is gone)

   The gates of the world park the identity checks on deferreds, so the
   exact hostile schedules are deterministic. The final states are asserted
   on the object identities of audio.files and on the mirrored view rows.

   Run: node dev/tests/player-add.cjs */

const {makePlayerWorld, settle, settleAll} = require('./player-world.cjs');

const names = files => files.map(f => f.name).join(', ');

/* ------------------------------------------------------------ the scenarios */

/* two additions of the same track; the playlist keeps its old copy of it */
const duplicates = async () => {
  const world = makePlayerWorld();
  const gateX = world.gates.makeGate();
  const gateA = world.gates.makeGate();

  // the playlist: A and an old copy of the shared track X
  const A = world.makeFile('a.mp3', world.makeHandle(1, {gate: gateA}));
  const Xold = world.makeFile('x-old.mp3', world.makeHandle(2, {gate: gateX}));
  world.finishRestore([A, Xold], -1);
  await settleAll();

  // two new copies of X arrive one after another; both scans park on the
  // comparisons with the old copy
  const X1 = world.makeFile('x-1.mp3', world.makeHandle(2));
  const X2 = world.makeFile('x-2.mp3', world.makeHandle(2));

  const first = world.add([X1]);
  await settle();  // the first addition parks on the comparison with Xold
  const second = world.add([X2]);
  await settle();  // under the old code the second scan parks as well

  /* the hostile schedule: let both scans see the old copy, then let both
     walk to the A comparison; the old code appends both copies this way */
  gateX.release();
  await settle();
  gateX.release(); // the second scan resumes on its stale read
  await settle();
  gateA.release(); // the first addition finishes and appends its copy
  await settle();
  gateA.release(); // the second addition walks over A as well
  await settle();
  gateA.release(); // the queue of the fix needs one more pass
  await settleAll();
  await first;
  await second;

  const files = world.audio.files;
  const xs = files.filter(f => f === X1 || f === X2 || f === Xold);
  if (xs.length !== 1 || files[1] !== X2) {
    throw Error('the shared track appears as [' + names(xs) + '], the newest copy must be the only one');
  }
  if (files.length !== 2 || files[0] !== A) {
    throw Error('the playlist is [' + names(files) + '] instead of [a, x-2]');
  }
  world.checkMirrored();
  // the newest copy plays as the newly added one
  if (world.audio.i !== 1 || world.audio.started[world.audio.started.length - 1] !== X2) {
    throw Error('the replaced copy does not play as the newly added one');
  }
  console.log('duplicates ok: the second copy replaces the first one');
};

/* a deletion that lands while an addition is parked on its comparison */
const wrongRow = async () => {
  const world = makePlayerWorld();
  const gateB = world.gates.makeGate();
  const gateC = world.gates.makeGate();
  const gateD = world.gates.makeGate();

  const A = world.makeFile('a.mp3', world.makeHandle(1));
  const B = world.makeFile('b.mp3', world.makeHandle(2, {gate: gateB}));
  const C = world.makeFile('c.mp3', world.makeHandle(3, {gate: gateC}));
  const D = world.makeFile('d.mp3', world.makeHandle(4, {gate: gateD}));
  world.finishRestore([A, B, C, D], -1);
  await settleAll();

  // the menu opens on the first row while nothing is running yet
  world.openMenuAt(10); // rows are 20px high: y 10 is the row of A

  // a new copy of B arrives; its scan walks down and parks on the B
  // comparison, holding the row indices it has walked over
  const Bnew = world.makeFile('b-new.mp3', world.makeHandle(2));
  const addition = world.add([Bnew]);
  await settle();  // the addition parks on the D comparison
  gateD.release();
  await settle();
  gateC.release();
  await settle(); // the addition is parked on the B comparison now

  // the user deletes A while the addition is parked; the rows below shift
  world.clickMenu('delete-this');
  await settle();

  // the parked comparison resolves: the old code removed C here because
  // the deletion had shifted B out of the remembered place
  gateB.release();
  await settle();
  gateB.release(); // the old code needs its second pass over B
  await settleAll();
  await addition;

  const files = world.audio.files;
  if (files.length !== 3 || files[0] !== C || files[1] !== D || files[2] !== Bnew) {
    throw Error('the playlist is [' + names(files) + '] instead of [c, d, b-new]: ' +
      'the deletion of the parked addition removed an unrelated row');
  }
  if (world.audio.i !== 2 || world.audio.started[world.audio.started.length - 1] !== Bnew) {
    throw Error('the new copy does not play as the current one');
  }
  world.checkMirrored();
  console.log('wrong row ok: the deletion shifts nothing under the parked scan');
};

/* two additions of distinct tracks apply in their arrival order */
const order = async () => {
  const world = makePlayerWorld();
  world.finishRestore([], -1);
  await settleAll();

  const P = {name: 'p.mp3', href: 'https://x/p.mp3'};
  const Q = {name: 'q.mp3', href: 'https://x/q.mp3'};
  const R = {name: 'r.mp3', href: 'https://x/r.mp3'};

  // both additions are in flight at the same time
  const first = world.add([P, Q]);
  const second = world.add([R]);
  await Promise.all([first, second]);
  await settleAll();

  const files = world.audio.files;
  if (names(files) !== 'p.mp3, q.mp3, r.mp3') {
    throw Error('the playlist is [' + names(files) + '] instead of [p, q, r]');
  }
  if (world.audio.i !== 2 || world.audio.started[world.audio.started.length - 1] !== R) {
    throw Error('the last addition does not own the current index');
  }
  world.checkMirrored();
  console.log('order ok: the additions apply in their arrival order');
};

/* a track that the background passes during the startup restore waits for
   the restored rows (it plays as the newly added one) */
const jobsAfterRestore = async () => {
  const world = makePlayerWorld();

  // the background passes a link track while the restore is still pending
  const J = {name: 'j.mp3', href: 'https://x/j.mp3'};
  const responded = world.jobs([J]);
  if (responded !== true) {
    throw Error('the jobs message was not accepted synchronously');
  }
  await settleAll();
  if (world.audio.files !== null || world.view.rows.length !== 0) {
    throw Error('the passed track did not wait for the restore');
  }

  // the remembered tracks come back; the passed one follows them
  const Rst = {name: 'rst.mp3', href: 'https://x/rst.mp3'};
  world.finishRestore([Rst], 0);
  await settleAll();

  const files = world.audio.files;
  if (names(files) !== 'rst.mp3, j.mp3') {
    throw Error('the playlist is [' + names(files) + '] instead of [rst, j]');
  }
  if (world.audio.i !== 1 || world.audio.started[world.audio.started.length - 1] !== J) {
    throw Error('the passed track does not play as the newly added one');
  }
  world.checkMirrored();
  console.log('jobs ok: the passed track waits for the restored rows');
};

/* the permission of a locked track is granted after its row was replaced
   by a readable copy; the readable file must not overwrite the new row */
const unlockSkip = async () => {
  const world = makePlayerWorld();
  const gate = world.gates.makeGate();

  // a locked track: the permission prompt parks on the gate
  const handle = world.makeHandle(7, {
    permission: gate.wait('granted'),
    real: {name: 'unlocked.mp3', size: 100, lastModified: 1, type: 'audio/x-test'}
  });
  const L = world.makeFile('locked.mp3', handle, {locked: true});
  world.finishRestore([L], 0);
  await settleAll();

  // the locked row starts the playback: the permission is asked for
  world.view.rows[0]._internal.div.dispatch('click');
  await settle();
  if (world.remember.currents[world.remember.currents.length - 1] !== L) {
    throw Error('the locked track did not start the permission flow');
  }

  // the same track is dropped as a readable copy while the prompt is open;
  // the old locked entry is replaced by it
  const L2 = world.makeFile('locked-new.mp3', world.makeHandle(7));
  await world.add([L2]);
  await settleAll();

  // the permission comes back now; the row of the locked entry is gone, so
  // the readable file of the prompt must not be written anywhere
  gate.release();
  await settleAll();

  const files = world.audio.files;
  if (files.length !== 1 || files[0] !== L2) {
    throw Error('the playlist is [' + names(files) + '] instead of the readable copy alone');
  }
  if (world.remember.removes[world.remember.removes.length - 1] !== L) {
    throw Error('the locked entry was not forgotten');
  }
  world.checkMirrored();
  console.log('unlock ok: a vanished row is not written back');
};

/* the readable replacement inherits the locked row's cleanup, so the row
   becomes a normal playlist row and its deletion keeps the selection and
   navigation controls synchronized */
const unlockInteraction = async () => {
  const world = makePlayerWorld();
  const handle = world.makeHandle(7, {
    real: {name: 'locked.mp3', size: 100, lastModified: 1, type: 'audio/x-test'}
  });
  const locked = world.makeFile('locked.mp3', handle, {locked: true});
  const other = {name: 'other.mp3', href: 'https://x/other.mp3'};
  world.finishRestore([locked, other], 1);
  await settleAll();

  const row = world.view.rows[0];
  const div = row._internal.div;
  let cleanups = 0;
  const cleanup = locked.cleanup;
  locked.cleanup = () => {
    cleanups += 1;
    cleanup();
  };

  // the locked row supplies the user action that grants the permission
  div.dispatch('click');
  await settleAll();

  const readable = world.audio.files[0];
  if (readable === locked || readable.handle !== handle) {
    throw Error('the locked entry was not replaced by its readable file');
  }
  if (readable.cleanup !== locked.cleanup) {
    throw Error('the readable replacement did not inherit the row cleanup');
  }
  if (cleanups !== 1) {
    throw Error('the replacement did not normalize its row after the swap');
  }
  if ((div.listeners.click || []).length !== 0 ||
      div.style.opacity || div.style.pointerEvents || div.style.cursor) {
    throw Error('the unlocked row kept its locked interaction state');
  }
  if (div.lastElementChild.previousElementSibling.textContent !== 'Local File') {
    throw Error('the unlocked row still asks for read permission');
  }
  world.checkMirrored();

  // keep the other track current, then delete the restored row before it
  world.view.onchange({target: {selectedIndex: 2}});
  await settleAll();
  world.openMenuAt(10);
  world.clickMenu('delete-this');
  await settleAll();

  if (world.audio.files.length !== 1 || world.audio.files[0] !== other) {
    throw Error('the unlocked row was not deleted from the playlist');
  }
  if (cleanups !== 2) {
    throw Error('the replacement did not run its cleanup when deleted');
  }
  if (world.audio.i !== 0 || world.view.selectedIndex !== 1) {
    throw Error('the selection did not follow the shorter playlist');
  }
  const previous = world.document.getElementById('previous');
  const next = world.document.getElementById('next');
  if (previous.disabled !== true || next.disabled !== true) {
    throw Error('the only track did not disable both navigation buttons');
  }
  if (world.document.title !== '[1/1] other.mp3 :: Audio Player') {
    throw Error('the title did not follow the shorter playlist');
  }
  world.checkMirrored();
  console.log('unlocked row ok: the replacement behaves and deletes like a normal row');
};

/* the retry of an unlock must follow its readable replacement by identity,
   not by its place: a deletion under the parked retry shifts the rows and
   the old place then holds another track, which the old code restarted */
const retryIdentity = async () => {
  const world = makePlayerWorld();
  const permission = world.gates.makeGate();
  const compare = world.gates.makeGate();

  // a locked track whose permission ask parks on the gate; the readable
  // copy keeps the name of its row
  const real = {name: 'locked.mp3', size: 100, lastModified: 1, type: 'audio/x-test'};
  const handle = {
    id: 7,
    // every entry comparison parks: the dedupe scan of the incoming
    // addition holds the mutation queue until the test releases it
    isSameEntry: () => compare.wait(false),
    requestPermission: () => permission.wait('granted'),
    getFile: async () => ({...real})
  };
  const L = world.makeFile('locked.mp3', handle, {locked: true});
  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  world.finishRestore([A, L], 1);
  await settleAll();

  // the locked row starts the permission flow; the retry parks on the gate
  world.view.rows[1]._internal.div.dispatch('click');
  await settle();
  if (world.remember.currents[world.remember.currents.length - 1] !== L) {
    throw Error('the locked track did not start the permission flow');
  }

  // another track arrives; its scan parks on the comparison with the locked
  // entry and holds the queue, so the replacement of the unlock waits too
  const C = world.makeFile('c.mp3', world.makeHandle(9));
  world.add([C]);
  await settle();

  // the permission comes back; the replacement queues behind the parked
  // addition and the row identity of the retry is recorded before both
  permission.release();
  await settle();

  // the row of A is deleted while everything waits
  world.openMenuAt(10); // the row of A
  world.clickMenu('delete-this');
  await settle();

  // the addition resumes: C plays as the newly added one, then the
  // replacement runs and the deletion shifts the rows under the retry
  compare.release();
  await settleAll();

  const files = world.audio.files;
  if (files.length !== 2 || files[0].handle !== handle || files[0].locked || files[1] !== C) {
    throw Error('the playlist is [' + names(files) +
      '] instead of the readable replacement and c.mp3');
  }
  if (world.audio.i !== 1) {
    throw Error('the current track did not stay on c.mp3');
  }
  /* the deletion moved C into the old place of the unlocked row; the retry
     of the old code restarted C here because the place still matched */
  if (world.audio.started.length !== 1 || world.audio.started[0] !== C) {
    throw Error('the stale retry restarted the playing track (' +
      world.audio.started.length + ' start(s))');
  }
  world.checkMirrored();
  console.log('retry ok: the unlock retry follows its replacement, not its place');
};

/* the same schedule through the Grant Access dialog: the retry of the
   Grant button must also resume its replacement by identity */
const grantRetryIdentity = async () => {
  const world = makePlayerWorld();
  const permission = world.gates.makeGate();
  const compare = world.gates.makeGate();

  // the first ask is denied (the dialog opens), the second one is granted
  let granted = false;
  const real = {name: 'locked.mp3', size: 100, lastModified: 1, type: 'audio/x-test'};
  const handle = {
    id: 7,
    isSameEntry: () => compare.wait(false),
    requestPermission: () => permission.wait(granted ? 'granted' : 'denied'),
    getFile: async () => ({...real})
  };
  const L = world.makeFile('locked.mp3', handle, {locked: true});
  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  world.finishRestore([A, L], 1);
  await settleAll();

  // the locked row asks for the permission; the ask is denied and the
  // Grant Access dialog opens
  world.view.rows[1]._internal.div.dispatch('click');
  await settle();
  permission.release();
  await settle();

  const grant = world.document.getElementById('grant');
  if (grant.open !== true) {
    throw Error('the Grant Access dialog did not open on the denied ask');
  }

  // the dialog stays open while another track arrives (a broadcast of the
  // worker can always do this); its scan parks and holds the queue
  const C = world.makeFile('c.mp3', world.makeHandle(9));
  world.add([C]);
  await settle();

  // the user grants the access; the second ask parks on the gate
  granted = true;
  world.document.getElementById('grant-ok').dispatch('click');
  await settle();

  // the permission is granted now; the replacement queues behind the
  // parked addition
  permission.release();
  await settle();

  // the row of A is deleted while everything waits
  world.openMenuAt(10); // the row of A
  world.clickMenu('delete-this');
  await settle();

  // the addition resumes: C plays, then the replacement runs and the
  // deletion shifts the rows under the retry of the Grant button
  compare.release();
  await settleAll();

  const files = world.audio.files;
  if (files.length !== 2 || files[0].handle !== handle || files[0].locked || files[1] !== C) {
    throw Error('the playlist is [' + names(files) +
      '] instead of the readable replacement and c.mp3');
  }
  if (grant.open !== false) {
    throw Error('the Grant Access dialog did not close after the grant');
  }
  if (world.audio.started.length !== 1 || world.audio.started[0] !== C) {
    throw Error('the stale retry of the Grant button restarted the playing track (' +
      world.audio.started.length + ' start(s))');
  }
  world.checkMirrored();
  console.log('grant retry ok: the Grant button resumes its replacement, not its place');
};

/* the context menu remembers its row by its entry, so a deletion after the
   playlist changed removes the right row (or nothing when it is gone) */
const menuRow = async () => {
  const world = makePlayerWorld();

  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  const B = {name: 'b.mp3', href: 'https://x/b.mp3'};
  world.finishRestore([A, B], 1);
  await settleAll();

  // the menu opens on the row of A
  world.openMenuAt(10);

  // a new copy of A replaces the old one: A moves to the end of the list
  const A2 = {name: 'a-new.mp3', href: 'https://x/a.mp3'};
  await world.add([A2]);
  await settleAll();

  // the menu deletion refers to the remembered row: A is gone, so nothing
  // may happen (the old code removed B here, the row that slid into the
  // remembered place)
  world.clickMenu('delete-this');
  await settleAll();

  let files = world.audio.files;
  if (names(files) !== 'b.mp3, a-new.mp3') {
    throw Error('the playlist is [' + names(files) + '] instead of [b, a-new]');
  }

  // a fresh menu opens on the row of the new copy: the deletion works
  world.openMenuAt(30);
  world.clickMenu('delete-this');
  await settleAll();

  files = world.audio.files;
  if (names(files) !== 'b.mp3' || world.audio.i !== 0) {
    throw Error('the playlist is [' + names(files) + '] instead of [b]');
  }
  world.checkMirrored();
  console.log('menu ok: the deletion follows its row, not its old place');
};

/* ------------------------------------------------------------------- run */

const run = async () => {
  await duplicates();
  await wrongRow();
  await order();
  await jobsAfterRestore();
  await unlockSkip();
  await unlockInteraction();
  await retryIdentity();
  await grantRetryIdentity();
  await menuRow();

  console.log('PLAYER-ADD TEST PASSED');
};

run().catch(e => {
  console.error('PLAYER-ADD TEST FAILED:', e.message);
  process.exit(1);
});
