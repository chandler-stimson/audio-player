/* global drag */
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

const play = () => {
  const i = audio.i || 0;
  previous.setAttribute('disabled', i === 0);
  next.setAttribute('disabled', i >= audio.files.length - 1);

  const reader = new FileReader();
  reader.onload = () => {
    audio.file.count = (audio.file.count || 0) + 1;
    audio.play(reader.result);
    title();
  };
  reader.readAsArrayBuffer(audio.file);
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
previous.addEventListener('click', () => navigate('backward', true));
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

chrome.runtime.connect({
  name: 'player'
});

drag.onDrag(files => {
  audio.i = 0;
  audio.files = files;

  if (audio.files.length) {
    play();
    audio.focus();
  }
});
