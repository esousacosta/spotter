import { describe, expect, it, vi } from "vitest";

import { getCached } from "./cache";

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
});
