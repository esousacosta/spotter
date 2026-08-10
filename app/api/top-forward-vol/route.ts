import { NextResponse } from "next/server";
import { z } from "zod";

import {
  computeForwardVolRowsForSymbol,
  getBestValidRow,
  normalizeTargets,
} from "@/lib/server/forward-vol-service";
import { buildRankingReason } from "@/lib/server/ranking-reason";
import { getNextEarningsForSymbols } from "@/lib/server/earnings-provider";
import { marketDataProvider } from "@/lib/server/market-data-provider";
import type { RankedForwardVolRow, TopForwardVolResponse, ScanStats } from "@/lib/types";

const requestSchema = z.object({
  topN: z.number().int().positive().optional(),
});

const IBKR_SCAN_CONCURRENCY = 5;
const CBOE_SCAN_CONCURRENCY = 1;
const SCAN_CACHE_TTL_MS = 60 * 60 * 1000;

type TopScanState = {
  asOf: string;
  scannedSymbols: number;
  processedSymbols: number;
  successfulSymbols: number;
  rows: RankedForwardVolRow[];
  scanStats: ScanStats | null;
  status: "running" | "complete" | "failed";
  expiresAtMs: number;
  runPromise: Promise<void> | null;
};

let topScanState: TopScanState | null = null;
let staleTopScanState: TopScanState | null = null;
let topScanGeneration = 0;

function toResponse(state: TopScanState, topN: number | null): TopForwardVolResponse {
  const visibleState =
    state.status === "running" && staleTopScanState ? staleTopScanState : state;
  const sorted = [...visibleState.rows].sort((a, b) => {
    const aEdge = a.forwardVolEdge ?? Number.NEGATIVE_INFINITY;
    const bEdge = b.forwardVolEdge ?? Number.NEGATIVE_INFINITY;
    return bEdge - aEdge;
  });

  return {
    asOf: visibleState.asOf,
    scannedSymbols: visibleState.scannedSymbols,
    processedSymbols: visibleState.processedSymbols,
    successfulSymbols: visibleState.successfulSymbols,
    isComplete: state.status === "complete",
    isWarming: state.status === "running",
    isStale: visibleState !== state || sorted.some((row) => row.isStale),
    warning:
      visibleState !== state
        ? "Showing the previous completed scan while a fresh scan runs in the background."
        : sorted.some((row) => row.isStale)
          ? "Some results use cached IBKR quotes while live refreshes run in the background."
          : null,
    scanStats: visibleState.scanStats,
    rows: topN === null ? sorted : sorted.slice(0, topN),
  };
}

/** Run tasks over items with at most `concurrency` in-flight at a time. */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

async function runTopScan(state: TopScanState, generation: number): Promise<void> {
  const tickers = await marketDataProvider.getSP500Tickers();
  const targets = normalizeTargets(undefined);
  const earningsMap = await getNextEarningsForSymbols(
    tickers.map((ticker) => ticker.symbol),
    targets.map((target) => target.shortDte),
  );

  state.scannedSymbols = tickers.length;

  const { isIbkrAvailable } = await import("@/lib/server/ibkr-client");
  const ibkrAvailable = await isIbkrAvailable();
  const scanConcurrency = ibkrAvailable ? IBKR_SCAN_CONCURRENCY : CBOE_SCAN_CONCURRENCY;
  console.info(`[top-forward-vol] scan starting with ${ibkrAvailable ? "IBKR live" : "Cboe delayed"} quotes (concurrency=${scanConcurrency}).`);

  const rejectionCounts: Record<string, number> = {
    no_valid_expiry_pair: 0,
    earnings_ineligible: 0,
    missing_shared_atm_strike: 0,
    invalid_forward_variance: 0,
    below_viability_threshold: 0,
    stale_or_missing_quote: 0,
    failed_earnings_safeguards: 0,
    failed_earnings_evaluation: 0,
  };

  await runWithConcurrency(tickers, scanConcurrency, async (ticker) => {
    if (generation !== topScanGeneration) {
      return;
    }
    try {
      const symbolRows = await computeForwardVolRowsForSymbol(
        ticker.symbol,
        targets,
        earningsMap.get(ticker.symbol) ?? null,
      );

      for (const row of symbolRows) {
        if (row.rejectionReason && rejectionCounts.hasOwnProperty(row.rejectionReason)) {
          rejectionCounts[row.rejectionReason] += 1;
        }
      }

      const bestRow = getBestValidRow(symbolRows);
      if (bestRow) {
        state.successfulSymbols += 1;
        const rankedRow: RankedForwardVolRow = {
          symbol: ticker.symbol,
          companyName: ticker.name,
          ...bestRow,
          rankingReason: null,
        };
        rankedRow.rankingReason = buildRankingReason(rankedRow);
        state.rows.push(rankedRow);
      }
    } catch {
      // Skip per-symbol failures and keep scanning.
    } finally {
      state.processedSymbols += 1;
    }
  });

  const topReasons = Object.entries(rejectionCounts)
    .map(([reason, count]) => ({ reason, count }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  state.scanStats = {
    totalScanned: state.scannedSymbols,
    rejectionCounts,
    topRejectionReasons: topReasons,
  };
}

async function ensureTopScan(): Promise<TopScanState> {
  if (topScanState) {
    const freshComplete = topScanState.status === "complete" && topScanState.expiresAtMs > Date.now();
    if (freshComplete || topScanState.status === "running") {
      return topScanState;
    }
    if (topScanState.status === "complete") {
      staleTopScanState = topScanState;
    }
  }

  const state: TopScanState = {
    asOf: new Date().toISOString(),
    scannedSymbols: 0,
    processedSymbols: 0,
    successfulSymbols: 0,
    rows: [],
    scanStats: null,
    status: "running",
    expiresAtMs: Date.now() + SCAN_CACHE_TTL_MS,
    runPromise: null,
  };
  topScanState = state;
  const generation = topScanGeneration;

  const runPromise = runTopScan(state, generation)
    .then(() => {
      if (generation !== topScanGeneration) return;
      state.status = "complete";
      state.expiresAtMs = Date.now() + SCAN_CACHE_TTL_MS;
      staleTopScanState = null;
    })
    .catch(() => {
      if (generation !== topScanGeneration) return;
      state.status = "failed";
    });

  state.runPromise = runPromise;
  return state;
}

export async function POST(request: Request) {
  let payload: z.infer<typeof requestSchema>;
  try {
    payload = requestSchema.parse(await request.json());
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid request body for top forward vol endpoint.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const topN = payload.topN ?? null; // null = no limit

  try {
    const state = await ensureTopScan();
    return NextResponse.json(toResponse(state, topN));
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unexpected error while computing top forward volatility opportunities.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE() {
  topScanGeneration += 1;
  topScanState = null;
  staleTopScanState = null;
  return NextResponse.json({ ok: true });
}
