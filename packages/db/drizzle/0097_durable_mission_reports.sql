CREATE TABLE "mission_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"conversation_id" uuid,
	"outcome" text NOT NULL,
	"text" text NOT NULL,
	"chat_status" text DEFAULT 'pending' NOT NULL,
	"owner_status" text DEFAULT 'pending' NOT NULL,
	"claim_token" uuid,
	"locked_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"chat_delivered_at" timestamp with time zone,
	"owner_delivered_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_reports_chat_status_check" CHECK ("mission_reports"."chat_status" IN ('pending','delivered','skipped','failed')),
	CONSTRAINT "mission_reports_owner_status_check" CHECK ("mission_reports"."owner_status" IN ('pending','delivered','skipped','failed','unknown'))
);
--> statement-breakpoint
ALTER TABLE "mission_reports" ADD CONSTRAINT "mission_reports_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_reports" ADD CONSTRAINT "mission_reports_mission_id_tasks_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_reports" ADD CONSTRAINT "mission_reports_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mission_reports_pending_idx" ON "mission_reports" USING btree ("next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "mission_reports_mission_idx" ON "mission_reports" USING btree ("agent_id","mission_id","created_at");