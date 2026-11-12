export function createLocalStore(indexedDB, name, storeName, timeoutMs = 5000) {
  let connection = null;
  let opening = null;
  let queue = Promise.resolve();

  function invalidate(db) {
    if (connection === db) connection = null;
    db.close();
  }

  function open() {
    if (!indexedDB) return Promise.reject(new Error("IndexedDB est indisponible dans ce navigateur."));
    if (connection) return Promise.resolve(connection);
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error("Stockage local bloqué. Gardez cette page ouverte et exportez la copie mémoire avant de fermer un autre onglet PixelBoard."));
      }, timeoutMs);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: "id" });
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        const db = request.result;
        if (settled) { db.close(); return; }
        settled = true;
        connection = db;
        db.onversionchange = () => invalidate(db);
        db.onclose = () => { if (connection === db) connection = null; };
        resolve(db);
      };
      request.onerror = () => {
        clearTimeout(timer);
        settled = true;
        reject(request.error || new Error("Impossible d’ouvrir le stockage local."));
      };
    }).finally(() => { opening = null; });
    return opening;
  }

  async function transact(mode, execute) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const db = await open();
      let transactionStarted = false;
      try {
        return await new Promise((resolve, reject) => {
          const transaction = db.transaction(storeName, mode);
          transactionStarted = true;
          const timer = setTimeout(() => {
            reject(new DOMException("Le stockage local ne répond pas. Gardez cette page ouverte et exportez votre copie mémoire.", "TimeoutError"));
            transaction.abort();
            invalidate(db);
          }, timeoutMs);
          let result;
          transaction.oncomplete = () => { clearTimeout(timer); resolve(result?.result); };
          transaction.onabort = () => { clearTimeout(timer); reject(transaction.error || new DOMException("Enregistrement interrompu.", "AbortError")); };
          transaction.onerror = () => { /* onabort reports the final transaction outcome. */ };
          try { result = execute(transaction.objectStore(storeName)); }
          catch (error) { clearTimeout(timer); transaction.abort(); reject(error); }
        });
      } catch (error) {
        const stale = error.name === "InvalidStateError" && !transactionStarted;
        const aborted = error.name === "AbortError";
        if (attempt || (!stale && !aborted)) throw error;
        invalidate(db);
      }
    }
  }

  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  return {
    open,
    read: () => enqueue(() => transact("readonly", (store) => store.getAll())),
    write(records) {
      const snapshot = structuredClone(records);
      return enqueue(() => transact("readwrite", (store) => { snapshot.forEach((record) => store.put(record)); }));
    },
    delete: (id) => enqueue(() => transact("readwrite", (store) => store.delete(id))),
  };
}
