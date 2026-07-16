CREATE TABLE `campaign_events` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`channel` text NOT NULL,
	`event` text NOT NULL,
	`provider` text NOT NULL,
	`provider_message_id` text,
	`occurred_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`metadata` text,
	`dedupe_key` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `campaign_events_campaign_occurred_idx` ON `campaign_events` (`campaign_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `campaign_events_campaign_user_idx` ON `campaign_events` (`campaign_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `campaign_events_occurred_at_idx` ON `campaign_events` (`occurred_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_events_dedupe_uq` ON `campaign_events` (`dedupe_key`);