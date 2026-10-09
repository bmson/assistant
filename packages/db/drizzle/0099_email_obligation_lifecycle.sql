ALTER TABLE "email_ingest" ADD COLUMN "provider_thread_id" text;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "provider_received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "obligation_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "obligation_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "obligation_decision" text;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "obligation_decision_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "obligation_snoozed_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "email_ingest_thread_current_idx" ON "email_ingest" USING btree ("agent_id","provider_thread_id","provider_received_at");