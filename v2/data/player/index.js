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

if (isNaN(localStorage.volume) === false) {
  audio.volume = Number(localStorage.getItem('volume'));
}

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

/* a remembered local track is listed before its read permission is granted;
   ask for the permission and replace the locked entry with the readable file */
const unlock = async (file, index) => {
  let state;
  try {
    state = await file.handle.requestPermission({mode: 'read'});
  }
  catch (e) {
    // the permission prompt requires a user gesture; keyboard jumps and the
    // automatic advancement do not provide one
    throw Error('Cannot read "' + file.name + '". Click the track once to grant the read access.');
  }
  if (state !== 'granted') {
    throw Error('The read permission for "' + file.name + '" was denied.');
  }

  const real = await file.handle.getFile();
  real.handle = file.handle;
  audio.files[index] = real;

  return real;
};

const play = () => {
  const i = audio.i || 0;

  document.getElementById('view').selectedIndex = i + 1;

  previous.setAttribute('disabled', i === 0);
  next.setAttribute('disabled', i >= audio.files.length - 1);

  const file = audio.file;
  if (!file) {
    return;
  }

  // a remembered local track needs its read permission before it can be
  // decoded; selecting the track provides the gesture for the prompt
  if (file.locked) {
    unlock(file, i).then(() => {
      // the row is readable now; revert it to a normal row
      if (file.cleanup) {
        file.cleanup();
      }
      // the track was not switched while the permission was being asked for
      if ((audio.i || 0) === i) {
        play();
      }
    }).catch(e => {
      document.title = (e.message || e);
      alert(e.message || e);
    });
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

  if (file.href) {
    get(file.href, (s, m) => {
      let msg = 'Buffering ';

      msg += format(s, 1);

      if (m) {
        msg += ' / ' + format(m, 1);
        msg += ' [' + (s / m * 100).toFixed(1) + '%]';
      }
      document.title = msg + '...';
    }).then(buffer => {
      // the track was switched while the input was downloading
      if (audio.file === file) {
        done(file, () => audio.play(buffer));
      }
    }).catch(e => alert(e.message));
  }
  else {
    const reader = new FileReader();
    reader.onload = () => {
      if (audio.file === file) {
        done(file, () => audio.play(reader.result));
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

{
  let id;
  audio.addEventListener('play', () => {
    clearTimeout(id);
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

    id = setTimeout(() => {
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
          if (r === 'no-repeat' && next.getAttribute('disabled') === 'false') {
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
    alert(e.detail);
    m();
  });
  audio.addEventListener('ended', () => m());
}

// the play button and the Space key with nothing loaded start the selected track
audio.addEventListener('empty', () => {
  if (audio.files && audio.files.length) {
    play();
  }
});

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

/* the playlist context menu; it replaces the fixed metadata panel */
{
  const view = document.getElementById('view');
  const menu = document.getElementById('context-menu');
  const anchor = document.getElementById('menu-anchor');
  const metadata = document.getElementById('metadata');
  const grid = document.getElementById('metadata-grid');
  const status = document.getElementById('metadata-status');

  // the row that the menu was opened for; -1 when it is the empty area
  let menuIndex = -1;

  // the track that the open metadata dialog describes and the on-demand
  // decode that belongs to it
  const metaJob = {
    file: null,
    token: 0,
    decoding: false
  };

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

    menuIndex = has ? rowAt(y) : -1;
    document.getElementById('play-this').disabled = menuIndex === -1;
    document.getElementById('delete-this').disabled = menuIndex === -1;
    document.getElementById('show-metadata').disabled = menuIndex === -1;
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

  /* render the known information of `file`; `known` is the decoded result of
     the track and null while it is still unknown */
  const renderMetadata = (file, known) => {
    grid.textContent = '';

    const m = (known && known.meta) || {};
    const b = known && known.audioBuffer;
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
    row('Duration', b ? htime(b.duration) : '-');
    row('Codec Name', m['Codec Name'] || '-');
    row('Codec Long Name', m['Codec Long Name'] || '-');
    row('Sample Format', m['Sample Format'] || '-');
    row('Sample Rate', b ? b.sampleRate : (m['Sample Rate'] || '-'));
    row('Sample Size', m['Sample Size'] || '-');
    row('Channels', b ? b.numberOfChannels : (m['Channels'] || '-'));
    row('LIBAVCODEC Version', m['LIBAVCODEC Version'] || '-');
    row('LIBAVFORMAT Version', m['LIBAVFORMAT Version'] || '-');
  };

  // the open dialog is refreshed when the decode of the current track ends
  audio.addEventListener('loadedmetadata', () => {
    if (metaJob.file === audio.file && metadata.open) {
      renderMetadata(audio.file, {
        audioBuffer: audio.audioBuffer,
        meta: audio.meta || {}
      });
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

  const closeMetadata = () => {
    if (metadata.open) {
      metadata.close();
    }
  };

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
    const i = menuIndex;
    const file = audio.files && audio.files[i];
    closeMenu();
    if (!file) {
      return;
    }

    let target = file;
    // a locked local track needs its read permission before it can be decoded
    if (file.locked) {
      try {
        target = await unlock(file, i);
        if (file.cleanup) {
          file.cleanup();
        }
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

    const known = cache.get(target) || (target === audio.file && audio.audioBuffer ? {
      audioBuffer: audio.audioBuffer,
      meta: audio.meta || {}
    } : null);

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

    // decode the track on demand; the `meta` worker never delays a playback
    metaJob.decoding = true;
    const input = target.href ? get(target.href, (s, m) => {
      if (metaJob.token !== token) {
        return;
      }
      let msg = 'Buffering ' + format(s, 1);
      if (m) {
        msg += ' / ' + format(m, 1);
        msg += ' [' + (s / m * 100).toFixed(1) + '%]';
      }
      status.textContent = msg + '...';
    }) : new Promise((resolve, reject) => {
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

  /* nothing is playing anymore; the player is reset to its idle state while
     the playlist stays in place */
  const stopped = () => {
    // the decode that might still be running belongs to a removed track
    decoder.cancel('user');
    audio.reset();
    audio.session = Math.random();
    // the play button must stay usable for the tracks that are left
    const parent = audio.shadowRoot.getElementById('parent');
    parent.setAttribute('mode', (audio.files && audio.files.length) ? 'play' : 'nosrc');
    previous.setAttribute('disabled', (audio.i || 0) === 0);
    next.setAttribute('disabled', 'true');
    title();
  };

  /* remove the track at `index` from the playlist and forget it */
  const removeAt = index => {
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

    view.removeIndex(index + 1); // the view counts the hidden header row
    audio.files.splice(index, 1);

    // the track must not come back on the next launch
    remember.remove(file);

    if (index === (audio.i || 0)) {
      // the current track was removed; the next one becomes the current one
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
      // the navigation buttons and the title follow the shorter playlist
      previous.setAttribute('disabled', (audio.i || 0) === 0);
      next.setAttribute('disabled', (audio.i || 0) >= audio.files.length - 1);
      title();
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

    stopped();

    // the remembered list must not restore the removed tracks again
    remember.clear();
  };

  document.getElementById('play-this').addEventListener('click', () => {
    const i = menuIndex;
    closeMenu();
    if (i === -1) {
      return;
    }
    if (i === (audio.i || 0)) {
      // the current track; resume it when it is paused
      if (!audio.source && audio.audioBuffer) {
        audio.play();
      }
      return;
    }
    audio.i = i;
    play();
  });

  document.getElementById('delete-this').addEventListener('click', () => {
    const i = menuIndex;
    closeMenu();
    if (i !== -1) {
      removeAt(i);
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
        removeAll();
      }
      // a stale return value must not leak into the next confirmation
      confirmation.returnValue = '';
    });
  }
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
      {name: file.href || 'Local File'}
    ], file.name, n, false).insert();
  }

  if (audio.files.length) {
    play();
    audio.focus();
  }

  // remember the newly added tracks (best effort; never blocks the playback)
  remember.save(files);
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
/* restore the remembered tracks into the playlist without playing them; a
   track that is passed to this window afterwards plays as the newly added
   one */
const restored = remember.restore().then(files => {
  if (files.length === 0) {
    return;
  }

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

  // the last restored track is the current one
  audio.i = audio.files.length - 1;
  view.selectedIndex = audio.i + 1;
  title();

  // the play button of the audio view is disabled while no source is loaded;
  // a selected track is a playable source for it
  const parent = audio.shadowRoot.getElementById('parent');
  if (parent.getAttribute('mode') === 'nosrc') {
    parent.setAttribute('mode', 'play');
  }
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
