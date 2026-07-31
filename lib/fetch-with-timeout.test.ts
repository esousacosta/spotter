import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithTimeout } from "./fetch-with-timeout";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe("fetchWithTimeout", () => {
  it("returns response when fetch resolves before timeout", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const response = await fetchWithTimeout("https://example.test", {}, 1_000);
    const payload = (await response.json()) as { ok: boolean };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
  });

  it("throws timeout error when fetch hangs", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const pending = fetchWithTimeout("https://example.test", {}, 500);
    const assertion = expect(pending).rejects.toThrow("Request timed out after 500ms.");
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it("preserves an external abort instead of reporting a timeout", async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const pending = fetchWithTimeout(
      "https://example.test",
      { signal: controller.signal },
      1_000,
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
