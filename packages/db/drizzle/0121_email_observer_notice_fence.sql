ALTER TABLE notification_outbox
  ADD COLUMN producer_work_id text,
  ADD COLUMN producer_privacy_generation text;

CREATE INDEX notification_outbox_producer_work_idx
  ON notification_outbox (agent_id, producer_work_id)
  WHERE producer_work_id IS NOT NULL;
