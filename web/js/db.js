// Tiny IndexedDB wrapper: a key-value store for cached rows and the outbox, and a blob store for photos.
// Falls back to memory when IndexedDB is unavailable (private windows, tests), so the app still works for the session.
const NAME = 'thaitastes', VERSION = 1;

function memoryDb() {
  const kv = new Map(), photos = new Map();
  return {
    kind: 'memory',
    async get(k) { return kv.get(k); },
    async set(k, v) { kv.set(k, structuredClone(v)); },
    async del(k) { kv.delete(k); },
    async clear() { kv.clear(); photos.clear(); },
    async getPhoto(p) { return photos.get(p); },
    async setPhoto(p, b) { photos.set(p, b); },
    async delPhoto(p) { photos.delete(p); },
    async allPhotos() { return [...photos].map(([path, blob]) => ({ path, blob })); },
  };
}

export async function openDb() {
  if (typeof indexedDB === 'undefined') return memoryDb();
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => { req.result.createObjectStore('kv'); req.result.createObjectStore('photos'); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    });
  } catch { return memoryDb(); }
  const run = (store, mode, fn) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
  return {
    kind: 'indexeddb',
    get: (k) => run('kv', 'readonly', (s) => s.get(k)),
    set: (k, v) => run('kv', 'readwrite', (s) => s.put(v, k)),
    del: (k) => run('kv', 'readwrite', (s) => s.delete(k)),
    async clear() { await run('kv', 'readwrite', (s) => s.clear()); await run('photos', 'readwrite', (s) => s.clear()); },
    getPhoto: (p) => run('photos', 'readonly', (s) => s.get(p)),
    setPhoto: (p, b) => run('photos', 'readwrite', (s) => s.put(b, p)),
    delPhoto: (p) => run('photos', 'readwrite', (s) => s.delete(p)),
    async allPhotos() {
      return new Promise((resolve, reject) => {
        const out = [], tx = db.transaction('photos', 'readonly');
        const req = tx.objectStore('photos').openCursor();
        req.onsuccess = () => { const c = req.result; if (c) { out.push({ path: c.key, blob: c.value }); c.continue(); } };
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(tx.error);
      });
    },
  };
}
