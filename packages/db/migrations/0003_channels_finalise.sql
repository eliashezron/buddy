ALTER TABLE "users" DROP CONSTRAINT "users_wa_id_unique";--> statement-breakpoint
DROP INDEX "messages_wa_message_id_key";--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "channel" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "external_message_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "channel" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "external_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_channel_external_id_key" ON "messages" USING btree ("channel","external_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_channel_external_id_key" ON "users" USING btree ("channel","external_id");--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "wa_message_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "wa_id";