CREATE TABLE `call_metadata` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`keys` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `call_metadata_name_unique` ON `call_metadata` (`name`);