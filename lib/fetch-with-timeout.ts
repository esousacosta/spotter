const DEFAULT_TIMEOUT_MS = 30_000;

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const response = await fetch(input, {
      ...init,
      signal,
    });
    return response;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "AbortError" &&
      timeoutController.signal.aborted &&
      !init.signal?.aborted
    ) {
      throw new Error(`Request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
