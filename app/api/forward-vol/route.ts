import { NextResponse } from "next/server";
import { z } from "zod";

import {
  computeForwardVolRowsForSymbol,
  normalizeTargets,
} from "@/lib/server/forward-vol-service";
import { getNextEarningsForSymbols } from "@/lib/server/earnings-provider";
import { marketDataProvider } from "@/lib/server/market-data-provider";
import type { ForwardVolResponse } from "@/lib/types";

const requestSchema = z.object({
  symbol: z.string().min(1).max(10),
  targetPairs: z
    .array(
      z.object({
        shortDte: z.number().int().positive().max(400),
        longDte: z.number().int().positive().max(700),
      }),
    )
    .min(1)
    .max(10)
    .optional(),
});

export async function POST(request: Request) {
  let payload: z.infer<typeof requestSchema>;
  try {
    payload = requestSchema.parse(await request.json());
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid request body for forward vol endpoint.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const symbol = payload.symbol.trim().toUpperCase();
  const targets = normalizeTargets(payload.targetPairs);
  if (targets.length === 0) {
    return NextResponse.json({ error: "No valid target pairs were provided." }, { status: 400 });
  }

  try {
    const tickers = await marketDataProvider.getSP500Tickers();
    const existsInSp500 = tickers.some((ticker) => ticker.symbol === symbol);
    if (!existsInSp500) {
      return NextResponse.json(
        { error: `${symbol} is not currently in the S&P 500 list.` },
        { status: 404 },
      );
    }

    const now = new Date();
    const earningsMap = await getNextEarningsForSymbols(
      [symbol],
      targets.map((target) => target.shortDte),
      now,
    );
    const rows = await computeForwardVolRowsForSymbol(
      symbol,
      targets,
      earningsMap.get(symbol) ?? null,
      now,
    );
    const response: ForwardVolResponse = {
      symbol,
      asOf: now.toISOString(),
      rows,
    };
    return NextResponse.json(response);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error while computing forward volatility.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
