import { describe, expect, it } from "vitest";

import { bidAskSpreadPct, computeLiquidityScore } from "./forward-vol-service";

describe("bidAskSpreadPct", () => {
  it("returns null when bid or ask is null", () => {
    expect(bidAskSpreadPct(null, 10)).toBeNull();
    expect(bidAskSpreadPct(9, null)).toBeNull();
    expect(bidAskSpreadPct(null, null)).toBeNull();
  });

  it("returns null when bid/ask are non-positive", () => {
    expect(bidAskSpreadPct(0, 10)).toBeNull();
    expect(bidAskSpreadPct(-1, 10)).toBeNull();
  });

  it("returns null when ask < bid", () => {
    expect(bidAskSpreadPct(10, 9)).toBeNull();
  });

  it("computes spread correctly", () => {
    // bid=9, ask=11 → mid=10, spread=2/10=0.2
    expect(bidAskSpreadPct(9, 11)).toBeCloseTo(0.2);
    // bid=99, ask=101 → mid=100, spread=2/100=0.02
    expect(bidAskSpreadPct(99, 101)).toBeCloseTo(0.02);
  });

  it("returns 0 for zero-width spread", () => {
    expect(bidAskSpreadPct(10, 10)).toBeCloseTo(0);
  });
});

describe("computeLiquidityScore", () => {
  it("returns 0.5 neutral when all inputs are null", () => {
    expect(computeLiquidityScore(null, null, null, null)).toBeCloseTo(0.5);
  });

  it("gives high score for good OI and tight spreads", () => {
    // OI=1000 (well above GOOD_OI_THRESHOLD=500), spreads=2% (below MAX=25%)
    const score = computeLiquidityScore(1000, 1000, 0.02, 0.02);
    expect(score).toBeGreaterThan(0.85);
  });

  it("gives low score for low OI and wide spreads", () => {
    // OI=50 (below MIN=100 → oiScore=0), spreads=30% (above MAX=25% → spreadScore=0)
    const score = computeLiquidityScore(50, 50, 0.30, 0.30);
    expect(score).toBeLessThan(0.1);
  });

  it("uses minimum of both OI legs", () => {
    // One very good leg, one very poor leg → bottleneck by the min
    const highLow = computeLiquidityScore(2000, 50, 0.05, 0.05);
    const bothGood = computeLiquidityScore(1000, 1000, 0.05, 0.05);
    expect(highLow).toBeLessThan(bothGood);
  });

  it("returns value in [0, 1]", () => {
    const cases: [number | null, number | null, number | null, number | null][] = [
      [null, null, null, null],
      [0, 0, 0.5, 0.5],
      [10000, 10000, 0, 0],
      [50, 200, 0.3, 0.01],
    ];
    for (const [sOI, lOI, sSp, lSp] of cases) {
      const score = computeLiquidityScore(sOI, lOI, sSp, lSp);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});
