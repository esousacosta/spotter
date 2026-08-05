import { z } from "zod";

export const MAX_WATCHLIST_SYMBOLS = 30;

export const watchlistSymbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(10)
  .regex(/^[A-Z][A-Z0-9.-]*$/, "Enter a valid ticker symbol.");

export const watchlistSymbolsSchema = z
  .array(watchlistSymbolSchema)
  .max(MAX_WATCHLIST_SYMBOLS)
  .transform((symbols) => [...new Set(symbols)].sort());

export function normalizeWatchlistSymbol(symbol: string): string {
  return watchlistSymbolSchema.parse(symbol);
}

export function normalizeWatchlistSymbols(symbols: unknown): string[] {
  if (!Array.isArray(symbols)) {
    return [];
  }

  const normalized = symbols.flatMap((symbol) => {
    const parsed = watchlistSymbolSchema.safeParse(symbol);
    return parsed.success ? [parsed.data] : [];
  });
  return [...new Set(normalized)].slice(0, MAX_WATCHLIST_SYMBOLS);
}
