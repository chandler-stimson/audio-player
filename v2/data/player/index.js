/* global drag, launchQueue, decoder, remember, htime */
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

/* the placeholder explains an empty playlist; every mutation that changes the
   number of tracks calls this so the instruction cannot fall behind */
const playlistEmpty = document.getElementById('playlist-empty');
const updatePlaylistEmpty = () => {
  playlistEmpty.hidden = Boolean(audio.files && audio.files.length);
};
updatePlaylistEmpty();

/* the volume of the last session; a missing entry reads as null, which the
   numeric test alone would otherwise treat as a stored zero */
{
  const saved = localStorage.getItem('volume');
  if (saved !== null && isNaN(saved) === false) {
    audio.volume = Number(saved);
  }
}

/* the tooltip wording of the skip preference; a number is a plain period of
   seconds and a fraction scales with the length of the loaded track */
const skipWord = n => {
  if (typeof n === 'number') {
    return [n + ' Seconds', n * 3 + ' Seconds'];
  }
  const [a, b] = n.split('/');
  return [a + '/' + b + ' of the Length', a * 3 + '/' + b + ' of the Length'];
};

/* reflect the stored skip preference into the player; a change of it applies
   to an open player right away */
const applySkip = n => {
  audio.skipPeriod = n;

  // the tooltips and the accessible names follow the preference
  const [one, long] = skipWord(n);
  audio.shadowRoot.getElementById('progress').title =
    'Use Arrow Left/Right to seek ' + one.toLowerCase() + ' backward/forward' + '\n' +
    'Use Meta + Arrow Left/Right to seek ' + long.toLowerCase() + ' backward/forward';
  const back = document.getElementById('skip-back');
  const forward = document.getElementById('skip-forward');
  back.title = 'Skip ' + one + ' Backward (J)';
  forward.title = 'Skip ' + one + ' Forward (L)';
  back.setAttribute('aria-label', 'Skip ' + one + ' Backward (J)');
  forward.setAttribute('aria-label', 'Skip ' + one + ' Forward (L)');
};
chrome.storage.local.get({
  'skip-period': 10
}).then(prefs => applySkip(prefs['skip-period']));
chrome.storage.onChanged.addListener((prefs, area) => {
  if (area === 'local' && prefs['skip-period']) {
    applySkip(prefs['skip-period'].newValue);
  }
});

/* the inline shortcut of the compact view; the browser owns the window, so
   the worker is the one that changes its height */
document.getElementById('expand').addEventListener('click', () => {
  chrome.runtime.sendMessage({
    method: 'expand'
  }, () => chrome.runtime.lastError);
});

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

/* the inline report of a track that cannot be played; a failed decode stops
   the playback and its reason stays in the report until the user dismisses
   it or another track starts */
const errorView = document.getElementById('error');
const showError = msg => {
  document.getElementById('error-text').textContent = msg;
  errorView.hidden = false;
};
document.getElementById('error-close').addEventListener('click', () => {
  errorView.hidden = true;
  title();
});

const get = (href, progress, limit) => {
  if (href.startsWith('filesystem:')) { // fetch does not work with this scheme
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', href, true);
      xhr.responseType = 'arraybuffer';

      xhr.onprogress = e => {
        if (progress && e.lengthComputable) {
          progress(e.loaded, e.total);
        }
        if (limit && e.lengthComputable && e.total > limit) {
          xhr.abort();
          reject(Error('TOO_LARGE'));
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
              // pass the typed-array views to the Blob; a chunk buffer can be
              // larger than the portion that was actually read
              new Blob(segments).arrayBuffer().then(resolve);
              return;
            }

            loaded += value.length;
            if (progress) {
              progress(loaded, total);
            }
            if (limit && loaded > limit) {
              reader.cancel().catch(() => {}).then(() => reject(Error('TOO_LARGE')));
              return;
            }
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

/* decoded-result cache; enables instant track transitions */
const cache = new Map();
const CACHE_LIMIT = 256 * 1024 * 1024;   // max bytes of decoded PCM to keep
const PREFETCH_LIMIT = 16 * 1024 * 1024; // do not prefetch inputs bigger than this
/* inputs above this size (and every network track) are decoded incrementally:
   their bytes are read on demand and only a window around the playhead is
   kept decoded, so a large input never hangs the player */
const STREAM_LIMIT = PREFETCH_LIMIT;

const decodedBytes = decoded => {
  const b = decoded.audioBuffer;
  return b.length * b.numberOfChannels * 4;
};

const cacheSet = (file, decoded) => {
  if (decodedBytes(decoded) > CACHE_LIMIT) {
    return; // a single entry that does not fit; never evict others for it
  }
  cache.delete(file);
  cache.set(file, decoded); // the most recent entry is always last

  let bytes = 0;
  for (const d of cache.values()) {
    bytes += decodedBytes(d);
  }
  // evict the least recently used entries
  for (const f of cache.keys()) {
    if (bytes <= CACHE_LIMIT || f === file) {
      break;
    }
    bytes -= decodedBytes(cache.get(f));
    cache.delete(f);
  }
};

/* the track that follows the current one in linear mode */
const nextFile = () => {
  const files = audio.files || [];
  const n = (audio.i || 0) + 1;
  if (n < files.length) {
    return files[n];
  }
  const repeat = document.getElementById('repeat').getAttribute('mode');
  return (repeat === 'repeat' && files.length) ? files[0] : null;
};

/* decode the next track in the background while the current one is playing */
let prefetching = null;
const prefetch = () => {
  const shuffle = document.getElementById('shuffle').getAttribute('active') === 'true';
  const file = shuffle ? null : nextFile();

  if (!file || file === audio.file || cache.has(file)) {
    return;
  }
  // a locked track is not readable until its read permission is granted
  if (file.locked) {
    return;
  }
  // decoding a very large input in the background costs more (CPU and memory)
  // than the transition it would save
  if (file.size && file.size > PREFETCH_LIMIT) {
    return;
  }

  prefetching = file;

  // the size limit keeps a background prefetch from downloading inputs that
  // would cost more to decode than the transition it would save
  const input = file.href ? get(file.href, undefined, PREFETCH_LIMIT) : new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });

  input.then(arrayBuffer => decoder.decode({
    name: 'input',
    arrayBuffer,
    owner: 'prefetch'
  })).then(decoded => {
    if (prefetching === file) {
      cacheSet(file, decoded);
    }
  }).catch(() => {}).finally(() => {
    if (prefetching === file) {
      prefetching = null;
    }
  });
};

const done = (file, action) => {
  file.count = (file.count || 0) + 1;
  action().catch(e => {
    document.title = (e.message || e);
    console.error(e);
  });
  title();
};

/* serialize every playlist mutation; the identity checks of the additions
   await real filesystem calls, so two mutations in flight would otherwise
   interleave their index arithmetic on the shared playlist (the queue never
   rejects, so one failed mutation cannot block the rest) */
let mutating = Promise.resolve();
const serialize = job => {
  mutating = mutating.then(job).catch(e => console.warn('CANNOT_MUTATE_PLAYLIST', e));
  return mutating;
};

/* a remembered local track is listed before its read permission is granted;
   ask for the permission and replace the locked entry with the readable
   file; the row is found again by its entry because the playlist can change
   while the permission prompt is open; -1 is returned when the row was
   removed in the meantime */
const unlock = async file => {
  let state;
  try {
    state = await file.handle.requestPermission({mode: 'read'});
  }
  catch (e) {
    // the permission prompt requires a user action; the automatic
    // advancement and the synthetic key events cannot provide one
    throw Error('Cannot ask for the read permission of "' + file.name + '" without a user action.');
  }
  if (state !== 'granted') {
    throw Error('The read permission for "' + file.name + '" was denied.');
  }

  const real = await file.handle.getFile();
  real.handle = file.handle;

  // the replacement is a playlist mutation as well, so it goes through the
  // queue; a row that was removed in the meantime is not written back
  return serialize(() => {
    const i = audio.files ? audio.files.indexOf(file) : -1;
    if (i !== -1) {
      const cleanup = file.cleanup;
      audio.files[i] = real;

      // the replacement owns the row from here on, so it inherits the row
      // cleanup and is normalized before any later mutation can delete it
      if (cleanup) {
        real.cleanup = cleanup;
        cleanup();
      }
    }
    return i;
  });
};

/* the read permission of a locked track cannot be asked for without a user
   action; the automatic advancement pauses on the grant dialog and its
   Grant button provides the action that the prompt of the browser needs */
const grantJob = {
  file: null
};

const askAccess = (file, e) => {
  grantJob.file = file;

  const grant = document.getElementById('grant');
  document.getElementById('grant-body').textContent =
    'The local track "' + file.name + '" needs its read access back. The browser clears the ' +
    'remembered permission of a local file after each restart.';
  const status = document.getElementById('grant-status');
  status.textContent = e.message || e;
  status.hidden = false;

  // the player is already silent (the selection retired the old track
  // before the permission was asked for); an open dialog of another locked
  // track must not be shown again
  if (grant.open === false) {
    grant.showModal();
  }
  title('Read access needed: ' + file.name);
};

/* the pending automatic advancement of the track that just ended; loading
   any other track or resetting the player cancels it */
let advance;

const play = () => {
  // the track that the user selects cancels the advancement that the track
  // that just ended scheduled; a slow decode can no longer let it fire
  clearTimeout(advance);

  // starting a track retires the error report of the previous one
  errorView.hidden = true;

  const i = audio.i || 0;

  document.getElementById('view').selectedIndex = i + 1;

  previous.disabled = i === 0;
  next.disabled = i >= audio.files.length - 1;

  const file = audio.file;
  if (!file) {
    return;
  }

  /* the selected track is not playable until its load ends: the read
     permission of a locked track must be granted first and a small local
     file must be read first; retiring the track that is playing now keeps
     a slow or failed load from leaving it running */
  decoder.cancel('user');
  audio.reset();
  audio.session = Math.random();

  // the selected track is the one that the next launch selects
  remember.current(file);

  // a remembered local track needs its read permission before it can be
  // decoded; selecting the track provides the gesture for the prompt
  if (file.locked) {
    unlock(file).then(j => {
      // the row was removed while the permission was being asked for
      if (j === -1) {
        return;
      }
      // the track was not switched while the permission was being asked for
      if ((audio.i || 0) === j) {
        play();
      }
    }).catch(e => askAccess(file, e));
    return;
  }

  // stop background decodes for tracks that are no longer next
  if (prefetching && prefetching !== file) {
    prefetching = null;
    decoder.cancel('prefetch');
  }

  const cached = cache.get(file);
  if (cached) {
    // any decode that is still running belongs to a previous track
    decoder.cancel('user');
    return done(file, () => audio.playDecoded(cached));
  }

  // a large local track and every network track decode incrementally: the
  // input is never read as a whole and only a window around the playhead
  // stays decoded
  if (file.href) {
    return done(file, () => audio.playStream({href: file.href}));
  }
  if (file.size && file.size > STREAM_LIMIT) {
    return done(file, () => audio.playStream({file}));
  }

  // a small local file keeps the whole-file path: its decoded result is
  // cached and the track transitions stay instant
  {
    const reader = new FileReader();
    reader.onload = () => {
      if (audio.file === file) {
        done(file, () => audio.play(reader.result));
      }
    };
    // a failed read is reported like a failed decode; the old playback is
    // already stopped, so the report is the only thing left to do (a read
    // that belongs to a superseded selection stays silent)
    reader.onerror = () => {
      if (audio.file === file) {
        console.error(reader.error);
        title('Cannot play: ' + file.name);
        showError(reader.error.message || reader.error);
      }
    };
    reader.readAsArrayBuffer(file);
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

/* a skip moves inside the current track; the bounds match the arrow keys
   (never past the end, never before the start) */
document.getElementById('skip-back').addEventListener('click', () => {
  if (audio.ready) {
    const shift = audio.skipSeconds;
    if (audio.currentTime - shift > 0) {
      audio.currentTime -= shift;
    }
  }
});
document.getElementById('skip-forward').addEventListener('click', () => {
  if (audio.ready) {
    const shift = audio.skipSeconds;
    if (audio.currentTime + shift < (audio.duration || Infinity)) {
      audio.currentTime += shift;
    }
  }
});

/* the grant dialog; the Grant button provides the user action that the
   permission prompt of the browser needs */
{
  const grant = document.getElementById('grant');
  const status = document.getElementById('grant-status');

  document.getElementById('grant-ok').addEventListener('click', () => {
    const {file} = grantJob;
    // this click is the user action that the prompt needs
    unlock(file).then(i => {
      grant.close();
      // the row was removed while the permission was being asked for
      if (i === -1) {
        return;
      }
      // the track was not switched while the permission was being asked for
      if ((audio.i || 0) === i) {
        play();
      }
    }).catch(e => {
      // the permission was denied; the reason stays in the open dialog
      status.textContent = e.message || e;
      status.hidden = false;
    });
  });

  // the Esc key restores the idle title of the paused player
  grant.addEventListener('cancel', () => title());

  grant.addEventListener('close', () => {
    if (grant.returnValue === 'skip') {
      // the locked track must still be the current one and have a follower
      if ((audio.files || [])[audio.i || 0] === grantJob.file &&
          (audio.i || 0) < audio.files.length - 1) {
        navigate('forward', true);
      }
    }
    else if (grant.returnValue === 'cancel') {
      title();
    }
    // a stale return value must not leak into the next grant request
    grant.returnValue = '';
    grantJob.file = null;
  });
}

{
  audio.addEventListener('play', () => {
    // a start that bypassed play() (the Space key resuming the ended track)
    // cancels the pending advancement as well
    clearTimeout(advance);
    // decode the next track in the background while this one is playing
    prefetch();
  });
  const m = () => {
    const single = audio.files && audio.files.length === 1;
    const repeat = document.getElementById('repeat').getAttribute('mode');

    // instant replay: the decoded buffer of the current track is still in memory
    if ((repeat === 'repeat-one' || (repeat === 'repeat' && single)) && audio.audioBuffer) {
      audio.file.count = (audio.file.count || 0) + 1;
      title();
      audio.play();
      return;
    }

    const cached = (() => {
      if (document.getElementById('shuffle').getAttribute('active') === 'true') {
        return false; // the next track is picked randomly on demand
      }
      const file = nextFile();
      return Boolean(file && cache.has(file));
    })();

    // a repeated ended must not leave an orphaned timer behind
    clearTimeout(advance);
    advance = setTimeout(() => {
      const r = document.getElementById('repeat').getAttribute('mode');
      if (r === 'repeat-one') {
        play();
      }
      else {
        const shuffle = document.getElementById('shuffle').getAttribute('active') === 'true';
        if (shuffle) {
          navigate('forward');
        }
        else {
          if (r === 'no-repeat' && !next.disabled) {
            navigate('forward');
          }
          else if (r === 'repeat' && audio.i === audio.files.length - 1) {
            audio.i = 0;
            play();
          }
          else if (r === 'repeat') {
            navigate('forward');
          }
        }
      }
    }, cached ? 50 : 500);
  };
  audio.addEventListener('error', e => {
    console.error(e);
    // a track that cannot be decoded stops the playback; the advancement
    // logic must not run for a failed track or an unreadable file would be
    // retried (and re-reported) forever; the user picks the next track
    clearTimeout(advance);
    audio.pause();
    title('Cannot play: ' + (audio.file ? audio.file.name : ''));
    showError(e.detail);
  });
  audio.addEventListener('ended', () => m());
}

// the play button and the Space key with nothing loaded start the selected track
audio.addEventListener('empty', () => {
  if (audio.files && audio.files.length) {
    play();
  }
});

/* a click that lands on a real control keeps its focus; a click on
   non-interactive content returns the focus to the host so that the player
   shortcuts stay active */
document.addEventListener('click', () => {
  if (document.activeElement === document.body) {
    audio.focus();
  }
});

// the player keys only reach the audio view while it is focused; a fresh
// window starts with the focus on the body, so the first Space press would
// be lost without this
audio.focus();

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
  // the accessible name reflects the mode; the tooltip keeps the hint
  const word = {
    'no-repeat': 'off',
    'repeat': 'all',
    'repeat-one': 'one'
  };
  const name = () => 'Repeat: ' + word[repeat.getAttribute('mode')] +
    ' (Ctrl/Command + Shift + R)';
  repeat.addEventListener('click', () => {
    const mode = repeat.getAttribute('mode');
    const modes = ['no-repeat', 'repeat', 'repeat-one'];
    repeat.setAttribute('mode', modes[(modes.indexOf(mode) + 1) % 3]);
    repeat.setAttribute('aria-label', name());
  });
}

// shuffle
{
  const shuffle = document.getElementById('shuffle');
  shuffle.addEventListener('click', () => {
    const active = shuffle.getAttribute('active');
    shuffle.setAttribute('active', active === 'false');
    // the pressed state follows so that the styling and the announcement
    // cannot diverge
    shuffle.setAttribute('aria-pressed', active === 'false');
  });
}

/* the playlist context menu; it replaces the fixed metadata panel */
{
  const view = document.getElementById('view');
  const menu = document.getElementById('context-menu');
  const anchor = document.getElementById('menu-anchor');
  const metadata = document.getElementById('metadata');
  const grid = document.getElementById('metadata-grid');
  const status = document.getElementById('metadata-status');

  // the row that the menu was opened for; null when it is the empty area
  let menuFile = null;

  /* the hidden select of the list view mirrors the geometry of the rows; the
     row under a coordinate is the option that contains it */
  const rowAt = y => {
    const select = view.shadowRoot.getElementById('select');
    const top = select.getBoundingClientRect().top;

    for (let i = 1; i < select.options.length; i += 1) { // option 0 is the hidden header
      const o = select.options[i];
      if (y >= top + o.offsetTop && y < top + o.offsetTop + o.offsetHeight) {
        return i - 1;
      }
    }
    return -1;
  };

  const closeMenu = () => {
    if (menu.showPopover) {
      if (menu.matches(':popover-open')) {
        menu.hidePopover();
      }
    }
    else if (menu.style.display === 'block') {
      menu.style.display = 'none';
    }
  };

  const openMenu = (x, y) => {
    const has = audio.files && audio.files.length;

    /* the row is remembered by its entry: the additions and removals of
       the meantime shift the indices, but the entry of the row stays the
       same one */
    menuFile = null;
    if (has) {
      const i = rowAt(y);
      if (i !== -1) {
        menuFile = audio.files[i] || null;
      }
    }
    document.getElementById('play-this').disabled = menuFile === null;
    document.getElementById('delete-this').disabled = menuFile === null;
    document.getElementById('show-metadata').disabled = menuFile === null;
    document.getElementById('delete-all').disabled = !has;

    if (CSS.supports('anchor-name: --a')) {
      // the anchor follows the cursor; the menu flips when there is no room
      anchor.style.left = x + 'px';
      anchor.style.top = y + 'px';
      menu.style.left = '';
      menu.style.top = '';
      menu.showPopover({source: anchor});
    }
    else {
      // the anchor positioning is not supported; position the menu manually
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';
      if (menu.showPopover) {
        menu.showPopover();
      }
      else {
        menu.style.display = 'block';
      }
      // keep the menu inside the window
      const r = menu.getBoundingClientRect();
      if (r.bottom > innerHeight) {
        menu.style.top = Math.max(5, innerHeight - r.height - 5) + 'px';
      }
      if (r.right > innerWidth) {
        menu.style.left = Math.max(5, innerWidth - r.width - 5) + 'px';
      }
    }

    // the focus starts on the first enabled entry
    const b = menu.querySelector('button:not(:disabled)');
    if (b) {
      b.focus();
    }
  };

  document.addEventListener('contextmenu', e => {
    // the menu belongs to the playlist area only
    if (e.composedPath().includes(document.getElementById('playlist')) === false) {
      return;
    }
    e.preventDefault();
    openMenu(e.clientX, e.clientY);
  });

  // the keyboard alternative of the right-click opens the menu on the selected
  // track when the playlist is focused
  document.addEventListener('keydown', e => {
    if (e.code !== 'ContextMenu' && (e.code !== 'F10' || e.shiftKey === false)) {
      return;
    }
    if (document.activeElement !== view) {
      return;
    }
    const i = view.selectedIndex - 1; // the view counts the hidden header row
    if (i < 0) {
      return;
    }
    e.preventDefault();

    const select = view.shadowRoot.getElementById('select');
    const r = select.getBoundingClientRect();
    const o = select.options[i + 1];
    openMenu(r.left + Math.min(r.width - 20, 100), r.top + o.offsetTop + o.offsetHeight / 2);
  });

  // the manual fallback for the browsers without the popover support; the
  // light dismiss is native everywhere else
  document.addEventListener('pointerdown', e => {
    if (!menu.showPopover && menu.style.display === 'block' && menu.contains(e.target) === false) {
      closeMenu();
    }
  });
  document.addEventListener('keydown', e => {
    if (e.code === 'Escape' && !menu.showPopover && menu.style.display === 'block') {
      closeMenu();
    }
  });

  /* render the known information of `file`; `known` describes what is
     decoded already: {audioBuffer, meta, duration} or null while it is
     still unknown */
  const renderMetadata = (file, known) => {
    grid.textContent = '';

    const m = (known && known.meta) || {};
    const b = known && known.audioBuffer;
    const duration = known ? (known.duration || (b ? b.duration : 0)) : 0;
    const row = (label, value) => {
      const l = document.createElement('span');
      l.textContent = label;
      const v = document.createElement('span');
      v.textContent = value;
      grid.append(l, v);
    };

    row('Track', file.name);
    row('Source', file.href || (file.locked ? 'Local File (read permission needed)' : 'Local File'));
    row('Size', file.size ? format(file.size, 1) : '-');
    row('Duration', duration ? htime(duration) : '-');
    row('Codec Name', m['Codec Name'] || '-');
    row('Codec Long Name', m['Codec Long Name'] || '-');
    row('Sample Format', m['Sample Format'] || '-');
    row('Sample Rate', b ? b.sampleRate : (m['Sample Rate'] || '-'));
    row('Sample Size', m['Sample Size'] || '-');
    row('Channels', b ? b.numberOfChannels : (m['Channels'] || '-'));
    row('LIBAVCODEC Version', m['LIBAVCODEC Version'] || '-');
    row('LIBAVFORMAT Version', m['LIBAVFORMAT Version'] || '-');
  };

  /* everything that is known about the current track: its cached decode, or
     the live state of the audio view (a whole-file buffer or a streaming
     window with its demuxed metadata) */
  const knownOf = file => {
    const cached = cache.get(file);
    if (cached) {
      return {
        audioBuffer: cached.audioBuffer,
        meta: cached.meta || {},
        duration: cached.audioBuffer.duration
      };
    }
    if (file === audio.file && (audio.audioBuffer || audio.stream)) {
      return {
        audioBuffer: audio.audioBuffer || null,
        meta: audio.meta || {},
        duration: audio.audioBuffer ? audio.audioBuffer.duration : (audio.stream ? audio.stream.duration : null)
      };
    }
    return null;
  };

  // the open dialog is refreshed when the decode of the current track ends
  audio.addEventListener('loadedmetadata', () => {
    if (metaJob.file === audio.file && metadata.open) {
      renderMetadata(audio.file, knownOf(audio.file));
      status.textContent = '';
      status.hidden = true;
    }
  });

  // closing the dialog stops the on-demand decode that belongs to it
  metadata.addEventListener('close', () => {
    if (metaJob.decoding) {
      metaJob.decoding = false;
      decoder.cancel('meta');
    }
    metaJob.file = null;
    metaJob.token += 1; // a late result can no longer update anything
  });

  // `closedby="any"` is not supported everywhere; dismiss manually there
  if ('closedBy' in HTMLDialogElement.prototype === false) {
    let outside = false;
    const test = e => {
      const r = metadata.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    metadata.addEventListener('pointerdown', e => {
      outside = test(e);
    });
    metadata.addEventListener('pointerup', e => {
      if (outside && test(e)) {
        metadata.close();
      }
    });
  }

  /* show the metadata of the right-clicked track; the codec information of a
     track that was never decoded is fetched with an on-demand decode */
  const showMetadata = async () => {
    const file = menuFile;
    closeMenu();
    if (!file) {
      return;
    }

    let target = file;
    // a locked local track needs its read permission before it can be decoded
    if (file.locked) {
      try {
        const i = await unlock(file);
        // the row was removed while the permission was being asked for
        if (i === -1) {
          return;
        }
        target = audio.files[i];
      }
      catch (e) {
        metaJob.file = file;
        metaJob.token += 1;
        renderMetadata(file, null);
        status.textContent = e.message || e;
        status.hidden = false;
        metadata.showModal();
        return;
      }
    }

    metaJob.file = target;
    metaJob.token += 1;
    const token = metaJob.token;

    const known = knownOf(target);

    renderMetadata(target, known);
    status.textContent = '';
    status.hidden = true;
    metadata.showModal();

    if (known) {
      return; // everything about this track is already known
    }
    if (target === audio.file) {
      // the track is being decoded for the playback; the dialog is refreshed
      // above once its decode finishes
      status.textContent = 'The track is being decoded...';
      status.hidden = false;
      return;
    }

    // a large track or a network track is never read as a whole for its
    // metadata: the streaming demuxer reads the header of the input only
    // and no sample is decoded
    if (target.href || (target.size && target.size > STREAM_LIMIT)) {
      metaJob.decoding = true;
      status.textContent = 'Reading the stream...';
      status.hidden = false;

      try {
        const session = await decoder.open(target.href ? {
          href: target.href,
          owner: 'meta'
        } : {
          file: target,
          owner: 'meta'
        });
        if (metaJob.token !== token) {
          session.close().catch(() => {});
          return;
        }
        metaJob.decoding = false;
        renderMetadata(target, {
          meta: session.meta,
          duration: session.meta['Duration']
        });
        status.textContent = '';
        status.hidden = true;
        session.close().catch(() => {});
      }
      catch (e) {
        metaJob.decoding = false;
        // the dialog was closed or another track was asked for
        if (metaJob.token !== token || e.message === 'CANCELED') {
          return;
        }
        status.textContent = 'Cannot read this track (' + (e.message || e) + ')';
        status.hidden = false;
      }
      return;
    }

    // a small local file is decoded on demand; the `meta` worker never
    // delays a playback and its decoded result is kept so that the track
    // starts instantly afterwards
    metaJob.decoding = true;
    const input = new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(target);
    });

    try {
      const arrayBuffer = await input;
      if (metaJob.token !== token) {
        return;
      }
      const decoded = await decoder.decode({
        name: 'input',
        arrayBuffer,
        owner: 'meta'
      });
      if (metaJob.token !== token) {
        return;
      }
      metaJob.decoding = false;
      // the decoded result is kept; the track starts instantly afterwards
      cacheSet(target, decoded);
      renderMetadata(target, decoded);
      status.textContent = '';
      status.hidden = true;
    }
    catch (e) {
      metaJob.decoding = false;
      // the dialog was closed or another track was asked for
      if (metaJob.token !== token || e.message === 'CANCELED') {
        return;
      }
      status.textContent = 'Cannot read this track (' + (e.message || e) + ')';
      status.hidden = false;
    }
  };

  /* remove every track from the playlist and forget all of them */
  const removeAll = () => {
    closeMetadata(); // stops the metadata decode that belongs to the dialog

    // every running decode belongs to a removed track
    decoder.cancel('user');
    decoder.cancel('prefetch');
    prefetching = null;
    cache.clear();

    view.clear();
    audio.files = null;
    audio.i = 0;
    updatePlaylistEmpty();

    stopped();

    // the remembered list must not restore the removed tracks again
    remember.clear();
  };

  document.getElementById('play-this').addEventListener('click', () => {
    const file = menuFile;
    closeMenu();
    if (!file) {
      return;
    }
    // the row may have moved while the menu was open
    const i = audio.files ? audio.files.indexOf(file) : -1;
    if (i === -1) {
      return;
    }
    if (i === (audio.i || 0)) {
      // the current track; resume it when it is paused
      if (!audio.source && audio.ready) {
        audio.play();
      }
      return;
    }
    audio.i = i;
    play();
  });

  document.getElementById('delete-this').addEventListener('click', () => {
    const file = menuFile;
    closeMenu();
    if (file) {
      /* the removal is a playlist mutation, so it goes through the queue;
         the place of the row is found again inside the job because the
         playlist may have changed since the menu was opened */
      serialize(() => {
        const i = audio.files ? audio.files.indexOf(file) : -1;
        if (i !== -1) {
          removeAt(i);
        }
      });
    }
  });

  document.getElementById('show-metadata').addEventListener('click', showMetadata);

  document.getElementById('delete-all').addEventListener('click', () => {
    closeMenu();

    const n = audio.files ? audio.files.length : 0;
    document.getElementById('confirm-body').textContent = 'This removes ' + n +
      ' track' + (n === 1 ? '' : 's') + ' from the playlist. The tracks that are remembered for the next launch are forgotten as well.';
    document.getElementById('confirm').showModal();
  });

  {
    const confirmation = document.getElementById('confirm');
    confirmation.addEventListener('close', () => {
      if (confirmation.returnValue === 'delete-all') {
        // the removal waits for the playlist mutations in flight
        serialize(removeAll);
      }
      // a stale return value must not leak into the next confirmation
      confirmation.returnValue = '';
    });
  }
}

/* the track that the open metadata dialog describes and the on-demand
   decode that belongs to it */
const metaJob = {
  file: null,
  token: 0,
  decoding: false
};

/* the metadata dialog of a removed track is closed with its on-demand decode */
const closeMetadata = () => {
  const metadata = document.getElementById('metadata');
  if (metadata.open) {
    metadata.close();
  }
};

/* nothing is playing anymore; the player is reset to its idle state while
   the playlist stays in place */
const stopped = () => {
  // an idle player must not advance anymore
  clearTimeout(advance);
  // the decode that might still be running belongs to a removed track
  decoder.cancel('user');
  audio.reset();
  audio.session = Math.random();
  // the play button must stay usable for the tracks that are left
  const parent = audio.shadowRoot.getElementById('parent');
  parent.setAttribute('mode', (audio.files && audio.files.length) ? 'play' : 'nosrc');
  previous.disabled = (audio.i || 0) === 0;
  next.disabled = true;
  title();
};

/* remove the track at `index` from the playlist and forget it; `silent`
   leaves the playback alone when the current track is removed because the
   replacing copy of a duplicate plays right afterwards */
const removeAt = (index, silent = false) => {
  const file = audio.files && audio.files[index];
  if (!file) {
    return;
  }

  // the metadata dialog that describes this track is closed with its decode
  if (metaJob.file === file) {
    closeMetadata();
  }

  // the background prefetch of the removed track is not needed anymore
  if (prefetching === file) {
    prefetching = null;
    decoder.cancel('prefetch');
  }
  cache.delete(file);

  // a locked row must not keep the click handler of its removed row
  if (file.cleanup) {
    file.cleanup();
  }

  const view = document.getElementById('view');
  view.removeIndex(index + 1); // the view counts the hidden header row
  audio.files.splice(index, 1);
  updatePlaylistEmpty();

  // the track must not come back on the next launch
  remember.remove(file);

  if (index === (audio.i || 0)) {
    // the current track was removed
    if (silent) {
      // the replacing copy follows right after; the caller fixes the index
      return;
    }
    // the next one becomes the current one
    if (audio.i < audio.files.length) {
      play();
    }
    else if (audio.files.length) {
      // the last track was removed while playing; nothing advances anymore
      audio.i = audio.files.length - 1;
      view.selectedIndex = audio.i + 1;
      stopped();
    }
    else {
      // the playlist is empty now; an empty list breaks `title()`
      audio.files = null;
      audio.i = 0;
      stopped();
    }
  }
  else {
    if (index < (audio.i || 0)) {
      audio.i -= 1;
    }
    // the additions refresh the navigation buttons and the title afterwards
    if (silent) {
      return;
    }
    // the selection and navigation buttons follow the shifted playlist
    view.selectedIndex = (audio.i || 0) + 1;
    previous.disabled = (audio.i || 0) === 0;
    next.disabled = (audio.i || 0) >= audio.files.length - 1;
    title();
  }
};

/* two entries describe the same track when they point to the same link or
   the same local file; a plain File without a handle has no identity and is
   matched by its name, size and modification date */
const sameTrack = async (a, b) => {
  if (!a || !b) {
    return false;
  }
  // the link tracks are identified by their address
  if (a.href || b.href) {
    return Boolean(a.href && b.href && a.href === b.href);
  }
  // the local tracks with a handle are identified by their entry
  if (a.handle && b.handle && a.handle.isSameEntry) {
    try {
      return await a.handle.isSameEntry(b.handle);
    }
    catch (e) {
      return false;
    }
  }
  return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
};

/* add tracks to the playlist; the old entries of the same tracks are
   replaced by the new copies */
const addTracks = async files => {
  audio.i = audio.i || 0;
  audio.files = audio.files || [];

  // the repeats of the incoming batch collapse into their newest copy
  const incoming = [];
  for (const file of files) {
    for (let k = incoming.length - 1; k >= 0; k -= 1) {
      if (await sameTrack(incoming[k], file)) {
        incoming.splice(k, 1);
      }
    }
    incoming.push(file);
  }

  // the old entries of the incoming tracks are removed from the highest
  // index down so that the indices of the removals stay valid
  for (let k = audio.files.length - 1; k >= 0; k -= 1) {
    let dupe = false;
    for (const file of incoming) {
      if (await sameTrack(audio.files[k], file)) {
        dupe = true;
        break;
      }
    }
    if (dupe) {
      removeAt(k, true);
    }
  }

  /* the first new track becomes the current one; the incoming tracks are
     appended at the end and the first of them plays right afterwards */
  if (audio.files.length && incoming.length) {
    audio.i = audio.files.length;
  }

  const view = document.getElementById('view');
  for (const file of incoming) {
    const n = audio.files.push(file);

    view.option([
      {name: file.name},
      {name: file.href || 'Local File'}
    ], file.name, n, false).insert();
  }
  updatePlaylistEmpty();

  /* remember the newly added tracks (best effort; never blocks the
     playback); the save is queued before the play below queues the first of
     them as the playing one, so a copy that is restoring right now never
     sees a playing record without its list record and cleans it up as a
     leftover */
  remember.save(incoming);

  if (audio.files.length) {
    play();
    audio.focus();
  }
};

/* the additions run one after another and never before the remembered
   tracks are restored; the identity checks of addTracks await real
   filesystem calls, so two additions in flight would otherwise interleave
   their index arithmetic on the shared playlist */
const add = files => restored.then(() => serialize(() => addTracks(files)));

drag.onDrag(add);

/* the broadcasts of the worker reach every open copy of the player; a Web
   Lock elects exactly one copy so that the others neither start the
   incoming jobs nor fight for the focus; a copy that loses the election
   must stay silent because its answer would race the answer of the
   elected copy and could make the worker open yet another window */
const elect = job => navigator.locks.request('player', {
  ifAvailable: true
}, async lock => {
  if (lock) {
    job();
  }
});

chrome.runtime.onMessage.addListener((request, sender, response) => {
  if (request.method === 'jobs') {
    elect(() => {
      add(request.jobs);
      response(true);
      chrome.runtime.sendMessage({
        method: 'bring-to-front'
      }, () => chrome.runtime.lastError);
    });
    // the elected copy answers asynchronously
    return true;
  }
  else if (request.method === 'ping') {
    elect(() => {
      response('pong');
      chrome.runtime.sendMessage({
        method: 'bring-to-front'
      }, () => chrome.runtime.lastError);
    });
    return true;
  }
});
/* restore the remembered tracks into the playlist without playing them; the
   track that was playing when the last session ended is the selected one; a
   track that is passed to this window afterwards plays as the newly added
   one */
const restored = remember.restore().then(({files, index}) => {
  if (files.length === 0) {
    return;
  }

  /* the restored rows are a playlist mutation, so they go through the
     queue; an addition can no longer interleave with them (the queue is
     empty at this point, so the job runs right away) */
  serialize(() => {
    audio.files = audio.files || [];

    const view = document.getElementById('view');
    for (const file of files) {
      const n = audio.files.push(file);

      const o = view.option([
        {name: file.name},
        {name: file.href || (file.locked ? 'Local File (read permission needed)' : 'Local File')}
      ], file.name, n, false);
      o.insert();
      // a locked track becomes readable once its read permission is granted;
      // the row handles its own click because the current row cannot be
      // re-selected through the hidden select of the list view
      if (file.locked) {
        const div = o._internal.div;
        div.style.opacity = '0.6';
        div.style.pointerEvents = 'initial';
        div.style.cursor = 'pointer';

        const handler = () => {
          audio.i = n - 1;
          play();
        };
        div.addEventListener('click', handler);

        // revert the row to a normal one once the file is readable
        file.cleanup = () => {
          div.removeEventListener('click', handler);
          div.style.pointerEvents = '';
          div.style.cursor = '';
          div.style.opacity = '';
          div.lastElementChild.textContent = 'Local File';
        };
      }
    }
    updatePlaylistEmpty();

    // the remembered playing track is the current one; the last restored
    // track is the fallback when it is not restorable anymore
    audio.i = index === -1 ? audio.files.length - 1 : index;
    view.selectedIndex = audio.i + 1;
    title();

    // the play button of the audio view is disabled while no source is
    // loaded; a selected track is a playable source for it
    const parent = audio.shadowRoot.getElementById('parent');
    if (parent.getAttribute('mode') === 'nosrc') {
      parent.setAttribute('mode', 'play');
    }
  });
}).catch(e => console.warn('CANNOT_RESTORE_TRACKS', e));

if (args.has('json')) {
  restored.then(() => {
    const jobs = JSON.parse(args.get('json'));
    add(jobs);
  });
}

launchQueue.setConsumer(async launchParams => {
  if (!launchParams.files || !launchParams.files.length) {
    return;
  }
  // wait for the remembered tracks so that the opened files play as the
  // newly added ones
  await restored;
  const files = [];
  for (const fileHandle of launchParams.files) {
    const file = await fileHandle.getFile();
    file.handle = fileHandle; // remember the opened local files
    files.push(file);
  }
  add(files);
});
