ALTER TABLE `provider_message_ids` ADD `sender_id` text;--> statement-breakpoint
ALTER TABLE `provider_message_ids` ADD `status` text;--> statement-breakpoint
ALTER TABLE `provider_message_ids` ADD `status_event` text;--> statement-breakpoint
ALTER TABLE `provider_message_ids` ADD `status_at` integer;--> statement-breakpoint
ALTER TABLE `provider_message_ids` ADD `provider_ref` text;--> statement-breakpoint
ALTER TABLE `provider_message_ids` ADD `next_poll_at` integer;--> statement-breakpoint
ALTER TABLE `provider_message_ids` ADD `last_polled_at` integer;--> statement-breakpoint
ALTER TABLE `provider_message_ids` ADD `poll_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_message_ids` ADD `poll_error` text;--> statement-breakpoint
CREATE INDEX `provider_message_ids_poll_idx` ON `provider_message_ids` (`provider`,`next_poll_at`);