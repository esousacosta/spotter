type CacheEntry<T> = {
  expiresAtMs: number;
  value: T;
};

const memoryCache = new Map<string, CacheEntry<unknown>>();

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

  const value = await loader();
  memoryCache.set(key, { value, expiresAtMs: now + ttlMs });
  return value;
}
