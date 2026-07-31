import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type CacheEntry<T> = {
  expiresAtMs: number;
  staleUntilMs: number;
  value: T;
};

export type StaleCacheResult<T> = {
  value: T;
  isStale: boolean;
};

const CACHE_FILE_FORMAT_VERSION = 3;
const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), "forward-vol-spotter-cache");
const CACHE_DIR = process.env.CACHE_DIR?.trim() || DEFAULT_CACHE_DIR;
const CACHE_EXTENSION = ".json";

const memoryCache = new Map<string, CacheEntry<unknown>>();
const inflightLoads = new Map<string, Promise<unknown>>();
let cacheGeneration = 0;

function toCacheFileName(key: string): string {
  return `${Buffer.from(key).toString("base64url")}${CACHE_EXTENSION}`;
}

function toCacheFilePath(key: string): string {
  return path.join(CACHE_DIR, toCacheFileName(key));
}

function ensureCacheDir(): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch {
    // Runtime cache still works in-memory if disk setup fails.
  }
}

function cacheJsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return {
      __cacheType: "Map",
      entries: [...value.entries()],
    };
  }
  if (value instanceof Set) {
    return {
      __cacheType: "Set",
      values: [...value.values()],
    };
  }
  return value;
}

function cacheJsonReviver(_key: string, value: unknown): unknown {
  const objectValue = value as Record<string, unknown> | null;
  if (
    objectValue &&
    objectValue.__cacheType === "Map" &&
    Array.isArray(objectValue.entries)
  ) {
    return new Map((objectValue.entries as unknown[]) as Array<[unknown, unknown]>);
  }

  if (
    objectValue &&
    objectValue.__cacheType === "Set" &&
    Array.isArray(objectValue.values)
  ) {
    return new Set(objectValue.values as unknown[]);
  }

  return value;
}

function loadDiskCacheIntoMemory(): void {
  ensureCacheDir();

  let loadedCount = 0;
  try {
    const files = fs.readdirSync(CACHE_DIR);
    const now = Date.now();
    for (const file of files) {
      if (!file.endsWith(CACHE_EXTENSION)) {
        continue;
      }

      const fullPath = path.join(CACHE_DIR, file);
      try {
        const raw = fs.readFileSync(fullPath, "utf8");
        const parsed = JSON.parse(raw, cacheJsonReviver) as {
          formatVersion?: number;
          key?: string;
          expiresAtMs?: number;
          staleUntilMs?: number;
          value?: unknown;
        };
        if (parsed.formatVersion !== CACHE_FILE_FORMAT_VERSION) {
          continue;
        }
        if (
          typeof parsed.key !== "string" ||
          typeof parsed.expiresAtMs !== "number" ||
          !Number.isFinite(parsed.expiresAtMs) ||
          typeof parsed.staleUntilMs !== "number" ||
          !Number.isFinite(parsed.staleUntilMs)
        ) {
          continue;
        }
        if (parsed.staleUntilMs <= now) {
          continue;
        }

        memoryCache.set(parsed.key, {
          expiresAtMs: parsed.expiresAtMs,
          staleUntilMs: parsed.staleUntilMs,
          value: parsed.value,
        });
        loadedCount += 1;
      } catch {
        continue;
      }
    }
  } catch {
    // Ignore disk warmup failures; cache still functions in memory.
  }

  if (loadedCount > 0) {
    console.info(`[cache] loaded ${loadedCount} non-expired entries from ${CACHE_DIR}`);
  }
}

loadDiskCacheIntoMemory();

async function persistCacheEntry(key: string, entry: CacheEntry<unknown>): Promise<void> {
  ensureCacheDir();
  const payload = JSON.stringify(
    {
      formatVersion: CACHE_FILE_FORMAT_VERSION,
      key,
      expiresAtMs: entry.expiresAtMs,
      staleUntilMs: entry.staleUntilMs,
      value: entry.value,
    },
    cacheJsonReplacer,
  );
  const filePath = toCacheFilePath(key);
  await fs.promises.writeFile(filePath, payload, "utf8");
}

function startCacheLoad<T>(
  key: string,
  ttlMs: number,
  staleTtlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const loadGeneration = cacheGeneration;
  const clearOwnInflightLoad = (): void => {
    if (inflightLoads.get(key) === loadPromise) {
      inflightLoads.delete(key);
    }
  };
  const loadPromise = loader()
    .then(async (value) => {
      if (loadGeneration !== cacheGeneration) {
        clearOwnInflightLoad();
        return value;
      }
      const entry: CacheEntry<unknown> = {
        value,
        expiresAtMs: Date.now() + ttlMs,
        staleUntilMs: Date.now() + ttlMs + staleTtlMs,
      };
      memoryCache.set(key, entry);
      clearOwnInflightLoad();

      try {
        await persistCacheEntry(key, entry);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown disk cache error";
        console.warn(`[cache] failed to persist key "${key}" to disk: ${message}`);
      }

      return value;
    })
    .catch((error) => {
      clearOwnInflightLoad();
      throw error;
    });

  inflightLoads.set(key, loadPromise);
  return loadPromise;
}

export async function getCached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const existing = memoryCache.get(key);
  if (existing && existing.expiresAtMs > Date.now()) {
    return existing.value as T;
  }

  const inflight = inflightLoads.get(key);
  return inflight ? (inflight as Promise<T>) : startCacheLoad(key, ttlMs, 0, loader);
}

export async function getCachedStaleWhileRevalidate<T>(
  key: string,
  ttlMs: number,
  staleTtlMs: number,
  loader: () => Promise<T>,
): Promise<StaleCacheResult<T>> {
  const now = Date.now();
  const existing = memoryCache.get(key);
  if (existing && existing.expiresAtMs > now) {
    return { value: existing.value as T, isStale: false };
  }

  const inflight = inflightLoads.get(key) as Promise<T> | undefined;
  if (existing && existing.staleUntilMs > now) {
    if (!inflight) {
      void startCacheLoad(key, ttlMs, staleTtlMs, loader).catch((error) => {
        const message = error instanceof Error ? error.message : "unknown refresh error";
        console.warn(`[cache] stale refresh failed for "${key}": ${message}`);
      });
    }
    return { value: existing.value as T, isStale: true };
  }

  const value = await (inflight ?? startCacheLoad(key, ttlMs, staleTtlMs, loader));
  return { value, isStale: false };
}

export async function deleteCached(key: string): Promise<void> {
  memoryCache.delete(key);
  inflightLoads.delete(key);
  try {
    await fs.promises.unlink(toCacheFilePath(key));
  } catch {
    // Missing cache files require no action.
  }
}

export function getCacheStatus(key: string): "fresh" | "stale" | "missing" {
  const entry = memoryCache.get(key);
  if (!entry) return "missing";
  const now = Date.now();
  if (entry.expiresAtMs > now) return "fresh";
  return entry.staleUntilMs > now ? "stale" : "missing";
}

export function getCacheDirectoryPath(): string {
  return CACHE_DIR;
}

export async function clearAppCache(): Promise<{
  memoryEntriesCleared: number;
  inflightLoadsCleared: number;
  diskFilesDeleted: number;
}> {
  cacheGeneration += 1;
  const memoryEntriesCleared = memoryCache.size;
  const inflightLoadsCleared = inflightLoads.size;
  memoryCache.clear();
  inflightLoads.clear();

  let diskFilesDeleted = 0;
  ensureCacheDir();
  try {
    const files = await fs.promises.readdir(CACHE_DIR);
    for (const file of files) {
      if (!file.endsWith(CACHE_EXTENSION)) {
        continue;
      }
      try {
        await fs.promises.unlink(path.join(CACHE_DIR, file));
        diskFilesDeleted += 1;
      } catch {
        continue;
      }
    }
  } catch {
    // Ignore disk cleanup failures; in-memory cache has already been cleared.
  }

  return {
    memoryEntriesCleared,
    inflightLoadsCleared,
    diskFilesDeleted,
  };
}
