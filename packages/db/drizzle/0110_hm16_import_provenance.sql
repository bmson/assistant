ALTER TABLE "import_sources" ADD COLUMN "parse_diagnostics" jsonb;--> statement-breakpoint
ALTER TABLE "memory_import_lineage" ADD COLUMN "source_unit_provenance" jsonb DEFAULT '[]'::jsonb NOT NULL;