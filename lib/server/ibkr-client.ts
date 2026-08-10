// IBKR Client Portal Gateway REST client.
//
// The gateway runs on localhost:5001 (HTTPS with a self-signed cert).
// This client automatically handles the self-signed certificate in development.
// For production use, import the gateway's self-signed cert as a trusted CA.

import { AsyncLocalStorage } from 'node:async_hooks';

// Allow self-signed certificates for localhost IBKR gateway in development
if (process.env.NODE_ENV !== 'production') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const IBKR_GATEWAY_URL = process.env.IBKR_GATEWAY_URL ?? 'https://localhost:5001';
const IBKR_REQUEST_TIMEOUT_MS = 15_000;
// CP Gateway sessions are limited to 10 requests/second.
const IBKR_REQUEST_GAP_MS = 110;
const BRIDGE_RETRY_DELAY_MS = 3_000;
type MarketDataPriority = 'interactive' | 'background';

const marketDataPriority = new AsyncLocalStorage<MarketDataPriority>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const interactiveRequestQueue: Array<() => void> = [];
const backgroundRequestQueue: Array<() => void> = [];
let requestDispatchActive = false;
let nextRequestAtMs = 0;
let consecutiveInteractiveRequests = 0;

async function dispatchRequestQueue(): Promise<void> {
  if (requestDispatchActive) return;
  requestDispatchActive = true;

  while (interactiveRequestQueue.length > 0 || backgroundRequestQueue.length > 0) {
    const waitMs = Math.max(0, nextRequestAtMs - Date.now());
    if (waitMs > 0) await sleep(waitMs);

    const priority = selectNextMarketDataPriority(
      interactiveRequestQueue.length,
      backgroundRequestQueue.length,
      consecutiveInteractiveRequests,
    );
    const next =
      priority === 'interactive'
        ? interactiveRequestQueue.shift()
        : priority === 'background'
          ? backgroundRequestQueue.shift()
          : undefined;
    if (!priority || !next) break;

    consecutiveInteractiveRequests =
      priority === 'interactive' ? consecutiveInteractiveRequests + 1 : 0;
    nextRequestAtMs = Date.now() + IBKR_REQUEST_GAP_MS;
    next();
  }

  requestDispatchActive = false;
}

function paceRequest(): Promise<void> {
  const priority = marketDataPriority.getStore() ?? 'background';
  return new Promise<void>((resolve) => {
    const queue = priority === 'interactive' ? interactiveRequestQueue : backgroundRequestQueue;
    queue.push(resolve);
    void dispatchRequestQueue();
  });
}

/** Fire-and-forget low-level fetch used solely for bridge re-auth — skips all logic above it. */
async function rawFetch(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${IBKR_GATEWAY_URL}${path}`, {
    ...options,
    signal: AbortSignal.timeout(IBKR_REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
}

const MAX_503_RETRIES = 4;
const RETRY_503_DELAY_MS = 2_000;
const MAX_429_RETRIES = 5;
const RETRY_429_BASE_DELAY_MS = 1_000;

async function ibkrFetch<T>(
  path: string,
  options: RequestInit = {},
  // retries503/retries429: remaining retry budgets; bridgeRetried prevents infinite bridge-repair loop
  retries503 = MAX_503_RETRIES,
  retries429 = MAX_429_RETRIES,
  bridgeRetried = false,
): Promise<T> {
  await paceRequest();

  const url = `${IBKR_GATEWAY_URL}${path}`;
  let response: Response;

  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(IBKR_REQUEST_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (
      msg.includes('ECONNREFUSED') ||
      msg.includes('fetch failed') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('connect')
    ) {
      throw new Error(
        'IBKR gateway is not running. Start it at https://localhost:5001 and authenticate.',
      );
    }
    throw error;
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      'IBKR session expired. Open https://localhost:5001 to re-authenticate.',
    );
  }

  if (response.status === 503 && retries503 > 0) {
    console.warn(`[ibkr] 503 on ${path} — retrying in ${RETRY_503_DELAY_MS}ms (${retries503} left)`);
    await sleep(RETRY_503_DELAY_MS);
    return ibkrFetch<T>(path, options, retries503 - 1, retries429, bridgeRetried);
  }

  if (response.status === 429 && retries429 > 0) {
    const attempt = MAX_429_RETRIES - retries429;
    const delayMs = Math.min(RETRY_429_BASE_DELAY_MS * 2 ** attempt, 8_000);
    console.warn(`[ibkr] 429 on ${path} — retrying in ${delayMs}ms (${retries429} left)`);
    await sleep(delayMs);
    return ibkrFetch<T>(path, options, retries503, retries429 - 1, bridgeRetried);
  }

  // "no bridge" means the iserver bridge to TWS/IB Gateway isn't established yet.
  // Call re-authenticate to wake it up, wait for it to connect, then retry once.
  if (response.status === 400) {
    const body = await response.text();
    if (body.includes('no bridge') && !bridgeRetried) {
      console.warn('[ibkr] "no bridge" — calling re-authenticate and retrying in 3 s…');
      await rawFetch('/v1/api/iserver/re-authenticate', { method: 'POST' }).catch(() => {});
      await sleep(BRIDGE_RETRY_DELAY_MS);
      return ibkrFetch<T>(path, options, retries503, retries429, true);
    }
    throw new Error(`IBKR request failed (400): ${body.slice(0, 240)}`);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`IBKR request failed (${response.status}): ${body.slice(0, 240)}`);
  }

  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Account initialisation (once per process, cached)
// ---------------------------------------------------------------------------

let cachedAccountId: string | null = null;
let accountInitPromise: Promise<string> | null = null;

type IbkrAccount = { id?: string; accountId?: string };

async function doInitAccount(): Promise<string> {
  // Proactively check the bridge. If not connected, trigger re-auth before
  // any iserver calls so we don't burn the single "no bridge" retry budget.
  try {
    type AuthStatus = { authenticated: boolean; connected: boolean };
    const status = await ibkrFetch<AuthStatus>('/v1/api/iserver/auth/status');
    if (!status.connected) {
      console.warn('[ibkr] IServer bridge not connected — calling re-authenticate…');
      await rawFetch('/v1/api/iserver/re-authenticate', { method: 'POST' }).catch(() => {});
      await sleep(BRIDGE_RETRY_DELAY_MS);
    }
  } catch {
    // If auth/status itself fails, proceed anyway — ibkrFetch will handle retries.
  }

  const accounts = await ibkrFetch<IbkrAccount[]>('/v1/api/portfolio/accounts');
  if (!accounts || accounts.length === 0) {
    throw new Error('No IBKR accounts found.');
  }
  const accountId = accounts[0].accountId ?? accounts[0].id;
  if (!accountId) {
    throw new Error('Could not determine IBKR account ID.');
  }
  await ibkrFetch('/v1/api/iserver/account', {
    method: 'POST',
    body: JSON.stringify({ acctId: accountId }),
  });
  cachedAccountId = accountId;
  return accountId;
}

async function initAccount(): Promise<string> {
  if (cachedAccountId) return cachedAccountId;
  if (!accountInitPromise) {
    accountInitPromise = doInitAccount().catch((err) => {
      accountInitPromise = null;
      throw err;
    });
  }
  return accountInitPromise;
}

// ---------------------------------------------------------------------------
// Contract search
// ---------------------------------------------------------------------------

type IbkrContractHit = {
  conid: string | number;
  symbol: string | null;
  description: string | null;
  sections?: Array<{ secType: string; months?: string; exchange?: string }>;
};

export type IbkrUnderlying = {
  conid: string;
  optionMonths: string[];
};

export function toIbkrSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replaceAll('.', ' ');
}

export async function searchUnderlying(symbol: string): Promise<IbkrUnderlying> {
  await initAccount();
  // Do not include the `name` parameter, even as false. IBKR documents that
  // its presence prevents the required derivative pre-flight from completing.
  const normalizedSymbol = toIbkrSymbol(symbol);
  const results = await ibkrFetch<IbkrContractHit[]>(
    `/v1/api/iserver/secdef/search?symbol=${encodeURIComponent(normalizedSymbol)}`,
  );
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(`Symbol ${symbol} not found in IBKR contract search.`);
  }
  const hit = results.find((result) => {
    const optionSection = result.sections?.find((section) => section.secType === 'OPT');
    return (
      result.symbol?.toUpperCase() === normalizedSymbol &&
      optionSection !== undefined &&
      (optionSection.exchange?.split(';').includes('SMART') ?? false)
    );
  });

  if (!hit?.conid) {
    throw new Error(`No SMART option contract definition found for ${symbol} in IBKR.`);
  }
  const optionSection = hit.sections?.find((section) => section.secType === 'OPT');
  const optionMonths =
    optionSection?.months
      ?.split(';')
      .map((month) => month.trim().toUpperCase())
      .filter(Boolean) ?? [];
  return { conid: String(hit.conid), optionMonths };
}

export async function searchConid(symbol: string): Promise<string> {
  return (await searchUnderlying(symbol)).conid;
}

// ---------------------------------------------------------------------------
// Option chain metadata
// ---------------------------------------------------------------------------

const MONTH_ABBRS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                     'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;

/**
 * Generate IBKR month codes (e.g. "AUG26") for all calendar months that
 * overlap the [startMs, endMs] window. No API call required — month codes
 * are deterministic from the current date.
 */
export function generateOptionMonths(startMs: number, endMs: number): string[] {
  const months: string[] = [];
  // Start at the first day of the month containing startMs
  const d = new Date(startMs);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);

  while (d.getTime() <= endMs) {
    const abbr = MONTH_ABBRS[d.getUTCMonth()];
    const year = String(d.getUTCFullYear()).slice(-2);
    months.push(`${abbr}${year}`);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return months;
}

type IbkrStrikesResponse = { call: number[]; put: number[] };

type IbkrSecdefEntry = {
  conid?: number;
  maturityDate?: string;
  strike?: number;
  right?: string;
};

export async function getStrikes(
  underlyingConid: string,
  month: string,
): Promise<IbkrStrikesResponse> {
  await initAccount();
  return ibkrFetch<IbkrStrikesResponse>(
    `/v1/api/iserver/secdef/strikes?conid=${encodeURIComponent(underlyingConid)}&sectype=OPT&month=${encodeURIComponent(month)}&exchange=SMART`,
  );
}

export type OptionContractEntry = {
  conid: string;
  right: 'C' | 'P';
  strike: number;
  expiry: string; // YYYYMMDD
  month: string;
};

export async function getOptionContracts(
  underlyingConid: string,
  month: string,
  strike: number,
): Promise<OptionContractEntry[]> {
  await initAccount();
  const results = await ibkrFetch<IbkrSecdefEntry[]>(
    `/v1/api/iserver/secdef/info?conid=${encodeURIComponent(underlyingConid)}&exchange=SMART&sectype=OPT&month=${encodeURIComponent(month)}&strike=${strike}`,
  );
  if (!Array.isArray(results)) return [];
  return results
    .filter(
      (result): result is IbkrSecdefEntry & { conid: number; maturityDate: string; strike: number; right: 'C' | 'P' } =>
        Boolean(
          result.conid &&
            result.maturityDate &&
            result.strike != null &&
            (result.right === 'C' || result.right === 'P'),
        ),
    )
    .map((r) => ({
      conid: String(r.conid),
      right: r.right,
      strike: r.strike,
      expiry: r.maturityDate,
      month,
    }));
}

// ---------------------------------------------------------------------------
// Market data snapshot
//
// IBKR quirk: the first snapshot call subscribes to data; subsequent calls
// return it. Retry up to 5 times (waiting 500 ms between attempts).
// ---------------------------------------------------------------------------

type IbkrSnapshotEntry = Record<string, string | number | undefined>;

const SNAPSHOT_RETRY_ATTEMPTS = 5;
const SNAPSHOT_RETRY_DELAY_MS = 500;

function snapshotHasData(
  entries: IbkrSnapshotEntry[],
  requiredFields: string[],
  expectedEntries: number,
): boolean {
  if (requiredFields.length > 0) {
    const populated = entries.filter((entry) =>
      requiredFields.some((field) => entry[field] != null),
    ).length;
    const requiredCount = Math.min(
      expectedEntries,
      Math.max(2, Math.min(6, Math.ceil(expectedEntries * 0.6))),
    );
    return populated >= requiredCount;
  }
  return entries.some((entry) => entry['84'] != null || entry['86'] != null || entry['31'] != null);
}

function mergeSnapshotEntries(
  target: Map<string, IbkrSnapshotEntry>,
  entries: IbkrSnapshotEntry[],
): void {
  for (const entry of entries) {
    const conid = String(entry.conid ?? entry.conidEx ?? '');
    if (!conid) continue;
    target.set(conid, { ...(target.get(conid) ?? {}), ...entry });
  }
}

export async function snapshotMarketData(
  conids: string[],
  fields: string,
  requiredFields: string[] = [],
  label = 'snapshot',
): Promise<IbkrSnapshotEntry[]> {
  if (conids.length === 0) return [];
  await initAccount();

  const endpoint = `/v1/api/iserver/marketdata/snapshot?conids=${conids.join(',')}&fields=${fields}`;
  const merged = new Map<string, IbkrSnapshotEntry>();
  mergeSnapshotEntries(merged, await ibkrFetch<IbkrSnapshotEntry[]>(endpoint));

  for (
    let i = 0;
    i < SNAPSHOT_RETRY_ATTEMPTS &&
    !snapshotHasData([...merged.values()], requiredFields, conids.length);
    i += 1
  ) {
    await sleep(SNAPSHOT_RETRY_DELAY_MS);
    mergeSnapshotEntries(merged, await ibkrFetch<IbkrSnapshotEntry[]>(endpoint));
  }

  const results = [...merged.values()];
  if (!snapshotHasData(results, requiredFields, conids.length)) {
    const populated = results.filter((entry) =>
      requiredFields.some((field) => entry[field] != null),
    ).length;
    console.warn(
      `[ibkr] ${label} populated ${populated}/${conids.length} contracts for fields ` +
        `${requiredFields.join(',') || fields} after retries.`,
    );
  }

  return results;
}

const interactiveMarketDataQueue: Array<() => void> = [];
const backgroundMarketDataQueue: Array<() => void> = [];
const MAX_INTERACTIVE_SESSION_BURST = 4;
let marketDataSessionActive = false;
let consecutiveInteractiveSessions = 0;
let interactiveSessionsDispatched = 0;
let backgroundSessionsDispatched = 0;

export function selectNextMarketDataPriority(
  interactiveCount: number,
  backgroundCount: number,
  interactiveBurst: number,
): MarketDataPriority | null {
  if (backgroundCount > 0 && (interactiveCount === 0 || interactiveBurst >= MAX_INTERACTIVE_SESSION_BURST)) {
    return 'background';
  }
  if (interactiveCount > 0) return 'interactive';
  return backgroundCount > 0 ? 'background' : null;
}

function recordDispatchedSession(priority: MarketDataPriority): void {
  if (priority === 'interactive') {
    consecutiveInteractiveSessions += 1;
    interactiveSessionsDispatched += 1;
  } else {
    consecutiveInteractiveSessions = 0;
    backgroundSessionsDispatched += 1;
  }
}

export function getMarketDataSchedulerMetrics(): {
  interactiveQueued: number;
  backgroundQueued: number;
  interactiveDispatched: number;
  backgroundDispatched: number;
  interactiveRequestsQueued: number;
  backgroundRequestsQueued: number;
} {
  return {
    interactiveQueued: interactiveMarketDataQueue.length,
    backgroundQueued: backgroundMarketDataQueue.length,
    interactiveDispatched: interactiveSessionsDispatched,
    backgroundDispatched: backgroundSessionsDispatched,
    interactiveRequestsQueued: interactiveRequestQueue.length,
    backgroundRequestsQueued: backgroundRequestQueue.length,
  };
}

function acquireMarketDataSession(priority: MarketDataPriority): Promise<void> {
  if (!marketDataSessionActive) {
    marketDataSessionActive = true;
    recordDispatchedSession(priority);
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const queue =
      priority === 'interactive' ? interactiveMarketDataQueue : backgroundMarketDataQueue;
    queue.push(resolve);
  });
}

function releaseMarketDataSession(): void {
  const priority = selectNextMarketDataPriority(
    interactiveMarketDataQueue.length,
    backgroundMarketDataQueue.length,
    consecutiveInteractiveSessions,
  );
  const next =
    priority === 'interactive'
      ? interactiveMarketDataQueue.shift()
      : priority === 'background'
        ? backgroundMarketDataQueue.shift()
        : undefined;
  if (priority && next) {
    recordDispatchedSession(priority);
    next();
    return;
  }
  marketDataSessionActive = false;
}

export function withInteractiveIbkrRequest<T>(fn: () => Promise<T>): Promise<T> {
  return marketDataPriority.run('interactive', fn);
}

export async function withMarketDataSession<T>(fn: () => Promise<T>): Promise<T> {
  await acquireMarketDataSession(marketDataPriority.getStore() ?? 'background');

  try {
    return await fn();
  } finally {
    try {
      await ibkrFetch('/v1/api/iserver/marketdata/unsubscribeall');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ibkr] Failed to release market-data streams: ${message}`);
    }
    releaseMarketDataSession();
  }
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

type IbkrTickleResponse = {
  session: boolean;
  hmds: { error: string } | null;
  iserver: Record<string, unknown>;
};

export async function tickle(): Promise<IbkrTickleResponse> {
  return ibkrFetch<IbkrTickleResponse>('/v1/api/tickle', { method: 'POST' });
}

type IbkrAuthStatus = {
  authenticated: boolean;
  connected: boolean;
  competing: boolean;
  message?: string;
};

export async function getAuthStatus(): Promise<IbkrAuthStatus> {
  return ibkrFetch<IbkrAuthStatus>('/v1/api/iserver/auth/status');
}

/** Returns true if the IBKR gateway is reachable and authenticated. */
export async function isIbkrAvailable(): Promise<boolean> {
  try {
    const status = await getAuthStatus();
    return status.authenticated === true;
  } catch {
    return false;
  }
}

const KEEPALIVE_INTERVAL_MS = 3 * 60 * 1_000;

export function startIbkrKeepalive(): void {
  setInterval(async () => {
    try {
      const result = await tickle();
      if (result.session === false) {
        console.warn(
          '[ibkr] Session appears expired. Open https://localhost:5001 to re-authenticate.',
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[ibkr] Keepalive tickle failed: ${msg}`);
    }
  }, KEEPALIVE_INTERVAL_MS);
}
