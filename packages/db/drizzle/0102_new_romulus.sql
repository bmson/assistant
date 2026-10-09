CREATE TABLE "security_incident_attention" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"producer" text NOT NULL,
	"delivery_status" text DEFAULT 'claimed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_incident_attention_producer_check" CHECK ("security_incident_attention"."producer" IN ('arrival','pulse','briefing')),
	CONSTRAINT "security_incident_attention_delivery_check" CHECK ("security_incident_attention"."delivery_status" IN ('claimed','accepted','unknown'))
);
--> statement-breakpoint
CREATE TABLE "security_incident_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"channel_message_id" text NOT NULL,
	"source_message_id" text,
	"mailbox_hash" text NOT NULL,
	"evidence_fingerprint" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"incident_key" text NOT NULL,
	"confidence" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"disposition" text DEFAULT 'unreviewed' NOT NULL,
	"decision_revision" integer,
	"decision_reason" text,
	"material_change_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_incidents_confidence_check" CHECK ("security_incidents"."confidence" IN ('provider-reference','recovery-reference','source-message','separate-source')),
	CONSTRAINT "security_incidents_disposition_check" CHECK ("security_incidents"."disposition" IN ('unreviewed','expected','dismissed')),
	CONSTRAINT "security_incidents_revision_check" CHECK ("security_incidents"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "email_booking_occurrences" ALTER COLUMN "source_authenticated" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "source_message_id" text;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "security_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "security_incident_id" uuid;--> statement-breakpoint
ALTER TABLE "security_incident_attention" ADD CONSTRAINT "security_incident_attention_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_incident_attention" ADD CONSTRAINT "security_incident_attention_incident_id_security_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."security_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_incident_sources" ADD CONSTRAINT "security_incident_sources_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_incident_sources" ADD CONSTRAINT "security_incident_sources_incident_id_security_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."security_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_incidents" ADD CONSTRAINT "security_incidents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "security_incident_attention_revision_idx" ON "security_incident_attention" USING btree ("agent_id","incident_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "security_incident_sources_owner_message_idx" ON "security_incident_sources" USING btree ("agent_id","channel_message_id");--> statement-breakpoint
CREATE INDEX "security_incident_sources_incident_idx" ON "security_incident_sources" USING btree ("agent_id","incident_id","observed_at");--> statement-breakpoint
CREATE INDEX "security_incident_sources_evidence_idx" ON "security_incident_sources" USING btree ("agent_id","incident_id","evidence_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "security_incidents_owner_key_idx" ON "security_incidents" USING btree ("agent_id","incident_key");--> statement-breakpoint
CREATE INDEX "email_ingest_security_incident_idx" ON "email_ingest" USING btree ("agent_id","security_incident_id");--> statement-breakpoint
CREATE INDEX "email_ingest_source_message_idx" ON "email_ingest" USING btree ("agent_id","source_message_id");