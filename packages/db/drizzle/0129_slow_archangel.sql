CREATE TABLE "phone_calendar_sharing" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_calendar_sharing_owner_id_check" CHECK ("phone_calendar_sharing"."id" = "phone_calendar_sharing"."agent_id")
);
--> statement-breakpoint
ALTER TABLE "phone_calendar_sharing" ADD CONSTRAINT "phone_calendar_sharing_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_calendar_sharing_agent_idx" ON "phone_calendar_sharing" USING btree ("agent_id");--> statement-breakpoint
