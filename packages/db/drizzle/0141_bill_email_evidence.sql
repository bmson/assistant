ALTER TABLE "email_ingest" ADD COLUMN "bill_evidence" jsonb;--> statement-breakpoint
CREATE INDEX "email_ingest_bill_identity_idx" ON "email_ingest" USING btree (("bill_evidence"->>'identity'));
