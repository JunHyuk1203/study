// A small, account-scoped response cache. Storage failure must never block study.
export function createReadCache({storage, now = Date.now} = {}) {
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch {} }
  const prefix = 'study-read-v1:', memory = new Map();
  return {
    get(key) {
      try {
        const saved = storage ? JSON.parse(storage.getItem(prefix + key) || 'null') : memory.get(key);
        if (saved && saved.expires > now()) return saved.value;
      } catch {}
      return undefined;
    },
    set(key, value, ttl) {
      const saved = {value, expires: now() + Math.max(0, ttl)};
      memory.set(key, saved);
      try { storage?.setItem(prefix + key, JSON.stringify(saved)); } catch { storage = null; }
      // Bound memory and local storage, including entries from previous dates.
      if (memory.size > 100) memory.delete(memory.keys().next().value);
      try {
        const keys = Object.keys(storage || {}).filter(key => key.startsWith(prefix));
        for (const name of keys) if (JSON.parse(storage.getItem(name) || 'null')?.expires <= now()) storage.removeItem(name);
      } catch {}
      return value;
    },
    remove(key) { memory.delete(key); try { storage?.removeItem(prefix + key); } catch {} },
  };
}
export const readCache = createReadCache();
