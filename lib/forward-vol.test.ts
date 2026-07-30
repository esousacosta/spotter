import { describe, expect, it } from "vitest";

import { chooseExpiryPair, computeForwardVolMetrics } from "./forward-vol";

describe("computeForwardVolMetrics", () => {
  it("computes a valid forward volatility edge", () => {
    const result = computeForwardVolMetrics(0.32, 0.28, 30, 60);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.forwardVol).toBeGreaterThan(0);
      expect(result.forwardVolEdge).toBeTypeOf("number");
    }
  });

  it("marks negative forward variance as invalid", () => {
    const result = computeForwardVolMetrics(0.7, 0.1, 30, 60);
    expect(result.status).toBe("invalid");
  });

  it("rejects non-increasing tenors", () => {
    const result = computeForwardVolMetrics(0.3, 0.35, 60, 60);
    expect(result.status).toBe("invalid");
  });
});

describe("chooseExpiryPair", () => {
  const base = new Date("2026-01-01T00:00:00.000Z");
  const day = 24 * 60 * 60;

  it("chooses nearest pair while respecting minimum gap", () => {
    const expirations = [28, 36, 63, 91].map((d) => Math.floor(base.getTime() / 1000) + d * day);
    const result = chooseExpiryPair(expirations, { shortDte: 30, longDte: 60 }, 7, base);
    expect(result).not.toBeNull();
    expect(result?.short.dteDays).toBeCloseTo(28, 6);
    expect(result?.long.dteDays).toBeCloseTo(63, 6);
  });
});
