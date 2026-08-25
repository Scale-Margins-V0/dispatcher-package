CREATE TABLE "campaign_summary" (
	"program_id" varchar(191) PRIMARY KEY NOT NULL,
	"program_kind" varchar(16) DEFAULT 'campaign' NOT NULL,
	"organization_id" varchar(191),
	"channel" varchar(16),
	"provider" varchar(32),
	"template_ref" varchar(191),
	"total_recipients" integer DEFAULT 0 NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"fallbacks_used" integer,
	"unique_recipients" integer DEFAULT 0 NOT NULL,
	"dispatched" integer DEFAULT 0 NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL,
	"opened" integer DEFAULT 0 NOT NULL,
	"clicked" integer DEFAULT 0 NOT NULL,
	"bounced" integer DEFAULT 0 NOT NULL,
	"complained" integer DEFAULT 0 NOT NULL,
	"unsubscribed" integer DEFAULT 0 NOT NULL,
	"first_send_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispatch_send_logs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"dispatch_run_id" varchar(36) NOT NULL,
	"campaign_id" varchar(191) NOT NULL,
	"program_id" varchar(191) DEFAULT '' NOT NULL,
	"step_id" varchar(191),
	"organization_id" varchar(191),
	"user_id" varchar(191) NOT NULL,
	"channel" varchar(16) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"template_ref" varchar(191),
	"status" varchar(16) NOT NULL,
	"provider_message_id" varchar(191),
	"latency_ms" integer,
	"error_category" varchar(191),
	"error_message" text,
	"fallbacks_used" integer,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dispatch_runs" ADD COLUMN "resolution_total" integer;--> statement-breakpoint
ALTER TABLE "dispatch_runs" ADD COLUMN "resolution_fallbacks" integer;--> statement-breakpoint
CREATE INDEX "campaign_summary_org_idx" ON "campaign_summary" USING btree ("organization_id","last_event_at");--> statement-breakpoint
CREATE INDEX "campaign_summary_last_event_idx" ON "campaign_summary" USING btree ("last_event_at");--> statement-breakpoint
CREATE INDEX "send_logs_run_idx" ON "dispatch_send_logs" USING btree ("dispatch_run_id");--> statement-breakpoint
CREATE INDEX "send_logs_program_occurred_idx" ON "dispatch_send_logs" USING btree ("program_id","occurred_at");--> statement-breakpoint
CREATE INDEX "send_logs_program_user_idx" ON "dispatch_send_logs" USING btree ("program_id","user_id");--> statement-breakpoint
CREATE INDEX "send_logs_occurred_at_idx" ON "dispatch_send_logs" USING btree ("occurred_at");