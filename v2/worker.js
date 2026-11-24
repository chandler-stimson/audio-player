const click = (extra = '') => {
  chrome.runtime.sendMessage({
    method: 'ping'
  }, a => {
    chrome.runtime.lastError;

    if (a === undefined) {
      chrome.windows.getCurrent(win => {
        chrome.storage.local.get({
          width: 500,
          height: 120,
          left: win.left + Math.round((win.width - 500) / 2),
          top: win.top + Math.round((win.height - 80) / 2)
        }, prefs => {
          chrome.windows.create({
            ...prefs,
            url: 'data/player/index.html' + (extra ? '?' + extra : ''),
            type: 'popup'
          });
        });
      });
    }
  });
};
chrome.action.onClicked.addListener(click);

chrome.runtime.onMessage.addListener((request, sender) => {
  if (request.method === 'bring-to-front') {
    const tab = sender.tab;
    chrome.tabs.update(tab.id, {
      selected: true
    });
    chrome.windows.update(tab.windowId, {
      focused: true
    });
  }
});

// context menu
{
  const once = async () => {
    const prefs = await chrome.storage.local.get({
      'remember-tracks': 10,
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

      // settings for the tracks that the player remembers between sessions
      chrome.contextMenus.create({
        id: 'settings',
        contexts: ['action'],
        title: 'Settings'
      }, () => chrome.runtime.lastError);
      for (const c of [10, 20, 30]) {
        chrome.contextMenus.create({
          id: 'remember-' + c,
          parentId: 'settings',
          contexts: ['action'],
          title: 'Remember Last ' + c + ' Tracks',
          type: 'radio',
          checked: prefs['remember-tracks'] === c
        }, () => chrome.runtime.lastError);
      }
      chrome.contextMenus.create({
        id: 'remember-none',
        parentId: 'settings',
        contexts: ['action'],
        title: 'Do Not Remember Tracks',
        type: 'radio',
        checked: prefs['remember-tracks'] === 0
      }, () => chrome.runtime.lastError);

      // settings for the size of the forward and backward skips of the
      // player; the separator keeps the two radio groups apart
      chrome.contextMenus.create({
        id: 'settings-separator',
        parentId: 'settings',
        contexts: ['action'],
        type: 'separator'
      }, () => chrome.runtime.lastError);
      for (const s of [5, 10, 30, 60]) {
        chrome.contextMenus.create({
          id: 'skip-' + s,
          parentId: 'settings',
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
          parentId: 'settings',
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
}

/* the remembered tracks are stored by the player page in IndexedDB; shrink
   or clear them here so that a reduced preference is effective even when the
   player window is closed */
const enforce = async n => {
  try {
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

    const t = database.transaction('tracks', 'readwrite');
    const os = t.objectStore('tracks');
    t.onabort = () => console.warn('CANNOT_ENFORCE_TRACKS', t.error);
    if (n === 0) {
      os.clear();
    }
    else {
      const req = os.get('list');
      req.onsuccess = () => {
        const record = req.result;
        if (record && record.list && record.list.length > n) {
          os.put({
            list: record.list.slice(-n)
          }, 'list');
        }
      };
    }
  }
  catch (e) {
    console.warn('CANNOT_ENFORCE_TRACKS', e);
  }
};

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
  else if (info.menuItemId.startsWith('remember-')) {
    const n = info.menuItemId === 'remember-none' ? 0 :
      Number(info.menuItemId.replace('remember-', ''));
    chrome.storage.local.set({
      'remember-tracks': n
    });
    enforce(n);
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
