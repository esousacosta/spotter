type CacheEntry<T> = {
  expiresAtMs: number;
  value: T;
};

const memoryCache = new Map<string, CacheEntry<unknown>>();
const inflightLoads = new Map<string, Promise<unknown>>();

export async function getCached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const existing = memoryCache.get(key);

  if (existing && existing.expiresAtMs > now) {
    return existing.value as T;
  }

  const inflight = inflightLoads.get(key);
  if (inflight) {
    return inflight as Promise<T>;
  }

  const loadPromise = loader()
    .then((value) => {
      memoryCache.set(key, { value, expiresAtMs: Date.now() + ttlMs });
      inflightLoads.delete(key);
      return value;
    })
    .catch((error) => {
      inflightLoads.delete(key);
      throw error;
    });

  inflightLoads.set(key, loadPromise);
  return loadPromise;
}
