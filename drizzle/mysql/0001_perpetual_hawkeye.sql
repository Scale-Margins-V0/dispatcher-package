CREATE TABLE `account` (
	`id` varchar(255) NOT NULL,
	`user_id` varchar(255) NOT NULL,
	`account_id` varchar(255) NOT NULL,
	`provider_id` varchar(128) NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` timestamp(3),
	`refresh_token_expires_at` timestamp(3),
	`scope` text,
	`password` text,
	`created_at` timestamp(3) NOT NULL,
	`updated_at` timestamp(3) NOT NULL,
	CONSTRAINT `account_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invitation` (
	`id` varchar(255) NOT NULL,
	`organization_id` varchar(255) NOT NULL,
	`email` varchar(191) NOT NULL,
	`role` varchar(64),
	`status` varchar(32) NOT NULL DEFAULT 'pending',
	`expires_at` timestamp(3) NOT NULL,
	`inviter_id` varchar(255) NOT NULL,
	CONSTRAINT `invitation_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `member` (
	`id` varchar(255) NOT NULL,
	`organization_id` varchar(255) NOT NULL,
	`user_id` varchar(255) NOT NULL,
	`role` varchar(64) NOT NULL DEFAULT 'member',
	`created_at` timestamp(3) NOT NULL,
	CONSTRAINT `member_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `organization` (
	`id` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`slug` varchar(191) NOT NULL,
	`logo` text,
	`metadata` text,
	`created_at` timestamp(3) NOT NULL,
	CONSTRAINT `organization_id` PRIMARY KEY(`id`),
	CONSTRAINT `organization_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` varchar(255) NOT NULL,
	`user_id` varchar(255) NOT NULL,
	`token` varchar(191) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`ip_address` varchar(64),
	`user_agent` text,
	`active_organization_id` varchar(255),
	`impersonated_by` varchar(255),
	`created_at` timestamp(3) NOT NULL,
	`updated_at` timestamp(3) NOT NULL,
	CONSTRAINT `session_id` PRIMARY KEY(`id`),
	CONSTRAINT `session_token_unique` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`email` varchar(191) NOT NULL,
	`email_verified` boolean NOT NULL DEFAULT false,
	`image` text,
	`role` varchar(64),
	`banned` boolean DEFAULT false,
	`ban_reason` text,
	`ban_expires` timestamp(3),
	`created_at` timestamp(3) NOT NULL,
	`updated_at` timestamp(3) NOT NULL,
	CONSTRAINT `user_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` varchar(255) NOT NULL,
	`identifier` varchar(191) NOT NULL,
	`value` text NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3),
	`updated_at` timestamp(3),
	CONSTRAINT `verification_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE INDEX `invitation_org_idx` ON `invitation` (`organization_id`);--> statement-breakpoint
CREATE INDEX `member_org_idx` ON `member` (`organization_id`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);