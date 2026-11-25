const drag = {
  cs: [],
  onDrag(c) {
    drag.cs.push(c);
  }
};
window.drag = drag;

/* accept a file for playback; `handle` (when present) lets a local track be
   remembered across sessions */
const collect = (files, file, handle) => {
  const ok = file.type ?
    (file.type.startsWith('audio/') || file.type.startsWith('video/')) :
    file.name.startsWith('.') === false;

  if (ok) {
    if (handle) {
      file.handle = handle;
    }
    files.push(file);
  }
};

/* collect the files of a dropped handle; a directory handle is browsed
   recursively */
const fromHandle = async (files, handle) => {
  if (handle.kind === 'directory') {
    for await (const entry of handle.values()) {
      await fromHandle(files, entry).catch(e => console.warn('CANNOT_ADD_FILE', e));
    }
  }
  else {
    const file = await handle.getFile();
    collect(files, file, handle);
  }
};

/* collect the files of a dropped entry (the legacy API without handles) */
const fromEntry = async (files, entry) => {
  const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
  collect(files, file);
};

/* collect the files of a dropped entry (the legacy API without handles);
   readEntries() returns the directory's entries in batches, so keep reading
   until a batch comes back empty */
const readEntries = async (files, entry) => {
  const directoryReader = entry.createReader();

  while (true) {
    const entries = await new Promise((resolve, reject) => {
      directoryReader.readEntries(resolve, reject);
    });

    if (!entries.length) {
      break;
    }

    for (const entry of entries) {
      if (entry.isFile) {
        await fromEntry(files, entry).catch(e => console.warn('CANNOT_ADD_FILE', e));
      }
      else {
        await readEntries(files, entry).catch(e => console.warn('CANNOT_BROWSE', e));
      }
    }
  }
};

const drop = async es => {
  const files = [];

  // both handle and entry APIs are only usable during the event turn; the
  // returned promises are settled after the handler has already returned
  const pairs = es.map(item => ({
    handle: item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null,
    entry: item.webkitGetAsEntry ? item.webkitGetAsEntry() : null,
    file: item instanceof File ? item : null
  }));

  for (const {handle, entry, file} of pairs) {
    if (handle) {
      const h = await handle.catch(() => null);
      if (h) {
        await fromHandle(files, h).catch(e => console.warn('CANNOT_ADD_FILE', e));
        continue;
      }
    }
    if (entry) {
      if (entry.isFile) {
        await fromEntry(files, entry).catch(e => console.warn('CANNOT_ADD_FILE', e));
      }
      else {
        await readEntries(files, entry).catch(e => console.warn('CANNOT_BROWSE', e));
      }
    }
    else if (file) {
      // the file input fallback does not provide handles
      collect(files, file);
    }
  }

  if (files.length) {
    for (const c of drag.cs) {
      c(files);
    }
  }
};

document.getElementById('browse').addEventListener('click', async () => {
  // the picker provides handles so that the picked tracks can be remembered
  if (window.showOpenFilePicker) {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{
          description: 'Media Files',
          accept: {
            'audio/*': ['.aac', '.flac', '.m4a', '.mka', '.mid', '.mp3', '.ogg', '.pcm', '.voc', '.wav', '.wma'],
            'video/*': ['.3gp', '.avi', '.flv', '.mkv', '.mov', '.mp4', '.mpg', '.ogv', '.swf', '.vob', '.webm', '.wmv']
          }
        }]
      });

      const files = [];
      for (const handle of handles) {
        const file = await handle.getFile();
        collect(files, file, handle);
      }
      if (files.length) {
        for (const c of drag.cs) {
          c(files);
        }
      }
      return;
    }
    catch (e) {
      if (e && e.name === 'AbortError') {
        return; // the picker was canceled
      }
      console.warn('CANNOT_USE_PICKER', e); // fall back to the file input
    }
  }

  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'video/*, audio/*';
  input.onchange = () => {
    if (input.files.length) {
      drop([...input.files]);
    }
  };
  input.click();
});

document.addEventListener('dragover', e => {
  e.preventDefault();
});
document.addEventListener('drop', e => {
  e.preventDefault();
  drop([...e.dataTransfer.items]);
});
