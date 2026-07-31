const WATCHLIST_STORAGE_KEY = "fvs:watchlist";
const WATCHLIST_LIMIT = 30;

function normalizeSymbols(symbols: unknown): string[] {
  if (!Array.isArray(symbols)) {
    return [];
  }

  return [
    ...new Set(
      symbols
        .filter((symbol): symbol is string => typeof symbol === "string")
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  ].slice(0, WATCHLIST_LIMIT);
}

export function loadWatchlist(): string[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    return normalizeSymbols(JSON.parse(window.localStorage.getItem(WATCHLIST_STORAGE_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

export function saveWatchlist(symbols: string[]): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(normalizeSymbols(symbols)));
}

export function addToWatchlist(symbol: string): void {
  saveWatchlist([...loadWatchlist(), symbol]);
}

export function removeFromWatchlist(symbol: string): void {
  const normalizedSymbol = symbol.trim().toUpperCase();
  saveWatchlist(loadWatchlist().filter((item) => item !== normalizedSymbol));
}

export function isInWatchlist(symbol: string): boolean {
  const normalizedSymbol = symbol.trim().toUpperCase();
  return loadWatchlist().includes(normalizedSymbol);
}
