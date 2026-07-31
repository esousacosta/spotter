import { beforeEach, describe, expect, it, vi } from "vitest";

const { getForwardTradeAnalyticsMock } = vi.hoisted(() => ({
  getForwardTradeAnalyticsMock: vi.fn(),
}));

vi.mock("@/lib/server/forward-trade-analytics-service", () => ({
  ForwardTradeAnalyticsError: class ForwardTradeAnalyticsError extends Error {
    readonly status: number;

    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  },
  getForwardTradeAnalytics: getForwardTradeAnalyticsMock,
}));

import { ForwardTradeAnalyticsError } from "@/lib/server/forward-trade-analytics-service";
import { POST } from "./route";

describe("/api/forward-trade-analytics", () => {
  beforeEach(() => {
    getForwardTradeAnalyticsMock.mockReset();
  });

  it("returns 400 on invalid schema", async () => {
    const request = new Request("http://localhost/api/forward-trade-analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: "AAPL" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("returns payload on valid request", async () => {
    getForwardTradeAnalyticsMock.mockResolvedValue({
      symbol: "AAPL",
      asOf: "2026-01-01T00:00:00.000Z",
      valuationDate: "2026-09-18T16:00:00.000Z",
      spot: 100,
      strike: 100,
      shortExpiry: "2026-09-18",
      longExpiry: "2026-10-16",
      rates: { r: 0.045, q: null, source: "constant-rate-phase-1" },
      assumptions: {
        pricingModel: "Black-Scholes-European",
        contracts: 1,
        multiplier: 100,
        popMethod: "lognormal_terminal",
      },
      profile: {
        maxProfit: 200,
        maxLoss: -90,
        breakEven: 102.2,
        returnRisk: 2.2,
        probabilityOfProfit: 0.53,
      },
      greeksNow: { delta: 5, gamma: 0.2, theta: -0.4, vega: 8, rho: 1.2 },
      scenarios: [],
      chart: { xUnderlying: [], yPnl: [] },
      warnings: [],
    });

    const request = new Request("http://localhost/api/forward-trade-analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "AAPL",
        shortExpiry: "2026-09-18",
        longExpiry: "2026-10-16",
        strike: 100,
      }),
    });

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.symbol).toBe("AAPL");
  });

  it("maps missing-contract failures to 422", async () => {
    getForwardTradeAnalyticsMock.mockRejectedValue(
      new ForwardTradeAnalyticsError("Short-expiry contract not found.", 422),
    );

    const request = new Request("http://localhost/api/forward-trade-analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "AAPL",
        shortExpiry: "2026-09-18",
        longExpiry: "2026-10-16",
        strike: 100,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(422);
    const payload = await response.json();
    expect(payload.error).toContain("not found");
  });
});
