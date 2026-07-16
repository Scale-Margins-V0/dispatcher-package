CREATE TABLE `campaign_events` (
	`id` varchar(36) NOT NULL,
	`campaign_id` varchar(191) NOT NULL,
	`organization_id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`channel` varchar(16) NOT NULL,
	`event` varchar(24) NOT NULL,
	`provider` varchar(32) NOT NULL,
	`provider_message_id` varchar(191),
	`occurred_at` timestamp(3) NOT NULL,
	`received_at` timestamp(3) NOT NULL,
	`metadata` json,
	`dedupe_key` varchar(64) NOT NULL,
	CONSTRAINT `campaign_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `campaign_events_dedupe_uq` UNIQUE(`dedupe_key`)
);
--> statement-breakpoint
CREATE INDEX `campaign_events_campaign_occurred_idx` ON `campaign_events` (`campaign_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `campaign_events_campaign_user_idx` ON `campaign_events` (`campaign_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `campaign_events_occurred_at_idx` ON `campaign_events` (`occurred_at`);