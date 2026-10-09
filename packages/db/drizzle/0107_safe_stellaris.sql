CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"delivery_key" text NOT NULL,
	"leg_key" text NOT NULL,
	"adapter" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"destination" jsonb,
	"payload" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"retryable" boolean DEFAULT false NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"provider_message_id" text,
	"result" jsonb,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_outbox_status_check" CHECK ("notification_outbox"."status" IN ('pending','sending','delivered','skipped','failed','unknown')),
	CONSTRAINT "notification_outbox_attempts_nonnegative" CHECK ("notification_outbox"."attempts" >= 0),
	CONSTRAINT "notification_outbox_retryable_failed_only" CHECK (not "notification_outbox"."retryable" or "notification_outbox"."status" = 'failed')
);
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_agent_delivery_leg_idx" ON "notification_outbox" USING btree ("agent_id","delivery_key","leg_key");--> statement-breakpoint
CREATE INDEX "notification_outbox_due_idx" ON "notification_outbox" USING btree ("agent_id","status","available_at");--> statement-breakpoint
