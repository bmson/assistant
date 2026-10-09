ALTER TABLE notification_outbox
  ADD COLUMN producer_task_id uuid,
  ADD COLUMN producer_application_id uuid,
  ADD COLUMN producer_confirmation_message_id text;

CREATE INDEX notification_outbox_producer_task_idx
  ON notification_outbox (agent_id, producer_task_id)
  WHERE producer_task_id IS NOT NULL;
