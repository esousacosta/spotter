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

type ForwardVolMetrics =
  | {
      status: "ok";
      forwardVol: number;
      forwardVolEdge: number;
      isViable: boolean;
    }
  | {
      status: "invalid";
      reason: string;
    };

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

  const forwardVariance =
    (varianceLong * tLong - varianceShort * tShort) / denominator;

  if (forwardVariance < 0) {
    return {
      status: "invalid",
      reason: "Forward variance is negative for this tenor combination.",
    };
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
