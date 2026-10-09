CREATE TABLE "watch_fire_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"watch_id" uuid NOT NULL,
	"fire_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_fire_effects_kind_check" CHECK ("watch_fire_effects"."kind" IN ('dashboard_notice','owner_notification','suggestion_enqueue','suggestion_message')),
	CONSTRAINT "watch_fire_effects_status_check" CHECK ("watch_fire_effects"."status" IN ('pending','sending','delivered','failed','unknown','skipped'))
);
--> statement-breakpoint
ALTER TABLE "watch_fire_effects" ADD CONSTRAINT "watch_fire_effects_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "watch_fire_effects_fire_kind_idx" ON "watch_fire_effects" USING btree ("fire_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "watch_fire_effects_agent_idem_idx" ON "watch_fire_effects" USING btree ("agent_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "watch_fire_effects_pending_idx" ON "watch_fire_effects" USING btree ("agent_id","status","created_at");
