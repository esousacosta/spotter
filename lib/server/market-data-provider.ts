import { getCached } from "@/lib/server/cache";
import type { Ticker } from "@/lib/types";

const S_AND_P_500_PRIMARY_URL =
  "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";
const S_AND_P_500_FALLBACK_URL =
  "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies";
const CBOE_OPTIONS_URL = "https://cdn.cboe.com/api/global/delayed_quotes/options";
const NASDAQ_HISTORICAL_URL = "https://api.nasdaq.com/api/quote";
const TICKER_CACHE_TTL_MS = 60 * 60 * 1000;
const OPTION_CHAIN_CACHE_TTL_MS = 60 * 60 * 1000;
const HISTORICAL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CBOE_REQUEST_GAP_MS = 1500;
const NASDAQ_REQUEST_GAP_MS = 25;
const MAX_RATE_LIMIT_RETRIES = 5;

const providerQueue = new Map<string, Promise<void>>();
const providerNextAllowedMs = new Map<string, number>();

type CboeOptionRow = {
  option?: string;
  iv?: number;
  open_interest?: number;
  bid?: number;
  ask?: number;
};

type CboeOptionsResponse = {
  data?: {
    current_price?: number;
    prev_day_close?: number;
    volume?: number | string;
    options?: CboeOptionRow[];
  };
};

export type OptionContract = {
  strike: number;
  impliedVolatility: number;
  openInterest: number;
  bid: number | null;
  ask: number | null;
};

export type OptionSnapshot = {
  spotPrice: number;
  expirations: number[];
  volume: number | null;
};

export type HistoricalDailyBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type ParsedCboeChain = {
  spotPrice: number;
  callsByExpiry: Map<number, OptionContract[]>;
  putsByExpiry: Map<number, OptionContract[]>;
  volume: number | null;
};

function normalizeExpiryMap(input: unknown): Map<number, OptionContract[]> {
  if (input instanceof Map) {
    return input as Map<number, OptionContract[]>;
  }

  const normalized = new Map<number, OptionContract[]>();
  if (!input || typeof input !== "object") {
    return normalized;
  }

  for (const [rawKey, rawValue] of Object.entries(input)) {
    const expiry = Number(rawKey);
    if (!Number.isFinite(expiry)) {
      continue;
    }
    if (!Array.isArray(rawValue)) {
      continue;
    }

    const contracts = rawValue.filter(
      (contract): contract is OptionContract =>
        !!contract &&
        typeof contract === "object" &&
        typeof (contract as OptionContract).strike === "number" &&
        typeof (contract as OptionContract).impliedVolatility === "number" &&
        typeof (contract as OptionContract).openInterest === "number",
    );
    normalized.set(expiry, contracts);
  }

  return normalized;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProviderSlot(provider: string, minGapMs: number): Promise<void> {
  const previous = providerQueue.get(provider) ?? Promise.resolve();
  const scheduled = previous.then(async () => {
    const now = Date.now();
    const nextAllowed = providerNextAllowedMs.get(provider) ?? now;
    const waitMs = Math.max(0, nextAllowed - now);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    providerNextAllowedMs.set(provider, Date.now() + minGapMs);
  });

  providerQueue.set(provider, scheduled.catch(() => undefined));
  await scheduled;
}

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) {
    return null;
  }

  const asSeconds = Number(headerValue);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return asSeconds * 1000;
  }

  const retryAt = Date.parse(headerValue);
  if (!Number.isFinite(retryAt)) {
    return null;
  }

  return Math.max(0, retryAt - Date.now());
}

async function fetchText(
  url: string,
  options: { provider: string; minGapMs: number },
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    await waitForProviderSlot(options.provider, options.minGapMs);

    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json, text/plain, */*",
      },
    });

    if (response.ok) {
      return response.text();
    }

    const body = await response.text();
    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfterMs =
        parseRetryAfterMs(response.headers.get("retry-after")) ??
        Math.min(2_000 * 2 ** attempt, 60_000);
      providerNextAllowedMs.set(
        options.provider,
        Math.max(providerNextAllowedMs.get(options.provider) ?? 0, Date.now() + retryAfterMs),
      );
      lastError = new Error(`${options.provider} request failed (429): ${body.slice(0, 240)}`);
      continue;
    }

    throw new Error(`${options.provider} request failed (${response.status}): ${body.slice(0, 240)}`);
  }

  throw lastError ?? new Error(`${options.provider} request failed after retries.`);
}

async function fetchJson<T>(
  url: string,
  options: { provider: string; minGapMs: number },
): Promise<T> {
  const body = await fetchText(url, options);
  return JSON.parse(body) as T;
}

function parseMarketNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value.replaceAll("$", "").replaceAll(",", "").trim();
  if (!cleaned) {
    return null;
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      fields.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  fields.push(current);
  return fields.map((field) => field.trim());
}

function parseConstituentCsv(csv: string): Ticker[] {
  const lines = csv
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const dataLines = lines.slice(1);
  const rows = dataLines
    .map((line) => parseCsvLine(line))
    .filter((columns) => columns.length >= 2)
    .map((columns) => ({
      symbol: columns[0].toUpperCase(),
      name: columns[1],
    }))
    .filter((row) => row.symbol.length > 0 && row.name.length > 0);

  if (rows.length === 0) {
    throw new Error("S&P 500 CSV source returned no valid rows.");
  }

  return rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function decodeHtml(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&#160;", " ")
    .replaceAll("&nbsp;", " ")
    .trim();
}

function parseFallbackWikipediaTable(html: string): Ticker[] {
  const table = html.match(/<table[^>]*id="constituents"[\s\S]*?<\/table>/i)?.[0];
  if (!table) {
    throw new Error("Could not parse S&P 500 table from fallback source.");
  }

  const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)]
    .map((row) => row[1])
    .map((rowHtml) =>
      [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
        decodeHtml(cell[1].replaceAll(/<[^>]+>/g, "")),
      ),
    )
    .filter((cells) => cells.length >= 2)
    .map((cells) => ({ symbol: cells[0].toUpperCase(), name: cells[1] }))
    .filter((row) => row.symbol !== "SYMBOL" && row.symbol.length > 0 && row.name.length > 0);

  if (rows.length === 0) {
    throw new Error("Fallback source returned no valid S&P 500 rows.");
  }

  return rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function parseOccOptionSymbol(
  occSymbol: string,
): { expiryUnix: number; optionType: "C" | "P"; strike: number } | null {
  const match = occSymbol.match(/^(.+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!match) {
    return null;
  }

  const year = 2000 + Number(match[2]);
  const month = Number(match[3]);
  const day = Number(match[4]);
  const optionType = match[5] as "C" | "P";
  const strike = Number(match[6]) / 1000;

  if (!Number.isFinite(strike) || strike <= 0) {
    return null;
  }

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }

  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return null;
  }

  const expiryUnix = Math.floor(Date.UTC(year, month - 1, day, 12, 0, 0) / 1000);
  return { expiryUnix, optionType, strike };
}

async function loadCboeChain(symbol: string): Promise<ParsedCboeChain> {
  const chain = await getCached(`cboe-chain:${symbol}`, OPTION_CHAIN_CACHE_TTL_MS, async () => {
    const payload = await fetchJson<CboeOptionsResponse>(
      `${CBOE_OPTIONS_URL}/${encodeURIComponent(symbol)}.json`,
      { provider: "Cboe options", minGapMs: CBOE_REQUEST_GAP_MS },
    );

    const data = payload.data;
    if (!data) {
      throw new Error(`No option-chain payload returned for ${symbol}.`);
    }

    const spotPrice = data.current_price ?? data.prev_day_close;
    if (!spotPrice || !Number.isFinite(spotPrice)) {
      throw new Error(`No valid spot price returned for ${symbol}.`);
    }

    const options = data.options ?? [];
    const callsByExpiry = new Map<number, OptionContract[]>();
    const putsByExpiry = new Map<number, OptionContract[]>();
    const volume = parseMarketNumber(data.volume);

    for (const optionRow of options) {
      const occ = optionRow.option;
      const iv = optionRow.iv;
      if (!occ || !iv || !Number.isFinite(iv) || iv <= 0) {
        continue;
      }

      const parsed = parseOccOptionSymbol(occ);
      if (!parsed) {
        continue;
      }

      const contract: OptionContract = {
        strike: parsed.strike,
        impliedVolatility: iv,
        openInterest:
          typeof optionRow.open_interest === "number" && Number.isFinite(optionRow.open_interest)
            ? optionRow.open_interest
            : 0,
        bid: parseMarketNumber(optionRow.bid),
        ask: parseMarketNumber(optionRow.ask),
      };

      const targetMap = parsed.optionType === "C" ? callsByExpiry : putsByExpiry;
      const existing = targetMap.get(parsed.expiryUnix) ?? [];
      existing.push({
        ...contract,
      });
      targetMap.set(parsed.expiryUnix, existing);
    }

    if (callsByExpiry.size === 0) {
      throw new Error(`No call options with implied volatility found for ${symbol}.`);
    }

    return {
      spotPrice,
      callsByExpiry,
      putsByExpiry,
      volume,
    };
  });

  return {
    spotPrice: chain.spotPrice,
    callsByExpiry: normalizeExpiryMap(chain.callsByExpiry),
    putsByExpiry: normalizeExpiryMap(chain.putsByExpiry),
    volume: chain.volume,
  };
}

type NasdaqHistoricalResponse = {
  data?: {
    tradesTable?: {
      rows?: Array<{
        date?: string;
        open?: string;
        high?: string;
        low?: string;
        close?: string;
        volume?: string;
      }>;
    };
  } | null;
};

function parseNasdaqDate(date: string): string | null {
  const match = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) {
    return null;
  }
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month || !day || !year) {
    return null;
  }
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

async function fetchNasdaqHistoricalBars(symbol: string, limit = 90): Promise<HistoricalDailyBar[]> {
  const now = new Date();
  const toDate = now.toISOString().slice(0, 10);
  const fromDateObj = new Date(now);
  fromDateObj.setUTCDate(fromDateObj.getUTCDate() - 220);
  const fromDate = fromDateObj.toISOString().slice(0, 10);

  const payload = await fetchJson<NasdaqHistoricalResponse>(
    `${NASDAQ_HISTORICAL_URL}/${encodeURIComponent(symbol)}/historical?assetclass=stocks&fromdate=${fromDate}&todate=${toDate}&limit=${limit}`,
    { provider: "Nasdaq historical", minGapMs: NASDAQ_REQUEST_GAP_MS },
  );

  const rows = payload.data?.tradesTable?.rows ?? [];
  const bars = rows
    .map((row) => {
      const date = row.date ? parseNasdaqDate(row.date) : null;
      const open = parseMarketNumber(row.open);
      const high = parseMarketNumber(row.high);
      const low = parseMarketNumber(row.low);
      const close = parseMarketNumber(row.close);
      const volume = parseMarketNumber(row.volume);

      if (!date || open === null || high === null || low === null || close === null || volume === null) {
        return null;
      }

      return {
        date,
        open,
        high,
        low,
        close,
        volume,
      } satisfies HistoricalDailyBar;
    })
    .filter((value): value is HistoricalDailyBar => value !== null)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (bars.length === 0) {
    throw new Error(`No valid historical bars returned for ${symbol}.`);
  }

  return bars;
}

export const marketDataProvider = {
  async getSP500Tickers(): Promise<Ticker[]> {
    return getCached("sp500-tickers", TICKER_CACHE_TTL_MS, async () => {
      try {
        const csv = await fetchText(S_AND_P_500_PRIMARY_URL, {
          provider: "S&P constituents CSV",
          minGapMs: 0,
        });
        return parseConstituentCsv(csv);
      } catch {
        const html = await fetchText(S_AND_P_500_FALLBACK_URL, {
          provider: "Wikipedia constituents fallback",
          minGapMs: 0,
        });
        return parseFallbackWikipediaTable(html);
      }
    });
  },

  async getOptionSnapshot(symbol: string): Promise<OptionSnapshot> {
    const chain = await loadCboeChain(symbol);
    const expirations = [...chain.callsByExpiry.keys()].sort((a, b) => a - b);
    return {
      spotPrice: chain.spotPrice,
      expirations,
      volume: chain.volume,
    };
  },

  async getOptionChainCalls(symbol: string, expirationUnix: number): Promise<OptionContract[]> {
    const chain = await loadCboeChain(symbol);
    return chain.callsByExpiry.get(expirationUnix) ?? [];
  },

  async getOptionChainPuts(symbol: string, expirationUnix: number): Promise<OptionContract[]> {
    const chain = await loadCboeChain(symbol);
    return chain.putsByExpiry.get(expirationUnix) ?? [];
  },

  async getHistoricalDailyBars(symbol: string, limit = 90): Promise<HistoricalDailyBar[]> {
    return getCached(`nasdaq-hist:${symbol}:${limit}`, HISTORICAL_CACHE_TTL_MS, async () =>
      fetchNasdaqHistoricalBars(symbol, limit),
    );
  },
};
