ALTER TABLE "commitments" ADD COLUMN "reopened_from_id" uuid;--> statement-breakpoint
ALTER TABLE "commitments" ADD COLUMN "reopen_operation_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "commitments_agent_reopen_operation_idx" ON "commitments" USING btree ("agent_id","reopen_operation_id") WHERE "commitments"."reopen_operation_id" IS NOT NULL;