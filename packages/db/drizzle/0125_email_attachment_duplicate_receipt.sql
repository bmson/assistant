ALTER TABLE "email_attachment_custodies" ADD COLUMN "duplicate_document_id" uuid;
--> statement-breakpoint
ALTER TABLE "email_attachment_custodies" DROP CONSTRAINT "email_attachment_custody_status_check";
--> statement-breakpoint
ALTER TABLE "email_attachment_custodies" ADD CONSTRAINT "email_attachment_custody_status_check" CHECK ("status" IN ('marker_pending','marker_ready','content_authorized','object_written','catalogued','cleanup_pending','duplicate_cleaned','erased'));
--> statement-breakpoint
ALTER TABLE "email_attachment_custodies" DROP CONSTRAINT "email_attachment_custody_private_fields_check";
--> statement-breakpoint
ALTER TABLE "email_attachment_custodies" ADD CONSTRAINT "email_attachment_custody_private_fields_check" CHECK ("status" <> 'erased' OR ("observer_work_id" IS NULL AND "claim_token" IS NULL AND "privacy_generation" IS NULL AND "channel_message_id" IS NULL AND "provider_message_id" IS NULL AND "provider_attachment_id" IS NULL AND "manifest_digest" IS NULL AND "filename" IS NULL AND "mime" IS NULL AND "advertised_bytes" = 0 AND "actual_bytes" IS NULL AND "sha256" IS NULL AND "file_id" IS NULL AND "document_id" IS NULL AND "duplicate_document_id" IS NULL));
