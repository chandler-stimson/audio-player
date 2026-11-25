/* Node test: the empty-playlist placeholder of the real player page in the
   fake page world. What is verified:

     - the instruction is visible before the first track arrives
     - adding tracks hides it
     - deleting one of several tracks keeps it hidden
     - deleting every track brings it back

   Run: node dev/tests/player-empty.cjs */

const fs = require('node:fs');
const path = require('node:path');
const {makePlayerWorld, settleAll} = require('./player-world.cjs');

const PLAYER_HTML = path.resolve(__dirname, '../../v2/data/player/index.html');
const PLAYER_CSS = path.resolve(__dirname, '../../v2/data/player/index.css');

const run = async () => {
  const html = fs.readFileSync(PLAYER_HTML, 'utf8');
  const css = fs.readFileSync(PLAYER_CSS, 'utf8');
  if (html.includes('id="playlist-empty"') === false) {
    throw Error('the player page has no empty-playlist placeholder');
  }
  if (css.includes('#view::part(row)') === false ||
      css.includes('padding-inline: 8px') === false) {
    throw Error('the playlist rows have no inline padding');
  }
  const playlistRule = /#playlist\s*\{[^}]*\}/.exec(css);
  if (!playlistRule || playlistRule[0].includes('padding-inline')) {
    throw Error('the playlist container is padded instead of its rows');
  }
  if (css.includes('scrollbar-width: thin') === false) {
    throw Error('the playlist does not use a thin scrollbar');
  }

  const world = makePlayerWorld();
  const placeholder = () => world.document.getElementById('playlist-empty');

  world.finishRestore([], -1);
  await settleAll();

  if (placeholder().hidden !== false) {
    throw Error('the empty playlist does not show its instruction');
  }

  const A = {name: 'a.mp3', href: 'https://x/a.mp3'};
  const B = {name: 'b.mp3', href: 'https://x/b.mp3'};
  await world.add([A, B]);
  await settleAll();

  if (placeholder().hidden !== true) {
    throw Error('the instruction stayed visible over a filled playlist');
  }

  world.openMenuAt(10); // the row of A
  world.clickMenu('delete-this');
  await settleAll();

  if (world.audio.files.length !== 1 || placeholder().hidden !== true) {
    throw Error('the instruction returned while one track was left');
  }

  world.clickMenu('delete-all');
  const confirmation = world.document.getElementById('confirm');
  confirmation.returnValue = 'delete-all';
  confirmation.dispatch('close');
  await settleAll();

  if (world.audio.files !== null || placeholder().hidden !== false) {
    throw Error('the instruction did not return to the empty playlist');
  }

  console.log('PLAYER EMPTY TEST PASSED');
};

run().catch(e => {
  console.error('PLAYER EMPTY TEST FAILED:', e.message);
  process.exit(1);
});
