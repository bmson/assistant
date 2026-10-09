ALTER TABLE "messages" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "client_delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "client_delivered_by" uuid;--> statement-breakpoint
ALTER TABLE "model_calls" ADD COLUMN "runtime_revision" text;--> statement-breakpoint
ALTER TABLE "model_calls" ADD COLUMN "runtime_release_sha" text;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_client_delivery_check" CHECK (("messages"."client_delivered_at" IS NULL) = ("messages"."client_delivered_by" IS NULL));