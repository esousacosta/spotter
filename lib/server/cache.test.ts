import { afterEach, describe, expect, it, vi } from "vitest";

import { clearAppCache, getCached, getCachedStaleWhileRevalidate } from "./cache";

afterEach(() => {
  vi.useRealTimers();
});

describe("getCached", () => {
  it("deduplicates concurrent loads for the same key", async () => {
    const cacheKey = `dedupe-key-${Date.now()}-${Math.random()}`;
    const loader = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: true };
    });

    const [first, second, third] = await Promise.all([
      getCached(cacheKey, 1_000, loader),
      getCached(cacheKey, 1_000, loader),
      getCached(cacheKey, 1_000, loader),
    ]);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(third).toEqual({ ok: true });
  });

  it("does not let a cleared load remove a newer in-flight load", async () => {
    const cacheKey = `clear-race-key-${Date.now()}-${Math.random()}`;
    let resolveOld!: (value: string) => void;
    let resolveNew!: (value: string) => void;
    const oldLoad = getCached(
      cacheKey,
      1_000,
      () => new Promise<string>((resolve) => {
        resolveOld = resolve;
      }),
    );

    await clearAppCache();

    const newLoader = vi.fn(
      () => new Promise<string>((resolve) => {
        resolveNew = resolve;
      }),
    );
    const newLoad = getCached(cacheKey, 1_000, newLoader);
    resolveOld("old");
    await oldLoad;

    const deduplicatedLoad = getCached(cacheKey, 1_000, newLoader);
    expect(newLoader).toHaveBeenCalledTimes(1);

    resolveNew("new");
    await expect(Promise.all([newLoad, deduplicatedLoad])).resolves.toEqual(["new", "new"]);
  });

  it("returns stale data immediately while refreshing it once", async () => {
    vi.useFakeTimers();
    const cacheKey = `swr-key-${Date.now()}-${Math.random()}`;
    await getCachedStaleWhileRevalidate(cacheKey, 100, 1_000, async () => "old");
    await vi.advanceTimersByTimeAsync(101);

    let resolveRefresh!: (value: string) => void;
    const loader = vi.fn(
      () => new Promise<string>((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const first = await getCachedStaleWhileRevalidate(cacheKey, 100, 1_000, loader);
    const second = await getCachedStaleWhileRevalidate(cacheKey, 100, 1_000, loader);

    expect(first).toEqual({ value: "old", isStale: true });
    expect(second).toEqual({ value: "old", isStale: true });
    expect(loader).toHaveBeenCalledTimes(1);

    resolveRefresh("new");
    await vi.runAllTimersAsync();
    await expect(
      getCachedStaleWhileRevalidate(cacheKey, 100, 1_000, loader),
    ).resolves.toEqual({ value: "new", isStale: false });
  });
});
