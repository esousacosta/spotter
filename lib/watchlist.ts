import { normalizeWatchlistSymbols } from "@/lib/watchlist-symbol";

const WATCHLIST_STORAGE_KEY = "fvs:watchlist";

export function loadWatchlist(): string[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    return normalizeWatchlistSymbols(JSON.parse(window.localStorage.getItem(WATCHLIST_STORAGE_KEY) ?? "[]"));
  } catch (error) {
    console.warn("Ignoring an invalid guest watchlist.", error);
    return [];
  }
}

export function saveWatchlist(symbols: string[]): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(normalizeWatchlistSymbols(symbols)));
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
