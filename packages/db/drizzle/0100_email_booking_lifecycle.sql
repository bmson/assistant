CREATE TABLE "email_booking_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"booking_key" text NOT NULL,
	"lifecycle" text NOT NULL,
	"dates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_channel_message_id" text NOT NULL,
	"source_received_at" timestamp with time zone NOT NULL,
	"source_authenticated" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_booking_occurrences_lifecycle_check" CHECK ("email_booking_occurrences"."lifecycle" IN ('confirmed','cancelled','rescheduled','tentative'))
);
--> statement-breakpoint
ALTER TABLE "suggestions" DROP CONSTRAINT "suggestions_status_check";--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "booking_key" text;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "booking_version" integer;--> statement-breakpoint
ALTER TABLE "email_booking_occurrences" ADD CONSTRAINT "email_booking_occurrences_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_booking_occurrences_owner_key_idx" ON "email_booking_occurrences" USING btree ("agent_id","booking_key");--> statement-breakpoint
CREATE INDEX "email_booking_occurrences_source_idx" ON "email_booking_occurrences" USING btree ("agent_id","source_channel_message_id");--> statement-breakpoint
CREATE INDEX "suggestions_booking_status_idx" ON "suggestions" USING btree ("agent_id","booking_key","status");--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_status_check" CHECK ("suggestions"."status" IN ('pending','accepted','dismissed','snoozed','expired','superseded'));
