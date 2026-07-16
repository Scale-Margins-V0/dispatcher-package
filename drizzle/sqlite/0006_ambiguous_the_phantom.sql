CREATE TABLE `dispatch_programs` (
	`campaign_id` text PRIMARY KEY NOT NULL,
	`program_id` text NOT NULL,
	`program_kind` text DEFAULT 'campaign' NOT NULL,
	`step_id` text,
	`organization_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dispatch_programs_program_idx` ON `dispatch_programs` (`program_id`);--> statement-breakpoint
DROP INDEX `campaign_events_campaign_user_idx`;--> statement-breakpoint
ALTER TABLE `campaign_events` ADD `program_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaign_events` ADD `program_kind` text DEFAULT 'campaign' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaign_events` ADD `step_id` text;--> statement-breakpoint
CREATE INDEX `campaign_events_program_occurred_idx` ON `campaign_events` (`program_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `campaign_events_program_user_idx` ON `campaign_events` (`program_id`,`user_id`);--> statement-breakpoint
ALTER TABLE `dispatch_runs` ADD `program_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `dispatch_runs` ADD `program_kind` text DEFAULT 'campaign' NOT NULL;--> statement-breakpoint
ALTER TABLE `dispatch_runs` ADD `step_id` text;--> statement-breakpoint
-- Backfill: every pre-existing row predates drips, so the send id IS the program id.
UPDATE campaign_events SET program_id = campaign_id WHERE program_id = '';--> statement-breakpoint
UPDATE dispatch_runs SET program_id = campaign_id WHERE program_id = '';--> statement-breakpoint
CREATE INDEX `dispatch_runs_program_idx` ON `dispatch_runs` (`program_id`,`occurred_at`);