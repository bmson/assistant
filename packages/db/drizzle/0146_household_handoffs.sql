CREATE TABLE "household_handoffs" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"revision" uuid NOT NULL,
	"plan" jsonb
);
--> statement-breakpoint
ALTER TABLE "household_handoffs" ADD CONSTRAINT "household_handoffs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
