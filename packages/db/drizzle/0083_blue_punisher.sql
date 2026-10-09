CREATE TABLE "occasion_import_lineage" (
	"source" text NOT NULL,
	"occasion_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "occasion_import_lineage" ADD CONSTRAINT "occasion_import_lineage_source_import_sources_source_fk" FOREIGN KEY ("source") REFERENCES "public"."import_sources"("source") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occasion_import_lineage" ADD CONSTRAINT "occasion_import_lineage_occasion_id_occasions_id_fk" FOREIGN KEY ("occasion_id") REFERENCES "public"."occasions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "occasion_import_lineage_source_occasion_idx" ON "occasion_import_lineage" USING btree ("source","occasion_id");--> statement-breakpoint
CREATE INDEX "occasion_import_lineage_occasion_idx" ON "occasion_import_lineage" USING btree ("occasion_id");