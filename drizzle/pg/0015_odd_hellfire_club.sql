CREATE TABLE "api_response_refs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_message_id" varchar(191) NOT NULL,
	"channel" varchar(16) NOT NULL,
	"user_id" varchar(191) NOT NULL,
	"organization_id" varchar(191),
	"campaign_id" varchar(191) NOT NULL,
	"dispatch_id" varchar(191),
	"template_name" varchar(191),
	"sender_id" varchar(191),
	"variable_name" varchar(191) NOT NULL,
	"path" varchar(191) NOT NULL,
	"value" varchar(191) NOT NULL,
	"sent_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "api_response_refs_message_idx" ON "api_response_refs" USING btree ("provider","provider_message_id");--> statement-breakpoint
CREATE INDEX "api_response_refs_value_idx" ON "api_response_refs" USING btree ("variable_name","path","value");--> statement-breakpoint
CREATE INDEX "api_response_refs_campaign_idx" ON "api_response_refs" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "api_response_refs_sent_at_idx" ON "api_response_refs" USING btree ("sent_at");