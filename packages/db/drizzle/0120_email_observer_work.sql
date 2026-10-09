ALTER TABLE "email_ingest" ADD COLUMN "ingest_mode" text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "has_external_or_unknown" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "observer_registry_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "observer_registry_hash" text;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "admitted_source_kind" text;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "admitted_source_id" text;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD CONSTRAINT "email_ingest_admitted_source_kind_check" CHECK ("admitted_source_kind" IS NULL OR "admitted_source_kind" IN ('message','automated_source'));--> statement-breakpoint
ALTER TABLE "email_ingest" ADD CONSTRAINT "email_ingest_admitted_source_pair_check" CHECK (("admitted_source_kind" IS NULL) = ("admitted_source_id" IS NULL));--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "classification_status" text DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "classification_claim_token" text;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "prepared_classification" jsonb;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD COLUMN "score_outcome" text DEFAULT 'model_prepared' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_ingest" ADD CONSTRAINT "email_ingest_mode_check" CHECK ("ingest_mode" IN ('direct','forwarded'));--> statement-breakpoint
ALTER TABLE "email_ingest" ADD CONSTRAINT "email_ingest_classification_status_check" CHECK ("classification_status" IN ('pending','in_progress','prepared','unknown','not_required'));--> statement-breakpoint
ALTER TABLE "email_ingest" ADD CONSTRAINT "email_ingest_score_outcome_check" CHECK ("score_outcome" IN ('model_prepared','deterministic_no_model','fallback_committed_unknown','provider_outcome_unknown','budget_blocked'));--> statement-breakpoint
CREATE TABLE "email_observer_sources" (
  "id" uuid PRIMARY KEY NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "source_key" text NOT NULL,
  "channel_message_id" text NOT NULL,
  "body" text NOT NULL,
  "privacy_generation" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_observer_source_body_length_check" CHECK (length("body") <= 20000)
);--> statement-breakpoint
CREATE UNIQUE INDEX "email_observer_source_owner_key_idx" ON "email_observer_sources" USING btree ("agent_id","source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "email_observer_source_channel_message_idx" ON "email_observer_sources" USING btree ("channel_message_id");--> statement-breakpoint
CREATE TABLE "email_observer_work" (
  "id" uuid PRIMARY KEY NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "source_key" text NOT NULL,
  "channel_message_id" text NOT NULL,
  "source_kind" text NOT NULL,
  "observer_key" text NOT NULL,
  "observer_version" integer NOT NULL,
  "work_class" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "claim_token" text,
  "claim_generation" integer DEFAULT 0 NOT NULL,
  "lease_expires_at" timestamp with time zone,
  "privacy_generation" text,
  "budget_key" text,
  "budget_window_start" timestamp with time zone,
  "budget_reserved" boolean DEFAULT false NOT NULL,
  "prepared_result" jsonb,
  "delivery_key" text,
  "last_error_code" text,
  "claimed_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_observer_work_status_check" CHECK ("status" IN ('pending','claimed','prepared','complete','no_op','retryable_failed','unknown','skipped_erased','skipped_budget')),
  CONSTRAINT "email_observer_work_class_check" CHECK ("work_class" IN ('idempotent_db','paid_ambiguous','external_provider')),
  CONSTRAINT "email_observer_work_source_kind_check" CHECK ("source_kind" IN ('message','automated_source')),
  CONSTRAINT "email_observer_work_attempts_check" CHECK ("attempt_count" >= 0),
  CONSTRAINT "email_observer_work_generation_check" CHECK ("claim_generation" >= 0),
  CONSTRAINT "email_observer_work_result_size_check" CHECK (octet_length("prepared_result"::text) <= 100000)
);--> statement-breakpoint
CREATE UNIQUE INDEX "email_observer_work_owner_source_key_idx" ON "email_observer_work" USING btree ("agent_id","source_key","observer_key","observer_version");--> statement-breakpoint
CREATE INDEX "email_observer_work_due_idx" ON "email_observer_work" USING btree ("agent_id","status","lease_expires_at","created_at");--> statement-breakpoint
CREATE INDEX "email_observer_work_source_idx" ON "email_observer_work" USING btree ("agent_id","source_key");--> statement-breakpoint
CREATE TABLE "email_observer_budgets" (
  "id" uuid PRIMARY KEY NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "observer_key" text NOT NULL,
  "utc_window_start" timestamp with time zone NOT NULL,
  "utc_window_end" timestamp with time zone NOT NULL,
  "reserved_count" integer DEFAULT 0 NOT NULL,
  "limit" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_observer_budget_count_check" CHECK ("reserved_count" >= 0),
  CONSTRAINT "email_observer_budget_limit_check" CHECK ("limit" BETWEEN 0 AND 1000)
);--> statement-breakpoint
CREATE UNIQUE INDEX "email_observer_budget_owner_window_idx" ON "email_observer_budgets" USING btree ("agent_id","observer_key","utc_window_start");
