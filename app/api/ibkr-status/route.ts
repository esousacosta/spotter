import { NextResponse } from "next/server";

export async function GET() {
  const gatewayUrl = process.env.IBKR_GATEWAY_URL ?? "https://localhost:5001";

  try {
    const { getAuthStatus, getMarketDataSchedulerMetrics } = await import("@/lib/server/ibkr-client");
    const status = await getAuthStatus();
    return NextResponse.json({
      enabled: true,
      authenticated: status.authenticated,
      gatewayUrl,
      scheduler: getMarketDataSchedulerMetrics(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to reach IBKR gateway.";
    return NextResponse.json(
      { enabled: false, authenticated: false, gatewayUrl, error: message },
    );
  }
}
