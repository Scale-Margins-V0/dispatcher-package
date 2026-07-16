CREATE TABLE `api_keys` (
	`id` varchar(36) NOT NULL,
	`name` varchar(191) NOT NULL,
	`key_hash` varchar(64) NOT NULL,
	`key_ciphertext` text NOT NULL,
	`key_prefix` varchar(16) NOT NULL,
	`created_at` timestamp(3) NOT NULL,
	`updated_at` timestamp(3) NOT NULL,
	`last_used_at` timestamp(3),
	`revoked_at` timestamp(3),
	CONSTRAINT `api_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_keys_name_unique` UNIQUE(`name`),
	CONSTRAINT `api_keys_key_hash_unique` UNIQUE(`key_hash`)
);
--> statement-breakpoint
CREATE INDEX `api_keys_active_idx` ON `api_keys` (`revoked_at`);--> statement-breakpoint
CREATE INDEX `api_keys_hash_idx` ON `api_keys` (`key_hash`);