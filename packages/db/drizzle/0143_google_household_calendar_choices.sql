CREATE TABLE "google_household_calendar_choices" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"settings" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "google_household_calendar_choices" ADD CONSTRAINT "google_household_calendar_choices_agent_id_google_calendar_connections_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."google_calendar_connections"("agent_id") ON DELETE cascade ON UPDATE no action;
