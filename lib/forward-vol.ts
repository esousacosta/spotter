import type { ForwardVolRow, TargetPair } from "@/lib/types";

export const DEFAULT_TARGET_PAIRS: TargetPair[] = [
  { shortDte: 15, longDte: 30 },
  { shortDte: 30, longDte: 45 },
  { shortDte: 30, longDte: 60 },
  { shortDte: 45, longDte: 75 },
  { shortDte: 60, longDte: 90 },
  { shortDte: 75, longDte: 105 },
];

export type ExpiryWithDte = {
  expiryUnix: number;
  dteDays: number;
};

export type ChosenExpiryPair = {
  short: ExpiryWithDte;
  long: ExpiryWithDte;
};

export type CandidateExpiryPair = ChosenExpiryPair & {
  distanceToTarget: number;
};

export function getDteDays(expiryUnix: number, now: Date = new Date()): number {
  const expiryMs = expiryUnix * 1000;
  const diffMs = expiryMs - now.getTime();
  return diffMs / (1000 * 60 * 60 * 24);
}

export function chooseExpiryPair(
  expirationsUnix: number[],
  target: TargetPair,
  minGapDays: number,
  now: Date = new Date(),
): ChosenExpiryPair | null {
  const candidates = expirationsUnix
    .map((expiryUnix) => ({ expiryUnix, dteDays: getDteDays(expiryUnix, now) }))
    .filter((entry) => entry.dteDays > 0);

  if (candidates.length === 0) {
    return null;
  }

  const shortSorted = [...candidates].sort((a, b) => {
    const distanceDelta =
      Math.abs(a.dteDays - target.shortDte) - Math.abs(b.dteDays - target.shortDte);
    if (distanceDelta !== 0) {
      return distanceDelta;
    }
    return b.expiryUnix - a.expiryUnix;
  });

  const short = shortSorted[0];
  if (!short) {
    return null;
  }

  const longCandidates = candidates.filter(
    (candidate) =>
      candidate.expiryUnix > short.expiryUnix && candidate.dteDays - short.dteDays >= minGapDays,
  );

  if (longCandidates.length === 0) {
    return null;
  }

  const long = longCandidates.sort((a, b) => {
    const distanceDelta =
      Math.abs(a.dteDays - target.longDte) - Math.abs(b.dteDays - target.longDte);
    if (distanceDelta !== 0) {
      return distanceDelta;
    }
    return b.expiryUnix - a.expiryUnix;
  })[0];

  if (!long) {
    return null;
  }

  return { short, long };
}

export function chooseMultipleExpiryPairs(
  expirationsUnix: number[],
  target: TargetPair,
  minGapDays: number,
  maxCandidates: number = 3,
  now: Date = new Date(),
): CandidateExpiryPair[] {
  const candidates = expirationsUnix
    .map((expiryUnix) => ({ expiryUnix, dteDays: getDteDays(expiryUnix, now) }))
    .filter((entry) => entry.dteDays > 0);

  if (candidates.length === 0) {
    return [];
  }

  const pairs: CandidateExpiryPair[] = [];

  // Find all possible short leg candidates within reasonable distance
  const shortCandidates = [...candidates]
    .sort((a, b) => Math.abs(a.dteDays - target.shortDte) - Math.abs(b.dteDays - target.shortDte))
    .slice(0, Math.max(2, Math.ceil(candidates.length / 3)));

  for (const shortCandidate of shortCandidates) {
    const longCandidates = candidates
      .filter(
        (candidate) =>
          candidate.expiryUnix > shortCandidate.expiryUnix &&
          candidate.dteDays - shortCandidate.dteDays >= minGapDays,
      )
      .sort((a, b) => {
        const distanceDelta =
          Math.abs(a.dteDays - target.longDte) - Math.abs(b.dteDays - target.longDte);
        if (distanceDelta !== 0) {
          return distanceDelta;
        }
        return b.expiryUnix - a.expiryUnix;
      })
      .slice(0, 2);

    for (const longCandidate of longCandidates) {
      const shortDistance = Math.abs(shortCandidate.dteDays - target.shortDte);
      const longDistance = Math.abs(longCandidate.dteDays - target.longDte);
      const distanceToTarget = Math.sqrt(shortDistance ** 2 + longDistance ** 2);

      pairs.push({
        short: shortCandidate,
        long: longCandidate,
        distanceToTarget,
      });
    }
  }

  pairs.sort((a, b) => a.distanceToTarget - b.distanceToTarget);
  return pairs.slice(0, maxCandidates);
}

type ForwardVolMetrics =
  | {
      status: "ok";
      forwardVol: number;
      forwardVolEdge: number;
      isViable: boolean;
      isLowConfidence?: boolean;
    }
  | {
      status: "invalid";
      reason: string;
    };

const STRONGLY_NEGATIVE_VARIANCE_THRESHOLD = -0.0001; // Threshold for "clearly broken"
const NEAR_ZERO_VARIANCE_FLOOR = 0.00001; // Minimum floor for near-zero variance
const ENABLE_NEAR_ZERO_VARIANCE_FALLBACK = true;

export function computeForwardVolMetrics(
  ivShort: number,
  ivLong: number,
  shortDteDays: number,
  longDteDays: number,
): ForwardVolMetrics {
  if (!(ivShort > 0) || !(ivLong > 0)) {
    return { status: "invalid", reason: "Implied volatilities must be positive." };
  }

  if (!(longDteDays > shortDteDays)) {
    return { status: "invalid", reason: "Long DTE must be greater than short DTE." };
  }

  const tShort = shortDteDays / 365;
  const tLong = longDteDays / 365;
  const varianceShort = ivShort ** 2;
  const varianceLong = ivLong ** 2;

  const denominator = tLong - tShort;
  if (!(denominator > 0)) {
    return { status: "invalid", reason: "Invalid tenor pair for forward variance." };
  }

  let forwardVariance =
    (varianceLong * tLong - varianceShort * tShort) / denominator;

  let isLowConfidence = false;

  // Handle negative or near-zero variance
  if (forwardVariance < 0) {
    if (forwardVariance < STRONGLY_NEGATIVE_VARIANCE_THRESHOLD) {
      // Clearly broken term structure
      return {
        status: "invalid",
        reason: "Forward variance is strongly negative for this tenor combination.",
      };
    }

    if (!ENABLE_NEAR_ZERO_VARIANCE_FALLBACK) {
      return {
        status: "invalid",
        reason: "Forward variance is negative for this tenor combination.",
      };
    }

    // Near-zero/slightly negative: clip to floor with low confidence flag
    forwardVariance = NEAR_ZERO_VARIANCE_FLOOR;
    isLowConfidence = true;
  }

  const forwardVol = Math.sqrt(forwardVariance);
  if (!(forwardVol > 0)) {
    return {
      status: "invalid",
      reason: "Forward volatility is zero and cannot produce a valid edge.",
    };
  }

  const forwardVolEdge = ivShort / forwardVol - 1;
  return {
    status: "ok",
    forwardVol,
    forwardVolEdge,
    isViable: forwardVolEdge > 0,
    isLowConfidence,
  };
}

export function emptyInvalidRow(target: TargetPair, notes: string, rejectionReason?: string): ForwardVolRow {
  return {
    shortTargetDte: target.shortDte,
    longTargetDte: target.longDte,
    nextEarningsDate: null,
    tradeClass: null,
    selectedStrike: null,
    shortExpiry: null,
    longExpiry: null,
    shortDteActual: null,
    longDteActual: null,
    ivShort: null,
    ivLong: null,
    shortOpenInterest: null,
    longOpenInterest: null,
    forwardVol: null,
    rawForwardVolEdge: null,
    adjustedForwardVolEdge: null,
    forwardVolEdge: null,
    isViable: false,
    status: "invalid",
    notes,
    quoteTime: null,
    rejectionReason: (rejectionReason ?? null) as any,
  };
}

export function formatExpiryIsoDate(expiryUnix: number): string {
  return new Date(expiryUnix * 1000).toISOString().slice(0, 10);
}
