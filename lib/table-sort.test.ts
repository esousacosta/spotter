import { describe, expect, it } from "vitest";

import { sortRows, toggleSort, type SortConfig } from "./table-sort";

type Row = { symbol: string; edge: number | null; tradeClass: "standard" | "earnings-exposed" };

describe("table sorting", () => {
  it("toggles the active key and defaults a new key to descending", () => {
    const current: SortConfig<Row> = { key: "edge", direction: "desc" };
    expect(toggleSort(current, "edge")).toEqual({ key: "edge", direction: "asc" });
    expect(toggleSort(current, "symbol")).toEqual({ key: "symbol", direction: "desc" });
  });

  it("sorts without mutating the source and keeps nulls last", () => {
    const rows: Row[] = [
      { symbol: "B", edge: null, tradeClass: "earnings-exposed" },
      { symbol: "A", edge: 0.2, tradeClass: "standard" },
      { symbol: "C", edge: 0.4, tradeClass: "standard" },
    ];
    expect(sortRows(rows, { key: "edge", direction: "desc" }).map((row) => row.symbol)).toEqual([
      "C",
      "A",
      "B",
    ]);
    expect(rows[0].symbol).toBe("B");
  });

  it("places standard trades first with the default descending direction", () => {
    const rows: Row[] = [
      { symbol: "B", edge: 0.3, tradeClass: "earnings-exposed" },
      { symbol: "A", edge: 0.2, tradeClass: "standard" },
    ];
    expect(sortRows(rows, { key: "tradeClass", direction: "desc" })[0].symbol).toBe("A");
  });
});
