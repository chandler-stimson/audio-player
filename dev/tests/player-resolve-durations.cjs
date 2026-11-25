/* Node test: the "Resolve All Durations" batch of the real
   v2/data/player/index.js in the fake page world (player-world.cjs).

   The behaviors this file guards:

     - menu: the entry is disabled for an empty playlist and enabled
       otherwise; clicking it on an empty playlist opens nothing
     - known: a track whose length is already known (the playing track) is
       counted without a decode and its row keeps the length
     - local: a small local file is decoded on demand with the meta worker;
       its row is filled and the decoded result is cached
     - network: the header of a network track is read only; the session is
       closed right away and the row follows the reported length
     - blank: a stream whose header tells no length stays blank and is
       reported; the stream is not decoded to the end
     - locked: the read permissions are asked for first, while the click
       that started the batch is still a fresh user action; a granted ask
       fills the row, a denied ask is reported and leaves the locked
       appearance of the row alone
     - failed: an unreadable track is reported and does not stop the rest
     - gone: a track that left the playlist while the batch ran is skipped
       without writing over the row that took its place
     - cancel: closing the dialog stops the batch; a result that arrives
       afterwards is not written anywhere and no report is left behind
     - again: a finished batch can be followed by a fresh one

   Run: node dev/tests/player-resolve-durations.cjs */

const {makePlayerWorld, settle, settleAll} = require('./player-world.cjs');

/* the duration cell of the row of a track; the rows mirror audio.files */
const cell = (world, i) => world.view.rows[i]._internal.div.lastElementChild.textContent;

const dialog = world => world.document.getElementById('resolve');

/* ------------------------------------------------------------ the scenarios */

/* the entry follows the emptiness of the playlist */
const menu = async () => {
  const world = makePlayerWorld();
  world.finishRestore([], -1);
  await settleAll();

  world.openMenuAt(5); // no rows yet
  if (world.document.getElementById('resolve-durations').disabled !== true) {
    throw Error('the entry is enabled for an empty playlist');
  }
  world.clickMenu('resolve-durations');
  if (dialog(world).open !== false) {
    throw Error('the empty playlist started a batch');
  }

  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  await world.add([A]);
  await settleAll();

  world.openMenuAt(10);
  if (world.document.getElementById('resolve-durations').disabled !== false) {
    throw Error('the entry is disabled for a filled playlist');
  }
  console.log('menu ok: the entry follows the emptiness of the playlist');
};

/* the playing track is known without a decode; the other one is decoded */
const knownAndLocal = async () => {
  const world = makePlayerWorld();
  const A = world.makeFile('a.mp3', world.makeHandle(1));
  const B = world.makeFile('b.mp3', world.makeHandle(2));
  world.finishRestore([A, B], 0);
  await settleAll();

  // the length of the playing track is known already (its decode ran)
  world.audio.audioBuffer = {duration: 185};

  let decodeCalls = 0;
  world.decoder.decode = ({owner}) => {
    decodeCalls += 1;
    if (owner !== 'meta') {
      throw Error('the batch did not use the meta worker');
    }
    return Promise.resolve({
      audioBuffer: {duration: 90, length: 1, numberOfChannels: 2},
      meta: {}
    });
  };

  world.openMenuAt(10);
  world.clickMenu('resolve-durations');
  await settleAll();

  if (cell(world, 0) !== '185' || cell(world, 1) !== '90') {
    throw Error('the rows show [' + cell(world, 0) + ', ' + cell(world, 1) +
      '] instead of [185, 90]');
  }
  if (decodeCalls !== 1) {
    throw Error('the known track was decoded ' + decodeCalls + ' time(s)');
  }

  // the report of the finished batch; the dialog stays open with its Close
  const status = world.document.getElementById('resolve-status');
  if (status.hidden !== false) {
    throw Error('the finished batch left no report');
  }
  if (status.textContent !== 'Resolved the length of 1 track. ' +
      '1 track had its length already.') {
    throw Error('the report reads: ' + status.textContent);
  }
  if (dialog(world).open !== true) {
    throw Error('the dialog closed itself after the batch');
  }
  if (world.document.getElementById('resolve-button').textContent !== 'Close') {
    throw Error('the button did not become the Close of the report');
  }
  if (world.document.getElementById('resolve-progress').hidden !== true) {
    throw Error('the bar is still shown after the batch');
  }
  world.checkMirrored();
  console.log('known ok: the playing track is known without a decode');
};

/* the header of a network track is read only and the session is closed */
const network = async () => {
  const world = makePlayerWorld();
  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  const B = {name: 'b.mp3', href: 'https://x/b.mp3'};
  world.finishRestore([A, B], -1);
  await settleAll();

  const closes = [];
  world.decoder.open = ({href, owner}) => {
    if (owner !== 'meta') {
      throw Error('the batch did not use the meta worker');
    }
    if (href === undefined) {
      throw Error('the network track was not opened by its link');
    }
    return Promise.resolve({
      meta: {'Duration': 120},
      close: () => {
        closes.push(href);
        return Promise.resolve();
      }
    });
  };

  world.openMenuAt(10);
  world.clickMenu('resolve-durations');
  await settleAll();

  if (cell(world, 0) !== '120' || cell(world, 1) !== '120') {
    throw Error('the rows show [' + cell(world, 0) + ', ' + cell(world, 1) +
      '] instead of [120, 120]');
  }
  if (closes.length !== 2) {
    throw Error('the opened streams were not closed (' + closes.length + ')');
  }
  const status = world.document.getElementById('resolve-status');
  if (status.textContent !== 'Resolved the lengths of 2 tracks.') {
    throw Error('the report reads: ' + status.textContent);
  }
  world.checkMirrored();
  console.log('network ok: the headers are read and their sessions closed');
};

/* a stream that tells no length stays blank and is reported */
const blankHeader = async () => {
  const world = makePlayerWorld();
  const A = {name: 'a.ogg', href: 'https://x/a.ogg'};
  world.finishRestore([A], 0);
  await settleAll();

  world.decoder.open = () => Promise.resolve({
    meta: {'Sample Rate': 44100},
    close: () => Promise.resolve()
  });

  world.openMenuAt(10);
  world.clickMenu('resolve-durations');
  await settleAll();

  if (cell(world, 0) !== '-') {
    throw Error('the row was filled without a reported length');
  }
  const status = world.document.getElementById('resolve-status');
  if (status.textContent !== 'Resolved the lengths of 0 tracks. ' +
      'No length reported: a.ogg.') {
    throw Error('the report reads: ' + status.textContent);
  }
  world.checkMirrored();
  console.log('blank ok: a stream without a length stays blank and is reported');
};

/* the permissions come first; a granted ask fills the row and a denied one
   is reported while the locked appearance of its row stays */
const locked = async () => {
  const world = makePlayerWorld();
  const gate = world.gates.makeGate();
  const asks = [];

  // the handles without a query option are asked directly (the ask counts
  // are kept here, like the counted helper of player-unlock.cjs does)
  const h1 = world.makeHandle(1, {
    real: {name: 'a.mp3', size: 100, lastModified: 1, type: 'audio/x-test'}
  });
  h1.requestPermission = () => {
    asks.push('a.mp3');
    return gate.wait('granted');
  };
  const h2 = world.makeHandle(2, {});
  h2.requestPermission = () => {
    asks.push('b.mp3');
    return Promise.resolve('denied');
  };
  const L1 = world.makeFile('a.mp3', h1, {locked: true});
  const L2 = world.makeFile('b.mp3', h2, {locked: true});
  world.finishRestore([L1, L2], 0);
  await settleAll();

  world.decoder.decode = () => Promise.resolve({
    audioBuffer: {duration: 90, length: 1, numberOfChannels: 2},
    meta: {}
  });

  world.openMenuAt(10);
  world.clickMenu('resolve-durations');
  await settle();

  // the ask of the first locked track comes before any decode: the dialog
  // reports the asking while the permission parks on the gate
  if (asks.length !== 1) {
    throw Error('the permission was not asked first (' + asks.length + ')');
  }
  if (world.document.getElementById('resolve-track').textContent
      .indexOf('read access') === -1) {
    throw Error('the dialog does not tell the asking: ' +
      world.document.getElementById('resolve-track').textContent);
  }
  if (world.document.getElementById('resolve-progress').getAttribute('value') !==
      undefined) {
    throw Error('the bar is determinate before the size of the batch is known');
  }

  gate.release();
  await settleAll();

  // the granted track was replaced by its readable copy and decoded; the
  // denied one stays locked and is reported
  if (world.audio.files[0].locked || world.audio.files[0].handle !== h1) {
    throw Error('the granted ask did not replace the locked entry');
  }
  if (cell(world, 0) !== '90') {
    throw Error('the row of the unlocked copy shows ' + cell(world, 0));
  }
  if (world.audio.files[1] !== L2 || world.audio.files[1].locked !== true) {
    throw Error('the denied track did not stay locked');
  }
  const div = world.view.rows[1]._internal.div;
  if (div.style.opacity !== '0.6' ||
      world.view.rows[1].parts[1].name !== 'Local File (read permission needed)') {
    throw Error('the denied row lost its locked appearance');
  }
  if (cell(world, 1) !== '-') {
    throw Error('the denied row invented a length');
  }
  const status = world.document.getElementById('resolve-status');
  if (status.textContent !== 'Resolved the length of 1 track. ' +
      'Read access needed: b.mp3.') {
    throw Error('the report reads: ' + status.textContent);
  }
  world.checkMirrored();
  console.log('locked ok: the permissions come first and denials are reported');
};

/* an unreadable track is reported and does not stop the rest */
const failed = async () => {
  const world = makePlayerWorld();
  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  const B = world.makeFile('b.mp3', world.makeHandle(2));
  world.finishRestore([A, B], 0);
  await settleAll();

  const attempts = [];
  world.decoder.open = () => {
    attempts.push('a.mp3');
    return Promise.reject(Error('HTTP_404'));
  };
  world.decoder.decode = () => {
    attempts.push('b.mp3');
    return Promise.reject(Error('CORRUPT'));
  };

  world.openMenuAt(10);
  world.clickMenu('resolve-durations');
  await settleAll();

  if (attempts.join(',') !== 'a.mp3,b.mp3') {
    throw Error('the batch did not continue after the failure: ' +
      attempts.join(','));
  }
  if (cell(world, 0) !== '-' || cell(world, 1) !== '-') {
    throw Error('a failed track invented a length');
  }
  const status = world.document.getElementById('resolve-status');
  if (status.textContent !== 'Resolved the lengths of 0 tracks. ' +
      'Cannot read: a.mp3, b.mp3.') {
    throw Error('the report reads: ' + status.textContent);
  }
  world.checkMirrored();
  console.log('failed ok: unreadable tracks are reported without stopping');
};

/* a track that left the playlist while the batch ran is skipped; the row
   that took its place is not written over */
const gone = async () => {
  const world = makePlayerWorld();
  const gate = world.gates.makeGate();
  const A = world.makeFile('a.mp3', world.makeHandle(1, {gate}));
  const B = world.makeFile('b.mp3', world.makeHandle(2));
  world.finishRestore([A, B], 0);
  await settleAll();

  // the decode of the first track parks on the scripted decode
  const deferreds = [];
  world.decoder.decode = () => new Promise(resolve => deferreds.push(resolve));

  world.openMenuAt(10);
  world.clickMenu('resolve-durations');
  await settle();
  if (deferreds.length !== 1) {
    throw Error('the first track did not reach its decode');
  }

  // the same track arrives again while the batch waits: its old entry is
  // removed by the dedupe of the addition and a fresh copy is appended
  const A2 = world.makeFile('a.mp3', world.makeHandle(1));
  world.add([A2]);
  await settle();
  gate.release(); // the comparison of the addition says: the same track
  await settleAll();

  if (world.audio.files.length !== 2 || world.audio.files[0] !== B ||
      world.audio.files[1] !== A2) {
    throw Error('the playlist is [' +
      world.audio.files.map(f => f.name).join(', ') + '] instead of [b, a]');
  }

  // the parked decode arrives now; the old entry is gone, so nothing is
  // written and the batch continues with the next track
  deferreds[0]({audioBuffer: {duration: 90, length: 1, numberOfChannels: 2}, meta: {}});
  await settle();
  deferreds[1]({audioBuffer: {duration: 95, length: 1, numberOfChannels: 2}, meta: {}});
  await settleAll();

  if (cell(world, 0) !== '95') {
    throw Error('the row of b shows ' + cell(world, 0) + ' instead of its length');
  }
  if (cell(world, 1) !== '-') {
    throw Error('the fresh copy of a invented a length');
  }
  const status = world.document.getElementById('resolve-status');
  if (status.textContent !== 'Resolved the length of 1 track.') {
    throw Error('the report reads: ' + status.textContent);
  }
  world.checkMirrored();
  console.log('gone ok: a removed track is skipped without writing over');
};

/* closing the dialog while the batch runs stops it; a late result is not
   written and no report is left behind */
const cancel = async () => {
  const world = makePlayerWorld();
  const A = world.makeFile('a.mp3', world.makeHandle(1));
  const B = world.makeFile('b.mp3', world.makeHandle(2));
  world.finishRestore([A, B], -1);
  await settleAll();

  const deferreds = [];
  world.decoder.decode = () => new Promise(resolve => deferreds.push(resolve));

  world.openMenuAt(10);
  world.clickMenu('resolve-durations');
  await settle();
  if (deferreds.length !== 1) {
    throw Error('the first track did not reach its decode');
  }

  // the user closes the dialog while the first decode runs
  const resolveDialog = dialog(world);
  resolveDialog.open = false;
  resolveDialog.dispatch('close');
  await settle();

  if (world.document.getElementById('resolve-status').hidden !== true) {
    throw Error('the cancelled batch left a report');
  }
  if (world.document.getElementById('resolve-button').textContent !== 'Cancel') {
    throw Error('the button did not stay the Cancel of a running batch');
  }
  if (cell(world, 0) !== '-' || cell(world, 1) !== '-') {
    throw Error('the rows were filled after the cancel');
  }

  // the parked decode arrives late; nothing is written anywhere
  deferreds[0]({audioBuffer: {duration: 90, length: 1, numberOfChannels: 2}, meta: {}});
  await settleAll();
  if (cell(world, 0) !== '-' || cell(world, 1) !== '-') {
    throw Error('the late result of a cancelled batch was written');
  }
  world.checkMirrored();
  console.log('cancel ok: the closed dialog stops the batch and its writes');
};

/* a finished batch can be followed by a fresh one */
const again = async () => {
  const world = makePlayerWorld();
  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  world.finishRestore([A], 0);
  await settleAll();

  let opens = 0;
  world.decoder.open = () => {
    opens += 1;
    return Promise.resolve({
      meta: {'Duration': 120},
      close: () => Promise.resolve()
    });
  };

  world.openMenuAt(10);
  world.clickMenu('resolve-durations');
  await settleAll();
  if (cell(world, 0) !== '120') {
    throw Error('the first batch did not resolve the track');
  }

  // the report is closed and a fresh batch starts; the header read of the
  // first run is not kept, so the second one reads it again
  const resolveDialog = dialog(world);
  resolveDialog.open = false;
  resolveDialog.dispatch('close');
  await settle();

  world.openMenuAt(10);
  world.clickMenu('resolve-durations');
  await settleAll();

  if (opens !== 2) {
    throw Error('the second batch asked the decoder ' + opens + ' time(s)');
  }
  if (cell(world, 0) !== '120') {
    throw Error('the second batch did not resolve the track');
  }
  const status = world.document.getElementById('resolve-status');
  if (status.textContent !== 'Resolved the length of 1 track.') {
    throw Error('the second report reads: ' + status.textContent);
  }
  world.checkMirrored();
  console.log('again ok: a finished batch can be followed by a fresh one');
};

/* ------------------------------------------------------------------- run */

const run = async () => {
  await menu();
  await knownAndLocal();
  await network();
  await blankHeader();
  await locked();
  await failed();
  await gone();
  await cancel();
  await again();

  console.log('PLAYER-RESOLVE-DURATIONS TEST PASSED');
};

run().catch(e => {
  console.error('PLAYER-RESOLVE-DURATIONS TEST FAILED:', e.message);
  process.exit(1);
});
