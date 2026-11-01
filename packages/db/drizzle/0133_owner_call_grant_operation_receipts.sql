CREATE TABLE "owner_call_grant_operation_slots" (
	"owner_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"purpose" text DEFAULT 'owner-call-grant-operation.v1' NOT NULL,
	"schema_version" smallint DEFAULT 1 NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"current_grant_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_call_grant_operation_slots_pk" PRIMARY KEY("owner_id","approval_id"),
	CONSTRAINT "owner_call_grant_operation_slots_purpose_check" CHECK ("owner_call_grant_operation_slots"."purpose" = 'owner-call-grant-operation.v1'),
	CONSTRAINT "owner_call_grant_operation_slots_version_check" CHECK ("owner_call_grant_operation_slots"."schema_version" = 1),
	CONSTRAINT "owner_call_grant_operation_slots_generation_check" CHECK (("owner_call_grant_operation_slots"."generation" = 0 AND "owner_call_grant_operation_slots"."current_grant_id" IS NULL) OR ("owner_call_grant_operation_slots"."generation" > 0 AND "owner_call_grant_operation_slots"."current_grant_id" IS NOT NULL)),
	CONSTRAINT "owner_call_grant_operation_slots_updated_at_check" CHECK (isfinite("owner_call_grant_operation_slots"."updated_at"))
);
--> statement-breakpoint
CREATE TABLE "owner_call_grant_operations" (
	"owner_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"purpose" text DEFAULT 'owner-call-grant-operation.v1' NOT NULL,
	"schema_version" smallint DEFAULT 1 NOT NULL,
	"operation_version" smallint DEFAULT 1 NOT NULL,
	"task_id" uuid NOT NULL,
	"tool_call_id" uuid NOT NULL,
	"slot_generation" integer NOT NULL,
	"request_fingerprint" text NOT NULL,
	"grant_scope_fingerprint" text NOT NULL,
	"phase" text NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"review_expires_at" timestamp with time zone NOT NULL,
	"grant_expires_at" timestamp with time zone NOT NULL,
	"admitted_at" timestamp with time zone,
	"committed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"created_policy_id" uuid,
	"wake_generation" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_call_grant_operations_pk" PRIMARY KEY("owner_id","approval_id","grant_id"),
	CONSTRAINT "owner_call_grant_operations_purpose_check" CHECK ("owner_call_grant_operations"."purpose" = 'owner-call-grant-operation.v1'),
	CONSTRAINT "owner_call_grant_operations_version_check" CHECK ("owner_call_grant_operations"."schema_version" = 1 AND "owner_call_grant_operations"."operation_version" = 1),
	CONSTRAINT "owner_call_grant_operations_generation_check" CHECK ("owner_call_grant_operations"."slot_generation" > 0),
	CONSTRAINT "owner_call_grant_operations_fingerprint_check" CHECK ("owner_call_grant_operations"."request_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "owner_call_grant_operations_scope_fingerprint_check" CHECK ("owner_call_grant_operations"."grant_scope_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "owner_call_grant_operations_phase_check" CHECK (
      isfinite("owner_call_grant_operations"."registered_at") AND isfinite("owner_call_grant_operations"."review_expires_at") AND isfinite("owner_call_grant_operations"."grant_expires_at") AND
      isfinite("owner_call_grant_operations"."updated_at") AND "owner_call_grant_operations"."review_expires_at" > "owner_call_grant_operations"."registered_at" AND "owner_call_grant_operations"."grant_expires_at" > "owner_call_grant_operations"."registered_at" AND
      ("owner_call_grant_operations"."admitted_at" IS NULL OR isfinite("owner_call_grant_operations"."admitted_at")) AND ("owner_call_grant_operations"."committed_at" IS NULL OR isfinite("owner_call_grant_operations"."committed_at")) AND
      ("owner_call_grant_operations"."closed_at" IS NULL OR isfinite("owner_call_grant_operations"."closed_at")) AND ("owner_call_grant_operations"."rejected_at" IS NULL OR isfinite("owner_call_grant_operations"."rejected_at")) AND
      CASE "owner_call_grant_operations"."phase"
        WHEN 'registered' THEN "owner_call_grant_operations"."admitted_at" IS NULL AND "owner_call_grant_operations"."committed_at" IS NULL AND "owner_call_grant_operations"."closed_at" IS NULL AND "owner_call_grant_operations"."rejected_at" IS NULL AND "owner_call_grant_operations"."created_policy_id" IS NULL AND "owner_call_grant_operations"."wake_generation" IS NULL AND "owner_call_grant_operations"."updated_at" >= "owner_call_grant_operations"."registered_at"
        WHEN 'admitted' THEN "owner_call_grant_operations"."admitted_at" IS NOT NULL AND "owner_call_grant_operations"."admitted_at" >= "owner_call_grant_operations"."registered_at" AND "owner_call_grant_operations"."admitted_at" < "owner_call_grant_operations"."review_expires_at" AND "owner_call_grant_operations"."committed_at" IS NULL AND "owner_call_grant_operations"."closed_at" IS NULL AND "owner_call_grant_operations"."rejected_at" IS NULL AND "owner_call_grant_operations"."created_policy_id" IS NULL AND "owner_call_grant_operations"."wake_generation" IS NULL AND "owner_call_grant_operations"."updated_at" >= "owner_call_grant_operations"."admitted_at"
        WHEN 'committed' THEN "owner_call_grant_operations"."admitted_at" IS NOT NULL AND "owner_call_grant_operations"."admitted_at" >= "owner_call_grant_operations"."registered_at" AND "owner_call_grant_operations"."admitted_at" < "owner_call_grant_operations"."review_expires_at" AND "owner_call_grant_operations"."committed_at" IS NOT NULL AND "owner_call_grant_operations"."committed_at" >= "owner_call_grant_operations"."admitted_at" AND "owner_call_grant_operations"."committed_at" < "owner_call_grant_operations"."review_expires_at" AND "owner_call_grant_operations"."closed_at" IS NULL AND "owner_call_grant_operations"."rejected_at" IS NULL AND "owner_call_grant_operations"."created_policy_id" IS NOT NULL AND "owner_call_grant_operations"."wake_generation" IS NOT NULL AND "owner_call_grant_operations"."wake_generation" > 0 AND "owner_call_grant_operations"."updated_at" >= "owner_call_grant_operations"."committed_at"
        WHEN 'closed_no_effect' THEN "owner_call_grant_operations"."closed_at" IS NOT NULL AND ("owner_call_grant_operations"."admitted_at" IS NULL OR ("owner_call_grant_operations"."admitted_at" >= "owner_call_grant_operations"."registered_at" AND "owner_call_grant_operations"."admitted_at" < "owner_call_grant_operations"."review_expires_at")) AND "owner_call_grant_operations"."closed_at" >= COALESCE("owner_call_grant_operations"."admitted_at", "owner_call_grant_operations"."registered_at") AND "owner_call_grant_operations"."committed_at" IS NULL AND "owner_call_grant_operations"."rejected_at" IS NULL AND "owner_call_grant_operations"."created_policy_id" IS NULL AND "owner_call_grant_operations"."wake_generation" IS NULL AND "owner_call_grant_operations"."updated_at" >= "owner_call_grant_operations"."closed_at"
        WHEN 'rejected_no_effect' THEN "owner_call_grant_operations"."rejected_at" IS NOT NULL AND ("owner_call_grant_operations"."admitted_at" IS NULL OR ("owner_call_grant_operations"."admitted_at" >= "owner_call_grant_operations"."registered_at" AND "owner_call_grant_operations"."admitted_at" < "owner_call_grant_operations"."review_expires_at")) AND "owner_call_grant_operations"."rejected_at" >= COALESCE("owner_call_grant_operations"."admitted_at", "owner_call_grant_operations"."registered_at") AND "owner_call_grant_operations"."committed_at" IS NULL AND "owner_call_grant_operations"."closed_at" IS NULL AND "owner_call_grant_operations"."created_policy_id" IS NULL AND "owner_call_grant_operations"."wake_generation" IS NULL AND "owner_call_grant_operations"."updated_at" >= "owner_call_grant_operations"."rejected_at"
        ELSE false
      END
    )
);
--> statement-breakpoint
CREATE TABLE "owner_call_grant_usage" (
	"owner_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"grant_scope_fingerprint" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_call_grant_usage_pk" PRIMARY KEY("owner_id","policy_id","grant_scope_fingerprint"),
	CONSTRAINT "owner_call_grant_usage_fingerprint_check" CHECK ("owner_call_grant_usage"."grant_scope_fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "owner_call_grant_usage_events_check" CHECK (jsonb_typeof("owner_call_grant_usage"."events") = 'array' AND jsonb_array_length("owner_call_grant_usage"."events") <= 100),
	CONSTRAINT "owner_call_grant_usage_updated_at_check" CHECK (isfinite("owner_call_grant_usage"."updated_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "owner_call_grant_operations_slot_key" ON "owner_call_grant_operations" USING btree ("owner_id","approval_id","grant_id","slot_generation");
--> statement-breakpoint
ALTER TABLE "owner_call_grant_operation_slots" ADD CONSTRAINT "owner_call_grant_operation_slots_current_fk" FOREIGN KEY ("owner_id","approval_id","current_grant_id","generation") REFERENCES "public"."owner_call_grant_operations"("owner_id","approval_id","grant_id","slot_generation") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION owner_call_grant_operation_transition_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.owner_id, NEW.approval_id, NEW.grant_id, NEW.purpose, NEW.schema_version,
      NEW.operation_version, NEW.task_id, NEW.tool_call_id, NEW.slot_generation,
      NEW.request_fingerprint, NEW.grant_scope_fingerprint, NEW.registered_at,
      NEW.review_expires_at, NEW.grant_expires_at)
     IS DISTINCT FROM
     (OLD.owner_id, OLD.approval_id, OLD.grant_id, OLD.purpose, OLD.schema_version,
      OLD.operation_version, OLD.task_id, OLD.tool_call_id, OLD.slot_generation,
      OLD.request_fingerprint, OLD.grant_scope_fingerprint, OLD.registered_at,
      OLD.review_expires_at, OLD.grant_expires_at) THEN
    RAISE EXCEPTION 'owner call operation identity and deadlines are immutable';
  END IF;
  IF OLD.phase IN ('committed', 'closed_no_effect', 'rejected_no_effect')
     OR NOT ((OLD.phase = 'registered' AND NEW.phase IN ('admitted', 'closed_no_effect', 'rejected_no_effect'))
          OR (OLD.phase = 'admitted' AND NEW.phase IN ('committed', 'closed_no_effect', 'rejected_no_effect'))) THEN
    RAISE EXCEPTION 'owner call operation terminal or invalid transition';
  END IF;
  IF OLD.phase = 'registered' AND NEW.phase = 'admitted'
     AND (NEW.committed_at, NEW.closed_at, NEW.rejected_at, NEW.created_policy_id, NEW.wake_generation)
         IS DISTINCT FROM
         (OLD.committed_at, OLD.closed_at, OLD.rejected_at, OLD.created_policy_id, OLD.wake_generation) THEN
    RAISE EXCEPTION 'admission may change only phase, admitted_at, and updated_at';
  END IF;
  IF OLD.phase = 'registered' AND NEW.phase = 'closed_no_effect'
     AND (NEW.admitted_at, NEW.committed_at, NEW.rejected_at, NEW.created_policy_id, NEW.wake_generation)
         IS DISTINCT FROM
         (OLD.admitted_at, OLD.committed_at, OLD.rejected_at, OLD.created_policy_id, OLD.wake_generation) THEN
    RAISE EXCEPTION 'close may change only phase, closed_at, and updated_at';
  END IF;
  IF OLD.phase = 'registered' AND NEW.phase = 'rejected_no_effect'
     AND (NEW.admitted_at, NEW.committed_at, NEW.closed_at, NEW.created_policy_id, NEW.wake_generation)
         IS DISTINCT FROM
         (OLD.admitted_at, OLD.committed_at, OLD.closed_at, OLD.created_policy_id, OLD.wake_generation) THEN
    RAISE EXCEPTION 'rejection may change only phase, rejected_at, and updated_at';
  END IF;
  IF OLD.phase = 'admitted' AND NEW.phase = 'committed'
     AND (NEW.admitted_at, NEW.closed_at, NEW.rejected_at)
         IS DISTINCT FROM (OLD.admitted_at, OLD.closed_at, OLD.rejected_at) THEN
    RAISE EXCEPTION 'commit may change only phase, committed evidence, and updated_at';
  END IF;
  IF OLD.phase = 'admitted' AND NEW.phase = 'closed_no_effect'
     AND (NEW.admitted_at, NEW.committed_at, NEW.rejected_at, NEW.created_policy_id, NEW.wake_generation)
         IS DISTINCT FROM
         (OLD.admitted_at, OLD.committed_at, OLD.rejected_at, OLD.created_policy_id, OLD.wake_generation) THEN
    RAISE EXCEPTION 'close may change only phase, closed_at, and updated_at';
  END IF;
  IF OLD.phase = 'admitted' AND NEW.phase = 'rejected_no_effect'
     AND (NEW.admitted_at, NEW.committed_at, NEW.closed_at, NEW.created_policy_id, NEW.wake_generation)
         IS DISTINCT FROM
         (OLD.admitted_at, OLD.committed_at, OLD.closed_at, OLD.created_policy_id, OLD.wake_generation) THEN
    RAISE EXCEPTION 'rejection may change only phase, rejected_at, and updated_at';
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE TRIGGER owner_call_grant_operation_transition_guard
BEFORE UPDATE ON owner_call_grant_operations
FOR EACH ROW EXECUTE FUNCTION owner_call_grant_operation_transition_guard();

