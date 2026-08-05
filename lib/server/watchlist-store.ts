import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";

import type { DatabaseClient } from "@/lib/server/db/client";
import { watchlists } from "@/lib/server/db/schema";
import { MAX_WATCHLIST_SYMBOLS } from "@/lib/watchlist-symbol";

export class WatchlistLimitError extends Error {
  constructor() {
    super(`Watchlists are limited to ${MAX_WATCHLIST_SYMBOLS} symbols.`);
    this.name = "WatchlistLimitError";
  }
}

export function createWatchlistStore(database: DatabaseClient) {
  async function list(userId: string): Promise<string[]> {
    const rows = await database
      .select({ symbol: watchlists.symbol })
      .from(watchlists)
      .where(eq(watchlists.userId, userId))
      .orderBy(asc(watchlists.symbol));
    return rows.map((row) => row.symbol);
  }

  async function add(userId: string, symbol: string): Promise<string[]> {
    const existing = await database.query.watchlists.findFirst({
      columns: { id: true },
      where: and(eq(watchlists.userId, userId), eq(watchlists.symbol, symbol)),
    });
    if (existing) {
      return list(userId);
    }

    const current = await list(userId);
    if (current.length >= MAX_WATCHLIST_SYMBOLS) {
      throw new WatchlistLimitError();
    }

    await database.insert(watchlists).values({ id: randomUUID(), userId, symbol }).onConflictDoNothing();
    return list(userId);
  }

  async function replace(userId: string, symbols: string[]): Promise<string[]> {
    if (symbols.length > MAX_WATCHLIST_SYMBOLS) {
      throw new WatchlistLimitError();
    }

    database.transaction((transaction) => {
      transaction.delete(watchlists).where(eq(watchlists.userId, userId)).run();
      if (symbols.length > 0) {
        transaction
          .insert(watchlists)
          .values(symbols.map((symbol) => ({ id: randomUUID(), userId, symbol })))
          .run();
      }
    });
    return list(userId);
  }

  async function remove(userId: string, symbol: string): Promise<string[]> {
    await database
      .delete(watchlists)
      .where(and(eq(watchlists.userId, userId), eq(watchlists.symbol, symbol)));
    return list(userId);
  }

  return { add, list, remove, replace };
}

export type WatchlistStore = ReturnType<typeof createWatchlistStore>;
