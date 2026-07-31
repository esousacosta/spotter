export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  try {
    const { warmPreEarningsScan } = await import("@/lib/server/pre-earnings-scan-service");
    warmPreEarningsScan();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown instrumentation error";
    console.warn(`[instrumentation] failed to start pre-earnings warmup: ${message}`);
  }
}

