CREATE TABLE "model_role_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "role" text NOT NULL,
  "before_state" jsonb,
  "after_state" jsonb,
  "source" text NOT NULL,
  "baseline_known" boolean NOT NULL,
  "requires_owner_review" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "model_role_revisions_role_created_idx" ON "model_role_revisions" USING btree ("role", "created_at");
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "seed_template_key" text;
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "seed_template_revision" integer;
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "seed_definition" jsonb;
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "seed_review_required" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "schedules" SET "seed_review_required" = true WHERE "name" = 'morning-brief';
