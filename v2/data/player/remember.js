/* global chrome */
'use strict';

/* Track remembering; the last added tracks are stored in IndexedDB so that
   the playlist can be restored. Link tracks are stored as plain records and
   local tracks are stored as FileSystemFileHandle-s; a stored handle is read
   back only after the user grants the read permission for it. The track that
   is playing when a track switch happens is stored as well so that the next
   launch can select it again; its record is dropped when its track is
   deleted or trimmed out of the stored list. */
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
  /* resolve on the commit rather than on the request, so that the queue
     below orders completed writes */
  tx: (mode, action) => db.open().then(database => new Promise((resolve, reject) => {
    const t = database.transaction('tracks', mode);
    const req = action(t.objectStore('tracks'));

    let result;
    req.onsuccess = () => { result = req.result; };
    req.onerror = () => reject(req.error);
    t.onabort = () => reject(t.error || Error('ABORTED'));
    t.oncomplete = () => resolve(result);
  })),
  read: () => db.tx('readonly', os => os.get('list')).then(r => (r && r.list) || []),
  write: list => db.tx('readwrite', os => os.put({list}, 'list')),
  clear: () => db.tx('readwrite', os => os.clear()),
  /* the record of the track that is playing now; it is a separate key, but
     it is dropped whenever its track leaves the stored list, because a
     record that is not in the list can never be selected again */
  readCurrent: () => db.tx('readonly', os => os.get('current')).then(r => r || null),
  writeCurrent: record => db.tx('readwrite', os => os.put(record, 'current')),
  dropCurrent: () => db.tx('readwrite', os => os.delete('current'))
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

/* two records describe the same track when they point to the same link or
   the same local file; a stored handle is a fresh structured clone, so only
   `isSameEntry` can compare it with another handle */
remember.same = async (r, rec) => {
  if (r.kind !== rec.kind) {
    return false;
  }
  if (r.kind === 'file') {
    try {
      return await r.handle.isSameEntry(rec.handle);
    }
    catch (e) {
      return false;
    }
  }
  return r.href === rec.href;
};

/* serialize the changes of this page so that concurrent additions cannot
   overwrite the stored list of each other */
let queue = Promise.resolve();

/* the queue orders this page alone, so every read-compute-write cycle below
   also holds a Web Lock that the other open copies of the player and the
   worker take as well; the lock makes the cycles exclusive across the whole
   extension */
const mutex = job => navigator.locks.request('audio-player-tracks', job);

/* `true` when the record of the playing track points into the given list */
const present = async (current, list) => {
  for (const record of list) {
    if (await remember.same(current, record)) {
      return true; // the playing track is still remembered
    }
  }
  return false;
};

/* write the new list, then reconcile the record of the playing track with
   it: a record that is not in the list anymore could never be selected
   again (`restore` matches the record against the list) and would only
   keep the handle of a deleted local file alive */
remember.commit = async list => {
  await db.write(list);
  const current = await db.readCurrent();
  if (current && (await present(current, list)) === false) {
    await db.dropCurrent();
  }
};

/* reconcile the record of the playing track on fresh reads; the launch
   sweeps a leftover record with this, and the fresh reads keep a copy that
   is saving this very track from losing its new record */
remember.forget = async () => {
  const current = await db.readCurrent();
  if (current && (await present(current, await db.read())) === false) {
    await db.dropCurrent();
  }
};

/* remember the newly added tracks; the promise never rejects */
remember.save = files => {
  queue = queue.then(() => mutex(() => remember.persist(files)))
    .catch(e => console.warn('CANNOT_REMEMBER_TRACKS', e));
  return queue;
};

remember.persist = async files => {
  try {
    const prefs = await chrome.storage.local.get({
      'remember-tracks': 30
    });
    if (prefs['remember-tracks'] === 0) {
      return; // the user asked not to remember any tracks
    }

    const records = files.map(remember.toRecord).filter(Boolean);
    if (records.length === 0) {
      return;
    }

    const list = await db.read();
    // the older records of the incoming tracks are dropped so that the
    // stored list stays free of duplicates
    const kept = [];
    for (const r of list) {
      let dupe = false;
      for (const rec of records) {
        if (await remember.same(r, rec)) {
          dupe = true;
          break;
        }
      }
      if (dupe === false) {
        kept.push(r);
      }
    }
    /* the oldest records fall off the end when the list outgrows the
       preference; the commit also drops the playing record when its track
       is among them */
    await remember.commit([...kept, ...records].slice(-prefs['remember-tracks']));
  }
  catch (e) {
    console.warn('CANNOT_REMEMBER_TRACKS', e);
  }
};

/* remember the track that is playing now; a track that cannot be stored (a
   dropped File without a handle) clears the remembered one so that the next
   launch falls back to the last restored track; the record is a single
   atomic write, so it takes no lock — the queue still orders it behind the
   other changes of this page; the promise never rejects */
remember.current = file => {
  const record = file ? remember.toRecord(file) : null;
  queue = queue.then(async () => {
    try {
      if (record) {
        await db.writeCurrent(record);
      }
      else {
        await db.dropCurrent();
      }
    }
    catch (e) {
      console.warn('CANNOT_REMEMBER_CURRENT', e);
    }
  });
  return queue;
};

/* playlist entries for the remembered tracks; a local file without the read
   permission returns a locked entry that asks for the permission on the
   first attempt to play it; `index` is the position of the remembered playing
   track among the entries and -1 when it is not restorable anymore; the
   promise never rejects */
remember.restore = async () => {
  try {
    const prefs = await chrome.storage.local.get({
      'remember-tracks': 30
    });
    if (prefs['remember-tracks'] === 0) {
      /* the sweep is a change like any other, so it runs under the lock;
         the launch does not wait for it */
      mutex(() => db.clear()).catch(e => console.warn('CANNOT_RESTORE_TRACKS', e));
      return {files: [], index: -1};
    }

    let list = await db.read();
    // the preference might have been reduced since the last save
    if (list.length > prefs['remember-tracks']) {
      list = list.slice(-prefs['remember-tracks']);
      /* the trim re-reads the list and the preference under the lock,
         because another copy could have added a track or the user could
         have changed the preference since the reads above; the commit drops
         the playing record when its track is trimmed out; the launch does
         not wait for the write */
      mutex(async () => {
        const p = await chrome.storage.local.get({
          'remember-tracks': prefs['remember-tracks']
        });
        const fresh = await db.read();
        if (fresh.length > p['remember-tracks']) {
          await remember.commit(fresh.slice(-p['remember-tracks']));
        }
      }).catch(e => console.warn('CANNOT_TRIM_TRACKS', e));
    }

    // the track that was playing when the last session ended; an unreadable
    // record leaves the selection to the caller
    let current = await db.readCurrent().catch(() => null);

    /* a playing record that points outside the stored list can never be
       selected again; the cleanup re-checks under the lock on fresh reads,
       so a copy that is saving this very track cannot lose its new record,
       and the launch does not wait for it either */
    if (current && (await present(current, list)) === false) {
      current = null; // the selection falls back to the last restored track
      mutex(() => remember.forget())
        .catch(e => console.warn('CANNOT_FORGET_CURRENT', e));
    }

    const files = [];
    let index = -1;
    for (const record of list) {
      try {
        // `pushed` is false when the record produces no playlist entry
        let pushed = false;
        if (record.kind === 'link') {
          files.push({
            name: record.name,
            href: record.href
          });
          pushed = true;
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
          pushed = true;
        }
        // the entry of the remembered playing track is the selected one
        if (pushed && current && index === -1 && await remember.same(current, record)) {
          index = files.length - 1;
        }
      }
      catch (e) {
        // the handle is not usable anymore (moved or deleted file)
        console.warn('CANNOT_RESTORE_TRACK', e);
      }
    }
    return {files, index};
  }
  catch (e) {
    console.warn('CANNOT_RESTORE_TRACKS', e);
    return {files: [], index: -1};
  }
};

/* remove a deleted track from the stored list; the promise never rejects */
remember.remove = file => {
  queue = queue.then(() => mutex(() => remember.unpersist(file)))
    .catch(e => console.warn('CANNOT_FORGET_TRACK', e));
  return queue;
};

remember.unpersist = async file => {
  try {
    const record = remember.toRecord(file);
    if (!record) {
      return; // the track was never stored (a dropped File without a handle)
    }

    const list = await db.read();
    const kept = [];
    for (const r of list) {
      if ((await remember.same(r, record)) === false) {
        kept.push(r);
      }
    }
    if (kept.length !== list.length) {
      /* the commit takes the record of the playing track along when its
         track is the removed one */
      await remember.commit(kept);
    }
  }
  catch (e) {
    console.warn('CANNOT_FORGET_TRACK', e);
  }
};

/* forget every stored track; the promise never rejects */
remember.clear = () => {
  queue = queue.then(() => mutex(() => db.clear()))
    .catch(e => console.warn('CANNOT_CLEAR_TRACKS', e));
  return queue;
};
