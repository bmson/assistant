CREATE TABLE "tool_call_receipt_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"digest" text NOT NULL,
	CONSTRAINT "tool_call_receipt_keys_kind_check" CHECK ("tool_call_receipt_keys"."kind" IN ('model_tool_call','idempotency')),
	CONSTRAINT "tool_call_receipt_keys_id_check" CHECK ("tool_call_receipt_keys"."id" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "tool_call_receipt_keys_digest_check" CHECK ("tool_call_receipt_keys"."digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "tool_call_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"tool_call_id" uuid NOT NULL,
	"model_tool_call_id_hash" text,
	"idempotency_key_hash" text,
	"tool_name" text NOT NULL,
	"effect_outcome" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tool_call_receipts_tool_call_id_unique" UNIQUE("tool_call_id"),
	CONSTRAINT "tool_call_receipts_outcome_check" CHECK ("tool_call_receipts"."effect_outcome" IN ('completed','failed','unknown','not_executed')),
	CONSTRAINT "tool_call_receipts_model_hash_check" CHECK ("tool_call_receipts"."model_tool_call_id_hash" IS NULL OR "tool_call_receipts"."model_tool_call_id_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "tool_call_receipts_idempotency_hash_check" CHECK ("tool_call_receipts"."idempotency_key_hash" IS NULL OR "tool_call_receipts"."idempotency_key_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "tool_call_receipt_keys" ADD CONSTRAINT "tool_call_receipt_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_receipts" ADD CONSTRAINT "tool_call_receipts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_receipt_keys_global_idempotency_idx" ON "tool_call_receipt_keys" USING btree ("digest") WHERE "tool_call_receipt_keys"."kind" = 'idempotency';--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_receipt_keys_model_scope_idx" ON "tool_call_receipt_keys" USING btree ("agent_id","task_id","digest") WHERE "tool_call_receipt_keys"."kind" = 'model_tool_call';--> statement-breakpoint
CREATE INDEX "tool_call_receipt_keys_receipt_idx" ON "tool_call_receipt_keys" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "tool_call_receipts_agent_task_idx" ON "tool_call_receipts" USING btree ("agent_id","task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_receipts_model_lookup_idx" ON "tool_call_receipts" USING btree ("model_tool_call_id_hash") WHERE "tool_call_receipts"."model_tool_call_id_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_receipts_global_idempotency_idx" ON "tool_call_receipts" USING btree ("idempotency_key_hash") WHERE "tool_call_receipts"."idempotency_key_hash" IS NOT NULL;