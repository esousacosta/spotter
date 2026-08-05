import { describe, expect, it } from "vitest";

import { normalizeWatchlistSymbol, watchlistSymbolsSchema } from "@/lib/watchlist-symbol";

describe("watchlist symbol validation", () => {
  it("normalizes supported ticker formats", () => {
    expect(normalizeWatchlistSymbol(" brk.b ")).toBe("BRK.B");
  });

  it("rejects invalid and oversized symbols", () => {
    expect(() => normalizeWatchlistSymbol("not a ticker")).toThrow();
    expect(() => normalizeWatchlistSymbol("ABCDEFGHIJK")).toThrow();
  });

  it("deduplicates and sorts bulk symbols", () => {
    expect(watchlistSymbolsSchema.parse(["msft", "AAPL", "MSFT"])).toEqual(["AAPL", "MSFT"]);
  });
});
