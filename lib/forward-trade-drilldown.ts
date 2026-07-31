import type { ForwardVolRow } from "@/lib/types";

type DrilldownRowLike = {
  symbol: string;
  shortExpiry: string | null;
  longExpiry: string | null;
  selectedStrike: number | null;
};

function toStrikePart(strike: number): string {
  return Number.isInteger(strike) ? strike.toString() : strike.toFixed(3).replace(/\.?0+$/, "");
}

export function buildForwardTradeRowKey(row: DrilldownRowLike): string | null {
  if (!row.shortExpiry || !row.longExpiry || row.selectedStrike === null || !Number.isFinite(row.selectedStrike)) {
    return null;
  }
  return `${row.symbol}|${row.shortExpiry}|${row.longExpiry}|${toStrikePart(row.selectedStrike)}`;
}

export function isForwardTradeDrilldownEligible(row: ForwardVolRow): boolean {
  return (
    row.isViable &&
    row.status === "ok" &&
    row.shortExpiry !== null &&
    row.longExpiry !== null &&
    row.selectedStrike !== null &&
    Number.isFinite(row.selectedStrike)
  );
}

export function toggleExpandedRow(currentRowKey: string | null, nextRowKey: string): string | null {
  return currentRowKey === nextRowKey ? null : nextRowKey;
}

export function shouldFetchForwardTradeAnalytics(
  rowKey: string,
  analyticsByRowKey: Record<string, unknown>,
  loadingByRowKey: Record<string, boolean>,
): boolean {
  if (loadingByRowKey[rowKey]) {
    return false;
  }
  return !(rowKey in analyticsByRowKey);
}
