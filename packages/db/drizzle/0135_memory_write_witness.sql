ALTER TABLE "memories" ADD COLUMN "memory_write_witness" jsonb;
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_memory_write_witness_check" CHECK (CASE
  WHEN "memories"."memory_write_witness" IS NULL THEN TRUE
  WHEN "memories"."memory_write_witness" = 'null'::jsonb THEN TRUE
  WHEN jsonb_typeof("memories"."memory_write_witness") IS DISTINCT FROM 'object' THEN FALSE
  ELSE (
    ("memories"."memory_write_witness" - ARRAY['version','writeVersion','contentHash','attribution']) = '{}'::jsonb
    AND "memories"."memory_write_witness" ?& ARRAY['version','writeVersion','contentHash','attribution']
    AND jsonb_typeof("memories"."memory_write_witness"->'version') = 'number'
    AND ("memories"."memory_write_witness"->'version' = '1'::jsonb) IS TRUE
    AND jsonb_typeof("memories"."memory_write_witness"->'writeVersion') = 'string'
    AND ("memories"."memory_write_witness"->>'writeVersion' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS TRUE
    AND jsonb_typeof("memories"."memory_write_witness"->'contentHash') = 'string'
    AND ("memories"."memory_write_witness"->>'contentHash' ~ '^[0-9a-f]{64}$') IS TRUE
    AND CASE
      WHEN ("memories"."memory_write_witness"->'attribution') = 'null'::jsonb THEN TRUE
      WHEN jsonb_typeof("memories"."memory_write_witness"->'attribution') IS DISTINCT FROM 'object' THEN FALSE
      ELSE (
        (("memories"."memory_write_witness"->'attribution') - ARRAY['operationKey','requestHash','provenanceFingerprint']) = '{}'::jsonb
        AND ("memories"."memory_write_witness"->'attribution') ?& ARRAY['operationKey','requestHash','provenanceFingerprint']
        AND jsonb_typeof(("memories"."memory_write_witness"->'attribution')->'operationKey') = 'string'
        AND (("memories"."memory_write_witness"->'attribution')->>'operationKey' ~ '^[0-9a-f]{64}$') IS TRUE
        AND jsonb_typeof(("memories"."memory_write_witness"->'attribution')->'requestHash') = 'string'
        AND (("memories"."memory_write_witness"->'attribution')->>'requestHash' ~ '^[0-9a-f]{64}$') IS TRUE
        AND jsonb_typeof(("memories"."memory_write_witness"->'attribution')->'provenanceFingerprint') = 'string'
        AND (("memories"."memory_write_witness"->'attribution')->>'provenanceFingerprint' ~ '^[0-9a-f]{64}$') IS TRUE
      ) IS TRUE
    END
  ) IS TRUE
END);
