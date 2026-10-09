ALTER TABLE email_ingest
  ADD COLUMN direct_routing text,
  ADD COLUMN direct_recovery_reason text,
  ADD COLUMN email_content_provenance jsonb;

ALTER TABLE email_ingest
  ADD CONSTRAINT email_ingest_direct_routing_check
    CHECK (direct_routing IS NULL OR direct_routing IN ('application_confirmation','email_triage','needs_attention')),
  ADD CONSTRAINT email_ingest_direct_recovery_reason_check
    CHECK (direct_recovery_reason IS NULL OR direct_recovery_reason IN ('provider_message_missing','provider_access_denied','provider_temporarily_unavailable','checkpoint_inconsistent'));

CREATE INDEX email_ingest_direct_recovery_idx
  ON email_ingest (agent_id, mailbox, updated_at, id)
  WHERE ingest_mode = 'direct' AND authenticated = true
    AND admitted_source_kind IS NULL AND message_persisted = false
    AND pipeline_stage <> 'needs_attention';
