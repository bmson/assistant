CREATE TABLE "estimated_cost_decisions" (
	"decision_id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"body_digest" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimated_cost_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"escrow_reservation_id" uuid NOT NULL,
	"allowance_micros" bigint NOT NULL,
	"consumed_micros" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimated_cost_requests" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"request_fingerprint" text NOT NULL,
	"binding_digest" text NOT NULL,
	"state" text NOT NULL,
	"quote" jsonb NOT NULL,
	"baseline" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_reservations" ADD COLUMN "reservation_kind" text DEFAULT 'attempt' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_reservations" ADD COLUMN "cost_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "estimated_cost_decisions" ADD CONSTRAINT "estimated_cost_decisions_operation_id_estimated_cost_requests_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."estimated_cost_requests"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimated_cost_grants" ADD CONSTRAINT "estimated_cost_grants_operation_id_estimated_cost_requests_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."estimated_cost_requests"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimated_cost_grants" ADD CONSTRAINT "estimated_cost_grants_escrow_reservation_id_cost_reservations_id_fk" FOREIGN KEY ("escrow_reservation_id") REFERENCES "public"."cost_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimated_cost_requests" ADD CONSTRAINT "estimated_cost_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_reservations" ADD CONSTRAINT "cost_reservations_kind_check" CHECK ("cost_reservations"."reservation_kind" IN ('attempt','escrow'));
