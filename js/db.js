// Lokal lagring i IndexedDB.
// Alla poster har samma form så att de kan synkas till servern i etapp 2:
// { id, type, date, data, createdAt, updatedAt, deleted, pending, schema }

const DB_NAME = 'dagbok';
const DB_VERSION = 1;
export const SCHEMA = 1;

let dbPromise = null;

// Anropas efter varje lokal ändring, så att synken kan schemaläggas.
let changeHook = null;
export function onChange(fn) { changeHook = fn; }
const notify = (v) => { try { changeHook?.(); } catch (e) { console.warn(e); } return v; };

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('records')) {
          const s = d.createObjectStore('records', { keyPath: 'id' });
          s.createIndex('type', 'type');
          s.createIndex('date', 'date');
          s.createIndex('pending', 'pending');
        }
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

// Kör en transaktion. fn får (store, setResult) och ska starta sina anrop synkront.
function run(storeName, mode, fn) {
  return open().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let out;
    fn(store, (v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaktionen avbröts'));
  }));
}

export function get(id) {
  return run('records', 'readonly', (s, set) => {
    s.get(id).onsuccess = (e) => set(e.target.result);
  });
}

// Skapar eller uppdaterar en post. Markeras alltid som osynkad (pending).
export function put(rec) {
  const now = Date.now();
  return run('records', 'readwrite', (s, set) => {
    const g = s.get(rec.id);
    g.onsuccess = () => {
      const prev = g.result;
      const next = {
        date: null,
        deleted: false,
        ...prev,
        ...rec,
        schema: SCHEMA,
        createdAt: prev?.createdAt ?? now,
        updatedAt: Math.max(now, (prev?.updatedAt ?? 0) + 1),
        pending: 1,
      };
      s.put(next);
      set(next);
    };
  }).then(notify);
}

// Mjuk radering: posten finns kvar som "raderad" så att raderingen kan synkas.
export function remove(id) {
  const now = Date.now();
  return run('records', 'readwrite', (s, set) => {
    const g = s.get(id);
    g.onsuccess = () => {
      const prev = g.result;
      if (!prev) return set(false);
      s.put({ ...prev, data: null, deleted: true, updatedAt: Math.max(now, prev.updatedAt + 1), pending: 1 });
      set(true);
    };
  }).then(notify);
}

export function list(type) {
  return run('records', 'readonly', (s, set) => {
    s.index('type').getAll(type).onsuccess = (e) => set(e.target.result.filter((r) => !r.deleted));
  });
}

export function listByDate(type, date) {
  return run('records', 'readonly', (s, set) => {
    s.index('date').getAll(date).onsuccess = (e) =>
      set(e.target.result.filter((r) => r.type === type && !r.deleted));
  });
}

export function count(type) {
  return run('records', 'readonly', (s, set) => {
    s.index('type').count(type).onsuccess = (e) => set(e.target.result);
  });
}

export function all() {
  return run('records', 'readonly', (s, set) => {
    s.getAll().onsuccess = (e) => set(e.target.result);
  });
}

// Slår ihop poster från en säkerhetskopia. Nyast (updatedAt) vinner per post.
export function importRecords(records) {
  return run('records', 'readwrite', (s, set) => {
    let written = 0;
    set(0);
    for (const r of records) {
      const g = s.get(r.id);
      g.onsuccess = () => {
        const prev = g.result;
        if (!prev || r.updatedAt > prev.updatedAt) {
          s.put({ ...r, pending: 1 });
          written += 1;
          set(written);
        }
      };
    }
  }).then(notify);
}

/* ---------- För synken ---------- */

// Poster som har ändrats lokalt och inte skickats än.
export function listPending() {
  return run('records', 'readonly', (s, set) => {
    s.index('pending').getAll(1).onsuccess = (e) => set(e.target.result);
  });
}

// Markerar poster som skickade, men bara om de inte har ändrats igen under tiden.
export function markSynced(items) {
  return run('records', 'readwrite', (s) => {
    for (const { id, updatedAt } of items) {
      const g = s.get(id);
      g.onsuccess = () => {
        const cur = g.result;
        if (cur && cur.updatedAt === updatedAt && cur.pending) s.put({ ...cur, pending: 0 });
      };
    }
  });
}

// Lägger in poster från servern. Nyast vinner; lokalt nyare poster lämnas orörda.
export function applyRemote(records) {
  return run('records', 'readwrite', (s, set) => {
    const changed = [];
    set(changed);
    for (const r of records) {
      const g = s.get(r.id);
      g.onsuccess = () => {
        const cur = g.result;
        if (!cur || r.updatedAt > cur.updatedAt) {
          s.put({ ...r, pending: 0 });
          changed.push(r);
        } else if (cur.updatedAt === r.updatedAt && cur.pending) {
          s.put({ ...cur, pending: 0 });
        }
      };
    }
  });
}

// Alla poster markeras som osynkade, t.ex. efter att serverdatan har raderats.
export function markAllPending() {
  return run('records', 'readwrite', (s) => {
    s.openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return;
      if (!c.value.pending) c.update({ ...c.value, pending: 1 });
      c.continue();
    };
  });
}

export function delMeta(key) {
  return run('meta', 'readwrite', (s) => { s.delete(key); });
}

// Tömmer all lokal data. Nycklar i `keepMeta` (t.ex. inloggningen) behålls.
export function clearAll(keepMeta = []) {
  return open().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(['records', 'blobs', 'meta'], 'readwrite');
    t.objectStore('records').clear();
    t.objectStore('blobs').clear();
    const meta = t.objectStore('meta');
    meta.getAllKeys().onsuccess = (e) => {
      for (const k of e.target.result) if (!keepMeta.includes(k)) meta.delete(k);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaktionen avbröts'));
  }));
}

export function putBlob(id, blob) {
  return run('blobs', 'readwrite', (s) => { s.put(blob, id); });
}

export function getBlob(id) {
  return run('blobs', 'readonly', (s, set) => {
    s.get(id).onsuccess = (e) => set(e.target.result);
  });
}

export function hasBlob(id) {
  return run('blobs', 'readonly', (s, set) => {
    s.count(id).onsuccess = (e) => set(e.target.result > 0);
  });
}

export function delBlob(id) {
  return run('blobs', 'readwrite', (s) => { s.delete(id); });
}

export function getMeta(key) {
  return run('meta', 'readonly', (s, set) => {
    s.get(key).onsuccess = (e) => set(e.target.result);
  });
}

export function setMeta(key, value) {
  return run('meta', 'readwrite', (s) => { s.put(value, key); });
}
