import { describe, expect, it } from "vitest";

import { getMarketDateIso } from "./market-time";
import { comparePreEarningsRows } from "./pre-earnings-ranking";
import type { PreEarningsRow } from "./types";

function makeRow(overrides: Partial<PreEarningsRow>): PreEarningsRow {
  return {
    symbol: "TEST",
    companyName: "Test Co",
    nextEarningsDate: null,
    earningsSession: null,
    underlyingPrice: 100,
    expectedMove: "3.00%",
    avgVolume30: 2_000_000,
    iv30Rv30: 1.3,
    tsSlope0To45: -0.01,
    avgVolumePass: true,
    iv30Rv30Pass: true,
    tsSlopePass: true,
    verdict: "recommended",
    isViable: true,
    notes: "ok",
    quoteTime: null,
    ...overrides,
  };
}

describe("getMarketDateIso", () => {
  it("uses US market calendar date instead of UTC date", () => {
    const now = new Date("2026-07-31T01:30:00.000Z");
    expect(getMarketDateIso(now)).toBe("2026-07-30");
  });
});

describe("comparePreEarningsRows", () => {
  it("prioritizes rows with earnings today over later dates", () => {
    const now = new Date("2026-07-31T12:00:00.000Z");
    const todayRow = makeRow({ symbol: "TODAY", nextEarningsDate: "2026-07-31", iv30Rv30: 1.2 });
    const laterRow = makeRow({ symbol: "LATER", nextEarningsDate: "2026-08-01", iv30Rv30: 4 });

    expect(comparePreEarningsRows(todayRow, laterRow, now)).toBeLessThan(0);
  });

  it("sorts earlier announced earnings before later ones after today priority", () => {
    const now = new Date("2026-07-31T12:00:00.000Z");
    const nearerRow = makeRow({ symbol: "NEAR", nextEarningsDate: "2026-08-01" });
    const fartherRow = makeRow({ symbol: "FAR", nextEarningsDate: "2026-08-05" });

    expect(comparePreEarningsRows(nearerRow, fartherRow, now)).toBeLessThan(0);
  });
});
