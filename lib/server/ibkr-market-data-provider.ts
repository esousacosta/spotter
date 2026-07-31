import { getCached } from '@/lib/server/cache';
import * as ibkrClient from '@/lib/server/ibkr-client';
import type { OptionContract, OptionSnapshot } from '@/lib/server/market-data-provider';

const OPTION_CHAIN_CACHE_TTL_MS = 60 * 60 * 1_000;
const CONID_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const SNAPSHOT_BATCH_SIZE = 100;
const OPTION_FIELDS = '31,84,85,7283,7308';
const SPOT_FIELDS = '31,84,85,87';

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
  const cleaned = value.replace(/[$,]/g, '').trim();
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
};

async function getUnderlyingConid(symbol: string): Promise<string> {
  return getCached(`ibkr-conid:${symbol}`, CONID_CACHE_TTL_MS, () =>
    ibkrClient.searchConid(symbol),
  );
}

async function loadIbkrChain(symbol: string): Promise<IbkrChain> {
  const raw = await getCached(`ibkr-chain:${symbol}`, OPTION_CHAIN_CACHE_TTL_MS, async () => {
    const underlyingConid = await getUnderlyingConid(symbol);

    // Spot price — prefer last trade (31), fall back to bid/ask midpoint (84/85).
    const spotSnaps = await ibkrClient.snapshotMarketData([underlyingConid], SPOT_FIELDS);
    const spotSnap = spotSnaps[0];
    const bid = parseSnapshotField(spotSnap?.['84']);
    const ask = parseSnapshotField(spotSnap?.['85']);
    const midpoint = bid != null && ask != null && bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
    const spotPrice = parseSnapshotField(spotSnap?.['31']) ?? midpoint;
    if (!spotPrice || !Number.isFinite(spotPrice)) {
      throw new Error(`No valid spot price from IBKR for ${symbol}.`);
    }

    // Available months in the next 90 days — generated locally, no API call needed.
    const now = Date.now();
    const end = now + 90 * 24 * 60 * 60 * 1_000;
    const relevantMonths = ibkrClient.generateOptionMonths(now, end);
    if (relevantMonths.length === 0) {
      throw new Error(`No option months within 90 days found for ${symbol}.`);
    }

    // Collect option contract entries for all relevant months / filtered strikes
    const callEntries: ibkrClient.OptionContractEntry[] = [];
    const putEntries: ibkrClient.OptionContractEntry[] = [];
    let successfulStrikesMonths = 0;
    let saw429OnStrikes = false;
    let firstStrikesError: string | null = null;

    for (const month of relevantMonths) {
      let strikesData: { call: number[]; put: number[] };
      try {
        strikesData = await ibkrClient.getStrikes(underlyingConid, month);
      } catch (err) {
        // Month may not have listed options — skip, but log so real errors are visible.
        const msg = err instanceof Error ? err.message : String(err);
        if (firstStrikesError === null) firstStrikesError = msg;
        if (msg.includes('(429)')) saw429OnStrikes = true;
        console.warn(`[ibkr] ${symbol} ${month}: getStrikes failed (${msg}) — skipping month`);
        continue;
      }
      successfulStrikesMonths += 1;
      const callStrikes = filterStrikesInRange(strikesData.call ?? [], spotPrice);
      const putStrikes = filterStrikesInRange(strikesData.put ?? [], spotPrice);

      for (const strike of callStrikes) {
        const entries = await ibkrClient.getOptionConids(underlyingConid, month, 'C', strike);
        callEntries.push(...entries);
      }
      for (const strike of putStrikes) {
        const entries = await ibkrClient.getOptionConids(underlyingConid, month, 'P', strike);
        putEntries.push(...entries);
      }
    }

    if (callEntries.length === 0) {
      if (successfulStrikesMonths === 0 && saw429OnStrikes) {
        throw new Error(`IBKR rate-limited secdef/strikes for ${symbol}; try again in a few seconds.`);
      }
      if (successfulStrikesMonths === 0 && firstStrikesError) {
        throw new Error(
          `No option contracts loaded for ${symbol} because secdef/strikes failed for all months: ${firstStrikesError}`,
        );
      }
      throw new Error(`No call option contracts found for ${symbol} within strike range.`);
    }

    // Batch market data snapshots (max SNAPSHOT_BATCH_SIZE conids per call)
    const allConids = [...new Set([...callEntries, ...putEntries].map((e) => e.conid))];
    const snapshotMap = new Map<string, { bid: number | null; ask: number | null; iv: number | null; oi: number | null }>();

    for (let i = 0; i < allConids.length; i += SNAPSHOT_BATCH_SIZE) {
      const batch = allConids.slice(i, i + SNAPSHOT_BATCH_SIZE);
      const snaps = await ibkrClient.snapshotMarketData(batch, OPTION_FIELDS);
      for (const snap of snaps) {
        const conid = String(snap['conid'] ?? '');
        if (!conid) continue;
        snapshotMap.set(conid, {
          bid: parseSnapshotField(snap['84']),
          ask: parseSnapshotField(snap['85']),
          iv: parseSnapshotField(snap['7283']),
          oi: parseSnapshotField(snap['7308']),
        });
      }
    }

    // Build expiry maps
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
        // IV field 7283 is already a percentage (e.g. 24.5 = 24.5% IV) — divide by 100.
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

    if (callsByExpiry.size === 0) {
      console.warn(
        `[ibkr] No call options with implied volatility found for ${symbol}. ` +
          'Snapshots may have returned partial data.',
      );
    }

    return {
      spotPrice,
      callsByExpiry,
      putsByExpiry,
      volume: null,
      quoteTime: new Date().toISOString(),
    };
  });

  return {
    spotPrice: raw.spotPrice,
    callsByExpiry: normalizeExpiryMap(raw.callsByExpiry),
    putsByExpiry: normalizeExpiryMap(raw.putsByExpiry),
    volume: raw.volume,
    quoteTime: raw.quoteTime,
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
