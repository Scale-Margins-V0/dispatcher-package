-- Onsite activation tables, first shipped on the acme branch as migration 0007.
-- Renumbered to run after 0013 so databases that already applied 0010-0013
-- still get them (drizzle skips a migration older than the newest applied one),
-- and made re-runnable because acme's database already has these tables.
CREATE TABLE IF NOT EXISTS `onsite_activations` (
	`id` varchar(36) NOT NULL,
	`touch_id` varchar(36) NOT NULL,
	`decision_id` varchar(191) NOT NULL,
	`campaign_id` varchar(191) NOT NULL,
	`program_id` varchar(191) NOT NULL DEFAULT '',
	`program_kind` varchar(16) NOT NULL DEFAULT 'campaign',
	`step_id` varchar(191),
	`organization_id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`channel` varchar(16) NOT NULL,
	`site_key` varchar(191) NOT NULL,
	`placement` varchar(191) NOT NULL,
	`analytics_token` text NOT NULL,
	`offer_ref` varchar(191) NOT NULL,
	`offer_version` varchar(64) NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`visitor_nonce_hash` varchar(64),
	`status` varchar(16) NOT NULL DEFAULT 'issued',
	`starts_at` timestamp(3) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`issued_at` timestamp(3) NOT NULL,
	`bound_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL,
	CONSTRAINT `onsite_activations_id` PRIMARY KEY(`id`),
	CONSTRAINT `onsite_activations_token_uq` UNIQUE(`token_hash`),
	INDEX `onsite_activations_decision_idx` (`decision_id`),
	INDEX `onsite_activations_campaign_idx` (`campaign_id`),
	INDEX `onsite_activations_user_idx` (`user_id`),
	INDEX `onsite_activations_expires_idx` (`expires_at`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `onsite_decisions` (
	`decision_id` varchar(191) NOT NULL,
	`campaign_id` varchar(191) NOT NULL,
	`program_id` varchar(191) NOT NULL DEFAULT '',
	`program_kind` varchar(16) NOT NULL DEFAULT 'campaign',
	`step_id` varchar(191),
	`organization_id` varchar(191) NOT NULL,
	`site_key` varchar(191) NOT NULL,
	`snapshot_ciphertext` text NOT NULL,
	`created_at` timestamp(3) NOT NULL,
	`updated_at` timestamp(3) NOT NULL,
	CONSTRAINT `onsite_decisions_decision_id` PRIMARY KEY(`decision_id`),
	INDEX `onsite_decisions_campaign_idx` (`campaign_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `onsite_receipts` (
	`id` varchar(36) NOT NULL,
	`receipt_id` varchar(191) NOT NULL,
	`activation_id` varchar(36) NOT NULL,
	`decision_id` varchar(191) NOT NULL,
	`session_id` varchar(36),
	`campaign_id` varchar(191) NOT NULL,
	`organization_id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`type` varchar(24) NOT NULL,
	`occurred_at` timestamp(3) NOT NULL,
	`received_at` timestamp(3) NOT NULL,
	CONSTRAINT `onsite_receipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `onsite_receipts_receipt_uq` UNIQUE(`receipt_id`),
	INDEX `onsite_receipts_activation_idx` (`activation_id`),
	INDEX `onsite_receipts_campaign_received_idx` (`campaign_id`,`received_at`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `onsite_sessions` (
	`id` varchar(36) NOT NULL,
	`activation_id` varchar(36) NOT NULL,
	`decision_id` varchar(191) NOT NULL,
	`campaign_id` varchar(191) NOT NULL,
	`organization_id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`session_token_hash` varchar(64) NOT NULL,
	`nonce_hash` varchar(64) NOT NULL,
	`page_key` varchar(191) NOT NULL,
	`consent_version` varchar(64),
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`created_at` timestamp(3) NOT NULL,
	`absolute_expires_at` timestamp(3) NOT NULL,
	`last_seen_at` timestamp(3) NOT NULL,
	CONSTRAINT `onsite_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `onsite_sessions_token_uq` UNIQUE(`session_token_hash`),
	INDEX `onsite_sessions_activation_idx` (`activation_id`),
	INDEX `onsite_sessions_absolute_idx` (`absolute_expires_at`)
);
