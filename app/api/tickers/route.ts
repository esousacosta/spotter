import { NextResponse } from "next/server";

import { marketDataProvider } from "@/lib/server/market-data-provider";

export async function GET() {
  try {
    const tickers = await marketDataProvider.getSP500Tickers();
    return NextResponse.json(tickers);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error while loading tickers.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
