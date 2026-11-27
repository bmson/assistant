CREATE TABLE "saved_places" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"revision" uuid NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
ALTER TABLE "saved_places" ADD CONSTRAINT "saved_places_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_places_agent_idx" ON "saved_places" USING btree ("agent_id");