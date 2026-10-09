ALTER TABLE "gmail_sync_state" ADD COLUMN "lease_holder" text;
ALTER TABLE "gmail_sync_state" ADD COLUMN "lease_generation" integer DEFAULT 0 NOT NULL;
ALTER TABLE "gmail_sync_state" ADD COLUMN "lease_expires_at" timestamp with time zone;
