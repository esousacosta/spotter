import { describe, expect, it } from "vitest";

import type { RankedForwardVolRow } from "./types";
import { buildMarketScanHtml, marketScanHtmlFilename } from "./market-scan-html";

function row(overrides: Partial<RankedForwardVolRow> = {}): RankedForwardVolRow {
  return {
    symbol: "ACME",
    companyName: "Acme & Sons <Holdings>",
    shortTargetDte: 30,
    longTargetDte: 60,
    nextEarningsDate: "2026-09-01",
    tradeClass: "standard",
    selectedStrike: 125,
    shortExpiry: "2026-09-18",
    longExpiry: "2026-10-16",
    shortDteActual: 29,
    longDteActual: 57,
    ivShort: 0.35,
    ivLong: 0.28,
    shortOpenInterest: 1234,
    longOpenInterest: 2345,
    forwardVol: 0.19,
    rawForwardVolEdge: 0.16,
    adjustedForwardVolEdge: 0.12,
    forwardVolEdge: 0.12,
    isViable: true,
    status: "ok",
    notes: 'Strong "edge" & liquid',
    quoteTime: "2026-08-10T17:30:00Z",
    rankingReason: "Best <candidate>",
    ...overrides,
  };
}

describe("market scan HTML export", () => {
  it("exports only viable trades with formatted market data", () => {
    const html = buildMarketScanHtml(
      [row(), row({ symbol: "NOPE", isViable: false, status: "invalid" })],
      "2026-08-10T17:00:00Z",
    );

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Acme &amp; Sons &lt;Holdings&gt;");
    expect(html).toContain("Strong &quot;edge&quot; &amp; liquid");
    expect(html).toContain("<td>35.00%</td>");
    expect(html).toContain("<td>12.00%</td>");
    expect(html).toContain("1 trade</p>");
    expect(html).not.toContain("NOPE");
  });

  it("uses the scan date in the download filename", () => {
    expect(marketScanHtmlFilename("2026-08-10T17:00:00Z")).toBe("viable-market-trades-2026-08-10.html");
  });
});
