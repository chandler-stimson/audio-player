/* global drag, launchQueue */
'use strict';

const args = new URLSearchParams(location.search);

const audio = document.getElementById('audio');
Object.defineProperty(audio, 'file', {
  get() {
    return audio.files ? audio.files[audio.i || 0] : undefined;
  }
});
const next = document.getElementById('next');
const previous = document.getElementById('previous');

if (isNaN(localStorage.volume) === false) {
  audio.volume = Number(localStorage.getItem('volume'));
}

const meta = (m = {}) => {
  document.getElementById('codec-name').textContent = m['Codec Long Name'] || '-';
  document.getElementById('sample-rate').textContent = audio.audioBuffer.sampleRate;
  document.getElementById('sample-size').textContent = m['Sample Size'] || '4';
  document.getElementById('number-of-channels').textContent = audio.audioBuffer.numberOfChannels;
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
};

const get = (href, progress) => {
  if (href.startsWith('filesystem:')) { // fetch does not work with this scheme
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', href, true);
      xhr.responseType = 'arraybuffer';

      xhr.onprogress = e => {
        if (e.lengthComputable) {
          progress(e.loaded, e.total);
        }
      };

      xhr.onreadystatechange = () => {
        if (xhr.readyState === 4) {
          if (xhr.status === 200) {
            resolve(xhr.response);
          }
          else {
            reject(xhr.status);
          }
        }
      };
      xhr.send();
    });
  }
  else {
    return fetch(href).then(response => {
      const contentLength = response.headers.get('Content-Length');
      const total = parseInt(contentLength, 10);
      let loaded = 0;

      const reader = response.body.getReader();
      const segments = [];

      return new Promise((resolve, reject) => {
        function read() {
          reader.read().then(({done, value}) => {
            if (done) {
              new Blob(segments.map(s => s.buffer)).arrayBuffer().then(resolve);
              return;
            }

            loaded += value.length;
            progress(loaded, total);
            segments.push(value);

            read();
          }).catch(reject);
        }
        read();
      });
    });
  }
};

const format = (bytes, decimals) => {
  if (bytes == 0) {
    return '0 Bytes';
  }
  const k = 1024;
  const dm = decimals || 2;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

const play = () => {
  const i = audio.i || 0;

  document.getElementById('view').selectedIndex = i + 1;

  previous.setAttribute('disabled', i === 0);
  next.setAttribute('disabled', i >= audio.files.length - 1);

  const done = buffer => {
    audio.file.count = (audio.file.count || 0) + 1;
    audio.play(buffer).catch(e => {
      document.title = (e.message || e);
      console.error(e);
    });
    title();
  };

  if (audio.file) {
    if (audio.file.href) {
      get(audio.file.href, (s, m) => {
        let msg = 'Buffering ';

        msg += format(s, 1);

        if (m) {
          msg += ' / ' + format(m, 1);
          msg += ' [' + (s / m * 100).toFixed(1) + '%]';
        }
        document.title = msg + '...';
      }).then(done).catch(e => alert(e.message));
    }
    else {
      const reader = new FileReader();
      reader.onload = () => {
        done(reader.result);
      };
      reader.readAsArrayBuffer(audio.file);
    }
  }
};

document.getElementById('view').onchange = e => {
  const n = e.target.selectedIndex;

  if (n > 0 && audio.i + 1 !== n) {
    audio.i = n - 1;
    play();
  }
};

const navigate = (direction = 'forward', forced = false) => {
  const shuffle = document.getElementById('shuffle').getAttribute('active') === 'true';

  if (shuffle) {
    const min = Math.min(...audio.files.map(f => f.count || 0));
    const mc = audio.files.filter(f => (f.count || 0) === min).length;
    const files = [...audio.files].sort((a, b) => {
      const ac = a.count || 0;
      const bc = b.count || 0;

      if (ac === min && bc === min) {
        return Math.random() - 0.5;
      }

      return ac - bc;
    });

    const repeat = document.getElementById('repeat').getAttribute('mode');
    // all files are already played
    if (mc === audio.files.length) {
      if (repeat === 'repeat' || forced) {
        audio.i = audio.files.indexOf(files[0]);
        play();
      }
    }
    else {
      audio.i = audio.files.indexOf(files[0]);
      play();
    }
  }
  else {
    audio.i = Math.max(0, (audio.i || 0) + (direction === 'forward' ? 1 : -1));
    play();
  }
};
previous.addEventListener('click', e => {
  if (e.shiftKey) {
    audio.currentTime = 0;
  }
  else {
    navigate('backward', true);
  }
});
next.addEventListener('click', () => navigate('forward', true));

{
  let id;
  audio.addEventListener('play', () => {
    clearTimeout(id);
  });
  const m = () => {
    meta();
    id = setTimeout(() => {
      const repeat = document.getElementById('repeat').getAttribute('mode');
      if (repeat === 'repeat-one') {
        play();
      }
      else {
        const shuffle = document.getElementById('shuffle').getAttribute('active') === 'true';
        if (shuffle) {
          navigate('forward');
        }
        else {
          if (repeat === 'no-repeat' && next.getAttribute('disabled') === 'false') {
            navigate('forward');
          }
          else if (repeat === 'repeat' && audio.i === audio.files.length - 1) {
            audio.i = 0;
            play();
          }
          else if (repeat === 'repeat') {
            navigate('forward');
          }
        }
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

{
  let cid;
  audio.addEventListener('volumechange', () => {
    title('Volume Level: ' + (audio.volume * 100).toFixed(0) + '%');
    localStorage.setItem('volume', audio.volume);
    clearTimeout(cid);
    cid = setTimeout(() => title(), 1000);
  });
}

// repeat
{
  const repeat = document.getElementById('repeat');
  repeat.addEventListener('click', () => {
    const mode = repeat.getAttribute('mode');
    const modes = ['no-repeat', 'repeat', 'repeat-one'];
    repeat.setAttribute('mode', modes[(modes.indexOf(mode) + 1) % 3]);
  });
}

// shuffle
{
  const shuffle = document.getElementById('shuffle');
  shuffle.addEventListener('click', () => {
    const active = shuffle.getAttribute('active');
    shuffle.setAttribute('active', active === 'false');
  });
}

const add = files => {
  audio.i = audio.i || 0;
  audio.files = audio.files || [];

  if (audio.files.length && files.length) {
    audio.i += 1;
  }

  const view = document.getElementById('view');
  for (const file of files) {
    const n = audio.files.push(file);

    view.option([
      {name: file.name},
      {name: file.href}
    ], file.name, n, false).insert();
  }

  if (audio.files.length) {
    play();
    audio.focus();
  }
};

drag.onDrag(add);
chrome.runtime.onMessage.addListener((request, sender, response) => {
  if (request.method === 'jobs') {
    add(request.jobs);
    response(true);
    chrome.runtime.sendMessage({
      method: 'bring-to-front'
    });
  }
  else if (request.method === 'ping') {
    response('pong');
    chrome.runtime.sendMessage({
      method: 'bring-to-front'
    });
  }
});
if (args.has('json')) {
  setTimeout(() => {
    const jobs = JSON.parse(args.get('json'));
    add(jobs);
  }, 0);
}

launchQueue.setConsumer(async launchParams => {
  if (!launchParams.files || !launchParams.files.length) {
    return;
  }
  const files = [];
  for (const fileHandle of launchParams.files) {
    const file = await fileHandle.getFile();
    files.push(file);
  }
  add(files);
});
