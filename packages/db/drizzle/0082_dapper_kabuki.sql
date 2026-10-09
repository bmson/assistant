CREATE TABLE "memory_import_lineage" (
	"source" text NOT NULL,
	"memory_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_import_lineage" ADD CONSTRAINT "memory_import_lineage_source_import_sources_source_fk" FOREIGN KEY ("source") REFERENCES "public"."import_sources"("source") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_import_lineage" ADD CONSTRAINT "memory_import_lineage_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_import_lineage_source_memory_idx" ON "memory_import_lineage" USING btree ("source","memory_id");--> statement-breakpoint
CREATE INDEX "memory_import_lineage_memory_idx" ON "memory_import_lineage" USING btree ("memory_id");