import { NextResponse } from "next/server";
import { z } from "zod";

import {
  computeForwardVolRowsForSymbol,
  getBestValidRow,
  normalizeTargets,
} from "@/lib/server/forward-vol-service";
import { buildRankingReason } from "@/lib/server/ranking-reason";
import { getNextEarningsForSymbols } from "@/lib/server/earnings-provider";
import {
  marketDataProvider,
  resolveOptionDataSource,
  type OptionDataProvider,
  type OptionDataSource,
} from "@/lib/server/market-data-provider";
import type { RankedForwardVolRow, TopForwardVolResponse, ScanStats } from "@/lib/types";

const requestSchema = z.object({
  topN: z.number().int().positive().optional(),
  liquidityFirst: z.boolean().optional(),
});

const IBKR_SCAN_CONCURRENCY = 5;
const CBOE_SCAN_CONCURRENCY = 1;
const SCAN_CACHE_TTL_MS = 60 * 60 * 1000;

type TopScanState = {
  quoteSource: OptionDataSource;
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

function toResponse(state: TopScanState, topN: number | null, liquidityFirst: boolean): TopForwardVolResponse {
  const visibleState =
    state.status === "running" && staleTopScanState ? staleTopScanState : state;

  const sorted = [...visibleState.rows].sort((a, b) => {
    const aEdge = a.forwardVolEdge ?? Number.NEGATIVE_INFINITY;
    const bEdge = b.forwardVolEdge ?? Number.NEGATIVE_INFINITY;
    const edgeDiff = bEdge - aEdge;

    if (!liquidityFirst || edgeDiff !== 0) {
      return edgeDiff;
    }

    // When liquidityFirst, use liquidityScore as a tiebreaker — or primary weight
    // when edges are equal. Sort descending by score.
    const aScore = a.liquidityScore ?? 0;
    const bScore = b.liquidityScore ?? 0;
    if (bScore !== aScore) {
      return bScore - aScore;
    }
    return edgeDiff;
  });

  if (liquidityFirst) {
    // Re-sort so liquidity blends with edge: composite score = edge + 0.1 * liquidityScore
    // This means a 10% edge gap can be offset by a perfect vs. zero liquidity score (0.1).
    sorted.sort((a, b) => {
      const aEdge = a.forwardVolEdge ?? Number.NEGATIVE_INFINITY;
      const bEdge = b.forwardVolEdge ?? Number.NEGATIVE_INFINITY;
      const aComposite = aEdge + 0.1 * (a.liquidityScore ?? 0.5);
      const bComposite = bEdge + 0.1 * (b.liquidityScore ?? 0.5);
      return bComposite - aComposite;
    });
  }

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

async function runTopScan(
  state: TopScanState,
  generation: number,
  optionProvider: OptionDataProvider,
): Promise<void> {
  const tickers = await marketDataProvider.getSP500Tickers();
  const targets = normalizeTargets(undefined);
  const earningsMap = await getNextEarningsForSymbols(
    tickers.map((ticker) => ticker.symbol),
    targets.map((target) => target.shortDte),
  );

  state.scannedSymbols = tickers.length;

  const ibkrAvailable = state.quoteSource === "ibkr";
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
        new Date(state.asOf),
        optionProvider,
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
  const { source, provider } = await resolveOptionDataSource();
  if (topScanState && topScanState.quoteSource !== source) {
    topScanGeneration += 1;
    topScanState = null;
    staleTopScanState = null;
  }

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
    quoteSource: source,
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

  const runPromise = runTopScan(state, generation, provider)
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
  const liquidityFirst = payload.liquidityFirst ?? false;

  try {
    const state = await ensureTopScan();
    return NextResponse.json(toResponse(state, topN, liquidityFirst));
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
