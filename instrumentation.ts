export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  // Always start the IBKR keepalive — it will fail gracefully if not connected.
  try {
    const { startIbkrKeepalive } = await import("@/lib/server/ibkr-client");
    startIbkrKeepalive();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.warn(`[instrumentation] failed to start IBKR keepalive: ${message}`);
  }

  // Pre-earnings warmup fans out hundreds of option-chain requests.
  // Skip in IBKR live mode to avoid startup bursts; use Cboe when offline.
  try {
    const { isIbkrAvailable } = await import("@/lib/server/ibkr-client");
    const ibkrAvailable = await isIbkrAvailable();
    if (!ibkrAvailable) {
      const { warmPreEarningsScan } = await import("@/lib/server/pre-earnings-scan-service");
      warmPreEarningsScan();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown instrumentation error";
    console.warn(`[instrumentation] failed to start pre-earnings warmup: ${message}`);
  }
}
