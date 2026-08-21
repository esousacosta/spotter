CREATE TABLE `trade_journal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`symbol` text NOT NULL,
	`status` text NOT NULL,
	`strategy` text NOT NULL,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`edge_at_entry` real,
	`forward_vol_at_entry` real,
	`iv_short_at_entry` real,
	`iv_long_at_entry` real,
	`short_dte_at_entry` integer,
	`long_dte_at_entry` integer,
	`next_earnings_date_at_entry` text,
	`trade_class_at_entry` text,
	`quote_time_at_entry` integer,
	`notes` text,
	`entry_net_debit` real NOT NULL,
	`entry_commissions` real DEFAULT 0 NOT NULL,
	`exit_net_credit` real,
	`exit_commissions` real,
	`contract_multiplier` integer DEFAULT 100 NOT NULL,
	`quantity` integer NOT NULL,
	`gross_pnl` real,
	`net_pnl` real,
	`return_on_debit` real,
	`max_risk` real,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "nonneg_entry_commissions" CHECK("trade_journal_entries"."entry_commissions" >= 0),
	CONSTRAINT "nonneg_exit_commissions" CHECK("trade_journal_entries"."exit_commissions" >= 0),
	CONSTRAINT "pos_multiplier" CHECK("trade_journal_entries"."contract_multiplier" > 0),
	CONSTRAINT "nz_quantity" CHECK("trade_journal_entries"."quantity" != 0),
	CONSTRAINT "closed_needs_timestamp" CHECK("trade_journal_entries"."status" != 'closed' OR "trade_journal_entries"."closed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `trade_journal_entries_user_opened_idx` ON `trade_journal_entries` (`user_id`,`opened_at`);--> statement-breakpoint
CREATE INDEX `trade_journal_entries_user_status_idx` ON `trade_journal_entries` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `trade_journal_entries_user_symbol_idx` ON `trade_journal_entries` (`user_id`,`symbol`);--> statement-breakpoint
CREATE TABLE `trade_journal_legs` (
	`id` text PRIMARY KEY NOT NULL,
	`trade_id` text NOT NULL,
	`side` text NOT NULL,
	`option_type` text NOT NULL,
	`quantity` integer NOT NULL,
	`strike` real NOT NULL,
	`expiration_date` text NOT NULL,
	`entry_price` real NOT NULL,
	`exit_price` real,
	`entry_iv` real,
	`exit_iv` real,
	`open_interest_at_entry` integer,
	FOREIGN KEY (`trade_id`) REFERENCES `trade_journal_entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `trade_journal_legs_trade_id_idx` ON `trade_journal_legs` (`trade_id`);