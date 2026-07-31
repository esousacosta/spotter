import fs from "node:fs";
import path from "node:path";

import { dayDiffIso } from "@/lib/earnings-filter";
import { getMarketDateIso } from "@/lib/market-time";
import { comparePreEarningsRows, compareRejectedPreEarningsRows } from "@/lib/pre-earnings-ranking";
import { getCacheDirectoryPath } from "@/lib/server/cache";
import { getNextEarningsForSymbols } from "@/lib/server/earnings-provider";
import { marketDataProvider } from "@/lib/server/market-data-provider";
import { computePreEarningsRow } from "@/lib/server/pre-earnings-service";
import type {
  PreEarningsRejectedRow,
  PreEarningsRow,
  TopPreEarningsResponse,
  Ticker,
} from "@/lib/types";

const CONCURRENCY = 1;
const BATCH_SIZE = 5;
const INTER_BATCH_PAUSE_MS = 5_000;
const SCAN_CACHE_TTL_MS = 60 * 60 * 1000;
const PRE_EARNINGS_WINDOW_DAYS = 21;
const MAX_THROTTLED_SYMBOL_RETRIES = 2;
const THROTTLED_RETRY_BASE_DELAY_MS = 30_000;
const SCAN_STATE_FILE = "pre-earnings-scan-result.json";

type ScanStatus = "running" | "complete" | "failed";

type ScanState = {
  asOf: string;
  scanLimit: number;
  scannedSymbols: number;
  evaluatedSymbols: number;
  computedSymbols: number;
  rows: PreEarningsRow[];
  rejectedRows: PreEarningsRejectedRow[];
  status: ScanStatus;
  expiresAtMs: number;
  runPromise: Promise<void> | null;
};

type PersistedScanState = Omit<ScanState, "runPromise">;

const scanStates = new Map<number, ScanState>();
const LEGACY_MAP_SHAPE_ERROR_FRAGMENT = "chain.callsbyexpiry.keys";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("(429)") || message.includes("rate limit") || message.includes("error 1015");
}

function throttledRetryDelayMs(retryAttempt: number): number {
  return Math.min(THROTTLED_RETRY_BASE_DELAY_MS * 2 ** retryAttempt, 120_000);
}

function buildRejectedRow(
  ticker: Ticker,
  nextEarningsDate: string | null,
  earningsSession: string | null,
  overrides: Omit<PreEarningsRejectedRow, "symbol" | "companyName" | "nextEarningsDate" | "earningsSession">,
): PreEarningsRejectedRow {
  return {
    symbol: ticker.symbol,
    companyName: ticker.name,
    nextEarningsDate,
    earningsSession,
    ...overrides,
  };
}

function buildFetchFailureRow(
  ticker: Ticker,
  rejectionReason: string,
  nextEarningsDate: string | null,
  earningsSession: string | null,
): PreEarningsRejectedRow {
  return buildRejectedRow(ticker, nextEarningsDate, earningsSession, {
    rejectionCategory: "data",
    rejectionStage: "Market data fetch",
    rejectionReason,
    wasComputed: false,
    underlyingPrice: null,
    expectedMove: null,
    avgVolume30: null,
    iv30Rv30: null,
    tsSlope0To45: null,
    avgVolumePass: null,
    iv30Rv30Pass: null,
    tsSlopePass: null,
    verdict: null,
  });
}

function snapshotFromState(state: ScanState, topN: number): TopPreEarningsResponse {
  const sortedRows = [...state.rows].sort((a, b) => comparePreEarningsRows(a, b, new Date(state.asOf)));
  const sortedRejectedRows = [...state.rejectedRows].sort((a, b) =>
    compareRejectedPreEarningsRows(a, b, new Date(state.asOf)),
  );

  return {
    asOf: state.asOf,
    scannedSymbols: state.scannedSymbols,
    evaluatedSymbols: state.evaluatedSymbols,
    computedSymbols: state.computedSymbols,
    viableSymbols: sortedRows.length,
    rejectedSymbols: sortedRejectedRows.length,
    isComplete: state.status === "complete",
    isWarming: state.status === "running",
    rows: sortedRows.slice(0, topN),
    rejectedRows: sortedRejectedRows,
  };
}

function hasLegacyMapShapeError(state: Pick<ScanState, "rejectedRows">): boolean {
  return state.rejectedRows.some((row) =>
    row.rejectionReason.toLowerCase().includes(LEGACY_MAP_SHAPE_ERROR_FRAGMENT),
  );
}

function getScanStateFilePath(): string {
  return path.join(getCacheDirectoryPath(), SCAN_STATE_FILE);
}

async function persistCompletedScanState(state: ScanState): Promise<void> {
  const persisted: PersistedScanState = {
    asOf: state.asOf,
    scanLimit: state.scanLimit,
    scannedSymbols: state.scannedSymbols,
    evaluatedSymbols: state.evaluatedSymbols,
    computedSymbols: state.computedSymbols,
    rows: state.rows,
    rejectedRows: state.rejectedRows,
    status: state.status,
    expiresAtMs: state.expiresAtMs,
  };
  const filePath = getScanStateFilePath();
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(persisted), "utf8");
}

function loadScanStateFromDisk(scanLimit: number): ScanState | null {
  const filePath = getScanStateFilePath();
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedScanState>;
    if (
      typeof parsed.asOf !== "string" ||
      typeof parsed.scanLimit !== "number" ||
      typeof parsed.scannedSymbols !== "number" ||
      typeof parsed.evaluatedSymbols !== "number" ||
      typeof parsed.computedSymbols !== "number" ||
      !Array.isArray(parsed.rows) ||
      !Array.isArray(parsed.rejectedRows) ||
      typeof parsed.status !== "string" ||
      typeof parsed.expiresAtMs !== "number"
    ) {
      return null;
    }

    if (parsed.scanLimit !== scanLimit || parsed.expiresAtMs <= Date.now() || parsed.status !== "complete") {
      return null;
    }

    const state: ScanState = {
      asOf: parsed.asOf,
      scanLimit: parsed.scanLimit,
      scannedSymbols: parsed.scannedSymbols,
      evaluatedSymbols: parsed.evaluatedSymbols,
      computedSymbols: parsed.computedSymbols,
      rows: parsed.rows as PreEarningsRow[],
      rejectedRows: parsed.rejectedRows as PreEarningsRejectedRow[],
      status: "complete",
      expiresAtMs: parsed.expiresAtMs,
      runPromise: null,
    };
    if (hasLegacyMapShapeError(state)) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

async function processScan(state: ScanState, tickers: Ticker[]): Promise<void> {
  const now = new Date(state.asOf);
  const todayIso = getMarketDateIso(now);
  const earningsMap = await getNextEarningsForSymbols(
    tickers.map((ticker) => ticker.symbol),
    [15, 30, 45, 60, 75],
    now,
  );

  if (CONCURRENCY !== 1) {
    throw new Error("Pre-earnings scan must run with concurrency=1 for Cboe rate-limit control.");
  }

  for (let i = 0; i < tickers.length; i += 1) {
    const ticker = tickers[i];
    const earningsInfo = earningsMap.get(ticker.symbol) ?? null;
    const nextEarningsDate = earningsInfo?.nextEarningsDate ?? null;
    const daysToEarnings =
      nextEarningsDate !== null ? dayDiffIso(todayIso, nextEarningsDate) : null;

    if (nextEarningsDate === null || daysToEarnings === null) {
      state.evaluatedSymbols += 1;
      state.rejectedRows.push(
        buildRejectedRow(ticker, null, earningsInfo?.releaseSession ?? null, {
          rejectionCategory: "criteria",
          rejectionStage: "Earnings timing",
          rejectionReason:
            "No upcoming announced earnings date was available, so this symbol is outside the pre-earnings scan scope.",
          wasComputed: false,
          underlyingPrice: null,
          expectedMove: null,
          avgVolume30: null,
          iv30Rv30: null,
          tsSlope0To45: null,
          avgVolumePass: null,
          iv30Rv30Pass: null,
          tsSlopePass: null,
          verdict: null,
        }),
      );
    } else if (daysToEarnings < 0 || daysToEarnings > PRE_EARNINGS_WINDOW_DAYS) {
      state.evaluatedSymbols += 1;
      state.rejectedRows.push(
        buildRejectedRow(ticker, nextEarningsDate, earningsInfo?.releaseSession ?? null, {
          rejectionCategory: "criteria",
          rejectionStage: "Earnings timing",
          rejectionReason:
            daysToEarnings < 0
              ? "The announced earnings date is already in the past for the current market date."
              : `The next announced earnings date is ${daysToEarnings} calendar days away, outside the ${PRE_EARNINGS_WINDOW_DAYS}-day pre-earnings scan window.`,
          wasComputed: false,
          underlyingPrice: null,
          expectedMove: null,
          avgVolume30: null,
          iv30Rv30: null,
          tsSlope0To45: null,
          avgVolumePass: null,
          iv30Rv30Pass: null,
          tsSlopePass: null,
          verdict: null,
        }),
      );
    } else {
      let completed = false;
      for (let retryAttempt = 0; retryAttempt <= MAX_THROTTLED_SYMBOL_RETRIES; retryAttempt += 1) {
        try {
          const result = await computePreEarningsRow(ticker, earningsInfo, now);
          state.evaluatedSymbols += 1;
          if (result.outcome === "viable") {
            state.computedSymbols += 1;
            state.rows.push(result.row);
          } else {
            if (result.row.wasComputed) {
              state.computedSymbols += 1;
            }
            state.rejectedRows.push(result.row);
          }
          completed = true;
          break;
        } catch (error) {
          const canRetryThrottle =
            isRateLimitError(error) && retryAttempt < MAX_THROTTLED_SYMBOL_RETRIES;
          if (canRetryThrottle) {
            const delayMs = throttledRetryDelayMs(retryAttempt);
            console.info(
              `[pre-earnings] ${ticker.symbol} throttled, retry ${retryAttempt + 1}/${MAX_THROTTLED_SYMBOL_RETRIES} in ${delayMs}ms`,
            );
            await sleep(delayMs);
            continue;
          }

          state.evaluatedSymbols += 1;
          const retrySuffix =
            isRateLimitError(error) && retryAttempt > 0
              ? ` after ${retryAttempt} retry attempt${retryAttempt === 1 ? "" : "s"}`
              : "";
          const rejectionReason =
            error instanceof Error
              ? `Market-data request failed${retrySuffix}: ${error.message}`
              : "The app could not load all required market data for this symbol during the scan.";
          state.rejectedRows.push(
            buildFetchFailureRow(
              ticker,
              rejectionReason,
              earningsInfo?.nextEarningsDate ?? null,
              earningsInfo?.releaseSession ?? null,
            ),
          );
          completed = true;
          break;
        }
      }

      if (!completed) {
        state.evaluatedSymbols += 1;
        state.rejectedRows.push(
          buildFetchFailureRow(
            ticker,
            "Market-data request failed: retry loop ended without completion.",
            earningsInfo?.nextEarningsDate ?? null,
            earningsInfo?.releaseSession ?? null,
          ),
        );
      }
    }

    if ((i + 1) % BATCH_SIZE === 0 && i + 1 < tickers.length) {
      console.info(`[pre-earnings] processed ${i + 1}/${tickers.length}; pausing ${INTER_BATCH_PAUSE_MS}ms`);
      await sleep(INTER_BATCH_PAUSE_MS);
    }
  }
}

async function startScan(scanLimit: number): Promise<ScanState> {
  const existing = scanStates.get(scanLimit);
  if (existing) {
    const hasLegacyError = hasLegacyMapShapeError(existing);
    const freshComplete = existing.status === "complete" && existing.expiresAtMs > Date.now();
    if ((freshComplete && !hasLegacyError) || existing.status === "running") {
      return existing;
    }
  }

  const diskState = loadScanStateFromDisk(scanLimit);
  if (diskState) {
    scanStates.set(scanLimit, diskState);
    console.info(`[pre-earnings] loaded completed scan from disk cache (${scanLimit} symbols).`);
    return diskState;
  }

  const allTickers = await marketDataProvider.getSP500Tickers();
  const tickers = allTickers.slice(0, scanLimit);
  const state: ScanState = {
    asOf: new Date().toISOString(),
    scanLimit,
    scannedSymbols: tickers.length,
    evaluatedSymbols: 0,
    computedSymbols: 0,
    rows: [],
    rejectedRows: [],
    status: "running",
    expiresAtMs: Date.now() + SCAN_CACHE_TTL_MS,
    runPromise: null,
  };

  const runPromise = processScan(state, tickers)
    .then(async () => {
      state.status = "complete";
      state.expiresAtMs = Date.now() + SCAN_CACHE_TTL_MS;
      try {
        await persistCompletedScanState(state);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown persistence error";
        console.warn(`[pre-earnings] failed to persist completed scan: ${message}`);
      }
    })
    .catch((error) => {
      state.status = "failed";
      state.rejectedRows.push({
        symbol: "SCAN",
        companyName: "Scan service",
        nextEarningsDate: null,
        earningsSession: null,
        rejectionCategory: "data",
        rejectionStage: "Background scan",
        rejectionReason:
          error instanceof Error ? error.message : "The background pre-earnings scan failed.",
        wasComputed: false,
        underlyingPrice: null,
        expectedMove: null,
        avgVolume30: null,
        iv30Rv30: null,
        tsSlope0To45: null,
        avgVolumePass: null,
        iv30Rv30Pass: null,
        tsSlopePass: null,
        verdict: null,
      });
    });

  state.runPromise = runPromise;
  scanStates.set(scanLimit, state);
  return state;
}

export async function getPreEarningsScan(options: {
  topN?: number;
  scanLimit?: number;
}): Promise<TopPreEarningsResponse> {
  const allTickers = await marketDataProvider.getSP500Tickers();
  const scanLimit = options.scanLimit ?? allTickers.length;
  const topN = options.topN ?? 10;
  const state = await startScan(scanLimit);
  return snapshotFromState(state, topN);
}

export function warmPreEarningsScan(scanLimit?: number): void {
  void (async () => {
    const allTickers = await marketDataProvider.getSP500Tickers();
    const finalScanLimit = scanLimit ?? allTickers.length;
    await startScan(finalScanLimit);
  })().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown warmup error";
    console.warn(`[pre-earnings] warmup failed: ${message}`);
  });
}
