/* Node test: the toolbar context menu of the real worker.js against a fake
   chrome API. What is verified:

     - the player-mode submenu defaults to the current view
     - the mode radios persist their choice in the local storage
     - a new player window follows the selected mode and its height
       preferences (200 and 600 by default)
     - the remember and skip radios moved under their own Settings submenus
     - the mode choice does not open a window by itself
     - preference changes rebuild the action menus so the options page cannot
       leave their checkmarks behind

   Run: node dev/tests/worker-menu.cjs */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WORKER = path.resolve(__dirname, '../../v2/worker.js');

/* a minimal synchronous chrome stub; only the calls that worker.js makes are
   implemented, and the optional FAQ block is turned off with webdriver */
const makeWorld = () => {
  const store = new Map();
  const menus = [];
  const created = [];
  const tabsCreated = [];
  const installed = [];
  const startup = [];
  const actionClicks = [];
  const menuClicks = [];
  const pageMessages = [];
  const windowUpdates = [];
  const storageChanges = [];
  const messages = [];
  let messageResponse;

  const chrome = {
    runtime: {
      lastError: undefined,
      onInstalled: {addListener: fn => installed.push(fn)},
      onStartup: {addListener: fn => startup.push(fn)},
      onMessage: {addListener: fn => pageMessages.push(fn)},
      sendMessage: (message, callback) => {
        messages.push(message);
        if (callback) {
          callback(messageResponse);
        }
      },
      setUninstallURL: () => {}
    },
    action: {
      onClicked: {addListener: fn => actionClicks.push(fn)}
    },
    storage: {
      local: {
        get: (defaults, callback) => {
          const prefs = {};
          for (const [key, value] of Object.entries(defaults)) {
            prefs[key] = store.has(key) ? store.get(key) : value;
          }
          if (callback) {
            callback(prefs);
            return;
          }
          return Promise.resolve(prefs);
        },
        set: prefs => {
          for (const [key, value] of Object.entries(prefs)) {
            store.set(key, value);
          }
        }
      },
      onChanged: {
        addListener: fn => storageChanges.push(fn)
      }
    },
    contextMenus: {
      removeAll: callback => {
        menus.length = 0;
        callback();
      },
      create: (props, callback) => {
        menus.push(props);
        callback();
      },
      onClicked: {addListener: fn => menuClicks.push(fn)}
    },
    windows: {
      getCurrent: callback => callback({left: 100, top: 50, width: 1000, height: 800}),
      create: props => created.push(props),
      update: (windowId, props) => windowUpdates.push({windowId, props})
    },
    tabs: {
      create: props => tabsCreated.push(props),
      update: () => {}
    }
  };

  const world = {
    chrome,
    menus,
    created,
    tabsCreated,
    installed,
    startup,
    actionClicks,
    menuClicks,
    pageMessages,
    windowUpdates,
    storageChanges,
    messages,
    store,
    respond: value => messageResponse = value
  };
  const context = {
    chrome,
    console,
    navigator: {webdriver: true}
  };
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(WORKER, 'utf8'), vm.createContext(context));

  return world;
};

const must = (condition, message) => {
  if (condition === false) {
    throw Error(message);
  }
};

const menuById = world => {
  const byId = {};
  for (const menu of world.menus) {
    byId[menu.id] = menu;
  }
  return byId;
};

/* let the promise chain of an async message handler run to its end */
const settle = async () => {
  await new Promise(resolve => setImmediate(resolve));
};

const run = async () => {
  const world = makeWorld();

  must(world.installed.length === 1, 'no install menu builder was registered');
  must(world.startup.length === 1, 'no startup menu builder was registered');
  await world.installed[0]();

  let byId = menuById(world);
  must(byId['settings'].title === 'Settings', 'the settings parent is missing');
  must(byId['open-player'].parentId === 'settings', 'the player-mode menu is not inside Settings');
  must(byId['open-player'].title === 'Open Player', 'the player-mode parent is missing');
  must(byId['open-player-current'].parentId === 'open-player', 'the compact mode is not in the submenu');
  must(byId['open-player-current'].title === 'Compact Mode', 'the compact mode kept its old name');
  must(byId['open-player-extended'].parentId === 'open-player', 'the extended mode is not in the submenu');
  must(byId['open-player-current'].checked === true, 'the compact mode is not the default');
  must(byId['open-player-extended'].checked === false, 'the extended mode is on by default');

  /* the two radio groups live in their own submenus, so the separator of the
     flat layout is gone */
  const rememberIds = ['remember-10', 'remember-30', 'remember-60', 'remember-none'];
  for (const id of rememberIds) {
    must(byId[id].parentId === 'settings-remember', id + ' is not in the remember submenu');
  }
  const skipIds = ['skip-5', 'skip-10', 'skip-30', 'skip-60', 'skip-1/60', 'skip-1/30', 'skip-1/10'];
  for (const id of skipIds) {
    must(byId[id].parentId === 'settings-skip', id + ' is not in the skip submenu');
  }
  must(byId['settings-separator'] === undefined, 'the old flat separator survived');

  /* the compact mode launches with the default height preference; the Tab
     object of the action click must not leak into the player URL */
  world.actionClicks[0]({id: 1});
  must(world.created.length === 1, 'the default action click did not open a player');
  must(world.created[0].width === 600, 'the default player width changed');
  must(world.created[0].height === 120, 'the compact mode does not use its default height');
  must(world.created[0].left === 300, 'the default player left is wrong');
  must(world.created[0].top === 390, 'the default player top is wrong');
  must(world.created[0].url === 'data/player/index.html', 'the action click polluted the player URL');

  /* selecting a mode only stores the preference; the selection itself must
     not open another window */
  world.menuClicks[0]({menuItemId: 'open-player-extended'}, {});
  must(world.store.get('extended-view') === true, 'the extended mode was not stored');
  must(world.created.length === 1, 'selecting a mode opened a player by itself');

  world.actionClicks[0]();
  must(world.created.length === 2, 'the extended action click did not open a player');
  must(world.created[1].height === 600, 'the extended mode does not use its default height');
  must(world.created[1].top === 150, 'the extended player is not centered vertically');
  must(world.created[1].url === 'data/player/index.html', 'the extended player URL is wrong');

  /* both heights are preferences; the saved values override the defaults.
     the left position is not a preference anymore: the window is centered
     inside the current browser window (100 + (1000 - 600) / 2) */
  world.menuClicks[0]({menuItemId: 'open-player-current'}, {});
  must(world.store.get('extended-view') === false, 'the compact mode was not stored');
  for (const [key, value] of Object.entries({
    width: 600,
    height: 240,
    'extended-height': 650
  })) {
    world.store.set(key, value);
  }
  world.actionClicks[0]();
  must(world.created[2].width === 600, 'the compact mode ignored the saved width');
  must(world.created[2].height === 240, 'the compact mode ignored the saved height');
  must(world.created[2].left === 300, 'the compact mode is not centered horizontally');
  must(world.created[2].top === 330, 'the current player is not centered vertically');

  world.menuClicks[0]({menuItemId: 'open-player-extended'}, {});
  world.actionClicks[0]();
  must(world.created[3].width === 600, 'the extended mode dropped the saved width');
  must(world.created[3].height === 650, 'the extended mode ignored its preference');
  must(world.created[3].left === 300, 'the extended mode is not centered horizontally');
  must(world.created[3].top === 125, 'the extended player is not centered vertically');

  /* a damaged or old preference cannot make the extended view shorter than
     the normal view */
  world.store.set('height', 400);
  world.store.set('extended-height', 300);
  world.actionClicks[0]();
  must(world.created[4].height === 400, 'the extended mode fell below the normal height');
  world.store.set('height', 240);
  world.store.set('extended-height', 650);

  /* the checkmarks of the rebuilt menu follow the stored mode and the
     skip radios keep writing their old preference */
  world.menuClicks[0]({menuItemId: 'skip-30'}, {});
  must(world.store.get('skip-period') === 30, 'the skip radio stopped storing its preference');
  await world.startup[0]();
  byId = menuById(world);
  must(byId['open-player-current'].checked === false, 'the rebuilt menu lost the extended mode');
  must(byId['open-player-extended'].checked === true, 'the rebuilt menu lost the extended checkmark');
  must(byId['skip-30'].checked === true, 'the rebuilt skip menu lost its selection');

  /* the options page saves through the storage area; the menu listener
     rebuilds the radios from the new value */
  must(world.storageChanges.length === 2, 'the worker did not register its storage listeners');
  world.store.set('extended-view', false);
  world.storageChanges[0]({'extended-view': {newValue: false}}, 'local');
  await settle();
  byId = menuById(world);
  must(byId['open-player-current'].checked === true, 'the options-page mode did not refresh the menu');
  must(byId['open-player-extended'].checked === false, 'the stale extended checkmark survived');

  /* the compact player asks the worker to grow its window to the extended
     height; the answer keeps the fire-and-forget sender from rejecting */
  world.store.set('height', 700);
  let expandResponse;
  world.pageMessages[0]({method: 'expand'}, {
    tab: {windowId: 77}
  }, response => expandResponse = response);
  await settle();
  must(expandResponse === true, 'the expand message was not answered');
  must(world.windowUpdates.length === 1, 'the expand message did not resize the window');
  must(world.windowUpdates[0].windowId === 77, 'the expand message resized the wrong window');
  must(world.windowUpdates[0].props.height === 700, 'the expand message used the wrong height');

  /* an open player answers the ping, so another action click only focuses it
     instead of opening a second window */
  world.respond(true);
  world.actionClicks[0]();
  must(world.created.length === 5, 'an open player was launched a second time');

  console.log('WORKER MENU TEST PASSED');
};

run().catch(e => {
  console.error('WORKER MENU TEST FAILED:', e.message);
  process.exit(1);
});
