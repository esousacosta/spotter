import { NextResponse } from "next/server";
import { z } from "zod";

import { getUpcomingEarningsEvents } from "@/lib/server/earnings-provider";
import { marketDataProvider } from "@/lib/server/market-data-provider";
import type { UpcomingEarningsResponse } from "@/lib/types";

const requestSchema = z.object({
  daysAhead: z.number().int().positive().max(60).optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

export async function POST(request: Request) {
  let payload: z.infer<typeof requestSchema>;
  try {
    payload = requestSchema.parse(await request.json());
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid request body for upcoming earnings endpoint.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const daysAhead = payload.daysAhead ?? 14;
  const limit = payload.limit ?? 300;

  try {
    const now = new Date();
    const [events, tickers] = await Promise.all([
      getUpcomingEarningsEvents(daysAhead, now),
      marketDataProvider.getSP500Tickers(),
    ]);

    const tickerNameMap = new Map(tickers.map((ticker) => [ticker.symbol, ticker.name]));
    const filtered = events
      .filter((event) => tickerNameMap.has(event.symbol))
      .map((event) => ({
        symbol: event.symbol,
        companyName: tickerNameMap.get(event.symbol) ?? event.symbol,
        earningsDate: event.earningsDate,
        earningsSession: event.earningsSession,
        strategyEntry: "Buy 15 min before close on earnings day",
        strategyExit: "Sell 15 min after next day open",
      }))
      .sort((a, b) =>
        a.earningsDate === b.earningsDate
          ? a.symbol.localeCompare(b.symbol)
          : a.earningsDate.localeCompare(b.earningsDate),
      );

    const response: UpcomingEarningsResponse = {
      asOf: now.toISOString(),
      daysAhead,
      totalRows: filtered.length,
      rows: filtered.slice(0, limit),
    };
    return NextResponse.json(response);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unexpected error while loading upcoming earnings events.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
