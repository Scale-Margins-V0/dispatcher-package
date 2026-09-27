-- Onsite activation tables, first shipped on the acme branch as migration 0007.
-- Renumbered to run after 0013 so databases that already applied 0010-0013
-- still get them (drizzle skips a migration older than the newest applied one),
-- and made re-runnable because acme's database already has these tables.
CREATE TABLE IF NOT EXISTS "onsite_activations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"touch_id" varchar(36) NOT NULL,
	"decision_id" varchar(191) NOT NULL,
	"campaign_id" varchar(191) NOT NULL,
	"program_id" varchar(191) DEFAULT '' NOT NULL,
	"program_kind" varchar(16) DEFAULT 'campaign' NOT NULL,
	"step_id" varchar(191),
	"organization_id" varchar(191) NOT NULL,
	"user_id" varchar(191) NOT NULL,
	"channel" varchar(16) NOT NULL,
	"site_key" varchar(191) NOT NULL,
	"placement" varchar(191) NOT NULL,
	"analytics_token" text NOT NULL,
	"offer_ref" varchar(191) NOT NULL,
	"offer_version" varchar(64) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"visitor_nonce_hash" varchar(64),
	"status" varchar(16) DEFAULT 'issued' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"bound_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onsite_decisions" (
	"decision_id" varchar(191) PRIMARY KEY NOT NULL,
	"campaign_id" varchar(191) NOT NULL,
	"program_id" varchar(191) DEFAULT '' NOT NULL,
	"program_kind" varchar(16) DEFAULT 'campaign' NOT NULL,
	"step_id" varchar(191),
	"organization_id" varchar(191) NOT NULL,
	"site_key" varchar(191) NOT NULL,
	"snapshot_ciphertext" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onsite_receipts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"receipt_id" varchar(191) NOT NULL,
	"activation_id" varchar(36) NOT NULL,
	"decision_id" varchar(191) NOT NULL,
	"session_id" varchar(36),
	"campaign_id" varchar(191) NOT NULL,
	"organization_id" varchar(191) NOT NULL,
	"user_id" varchar(191) NOT NULL,
	"type" varchar(24) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onsite_sessions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"activation_id" varchar(36) NOT NULL,
	"decision_id" varchar(191) NOT NULL,
	"campaign_id" varchar(191) NOT NULL,
	"organization_id" varchar(191) NOT NULL,
	"user_id" varchar(191) NOT NULL,
	"session_token_hash" varchar(64) NOT NULL,
	"nonce_hash" varchar(64) NOT NULL,
	"page_key" varchar(191) NOT NULL,
	"consent_version" varchar(64),
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onsite_activations_token_uq" ON "onsite_activations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onsite_activations_decision_idx" ON "onsite_activations" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onsite_activations_campaign_idx" ON "onsite_activations" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onsite_activations_user_idx" ON "onsite_activations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onsite_activations_expires_idx" ON "onsite_activations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onsite_decisions_campaign_idx" ON "onsite_decisions" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onsite_receipts_receipt_uq" ON "onsite_receipts" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onsite_receipts_activation_idx" ON "onsite_receipts" USING btree ("activation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onsite_receipts_campaign_received_idx" ON "onsite_receipts" USING btree ("campaign_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onsite_sessions_token_uq" ON "onsite_sessions" USING btree ("session_token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onsite_sessions_activation_idx" ON "onsite_sessions" USING btree ("activation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onsite_sessions_absolute_idx" ON "onsite_sessions" USING btree ("absolute_expires_at");