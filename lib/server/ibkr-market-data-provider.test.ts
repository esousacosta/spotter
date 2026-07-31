import { afterEach, describe, expect, it, vi } from "vitest";

import {
  expiryDateToUnix,
  filterStrikesInRange,
  parseSnapshotField,
  parseMonthCode,
  isMonthInRange,
  selectAtmStrikes,
} from "./ibkr-market-data-provider";
import {
  generateOptionMonths,
  selectNextMarketDataPriority,
  toIbkrSymbol,
} from "./ibkr-client";
import { getCachedIbkrMetadata, getIbkrMetadataCacheMetrics } from "./ibkr-market-data-provider";

describe("toIbkrSymbol", () => {
  it("converts dotted class-share tickers to IBKR's space format", () => {
    expect(toIbkrSymbol("brk.b")).toBe("BRK B");
  });

  describe("IBKR scheduling and metadata caching", () => {
    it("serves background work after a bounded interactive burst", () => {
      expect(selectNextMarketDataPriority(2, 1, 3)).toBe("interactive");
      expect(selectNextMarketDataPriority(2, 1, 4)).toBe("background");
    });

    it("avoids repeating metadata discovery on the second load", async () => {
      const loader = vi.fn(async () => ({ conid: "123" }));
      const key = `test-${Date.now()}-${Math.random()}`;
      const before = getIbkrMetadataCacheMetrics();

      await getCachedIbkrMetadata(key, loader);
      await getCachedIbkrMetadata(key, loader);

      const after = getIbkrMetadataCacheMetrics();
      expect(loader).toHaveBeenCalledTimes(1);
      expect(after.misses - before.misses).toBe(1);
      expect(after.hits - before.hits).toBe(1);
    });
  });
});

describe("expiryDateToUnix", () => {
  it("converts YYYYMMDD to Unix timestamp at noon UTC", () => {
    const result = expiryDateToUnix("20260821");
    const expected = Math.floor(Date.UTC(2026, 7, 21, 12, 0, 0) / 1000);
    expect(result).toBe(expected);
  });

  it("converts a January date correctly", () => {
    const result = expiryDateToUnix("20250117");
    const expected = Math.floor(Date.UTC(2025, 0, 17, 12, 0, 0) / 1000);
    expect(result).toBe(expected);
  });

  it("converts a December date correctly", () => {
    const result = expiryDateToUnix("20271219");
    const expected = Math.floor(Date.UTC(2027, 11, 19, 12, 0, 0) / 1000);
    expect(result).toBe(expected);
  });
});

describe("parseSnapshotField", () => {
  it("returns a number as-is when finite", () => {
    expect(parseSnapshotField(24.5)).toBe(24.5);
  });

  it("parses a numeric string", () => {
    expect(parseSnapshotField("24.5")).toBe(24.5);
  });

  it("strips $ and , from strings", () => {
    expect(parseSnapshotField("$1,234.56")).toBe(1234.56);
  });

  it("parses IBKR percentage strings", () => {
    expect(parseSnapshotField("30.5%")).toBe(30.5);
  });

  it("returns null for non-numeric string", () => {
    expect(parseSnapshotField("N/A")).toBeNull();
  });

  describe("selectAtmStrikes", () => {
    it("selects the closest strikes available for calls and puts across the most months", () => {
      const months = [
        { call: [95, 100, 105], put: [95, 100, 105] },
        { call: [90, 100, 110], put: [90, 100, 110] },
        { call: [95, 100, 105], put: [95, 100, 105] },
      ];

      expect(selectAtmStrikes(months, 102, 2)).toEqual([100, 105]);
    });

    it("ignores strikes that are not available for both rights", () => {
      const months = [{ call: [100, 105], put: [95, 100] }];
      expect(selectAtmStrikes(months, 104, 2)).toEqual([100]);
    });
  });

  it("returns null for null/undefined", () => {
    expect(parseSnapshotField(null)).toBeNull();
    expect(parseSnapshotField(undefined)).toBeNull();
  });

  it("returns null for Infinity", () => {
    expect(parseSnapshotField(Infinity)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSnapshotField("")).toBeNull();
  });

  it("IV percentage: value 24.5 divided by 100 equals 0.245 (caller responsibility)", () => {
    // parseSnapshotField returns the raw value; the provider divides by 100
    const raw = parseSnapshotField("24.5");
    expect(raw).toBe(24.5);
    expect((raw as number) / 100).toBeCloseTo(0.245);
  });
});

describe("filterStrikesInRange", () => {
  it("keeps only strikes within ±30% of spot", () => {
    const spot = 100;
    const strikes = [60, 70, 75, 80, 90, 100, 110, 120, 125, 130, 135];
    const result = filterStrikesInRange(strikes, spot);
    expect(result).toEqual([70, 75, 80, 90, 100, 110, 120, 125, 130]);
  });

  it("includes boundary strikes (exactly 70% and 130% of spot)", () => {
    const spot = 100;
    expect(filterStrikesInRange([70, 130], spot)).toEqual([70, 130]);
  });

  it("excludes strikes outside the range", () => {
    const spot = 100;
    expect(filterStrikesInRange([69.99, 130.01], spot)).toEqual([]);
  });

  it("returns empty array when no strikes are in range", () => {
    expect(filterStrikesInRange([10, 20, 200, 300], 100)).toEqual([]);
  });

  it("handles empty input", () => {
    expect(filterStrikesInRange([], 100)).toEqual([]);
  });
});

describe("getOptionDataProvider provider selection", () => {
  const originalEnv = process.env.IBKR_ENABLED;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.IBKR_ENABLED;
    } else {
      process.env.IBKR_ENABLED = originalEnv;
    }
    vi.resetModules();
  });

  it("returns the IBKR provider when IBKR_ENABLED=true", async () => {
    process.env.IBKR_ENABLED = "true";
    const { getOptionDataProvider } = await import("./market-data-provider");
    const { ibkrMarketDataProvider } = await import("./ibkr-market-data-provider");
    const provider = getOptionDataProvider();
    expect(provider).toBe(ibkrMarketDataProvider);
  });

  it("returns the Cboe provider when IBKR_ENABLED=false", async () => {
    process.env.IBKR_ENABLED = "false";
    const { getOptionDataProvider, marketDataProvider } = await import("./market-data-provider");
    const provider = getOptionDataProvider();
    // Not the IBKR provider — wraps marketDataProvider methods
    expect(provider).not.toBe(marketDataProvider);
    expect(typeof provider.getOptionSnapshot).toBe("function");
  });

  it("returns the Cboe provider when IBKR_ENABLED is unset", async () => {
    delete process.env.IBKR_ENABLED;
    const { getOptionDataProvider } = await import("./market-data-provider");
    const { ibkrMarketDataProvider } = await import("./ibkr-market-data-provider");
    const provider = getOptionDataProvider();
    expect(provider).not.toBe(ibkrMarketDataProvider);
  });
});

describe("parseMonthCode", () => {
  it("parses a 2-digit year code", () => {
    expect(parseMonthCode("AUG25")).toEqual({ year: 2025, month: 8 });
  });

  it("parses different months", () => {
    expect(parseMonthCode("JAN25")).toEqual({ year: 2025, month: 1 });
    expect(parseMonthCode("DEC26")).toEqual({ year: 2026, month: 12 });
  });

  it("returns null for invalid abbreviation", () => {
    expect(parseMonthCode("XYZ25")).toBeNull();
  });
});

describe("isMonthInRange", () => {
  it("includes a month fully within the range", () => {
    const start = Date.UTC(2025, 7, 1); // Aug 1 2025
    const end = Date.UTC(2025, 9, 31); // Oct 31 2025
    expect(isMonthInRange("SEP25", start, end)).toBe(true);
  });

  it("excludes a month completely before the range", () => {
    const start = Date.UTC(2025, 8, 1); // Sep 1 2025
    const end = Date.UTC(2025, 10, 30); // Nov 30 2025
    expect(isMonthInRange("AUG25", start, end)).toBe(false);
  });

  it("excludes a month completely after the range", () => {
    const start = Date.UTC(2025, 6, 1); // Jul 1 2025
    const end = Date.UTC(2025, 7, 31); // Aug 31 2025
    expect(isMonthInRange("SEP25", start, end)).toBe(false);
  });
});

describe("generateOptionMonths", () => {
  it("generates month codes covering the full window", () => {
    const start = Date.UTC(2026, 6, 31); // Jul 31 2026
    const end = Date.UTC(2026, 9, 29);   // Oct 29 2026 (~90 days)
    const months = generateOptionMonths(start, end);
    expect(months).toEqual(["JUL26", "AUG26", "SEP26", "OCT26"]);
  });

  it("includes the start month even if start is mid-month", () => {
    const start = Date.UTC(2026, 7, 15); // Aug 15 2026
    const end = Date.UTC(2026, 8, 1);    // Sep 1 2026
    const months = generateOptionMonths(start, end);
    expect(months).toContain("AUG26");
    expect(months).toContain("SEP26");
  });

  it("returns a single month when start and end are in the same month", () => {
    const start = Date.UTC(2026, 7, 1);  // Aug 1 2026
    const end = Date.UTC(2026, 7, 20);   // Aug 20 2026
    expect(generateOptionMonths(start, end)).toEqual(["AUG26"]);
  });
});
