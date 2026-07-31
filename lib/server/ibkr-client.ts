// IBKR Client Portal Gateway REST client.
//
// The gateway runs on localhost:5001 (HTTPS with a self-signed cert).
// Set NODE_TLS_REJECT_UNAUTHORIZED=0 in .env.local for development.
// For production use, import the gateway's self-signed cert as a trusted CA.
//
// KNOWN LIMITATION: NODE_TLS_REJECT_UNAUTHORIZED=0 must never be set on a
// remote server or in any production environment.

const IBKR_GATEWAY_URL = process.env.IBKR_GATEWAY_URL ?? 'https://localhost:5001';
const IBKR_REQUEST_TIMEOUT_MS = 15_000;
const IBKR_REQUEST_GAP_MS = 50;

let lastRequestMs = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paceRequest(): Promise<void> {
  const now = Date.now();
  const wait = lastRequestMs + IBKR_REQUEST_GAP_MS - now;
  if (wait > 0) await sleep(wait);
  lastRequestMs = Date.now();
}

async function ibkrFetch<T>(
  path: string,
  options: RequestInit = {},
  retryOn503 = true,
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

  if (response.status === 503 && retryOn503) {
    await sleep(1_000);
    return ibkrFetch<T>(path, options, false);
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
  symbol: string;
  description: string;
  sections?: Array<{ secType: string }>;
};

export async function searchConid(symbol: string): Promise<string> {
  await initAccount();
  const results = await ibkrFetch<IbkrContractHit[]>(
    `/v1/api/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}&name=false&secType=STK`,
  );
  if (!results || results.length === 0) {
    throw new Error(`Symbol ${symbol} not found in IBKR contract search.`);
  }
  const hit =
    results.find(
      (r) =>
        (r.description === symbol || r.symbol === symbol) &&
        r.sections?.some((s) => s.secType === 'OPT'),
    ) ?? results[0];

  if (!hit?.conid) {
    throw new Error(`Symbol ${symbol} not found in IBKR contract search.`);
  }
  return String(hit.conid);
}

// ---------------------------------------------------------------------------
// Option chain metadata
// ---------------------------------------------------------------------------

type IbkrSecdefEntry = {
  conid?: number;
  month?: string;
  maturityDate?: string;
  right?: string;
  strike?: number;
};

export async function getOptionMonths(underlyingConid: string): Promise<string[]> {
  await initAccount();
  const results = await ibkrFetch<IbkrSecdefEntry[]>(
    `/v1/api/iserver/secdef/info?conid=${encodeURIComponent(underlyingConid)}&sectype=OPT&month=&right=C&strike=0`,
  );
  if (!Array.isArray(results)) return [];
  const months = new Set<string>();
  for (const entry of results) {
    if (typeof entry.month === 'string' && entry.month) {
      months.add(entry.month);
    }
  }
  return [...months];
}

type IbkrStrikesResponse = { call: number[]; put: number[] };

export async function getStrikes(
  underlyingConid: string,
  month: string,
): Promise<IbkrStrikesResponse> {
  await initAccount();
  return ibkrFetch<IbkrStrikesResponse>('/v1/api/iserver/secdef/strikes', {
    method: 'POST',
    body: JSON.stringify({ secType: 'OPT', conid: underlyingConid, month, exchange: 'SMART' }),
  });
}

export type OptionContractEntry = {
  conid: string;
  right: 'C' | 'P';
  strike: number;
  expiry: string; // YYYYMMDD
  month: string;
};

export async function getOptionConids(
  underlyingConid: string,
  month: string,
  right: 'C' | 'P',
  strike: number,
): Promise<OptionContractEntry[]> {
  await initAccount();
  const results = await ibkrFetch<IbkrSecdefEntry[]>(
    `/v1/api/iserver/secdef/info?conid=${encodeURIComponent(underlyingConid)}&sectype=OPT&month=${encodeURIComponent(month)}&right=${right}&strike=${strike}`,
  );
  if (!Array.isArray(results)) return [];
  return results
    .filter((r) => r.conid && r.maturityDate && r.strike != null)
    .map((r) => ({
      conid: String(r.conid),
      right,
      strike: r.strike ?? strike,
      expiry: r.maturityDate ?? '',
      month,
    }));
}

// ---------------------------------------------------------------------------
// Market data snapshot
//
// IBKR quirk: the first snapshot call subscribes to data; subsequent calls
// return it. Retry up to 3 times (waiting 600 ms between attempts).
// ---------------------------------------------------------------------------

type IbkrSnapshotEntry = Record<string, string | number | undefined>;

const SNAPSHOT_RETRY_ATTEMPTS = 3;
const SNAPSHOT_RETRY_DELAY_MS = 600;

function snapshotHasData(entries: IbkrSnapshotEntry[]): boolean {
  return entries.some(
    (r) => r['84'] != null || r['31'] != null || r['7283'] != null,
  );
}

export async function snapshotMarketData(
  conids: string[],
  fields: string,
): Promise<IbkrSnapshotEntry[]> {
  if (conids.length === 0) return [];
  await initAccount();

  const endpoint = `/v1/api/iserver/marketdata/snapshot?conids=${conids.join(',')}&fields=${fields}`;
  let results = await ibkrFetch<IbkrSnapshotEntry[]>(endpoint);

  for (let i = 0; i < SNAPSHOT_RETRY_ATTEMPTS && !snapshotHasData(results); i += 1) {
    await sleep(SNAPSHOT_RETRY_DELAY_MS);
    results = await ibkrFetch<IbkrSnapshotEntry[]>(endpoint);
  }

  if (!snapshotHasData(results)) {
    console.warn('[ibkr] Snapshot returned empty fields after retries. Using available data.');
  }

  return results;
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
