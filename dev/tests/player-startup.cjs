/* Node test: the startup query of the real v2/data/player/index.js in the
   fake page world (player-world.cjs).

   The regression this file guards: the player page accepts launch jobs
   through the ?json= query (the fallback handoff of the worker). A
   corrupted or hand-made URL used to end the startup of the query with an
   unhandled SyntaxError rejection and silently dropped the jobs:

     - malformed: a broken ?json= value is reported and dropped; the
       startup stays free of unhandled rejections and the consumer of a
       file launch (launchQueue) still adds its files afterwards
     - jobs: a valid ?json= value waits for the remembered tracks and its
       track plays as the newly added one (like the jobs broadcast does)

   Run: node dev/tests/player-startup.cjs */

const {makePlayerWorld, settleAll} = require('./player-world.cjs');

/* every unhandled rejection of the process; the broken query of the old
   page produced exactly one of these */
const rejections = [];
const onUnhandled = error => rejections.push(error);
process.on('unhandledRejection', onUnhandled);

const names = files => files.map(f => f.name).join(', ');

/* a console that records the reports of the page instead of printing them;
   the page only logs and warns/errors */
const makeConsole = () => {
  const messages = [];
  return {
    console: {
      log: (...args) => messages.push(['log', ...args]),
      warn: (...args) => messages.push(['warn', ...args]),
      error: (...args) => messages.push(['error', ...args])
    },
    messages
  };
};

/* a broken ?json= value is reported and dropped; the launch consumer stays
   registered and its files are added as the newly added ones */
const malformed = async () => {
  const {console: page, messages} = makeConsole();
  const world = makePlayerWorld({search: '?json=%7B', console: page}); // a bare '{'

  // the consumer of a file launch is registered while the query of this
  // window is broken
  const launched = world.launch([world.makeHandle(42)]);
  if (!launched || typeof launched.then !== 'function') {
    throw Error('the launchQueue consumer was not registered');
  }

  // the restore comes back; the broken query must not reject anything
  world.finishRestore([], -1);
  await settleAll();
  await launched;
  await settleAll();

  /* the error is a SyntaxError of the page realm; instanceof cannot be
     used across the vm boundary, so the name is compared instead */
  const report = messages.find(args => args[1] === 'CANNOT_PARSE_LAUNCH_JOBS');
  if (!report || !report[2] || report[2].name !== 'SyntaxError') {
    throw Error('the broken json query was not reported: ' +
      messages.map(m => m[0] + ' ' + m[1]).join(' | '));
  }
  if (rejections.length !== 0) {
    throw Error('the broken json query ended the startup with ' +
      rejections.length + ' unhandled rejection(s) (' + rejections[0] + ')');
  }

  // the launched file is the only track; the broken query added nothing
  const files = world.audio.files;
  if (!files || files.length !== 1 || files[0].name !== 'readable') {
    throw Error('the playlist is [' + names(files || []) + '] instead of the launched file');
  }
  world.checkMirrored();
  console.log('malformed ok: a broken json query is reported and the launch still works');
};

/* a valid ?json= value waits for the remembered tracks; its track follows
   them and plays as the newly added one */
const jobsQuery = async () => {
  const J = {name: 'j.mp3', href: 'https://x/j.mp3'};
  const search = '?json=' + encodeURIComponent(JSON.stringify([J]));
  const world = makePlayerWorld({search});

  // nothing is added while the restore is still pending
  await settleAll();
  if (world.audio.files !== null || world.view.rows.length !== 0) {
    throw Error('the query jobs did not wait for the restore');
  }

  // the remembered tracks come back; the query track follows them
  const Rst = {name: 'rst.mp3', href: 'https://x/rst.mp3'};
  world.finishRestore([Rst], 0);
  await settleAll();

  const files = world.audio.files;
  if (names(files) !== 'rst.mp3, j.mp3') {
    throw Error('the playlist is [' + names(files) + '] instead of [rst, j]');
  }
  /* the parsed jobs are objects of the page realm (the query is a string),
     so the playing track is compared by its content, not its identity */
  const current = world.audio.started[world.audio.started.length - 1];
  if (world.audio.i !== 1 || !current || current.name !== J.name || current.href !== J.href) {
    throw Error('the query track does not play as the newly added one');
  }
  world.checkMirrored();
  console.log('jobs ok: the query track waits for the restored rows');
};

/* ------------------------------------------------------------------- run */

const run = async () => {
  await malformed();
  await jobsQuery();

  if (rejections.length !== 0) {
    throw Error('unexpected unhandled rejection(s): ' +
      rejections.map(e => String(e)).join(', '));
  }
  process.off('unhandledRejection', onUnhandled);

  console.log('PLAYER-STARTUP TEST PASSED');
};

run().catch(e => {
  process.off('unhandledRejection', onUnhandled);
  console.error('PLAYER-STARTUP TEST FAILED:', e.message);
  process.exit(1);
});
