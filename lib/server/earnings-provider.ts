import { getCached } from "@/lib/server/cache";
import { getMarketDateIso } from "@/lib/market-time";

const NASDAQ_EARNINGS_URL = "https://api.nasdaq.com/api/calendar/earnings";
const EARNINGS_CACHE_TTL_MS = 15 * 60 * 1000;
const EARNINGS_MAX_HORIZON_DAYS = 120;
const EARNINGS_BUFFER_DAYS = 30;

type NasdaqEarningsRow = {
  symbol?: string;
  time?: string;
};

type NasdaqEarningsResponse = {
  data?: {
    rows?: NasdaqEarningsRow[];
  } | null;
};

export type EarningsInfo = {
  symbol: string;
  nextEarningsDate: string | null;
  releaseSession: string | null;
  isReliable: boolean;
  retrievedAt: string;
};

export type UpcomingEarningsEvent = {
  symbol: string;
  earningsDate: string;
  earningsSession: string | null;
};

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(base: Date, days: number): Date {
  const date = new Date(base);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json, text/plain, */*",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Earnings data request failed (${response.status}): ${body.slice(0, 240)}`);
  }

  return (await response.json()) as T;
}

async function fetchNasdaqRowsByDate(dateIso: string): Promise<NasdaqEarningsRow[]> {
  const payload = await fetchJson<NasdaqEarningsResponse>(`${NASDAQ_EARNINGS_URL}?date=${dateIso}`);
  return payload.data?.rows ?? [];
}

async function fetchNasdaqRowsByDateWithRetry(dateIso: string): Promise<NasdaqEarningsRow[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetchNasdaqRowsByDate(dateIso);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to fetch earnings calendar for ${dateIso}.`);
}

function computeHorizonDays(shortTargetDtes: number[]): number {
  const maxShort = shortTargetDtes.length > 0 ? Math.max(...shortTargetDtes) : 60;
  return Math.min(EARNINGS_MAX_HORIZON_DAYS, maxShort + EARNINGS_BUFFER_DAYS);
}

export async function getNextEarningsForSymbols(
  symbols: string[],
  shortTargetDtes: number[],
  now: Date = new Date(),
): Promise<Map<string, EarningsInfo>> {
  const normalizedSymbols = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()))];
  const horizonDays = computeHorizonDays(shortTargetDtes);
  const startIso = getMarketDateIso(now);
  const cacheKey = `earnings:${startIso}:h${horizonDays}`;

  const baseMap = await getCached(cacheKey, EARNINGS_CACHE_TTL_MS, async () => {
    const earliestBySymbol = new Map<string, { date: string; session: string | null }>();
    const failedDates = new Set<string>();

    for (let dayOffset = 0; dayOffset <= horizonDays; dayOffset += 1) {
      const currentDate = addUtcDays(new Date(`${startIso}T00:00:00.000Z`), dayOffset);
      const currentIso = toIsoDate(currentDate);

      try {
        const rows = await fetchNasdaqRowsByDateWithRetry(currentIso);
        for (const row of rows) {
          const rawSymbol = row.symbol?.trim().toUpperCase();
          if (!rawSymbol) {
            continue;
          }
          if (!earliestBySymbol.has(rawSymbol)) {
            earliestBySymbol.set(rawSymbol, {
              date: currentIso,
              session: row.time?.trim() || null,
            });
          }
        }
      } catch {
        failedDates.add(currentIso);
      }
    }

    return {
      earliestBySymbol,
      failedDates,
    };
  });

  const result = new Map<string, EarningsInfo>();
  const retrievedAt = now.toISOString();
  for (const symbol of normalizedSymbols) {
    const found = baseMap.earliestBySymbol.get(symbol);
    if (!found) {
      result.set(symbol, {
        symbol,
        nextEarningsDate: null,
        releaseSession: null,
        isReliable: false,
        retrievedAt,
      });
      continue;
    }

    result.set(symbol, {
      symbol,
      nextEarningsDate: found.date,
      releaseSession: found.session,
      isReliable: true,
      retrievedAt,
    });
  }

  return result;
}

export async function getUpcomingEarningsEvents(
  daysAhead: number,
  now: Date = new Date(),
): Promise<UpcomingEarningsEvent[]> {
  const boundedDaysAhead = Math.max(1, Math.min(daysAhead, 60));
  const startIso = getMarketDateIso(now);
  const cacheKey = `earnings-upcoming:${startIso}:d${boundedDaysAhead}`;

  const rowsByDate = await getCached(cacheKey, EARNINGS_CACHE_TTL_MS, async () => {
    const rows: UpcomingEarningsEvent[] = [];
    for (let dayOffset = 0; dayOffset <= boundedDaysAhead; dayOffset += 1) {
      const currentDate = addUtcDays(new Date(`${startIso}T00:00:00.000Z`), dayOffset);
      const currentIso = toIsoDate(currentDate);

      try {
        const dayRows = await fetchNasdaqRowsByDateWithRetry(currentIso);
        for (const dayRow of dayRows) {
          const symbol = dayRow.symbol?.trim().toUpperCase();
          if (!symbol) {
            continue;
          }

          rows.push({
            symbol,
            earningsDate: currentIso,
            earningsSession: dayRow.time?.trim() || null,
          });
        }
      } catch {
        continue;
      }
    }
    return rows;
  });

  return rowsByDate;
}
