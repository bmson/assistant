DROP INDEX "commitments_agent_hash_idx";--> statement-breakpoint
ALTER TABLE "commitments" ADD COLUMN "source_occurrence_key" text;--> statement-breakpoint
WITH ranked AS (
  SELECT
    id,
    agent_id,
    conversation_id,
    kind,
    source_message_id,
    row_number() OVER (
      PARTITION BY agent_id, conversation_id, kind, source_message_id
      ORDER BY CASE WHEN status IN ('open', 'snoozed') THEN 1 ELSE 0 END, created_at, id
    ) AS occurrence_rank
  FROM commitments
  WHERE source_message_id IS NOT NULL
)
UPDATE commitments AS commitment
SET source_occurrence_key =
  'v1:' || ranked.agent_id || ':' || ranked.conversation_id || ':' || ranked.kind || ':' || ranked.source_message_id ||
  CASE WHEN ranked.occurrence_rank = 1 THEN '' ELSE ':legacy:' || ranked.id END
FROM ranked
WHERE commitment.id = ranked.id;--> statement-breakpoint
CREATE UNIQUE INDEX "commitments_agent_source_occurrence_idx" ON "commitments" USING btree ("agent_id","source_occurrence_key") WHERE "commitments"."source_occurrence_key" IS NOT NULL;
