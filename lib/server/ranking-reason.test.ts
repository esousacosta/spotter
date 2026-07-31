import { describe, expect, it } from "vitest";

import { buildRankingReason } from "./ranking-reason";
import type { ForwardVolRow } from "../types";

function makeRow(overrides: Partial<ForwardVolRow> = {}): ForwardVolRow & { symbol: string } {
  return {
    symbol: "TEST",
    shortTargetDte: 30,
    longTargetDte: 60,
    nextEarningsDate: "2026-09-30",
    tradeClass: "standard",
    selectedStrike: 100,
    shortExpiry: "2026-08-30",
    longExpiry: "2026-09-30",
    shortDteActual: 30,
    longDteActual: 60,
    ivShort: 0.35,
    ivLong: 0.25,
    shortOpenInterest: 500,
    longOpenInterest: 600,
    forwardVol: 0.2,
    rawForwardVolEdge: 0.4,
    adjustedForwardVolEdge: 0.38,
    forwardVolEdge: 0.38,
    isViable: true,
    status: "ok",
    notes: "ok",
    quoteTime: null,
    ...overrides,
  };
}

describe("buildRankingReason", () => {
  it("describes the actual edge and earnings timing", () => {
    const reason = buildRankingReason(makeRow(), new Date("2026-07-30T12:00:00Z"));
    expect(reason).toContain("High adjusted edge (38%)");
    expect(reason).toContain("earnings 62 days away");
    expect(reason?.length).toBeLessThanOrEqual(120);
  });

  it("calls out imminent earnings and liquidity", () => {
    const reason = buildRankingReason(
      makeRow({
        adjustedForwardVolEdge: 0.24,
        nextEarningsDate: "2026-08-08",
        tradeClass: "earnings-exposed",
        shortOpenInterest: 20,
      }),
      new Date("2026-07-31T12:00:00Z"),
    );
    expect(reason).toContain("Viable adjusted edge (24%)");
    expect(reason).toContain("earnings in 8 days");
    expect(reason).toContain("limited open interest");
  });

  it("returns null for non-viable rows", () => {
    expect(buildRankingReason(makeRow({ isViable: false }))).toBeNull();
  });
});
