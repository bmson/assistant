ALTER TABLE "knowledge_graph_relations" ADD COLUMN "corrected_by_relation_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_graph_relations" ADD COLUMN "correction_source_content_hash" text;--> statement-breakpoint
ALTER TABLE "knowledge_graph_relations" ADD COLUMN "correction_disposition" text;--> statement-breakpoint
ALTER TABLE "knowledge_graph_relations" ADD CONSTRAINT "knowledge_graph_relations_correction_disposition_check" CHECK ("knowledge_graph_relations"."correction_disposition" IS NULL OR "knowledge_graph_relations"."correction_disposition" IN ('graph_only','whole_fact'));