// On-device storage: converted files live in IndexedDB, preferences in localStorage.
// Metadata and bytes are kept in separate stores so listing the library never
// pulls file contents into memory.

const DB_NAME = 'quillshift';
const DB_VERSION = 1;
let dbPromise;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('data')) d.createObjectStore('data');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage is full or unavailable.'));
    Promise.resolve(fn(t)).then((r) => { result = r; }, (e) => { try { t.abort(); } catch {} reject(e); });
  });
}

export const library = {
  /** @param {{id,name,format,mime,size,created,from?}} meta @param {Blob} blob */
  async add(meta, blob) {
    const buf = await blob.arrayBuffer();
    await tx(['meta', 'data'], 'readwrite', (t) => {
      t.objectStore('meta').put(meta);
      t.objectStore('data').put(buf, meta.id);
    });
    return meta;
  },
  async list() {
    const all = await tx(['meta'], 'readonly', (t) => wrap(t.objectStore('meta').getAll()));
    return all.sort((a, b) => b.created - a.created);
  },
  async get(id) {
    return tx(['meta', 'data'], 'readonly', async (t) => {
      const [meta, buf] = await Promise.all([wrap(t.objectStore('meta').get(id)), wrap(t.objectStore('data').get(id))]);
      if (!meta || !buf) return null;
      return { ...meta, blob: new Blob([buf], { type: meta.mime }) };
    });
  },
  async patch(id, changes) {
    return tx(['meta'], 'readwrite', async (t) => {
      const s = t.objectStore('meta');
      const meta = await wrap(s.get(id));
      if (meta) s.put({ ...meta, ...changes });
    });
  },
  async remove(id) {
    return tx(['meta', 'data'], 'readwrite', (t) => {
      t.objectStore('meta').delete(id);
      t.objectStore('data').delete(id);
    });
  },
  async clear() {
    return tx(['meta', 'data'], 'readwrite', (t) => {
      t.objectStore('meta').clear();
      t.objectStore('data').clear();
    });
  },
  /** Drop items older than the retention window. Returns how many were removed. */
  async prune(days) {
    if (!days) return 0;
    const cutoff = Date.now() - days * 864e5;
    const old = (await this.list()).filter((m) => m.created < cutoff);
    for (const m of old) await this.remove(m.id);
    return old.length;
  },
};

const DEFAULTS = {
  theme: 'auto',            // auto | light | dark
  keep: true,               // save conversions to the library
  retention: 0,             // days; 0 = keep until removed
  pageSize: 'A4',           // A4 | LETTER
  orientation: 'portrait',
  margin: 'normal',         // narrow | normal | wide
  pdfMode: 'auto',          // auto | text | snapshot
  pageNumbers: false,
  quality: 0.85,            // JPG / WEBP quality
  maxEdge: 0,               // resize images so the longest edge is at most N px; 0 = original
  dpi: 150,                 // PDF → image resolution
  reader: { theme: 'auto', font: 'serif', size: 18, leading: 1.65, width: 'medium', justify: false, rate: 1 },
};

const KEY = 'quillshift.settings';
let cache;

export const settings = {
  all() {
    if (!cache) {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
      cache = { ...DEFAULTS, pageSize: defaultPageSize(), ...saved, reader: { ...DEFAULTS.reader, ...(saved.reader || {}) } };
    }
    return cache;
  },
  get(k) { return this.all()[k]; },
  set(k, v) {
    this.all()[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch {}
  },
};

export function defaultPageSize() {
  // Letter is the norm in the US, Canada and a few neighbours; A4 everywhere else.
  const region = (navigator.language || '').split('-')[1]?.toUpperCase();
  return ['US', 'CA', 'MX', 'PH', 'CL', 'CO'].includes(region) ? 'LETTER' : 'A4';
}
