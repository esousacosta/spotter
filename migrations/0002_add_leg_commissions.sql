PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_trade_journal_legs` (
	`id` text PRIMARY KEY NOT NULL,
	`trade_id` text NOT NULL,
	`side` text NOT NULL,
	`option_type` text NOT NULL,
	`quantity` integer NOT NULL,
	`strike` real NOT NULL,
	`expiration_date` text NOT NULL,
	`entry_price` real NOT NULL,
	`exit_price` real,
	`entry_commission` real DEFAULT 0 NOT NULL,
	`exit_commission` real,
	`entry_iv` real,
	`exit_iv` real,
	`open_interest_at_entry` integer,
	FOREIGN KEY (`trade_id`) REFERENCES `trade_journal_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "nonneg_leg_entry_commission" CHECK("__new_trade_journal_legs"."entry_commission" >= 0),
	CONSTRAINT "nonneg_leg_exit_commission" CHECK("__new_trade_journal_legs"."exit_commission" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_trade_journal_legs`("id", "trade_id", "side", "option_type", "quantity", "strike", "expiration_date", "entry_price", "exit_price", "entry_commission", "exit_commission", "entry_iv", "exit_iv", "open_interest_at_entry") SELECT "id", "trade_id", "side", "option_type", "quantity", "strike", "expiration_date", "entry_price", "exit_price", 0, NULL, "entry_iv", "exit_iv", "open_interest_at_entry" FROM `trade_journal_legs`;--> statement-breakpoint
DROP TABLE `trade_journal_legs`;--> statement-breakpoint
ALTER TABLE `__new_trade_journal_legs` RENAME TO `trade_journal_legs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `trade_journal_legs_trade_id_idx` ON `trade_journal_legs` (`trade_id`);