import { dayDiffIso } from "@/lib/earnings-filter";
import { getMarketDateIso } from "@/lib/market-time";
import type { ForwardVolRow } from "@/lib/types";

const LOW_OPEN_INTEREST = 100;
const WIDE_SPREAD_PCT = 0.15; // 15% bid-ask spread = poor liquidity
const MAX_REASON_LENGTH = 120;

export function buildRankingReason(
  row: ForwardVolRow & { symbol: string },
  now: Date = new Date(),
): string | null {
  const edge = row.adjustedForwardVolEdge ?? row.forwardVolEdge;
  if (!row.isViable || row.status !== "ok" || edge === null || !Number.isFinite(edge)) {
    return null;
  }

  const edgeLabel = edge >= 0.35 ? "High" : edge >= 0.25 ? "Strong" : edge >= 0.2 ? "Viable" : "Positive";
  const parts = [`${edgeLabel} adjusted edge (${Math.round(edge * 100)}%)`];

  if (row.tradeClass === "earnings-exposed") {
    parts.push("earnings-exposed");
  } else if (
    row.ivShort !== null &&
    row.ivLong !== null &&
    row.ivShort > row.ivLong
  ) {
    parts.push("downward term structure");
  } else {
    parts.push("standard trade");
  }

  const daysToEarnings = row.nextEarningsDate
    ? dayDiffIso(getMarketDateIso(now), row.nextEarningsDate)
    : null;
  if (daysToEarnings !== null) {
    parts.push(
      daysToEarnings <= 14
        ? `earnings in ${daysToEarnings} day${daysToEarnings === 1 ? "" : "s"} adds uncertainty`
        : `earnings ${daysToEarnings} days away`,
    );
  }

  const hasLowOpenInterest = [row.shortOpenInterest, row.longOpenInterest].some(
    (value) => value !== null && value < LOW_OPEN_INTEREST,
  );
  const hasWideSpread = [row.shortBidAskSpreadPct, row.longBidAskSpreadPct].some(
    (value) => value !== null && value > WIDE_SPREAD_PCT,
  );

  if (hasWideSpread) {
    parts.push("wide bid-ask spread");
  } else if (hasLowOpenInterest) {
    parts.push("limited open interest");
  }

  const reason = `${parts.join("; ")}.`;
  if (reason.length <= MAX_REASON_LENGTH) {
    return reason;
  }
  return `${reason.slice(0, MAX_REASON_LENGTH - 1).replace(/[;,\s]+$/, "")}.`;
}
