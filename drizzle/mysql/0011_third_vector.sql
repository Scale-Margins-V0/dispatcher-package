CREATE TABLE `call_metadata` (
	`id` varchar(36) NOT NULL,
	`name` varchar(191) NOT NULL,
	`keys` json NOT NULL,
	`created_at` timestamp(3) NOT NULL,
	`updated_at` timestamp(3) NOT NULL,
	`updated_by` varchar(191),
	CONSTRAINT `call_metadata_id` PRIMARY KEY(`id`),
	CONSTRAINT `call_metadata_name_unique` UNIQUE(`name`)
);
