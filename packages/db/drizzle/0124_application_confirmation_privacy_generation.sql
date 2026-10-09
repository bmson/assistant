ALTER TABLE application_confirmations
  ADD COLUMN producer_privacy_generation text;

ALTER TABLE application_confirmations
  ADD CONSTRAINT application_confirmations_producer_privacy_generation_check
    CHECK (producer_privacy_generation IS NULL OR length(producer_privacy_generation) <= 128);
