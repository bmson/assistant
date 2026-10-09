ALTER TABLE "email_ingest" ADD COLUMN "mailbox" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "pipeline_stage" text DEFAULT 'complete' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "score_status" text DEFAULT 'prepared' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "score_claim_token" text;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "card_candidate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "next_step" text;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "message_persisted" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "triage_task_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "email_ingest_owner_source_idx" ON "email_ingest" USING btree ("agent_id","mailbox","provider_message_id");