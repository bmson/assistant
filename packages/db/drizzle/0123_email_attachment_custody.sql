CREATE TABLE "email_attachment_custodies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"observer_work_id" uuid,
	"claim_token" text,
	"claim_generation" integer NOT NULL,
	"privacy_generation" text,
	"channel_message_id" text,
	"provider_message_id" text,
	"provider_attachment_id" text,
	"manifest_digest" text,
	"attachment_ordinal" integer NOT NULL,
	"workspace_path" text NOT NULL,
	"filename" text,
	"mime" text,
	"advertised_bytes" integer NOT NULL,
	"actual_bytes" integer,
	"sha256" text,
	"marker_generation" text,
	"object_generation" text,
	"status" text DEFAULT 'marker_pending' NOT NULL,
	"file_id" uuid,
	"document_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_attachment_custody_generation_check" CHECK ("claim_generation" >= 0),
	CONSTRAINT "email_attachment_custody_ordinal_check" CHECK ("attachment_ordinal" BETWEEN 0 AND 7),
	CONSTRAINT "email_attachment_custody_advertised_bytes_check" CHECK ("advertised_bytes" BETWEEN 0 AND 26214400),
	CONSTRAINT "email_attachment_custody_actual_bytes_check" CHECK ("actual_bytes" IS NULL OR "actual_bytes" BETWEEN 1 AND 26214400),
	CONSTRAINT "email_attachment_custody_manifest_check" CHECK ("status" = 'erased' OR "manifest_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "email_attachment_custody_sha_check" CHECK ("sha256" IS NULL OR "sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "email_attachment_custody_status_check" CHECK ("status" IN ('marker_pending','marker_ready','content_authorized','object_written','catalogued','cleanup_pending','erased')),
	CONSTRAINT "email_attachment_custody_path_check" CHECK ("workspace_path" ~ '^email-attachments/custody/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "email_attachment_custody_private_fields_check" CHECK ("status" <> 'erased' OR ("observer_work_id" IS NULL AND "claim_token" IS NULL AND "privacy_generation" IS NULL AND "channel_message_id" IS NULL AND "provider_message_id" IS NULL AND "provider_attachment_id" IS NULL AND "manifest_digest" IS NULL AND "filename" IS NULL AND "mime" IS NULL AND "advertised_bytes" = 0 AND "actual_bytes" IS NULL AND "sha256" IS NULL AND "file_id" IS NULL AND "document_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "email_attachment_custodies" ADD CONSTRAINT "email_attachment_custodies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "email_attachment_custody_source_idx" ON "email_attachment_custodies" USING btree ("agent_id","observer_work_id","provider_attachment_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "email_attachment_custody_path_idx" ON "email_attachment_custodies" USING btree ("workspace_path");
--> statement-breakpoint
CREATE INDEX "email_attachment_custody_cleanup_idx" ON "email_attachment_custodies" USING btree ("agent_id","status","updated_at");

--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "object_generation" text;
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "email_attachment_custody_id" uuid;
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_email_attachment_custody_id_email_attachment_custodies_id_fk" FOREIGN KEY ("email_attachment_custody_id") REFERENCES "public"."email_attachment_custodies"("id") ON DELETE restrict ON UPDATE no action;
