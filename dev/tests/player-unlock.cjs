/* Node test: the read-permission flow of the real v2/data/player/index.js in
   the fake page world (player-world.cjs).

   The behaviors this file guards:

     - batch: one granted ask unlocks every other locked track whose handle
       reports its read permission as granted (the prompt of the browser
       covers the files the extension was granted before), and the replaced
       rows lose their locked interaction state
     - partial: a handle that still reads 'prompt' stays locked and asks for
       its own permission on its first attempt to play
     - denied: a denied ask opens the Grant Access dialog and asks nothing
       else; the Grant button re-asks and the batch follows the new grant
     - front: an ask without a user action (the automatic advancement and
       the media keys) raises the window of the player before the
       Grant Access dialog opens
     - hidden: a hidden player never asks with the prompt of the browser
       (it would open behind the window); the dialog does the asking once
       the window was raised, and a granted track plays in the background
     - gone: a sibling locked row that was removed while a prompt was open
       does not disturb the swap or the batch

   Run: node dev/tests/player-unlock.cjs */

const {makePlayerWorld, settleAll} = require('./player-world.cjs');

const names = files => files.map(f => f.name).join(', ');

const readable = name => ({name, size: 100, lastModified: 1, type: 'audio/x-test'});

/* count the asks of a handle without changing what they answer */
const counted = (handle, ask) => {
  let asks = 0;
  handle.requestPermission = () => {
    asks += 1;
    return ask();
  };
  return () => asks;
};

/* let a few macrotask turns pass so that a parked chain can advance */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/* ------------------------------------------------------------ the scenarios */

/* one granted ask replaces every locked row whose handle reads 'granted' */
const batch = async () => {
  const world = makePlayerWorld();

  const h1 = world.makeHandle(1, {query: 'granted', real: readable('a.mp3')});
  const h2 = world.makeHandle(2, {query: 'granted', real: readable('b.mp3')});
  const asks1 = counted(h1, () => Promise.resolve('granted'));
  const asks2 = counted(h2, () => Promise.resolve('granted'));

  const L1 = world.makeFile('a.mp3', h1, {locked: true});
  const L2 = world.makeFile('b.mp3', h2, {locked: true});
  world.finishRestore([L1, L2], 0);
  await settleAll();

  // the locked row of the first track supplies the user action
  world.view.rows[0]._internal.div.dispatch('click');
  await settleAll();

  if (asks1() !== 1) {
    throw Error('the first track asked ' + asks1() + ' time(s)');
  }
  // the whole playlist was restored by the one ask; the second handle was
  // never asked for its own permission
  if (asks2() !== 0) {
    throw Error('the second track was asked ' + asks2() + ' time(s)');
  }
  const files = world.audio.files;
  if (files.length !== 2 || files[0].handle !== h1 || files[0].locked ||
      files[1].handle !== h2 || files[1].locked) {
    throw Error('the playlist is [' + names(files) + '] instead of two readable tracks');
  }
  // only the selected track plays; the batch replaces the other one silently
  if (world.audio.started.length !== 1 || world.audio.started[0] !== files[0]) {
    throw Error('the unlocked track did not resume as itself');
  }
  // both rows lost their locked interaction state
  for (const row of world.view.rows) {
    const div = row._internal.div;
    if (div.lastElementChild.textContent !== 'Local File' ||
        div.style.opacity || div.style.pointerEvents || div.style.cursor ||
        (div.listeners.click || []).length !== 0) {
      throw Error('the unlocked row kept its locked interaction state');
    }
  }
  world.checkMirrored();
  console.log('batch ok: one ask unlocked the whole playlist');
};

/* a handle that still reads 'prompt' stays locked and asks on its own play */
const partial = async () => {
  const world = makePlayerWorld();

  const h1 = world.makeHandle(1, {query: 'granted', real: readable('a.mp3')});
  const h2 = world.makeHandle(2, {query: 'prompt', real: readable('b.mp3')});
  const asks2 = counted(h2, () => Promise.resolve('granted'));

  const L1 = world.makeFile('a.mp3', h1, {locked: true});
  const L2 = world.makeFile('b.mp3', h2, {locked: true});
  world.finishRestore([L1, L2], 0);
  await settleAll();

  world.view.rows[0]._internal.div.dispatch('click');
  await settleAll();

  const files = world.audio.files;
  if (files[0].locked || files[0].handle !== h1) {
    throw Error('the asked track was not replaced by its readable file');
  }
  if (files[1] !== L2 || files[1].locked !== true) {
    throw Error('the ungranted track did not stay locked');
  }
  const div = world.view.rows[1]._internal.div;
  if (div.style.opacity !== '0.6' ||
      world.view.rows[1].parts[1].name !== 'Local File (read permission needed)') {
    throw Error('the still-locked row lost its locked appearance');
  }

  // the fallback: playing the locked track asks for its own permission
  world.view.rows[1]._internal.div.dispatch('click');
  await settleAll();

  if (asks2() !== 1) {
    throw Error('the locked track asked ' + asks2() + ' time(s) on its play');
  }
  if (world.audio.files[1].locked || world.audio.files[1].handle !== h2) {
    throw Error('the granted track was not replaced after its own ask');
  }
  if (world.audio.started.length !== 2 ||
      world.audio.started[1] !== world.audio.files[1]) {
    throw Error('the second track did not play after its own grant');
  }
  world.checkMirrored();
  console.log('partial ok: an ungranted track stays locked and asks on its play');
};

/* a denied ask opens the dialog and asks nothing else; the Grant button
   re-asks and the batch follows the new grant */
const denied = async () => {
  const world = makePlayerWorld();

  let granted = false;
  const h1 = world.makeHandle(1, {real: readable('a.mp3')});
  h1.requestPermission = () => Promise.resolve(granted ? 'granted' : 'denied');
  const h2 = world.makeHandle(2, {query: 'granted', real: readable('b.mp3')});
  const asks2 = counted(h2, () => Promise.resolve('granted'));

  const L1 = world.makeFile('a.mp3', h1, {locked: true});
  const L2 = world.makeFile('b.mp3', h2, {locked: true});
  world.finishRestore([L1, L2], 0);
  await settleAll();

  world.view.rows[0]._internal.div.dispatch('click');
  await settleAll();

  const grant = world.document.getElementById('grant');
  if (grant.open !== true) {
    throw Error('the Grant Access dialog did not open on the denied ask');
  }
  if (asks2() !== 0) {
    throw Error('a denied ask unlocked another track');
  }
  if (world.audio.files[0] !== L1 || world.audio.files[1] !== L2) {
    throw Error('a denied ask changed the playlist');
  }

  // the Grant button provides the user action of the second ask
  granted = true;
  world.document.getElementById('grant-ok').dispatch('click');
  await settleAll();

  if (grant.open !== false) {
    throw Error('the Grant Access dialog did not close after the grant');
  }
  const files = world.audio.files;
  if (files.length !== 2 || files[0].locked || files[0].handle !== h1 ||
      files[1].locked || files[1].handle !== h2) {
    throw Error('the playlist is [' + names(files) + '] after the granted ask');
  }
  if (asks2() !== 0) {
    throw Error('the granted ask asked the second handle anyway');
  }
  if (world.audio.started.length !== 1 || world.audio.started[0] !== files[0]) {
    throw Error('the granted track did not resume');
  }
  world.checkMirrored();
  console.log('denied ok: the dialog re-asks and the batch follows the grant');
};

/* an ask without a user action raises the window before the dialog opens */
const front = async () => {
  const world = makePlayerWorld();

  // the ask of the automatic advancement carries no user action
  const h1 = world.makeHandle(1, {real: readable('a.mp3')});
  h1.requestPermission = () => Promise.reject(Error('NO_ACTIVATION'));
  const h2 = world.makeHandle(2, {query: 'granted', real: readable('b.mp3')});

  const L1 = world.makeFile('a.mp3', h1, {locked: true});
  const L2 = world.makeFile('b.mp3', h2, {locked: true});
  world.finishRestore([L1, L2], 0);
  await settleAll();

  // the automatic path: the empty player starts the selected track
  world.audio.dispatch('empty');
  await settleAll();

  const message = world.sentMessages.find(m => m.method === 'bring-to-front');
  if (!message || message.windowId !== 1) {
    throw Error('the player did not raise its window before the dialog');
  }
  const grant = world.document.getElementById('grant');
  if (grant.open !== true) {
    throw Error('the Grant Access dialog did not open after the raise');
  }
  // nothing was granted; the batch runs after a grant alone
  const files = world.audio.files;
  if (files[0] !== L1 || files[1] !== L2 || files[0].locked !== true) {
    throw Error('the failed ask changed the playlist');
  }
  if (grant.returnValue !== '') {
    throw Error('the dialog leaked a return value');
  }
  world.checkMirrored();
  console.log('front ok: the window is raised before the dialog opens');
};

/* a sibling locked row that was removed while a prompt was open does not
   disturb the swap or the batch */
const gone = async () => {
  const world = makePlayerWorld();
  const gate = world.gates.makeGate();

  const h1 = world.makeHandle(1, {
    permission: gate.wait('granted'),
    query: 'granted',
    real: readable('a.mp3')
  });
  const h2 = world.makeHandle(2, {query: 'granted', real: readable('b.mp3')});

  const L1 = world.makeFile('a.mp3', h1, {locked: true});
  const L2 = world.makeFile('b.mp3', h2, {locked: true});
  world.finishRestore([L1, L2], 0);
  await settleAll();

  // the locked row starts the permission flow; the ask parks on the gate
  world.view.rows[0]._internal.div.dispatch('click');
  await settle();

  // the sibling locked row is removed while the prompt is open
  world.openMenuAt(30); // the row of the second track
  world.clickMenu('delete-this');
  await settleAll();

  // the permission comes back; the own row is replaced and the batch finds
  // the sibling gone
  gate.release();
  await settleAll();

  const files = world.audio.files;
  if (files.length !== 1 || files[0].handle !== h1 || files[0].locked) {
    throw Error('the playlist is [' + names(files) + '] instead of the readable copy');
  }
  if (world.audio.started.length !== 1 || world.audio.started[0] !== files[0]) {
    throw Error('the unlocked track did not resume after the deletion');
  }
  world.checkMirrored();
  console.log('gone ok: a removed sibling does not disturb the batch');
};

/* the OS media keys and the automatic advancement reach a hidden player;
   there the read permission is not asked for (the prompt of the browser
   would open behind the window) — the grant dialog asks for it instead */
const hidden = async () => {
  const world = makePlayerWorld();
  world.document.hasFocus = () => false;

  const h1 = world.makeHandle(1, {query: 'prompt', real: readable('a.mp3')});
  const h2 = world.makeHandle(2, {query: 'granted', real: readable('b.mp3')});
  const asks1 = counted(h1, () => Promise.resolve('granted'));
  const asks2 = counted(h2, () => Promise.resolve('granted'));

  const L1 = world.makeFile('a.mp3', h1, {locked: true});
  const L2 = world.makeFile('b.mp3', h2, {locked: true});
  world.finishRestore([L1, L2], 0);
  await settleAll();

  // the automatic path starts the selected locked track
  world.audio.dispatch('empty');
  await settleAll();

  // the permission was never asked for; the window was raised and the
  // grant dialog opened instead
  if (asks1() !== 0) {
    throw Error('the hidden player asked for the permission ' + asks1() + ' time(s)');
  }
  const message = world.sentMessages.find(m => m.method === 'bring-to-front');
  if (!message || message.windowId !== 1) {
    throw Error('the hidden player did not raise its window');
  }
  const grant = world.document.getElementById('grant');
  if (grant.open !== true) {
    throw Error('the grant dialog did not open for the hidden player');
  }

  // the Grant button of the raised dialog provides the user action
  world.document.getElementById('grant-ok').dispatch('click');
  await settleAll();

  if (asks1() !== 1) {
    throw Error('the Grant button asked ' + asks1() + ' time(s)');
  }
  // the batch follows the one grant: the second locked track is readable too
  const files = world.audio.files;
  if (files.length !== 2 || files[0].handle !== h1 || files[0].locked ||
      files[1].handle !== h2 || files[1].locked) {
    throw Error('the playlist is [' + names(files) + '] after the grant');
  }
  if (asks2() !== 0) {
    throw Error('the second track was asked ' + asks2() + ' time(s)');
  }
  if (world.audio.started.length !== 1 || world.audio.started[0] !== files[0]) {
    throw Error('the granted track did not resume');
  }
  world.checkMirrored();
  console.log('hidden ok: a hidden player asks through the dialog, not the prompt');
};

/* a hidden player whose read access is still granted plays in the
   background without a dialog and without raising the window */
const hiddenGranted = async () => {
  const world = makePlayerWorld();
  world.document.hasFocus = () => false;

  const h1 = world.makeHandle(1, {query: 'granted', real: readable('a.mp3')});
  const asks1 = counted(h1, () => Promise.resolve('granted'));
  const L1 = world.makeFile('a.mp3', h1, {locked: true});
  world.finishRestore([L1], 0);
  await settleAll();

  world.audio.dispatch('empty');
  await settleAll();

  if (asks1() !== 0) {
    throw Error('the hidden player asked for the granted permission');
  }
  if (world.document.getElementById('grant').open !== false) {
    throw Error('the grant dialog opened for a granted track');
  }
  if (world.sentMessages.some(m => m.method === 'bring-to-front')) {
    throw Error('a granted track raised the window');
  }
  const files = world.audio.files;
  if (files.length !== 1 || files[0].handle !== h1 || files[0].locked) {
    throw Error('the granted track was not replaced by its readable file');
  }
  if (world.audio.started.length !== 1 || world.audio.started[0] !== files[0]) {
    throw Error('the granted track did not play in the background');
  }
  world.checkMirrored();
  console.log('hidden granted ok: a granted track plays without raising the window');
};

/* ------------------------------------------------------------------- run */

const run = async () => {
  await batch();
  await partial();
  await denied();
  await front();
  await gone();
  await hidden();
  await hiddenGranted();

  console.log('PLAYER-UNLOCK TEST PASSED');
};

run().catch(e => {
  console.error('PLAYER-UNLOCK TEST FAILED:', e.message);
  process.exit(1);
});
