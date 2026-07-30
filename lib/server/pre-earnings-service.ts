import { marketDataProvider, type OptionContract } from "@/lib/server/market-data-provider";
import type { EarningsInfo } from "@/lib/server/earnings-provider";
import type { PreEarningsRow, PreEarningsVerdict, Ticker } from "@/lib/types";

const MIN_AVG_VOLUME = 1_500_000;
const MIN_IV30_RV30 = 1.25;
const MAX_TS_SLOPE_0_45 = -0.00406;

function daysToExpiry(expiryUnix: number, now: Date): number {
  return (expiryUnix * 1000 - now.getTime()) / (1000 * 60 * 60 * 24);
}

function filterExpiries(expirationsUnix: number[], now: Date): number[] {
  const todayIso = now.toISOString().slice(0, 10);
  const sorted = expirationsUnix
    .map((expiryUnix) => ({
      expiryUnix,
      dateIso: new Date(expiryUnix * 1000).toISOString().slice(0, 10),
      dte: daysToExpiry(expiryUnix, now),
    }))
    .filter((entry) => entry.dte > 0)
    .sort((a, b) => a.expiryUnix - b.expiryUnix);

  const noToday = sorted.filter((entry) => entry.dateIso !== todayIso);
  const cutoffIndex = noToday.findIndex((entry) => entry.dte >= 45);
  if (cutoffIndex < 0) {
    return [];
  }
  return noToday.slice(0, cutoffIndex + 1).map((entry) => entry.expiryUnix);
}

function nearestAtm(contracts: OptionContract[], underlyingPrice: number): OptionContract | null {
  if (contracts.length === 0) {
    return null;
  }

  return [...contracts].sort((a, b) => {
    const delta = Math.abs(a.strike - underlyingPrice) - Math.abs(b.strike - underlyingPrice);
    if (delta !== 0) {
      return delta;
    }
    return a.strike - b.strike;
  })[0];
}

function termLinear(days: number[], ivs: number[]): (dte: number) => number {
  const entries = days
    .map((day, index) => ({ day, iv: ivs[index] }))
    .sort((a, b) => a.day - b.day);

  return (dte: number) => {
    if (entries.length === 0) {
      throw new Error("Term structure has no entries.");
    }
    if (dte <= entries[0].day) {
      return entries[0].iv;
    }
    if (dte >= entries[entries.length - 1].day) {
      return entries[entries.length - 1].iv;
    }

    for (let i = 1; i < entries.length; i += 1) {
      const left = entries[i - 1];
      const right = entries[i];
      if (dte >= left.day && dte <= right.day) {
        const range = right.day - left.day;
        if (range <= 0) {
          return left.iv;
        }
        const weight = (dte - left.day) / range;
        return left.iv + weight * (right.iv - left.iv);
      }
    }

    return entries[entries.length - 1].iv;
  };
}

function yangZhangFromBars(
  bars: Array<{ open: number; high: number; low: number; close: number }>,
  window = 30,
  tradingPeriods = 252,
): number | null {
  if (bars.length < window + 1) {
    return null;
  }

  const recent = bars.slice(-window);
  let sumLogOcSq = 0;
  let sumLogCcSq = 0;
  let sumRs = 0;

  for (let i = 0; i < recent.length; i += 1) {
    const day = recent[i];
    const prevClose = i === 0 ? bars[bars.length - window - 1].close : recent[i - 1].close;

    const logHo = Math.log(day.high / day.open);
    const logLo = Math.log(day.low / day.open);
    const logCo = Math.log(day.close / day.open);
    const logOc = Math.log(day.open / prevClose);
    const logCc = Math.log(day.close / prevClose);
    const rs = logHo * (logHo - logCo) + logLo * (logLo - logCo);

    sumLogOcSq += logOc ** 2;
    sumLogCcSq += logCc ** 2;
    sumRs += rs;
  }

  const divisor = window - 1;
  if (divisor <= 0) {
    return null;
  }

  const openVol = sumLogOcSq / divisor;
  const closeVol = sumLogCcSq / divisor;
  const windowRs = sumRs / divisor;
  const k = 0.34 / (1.34 + (window + 1) / (window - 1));
  const variance = openVol + k * closeVol + (1 - k) * windowRs;
  if (!(variance > 0)) {
    return null;
  }

  return Math.sqrt(variance) * Math.sqrt(tradingPeriods);
}

function toMid(bid: number | null, ask: number | null): number | null {
  if (bid === null || ask === null || !Number.isFinite(bid) || !Number.isFinite(ask)) {
    return null;
  }
  if (bid < 0 || ask < 0) {
    return null;
  }
  return (bid + ask) / 2;
}

function verdictFromFlags(input: {
  avgVolumePass: boolean;
  iv30Rv30Pass: boolean;
  tsSlopePass: boolean;
}): PreEarningsVerdict {
  if (input.avgVolumePass && input.iv30Rv30Pass && input.tsSlopePass) {
    return "recommended";
  }
  if (
    input.tsSlopePass &&
    ((input.avgVolumePass && !input.iv30Rv30Pass) ||
      (input.iv30Rv30Pass && !input.avgVolumePass))
  ) {
    return "consider";
  }
  return "avoid";
}

export async function computePreEarningsRow(
  ticker: Ticker,
  earningsInfo: EarningsInfo | null = null,
  now: Date = new Date(),
): Promise<PreEarningsRow | null> {
  const snapshot = await marketDataProvider.getOptionSnapshot(ticker.symbol);
  const filteredExpiries = filterExpiries(snapshot.expirations, now);
  if (filteredExpiries.length === 0) {
    return null;
  }

  const chains = await Promise.all(
    filteredExpiries.map(async (expiryUnix) => {
      const [calls, puts] = await Promise.all([
        marketDataProvider.getOptionChainCalls(ticker.symbol, expiryUnix),
        marketDataProvider.getOptionChainPuts(ticker.symbol, expiryUnix),
      ]);
      return { expiryUnix, calls, puts };
    }),
  );

  const dtes: number[] = [];
  const ivs: number[] = [];
  let expectedMove: string | null = null;

  for (let i = 0; i < chains.length; i += 1) {
    const chain = chains[i];
    const atmCall = nearestAtm(chain.calls, snapshot.spotPrice);
    const atmPut = nearestAtm(chain.puts, snapshot.spotPrice);
    if (!atmCall || !atmPut) {
      continue;
    }

    const atmIv = (atmCall.impliedVolatility + atmPut.impliedVolatility) / 2;
    const dte = daysToExpiry(chain.expiryUnix, now);
    if (!(dte > 0) || !Number.isFinite(atmIv) || atmIv <= 0) {
      continue;
    }
    dtes.push(dte);
    ivs.push(atmIv);

    if (i === 0) {
      const callMid = toMid(atmCall.bid, atmCall.ask);
      const putMid = toMid(atmPut.bid, atmPut.ask);
      if (callMid !== null && putMid !== null && snapshot.spotPrice > 0) {
        const straddle = callMid + putMid;
        expectedMove = `${((straddle / snapshot.spotPrice) * 100).toFixed(2)}%`;
      }
    }
  }

  if (dtes.length < 2) {
    return null;
  }

  const term = termLinear(dtes, ivs);
  const firstDte = Math.min(...dtes);
  const slopeDenominator = 45 - firstDte;
  if (Math.abs(slopeDenominator) < 1e-8) {
    return null;
  }
  const tsSlope0To45 = (term(45) - term(firstDte)) / slopeDenominator;

  const bars = await marketDataProvider.getHistoricalDailyBars(ticker.symbol, 90);
  const rv30 = yangZhangFromBars(
    bars.map((bar) => ({
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    })),
    30,
    252,
  );
  if (!rv30 || rv30 <= 0) {
    return null;
  }

  const recentVolumes = bars.slice(-30).map((bar) => bar.volume);
  if (recentVolumes.length < 30) {
    return null;
  }

  const avgVolume30 =
    recentVolumes.reduce((sum, volume) => sum + volume, 0) / recentVolumes.length;
  const iv30Rv30 = term(30) / rv30;

  const avgVolumePass = avgVolume30 >= MIN_AVG_VOLUME;
  const iv30Rv30Pass = iv30Rv30 >= MIN_IV30_RV30;
  const tsSlopePass = tsSlope0To45 <= MAX_TS_SLOPE_0_45;
  const verdict = verdictFromFlags({ avgVolumePass, iv30Rv30Pass, tsSlopePass });

  return {
    symbol: ticker.symbol,
    companyName: ticker.name,
    nextEarningsDate: earningsInfo?.nextEarningsDate ?? null,
    earningsSession: earningsInfo?.releaseSession ?? null,
    underlyingPrice: snapshot.spotPrice,
    expectedMove,
    avgVolume30,
    iv30Rv30,
    tsSlope0To45,
    avgVolumePass,
    iv30Rv30Pass,
    tsSlopePass,
    verdict,
    isViable: verdict !== "avoid",
    notes:
      verdict === "recommended"
        ? "Recommended: all pre-earnings checks passed."
        : verdict === "consider"
          ? "Consider: term-structure check passed with one supporting signal."
          : "Avoid: pre-earnings viability checks did not pass.",
  };
}
