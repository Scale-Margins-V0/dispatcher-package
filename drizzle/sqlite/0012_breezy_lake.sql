CREATE TABLE `dispatch_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`minute` integer NOT NULL,
	`program_id` text NOT NULL,
	`step_id` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`ok` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`timeout` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`fallback` integer DEFAULT 0 NOT NULL,
	`items` integer DEFAULT 0 NOT NULL,
	`sum_ms` integer DEFAULT 0 NOT NULL,
	`min_ms` integer,
	`max_ms` integer,
	`peak_per_sec` integer DEFAULT 0 NOT NULL,
	`b0` integer DEFAULT 0 NOT NULL,
	`b1` integer DEFAULT 0 NOT NULL,
	`b2` integer DEFAULT 0 NOT NULL,
	`b3` integer DEFAULT 0 NOT NULL,
	`b4` integer DEFAULT 0 NOT NULL,
	`b5` integer DEFAULT 0 NOT NULL,
	`b6` integer DEFAULT 0 NOT NULL,
	`b7` integer DEFAULT 0 NOT NULL,
	`b8` integer DEFAULT 0 NOT NULL,
	`b9` integer DEFAULT 0 NOT NULL,
	`b10` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dispatch_metrics_program_minute_idx` ON `dispatch_metrics` (`program_id`,`minute`);--> statement-breakpoint
CREATE INDEX `dispatch_metrics_minute_idx` ON `dispatch_metrics` (`minute`);