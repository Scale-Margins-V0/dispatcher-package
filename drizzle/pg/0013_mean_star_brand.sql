ALTER TABLE "provider_message_ids" ADD COLUMN IF NOT EXISTS "sender_id" varchar(191);--> statement-breakpoint
ALTER TABLE "provider_message_ids" ADD COLUMN IF NOT EXISTS "status" varchar(32);--> statement-breakpoint
ALTER TABLE "provider_message_ids" ADD COLUMN IF NOT EXISTS "status_event" varchar(16);--> statement-breakpoint
ALTER TABLE "provider_message_ids" ADD COLUMN IF NOT EXISTS "status_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_message_ids" ADD COLUMN IF NOT EXISTS "provider_ref" varchar(191);--> statement-breakpoint
ALTER TABLE "provider_message_ids" ADD COLUMN IF NOT EXISTS "next_poll_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_message_ids" ADD COLUMN IF NOT EXISTS "last_polled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_message_ids" ADD COLUMN IF NOT EXISTS "poll_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_message_ids" ADD COLUMN IF NOT EXISTS "poll_error" varchar(255);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_message_ids_poll_idx" ON "provider_message_ids" USING btree ("provider","next_poll_at");