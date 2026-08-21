import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const watchlists = sqliteTable(
  "watchlists",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("watchlists_user_id_idx").on(table.userId),
    uniqueIndex("watchlists_user_symbol_unique").on(table.userId, table.symbol),
  ],
);

export const tradeJournalEntries = sqliteTable(
  "trade_journal_entries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    status: text("status", { enum: ["open", "closed", "cancelled"] }).notNull(),
    strategy: text("strategy").notNull(),
    openedAt: integer("opened_at", { mode: "timestamp" }).notNull(),
    closedAt: integer("closed_at", { mode: "timestamp" }),

    // Entry snapshot fields (immutable after create)
    edgeAtEntry: real("edge_at_entry"),
    forwardVolAtEntry: real("forward_vol_at_entry"),
    ivShortAtEntry: real("iv_short_at_entry"),
    ivLongAtEntry: real("iv_long_at_entry"),
    shortDteAtEntry: integer("short_dte_at_entry"),
    longDteAtEntry: integer("long_dte_at_entry"),
    nextEarningsDateAtEntry: text("next_earnings_date_at_entry"), // date as text (YYYY-MM-DD)
    tradeClassAtEntry: text("trade_class_at_entry", {
      enum: ["standard", "earnings-exposed"],
    }),
    quoteTimeAtEntry: integer("quote_time_at_entry", { mode: "timestamp" }),
    notes: text("notes"),

    // Cashflow + sizing
    entryNetDebit: real("entry_net_debit").notNull(),
    entryCommissions: real("entry_commissions").notNull().default(0),
    exitNetCredit: real("exit_net_credit"),
    exitCommissions: real("exit_commissions"),
    contractMultiplier: integer("contract_multiplier").notNull().default(100),
    quantity: integer("quantity").notNull(),

    // Derived persisted metrics
    grossPnl: real("gross_pnl"),
    netPnl: real("net_pnl"),
    returnOnDebit: real("return_on_debit"),
    maxRisk: real("max_risk"),

    // Audit
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    check("nonneg_entry_commissions", sql`${table.entryCommissions} >= 0`),
    check("nonneg_exit_commissions", sql`${table.exitCommissions} >= 0`),
    check("pos_multiplier", sql`${table.contractMultiplier} > 0`),
    check("nz_quantity", sql`${table.quantity} != 0`),
    check("closed_needs_timestamp", sql`${table.status} != 'closed' OR ${table.closedAt} IS NOT NULL`),
    index("trade_journal_entries_user_opened_idx").on(
      table.userId,
      table.openedAt,
    ),
    index("trade_journal_entries_user_status_idx").on(table.userId, table.status),
    index("trade_journal_entries_user_symbol_idx").on(table.userId, table.symbol),
  ],
);

export const tradeJournalLegs = sqliteTable(
  "trade_journal_legs",
  {
    id: text("id").primaryKey(),
    tradeId: text("trade_id")
      .notNull()
      .references(() => tradeJournalEntries.id, { onDelete: "cascade" }),
    side: text("side", { enum: ["buy", "sell"] }).notNull(),
    optionType: text("option_type", { enum: ["call", "put"] }).notNull(),
    quantity: integer("quantity").notNull(),
    strike: real("strike").notNull(),
    expirationDate: text("expiration_date").notNull(), // date as text (YYYY-MM-DD)
    entryPrice: real("entry_price").notNull(),
    exitPrice: real("exit_price"),
    entryCommission: real("entry_commission").notNull().default(0),
    exitCommission: real("exit_commission"),

    // Optional diagnostic fields
    entryIv: real("entry_iv"),
    exitIv: real("exit_iv"),
    openInterestAtEntry: integer("open_interest_at_entry"),
  },
  (table) => [
    index("trade_journal_legs_trade_id_idx").on(table.tradeId),
    check("nonneg_leg_entry_commission", sql`${table.entryCommission} >= 0`),
    check("nonneg_leg_exit_commission", sql`${table.exitCommission} >= 0`),
  ],
);

export const databaseSchema = { users, watchlists, tradeJournalEntries, tradeJournalLegs };
