import "server-only";

import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { databaseSchema } from "@/lib/server/db/schema";

type DatabaseClient = BetterSQLite3Database<typeof databaseSchema>;

const globalForDatabase = globalThis as typeof globalThis & {
  spotterDatabase?: DatabaseClient;
};

function databaseFilename(): string {
  const databaseUrl = process.env.DATABASE_URL ?? "file:./data/spotter.db";
  if (!databaseUrl.startsWith("file:")) {
    throw new Error("DATABASE_URL must be a file: URL for SQLite.");
  }

  const filename = databaseUrl.slice("file:".length);
  if (!filename) {
    throw new Error("DATABASE_URL must include a SQLite file path.");
  }

  return path.resolve(/* turbopackIgnore: true */ process.cwd(), filename);
}

export function getDatabase(): DatabaseClient {
  if (globalForDatabase.spotterDatabase) {
    return globalForDatabase.spotterDatabase;
  }

  const filename = databaseFilename();
  mkdirSync(path.dirname(filename), { recursive: true });
  const sqlite = new Database(filename);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const database = drizzle(sqlite, { schema: databaseSchema });
  globalForDatabase.spotterDatabase = database;

  return database;
}

export type { DatabaseClient };
