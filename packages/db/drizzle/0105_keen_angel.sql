CREATE TABLE "knowledge_graph_assertion_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"assertion_id" uuid NOT NULL,
	"source_memory_id" uuid NOT NULL,
	"source_fingerprint" text NOT NULL,
	"source_content_hash" text NOT NULL,
	"evidence_quote" text NOT NULL,
	"source_author" text DEFAULT 'unknown' NOT NULL,
	"source_trust" text DEFAULT 'unknown' NOT NULL,
	"independent" boolean DEFAULT false NOT NULL,
	"span_start" integer,
	"span_end" integer,
	"extraction_version" integer NOT NULL,
	"evidence_revision" integer DEFAULT 1 NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_graph_assertion_evidence_author_check" CHECK ("knowledge_graph_assertion_evidence"."source_author" IN ('owner','other','unknown')),
	CONSTRAINT "knowledge_graph_assertion_evidence_span_check" CHECK ("knowledge_graph_assertion_evidence"."span_start" IS NULL OR ("knowledge_graph_assertion_evidence"."span_start" >= 0 AND "knowledge_graph_assertion_evidence"."span_end" >= "knowledge_graph_assertion_evidence"."span_start"))
);
--> statement-breakpoint
CREATE TABLE "knowledge_graph_assertions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"semantic_key" text NOT NULL,
	"subject_entity_id" uuid NOT NULL,
	"predicate" text NOT NULL,
	"object_entity_id" uuid NOT NULL,
	"assertion" jsonb NOT NULL,
	"qualifiers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"valid_from" text,
	"valid_until" text,
	"semantic_revision" integer DEFAULT 1 NOT NULL,
	"evidence_revision" integer DEFAULT 0 NOT NULL,
	"lifecycle" text DEFAULT 'current' NOT NULL,
	"review_status" text DEFAULT 'unreviewed' NOT NULL,
	"reviewed_revision" integer,
	"reviewed_payload_hash" text,
	"owner_authored" boolean DEFAULT false NOT NULL,
	"superseded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_graph_assertions_lifecycle_check" CHECK ("knowledge_graph_assertions"."lifecycle" IN ('current','superseded','retracted')),
	CONSTRAINT "knowledge_graph_assertions_review_check" CHECK ("knowledge_graph_assertions"."review_status" IN ('unreviewed','confirmed','rejected')),
	CONSTRAINT "knowledge_graph_assertions_revision_check" CHECK ("knowledge_graph_assertions"."semantic_revision" >= 1 AND "knowledge_graph_assertions"."evidence_revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "knowledge_graph_relations" ADD COLUMN "assertion_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_graph_assertion_evidence" ADD CONSTRAINT "knowledge_graph_assertion_evidence_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_graph_assertion_evidence" ADD CONSTRAINT "knowledge_graph_assertion_evidence_assertion_id_knowledge_graph_assertions_id_fk" FOREIGN KEY ("assertion_id") REFERENCES "public"."knowledge_graph_assertions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_graph_assertion_evidence" ADD CONSTRAINT "knowledge_graph_assertion_evidence_source_memory_id_memories_id_fk" FOREIGN KEY ("source_memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_graph_assertions" ADD CONSTRAINT "knowledge_graph_assertions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_graph_assertions" ADD CONSTRAINT "knowledge_graph_assertions_subject_entity_id_knowledge_graph_entities_id_fk" FOREIGN KEY ("subject_entity_id") REFERENCES "public"."knowledge_graph_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_graph_assertions" ADD CONSTRAINT "knowledge_graph_assertions_object_entity_id_knowledge_graph_entities_id_fk" FOREIGN KEY ("object_entity_id") REFERENCES "public"."knowledge_graph_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_graph_assertion_evidence_source_idx" ON "knowledge_graph_assertion_evidence" USING btree ("agent_id","assertion_id","source_memory_id","source_fingerprint");--> statement-breakpoint
CREATE INDEX "knowledge_graph_assertion_evidence_lookup_idx" ON "knowledge_graph_assertion_evidence" USING btree ("agent_id","source_memory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_graph_assertions_owner_key_idx" ON "knowledge_graph_assertions" USING btree ("agent_id","semantic_key");--> statement-breakpoint
CREATE INDEX "knowledge_graph_assertions_subject_idx" ON "knowledge_graph_assertions" USING btree ("agent_id","subject_entity_id","predicate");--> statement-breakpoint
CREATE INDEX "knowledge_graph_assertions_object_idx" ON "knowledge_graph_assertions" USING btree ("agent_id","object_entity_id","predicate");--> statement-breakpoint
ALTER TABLE "knowledge_graph_relations" ADD CONSTRAINT "knowledge_graph_relations_assertion_id_knowledge_graph_assertions_id_fk" FOREIGN KEY ("assertion_id") REFERENCES "public"."knowledge_graph_assertions"("id") ON DELETE set null ON UPDATE no action;
