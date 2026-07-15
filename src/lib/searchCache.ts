type Entry<T> = { at: number; data: T };

const store = new Map<string, Entry<unknown>>();
const TTL = 90_000;

export function cacheGet<T>(key: string): T | null {
  const e = store.get(key);
  if (!e) return null;
  if (Date.now() - e.at > TTL) {
    store.delete(key);
    return null;
  }
  return e.data as T;
}

export function cacheSet<T>(key: string, data: T) {
  store.set(key, { at: Date.now(), data });
  if (store.size > 80) {
    const first = store.keys().next().value;
    if (first) store.delete(first);
  }
}

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
