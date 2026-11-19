CREATE TABLE "signals" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"at" text NOT NULL,
	"subject_person_ids" text[] NOT NULL,
	"record" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signals_agent_kind_at_idx" ON "signals" USING btree ("agent_id","kind","at");--> statement-breakpoint
CREATE INDEX "signals_subject_person_ids_idx" ON "signals" USING gin ("subject_person_ids");
