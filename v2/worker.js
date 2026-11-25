/* the width of a newly opened player; the options page can store a wider
   or narrower choice that overrides this default */
const DEFAULT_WIDTH = 600;

const click = (extra = '') => {
  chrome.runtime.sendMessage({
    method: 'ping'
  }, a => {
    chrome.runtime.lastError;

    if (a === undefined) {
      chrome.windows.getCurrent(win => {
        chrome.storage.local.get({
          'extended-view': false,
          height: 120,
          'extended-height': 600,
          width: DEFAULT_WIDTH
        }, prefs => {
          const extended = prefs['extended-view'];
          /* the extended view is never shorter than the normal view, even
             when an old or damaged preference says otherwise */
          const height = extended ?
            Math.max(prefs['extended-height'], prefs.height) :
            prefs.height;

          /* the selected width centers the window inside the current
             browser window */
          const left = win.left + Math.round((win.width - prefs.width) / 2);

          /* the selected height centers the window inside the current
             browser window; a height taller than the browser window stays
             at its top instead of moving off-screen */
          const top = Math.max(win.top, win.top + Math.round((win.height - height) / 2));

          chrome.windows.create({
            width: prefs.width,
            height,
            left,
            top,
            url: 'data/player/index.html' + (extra ? '?' + extra : ''),
            type: 'popup'
          });
        });
      });
    }
  });
};
/* the click event passes its Tab object as the first argument; the object
   must not leak into `extra` and end up as the ?[object Object] query of
   the player URL */
chrome.action.onClicked.addListener(() => click());

chrome.runtime.onMessage.addListener((request, sender, response) => {
  if (request.method === 'bring-to-front') {
    // the answer keeps the promise of the fire-and-forget sender from
    // rejecting; the focus updates below still run on their own
    response(true);
    /* the player page passes the ID of its own window because extension
       pages do not report a sender.tab; a player hosted in a tab falls
       back to the window of that tab */
    const tab = sender.tab;
    const windowId = request.windowId !== undefined ?
      request.windowId : tab && tab.windowId;
    if (windowId !== undefined) {
      if (tab && tab.id !== undefined) {
        chrome.tabs.update(tab.id, {
          selected: true
        });
      }
      chrome.windows.update(windowId, {
        focused: true
      });
    }
  }
  else if (request.method === 'expand') {
    // the compact player asks for the height of the extended view
    response(true);
    const windowId = request.windowId !== undefined ?
      request.windowId : sender.tab && sender.tab.windowId;
    if (windowId === undefined) {
      return;
    }
    (async () => {
      const prefs = await chrome.storage.local.get({
        height: 120,
        'extended-height': 600
      });
      await chrome.windows.update(windowId, {
        // the extended view can never be shorter than the normal view
        height: Math.max(prefs['extended-height'], prefs.height)
      });
    })().catch(e => console.warn('CANNOT_EXPAND_PLAYER', e));
  }
});

// context menu
{
  const once = async () => {
    // the 20-track choice is no longer offered; map an old stored choice to
    // the new default so that the menus and the player agree on the value
    const migrated = await chrome.storage.local.get({'remember-tracks': 30});
    if (migrated['remember-tracks'] === 20) {
      await chrome.storage.local.set({'remember-tracks': 30});
    }

    const prefs = await chrome.storage.local.get({
      'extended-view': false,
      'remember-tracks': 30,
      'skip-period': 10
    });

    // remove the previous menus so that the radio checkmarks are refreshed
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'play-audio',
        contexts: ['audio', 'video'],
        title: 'Play this Audio'
      }, () => chrome.runtime.lastError);
      chrome.contextMenus.create({
        id: 'samples',
        contexts: ['action'],
        title: 'Test Audio'
      }, () => chrome.runtime.lastError);
      chrome.contextMenus.create({
        title: 'Play this Audio',
        id: 'play-link',
        contexts: ['link'],
        targetUrlPatterns: [
          'avi', 'mp4', 'webm', 'flv', 'mov', 'ogv', '3gp', 'mpg', 'wmv', 'swf', 'mkv',
          'pcm', 'wav', 'aac', 'ogg', 'wma', 'flac', 'mid', 'mka', 'm4a', 'voc', 'mp3'
        ].map(a => '*://*/*.' + a)
      }, () => chrome.runtime.lastError);

      // every preference that the toolbar action menu can change
      chrome.contextMenus.create({
        id: 'settings',
        contexts: ['action'],
        title: 'Settings'
      }, () => chrome.runtime.lastError);

      // the mode of the window that a new player opens in
      chrome.contextMenus.create({
        id: 'open-player',
        parentId: 'settings',
        contexts: ['action'],
        title: 'Open Player'
      }, () => chrome.runtime.lastError);
      chrome.contextMenus.create({
        id: 'open-player-current',
        parentId: 'open-player',
        contexts: ['action'],
        title: 'Compact Mode',
        type: 'radio',
        checked: prefs['extended-view'] === false
      }, () => chrome.runtime.lastError);
      chrome.contextMenus.create({
        id: 'open-player-extended',
        parentId: 'open-player',
        contexts: ['action'],
        title: 'Extended View',
        type: 'radio',
        checked: prefs['extended-view'] === true
      }, () => chrome.runtime.lastError);

      // settings for the tracks that the player remembers between sessions
      chrome.contextMenus.create({
        id: 'settings-remember',
        parentId: 'settings',
        contexts: ['action'],
        title: 'Remember Tracks'
      }, () => chrome.runtime.lastError);
      for (const c of [10, 30, 60]) {
        chrome.contextMenus.create({
          id: 'remember-' + c,
          parentId: 'settings-remember',
          contexts: ['action'],
          title: 'Remember Last ' + c + ' Tracks',
          type: 'radio',
          checked: prefs['remember-tracks'] === c
        }, () => chrome.runtime.lastError);
      }
      chrome.contextMenus.create({
        id: 'remember-none',
        parentId: 'settings-remember',
        contexts: ['action'],
        title: 'Do Not Remember Tracks',
        type: 'radio',
        checked: prefs['remember-tracks'] === 0
      }, () => chrome.runtime.lastError);

      // settings for the size of the forward and backward skips of the player
      chrome.contextMenus.create({
        id: 'settings-skip',
        parentId: 'settings',
        contexts: ['action'],
        title: 'Skip Period'
      }, () => chrome.runtime.lastError);
      for (const s of [5, 10, 30, 60]) {
        chrome.contextMenus.create({
          id: 'skip-' + s,
          parentId: 'settings-skip',
          contexts: ['action'],
          title: 'Skip ' + s + ' Seconds',
          type: 'radio',
          checked: prefs['skip-period'] === s
        }, () => chrome.runtime.lastError);
      }
      // a fraction of the length scales the skip with the track itself
      for (const f of [60, 30, 10]) {
        chrome.contextMenus.create({
          id: 'skip-1/' + f,
          parentId: 'settings-skip',
          contexts: ['action'],
          title: 'Skip 1/' + f + ' of Length',
          type: 'radio',
          checked: prefs['skip-period'] === '1/' + f
        }, () => chrome.runtime.lastError);
      }
    });
  };
  chrome.runtime.onInstalled.addListener(once);
  chrome.runtime.onStartup.addListener(once);

  /* the options page writes the same preferences; rebuild the menus so
     their radio checkmarks cannot fall behind the stored choices */
  chrome.storage.onChanged.addListener((prefs, area) => {
    if (area === 'local' && (
      prefs['extended-view'] || prefs['remember-tracks'] || prefs['skip-period']
    )) {
      once();
    }
  });
}

/* two records describe the same track when they point to the same link or
   the same local file; a stored handle is a fresh structured clone, so only
   `isSameEntry` can compare it with another handle; the player page compares
   its records the same way */
const same = async (a, b) => {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === 'file') {
    try {
      return await a.handle.isSameEntry(b.handle);
    }
    catch (e) {
      return false;
    }
  }
  return a.href === b.href;
};

/* the remembered tracks are stored by the player page in IndexedDB; shrink
   or clear them here so that a reduced preference is effective even when
   the player window is closed */
const enforce = async n => {
  try {
    /* the player page saves and trims its tracks under the same lock, so
       the shrink below cannot interleave with a save and be undone by it */
    await navigator.locks.request('audio-player-tracks', async () => {
      const r = indexedDB.open('audio-player', 1);
      // use the same schema as the player page
      r.onupgradeneeded = () => {
        if (r.result.objectStoreNames.contains('tracks') === false) {
          r.result.createObjectStore('tracks');
        }
      };
      const database = await new Promise((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      if (database.objectStoreNames.contains('tracks') === false) {
        return;
      }

      if (n === 0) {
        await new Promise((resolve, reject) => {
          const t = database.transaction('tracks', 'readwrite');
          t.objectStore('tracks').clear();
          t.oncomplete = () => resolve();
          t.onabort = () => reject(t.error || Error('ABORTED'));
        });
        return;
      }

      /* the record of the playing track is dropped when its track is
         trimmed out, just like the player page drops it; `isSameEntry`
         cannot run inside a transaction because the await commits it, so
         the keys are read first and the survivors are written back
         afterwards while the lock keeps the other writers out */
      const stored = await new Promise((resolve, reject) => {
        const t = database.transaction('tracks', 'readonly');
        const os = t.objectStore('tracks');
        const list = os.get('list');
        const current = os.get('current');
        t.oncomplete = () => resolve({
          list: (list.result && list.result.list) || [],
          current: current.result || null
        });
        t.onabort = () => reject(t.error || Error('ABORTED'));
      });
      if (stored.list.length <= n) {
        return;
      }
      const kept = stored.list.slice(-n);

      let found = false;
      if (stored.current) {
        for (const record of kept) {
          if (await same(stored.current, record)) {
            found = true;
            break;
          }
        }
      }

      await new Promise((resolve, reject) => {
        const t = database.transaction('tracks', 'readwrite');
        const os = t.objectStore('tracks');
        os.put({list: kept}, 'list');
        if (stored.current && found === false) {
          os.delete('current');
        }
        t.oncomplete = () => resolve();
        t.onabort = () => reject(t.error || Error('ABORTED'));
      });
    });
  }
  catch (e) {
    console.warn('CANNOT_ENFORCE_TRACKS', e);
  }
};

/* the options page and the context menu both write the preference; shrinking
   the remembered tracks from either place keeps the stored history in sync */
chrome.storage.onChanged.addListener((prefs, area) => {
  const change = prefs['remember-tracks'];
  if (area === 'local' && change && change.newValue !== undefined) {
    enforce(change.newValue);
  }
});

const send = jobs => chrome.runtime.sendMessage({
  method: 'jobs',
  jobs
}, r => {
  chrome.runtime.lastError;
  if (r !== true) {
    click('json=' + encodeURIComponent(JSON.stringify(jobs)));
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'play-link' || info.menuItemId === 'play-audio') {
    const jobs = [{
      href: info.srcUrl || info.linkUrl,
      name: tab.title
    }];
    send(jobs);
  }
  else if (info.menuItemId === 'samples') {
    chrome.tabs.create({
      url: 'https://webbrowsertools.com/audio-test/'
    });
  }
  else if (info.menuItemId === 'open-player-current' || info.menuItemId === 'open-player-extended') {
    // the choice only sets the mode of the windows opened afterwards
    chrome.storage.local.set({
      'extended-view': info.menuItemId === 'open-player-extended'
    });
  }
  else if (info.menuItemId.startsWith('remember-')) {
    const n = info.menuItemId === 'remember-none' ? 0 :
      Number(info.menuItemId.replace('remember-', ''));
    chrome.storage.local.set({
      'remember-tracks': n
    });
  }
  else if (info.menuItemId.startsWith('skip-')) {
    const v = info.menuItemId.replace('skip-', '');
    // a plain number is seconds; a fraction scales with the track length
    chrome.storage.local.set({
      'skip-period': v.includes('/') ? v : Number(v)
    });
  }
});

/* file handling */
if (chrome.fileBrowserHandler) {
  chrome.fileBrowserHandler.onExecute.addListener((id, details) => {
    if (id === 'open-media') {
      const entries = details.entries;
      send(entries.map(e => ({
        name: e.name,
        href: e.toURL()
      })));
    }
  });
}

/* FAQs & Feedback */
{
  const {management, runtime: {onInstalled, setUninstallURL, getManifest}, storage, tabs} = chrome;
  if (navigator.webdriver !== true) {
    const page = getManifest().homepage_url;
    const {name, version} = getManifest();
    onInstalled.addListener(({reason, previousVersion}) => {
      management.getSelf(({installType}) => installType === 'normal' && storage.local.get({
        'faqs': true,
        'last-update': 0
      }, prefs => {
        if (reason === 'install' || (prefs.faqs && reason === 'update')) {
          const doUpdate = (Date.now() - prefs['last-update']) / 1000 / 60 / 60 / 24 > 45;
          if (doUpdate && previousVersion !== version) {
            tabs.query({active: true, currentWindow: true}, tbs => tabs.create({
              url: page + '?version=' + version + (previousVersion ? '&p=' + previousVersion : '') + '&type=' + reason,
              active: reason === 'install',
              ...(tbs && tbs.length && {index: tbs[0].index + 1})
            }));
            storage.local.set({'last-update': Date.now()});
          }
        }
      }));
    });
    setUninstallURL(page + '?rd=feedback&name=' + encodeURIComponent(name) + '&version=' + version);
  }
}
