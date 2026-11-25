/* Node test: the inline shortcut of the compact player. The real
   v2/data/player/index.js runs in the fake page world; clicking the
   "click here" action of the hint must send the expand message to the
   worker and must not change the playlist itself.

   Run: node dev/tests/player-expand.cjs */

const {makePlayerWorld, settleAll} = require('./player-world.cjs');

const run = async () => {
  const world = makePlayerWorld();

  world.clickMenu('expand');
  await settleAll(2);

  if (world.sentMessages.length !== 1) {
    throw Error('the expand click sent ' + world.sentMessages.length + ' messages');
  }
  if (world.sentMessages[0].method !== 'expand') {
    throw Error('the expand click sent ' + world.sentMessages[0].method);
  }
  if (world.audio.files !== null) {
    throw Error('the expand click changed the playlist');
  }

  console.log('PLAYER EXPAND TEST PASSED');
};

run().catch(e => {
  console.error('PLAYER EXPAND TEST FAILED:', e.message);
  process.exit(1);
});
