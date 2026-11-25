/* Node test: the bring-to-front handler of the real v2/worker.js against a
   fake chrome API. What is verified:

     - a focused window is left alone and answered without an update
     - an unfocused window is focused
     - a minimized window is restored first (state 'normal') and focused
       afterwards; focusing alone does not raise a minimized window
     - a maximized window keeps its shape and is only focused
     - a player hosted in a tab activates the tab and focuses its window
     - a message without a window and without a tab is answered without any
       window update
     - an unknown window (already closed) is answered without an update
     - a window manager that refuses the focus gets a drawAttention update
       instead, so the player is at least highlighted
     - the answer of a windowed bring-to-front is asynchronous, so a sender
       can wait for the visible window

   Run: node dev/tests/worker-front.cjs */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WORKER = path.resolve(__dirname, '../../v2/worker.js');

/* a minimal synchronous chrome stub; only the calls that worker.js makes
   are implemented, and the optional FAQ block is turned off with webdriver.
   `refuseFocus` emulates a window manager that ignores the focus requests
   (the restore of a minimized window still works there) */
const makeWorld = ({refuseFocus = false} = {}) => {
  const windows = new Map();
  const windowUpdates = [];
  const tabUpdates = [];
  const pageMessages = [];

  const chrome = {
    runtime: {
      lastError: undefined,
      onInstalled: {addListener: () => {}},
      onStartup: {addListener: () => {}},
      onMessage: {addListener: fn => pageMessages.push(fn)},
      sendMessage: () => {}
    },
    action: {
      onClicked: {addListener: () => {}}
    },
    storage: {
      local: {
        get: defaults => Promise.resolve({...defaults}),
        set: () => {}
      },
      onChanged: {
        addListener: () => {}
      }
    },
    contextMenus: {
      removeAll: callback => callback(),
      create: (props, callback) => callback(),
      onClicked: {addListener: () => {}}
    },
    tabs: {
      update: (id, props, callback) => {
        tabUpdates.push({id, props});
        if (callback) {
          callback();
        }
      }
    },
    windows: {
      // a missing window rejects like the real API
      get: windowId => {
        const win = windows.get(windowId);
        return win ? Promise.resolve({...win}) : Promise.reject(Error('NO_WINDOW'));
      },
      update: (windowId, props) => {
        windowUpdates.push({windowId, props});
        const win = windows.get(windowId);
        if (win && (refuseFocus === false || props.focused !== true)) {
          Object.assign(win, props);
        }
        return Promise.resolve(win && {...win});
      }
    }
  };

  const context = {
    chrome,
    console,
    navigator: {webdriver: true}
  };
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(WORKER, 'utf8'), vm.createContext(context));

  return {chrome, windows, windowUpdates, tabUpdates, pageMessages};
};

const must = (condition, message) => {
  if (condition === false) {
    throw Error(message);
  }
};

/* let the promise chain of the message handler run to its end */
const settle = async () => {
  await new Promise(resolve => setImmediate(resolve));
};

const run = async () => {
  const world = makeWorld();

  const listener = world.pageMessages[0];
  must(listener, 'no message listener was registered');

  /* a focused window stays as it is; the answer is marked asynchronous so
     that a waiting sender cannot give up too early */
  world.windows.set(1, {id: 1, focused: true, state: 'normal'});
  let answered;
  const keepOpen = listener({method: 'bring-to-front', windowId: 1}, {},
    response => answered = response);
  await settle();
  must(answered === true, 'the focused window was not answered');
  must(world.windowUpdates.length === 0, 'the focused window was updated');
  must(keepOpen === true, 'the bring-to-front answer is not marked asynchronous');

  // an unfocused window is focused in place
  world.windows.set(2, {id: 2, focused: false, state: 'normal'});
  answered = undefined;
  listener({method: 'bring-to-front', windowId: 2}, {},
    response => answered = response);
  await settle();
  must(answered === true, 'the unfocused window was not answered');
  must(world.windowUpdates.length === 1 &&
    world.windowUpdates[0].windowId === 2 &&
    world.windowUpdates[0].props.focused === true &&
    world.windowUpdates[0].props.state === undefined,
  'the unfocused window was not focused in place');

  /* a minimized window is restored first and focused afterwards; the two
     updates are separate because a combined one is refused in places */
  world.windows.set(3, {id: 3, focused: false, state: 'minimized'});
  answered = undefined;
  listener({method: 'bring-to-front', windowId: 3}, {},
    response => answered = response);
  await settle();
  must(answered === true, 'the minimized window was not answered');
  must(world.windowUpdates.length === 3 &&
    world.windowUpdates[1].props.state === 'normal' &&
    world.windowUpdates[2].props.focused === true &&
    world.windowUpdates[2].props.state === undefined,
  'the minimized window was not restored before the focus');
  must(world.windows.get(3).state === 'normal' && world.windows.get(3).focused === true,
    'the minimized window did not end up visible and focused');

  // a maximized window keeps its shape
  world.windows.set(4, {id: 4, focused: false, state: 'maximized'});
  listener({method: 'bring-to-front', windowId: 4}, {}, () => {});
  await settle();
  must(world.windowUpdates[3].props.state === undefined &&
    world.windowUpdates[3].props.focused === true,
  'the maximized window lost its shape');
  must(world.windows.get(4).state === 'maximized', 'the maximized state was reset');

  // a player hosted in a tab activates the tab and focuses its window
  world.windows.set(5, {id: 5, focused: false, state: 'normal'});
  listener({method: 'bring-to-front'}, {tab: {id: 9, windowId: 5}}, () => {});
  await settle();
  must(world.tabUpdates.length === 1 && world.tabUpdates[0].id === 9 &&
    world.tabUpdates[0].props.selected === true,
  'the tab of the player was not activated');
  must(world.windowUpdates[4].windowId === 5 &&
    world.windowUpdates[4].props.focused === true,
  'the window of the tabbed player was not focused');

  // no window and no tab: answered without any window update
  const before = world.windowUpdates.length;
  answered = undefined;
  const syncAnswer = listener({method: 'bring-to-front'}, {},
    response => answered = response);
  await settle();
  must(answered === true, 'the windowless message was not answered');
  must(syncAnswer === undefined, 'the windowless answer is not synchronous');
  must(world.windowUpdates.length === before, 'the windowless message updated a window');

  // an unknown window (already closed) is answered without an update
  answered = undefined;
  listener({method: 'bring-to-front', windowId: 99}, {},
    response => answered = response);
  await settle();
  must(answered === true, 'the unknown window was not answered');
  must(world.windowUpdates.length === before, 'the unknown window was updated');

  /* a window manager that refuses the focus gets the attention request;
     the minimized restore still worked there, so the window is at least
     visible again */
  const refused = makeWorld({refuseFocus: true});
  const listener2 = refused.pageMessages[0];

  refused.windows.set(6, {id: 6, focused: false, state: 'normal'});
  answered = undefined;
  listener2({method: 'bring-to-front', windowId: 6}, {},
    response => answered = response);
  await settle();
  must(answered === true, 'the refusing window manager was not answered');
  must(refused.windowUpdates.length === 2 &&
    refused.windowUpdates[0].props.focused === true &&
    refused.windowUpdates[1].props.drawAttention === true,
  'the refused focus did not fall back to the attention request');

  refused.windows.set(7, {id: 7, focused: false, state: 'minimized'});
  listener2({method: 'bring-to-front', windowId: 7}, {}, () => {});
  await settle();
  must(refused.windowUpdates[2].props.state === 'normal' &&
    refused.windowUpdates[3].props.focused === true &&
    refused.windowUpdates[4].props.drawAttention === true,
  'the restored window was not highlighted after the refused focus');
  must(refused.windows.get(7).state === 'normal',
    'the minimized window stayed minimized under the refusing manager');

  console.log('WORKER-FRONT TEST PASSED');
};

run().catch(e => {
  console.error('WORKER-FRONT TEST FAILED:', e.message);
  process.exit(1);
});
