ALTER TABLE "conversation_segments" ADD COLUMN "embedding_space_key" text;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD COLUMN "embedding_space_key" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "embedding_space_key" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "embedding_space_key" text;--> statement-breakpoint
ALTER TABLE "writing_samples" ADD COLUMN "embedding_space_key" text;--> statement-breakpoint
CREATE INDEX "conversation_segments_embedding_space_idx" ON "conversation_segments" USING btree ("agent_id","embedding_space_key");--> statement-breakpoint
CREATE INDEX "document_chunks_embedding_space_idx" ON "document_chunks" USING btree ("agent_id","embedding_space_key");--> statement-breakpoint
CREATE INDEX "messages_embedding_space_idx" ON "messages" USING btree ("conversation_id","embedding_space_key");--> statement-breakpoint
CREATE INDEX "skills_embedding_space_idx" ON "skills" USING btree ("agent_id","embedding_space_key");--> statement-breakpoint
CREATE INDEX "writing_samples_embedding_space_idx" ON "writing_samples" USING btree ("embedding_space_key");