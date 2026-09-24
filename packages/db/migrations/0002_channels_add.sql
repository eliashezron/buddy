CREATE TYPE "public"."channel" AS ENUM('whatsapp', 'telegram');--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "channel" "channel" DEFAULT 'whatsapp' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "external_message_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "channel" "channel" DEFAULT 'whatsapp' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "external_id" text;--> statement-breakpoint
-- Backfill: every existing row came from WhatsApp.
UPDATE "users" SET "external_id" = "wa_id" WHERE "external_id" IS NULL;--> statement-breakpoint
UPDATE "messages" SET "external_message_id" = "wa_message_id" WHERE "external_message_id" IS NULL;
