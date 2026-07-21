CREATE TABLE "app_logs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"level" varchar(8) NOT NULL,
	"request_id" varchar(36),
	"campaign_id" varchar(191),
	"component" varchar(64),
	"message" text NOT NULL,
	"stack" text,
	"context" jsonb
);
--> statement-breakpoint
CREATE TABLE "campaign_callbacks" (
	"campaign_id" varchar(191) PRIMARY KEY NOT NULL,
	"organization_id" varchar(191) NOT NULL,
	"analytics_callback_url" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dev_sent_campaigns" (
	"campaign_id" varchar(191) PRIMARY KEY NOT NULL,
	"sent_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispatch_recipient_failures" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"dispatch_run_id" varchar(36) NOT NULL,
	"campaign_id" varchar(191) NOT NULL,
	"user_id" varchar(191) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"error_category" varchar(191) NOT NULL,
	"error_message" text NOT NULL,
	"error_stack" text,
	"context" jsonb,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispatch_runs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"campaign_id" varchar(191) NOT NULL,
	"organization_id" varchar(191),
	"channel" varchar(32) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"status" varchar(16) NOT NULL,
	"recipient_count" integer NOT NULL,
	"sent_count" integer,
	"failed_count" integer,
	"duration_ms" integer,
	"error_category" varchar(191),
	"error_message" text,
	"error_stack" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispatcher_meta" (
	"key" varchar(191) PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_outbox" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"callback_url" text NOT NULL,
	"campaign_id" varchar(191) NOT NULL,
	"organization_id" varchar(191) NOT NULL,
	"event" jsonb NOT NULL,
	"idempotency_key" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "variables" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(191) NOT NULL,
	"source" varchar(16) NOT NULL,
	"field" varchar(191),
	"expr" text,
	"fallback" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" varchar(191),
	CONSTRAINT "variables_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "webhook_activity" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"provider" varchar(32) NOT NULL,
	"direction" varchar(16) NOT NULL,
	"status" varchar(16) NOT NULL,
	"event_count" integer NOT NULL,
	"http_status" integer,
	"duration_ms" integer,
	"attempt" integer,
	"destination" text,
	"error_category" varchar(191),
	"error_message" text,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "app_logs_ts_idx" ON "app_logs" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "app_logs_level_idx" ON "app_logs" USING btree ("level");--> statement-breakpoint
CREATE INDEX "app_logs_campaign_id_idx" ON "app_logs" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "recipient_failures_run_idx" ON "dispatch_recipient_failures" USING btree ("dispatch_run_id");--> statement-breakpoint
CREATE INDEX "recipient_failures_occurred_at_idx" ON "dispatch_recipient_failures" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "dispatch_runs_occurred_at_idx" ON "dispatch_runs" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "dispatch_runs_campaign_id_idx" ON "dispatch_runs" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "event_outbox_due_idx" ON "event_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "event_outbox_idempotency_idx" ON "event_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "webhook_activity_occurred_at_idx" ON "webhook_activity" USING btree ("occurred_at");