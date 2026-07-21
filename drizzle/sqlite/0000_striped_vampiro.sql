CREATE TABLE `app_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer NOT NULL,
	`level` text NOT NULL,
	`request_id` text,
	`campaign_id` text,
	`component` text,
	`message` text NOT NULL,
	`stack` text,
	`context` text
);
--> statement-breakpoint
CREATE INDEX `app_logs_ts_idx` ON `app_logs` (`ts`);--> statement-breakpoint
CREATE INDEX `app_logs_level_idx` ON `app_logs` (`level`);--> statement-breakpoint
CREATE INDEX `app_logs_campaign_id_idx` ON `app_logs` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `campaign_callbacks` (
	`campaign_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`analytics_callback_url` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dev_sent_campaigns` (
	`campaign_id` text PRIMARY KEY NOT NULL,
	`sent_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dispatch_recipient_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`dispatch_run_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`error_category` text NOT NULL,
	`error_message` text NOT NULL,
	`error_stack` text,
	`context` text,
	`occurred_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recipient_failures_run_idx` ON `dispatch_recipient_failures` (`dispatch_run_id`);--> statement-breakpoint
CREATE INDEX `recipient_failures_occurred_at_idx` ON `dispatch_recipient_failures` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `dispatch_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`organization_id` text,
	`channel` text NOT NULL,
	`provider` text NOT NULL,
	`status` text NOT NULL,
	`recipient_count` integer NOT NULL,
	`sent_count` integer,
	`failed_count` integer,
	`duration_ms` integer,
	`error_category` text,
	`error_message` text,
	`error_stack` text,
	`occurred_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dispatch_runs_occurred_at_idx` ON `dispatch_runs` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `dispatch_runs_campaign_id_idx` ON `dispatch_runs` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `dispatcher_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`callback_url` text NOT NULL,
	`campaign_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`event` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer
);
--> statement-breakpoint
CREATE INDEX `event_outbox_due_idx` ON `event_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `event_outbox_idempotency_idx` ON `event_outbox` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `variables` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`field` text,
	`expr` text,
	`fallback` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variables_name_unique` ON `variables` (`name`);--> statement-breakpoint
CREATE TABLE `webhook_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`direction` text NOT NULL,
	`status` text NOT NULL,
	`event_count` integer NOT NULL,
	`http_status` integer,
	`duration_ms` integer,
	`attempt` integer,
	`destination` text,
	`error_category` text,
	`error_message` text,
	`occurred_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhook_activity_occurred_at_idx` ON `webhook_activity` (`occurred_at`);