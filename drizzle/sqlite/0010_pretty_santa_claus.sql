CREATE TABLE `provider_message_ids` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`sent_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `provider_message_ids_sent_at_idx` ON `provider_message_ids` (`sent_at`);--> statement-breakpoint
CREATE INDEX `provider_message_ids_lookup_idx` ON `provider_message_ids` (`provider`,`provider_message_id`);--> statement-breakpoint
CREATE INDEX `provider_message_ids_user_idx` ON `provider_message_ids` (`user_id`);