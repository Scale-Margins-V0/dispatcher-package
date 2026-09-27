CREATE TABLE `dispatch_metrics` (
	`id` varchar(36) NOT NULL,
	`minute` int NOT NULL,
	`program_id` varchar(191) NOT NULL,
	`step_id` varchar(191) NOT NULL DEFAULT '',
	`kind` varchar(24) NOT NULL,
	`subject` varchar(191) NOT NULL DEFAULT '',
	`count` int NOT NULL DEFAULT 0,
	`ok` int NOT NULL DEFAULT 0,
	`failed` int NOT NULL DEFAULT 0,
	`timeout` int NOT NULL DEFAULT 0,
	`skipped` int NOT NULL DEFAULT 0,
	`fallback` int NOT NULL DEFAULT 0,
	`items` int NOT NULL DEFAULT 0,
	`sum_ms` int NOT NULL DEFAULT 0,
	`min_ms` int,
	`max_ms` int,
	`peak_per_sec` int NOT NULL DEFAULT 0,
	`b0` int NOT NULL DEFAULT 0,
	`b1` int NOT NULL DEFAULT 0,
	`b2` int NOT NULL DEFAULT 0,
	`b3` int NOT NULL DEFAULT 0,
	`b4` int NOT NULL DEFAULT 0,
	`b5` int NOT NULL DEFAULT 0,
	`b6` int NOT NULL DEFAULT 0,
	`b7` int NOT NULL DEFAULT 0,
	`b8` int NOT NULL DEFAULT 0,
	`b9` int NOT NULL DEFAULT 0,
	`b10` int NOT NULL DEFAULT 0,
	CONSTRAINT `dispatch_metrics_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `dispatch_metrics_program_minute_idx` ON `dispatch_metrics` (`program_id`,`minute`);--> statement-breakpoint
CREATE INDEX `dispatch_metrics_minute_idx` ON `dispatch_metrics` (`minute`);