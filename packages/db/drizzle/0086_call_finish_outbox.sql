ALTER TABLE "call_sessions" ADD COLUMN "finish_delivery" jsonb;
ALTER TABLE "cost_events" ADD COLUMN "idempotency_key" text;
CREATE UNIQUE INDEX "cost_events_idempotency_key_idx" ON "cost_events" USING btree ("idempotency_key") WHERE "cost_events"."idempotency_key" IS NOT NULL;
CREATE TABLE "execution_job_callback_receipts" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE cascade,
	"token_hash" text NOT NULL,
	"payload_digest" text NOT NULL,
	"queue_generation" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "execution_job_callback_receipts_task_idx" ON "execution_job_callback_receipts" USING btree ("task_id");
ALTER TABLE "call_sessions" ADD COLUMN "line_rate" jsonb;
