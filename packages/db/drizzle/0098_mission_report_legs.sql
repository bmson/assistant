ALTER TABLE "mission_reports" ADD COLUMN "goal_id" uuid;--> statement-breakpoint
ALTER TABLE "mission_reports" ADD COLUMN "mirror_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "mission_reports" ADD COLUMN "mirror_delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mission_reports" ADD CONSTRAINT "mission_reports_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_reports" ADD CONSTRAINT "mission_reports_mirror_status_check" CHECK ("mission_reports"."mirror_status" IN ('pending','delivered','skipped','failed'));