export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  if (process.env.IBKR_DISABLED !== "true") {
    try {
      const { startIbkrKeepalive } = await import("@/lib/server/ibkr-client");
      startIbkrKeepalive();
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      console.warn(`[instrumentation] failed to start IBKR keepalive: ${message}`);
    }
  }

  // Pre-earnings warmup fan-outs hundreds of option-chain requests.
  // Keep it for delayed mode, but skip in IBKR live mode to avoid startup bursts.
  if (process.env.IBKR_DISABLED === "true") {
    try {
      const { warmPreEarningsScan } = await import("@/lib/server/pre-earnings-scan-service");
      warmPreEarningsScan();
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown instrumentation error";
      console.warn(`[instrumentation] failed to start pre-earnings warmup: ${message}`);
    }
  }
}
