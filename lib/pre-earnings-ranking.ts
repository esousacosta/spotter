import { compareIsoCalendarDates } from "./earnings-filter";
import { getMarketDateIso } from "./market-time";
import type { PreEarningsRejectedRow, PreEarningsRow } from "./types";

type EarningsDatedRow = {
  symbol: string;
  nextEarningsDate: string | null;
};

function rankScore(row: PreEarningsRow): number {
  if (row.verdict === "recommended") {
    return 2;
  }
  if (row.verdict === "consider") {
    return 1;
  }
  return 0;
}

function compareKnownEarningsDates(
  aDate: string | null,
  bDate: string | null,
): number {
  if (aDate && bDate) {
    const comparison = compareIsoCalendarDates(aDate, bDate);
    if (comparison !== null && comparison !== 0) {
      return comparison;
    }
  }

  if (aDate && !bDate) {
    return -1;
  }
  if (!aDate && bDate) {
    return 1;
  }
  return 0;
}

export function comparePreEarningsDatePriority<T extends EarningsDatedRow>(
  a: T,
  b: T,
  now: Date,
): number {
  const marketToday = getMarketDateIso(now);
  const aIsToday = a.nextEarningsDate === marketToday;
  const bIsToday = b.nextEarningsDate === marketToday;
  if (aIsToday !== bIsToday) {
    return aIsToday ? -1 : 1;
  }

  const earningsDateComparison = compareKnownEarningsDates(
    a.nextEarningsDate,
    b.nextEarningsDate,
  );
  if (earningsDateComparison !== 0) {
    return earningsDateComparison;
  }

  return a.symbol.localeCompare(b.symbol);
}

export function comparePreEarningsRows(
  a: PreEarningsRow,
  b: PreEarningsRow,
  now: Date,
): number {
  const earningsPriority = comparePreEarningsDatePriority(a, b, now);
  if (earningsPriority !== 0) {
    return earningsPriority;
  }

  const scoreDelta = rankScore(b) - rankScore(a);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const ivRatioA = a.iv30Rv30 ?? Number.NEGATIVE_INFINITY;
  const ivRatioB = b.iv30Rv30 ?? Number.NEGATIVE_INFINITY;
  if (ivRatioB !== ivRatioA) {
    return ivRatioB - ivRatioA;
  }

  const slopeA = a.tsSlope0To45 ?? Number.POSITIVE_INFINITY;
  const slopeB = b.tsSlope0To45 ?? Number.POSITIVE_INFINITY;
  return slopeA - slopeB;
}

export function compareRejectedPreEarningsRows(
  a: PreEarningsRejectedRow,
  b: PreEarningsRejectedRow,
  now: Date,
): number {
  const earningsPriority = comparePreEarningsDatePriority(a, b, now);
  if (earningsPriority !== 0) {
    return earningsPriority;
  }

  if (a.wasComputed !== b.wasComputed) {
    return a.wasComputed ? -1 : 1;
  }

  return a.rejectionReason.localeCompare(b.rejectionReason);
}
