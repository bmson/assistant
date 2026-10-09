ALTER TABLE "cost_reservations" DROP CONSTRAINT "cost_reservations_status_check";--> statement-breakpoint
ALTER TABLE "cost_reservations" ADD COLUMN "attempt_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cost_reservations" ADD COLUMN "attempt_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "cost_reservations" ADD COLUMN "unknown_reason" text;--> statement-breakpoint
ALTER TABLE "cost_reservations" ADD CONSTRAINT "cost_reservations_status_check" CHECK ("cost_reservations"."status" IN ('held','dispatching','unknown','reconciled','released'));