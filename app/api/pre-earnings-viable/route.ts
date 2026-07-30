import { NextResponse } from "next/server";
import { z } from "zod";

import { computePreEarningsRow } from "@/lib/server/pre-earnings-service";
import { getNextEarningsForSymbols } from "@/lib/server/earnings-provider";
import { marketDataProvider } from "@/lib/server/market-data-provider";
import type { PreEarningsRow, TopPreEarningsResponse } from "@/lib/types";

const requestSchema = z.object({
  topN: z.number().int().positive().max(50).optional(),
  scanLimit: z.number().int().positive().max(500).optional(),
});

const CONCURRENCY = 2;
const DEFAULT_SCAN_LIMIT = 120;

function rankScore(row: PreEarningsRow): number {
  if (row.verdict === "recommended") {
    return 2;
  }
  if (row.verdict === "consider") {
    return 1;
  }
  return 0;
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

  const topN = payload.topN ?? 10;
  const scanLimit = payload.scanLimit ?? DEFAULT_SCAN_LIMIT;

  try {
    const now = new Date();
    const allTickers = await marketDataProvider.getSP500Tickers();
    const tickers = allTickers.slice(0, scanLimit);
    const earningsMap = await getNextEarningsForSymbols(
      tickers.map((ticker) => ticker.symbol),
      [15, 30, 45, 60, 75],
      now,
    );
    const rows: PreEarningsRow[] = [];
    let index = 0;
    let evaluatedSymbols = 0;

    async function worker() {
      while (true) {
        const current = index;
        index += 1;
        if (current >= tickers.length) {
          return;
        }

        const ticker = tickers[current];
        try {
          const row = await computePreEarningsRow(
            ticker,
            earningsMap.get(ticker.symbol) ?? null,
            now,
          );
          if (!row) {
            continue;
          }

          evaluatedSymbols += 1;
          if (row.isViable) {
            rows.push(row);
          }
        } catch {
          continue;
        }
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, tickers.length) }, () => worker());
    await Promise.all(workers);

    rows.sort((a, b) => {
      const scoreDelta = rankScore(b) - rankScore(a);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      const ivRatioA = a.iv30Rv30 ?? Number.NEGATIVE_INFINITY;
      const ivRatioB = b.iv30Rv30 ?? Number.NEGATIVE_INFINITY;
      if (ivRatioB !== ivRatioA) {
        return ivRatioB - ivRatioA;
      }

      const slopeA = a.tsSlope0To45 ?? Number.POSITIVE_INFINITY;
      const slopeB = b.tsSlope0To45 ?? Number.POSITIVE_INFINITY;
      return slopeA - slopeB;
    });

    const response: TopPreEarningsResponse = {
      asOf: now.toISOString(),
      scannedSymbols: tickers.length,
      evaluatedSymbols,
      viableSymbols: rows.length,
      rows: rows.slice(0, topN),
    };

    return NextResponse.json(response);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unexpected error while computing pre-earnings viable trades.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
