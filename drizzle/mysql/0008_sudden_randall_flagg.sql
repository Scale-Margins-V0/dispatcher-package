CREATE TABLE `campaign_summary` (
	`program_id` varchar(191) NOT NULL,
	`program_kind` varchar(16) NOT NULL DEFAULT 'campaign',
	`organization_id` varchar(191),
	`channel` varchar(16),
	`provider` varchar(32),
	`template_ref` varchar(191),
	`total_recipients` int NOT NULL DEFAULT 0,
	`sent` int NOT NULL DEFAULT 0,
	`failed` int NOT NULL DEFAULT 0,
	`fallbacks_used` int,
	`unique_recipients` int NOT NULL DEFAULT 0,
	`dispatched` int NOT NULL DEFAULT 0,
	`delivered` int NOT NULL DEFAULT 0,
	`opened` int NOT NULL DEFAULT 0,
	`clicked` int NOT NULL DEFAULT 0,
	`bounced` int NOT NULL DEFAULT 0,
	`complained` int NOT NULL DEFAULT 0,
	`unsubscribed` int NOT NULL DEFAULT 0,
	`first_send_at` timestamp(3),
	`last_event_at` timestamp(3),
	`updated_at` timestamp(3) NOT NULL,
	CONSTRAINT `campaign_summary_program_id` PRIMARY KEY(`program_id`)
);
--> statement-breakpoint
CREATE TABLE `dispatch_send_logs` (
	`id` varchar(36) NOT NULL,
	`dispatch_run_id` varchar(36) NOT NULL,
	`campaign_id` varchar(191) NOT NULL,
	`program_id` varchar(191) NOT NULL DEFAULT '',
	`step_id` varchar(191),
	`organization_id` varchar(191),
	`user_id` varchar(191) NOT NULL,
	`channel` varchar(16) NOT NULL,
	`provider` varchar(32) NOT NULL,
	`template_ref` varchar(191),
	`status` varchar(16) NOT NULL,
	`provider_message_id` varchar(191),
	`latency_ms` int,
	`error_category` varchar(191),
	`error_message` text,
	`fallbacks_used` int,
	`occurred_at` timestamp(3) NOT NULL,
	CONSTRAINT `dispatch_send_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `dispatch_runs` ADD `resolution_total` int;--> statement-breakpoint
ALTER TABLE `dispatch_runs` ADD `resolution_fallbacks` int;--> statement-breakpoint
CREATE INDEX `campaign_summary_org_idx` ON `campaign_summary` (`organization_id`,`last_event_at`);--> statement-breakpoint
CREATE INDEX `campaign_summary_last_event_idx` ON `campaign_summary` (`last_event_at`);--> statement-breakpoint
CREATE INDEX `send_logs_run_idx` ON `dispatch_send_logs` (`dispatch_run_id`);--> statement-breakpoint
CREATE INDEX `send_logs_program_occurred_idx` ON `dispatch_send_logs` (`program_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `send_logs_program_user_idx` ON `dispatch_send_logs` (`program_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `send_logs_occurred_at_idx` ON `dispatch_send_logs` (`occurred_at`);