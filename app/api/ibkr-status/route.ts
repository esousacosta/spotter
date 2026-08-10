import { NextResponse } from "next/server";

import { recordIbkrAvailability } from "@/lib/server/market-data-provider";

export const dynamic = "force-dynamic";

export async function GET() {
  const gatewayUrl = process.env.IBKR_GATEWAY_URL ?? "https://localhost:5001";

  try {
    const { getAuthStatus, getMarketDataSchedulerMetrics } = await import("@/lib/server/ibkr-client");
    const status = await getAuthStatus();
    const authenticated = recordIbkrAvailability(status.authenticated);
    return NextResponse.json(
      {
        enabled: true,
        authenticated,
        gatewayUrl,
        scheduler: getMarketDataSchedulerMetrics(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const authenticated = recordIbkrAvailability(false);
    const message =
      error instanceof Error ? error.message : "Failed to reach IBKR gateway.";
    return NextResponse.json(
      { enabled: authenticated, authenticated, gatewayUrl, error: message },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
