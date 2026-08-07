export type EarningsTradeClass = "standard" | "earnings-exposed";

export type EarningsContextDecision =
  | {
      state: "standard";
      tradeClass: "standard";
      reason: string;
    }
  | {
      state: "earnings-exposed-post";
      tradeClass: "earnings-exposed";
    }
  | {
      state: "ineligible";
      tradeClass: EarningsTradeClass | null;
      reason: string;
    };

export type EarningsAdjustedEvaluation =
  | {
      eligible: true;
      adjustedEdge: number;
      adjustedForwardVol: number;
      adjustedShortIv: number;
      reason: string;
    }
  | {
      eligible: false;
      adjustedEdge: number | null;
      adjustedForwardVol: number | null;
      adjustedShortIv: number | null;
      reason: string;
    };

const EARNINGS_EXPOSED_MIN_ADJUSTED_EDGE = 0.05;
const MIN_POSITIVE = 1e-10;
const MAX_ANCHOR_TENOR_GAP_DAYS = 21;
const MAX_ANCHOR_CYCLE_LOOKBACK_DAYS = 90;
const MAX_EARNINGS_TO_LONG_WINDOW_DAYS = 90;

export const EARNINGS_STANDARD_REASON =
  "Eligible because the selected expiration occurs before the next earnings announcement.";
export const EARNINGS_ACCEPTED_REASON =
  "Accepted despite earnings before expiration because the ex-earnings-adjusted edge remains above threshold.";
export const EARNINGS_REJECTED_REASON =
  "Rejected because the apparent premium advantage disappears after adjusting for earnings-related implied volatility.";
export const EARNINGS_SAME_DAY_REJECTED_REASON =
  "Rejected because earnings is on the short-call expiration date and same-day event handling is disabled.";
export const EARNINGS_MISSING_REASON =
  "Rejected because a reliable next earnings date or event-volatility estimate is not available.";
export const EARNINGS_MISSING_FALLBACK_REASON =
  "No reliable next earnings date is available, so this row is evaluated without earnings adjustment.";
export const EARNINGS_ANCHOR_MISSING_REASON =
  "Rejected because no valid pre-earnings anchor expiry is available for ex-earnings adjustment.";
export const EARNINGS_ANCHOR_LIQUIDITY_REASON =
  "Rejected because the pre-earnings anchor has insufficient liquidity at the selected strike.";
export const EARNINGS_ANCHOR_DISTANCE_REASON =
  "Rejected because the pre-earnings anchor is too far from the earnings date for a reliable baseline.";
export const EARNINGS_TENOR_STRETCH_REASON =
  "Rejected because the anchor tenor is too far from the short tenor for a reliable ex-earnings estimate.";
export const EARNINGS_ALIGNMENT_REASON =
  "Rejected because the current ex-earnings model requires both legs to span the same earnings event.";
export const EARNINGS_MULTI_EVENT_REASON =
  "Rejected because multiple earnings events may fall within the trade window, which this model does not support.";
export const EARNINGS_BASELINE_CONFLICT_REASON =
  "Rejected because pre-earnings baseline variance exceeds short-leg variance, making event decomposition inconclusive.";

function toUtcDate(value: string): Date | null {
  const normalized = value.trim();
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
}

export function compareIsoCalendarDates(a: string, b: string): number | null {
  const dateA = toUtcDate(a);
  const dateB = toUtcDate(b);
  if (!dateA || !dateB) {
    return null;
  }

  const timeA = dateA.getTime();
  const timeB = dateB.getTime();
  if (timeA < timeB) {
    return -1;
  }
  if (timeA > timeB) {
    return 1;
  }
  return 0;
}

export function dayDiffIso(startIso: string, endIso: string): number | null {
  const start = toUtcDate(startIso);
  const end = toUtcDate(endIso);
  if (!start || !end) {
    return null;
  }
  return Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

export function classifyEarningsContext(input: {
  nextEarningsDate: string | null;
  shortExpiryDate: string;
  isReliable: boolean;
}): EarningsContextDecision {
  if (!input.isReliable || !input.nextEarningsDate) {
    return {
      state: "standard",
      tradeClass: "standard",
      reason: EARNINGS_MISSING_FALLBACK_REASON,
    };
  }

  const comparison = compareIsoCalendarDates(input.shortExpiryDate, input.nextEarningsDate);
  if (comparison === null) {
    return {
      state: "ineligible",
      tradeClass: null,
      reason: EARNINGS_MISSING_REASON,
    };
  }

  if (comparison < 0) {
    return {
      state: "standard",
      tradeClass: "standard",
      reason: EARNINGS_STANDARD_REASON,
    };
  }

  if (comparison === 0) {
    return {
      state: "ineligible",
      tradeClass: "earnings-exposed",
      reason: EARNINGS_SAME_DAY_REJECTED_REASON,
    };
  }

  return {
    state: "earnings-exposed-post",
    tradeClass: "earnings-exposed",
  };
}

export function validateExEarningsSafeguards(input: {
  hasAnchorExpiry: boolean;
  anchorOpenInterest: number | null;
  daysNowToEarnings: number | null;
  anchorDaysBeforeEarnings: number | null;
  anchorTenorGapDays: number | null;
  bothLegsSpanEarnings: boolean;
  daysEarningsToLong: number | null;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.hasAnchorExpiry) {
    return { ok: false, reason: EARNINGS_ANCHOR_MISSING_REASON };
  }

  if (!(typeof input.anchorOpenInterest === "number" && Number.isFinite(input.anchorOpenInterest) && input.anchorOpenInterest > 0)) {
    return { ok: false, reason: EARNINGS_ANCHOR_LIQUIDITY_REASON };
  }

  if (!(typeof input.daysNowToEarnings === "number" && input.daysNowToEarnings > 0)) {
    return { ok: false, reason: EARNINGS_MISSING_REASON };
  }

  if (!(typeof input.anchorDaysBeforeEarnings === "number" && input.anchorDaysBeforeEarnings > 0)) {
    return { ok: false, reason: EARNINGS_ANCHOR_DISTANCE_REASON };
  }

  const maxAnchorDistance = Math.min(30, Math.max(1, Math.floor(input.daysNowToEarnings / 2)));
  if (
    input.anchorDaysBeforeEarnings > maxAnchorDistance ||
    input.anchorDaysBeforeEarnings > MAX_ANCHOR_CYCLE_LOOKBACK_DAYS
  ) {
    return { ok: false, reason: EARNINGS_ANCHOR_DISTANCE_REASON };
  }

  if (!(typeof input.anchorTenorGapDays === "number" && input.anchorTenorGapDays <= MAX_ANCHOR_TENOR_GAP_DAYS)) {
    return { ok: false, reason: EARNINGS_TENOR_STRETCH_REASON };
  }

  if (!input.bothLegsSpanEarnings) {
    return { ok: false, reason: EARNINGS_ALIGNMENT_REASON };
  }

  if (
    !(typeof input.daysEarningsToLong === "number") ||
    input.daysEarningsToLong < 0 ||
    input.daysEarningsToLong > MAX_EARNINGS_TO_LONG_WINDOW_DAYS
  ) {
    return { ok: false, reason: EARNINGS_MULTI_EVENT_REASON };
  }

  return { ok: true };
}

export function evaluateEarningsExposedAdjustedEdge(input: {
  ivShort: number;
  ivLong: number;
  shortDteDays: number;
  longDteDays: number;
  preEarningsAnchorIv: number | null;
}): EarningsAdjustedEvaluation {
  if (!(input.ivShort > 0) || !(input.ivLong > 0) || !(input.preEarningsAnchorIv && input.preEarningsAnchorIv > 0)) {
    return {
      eligible: false,
      adjustedEdge: null,
      adjustedForwardVol: null,
      adjustedShortIv: null,
      reason: EARNINGS_MISSING_REASON,
    };
  }

  const tShort = input.shortDteDays / 365;
  const tLong = input.longDteDays / 365;
  if (!(tLong > tShort) || !(tShort > 0)) {
    return {
      eligible: false,
      adjustedEdge: null,
      adjustedForwardVol: null,
      adjustedShortIv: null,
      reason: EARNINGS_REJECTED_REASON,
    };
  }

  const shortTotalVariance = input.ivShort ** 2 * tShort;
  const longTotalVariance = input.ivLong ** 2 * tLong;
  const baselineShortVariance = input.preEarningsAnchorIv ** 2;
  const baselineShortTotal = baselineShortVariance * tShort;

  if (shortTotalVariance < baselineShortTotal) {
    return {
      eligible: false,
      adjustedEdge: null,
      adjustedForwardVol: null,
      adjustedShortIv: null,
      reason: EARNINGS_BASELINE_CONFLICT_REASON,
    };
  }

  // Single-event approximation: estimate and strip one event variance contribution from both tenors.
  const eventVariance = shortTotalVariance - baselineShortTotal;
  const adjustedShortTotal = Math.max(shortTotalVariance - eventVariance, MIN_POSITIVE);
  const adjustedLongTotal = Math.max(longTotalVariance - eventVariance, MIN_POSITIVE);
  const adjustedForwardVariance = (adjustedLongTotal - adjustedShortTotal) / (tLong - tShort);

  if (!(adjustedForwardVariance > MIN_POSITIVE)) {
    return {
      eligible: false,
      adjustedEdge: null,
      adjustedForwardVol: null,
      adjustedShortIv: null,
      reason: EARNINGS_REJECTED_REASON,
    };
  }

  const adjustedShortIv = Math.sqrt(adjustedShortTotal / tShort);
  const adjustedForwardVol = Math.sqrt(adjustedForwardVariance);
  const adjustedEdge = adjustedShortIv / adjustedForwardVol - 1;

  if (!Number.isFinite(adjustedEdge) || adjustedEdge < EARNINGS_EXPOSED_MIN_ADJUSTED_EDGE) {
    return {
      eligible: false,
      adjustedEdge,
      adjustedForwardVol,
      adjustedShortIv,
      reason: EARNINGS_REJECTED_REASON,
    };
  }

  return {
    eligible: true,
    adjustedEdge,
    adjustedForwardVol,
    adjustedShortIv,
    reason: EARNINGS_ACCEPTED_REASON,
  };
}
