import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type CacheEntry<T> = {
  expiresAtMs: number;
  value: T;
};

const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), "forward-vol-spotter-cache");
const CACHE_DIR = process.env.CACHE_DIR?.trim() || DEFAULT_CACHE_DIR;
const CACHE_EXTENSION = ".json";

const memoryCache = new Map<string, CacheEntry<unknown>>();
const inflightLoads = new Map<string, Promise<unknown>>();

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
        const parsed = JSON.parse(raw) as { key?: string; expiresAtMs?: number; value?: unknown };
        if (
          typeof parsed.key !== "string" ||
          typeof parsed.expiresAtMs !== "number" ||
          !Number.isFinite(parsed.expiresAtMs)
        ) {
          continue;
        }
        if (parsed.expiresAtMs <= now) {
          continue;
        }

        memoryCache.set(parsed.key, {
          expiresAtMs: parsed.expiresAtMs,
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
      key,
      expiresAtMs: entry.expiresAtMs,
      value: entry.value,
    },
    null,
    0,
  );
  const filePath = toCacheFilePath(key);
  await fs.promises.writeFile(filePath, payload, "utf8");
}

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
    .then(async (value) => {
      const entry: CacheEntry<unknown> = {
        value,
        expiresAtMs: Date.now() + ttlMs,
      };
      memoryCache.set(key, entry);
      inflightLoads.delete(key);

      try {
        await persistCacheEntry(key, entry);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown disk cache error";
        console.warn(`[cache] failed to persist key "${key}" to disk: ${message}`);
      }

      return value;
    })
    .catch((error) => {
      inflightLoads.delete(key);
      throw error;
    });

  inflightLoads.set(key, loadPromise);
  return loadPromise;
}

export function getCacheDirectoryPath(): string {
  return CACHE_DIR;
}
