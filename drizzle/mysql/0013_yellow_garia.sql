ALTER TABLE `provider_message_ids` ADD `sender_id` varchar(191);--> statement-breakpoint
ALTER TABLE `provider_message_ids` ADD `status` varchar(32);--> statement-breakpoint
ALTER TABLE `provider_message_ids` ADD `status_event` varchar(16);--> statement-breakpoint
ALTER TABLE `provider_message_ids` ADD `status_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `provider_message_ids` ADD `provider_ref` varchar(191);--> statement-breakpoint
ALTER TABLE `provider_message_ids` ADD `next_poll_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `provider_message_ids` ADD `last_polled_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `provider_message_ids` ADD `poll_attempts` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_message_ids` ADD `poll_error` varchar(255);--> statement-breakpoint
CREATE INDEX `provider_message_ids_poll_idx` ON `provider_message_ids` (`provider`,`next_poll_at`);