ALTER TABLE "call_sessions" ADD COLUMN "capacity_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "message_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "append_sequence" text DEFAULT '00000000000000000000' NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_conversation_append_idx" ON "messages" USING btree ("conversation_id","append_sequence");--> statement-breakpoint
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS sequence
  FROM messages
)
UPDATE messages AS target
SET append_sequence = lpad(ranked.sequence::text, 20, '0')
FROM ranked
WHERE ranked.id = target.id;
--> statement-breakpoint
UPDATE conversations AS conversation
SET message_sequence = COALESCE(latest.sequence, 0)
FROM (
  SELECT conversation_id, max(append_sequence::numeric) AS sequence
  FROM messages
  GROUP BY conversation_id
) AS latest
WHERE latest.conversation_id = conversation.id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION assign_message_append_sequence() RETURNS trigger AS $$
DECLARE
  assigned_sequence bigint;
BEGIN
  UPDATE conversations
  SET message_sequence = message_sequence + 1
  WHERE id = NEW.conversation_id
  RETURNING message_sequence INTO assigned_sequence;
  IF assigned_sequence IS NULL THEN
    RAISE EXCEPTION 'Conversation % does not exist', NEW.conversation_id;
  END IF;
  NEW.append_sequence := lpad(assigned_sequence::text, 20, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER messages_assign_append_sequence
BEFORE INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION assign_message_append_sequence();
