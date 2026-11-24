/* global chrome */
'use strict';

/* Track remembering; the last added tracks are stored in IndexedDB so that
   the playlist can be restored. Link tracks are stored as plain records and
   local tracks are stored as FileSystemFileHandle-s; a stored handle is read
   back only after the user grants the read permission for it. */
const remember = {};
window.remember = remember;

/* IndexedDB; the same schema is used by the worker when the stored tracks
   are trimmed after the preference is changed */
const db = {
  r: null,
  open: () => db.r = db.r || new Promise((resolve, reject) => {
    const r = indexedDB.open('audio-player', 1);

    r.onupgradeneeded = () => {
      if (r.result.objectStoreNames.contains('tracks') === false) {
        r.result.createObjectStore('tracks');
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(Error('BLOCKED'));
  }),
  tx: (mode, action) => db.open().then(database => new Promise((resolve, reject) => {
    const t = database.transaction('tracks', mode);
    const req = action(t.objectStore('tracks'));

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.onabort = () => reject(t.error || Error('ABORTED'));
  })),
  read: () => db.tx('readonly', os => os.get('list')).then(r => (r && r.list) || []),
  write: list => db.tx('readwrite', os => os.put({list}, 'list')),
  clear: () => db.tx('readwrite', os => os.clear())
};

/* convert an added track into a storable record; a File without a handle
   cannot be restored and is ignored */
remember.toRecord = file => {
  if (file.handle) {
    return {
      kind: 'file',
      name: file.name,
      handle: file.handle
    };
  }
  if (file.href) {
    return {
      kind: 'link',
      name: file.name,
      href: file.href
    };
  }
  return null;
};

/* serialize the saves so that concurrent additions cannot overwrite the
   stored list of each other */
let queue = Promise.resolve();

/* remember the newly added tracks; the promise never rejects */
remember.save = files => {
  queue = queue.then(() => remember.persist(files));
  return queue;
};

remember.persist = async files => {
  try {
    const prefs = await chrome.storage.local.get({
      'remember-tracks': 10
    });
    if (prefs['remember-tracks'] === 0) {
      return; // the user asked not to remember any tracks
    }

    const records = files.map(remember.toRecord).filter(Boolean);
    if (records.length === 0) {
      return;
    }

    const list = await db.read();
    await db.write([...list, ...records].slice(-prefs['remember-tracks']));
  }
  catch (e) {
    console.warn('CANNOT_REMEMBER_TRACKS', e);
  }
};

/* playlist entries for the remembered tracks; a local file without the read
   permission returns a locked entry that asks for the permission on the
   first attempt to play it; the promise never rejects */
remember.restore = async () => {
  try {
    const prefs = await chrome.storage.local.get({
      'remember-tracks': 10
    });
    if (prefs['remember-tracks'] === 0) {
      await db.clear();
      return [];
    }

    let list = await db.read();
    // the preference might have been reduced since the last save
    if (list.length > prefs['remember-tracks']) {
      list = list.slice(-prefs['remember-tracks']);
      db.write(list).catch(e => console.warn('CANNOT_TRIM_TRACKS', e));
    }

    const files = [];
    for (const record of list) {
      try {
        if (record.kind === 'link') {
          files.push({
            name: record.name,
            href: record.href
          });
        }
        else if (record.handle.queryPermission) {
          const state = await record.handle.queryPermission({mode: 'read'});
          if (state === 'granted') {
            const file = await record.handle.getFile();
            file.handle = record.handle;
            files.push(file);
          }
          else {
            files.push({
              name: record.name,
              handle: record.handle,
              locked: true
            });
          }
        }
      }
      catch (e) {
        // the handle is not usable anymore (moved or deleted file)
        console.warn('CANNOT_RESTORE_TRACK', e);
      }
    }
    return files;
  }
  catch (e) {
    console.warn('CANNOT_RESTORE_TRACKS', e);
    return [];
  }
};
