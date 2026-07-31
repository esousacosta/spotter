import { NextResponse } from "next/server";
import { z } from "zod";

import {
  computeForwardVolRowsForSymbol,
  getBestValidRow,
  normalizeTargets,
} from "@/lib/server/forward-vol-service";
import { getNextEarningsForSymbols } from "@/lib/server/earnings-provider";
import { marketDataProvider } from "@/lib/server/market-data-provider";
import type { RankedForwardVolRow, TopForwardVolResponse } from "@/lib/types";

const requestSchema = z.object({
  topN: z.number().int().positive().optional(),
});

const isLiveMode = process.env.IBKR_ENABLED === 'true';
// Cboe pacing requires strict sequential processing.
// IBKR requests are globally paced below the gateway's 10 req/s limit, so a
// larger worker pool can overlap contract processing without creating bursts.
const SCAN_CONCURRENCY = isLiveMode ? 5 : 1;
const SCAN_CACHE_TTL_MS = 60 * 60 * 1000;

type TopScanState = {
  asOf: string;
  scannedSymbols: number;
  processedSymbols: number;
  successfulSymbols: number;
  rows: RankedForwardVolRow[];
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

  await runWithConcurrency(tickers, SCAN_CONCURRENCY, async (ticker) => {
    if (generation !== topScanGeneration) {
      return;
    }
    try {
      const symbolRows = await computeForwardVolRowsForSymbol(
        ticker.symbol,
        targets,
        earningsMap.get(ticker.symbol) ?? null,
      );
      const bestRow = getBestValidRow(symbolRows);
      if (bestRow) {
        state.successfulSymbols += 1;
        state.rows.push({
          symbol: ticker.symbol,
          companyName: ticker.name,
          ...bestRow,
        });
      }
    } catch {
      // Skip per-symbol failures and keep scanning.
    } finally {
      state.processedSymbols += 1;
    }
  });
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
