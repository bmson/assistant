ALTER TABLE "contacts" ADD COLUMN "identity_authority" text;
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_identity_authority_check" CHECK ("identity_authority" IS NULL OR "identity_authority" IN ('owner','inferred'));
