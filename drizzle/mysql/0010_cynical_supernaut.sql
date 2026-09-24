CREATE TABLE `provider_message_ids` (
	`id` varchar(36) NOT NULL,
	`provider` varchar(32) NOT NULL,
	`provider_message_id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`sent_at` timestamp(3) NOT NULL,
	CONSTRAINT `provider_message_ids_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `provider_message_ids_sent_at_idx` ON `provider_message_ids` (`sent_at`);--> statement-breakpoint
CREATE INDEX `provider_message_ids_lookup_idx` ON `provider_message_ids` (`provider`,`provider_message_id`);--> statement-breakpoint
CREATE INDEX `provider_message_ids_user_idx` ON `provider_message_ids` (`user_id`);