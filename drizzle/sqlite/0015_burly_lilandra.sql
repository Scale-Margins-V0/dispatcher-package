CREATE TABLE `api_response_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_message_id` text NOT NULL,
	`channel` text NOT NULL,
	`user_id` text NOT NULL,
	`organization_id` text,
	`campaign_id` text NOT NULL,
	`dispatch_id` text,
	`template_name` text,
	`sender_id` text,
	`variable_name` text NOT NULL,
	`path` text NOT NULL,
	`value` text NOT NULL,
	`sent_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `api_response_refs_message_idx` ON `api_response_refs` (`provider`,`provider_message_id`);--> statement-breakpoint
CREATE INDEX `api_response_refs_value_idx` ON `api_response_refs` (`variable_name`,`path`,`value`);--> statement-breakpoint
CREATE INDEX `api_response_refs_campaign_idx` ON `api_response_refs` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `api_response_refs_sent_at_idx` ON `api_response_refs` (`sent_at`);