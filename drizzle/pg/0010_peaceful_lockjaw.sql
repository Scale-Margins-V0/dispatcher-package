-- Idempotent: an earlier draft of this migration (without user_id) ran on some
-- dev databases. There the table already exists, so only the column is added.
CREATE TABLE IF NOT EXISTS "provider_message_ids" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_message_id" varchar(191) NOT NULL,
	"user_id" varchar(191) NOT NULL,
	"sent_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- Rows from the draft get '' (recipient unknown); the default is then dropped so
-- every new row must carry a real user id.
ALTER TABLE "provider_message_ids" ADD COLUMN IF NOT EXISTS "user_id" varchar(191) NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "provider_message_ids" ALTER COLUMN "user_id" DROP DEFAULT;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_message_ids_sent_at_idx" ON "provider_message_ids" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_message_ids_lookup_idx" ON "provider_message_ids" USING btree ("provider","provider_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_message_ids_user_idx" ON "provider_message_ids" USING btree ("user_id");
