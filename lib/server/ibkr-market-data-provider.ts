import {
  deleteCached,
  getCached,
  getCachedStaleWhileRevalidate,
  getCacheStatus,
} from '@/lib/server/cache';
import * as ibkrClient from '@/lib/server/ibkr-client';
import type { OptionContract, OptionSnapshot } from '@/lib/server/market-data-provider';

const OPTION_QUOTE_CACHE_TTL_MS = 30 * 1_000;
const OPTION_QUOTE_STALE_TTL_MS = 5 * 60 * 1_000;
const CONTRACT_METADATA_CACHE_TTL_MS = 12 * 60 * 60 * 1_000;
const SNAPSHOT_BATCH_SIZE = 100;
const OPTION_CHAIN_WINDOW_DAYS = 112;
const ATM_STRIKE_COUNT = 1;
const OPTION_FIELDS = '31,84,86,7633,7638';
const SPOT_FIELDS = '31,84,86,87';

// ---------------------------------------------------------------------------
// Helpers (exported for testing)
// ---------------------------------------------------------------------------

const MONTH_ABBR: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/** Convert an IBKR month code like "AUG25" to { year, month }. */
export function parseMonthCode(code: string): { year: number; month: number } | null {
  const abbr = code.slice(0, 3).toUpperCase();
  const yearPart = code.slice(3);
  const month = MONTH_ABBR[abbr];
  if (!month) return null;
  const year = yearPart.length === 2 ? 2000 + Number(yearPart) : Number(yearPart);
  if (!Number.isInteger(year) || year < 2000) return null;
  return { year, month };
}

/** True if the option month overlaps the [startMs, endMs] window. */
export function isMonthInRange(code: string, startMs: number, endMs: number): boolean {
  const parsed = parseMonthCode(code);
  if (!parsed) return false;
  const monthStart = Date.UTC(parsed.year, parsed.month - 1, 1);
  const monthEnd = Date.UTC(parsed.year, parsed.month, 0, 23, 59, 59);
  return monthStart <= endMs && monthEnd >= startMs;
}

/** Convert an IBKR YYYYMMDD expiry string to a Unix timestamp at noon UTC. */
export function expiryDateToUnix(dateStr: string): number {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(4, 6)) - 1; // 0-indexed
  const day = Number(dateStr.slice(6, 8));
  return Math.floor(Date.UTC(year, month, day, 12, 0, 0) / 1000);
}

/** Parse a market number from IBKR snapshot field values. */
export function parseSnapshotField(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[$,%]/g, '').trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Filter strikes to those within ±30% of the spot price. */
export function filterStrikesInRange(strikes: number[], spot: number): number[] {
  const low = spot * 0.7;
  const high = spot * 1.3;
  return strikes.filter((s) => s >= low && s <= high);
}

export function selectAtmStrikes(
  months: Array<{ call: number[]; put: number[] }>,
  spot: number,
  limit = ATM_STRIKE_COUNT,
): number[] {
  const coverage = new Map<number, number>();
  for (const month of months) {
    const putStrikes = new Set(month.put.filter(Number.isFinite));
    const commonStrikes = new Set(
      month.call.filter((strike) => Number.isFinite(strike) && putStrikes.has(strike)),
    );
    for (const strike of commonStrikes) {
      coverage.set(strike, (coverage.get(strike) ?? 0) + 1);
    }
  }

  return [...coverage.entries()]
    .sort(
      ([strikeA, coverageA], [strikeB, coverageB]) =>
        coverageB - coverageA || Math.abs(strikeA - spot) - Math.abs(strikeB - spot),
    )
    .slice(0, limit)
    .map(([strike]) => strike);
}

// ---------------------------------------------------------------------------
// normalizeExpiryMap — defensive Map reconstruction after disk-cache load
// ---------------------------------------------------------------------------

function normalizeExpiryMap(input: unknown): Map<number, OptionContract[]> {
  if (input instanceof Map) return input as Map<number, OptionContract[]>;

  const out = new Map<number, OptionContract[]>();
  if (!input || typeof input !== 'object') return out;

  for (const [rawKey, rawValue] of Object.entries(input)) {
    const expiry = Number(rawKey);
    if (!Number.isFinite(expiry) || !Array.isArray(rawValue)) continue;

    const contracts = (rawValue as unknown[]).filter(
      (c): c is OptionContract =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as OptionContract).strike === 'number' &&
        typeof (c as OptionContract).impliedVolatility === 'number' &&
        typeof (c as OptionContract).openInterest === 'number',
    );
    out.set(expiry, contracts);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Core chain loader
// ---------------------------------------------------------------------------

type IbkrChain = {
  spotPrice: number;
  callsByExpiry: Map<number, OptionContract[]>;
  putsByExpiry: Map<number, OptionContract[]>;
  volume: number | null;
  quoteTime: string | null;
  isStale: boolean;
};

type IbkrContractMetadata = {
  underlyingConid: string;
  relevantMonths: string[];
};

let metadataCacheHits = 0;
let metadataCacheMisses = 0;

export function getIbkrMetadataCacheMetrics(): { hits: number; misses: number } {
  return { hits: metadataCacheHits, misses: metadataCacheMisses };
}

export async function getCachedIbkrMetadata<T>(
  keySuffix: string,
  loader: () => Promise<T>,
): Promise<T> {
  const key = `ibkr-metadata-v1:${keySuffix}`;
  if (getCacheStatus(key) === 'fresh') {
    metadataCacheHits += 1;
  } else {
    metadataCacheMisses += 1;
  }
  const accessCount = metadataCacheHits + metadataCacheMisses;
  if (accessCount % 100 === 0) {
    console.info(
      `[ibkr] metadata cache: ${metadataCacheHits}/${accessCount} hits ` +
        `(${Math.round((metadataCacheHits / accessCount) * 100)}%).`,
    );
  }
  return getCached(key, CONTRACT_METADATA_CACHE_TTL_MS, loader);
}

function metadataDateKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

async function loadContractMetadata(
  symbol: string,
  now: number,
  end: number,
  underlying: ibkrClient.IbkrUnderlying,
): Promise<IbkrContractMetadata> {
  const dateKey = metadataDateKey(now);
  return getCachedIbkrMetadata(`${dateKey}:${symbol}:base`, async () => {
    const listedMonths =
      underlying.optionMonths.length > 0
        ? underlying.optionMonths
        : ibkrClient.generateOptionMonths(now, end);
    const earliestUsableExpiry = now + 24 * 60 * 60 * 1_000;
    const relevantMonths = listedMonths.filter((month) =>
      isMonthInRange(month, earliestUsableExpiry, end),
    );
    if (relevantMonths.length === 0) {
      throw new Error(
        `No option months within ${OPTION_CHAIN_WINDOW_DAYS} days found for ${symbol}.`,
      );
    }

    return {
      underlyingConid: underlying.conid,
      relevantMonths,
    };
  });
}

async function loadIbkrChain(symbol: string): Promise<IbkrChain> {
  const cacheResult = await getCachedStaleWhileRevalidate(
    `ibkr-quotes-v1:${symbol}`,
    OPTION_QUOTE_CACHE_TTL_MS,
    OPTION_QUOTE_STALE_TTL_MS,
    async () => {
      const loadStartedAt = Date.now();
      const now = Date.now();
      const end = now + OPTION_CHAIN_WINDOW_DAYS * 24 * 60 * 60 * 1_000;
      const dateKey = metadataDateKey(now);
      // IBKR's derivative preflight is a session-local side effect. Run it on
      // every quote refresh even when its returned metadata is cached.
      const underlying = await ibkrClient.searchUnderlying(symbol);
      const metadata = await loadContractMetadata(symbol, now, end, underlying);
      const underlyingConid = metadata.underlyingConid;
      const relevantMonths = metadata.relevantMonths;
      const searchCompletedAt = Date.now();
      const strikeDiscoveryMonth = relevantMonths[relevantMonths.length - 1];

      const [spotSnaps, strikes] = await Promise.all([
        ibkrClient.withMarketDataSession(() =>
          ibkrClient.snapshotMarketData([underlyingConid], SPOT_FIELDS, [], `${symbol} spot`),
        ),
        getCachedIbkrMetadata(
          `${dateKey}:${symbol}:strikes:${strikeDiscoveryMonth}`,
          () => ibkrClient.getStrikes(underlyingConid, strikeDiscoveryMonth),
        ),
      ]);
      const spotSnap = spotSnaps[0];
      const bid = parseSnapshotField(spotSnap?.['84']);
      const ask = parseSnapshotField(spotSnap?.['86']);
      const midpoint =
        bid != null && ask != null && bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
      const spotPrice = parseSnapshotField(spotSnap?.['31']) ?? midpoint;
      if (!spotPrice || !Number.isFinite(spotPrice)) {
        throw new Error(`No valid spot price from IBKR for ${symbol}.`);
      }
      const discoveryCompletedAt = Date.now();

      const strikeCandidates = selectAtmStrikes([strikes], spotPrice, 2);
    if (strikeCandidates.length === 0) {
      throw new Error(`No shared near-ATM call/put strikes found for ${symbol}.`);
    }
    const selectedStrikes = strikeCandidates.slice(0, 1);

    async function loadContractsForStrike(strike: number) {
      return Promise.all(
        relevantMonths.map(async (month) => {
          const keySuffix = `${dateKey}:${symbol}:contracts:${strike}:${month}`;
          try {
            return await getCachedIbkrMetadata(keySuffix, () =>
              ibkrClient.getOptionContracts(underlyingConid, month, strike),
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(
              `[ibkr] ${symbol} ${month} ${strike}: secdef/info failed (${message})`,
            );
            return [];
          }
        }),
      );
    }

    async function loadContracts(strikesToLoad: number[]) {
      return Promise.all(
        strikesToLoad.map(async (strike) => {
          let groups = await loadContractsForStrike(strike);
          if (groups.flat().length === 0) {
            await Promise.all(
              relevantMonths.map((month) =>
                deleteCached(
                  `ibkr-metadata-v1:${dateKey}:${symbol}:contracts:${strike}:${month}`,
                ),
              ),
            );
            groups = await loadContractsForStrike(strike);
          }
          return groups.flat();
        }),
      );
    }

    const contractGroups = await loadContracts(selectedStrikes);
    const allEntries = contractGroups.flat().filter((entry) => {
      const expiryMs = expiryDateToUnix(entry.expiry) * 1_000;
      return expiryMs >= now && expiryMs <= end;
    });
    const callEntries = allEntries.filter((entry) => entry.right === 'C');
    const putEntries = allEntries.filter((entry) => entry.right === 'P');

    if (callEntries.length === 0) {
      throw new Error(`No near-ATM call option contracts found for ${symbol}.`);
    }
    const contractsCompletedAt = Date.now();

    let allConids = [...new Set(allEntries.map((entry) => entry.conid))];
    const snapshotMap = new Map<
      string,
      { bid: number | null; ask: number | null; iv: number | null; oi: number | null }
    >();

    async function loadSnapshots(entries: ibkrClient.OptionContractEntry[]): Promise<void> {
      const conids = [...new Set(entries.map((entry) => entry.conid))];
      await ibkrClient.withMarketDataSession(async () => {
        for (let i = 0; i < conids.length; i += SNAPSHOT_BATCH_SIZE) {
          const batch = conids.slice(i, i + SNAPSHOT_BATCH_SIZE);
          const snaps = await ibkrClient.snapshotMarketData(
            batch,
            OPTION_FIELDS,
            ['7633'],
            `${symbol} options`,
          );
          for (const snap of snaps) {
            const conid = String(snap['conid'] ?? '');
            if (!conid) continue;
            snapshotMap.set(conid, {
              bid: parseSnapshotField(snap['84']),
              ask: parseSnapshotField(snap['86']),
              iv: parseSnapshotField(snap['7633']),
              oi: parseSnapshotField(snap['7638']),
            });
          }
        }
      });
    }

    await loadSnapshots(allEntries);

    const callsByExpiry = new Map<number, OptionContract[]>();
    const putsByExpiry = new Map<number, OptionContract[]>();

    function addToMap(
      entries: ibkrClient.OptionContractEntry[],
      targetMap: Map<number, OptionContract[]>,
    ): void {
      for (const entry of entries) {
        if (!entry.expiry || entry.expiry.length < 8) continue;
        const snap = snapshotMap.get(entry.conid);
        const ivRaw = snap?.iv;
        if (ivRaw == null || !Number.isFinite(ivRaw) || ivRaw <= 0) continue;

        const expiryUnix = expiryDateToUnix(entry.expiry);
        const contract: OptionContract = {
          strike: entry.strike,
          impliedVolatility: ivRaw / 100,
          openInterest: Math.round(snap?.oi ?? 0),
          bid: snap?.bid ?? null,
          ask: snap?.ask ?? null,
        };

        const existing = targetMap.get(expiryUnix) ?? [];
        existing.push(contract);
        targetMap.set(expiryUnix, existing);
      }
    }

    addToMap(callEntries, callsByExpiry);
    addToMap(putEntries, putsByExpiry);

    const fallbackStrike = strikeCandidates[1];
    if ((callsByExpiry.size < 2 || putsByExpiry.size < 2) && fallbackStrike != null) {
      const fallbackEntries = (await loadContracts([fallbackStrike])).flat().filter((entry) => {
        const expiryMs = expiryDateToUnix(entry.expiry) * 1_000;
        return expiryMs >= now && expiryMs <= end;
      });
      if (fallbackEntries.length > 0) {
        await loadSnapshots(fallbackEntries);
        addToMap(
          fallbackEntries.filter((entry) => entry.right === 'C'),
          callsByExpiry,
        );
        addToMap(
          fallbackEntries.filter((entry) => entry.right === 'P'),
          putsByExpiry,
        );
        allEntries.push(...fallbackEntries);
        allConids = [...new Set(allEntries.map((entry) => entry.conid))];
        selectedStrikes.push(fallbackStrike);
      }
    }

    if (callsByExpiry.size === 0) {
      throw new Error(
        `IBKR returned no strike-level implied volatility for ${symbol}; verify US options market-data permissions.`,
      );
    }

    console.info(
      `[ibkr] ${symbol} chain loaded in ${Date.now() - loadStartedAt}ms: ` +
        `${relevantMonths.length} months, ${selectedStrikes.length} ATM strikes, ` +
        `${allConids.length} contracts, ${callsByExpiry.size} call expiries, ` +
        `${putsByExpiry.size} put expiries ` +
        `(search ${searchCompletedAt - loadStartedAt}ms, ` +
        `spot+strikes ${discoveryCompletedAt - searchCompletedAt}ms, ` +
        `contracts ${contractsCompletedAt - discoveryCompletedAt}ms, ` +
        `quotes ${Date.now() - contractsCompletedAt}ms).`,
    );

    return {
      spotPrice,
      callsByExpiry,
      putsByExpiry,
      volume: null,
      quoteTime: new Date().toISOString(),
      isStale: false,
    };
  });

  return {
    spotPrice: cacheResult.value.spotPrice,
    callsByExpiry: normalizeExpiryMap(cacheResult.value.callsByExpiry),
    putsByExpiry: normalizeExpiryMap(cacheResult.value.putsByExpiry),
    volume: cacheResult.value.volume,
    quoteTime: cacheResult.value.quoteTime,
    isStale: cacheResult.isStale,
  };
}

// ---------------------------------------------------------------------------
// Exported provider
// ---------------------------------------------------------------------------

export const ibkrMarketDataProvider = {
  async getOptionSnapshot(symbol: string): Promise<OptionSnapshot> {
    const chain = await loadIbkrChain(symbol);
    const expirations = [...chain.callsByExpiry.keys()].sort((a, b) => a - b);
    return {
      spotPrice: chain.spotPrice,
      expirations,
      volume: chain.volume,
      quoteTime: chain.quoteTime,
      isStale: chain.isStale,
      freshUntil:
        chain.quoteTime !== null
          ? new Date(
              new Date(chain.quoteTime).getTime() + OPTION_QUOTE_CACHE_TTL_MS,
            ).toISOString()
          : null,
    };
  },

  async getOptionChainCalls(symbol: string, expirationUnix: number): Promise<OptionContract[]> {
    const chain = await loadIbkrChain(symbol);
    return chain.callsByExpiry.get(expirationUnix) ?? [];
  },

  async getOptionChainPuts(symbol: string, expirationUnix: number): Promise<OptionContract[]> {
    const chain = await loadIbkrChain(symbol);
    return chain.putsByExpiry.get(expirationUnix) ?? [];
  },
};
