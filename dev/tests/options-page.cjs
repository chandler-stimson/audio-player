/* Node test: the options page of the extension. The real
   v2/data/options/index.js runs against a fake DOM and chrome storage. What
   is verified:

     - the manifest registers the page as a full-tab options UI
     - the page loads every default of the toolbar action preferences
     - a valid submission stores the heights, player mode, remember count and
       skip period
     - the extended height cannot be saved below the player height
     - a numeric skip is stored as a number and a fraction as a string
     - an invalid submission keeps the stored values and reports the form

   Run: node dev/tests/options-page.cjs */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const MANIFEST = path.join(ROOT, 'v2/manifest.json');
const OPTIONS = path.join(ROOT, 'v2/data/options/index.js');
const OPTIONS_HTML = path.join(ROOT, 'v2/data/options/index.html');

const makeElement = (id = '') => ({
  id,
  value: '',
  checked: false,
  textContent: '',
  listeners: {},
  valid: true,
  reported: 0,
  customValidity: '',
  ariaInvalid: 'false',

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  },
  dispatch(type, e = {}) {
    for (const fn of (this.listeners[type] || []).slice()) {
      fn(e);
    }
  },
  setCustomValidity(message) {
    this.customValidity = message;
  },
  setAttribute(name, value) {
    if (name === 'aria-invalid') {
      this.ariaInvalid = value;
    }
  },
  checkValidity() {
    return this.valid;
  },
  reportValidity() {
    this.reported += 1;
  }
});

const makeWorld = () => {
  const store = new Map();
  const saved = [];
  const elements = new Map();
  const element = id => {
    if (elements.has(id) === false) {
      elements.set(id, makeElement(id));
    }
    return elements.get(id);
  };

  const chrome = {
    storage: {
      local: {
        async get(defaults) {
          const prefs = {};
          for (const [key, value] of Object.entries(defaults)) {
            prefs[key] = store.has(key) ? store.get(key) : value;
          }
          return prefs;
        },
        async set(prefs) {
          saved.push(prefs);
          for (const [key, value] of Object.entries(prefs)) {
            store.set(key, value);
          }
        }
      }
    }
  };
  const document = {
    getElementById: element
  };

  const world = {
    chrome,
    document,
    element,
    store,
    saved,
    get form() {
      return element('preferences');
    },
    get status() {
      return element('status');
    }
  };
  const context = {
    chrome,
    document,
    console
  };
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(OPTIONS, 'utf8'), vm.createContext(context), {
    filename: OPTIONS
  });

  return world;
};

const must = (condition, message) => {
  if (condition === false) {
    throw Error(message);
  }
};

const settle = async () => {
  await new Promise(resolve => setImmediate(resolve));
};

const run = async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  must(manifest.options_ui.page === '/data/options/index.html', 'the options page is not registered');
  must(manifest.options_ui.open_in_tab === true, 'the options page does not open in a tab');

  const html = fs.readFileSync(OPTIONS_HTML, 'utf8');
  const ids = [
    'height',
    'extended-height',
    'open-player-current',
    'open-player-extended',
    'remember-10',
    'remember-20',
    'remember-30',
    'remember-none',
    'skip-period'
  ];
  for (const id of ids) {
    must(html.includes('id="' + id + '"'), 'the options page is missing the ' + id + ' control');
  }
  must(html.includes('id="extended-height-rule"'), 'the extended-height rule is missing');
  must(html.includes('min="120"'), 'the player height minimum is not 120');
  must(html.includes('>Compact Mode<'), 'the options page did not use the Compact Mode name');
  must(html.includes('>Current Mode<') === false, 'the old Current Mode name survived');

  const world = makeWorld();
  await settle();

  must(world.element('height').value === 120, 'the default height is not 120');
  must(world.element('extended-height').value === 600, 'the default extended height is not 600');
  must(world.element('open-player-current').checked === true, 'the compact mode is not the default');
  must(world.element('open-player-extended').checked === false, 'the extended mode is on by default');
  must(world.element('remember-10').checked === true, 'ten remembered tracks is not the default');
  must(world.element('remember-20').checked === false, 'twenty remembered tracks is on by default');
  must(world.element('remember-30').checked === false, 'thirty remembered tracks is on by default');
  must(world.element('remember-none').checked === false, 'no remembered tracks is on by default');
  must(world.element('skip-period').value === '10', 'ten-second skips is not the default');

  world.element('height').value = '240';
  world.element('extended-height').value = '650';
  world.element('open-player-current').checked = false;
  world.element('open-player-extended').checked = true;
  world.element('remember-10').checked = false;
  world.element('remember-20').checked = true;
  world.element('skip-period').value = '30';
  world.status.textContent = 'Preferences saved.';
  world.form.dispatch('input');
  must(world.status.textContent === '', 'an edit did not retire the old save report');

  world.form.dispatch('submit', {preventDefault() {}});
  await settle();
  must(world.store.get('height') === 240, 'the height preference was not saved');
  must(world.store.get('extended-height') === 650, 'the extended height preference was not saved');
  must(world.store.get('extended-view') === true, 'the player mode was not saved');
  must(world.store.get('remember-tracks') === 20, 'the remember count was not saved');
  must(world.store.get('skip-period') === 30, 'the numeric skip was not saved as a number');
  must(world.status.textContent === 'Preferences saved.', 'the options page did not report the save');

  world.element('skip-period').value = '1/30';
  world.form.dispatch('submit', {preventDefault() {}});
  await settle();
  must(world.store.get('skip-period') === '1/30', 'the fraction skip was not saved as a string');

  world.element('extended-height').value = '200';
  world.form.dispatch('submit', {preventDefault() {}});
  await settle();
  must(world.store.get('extended-height') === 650, 'a short extended height changed the stored preference');
  must(world.element('extended-height').customValidity !== '', 'the short extended height was not rejected');
  must(world.element('extended-height').ariaInvalid === 'true', 'the short extended height was not marked invalid');
  must(world.saved.length === 2, 'a short extended height saved the preferences');

  world.form.dispatch('input');
  must(world.element('extended-height').customValidity === '', 'an edit did not clear the comparison error');
  must(world.element('extended-height').ariaInvalid === 'false', 'an edit did not clear the invalid state');

  world.form.valid = false;
  world.element('height').value = '';
  world.form.dispatch('submit', {preventDefault() {}});
  await settle();
  must(world.store.get('height') === 240, 'an invalid height changed the stored preference');
  must(world.form.reported === 2, 'the invalid forms were not reported');
  must(world.saved.length === 2, 'an invalid submission saved the preferences');

  console.log('OPTIONS PAGE TEST PASSED');
};

run().catch(e => {
  console.error('OPTIONS PAGE TEST FAILED:', e.message);
  process.exit(1);
});
