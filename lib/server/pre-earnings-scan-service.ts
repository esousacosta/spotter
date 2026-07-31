import { dayDiffIso } from "@/lib/earnings-filter";
import { getMarketDateIso } from "@/lib/market-time";
import { comparePreEarningsRows, compareRejectedPreEarningsRows } from "@/lib/pre-earnings-ranking";
import { getNextEarningsForSymbols } from "@/lib/server/earnings-provider";
import { computePreEarningsRow } from "@/lib/server/pre-earnings-service";
import { marketDataProvider } from "@/lib/server/market-data-provider";
import type {
  PreEarningsRejectedRow,
  PreEarningsRow,
  TopPreEarningsResponse,
  Ticker,
} from "@/lib/types";

const CONCURRENCY = 3;
const SCAN_CACHE_TTL_MS = 10 * 60 * 1000;
const PRE_EARNINGS_WINDOW_DAYS = 21;

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

const scanStates = new Map<number, ScanState>();

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

async function processScan(state: ScanState, tickers: Ticker[]): Promise<void> {
  const now = new Date(state.asOf);
  const todayIso = getMarketDateIso(now);
  const earningsMap = await getNextEarningsForSymbols(
    tickers.map((ticker) => ticker.symbol),
    [15, 30, 45, 60, 75],
    now,
  );

  let index = 0;

  async function worker() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= tickers.length) {
        return;
      }

      const ticker = tickers[current];
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
        continue;
      }

      if (daysToEarnings < 0 || daysToEarnings > PRE_EARNINGS_WINDOW_DAYS) {
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
        continue;
      }

      try {
        const result = await computePreEarningsRow(ticker, earningsInfo, now);
        state.evaluatedSymbols += 1;
        if (result.outcome === "viable") {
          state.computedSymbols += 1;
          state.rows.push(result.row);
          continue;
        }

        if (result.row.wasComputed) {
          state.computedSymbols += 1;
        }
        state.rejectedRows.push(result.row);
      } catch (error) {
        state.evaluatedSymbols += 1;
        const rejectionReason =
          error instanceof Error
            ? `Market-data request failed: ${error.message}`
            : "The app could not load all required market data for this symbol during the scan.";
        state.rejectedRows.push(
          buildFetchFailureRow(
            ticker,
            rejectionReason,
            earningsInfo?.nextEarningsDate ?? null,
            earningsInfo?.releaseSession ?? null,
          ),
        );
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, tickers.length) }, () => worker());
  await Promise.all(workers);
}

async function startScan(scanLimit: number): Promise<ScanState> {
  const existing = scanStates.get(scanLimit);
  if (existing) {
    const freshComplete = existing.status === "complete" && existing.expiresAtMs > Date.now();
    if (freshComplete || existing.status === "running") {
      return existing;
    }
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
    .then(() => {
      state.status = "complete";
      state.expiresAtMs = Date.now() + SCAN_CACHE_TTL_MS;
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
  })().catch(() => undefined);
}

