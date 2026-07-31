import { NextResponse } from "next/server";
import { z } from "zod";

import { clearPreEarningsScanCache, getPreEarningsScan } from "@/lib/server/pre-earnings-scan-service";
import { getNextEarningsForSymbols } from "@/lib/server/earnings-provider";
import { marketDataProvider } from "@/lib/server/market-data-provider";
import { computePreEarningsRow } from "@/lib/server/pre-earnings-service";
import type { TopPreEarningsResponse } from "@/lib/types";

const requestSchema = z.object({
  topN: z.number().int().positive().optional(),
  scanLimit: z.number().int().positive().max(500).optional(),
  symbols: z.array(z.string().min(1).max(10)).max(30).optional(),
});

async function getWatchlistScan(symbols: string[]): Promise<TopPreEarningsResponse> {
  const normalized = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()))];
  const tickers = await marketDataProvider.getSP500Tickers();
  const selectedTickers = tickers.filter((ticker) => normalized.includes(ticker.symbol));
  const now = new Date();
  const earnings = await getNextEarningsForSymbols(normalized, [21], now);
  const results = await Promise.allSettled(
    selectedTickers.map((ticker) =>
      computePreEarningsRow(ticker, earnings.get(ticker.symbol) ?? null, now),
    ),
  );
  const rows = results.flatMap((result) =>
    result.status === "fulfilled" && result.value.outcome === "viable" ? [result.value.row] : [],
  );
  const rejectedRows = results.flatMap((result) =>
    result.status === "fulfilled" && result.value.outcome === "rejected" ? [result.value.row] : [],
  );

  return {
    asOf: now.toISOString(),
    scannedSymbols: selectedTickers.length,
    evaluatedSymbols: results.filter((result) => result.status === "fulfilled").length,
    computedSymbols:
      rows.length + rejectedRows.filter((row) => row.wasComputed).length,
    viableSymbols: rows.length,
    rejectedSymbols: rejectedRows.length,
    isComplete: true,
    isWarming: false,
    isStale: rows.some((row) => row.isStale) || rejectedRows.some((row) => row.isStale),
    warning: null,
    rows,
    rejectedRows,
  };
}

export async function POST(request: Request) {
  let payload: z.infer<typeof requestSchema>;
  try {
    payload = requestSchema.parse(await request.json());
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Invalid request body for pre-earnings viable endpoint.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const response = payload.symbols
      ? await getWatchlistScan(payload.symbols)
      : await getPreEarningsScan({
          topN: payload.topN,
          scanLimit: payload.scanLimit,
        });
    return NextResponse.json(response);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unexpected error while computing pre-earnings viable trades.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE() {
  await clearPreEarningsScanCache();
  return NextResponse.json({ ok: true });
}
