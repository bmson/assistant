ALTER TABLE recall_metrics
  DROP CONSTRAINT IF EXISTS recall_metrics_tier_check;

ALTER TABLE recall_metrics
  ADD CONSTRAINT recall_metrics_tier_check
  CHECK (history_tier IN ('segment', 'message', 'blended', 'none'));
