import { describe, expect, it } from "vitest";

import {
  buildForwardTradeRowKey,
  shouldFetchForwardTradeAnalytics,
  toggleExpandedRow,
} from "./forward-trade-drilldown";

describe("forward-trade-drilldown utils", () => {
  it("builds deterministic row keys", () => {
    const key = buildForwardTradeRowKey({
      symbol: "AAPL",
      shortExpiry: "2026-09-18",
      longExpiry: "2026-10-16",
      selectedStrike: 215,
    });
    expect(key).toBe("AAPL|2026-09-18|2026-10-16|215");
  });

  it("toggles expanded rows", () => {
    expect(toggleExpandedRow(null, "row-a")).toBe("row-a");
    expect(toggleExpandedRow("row-a", "row-a")).toBeNull();
    expect(toggleExpandedRow("row-a", "row-b")).toBe("row-b");
  });

  it("supports independent expansion state per table", () => {
    const forwardExpanded = toggleExpandedRow(null, "forward-row");
    const topExpanded = toggleExpandedRow(null, "top-row");
    expect(forwardExpanded).toBe("forward-row");
    expect(topExpanded).toBe("top-row");
  });

  it("fetches once and reuses cache entries", () => {
    const rowKey = "AAPL|2026-09-18|2026-10-16|215";
    expect(shouldFetchForwardTradeAnalytics(rowKey, {}, {})).toBe(true);
    expect(shouldFetchForwardTradeAnalytics(rowKey, {}, { [rowKey]: true })).toBe(false);
    expect(
      shouldFetchForwardTradeAnalytics(
        rowKey,
        { [rowKey]: { profile: { probabilityOfProfit: 0.52 } } },
        { [rowKey]: false },
      ),
    ).toBe(false);
  });
});
