import {
  chooseExpiryPair,
  chooseMultipleExpiryPairs,
  computeForwardVolMetrics,
  DEFAULT_TARGET_PAIRS,
  emptyInvalidRow,
  formatExpiryIsoDate,
  getDteDays,
  type CandidateExpiryPair,
} from "@/lib/forward-vol";
import {
  classifyEarningsContext,
  compareIsoCalendarDates,
  dayDiffIso,
  EARNINGS_STANDARD_REASON,
  evaluateEarningsExposedAdjustedEdge,
  validateExEarningsSafeguards,
} from "@/lib/earnings-filter";
import { getMarketDateIso } from "@/lib/market-time";
import type { EarningsInfo } from "@/lib/server/earnings-provider";
import {
  marketDataProvider,
  getOptionDataProvider,
  isOptionSnapshotStale,
  type OptionContract,
} from "@/lib/server/market-data-provider";
import type { ForwardVolRow, TargetPair } from "@/lib/types";

const MIN_VIABLE_ADJUSTED_EDGE = 0.2;
const MAX_CANDIDATE_PAIRS_PER_TARGET = 3;
const ENABLE_MULTIPLE_PAIRS = true;
const STRIKE_TOLERANCE_PCT = 2; // 2% tolerance for strike selection
const ENABLE_STRIKE_TOLERANCE = true;

type SharedAtmSelection = {
  strike: number;
  short: OptionContract;
  long: OptionContract;
  isExactMatch?: boolean;
  isFallbackStrike?: boolean;
};

function toStrikeKey(strike: number): string {
  return strike.toFixed(3);
}

function pickLastExpiryBeforeEarnings(expirationsUnix: number[], earningsDateIso: string): number | null {
  const candidates = expirationsUnix.filter((expiryUnix) => {
    const expiryDateIso = formatExpiryIsoDate(expiryUnix);
    const comparison = compareIsoCalendarDates(expiryDateIso, earningsDateIso);
    return comparison !== null && comparison < 0;
  });

  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort((a, b) => b - a)[0];
}

function findContractByStrike(
  contracts: OptionContract[],
  strike: number,
): OptionContract | null {
  const key = toStrikeKey(strike);
  return contracts.find((contract) => toStrikeKey(contract.strike) === key) ?? null;
}

function selectFlexibleAtmCalls(
  shortContracts: OptionContract[],
  longContracts: OptionContract[],
  spotPrice: number,
): SharedAtmSelection | null {
  if (shortContracts.length === 0 || longContracts.length === 0) {
    return null;
  }

  // Step 1: Try to find exact shared ATM strike
  const exactMatch = selectSharedAtmCalls(shortContracts, longContracts, spotPrice);
  if (exactMatch) {
    return { ...exactMatch, isExactMatch: true };
  }

  if (!ENABLE_STRIKE_TOLERANCE) {
    return null;
  }

  // Step 2: Try to find strikes within tolerance
  const tolerance = (spotPrice * STRIKE_TOLERANCE_PCT) / 100;
  const toleranceBand = { min: spotPrice - tolerance, max: spotPrice + tolerance };

  // Find best strikes in both legs within tolerance
  const shortCandidates = shortContracts
    .filter((c) => c.strike >= toleranceBand.min && c.strike <= toleranceBand.max)
    .sort((a, b) => Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice));

  const longCandidates = longContracts
    .filter((c) => c.strike >= toleranceBand.min && c.strike <= toleranceBand.max)
    .sort((a, b) => Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice));

  if (shortCandidates.length === 0 || longCandidates.length === 0) {
    return null;
  }

  // Use nearest strike to spot in each leg
  const shortStrike = shortCandidates[0];
  const longStrike = longCandidates[0];

  // Use the average strike as the "selected strike" for reporting
  const selectedStrike = (shortStrike.strike + longStrike.strike) / 2;

  return {
    strike: selectedStrike,
    short: shortStrike,
    long: longStrike,
    isFallbackStrike: true,
    isExactMatch: false,
  };
}

function selectSharedAtmCalls(
  shortContracts: OptionContract[],
  longContracts: OptionContract[],
  spotPrice: number,
): SharedAtmSelection | null {
  if (shortContracts.length === 0 || longContracts.length === 0) {
    return null;
  }

  const shortByStrike = new Map<string, OptionContract>();
  for (const contract of shortContracts) {
    shortByStrike.set(toStrikeKey(contract.strike), contract);
  }

  const longByStrike = new Map<string, OptionContract>();
  for (const contract of longContracts) {
    longByStrike.set(toStrikeKey(contract.strike), contract);
  }

  const common = [...shortByStrike.keys()]
    .filter((key) => longByStrike.has(key))
    .map((key) => {
      const short = shortByStrike.get(key);
      const long = longByStrike.get(key);
      if (!short || !long) {
        return null;
      }
      return {
        strike: short.strike,
        short,
        long,
      };
    })
    .filter((value): value is SharedAtmSelection => value !== null);

  if (common.length === 0) {
    return null;
  }

  return common.sort((a, b) => {
    const delta = Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice);
    if (delta !== 0) {
      return delta;
    }
    return a.strike - b.strike;
  })[0] || { ...common[0], isExactMatch: true };
}

export function normalizeTargets(targetPairs: TargetPair[] | undefined): TargetPair[] {
  return (targetPairs && targetPairs.length > 0 ? targetPairs : DEFAULT_TARGET_PAIRS).filter(
    (pair) => pair.longDte > pair.shortDte,
  );
}

export function getBestValidRow(rows: ForwardVolRow[]): ForwardVolRow | null {
  const validRows = rows.filter(
    (row): row is ForwardVolRow & { forwardVolEdge: number } =>
      row.status === "ok" &&
      row.isViable &&
      row.forwardVolEdge !== null &&
      Number.isFinite(row.forwardVolEdge),
  );
  if (validRows.length === 0) {
    return null;
  }

  return validRows.sort((a, b) => b.forwardVolEdge - a.forwardVolEdge)[0];
}

export async function computeForwardVolRowsForSymbol(
  symbol: string,
  targetPairs: TargetPair[] | undefined,
  earningsInfo: EarningsInfo | null | Promise<EarningsInfo | null> = null,
  now: Date = new Date(),
): Promise<ForwardVolRow[]> {
  const targets = normalizeTargets(targetPairs);
  const optionProvider = getOptionDataProvider();
  const [snapshot, resolvedEarningsInfo] = await Promise.all([
    optionProvider.getOptionSnapshot(symbol),
    earningsInfo,
  ]);

  const rowsByTarget: ForwardVolRow[][] = [];

  for (const target of targets) {
    const targetRows: ForwardVolRow[] = [];

    // Get multiple candidate pairs per target if enabled
    const candidatePairs = ENABLE_MULTIPLE_PAIRS
      ? chooseMultipleExpiryPairs(snapshot.expirations, target, 7, MAX_CANDIDATE_PAIRS_PER_TARGET, now)
      : chooseExpiryPair(snapshot.expirations, target, 7, now)
        ? [
            {
              short: chooseExpiryPair(snapshot.expirations, target, 7, now)!.short,
              long: chooseExpiryPair(snapshot.expirations, target, 7, now)!.long,
              distanceToTarget: 0,
            },
          ]
        : [];

    if (candidatePairs.length === 0) {
      targetRows.push(emptyInvalidRow(target, "Could not find a valid short/long expiration pair.", "no_valid_expiry_pair"));
      rowsByTarget.push(targetRows);
      continue;
    }

    // Evaluate each candidate pair
    for (const candidatePair of candidatePairs) {
      const chosen = candidatePair;
      const shortExpiryDate = formatExpiryIsoDate(chosen.short.expiryUnix);
      const longExpiryDate = formatExpiryIsoDate(chosen.long.expiryUnix);
      const earningsDecision = classifyEarningsContext({
        nextEarningsDate: resolvedEarningsInfo?.nextEarningsDate ?? null,
        shortExpiryDate,
        isReliable: resolvedEarningsInfo?.isReliable ?? false,
      });

      if (earningsDecision.state === "ineligible") {
        targetRows.push({
          ...emptyInvalidRow(target, earningsDecision.reason, "earnings_ineligible"),
          nextEarningsDate: resolvedEarningsInfo?.nextEarningsDate ?? null,
          tradeClass: earningsDecision.tradeClass,
          shortExpiry: shortExpiryDate,
          longExpiry: longExpiryDate,
          shortDteActual: Number(chosen.short.dteDays.toFixed(2)),
          longDteActual: Number(chosen.long.dteDays.toFixed(2)),
        });
        continue;
      }

      const [shortCalls, longCalls] = await Promise.all([
        optionProvider.getOptionChainCalls(symbol, chosen.short.expiryUnix),
        optionProvider.getOptionChainCalls(symbol, chosen.long.expiryUnix),
      ]);

      const sharedAtm = selectFlexibleAtmCalls(shortCalls, longCalls, snapshot.spotPrice);
      if (!sharedAtm) {
        targetRows.push({
          ...emptyInvalidRow(
            target,
            "Missing a shared ATM strike with implied volatility for both expiries.",
            "missing_shared_atm_strike",
          ),
          nextEarningsDate: resolvedEarningsInfo?.nextEarningsDate ?? null,
          tradeClass: earningsDecision.tradeClass,
          shortExpiry: shortExpiryDate,
          longExpiry: longExpiryDate,
          shortDteActual: Number(chosen.short.dteDays.toFixed(2)),
          longDteActual: Number(chosen.long.dteDays.toFixed(2)),
        });
        continue;
      }

      // Track if fallback strike was used
      const strikeNote = sharedAtm.isFallbackStrike
        ? `Fallback strike ${sharedAtm.strike.toFixed(2)} used (within ${STRIKE_TOLERANCE_PCT}% tolerance).`
        : undefined;

      const metrics = computeForwardVolMetrics(
        sharedAtm.short.impliedVolatility,
        sharedAtm.long.impliedVolatility,
        chosen.short.dteDays,
        chosen.long.dteDays,
      );

      if (metrics.status === "invalid") {
        targetRows.push({
          ...emptyInvalidRow(target, metrics.reason, "invalid_forward_variance"),
          nextEarningsDate: resolvedEarningsInfo?.nextEarningsDate ?? null,
          tradeClass: earningsDecision.tradeClass,
          shortExpiry: shortExpiryDate,
          longExpiry: longExpiryDate,
          shortDteActual: Number(chosen.short.dteDays.toFixed(2)),
          longDteActual: Number(chosen.long.dteDays.toFixed(2)),
          selectedStrike: sharedAtm.strike,
          ivShort: sharedAtm.short.impliedVolatility,
          ivLong: sharedAtm.long.impliedVolatility,
          shortOpenInterest: sharedAtm.short.openInterest,
          longOpenInterest: sharedAtm.long.openInterest,
        });
        continue;
      }

      let adjustedEdge = metrics.forwardVolEdge;
      let adjustedForwardVol = metrics.forwardVol;
      let notes = EARNINGS_STANDARD_REASON;
      if (strikeNote) {
        notes = `${notes} ${strikeNote}`;
      }
      let viable = metrics.forwardVolEdge > MIN_VIABLE_ADJUSTED_EDGE;
      let rejectionReason: string | null = null;

      if (!viable) {
        rejectionReason = "below_viability_threshold";
      }

      if (earningsDecision.state === "earnings-exposed-post") {
        const earningsDate = resolvedEarningsInfo?.nextEarningsDate ?? null;
        const todayIso = getMarketDateIso(now);
        const anchorExpiryUnix =
          earningsDate !== null
            ? pickLastExpiryBeforeEarnings(snapshot.expirations, earningsDate)
            : null;
        const anchorCalls =
          anchorExpiryUnix !== null
            ? await optionProvider.getOptionChainCalls(symbol, anchorExpiryUnix)
            : [];
        const anchorContract =
          anchorExpiryUnix !== null ? findContractByStrike(anchorCalls, sharedAtm.strike) : null;
        const anchorExpiryDate =
          anchorExpiryUnix !== null ? formatExpiryIsoDate(anchorExpiryUnix) : null;

        const shortVsEarnings = earningsDate ? compareIsoCalendarDates(shortExpiryDate, earningsDate) : null;
        const longVsEarnings = earningsDate ? compareIsoCalendarDates(longExpiryDate, earningsDate) : null;
        const safeguards = validateExEarningsSafeguards({
          hasAnchorExpiry: anchorExpiryUnix !== null,
          anchorOpenInterest: anchorContract?.openInterest ?? null,
          daysNowToEarnings: earningsDate ? dayDiffIso(todayIso, earningsDate) : null,
          anchorDaysBeforeEarnings:
            earningsDate && anchorExpiryDate ? dayDiffIso(anchorExpiryDate, earningsDate) : null,
          anchorTenorGapDays:
            anchorExpiryUnix !== null ? Math.abs(getDteDays(anchorExpiryUnix, now) - chosen.short.dteDays) : null,
          bothLegsSpanEarnings:
            shortVsEarnings !== null &&
            longVsEarnings !== null &&
            shortVsEarnings > 0 &&
            longVsEarnings > 0,
          daysEarningsToLong: earningsDate ? dayDiffIso(earningsDate, longExpiryDate) : null,
        });
        if (!safeguards.ok) {
          targetRows.push({
            ...emptyInvalidRow(target, safeguards.reason, "failed_earnings_safeguards"),
            nextEarningsDate: resolvedEarningsInfo?.nextEarningsDate ?? null,
            tradeClass: earningsDecision.tradeClass,
            shortExpiry: shortExpiryDate,
            longExpiry: longExpiryDate,
            shortDteActual: Number(chosen.short.dteDays.toFixed(2)),
            longDteActual: Number(chosen.long.dteDays.toFixed(2)),
            selectedStrike: sharedAtm.strike,
            ivShort: sharedAtm.short.impliedVolatility,
            ivLong: sharedAtm.long.impliedVolatility,
            shortOpenInterest: sharedAtm.short.openInterest,
            longOpenInterest: sharedAtm.long.openInterest,
            forwardVol: metrics.forwardVol,
            rawForwardVolEdge: metrics.forwardVolEdge,
            adjustedForwardVolEdge: null,
            forwardVolEdge: null,
          });
          continue;
        }

        const earningsEvaluation = evaluateEarningsExposedAdjustedEdge({
          ivShort: sharedAtm.short.impliedVolatility,
          ivLong: sharedAtm.long.impliedVolatility,
          shortDteDays: chosen.short.dteDays,
          longDteDays: chosen.long.dteDays,
          preEarningsAnchorIv: anchorContract?.impliedVolatility ?? null,
        });

        if (!earningsEvaluation.eligible) {
          targetRows.push({
            ...emptyInvalidRow(target, earningsEvaluation.reason, "failed_earnings_evaluation"),
            nextEarningsDate: resolvedEarningsInfo?.nextEarningsDate ?? null,
            tradeClass: earningsDecision.tradeClass,
            shortExpiry: shortExpiryDate,
            longExpiry: longExpiryDate,
            shortDteActual: Number(chosen.short.dteDays.toFixed(2)),
            longDteActual: Number(chosen.long.dteDays.toFixed(2)),
            selectedStrike: sharedAtm.strike,
            ivShort: sharedAtm.short.impliedVolatility,
            ivLong: sharedAtm.long.impliedVolatility,
            shortOpenInterest: sharedAtm.short.openInterest,
            longOpenInterest: sharedAtm.long.openInterest,
            forwardVol: earningsEvaluation.adjustedForwardVol ?? metrics.forwardVol,
            rawForwardVolEdge: metrics.forwardVolEdge,
            adjustedForwardVolEdge: earningsEvaluation.adjustedEdge,
            forwardVolEdge: earningsEvaluation.adjustedEdge,
          });
          continue;
        }

        adjustedEdge = earningsEvaluation.adjustedEdge;
        adjustedForwardVol = earningsEvaluation.adjustedForwardVol;
        notes = earningsEvaluation.reason;
        viable = adjustedEdge > MIN_VIABLE_ADJUSTED_EDGE;
        if (!viable) {
          rejectionReason = "below_viability_threshold";
        }
      }

      targetRows.push({
        shortTargetDte: target.shortDte,
        longTargetDte: target.longDte,
        nextEarningsDate: resolvedEarningsInfo?.nextEarningsDate ?? null,
        tradeClass: earningsDecision.tradeClass,
        selectedStrike: sharedAtm.strike,
        shortExpiry: shortExpiryDate,
        longExpiry: longExpiryDate,
        shortDteActual: Number(chosen.short.dteDays.toFixed(2)),
        longDteActual: Number(chosen.long.dteDays.toFixed(2)),
        ivShort: sharedAtm.short.impliedVolatility,
        ivLong: sharedAtm.long.impliedVolatility,
        shortOpenInterest: sharedAtm.short.openInterest,
        longOpenInterest: sharedAtm.long.openInterest,
        forwardVol: adjustedForwardVol,
        rawForwardVolEdge: metrics.forwardVolEdge,
        adjustedForwardVolEdge: adjustedEdge,
        forwardVolEdge: adjustedEdge,
        isViable: viable,
        status: "ok" as const,
        notes,
        quoteTime: snapshot.quoteTime,
        rejectionReason: (rejectionReason ?? null) as any,
      });
    }

    rowsByTarget.push(targetRows);
  }

  const rows = rowsByTarget.flat() as ForwardVolRow[];

  for (const row of rows) {
    row.quoteTime ??= snapshot.quoteTime;
    row.isStale = isOptionSnapshotStale(snapshot);
  }

  rows.sort((a, b) => {
    const aEdge = a.forwardVolEdge ?? Number.NEGATIVE_INFINITY;
    const bEdge = b.forwardVolEdge ?? Number.NEGATIVE_INFINITY;
    return bEdge - aEdge;
  });

  return rows;
}
