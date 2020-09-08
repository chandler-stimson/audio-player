'use strict';

const audio = document.getElementById('audio');
Object.defineProperty(audio, 'file', {
  get() {
    return audio.files ? audio.files[audio.i || 0] : undefined;
  }
});
const next = document.getElementById('next');
const previous = document.getElementById('previous');

const meta = (m = {}) => {
  document.getElementById('codec-name').textContent = m['Codec Long Name'] || '-';
  document.getElementById('sample-rate').textContent = m['Sample Rate'] || '-';
  document.getElementById('sample-size').textContent = m['Sample Size'] || '-';
  document.getElementById('avcodec-version').textContent = m['LIBAVCODEC Version'] || '-';
  document.getElementById('avformat-version').textContent = m['LIBAVFORMAT Version'] || '-';
};

const title = (msg = '') => {
  if (msg) {
    document.title = msg;
  }
  else if (audio.files) {
    document.title = msg || `[${audio.i + 1}/${audio.files.length}] ` + audio.file.name + ' :: Audio Player';
  }
  else {
    document.title = 'Audio Player';
  }
  parent.postMessage({
    method: 'set-title',
    title: document.title
  }, '*');
};

const play = () => {
  const i = audio.i || 0;
  previous.setAttribute('disabled', i === 0);
  next.setAttribute('disabled', i >= audio.files.length - 1);

  const reader = new FileReader();
  reader.onload = () => {
    audio.play(reader.result);
    title();
  };
  reader.readAsArrayBuffer(audio.file);
};

previous.addEventListener('click', () => {
  audio.i = Math.max(0, (audio.i || 0) - 1);
  play();
});
next.addEventListener('click', () => {
  audio.i = Math.min(audio.files.length - 1, (audio.i || 0) + 1);
  play();
});
{
  let id;
  audio.addEventListener('play', () => {
    clearTimeout(id);
  });
  const m = () => {
    meta();
    id = setTimeout(() => {
      if (next.getAttribute('disabled') === 'false') {
        next.dispatchEvent(new Event('click'));
      }
    }, 500);
  };
  audio.addEventListener('error', e => {
    console.error(e);
    alert(e.detail);
    m();
  });
  audio.addEventListener('ended', () => m());
}
audio.addEventListener('loadedmetadata', () => meta(audio.meta));

document.addEventListener('click', () => {
  audio.focus();
});

document.addEventListener('dragover', e => {
  parent.postMessage({
    method: 'drag-over'
  }, '*');
  e.preventDefault();
});
document.addEventListener('dblclick', () => parent.postMessage({
  method: 'dblclick'
}, '*'));

window.addEventListener('message', e => {
  if (e.data.method === 'drop') {
    audio.i = 0;
    audio.files = e.data.files;

    if (audio.files.length) {
      play();
      audio.focus();
    }
  }
});

{
  let cid;
  audio.addEventListener('volumechange', () => {
    title('Volume Level: ' + (audio.volume * 100).toFixed(0) + '%');
    clearTimeout(cid);
    cid = setTimeout(() => title(), 1000);
  });
}
