CREATE TABLE "owner_editor_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"epoch" uuid NOT NULL,
	"privacy_generation_digest" text NOT NULL,
	"operation_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"scope_digest" text NOT NULL,
	"command" text NOT NULL,
	"protocol_version" integer NOT NULL,
	"form_issued_at" timestamp with time zone NOT NULL,
	"form_expires_at" timestamp with time zone NOT NULL,
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	"status" text NOT NULL,
	"status_version" integer NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_editor_operation_hashes" CHECK ("owner_editor_operations"."id" ~ '^[a-f0-9]{64}$' AND "owner_editor_operations"."request_hash" ~ '^[a-f0-9]{64}$' AND "owner_editor_operations"."scope_digest" ~ '^[a-f0-9]{64}$' AND "owner_editor_operations"."privacy_generation_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "owner_editor_operation_version" CHECK ("owner_editor_operations"."protocol_version" = 1 AND "owner_editor_operations"."status_version" >= 1 AND "owner_editor_operations"."form_expires_at" > "owner_editor_operations"."form_issued_at"),
	CONSTRAINT "owner_editor_operation_command" CHECK ("owner_editor_operations"."command" IN ('create_person','update_person_identity','add_family_relationship','correct_owner_family_relationship')),
	CONSTRAINT "owner_editor_operation_state" CHECK (("owner_editor_operations"."status" = 'preparing' AND "owner_editor_operations"."claim_token" IS NOT NULL AND "owner_editor_operations"."claim_expires_at" IS NOT NULL AND "owner_editor_operations"."result" IS NULL) OR ("owner_editor_operations"."status" IN ('committed','terminal_rejected','abandoned') AND "owner_editor_operations"."claim_token" IS NULL AND "owner_editor_operations"."claim_expires_at" IS NULL AND "owner_editor_operations"."result" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "owner_editor_operations" ADD CONSTRAINT "owner_editor_operations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "owner_editor_operation_identity" ON "owner_editor_operations" USING btree ("agent_id","epoch","operation_id");--> statement-breakpoint
CREATE INDEX "owner_editor_operation_owner" ON "owner_editor_operations" USING btree ("agent_id","created_at");
--> statement-breakpoint
CREATE INDEX "owner_editor_operation_retention" ON "owner_editor_operations" USING btree ("agent_id","form_issued_at","id");
