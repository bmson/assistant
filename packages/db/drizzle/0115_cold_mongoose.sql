CREATE TABLE "recall_surfaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"source_revision" text,
	"kind" text NOT NULL,
	"first_surfaced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_surfaced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_id" uuid,
	"surface_count" integer DEFAULT 1 NOT NULL,
	"suppressed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "recall_surfaces_key_check" CHECK ("recall_surfaces"."source_key" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "recall_surfaces_count_check" CHECK ("recall_surfaces"."surface_count" > 0),
	CONSTRAINT "recall_surfaces_version_check" CHECK ("recall_surfaces"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "recall_surfaces" ADD CONSTRAINT "recall_surfaces_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recall_surfaces_owner_source_idx" ON "recall_surfaces" USING btree ("agent_id","source_key");--> statement-breakpoint
CREATE INDEX "recall_surfaces_owner_recent_idx" ON "recall_surfaces" USING btree ("agent_id","last_surfaced_at");