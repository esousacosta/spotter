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
  topN: z.number().int().positive().max(50).optional(),
});

const CONCURRENCY = 8;

async function collectBestRows(): Promise<{
  scannedSymbols: number;
  successfulSymbols: number;
  rows: RankedForwardVolRow[];
}> {
  const tickers = await marketDataProvider.getSP500Tickers();
  const targets = normalizeTargets(undefined);
  const earningsMap = await getNextEarningsForSymbols(
    tickers.map((ticker) => ticker.symbol),
    targets.map((target) => target.shortDte),
  );
  const rows: RankedForwardVolRow[] = [];
  let successfulSymbols = 0;
  let index = 0;

  async function worker() {
    while (true) {
      const currentIndex = index;
      index += 1;
      if (currentIndex >= tickers.length) {
        return;
      }

      const ticker = tickers[currentIndex];
      try {
        const symbolRows = await computeForwardVolRowsForSymbol(
          ticker.symbol,
          targets,
          earningsMap.get(ticker.symbol) ?? null,
        );
        const bestRow = getBestValidRow(symbolRows);
        if (!bestRow) {
          continue;
        }

        successfulSymbols += 1;
        rows.push({
          symbol: ticker.symbol,
          companyName: ticker.name,
          ...bestRow,
        });
      } catch {
        continue;
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, tickers.length) },
    () => worker(),
  );
  await Promise.all(workers);

  return {
    scannedSymbols: tickers.length,
    successfulSymbols,
    rows,
  };
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

  const topN = payload.topN ?? 10;

  try {
    const now = new Date();
    const collected = await collectBestRows();
    const sorted = collected.rows.sort((a, b) => {
      const aEdge = a.forwardVolEdge ?? Number.NEGATIVE_INFINITY;
      const bEdge = b.forwardVolEdge ?? Number.NEGATIVE_INFINITY;
      return bEdge - aEdge;
    });

    const response: TopForwardVolResponse = {
      asOf: now.toISOString(),
      scannedSymbols: collected.scannedSymbols,
      successfulSymbols: collected.successfulSymbols,
      rows: sorted.slice(0, topN),
    };

    return NextResponse.json(response);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unexpected error while computing top forward volatility opportunities.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
