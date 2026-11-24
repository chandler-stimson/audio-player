/* Node test: the real volume-view.js inside the shared DOM stub.

   - the level of the icon: a cross at zero volume, one wave up to 100% and
     a second wave in the boosted range above it
   - the clamp of the accepted range
   - a slider click: the volume follows the position and the change is
     reported to the host
   - the mute toggle: the icon click mutes and the second click restores
     the remembered level
   - the audio view funnel: a programmatic set reflects into the view and
     reports to the host exactly once (no loop through the view)

   Run: node dev/tests/volume-view.cjs */

const {loadVolumeView, makeAudioViewWorld, loadAudioView} = require('./harness.cjs');

const boot = () => {
  const {VolumeViewClass, elements, events} = loadVolumeView();
  const view = new VolumeViewClass();
  view.connectedCallback();
  return {view, elements, events};
};

const run = async () => {
  /* the icon level follows the volume */
  {
    const {view, elements} = boot();
    const levels = [
      [0, 'mute'],
      [0.5, 'low'],
      [1, 'low'],
      [1.5, 'high'],
      [2, 'high']
    ];
    for (const [v, level] of levels) {
      view.volume = v;
      if (elements.icon.attributes.level !== level) {
        throw Error('volume ' + v + ' shows level ' + elements.icon.attributes.level +
          ' instead of ' + level);
      }
      if (Math.abs(view.volume - v) > 0.001) {
        throw Error('volume ' + v + ' reads back ' + view.volume);
      }
    }
    // the range clamps on both ends
    view.volume = 5;
    if (view.volume !== 2 || elements.icon.attributes.level !== 'high') {
      throw Error('the upper clamp left the volume at ' + view.volume);
    }
    view.volume = -1;
    if (view.volume !== 0 || elements.icon.attributes.level !== 'mute') {
      throw Error('the lower clamp left the volume at ' + view.volume);
    }
    console.log('levels ok: mute / low / high with the clamp');
  }

  /* a slider click reports the new volume */
  {
    const {view, elements} = boot();
    const reported = [];
    view.addEventListener('volumechange', e => reported.push(e.detail));
    elements.sound.handlers.seek({detail: 75}); // 75% of the slider = 150%
    if (view.volume !== 1.5 || elements.icon.attributes.level !== 'high') {
      throw Error('the slider click left the volume at ' + view.volume);
    }
    if (reported.length !== 1 || reported[0] !== 1.5) {
      throw Error('the slider click reported ' + JSON.stringify(reported));
    }
    console.log('slider ok: 75% of the slider reports volume 1.5');
  }

  /* the mute toggle: the icon click mutes and the second click restores */
  {
    const {view, elements} = boot();
    const reported = [];
    view.addEventListener('volumechange', e => reported.push(e.detail));
    view.volume = 1.5;
    elements.icon.handlers.click();
    if (view.volume !== 0 || elements.icon.attributes.level !== 'mute') {
      throw Error('the toggle did not mute: ' + view.volume);
    }
    elements.icon.handlers.click();
    if (view.volume !== 1.5 || elements.icon.attributes.level !== 'high') {
      throw Error('the toggle did not restore 1.5: ' + view.volume);
    }
    // a toggle that starts at zero restores the remembered level too
    view.volume = 0;
    elements.icon.handlers.click();
    if (view.volume !== 1.5 || elements.icon.attributes.level !== 'high') {
      throw Error('the mute at zero restored ' + view.volume);
    }
    if (reported.join(',') !== '0,1.5,1.5') {
      throw Error('the toggle reported ' + JSON.stringify(reported));
    }
    console.log('toggle ok: mute, restore 1.5 and the zero-start restore');
  }

  /* the audio view funnel: the host reflects into the view, reports once
     and re-enters on a change that started in the view */
  {
    const world = makeAudioViewWorld();
    const decoder = {context: () => world.context};
    const ctx = loadAudioView({decoder, world});
    const el = new ctx.AudioViewClass();
    el.connectedCallback();
    const volumeView = el.shadowRoot.getElementById('volume');

    el.volume = 1.7;
    if (volumeView.volume !== 1.7 || el.volume !== 1.7) {
      throw Error('the host set left the view at ' + volumeView.volume +
        ' and reads back ' + el.volume);
    }
    // the report of the host fires exactly once; the silent reflect of the
    // view cannot loop it back
    let reported = 0;
    el.addEventListener('volumechange', () => reported += 1);
    el.volume = 0.8;
    if (reported !== 1) {
      throw Error('the host reported ' + reported + ' times');
    }
    // a change that started in the view re-enters the funnel of the host
    volumeView.handlers.volumechange({detail: 0.3});
    if (volumeView.volume !== 0.3 || el.volume !== 0.3) {
      throw Error('the funnel did not re-enter: view ' + volumeView.volume +
        ', host ' + el.volume);
    }
    if (reported !== 2) {
      throw Error('the funnel reported ' + reported + ' times');
    }
    console.log('funnel ok: reflect, one report and the re-enter');
  }

  console.log('VOLUME-VIEW TEST PASSED');
};

run().catch(e => {
  console.error('VOLUME-VIEW TEST FAILED:', e.message);
  process.exit(1);
});
