const click = (extra = '') => {
  chrome.runtime.sendMessage({
    method: 'ping'
  }, a => {
    chrome.runtime.lastError;

    if (a === undefined) {
      chrome.windows.getCurrent(win => {
        chrome.storage.local.get({
          width: 500,
          height: 80,
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
  const once = () => {
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
  };
  chrome.runtime.onInstalled.addListener(once);
  chrome.runtime.onStartup.addListener(once);
}

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
