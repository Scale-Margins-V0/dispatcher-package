CREATE TABLE `app_logs` (
	`id` varchar(36) NOT NULL,
	`ts` timestamp(3) NOT NULL,
	`level` varchar(8) NOT NULL,
	`request_id` varchar(36),
	`campaign_id` varchar(191),
	`component` varchar(64),
	`message` text NOT NULL,
	`stack` text,
	`context` json,
	CONSTRAINT `app_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `campaign_callbacks` (
	`campaign_id` varchar(191) NOT NULL,
	`organization_id` varchar(191) NOT NULL,
	`analytics_callback_url` text NOT NULL,
	`created_at` timestamp(3) NOT NULL,
	`last_used_at` timestamp(3) NOT NULL,
	CONSTRAINT `campaign_callbacks_campaign_id` PRIMARY KEY(`campaign_id`)
);
--> statement-breakpoint
CREATE TABLE `dev_sent_campaigns` (
	`campaign_id` varchar(191) NOT NULL,
	`sent_at` timestamp(3) NOT NULL,
	CONSTRAINT `dev_sent_campaigns_campaign_id` PRIMARY KEY(`campaign_id`)
);
--> statement-breakpoint
CREATE TABLE `dispatch_recipient_failures` (
	`id` varchar(36) NOT NULL,
	`dispatch_run_id` varchar(36) NOT NULL,
	`campaign_id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`provider` varchar(32) NOT NULL,
	`error_category` varchar(191) NOT NULL,
	`error_message` text NOT NULL,
	`error_stack` text,
	`context` json,
	`occurred_at` timestamp(3) NOT NULL,
	CONSTRAINT `dispatch_recipient_failures_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `dispatch_runs` (
	`id` varchar(36) NOT NULL,
	`campaign_id` varchar(191) NOT NULL,
	`organization_id` varchar(191),
	`channel` varchar(32) NOT NULL,
	`provider` varchar(32) NOT NULL,
	`status` varchar(16) NOT NULL,
	`recipient_count` int NOT NULL,
	`sent_count` int,
	`failed_count` int,
	`duration_ms` int,
	`error_category` varchar(191),
	`error_message` text,
	`error_stack` text,
	`occurred_at` timestamp(3) NOT NULL,
	`updated_at` timestamp(3) NOT NULL,
	CONSTRAINT `dispatch_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `dispatcher_meta` (
	`key` varchar(191) NOT NULL,
	`value` text NOT NULL,
	`updated_at` timestamp(3) NOT NULL,
	CONSTRAINT `dispatcher_meta_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `event_outbox` (
	`id` varchar(36) NOT NULL,
	`callback_url` text NOT NULL,
	`campaign_id` varchar(191) NOT NULL,
	`organization_id` varchar(191) NOT NULL,
	`event` json NOT NULL,
	`idempotency_key` varchar(64) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`next_attempt_at` timestamp(3) NOT NULL,
	`last_error` text,
	`created_at` timestamp(3) NOT NULL,
	`delivered_at` timestamp(3),
	CONSTRAINT `event_outbox_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `variables` (
	`id` varchar(36) NOT NULL,
	`name` varchar(191) NOT NULL,
	`source` varchar(16) NOT NULL,
	`field` varchar(191),
	`expr` text,
	`fallback` text,
	`enabled` boolean NOT NULL DEFAULT true,
	`created_at` timestamp(3) NOT NULL,
	`updated_at` timestamp(3) NOT NULL,
	`updated_by` varchar(191),
	CONSTRAINT `variables_id` PRIMARY KEY(`id`),
	CONSTRAINT `variables_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `webhook_activity` (
	`id` varchar(36) NOT NULL,
	`provider` varchar(32) NOT NULL,
	`direction` varchar(16) NOT NULL,
	`status` varchar(16) NOT NULL,
	`event_count` int NOT NULL,
	`http_status` int,
	`duration_ms` int,
	`attempt` int,
	`destination` text,
	`error_category` varchar(191),
	`error_message` text,
	`occurred_at` timestamp(3) NOT NULL,
	CONSTRAINT `webhook_activity_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `app_logs_ts_idx` ON `app_logs` (`ts`);--> statement-breakpoint
CREATE INDEX `app_logs_level_idx` ON `app_logs` (`level`);--> statement-breakpoint
CREATE INDEX `app_logs_campaign_id_idx` ON `app_logs` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `recipient_failures_run_idx` ON `dispatch_recipient_failures` (`dispatch_run_id`);--> statement-breakpoint
CREATE INDEX `recipient_failures_occurred_at_idx` ON `dispatch_recipient_failures` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `dispatch_runs_occurred_at_idx` ON `dispatch_runs` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `dispatch_runs_campaign_id_idx` ON `dispatch_runs` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `event_outbox_due_idx` ON `event_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `event_outbox_idempotency_idx` ON `event_outbox` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `webhook_activity_occurred_at_idx` ON `webhook_activity` (`occurred_at`);