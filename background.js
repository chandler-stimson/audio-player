const ports = [];
chrome.runtime.onConnect.addListener(port => {
  ports.push(port);
  port.onDisconnect.addListener(() => {
    const i = ports.indexOf(port);
    ports.splice(i, 1);
  });
});
chrome.browserAction.onClicked.addListener(() => {
  if (ports.length) {
    const tab = ports[0].sender.tab;
    chrome.tabs.update(tab.id, {
      selected: true
    });
    chrome.windows.update(tab.windowId, {
      focused: true
    });
  }
  else {
    chrome.storage.local.get({
      width: 500,
      height: 80,
      left: screen.availLeft + Math.round((screen.availWidth - 500) / 2),
      top: screen.availTop + Math.round((screen.availHeight - 80) / 2)
    }, prefs => {
      chrome.windows.create({
        ...prefs,
        url: chrome.extension.getURL('data/player/index.html'),
        type: 'popup'
      });
    });
  }
});
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
            tabs.create({
              url: page + '?version=' + version + (previousVersion ? '&p=' + previousVersion : '') + '&type=' + reason,
              active: reason === 'install'
            });
            storage.local.set({'last-update': Date.now()});
          }
        }
      }));
    });
    setUninstallURL(page + '?rd=feedback&name=' + encodeURIComponent(name) + '&version=' + version);
  }
}
