import type { Records } from './records.js';

/** Source admission and observer execution are independent. A direct-mode
 * canonical source is readable even while its side-effect observers are pending. */
export function emailIngestReadable(row: Partial<Records['emailIngest']>): boolean {
  if (row.pipelineStage == null || row.pipelineStage === 'complete') return true;
  return (
    row.pipelineStage === 'message_persisted' &&
    row.ingestMode === 'direct' &&
    row.authenticated === true &&
    typeof row.admittedSourceId === 'string' &&
    row.admittedSourceId.length > 0 &&
    (row.admittedSourceKind === 'automated_source' ||
      (row.admittedSourceKind === 'message' && row.messagePersisted === true)) &&
    (row.scoreStatus === 'prepared' ||
      (row.scoreStatus === 'unknown' && row.scoreOutcome === 'fallback_committed_unknown'))
  );
}
