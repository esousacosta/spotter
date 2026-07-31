import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addToWatchlist,
  isInWatchlist,
  loadWatchlist,
  removeFromWatchlist,
  saveWatchlist,
} from "./watchlist";

function storageMock() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
    clear: vi.fn(() => values.clear()),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    get length() {
      return values.size;
    },
  };
}

describe("watchlist", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: storageMock() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists normalized unique symbols", () => {
    saveWatchlist([" aapl ", "MSFT", "AAPL"]);
    expect(loadWatchlist()).toEqual(["AAPL", "MSFT"]);
  });

  it("adds, removes, and checks symbols", () => {
    addToWatchlist("aapl");
    addToWatchlist("msft");
    expect(isInWatchlist("AAPL")).toBe(true);

    removeFromWatchlist("aapl");
    expect(loadWatchlist()).toEqual(["MSFT"]);
  });

  it("recovers from malformed persisted data", () => {
    window.localStorage.setItem("fvs:watchlist", "{bad json");
    expect(loadWatchlist()).toEqual([]);
  });
});
