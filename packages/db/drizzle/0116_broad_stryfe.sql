CREATE TABLE "memory_embedding_refreshes" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"source_hash" text NOT NULL,
	"target_space_key" text NOT NULL,
	"target_dimensions" integer NOT NULL,
	"observed_space_key" text,
	"status" text NOT NULL,
	"prepared_vector" vector(1536),
	"privacy_generation" text,
	"claim_token" text,
	"lease_until" timestamp with time zone,
	"unknown_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_embedding_refresh_status_check" CHECK ("memory_embedding_refreshes"."status" IN ('dispatching','prepared','unknown','retry_authorized','completed','stale','abandoned')),
	CONSTRAINT "memory_embedding_refresh_dimensions_check" CHECK ("memory_embedding_refreshes"."target_dimensions" BETWEEN 1 AND 1536)
);
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "embedding_space_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "memories_agent_id_id_unique_idx" ON "memories" USING btree ("agent_id","id");--> statement-breakpoint
ALTER TABLE "memory_embedding_refreshes" ADD CONSTRAINT "memory_embedding_refreshes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embedding_refreshes" ADD CONSTRAINT "memory_embedding_refreshes_agent_id_memory_id_memories_agent_id_id_fk" FOREIGN KEY ("agent_id","memory_id") REFERENCES "public"."memories"("agent_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_embedding_refresh_identity_idx" ON "memory_embedding_refreshes" USING btree ("agent_id","memory_id","target_space_key","source_hash","updated_at");--> statement-breakpoint
CREATE INDEX "memory_embedding_refresh_owner_status_idx" ON "memory_embedding_refreshes" USING btree ("agent_id","status","updated_at");--> statement-breakpoint
