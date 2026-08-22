CREATE TABLE `campaign_summary` (
	`program_id` text PRIMARY KEY NOT NULL,
	`program_kind` text DEFAULT 'campaign' NOT NULL,
	`organization_id` text,
	`channel` text,
	`provider` text,
	`template_ref` text,
	`total_recipients` integer DEFAULT 0 NOT NULL,
	`sent` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`fallbacks_used` integer,
	`unique_recipients` integer DEFAULT 0 NOT NULL,
	`dispatched` integer DEFAULT 0 NOT NULL,
	`delivered` integer DEFAULT 0 NOT NULL,
	`opened` integer DEFAULT 0 NOT NULL,
	`clicked` integer DEFAULT 0 NOT NULL,
	`bounced` integer DEFAULT 0 NOT NULL,
	`complained` integer DEFAULT 0 NOT NULL,
	`unsubscribed` integer DEFAULT 0 NOT NULL,
	`first_send_at` integer,
	`last_event_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `campaign_summary_org_idx` ON `campaign_summary` (`organization_id`,`last_event_at`);--> statement-breakpoint
CREATE INDEX `campaign_summary_last_event_idx` ON `campaign_summary` (`last_event_at`);--> statement-breakpoint
CREATE TABLE `dispatch_send_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`dispatch_run_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`program_id` text DEFAULT '' NOT NULL,
	`step_id` text,
	`organization_id` text,
	`user_id` text NOT NULL,
	`channel` text NOT NULL,
	`provider` text NOT NULL,
	`template_ref` text,
	`status` text NOT NULL,
	`provider_message_id` text,
	`latency_ms` integer,
	`error_category` text,
	`error_message` text,
	`fallbacks_used` integer,
	`occurred_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `send_logs_run_idx` ON `dispatch_send_logs` (`dispatch_run_id`);--> statement-breakpoint
CREATE INDEX `send_logs_program_occurred_idx` ON `dispatch_send_logs` (`program_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `send_logs_program_user_idx` ON `dispatch_send_logs` (`program_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `send_logs_occurred_at_idx` ON `dispatch_send_logs` (`occurred_at`);--> statement-breakpoint
ALTER TABLE `dispatch_runs` ADD `resolution_total` integer;--> statement-breakpoint
ALTER TABLE `dispatch_runs` ADD `resolution_fallbacks` integer;