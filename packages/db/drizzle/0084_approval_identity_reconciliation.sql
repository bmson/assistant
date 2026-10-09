-- Forward correction for installations whose 0020 watermark skipped 0021.
-- Historical migration timestamps and SQL remain immutable.
LOCK TABLE "approval_policies", "approvals" IN SHARE ROW EXCLUSIVE MODE;

WITH ranked AS (
  SELECT "id", first_value("id") OVER (
    PARTITION BY "agent_id", "tool_name", "template_key", "match", "effect"
    ORDER BY "enabled" DESC, "created_at" ASC, "id" ASC
  ) AS "keep_id", row_number() OVER (
    PARTITION BY "agent_id", "tool_name", "template_key", "match", "effect"
    ORDER BY "enabled" DESC, "created_at" ASC, "id" ASC
  ) AS "duplicate_number" FROM "approval_policies"
)
UPDATE "approvals" a SET "created_policy_id" = ranked."keep_id"
FROM ranked WHERE ranked."duplicate_number" > 1 AND a."created_policy_id" = ranked."id";

WITH ranked AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "agent_id", "tool_name", "template_key", "match", "effect"
    ORDER BY "enabled" DESC, "created_at" ASC, "id" ASC
  ) AS "duplicate_number" FROM "approval_policies"
)
DELETE FROM "approval_policies" p USING ranked
WHERE ranked."duplicate_number" > 1 AND p."id" = ranked."id";

DO $$
DECLARE valid_identity boolean;
BEGIN
  SELECT i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL
    AND i.indnkeyatts = 5 AND i.indnatts = 5 AND am.amname = 'btree'
    AND (SELECT array_agg(a.attname::text ORDER BY key.ordinality)
      FROM unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = key.attnum)
      = ARRAY['agent_id','tool_name','template_key','match','effect']
  INTO valid_identity
  FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
  JOIN pg_am am ON idx.relam = am.oid
  WHERE i.indrelid = 'approval_policies'::regclass
    AND idx.relname = 'approval_policies_identity_idx';
  IF valid_identity IS DISTINCT FROM TRUE THEN
    EXECUTE format('DROP INDEX IF EXISTS %I.approval_policies_identity_idx', current_schema());
    CREATE UNIQUE INDEX "approval_policies_identity_idx" ON "approval_policies"
      USING btree ("agent_id","tool_name","template_key","match","effect");
  END IF;
END $$;
