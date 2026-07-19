CREATE TABLE `onsite_activations` (
	`id` text PRIMARY KEY NOT NULL,
	`touch_id` text NOT NULL,
	`decision_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`program_id` text DEFAULT '' NOT NULL,
	`program_kind` text DEFAULT 'campaign' NOT NULL,
	`step_id` text,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`channel` text NOT NULL,
	`site_key` text NOT NULL,
	`placement` text NOT NULL,
	`analytics_token` text NOT NULL,
	`offer_ref` text NOT NULL,
	`offer_version` text NOT NULL,
	`token_hash` text NOT NULL,
	`visitor_nonce_hash` text,
	`status` text DEFAULT 'issued' NOT NULL,
	`starts_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`issued_at` integer NOT NULL,
	`bound_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onsite_activations_token_uq` ON `onsite_activations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `onsite_activations_decision_idx` ON `onsite_activations` (`decision_id`);--> statement-breakpoint
CREATE INDEX `onsite_activations_campaign_idx` ON `onsite_activations` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `onsite_activations_user_idx` ON `onsite_activations` (`user_id`);--> statement-breakpoint
CREATE INDEX `onsite_activations_expires_idx` ON `onsite_activations` (`expires_at`);--> statement-breakpoint
CREATE TABLE `onsite_decisions` (
	`decision_id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`program_id` text DEFAULT '' NOT NULL,
	`program_kind` text DEFAULT 'campaign' NOT NULL,
	`step_id` text,
	`organization_id` text NOT NULL,
	`site_key` text NOT NULL,
	`snapshot_ciphertext` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `onsite_decisions_campaign_idx` ON `onsite_decisions` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `onsite_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`activation_id` text NOT NULL,
	`decision_id` text NOT NULL,
	`session_id` text,
	`campaign_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onsite_receipts_receipt_uq` ON `onsite_receipts` (`receipt_id`);--> statement-breakpoint
CREATE INDEX `onsite_receipts_activation_idx` ON `onsite_receipts` (`activation_id`);--> statement-breakpoint
CREATE INDEX `onsite_receipts_campaign_received_idx` ON `onsite_receipts` (`campaign_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `onsite_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`activation_id` text NOT NULL,
	`decision_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`session_token_hash` text NOT NULL,
	`nonce_hash` text NOT NULL,
	`page_key` text NOT NULL,
	`consent_version` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`absolute_expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onsite_sessions_token_uq` ON `onsite_sessions` (`session_token_hash`);--> statement-breakpoint
CREATE INDEX `onsite_sessions_activation_idx` ON `onsite_sessions` (`activation_id`);--> statement-breakpoint
CREATE INDEX `onsite_sessions_absolute_idx` ON `onsite_sessions` (`absolute_expires_at`);