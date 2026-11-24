/* Node test: the whole playback chain of the streaming path against a real
   mp4 — the real wasm inside the real worker.js, bridged into the real
   wrapper.js, whose sessions drive the real audio-view.js on a fake
   AudioContext with a test-controlled clock. This is the layer between the
   worker tests (which accept any chunk position) and the scheduler test
   (whose fake session emits chunks starting exactly at zero): a primed
   aac track reports its first chunk slightly late, and the run start of
   the audio view must still begin the playback there.

   What is verified:

     - playStream of a real mp4 schedules the source chain (the regression:
       the priming gap left the run waiting forever in perfect silence)
     - the run starts at the stream origin with contiguous sources
     - the playhead advances with the clock; pause and resume work mid-stream
     - the batch path (audio.play with a whole-file buffer) still starts

   The sample is the Sintel trailer, cached in /tmp/opencode/sample.mp4.

   Run: node dev/tests/audio-view-integration.cjs */

const fs = require('node:fs');
const {
  loadAudioView,
  loadWrapper,
  makeAudioViewWorld,
  makeFile,
  makeWav,
  settle
} = require('./harness.cjs');

const SAMPLE = '/tmp/opencode/sample.mp4';

/* ----------------------------------------------------------------------- run */

const run = async () => {
  let bytes;
  try {
    bytes = new Uint8Array(fs.readFileSync(SAMPLE));
  }
  catch (e) {
    console.log('sample missing (' + e.message + '); download it first:');
    console.log('  curl -sL -o ' + SAMPLE + ' "https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4"');
    process.exit(2);
  }

  // the wrapper and the audio view share one context, exactly like the
  // shared AudioContext of the wrapper in a browser
  const world = makeAudioViewWorld();
  const decoder = loadWrapper({
    AudioContext: class {
      constructor() {
        return world.context;
      }
    }
  });
  const ctx = loadAudioView({decoder, world});
  const el = new ctx.AudioViewClass();
  el.connectedCallback();

  /* a real mp4 through the whole chain: the demuxer picks the aac stream,
     the decode window fills chunk by chunk and the run must start although
     the first samples of the track sit a fraction behind position zero */
  await el.playStream({file: makeFile(bytes)});

  // the open resolved; the window fills through the real worker round trips
  await settle(1000);

  if (!el.stream || el.stream.duration == null || el.stream.duration < 50) {
    throw Error('the stream did not open: ' + JSON.stringify(el.stream && {
      duration: el.stream.duration
    }));
  }
  if (!el.stream.chunks.length) {
    throw Error('no chunks were decoded into the window');
  }
  if (!world.scheduled.length) {
    throw Error('the run never started: ' + world.scheduled.length +
      ' sources scheduled for ' + el.stream.chunks.length + ' chunks (the priming gap)');
  }

  // the chain starts at the stream origin and is contiguous
  const first = world.scheduled[0].started;
  if (first.offset !== 0) {
    throw Error('the first source starts at a chunk offset of ' + first.offset);
  }
  for (let i = 1; i < world.scheduled.length; i += 1) {
    const prev = world.scheduled[i - 1].started;
    const cur = world.scheduled[i].started;
    if (Math.abs(cur.when - (prev.when + 1)) > 0.01) {
      throw Error('source ' + i + ' is not chained: ' + JSON.stringify({prev, cur}));
    }
  }
  if (world.events.indexOf('loadedmetadata') === -1 || world.events.indexOf('play') === -1) {
    throw Error('the metadata and play events did not fire: ' + JSON.stringify(world.events));
  }

  // the playhead follows the fake clock
  world.tick(1500);
  if (Math.abs(el.currentTime - 1.45) > 0.05) {
    throw Error('the playhead is at ' + el.currentTime + ' after 1.5s');
  }

  // a pause mid-stream and a resume inside the decoded window
  el.pause();
  const pausedAt = el.currentTime;
  world.scheduled.length = 0;
  el.play();
  await settle(300);
  if (!world.scheduled.length) {
    throw Error('the resume did not restart the run');
  }
  console.log('mp4 stream ok:', el.stream.chunks.length, 'chunks in the window,',
    world.scheduled.length, 'sources, resumed at', pausedAt.toFixed(2));

  /* the batch path of the same element: a small whole-file decode still
     starts through start() */
  const wav = makeWav(3);
  world.scheduled.length = 0;
  world.events.length = 0;
  el.play(wav.buffer.slice(0));
  await settle(3000);

  if (!el.audioBuffer || el.audioBuffer.length !== 3 * 44100) {
    throw Error('the batch decode did not produce the audio buffer: ' +
      JSON.stringify(el.audioBuffer && el.audioBuffer.length));
  }
  if (world.scheduled.length !== 1) {
    throw Error('the batch playback scheduled ' + world.scheduled.length + ' sources');
  }
  if (world.events.indexOf('play') === -1) {
    throw Error('the batch playback did not dispatch play: ' + JSON.stringify(world.events));
  }
  console.log('batch regression ok:', el.audioBuffer.length, 'samples');

  console.log('AUDIO-VIEW INTEGRATION TEST PASSED');
};

run().catch(e => {
  console.error('AUDIO-VIEW INTEGRATION TEST FAILED:', e.message);
  process.exit(1);
});
