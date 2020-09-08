/* global drag */
drag.onDrag(files => {
  console.log(files);

  document.querySelector('iframe').contentWindow.postMessage({
    method: 'drop',
    files
  }, '*');
});

window.addEventListener('message', e => {
  if (e.data.method === 'set-title') {
    document.title = e.data.title;
  }
  else if (e.data.method === 'dblclick') {
    document.dispatchEvent(new Event('dblclick'));
  }
});

chrome.runtime.connect({
  name: 'player'
});
