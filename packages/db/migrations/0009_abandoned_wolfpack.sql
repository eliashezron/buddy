ALTER TABLE "users" ADD COLUMN "brief_enabled" boolean;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "brief_time" text DEFAULT '07:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_brief_on" text;