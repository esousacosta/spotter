import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { databaseSchema, users } from "@/lib/server/db/schema";
import { createWatchlistStore } from "@/lib/server/watchlist-store";

describe("watchlist store", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      CREATE TABLE users (
        id text PRIMARY KEY NOT NULL,
        email text NOT NULL UNIQUE,
        password_hash text NOT NULL,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        updated_at integer DEFAULT (unixepoch()) NOT NULL
      );
      CREATE TABLE watchlists (
        id text PRIMARY KEY NOT NULL,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        symbol text NOT NULL,
        created_at integer DEFAULT (unixepoch()) NOT NULL,
        UNIQUE(user_id, symbol)
      );
    `);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("keeps add and remove idempotent", async () => {
    const database = drizzle(sqlite, { schema: databaseSchema });
    await database.insert(users).values({ id: "user-1", email: "one@example.com", passwordHash: "hash" });
    const store = createWatchlistStore(database);

    expect(await store.add("user-1", "MSFT")).toEqual(["MSFT"]);
    expect(await store.add("user-1", "MSFT")).toEqual(["MSFT"]);
    expect(await store.remove("user-1", "AAPL")).toEqual(["MSFT"]);
    expect(await store.remove("user-1", "MSFT")).toEqual([]);
  });

  it("isolates symbols by user and replaces with sorted unique values", async () => {
    const database = drizzle(sqlite, { schema: databaseSchema });
    await database.insert(users).values([
      { id: "user-1", email: "one@example.com", passwordHash: "hash" },
      { id: "user-2", email: "two@example.com", passwordHash: "hash" },
    ]);
    const store = createWatchlistStore(database);

    await store.add("user-1", "MSFT");
    await store.add("user-2", "TSLA");

    expect(await store.replace("user-1", ["AAPL", "MSFT"])).toEqual(["AAPL", "MSFT"]);
    expect(await store.list("user-2")).toEqual(["TSLA"]);
  });
});
