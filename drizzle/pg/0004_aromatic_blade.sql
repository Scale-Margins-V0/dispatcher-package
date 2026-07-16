CREATE TABLE "campaign_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"campaign_id" varchar(191) NOT NULL,
	"organization_id" varchar(191) NOT NULL,
	"user_id" varchar(191) NOT NULL,
	"channel" varchar(16) NOT NULL,
	"event" varchar(24) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_message_id" varchar(191),
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"metadata" jsonb,
	"dedupe_key" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "campaign_events_campaign_occurred_idx" ON "campaign_events" USING btree ("campaign_id","occurred_at");--> statement-breakpoint
CREATE INDEX "campaign_events_campaign_user_idx" ON "campaign_events" USING btree ("campaign_id","user_id");--> statement-breakpoint
CREATE INDEX "campaign_events_occurred_at_idx" ON "campaign_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_events_dedupe_uq" ON "campaign_events" USING btree ("dedupe_key");