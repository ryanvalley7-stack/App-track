// Thin promise wrapper around IndexedDB. Photos are stored as Blobs on-device.
const DB_NAME = 'gym-progress';
const STORE = 'photos';

let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      store.createIndex('takenAt', 'takenAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const getAll = () => run('readonly', (s) => s.getAll());
export const add = (record) => run('readwrite', (s) => s.add(record));
export const put = (record) => run('readwrite', (s) => s.put(record));
export const remove = (id) => run('readwrite', (s) => s.delete(id));
