import { afterEach, describe, expect, it, vi } from "vitest";

import { marketDataProvider } from "./market-data-provider";

import {
  ForwardTradeAnalyticsError,
  blackScholesCallMetrics,
  computeForwardTradeAnalytics,
  gatherBreakEvenPoints,
  popFromScenarioCurve,
} from "./forward-trade-analytics-service";

describe("forward-trade-analytics service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("computes Black-Scholes call metrics with expected signs", () => {
    const metrics = blackScholesCallMetrics(100, 100, 30 / 365, 0.25, 0.04, 0);
    expect(metrics.price).toBeGreaterThan(0);
    expect(metrics.delta).toBeGreaterThan(0.4);
    expect(metrics.delta).toBeLessThan(0.7);
    expect(metrics.gamma).toBeGreaterThan(0);
    expect(metrics.vega).toBeGreaterThan(0);
  });

  it("finds break-even by interpolation", () => {
    const roots = gatherBreakEvenPoints([90, 100, 110], [-8, -2, 4]);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toBeCloseTo(103.333333, 5);
  });

  it("shows lower POP when break-even shifts higher", () => {
    const underlyings = [80, 90, 100, 110, 120];
    const easierPnls = [-5, -1, 2, 6, 11];
    const harderPnls = [-9, -4, -1, 2, 7];
    const easyPop = popFromScenarioCurve(underlyings, easierPnls, 100, 30 / 365, 0.04, 0, 0.3);
    const hardPop = popFromScenarioCurve(underlyings, harderPnls, 100, 30 / 365, 0.04, 0, 0.3);
    expect(easyPop).not.toBeNull();
    expect(hardPop).not.toBeNull();
    expect((easyPop ?? 0) > (hardPop ?? 1)).toBe(true);
  });

  it("returns full analytics payload for a valid request", async () => {
    const shortExpiry = "2026-09-18";
    const longExpiry = "2026-10-16";
    const shortExpiryUnix = Math.floor(Date.UTC(2026, 8, 18, 12, 0, 0) / 1000);
    const longExpiryUnix = Math.floor(Date.UTC(2026, 9, 16, 12, 0, 0) / 1000);

    vi.spyOn(marketDataProvider, "getOptionSnapshot").mockResolvedValue({
      spotPrice: 100,
      expirations: [shortExpiryUnix, longExpiryUnix],
      volume: null,
    });

    vi.spyOn(marketDataProvider, "getOptionChainCalls").mockImplementation(async (_symbol, expiryUnix) => {
      if (expiryUnix === shortExpiryUnix) {
        return [{ strike: 100, impliedVolatility: 0.24, openInterest: 500, bid: 2.1, ask: 2.5 }];
      }
      if (expiryUnix === longExpiryUnix) {
        return [{ strike: 100, impliedVolatility: 0.3, openInterest: 900, bid: 3.8, ask: 4.2 }];
      }
      return [];
    });

    const payload = await computeForwardTradeAnalytics({
      symbol: "AAPL",
      shortExpiry,
      longExpiry,
      strike: 100,
      steps: 21,
    });

    expect(payload.symbol).toBe("AAPL");
    expect(payload.profile.probabilityOfProfit).not.toBeNull();
    expect(payload.greeksNow.delta).toBeTypeOf("number");
    expect(payload.scenarios).toHaveLength(21);
    expect(payload.chart.yPnl).toHaveLength(21);
  });

  it("adds warnings when bid/ask data is missing", async () => {
    const shortExpiryUnix = Math.floor(Date.UTC(2026, 8, 18, 12, 0, 0) / 1000);
    const longExpiryUnix = Math.floor(Date.UTC(2026, 9, 16, 12, 0, 0) / 1000);
    vi.spyOn(marketDataProvider, "getOptionSnapshot").mockResolvedValue({
      spotPrice: 100,
      expirations: [shortExpiryUnix, longExpiryUnix],
      volume: null,
    });
    vi.spyOn(marketDataProvider, "getOptionChainCalls").mockImplementation(async (_symbol, expiryUnix) => {
      if (expiryUnix === shortExpiryUnix) {
        return [{ strike: 100, impliedVolatility: 0.24, openInterest: 500, bid: null, ask: null }];
      }
      return [{ strike: 100, impliedVolatility: 0.3, openInterest: 900, bid: 3.8, ask: 4.2 }];
    });

    const payload = await computeForwardTradeAnalytics({
      symbol: "AAPL",
      shortExpiry: "2026-09-18",
      longExpiry: "2026-10-16",
      strike: 100,
    });

    expect(payload.warnings.some((warning) => warning.includes("Missing bid/ask"))).toBe(true);
  });

  it("throws 422 when a contract is missing", async () => {
    vi.spyOn(marketDataProvider, "getOptionSnapshot").mockResolvedValue({
      spotPrice: 100,
      expirations: [],
      volume: null,
    });
    vi.spyOn(marketDataProvider, "getOptionChainCalls").mockResolvedValue([]);

    await expect(
      computeForwardTradeAnalytics({
        symbol: "AAPL",
        shortExpiry: "2026-09-18",
        longExpiry: "2026-10-16",
        strike: 100,
      }),
    ).rejects.toMatchObject<ForwardTradeAnalyticsError>({
      status: 422,
    });
  });
});
