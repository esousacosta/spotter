import {
  chooseExpiryPair,
  computeForwardVolMetrics,
  DEFAULT_TARGET_PAIRS,
  emptyInvalidRow,
  formatExpiryIsoDate,
  getDteDays,
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
import { marketDataProvider, type OptionContract } from "@/lib/server/market-data-provider";
import type { ForwardVolRow, TargetPair } from "@/lib/types";

const MIN_VIABLE_ADJUSTED_EDGE = 0.2;

type SharedAtmSelection = {
  strike: number;
  short: OptionContract;
  long: OptionContract;
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
  })[0];
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
  earningsInfo: EarningsInfo | null = null,
  now: Date = new Date(),
): Promise<ForwardVolRow[]> {
  const targets = normalizeTargets(targetPairs);
  const snapshot = await marketDataProvider.getOptionSnapshot(symbol);

  const rows = await Promise.all(
    targets.map(async (target) => {
      const chosen = chooseExpiryPair(snapshot.expirations, target, 7, now);
      if (!chosen) {
        return emptyInvalidRow(target, "Could not find a valid short/long expiration pair.");
      }

      const shortExpiryDate = formatExpiryIsoDate(chosen.short.expiryUnix);
      const longExpiryDate = formatExpiryIsoDate(chosen.long.expiryUnix);
      const earningsDecision = classifyEarningsContext({
        nextEarningsDate: earningsInfo?.nextEarningsDate ?? null,
        shortExpiryDate,
        isReliable: earningsInfo?.isReliable ?? false,
      });
      if (earningsDecision.state === "ineligible") {
        return {
          ...emptyInvalidRow(target, earningsDecision.reason),
          nextEarningsDate: earningsInfo?.nextEarningsDate ?? null,
          tradeClass: earningsDecision.tradeClass,
          shortExpiry: shortExpiryDate,
          longExpiry: longExpiryDate,
          shortDteActual: Number(chosen.short.dteDays.toFixed(2)),
          longDteActual: Number(chosen.long.dteDays.toFixed(2)),
        };
      }

      const [shortCalls, longCalls] = await Promise.all([
        marketDataProvider.getOptionChainCalls(symbol, chosen.short.expiryUnix),
        marketDataProvider.getOptionChainCalls(symbol, chosen.long.expiryUnix),
      ]);

      const sharedAtm = selectSharedAtmCalls(shortCalls, longCalls, snapshot.spotPrice);
      if (!sharedAtm) {
        return {
          ...emptyInvalidRow(
            target,
            "Missing a shared ATM strike with implied volatility for both expiries.",
          ),
          nextEarningsDate: earningsInfo?.nextEarningsDate ?? null,
          tradeClass: earningsDecision.tradeClass,
          shortExpiry: shortExpiryDate,
          longExpiry: longExpiryDate,
          shortDteActual: Number(chosen.short.dteDays.toFixed(2)),
          longDteActual: Number(chosen.long.dteDays.toFixed(2)),
        };
      }

      const metrics = computeForwardVolMetrics(
        sharedAtm.short.impliedVolatility,
        sharedAtm.long.impliedVolatility,
        chosen.short.dteDays,
        chosen.long.dteDays,
      );

      if (metrics.status === "invalid") {
        return {
          ...emptyInvalidRow(target, metrics.reason),
          nextEarningsDate: earningsInfo?.nextEarningsDate ?? null,
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
        };
      }

      let adjustedEdge = metrics.forwardVolEdge;
      let adjustedForwardVol = metrics.forwardVol;
      let notes = EARNINGS_STANDARD_REASON;
      let viable = metrics.forwardVolEdge > MIN_VIABLE_ADJUSTED_EDGE;

      if (earningsDecision.state === "earnings-exposed-post") {
        const earningsDate = earningsInfo?.nextEarningsDate ?? null;
        const todayIso = getMarketDateIso(now);
        const anchorExpiryUnix =
          earningsDate !== null
            ? pickLastExpiryBeforeEarnings(snapshot.expirations, earningsDate)
            : null;
        const anchorCalls =
          anchorExpiryUnix !== null
            ? await marketDataProvider.getOptionChainCalls(symbol, anchorExpiryUnix)
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
          return {
            ...emptyInvalidRow(target, safeguards.reason),
            nextEarningsDate: earningsInfo?.nextEarningsDate ?? null,
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
          };
        }

        const earningsEvaluation = evaluateEarningsExposedAdjustedEdge({
          ivShort: sharedAtm.short.impliedVolatility,
          ivLong: sharedAtm.long.impliedVolatility,
          shortDteDays: chosen.short.dteDays,
          longDteDays: chosen.long.dteDays,
          preEarningsAnchorIv: anchorContract?.impliedVolatility ?? null,
        });

        if (!earningsEvaluation.eligible) {
          return {
            ...emptyInvalidRow(target, earningsEvaluation.reason),
            nextEarningsDate: earningsInfo?.nextEarningsDate ?? null,
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
          };
        }

        adjustedEdge = earningsEvaluation.adjustedEdge;
        adjustedForwardVol = earningsEvaluation.adjustedForwardVol;
        notes = earningsEvaluation.reason;
        viable = adjustedEdge > MIN_VIABLE_ADJUSTED_EDGE;
      }

      return {
        shortTargetDte: target.shortDte,
        longTargetDte: target.longDte,
        nextEarningsDate: earningsInfo?.nextEarningsDate ?? null,
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
      };
    }),
  );

  rows.sort((a, b) => {
    const aEdge = a.forwardVolEdge ?? Number.NEGATIVE_INFINITY;
    const bEdge = b.forwardVolEdge ?? Number.NEGATIVE_INFINITY;
    return bEdge - aEdge;
  });

  return rows;
}
