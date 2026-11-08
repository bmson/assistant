import { sql } from 'drizzle-orm';
import { emailIngest } from './schema.js';

/** SQL counterpart of persistence.emailIngestReadable; observer receipts do not gate reads. */
export function emailIngestReadableSql() {
  return sql`(${emailIngest.pipelineStage} IS NULL OR ${emailIngest.pipelineStage} = 'complete' OR (
    ${emailIngest.pipelineStage} = 'message_persisted'
    AND ${emailIngest.ingestMode} = 'direct' AND ${emailIngest.authenticated} = true
    AND length(${emailIngest.admittedSourceId}) > 0
    AND (${emailIngest.admittedSourceKind} = 'automated_source' OR (
      ${emailIngest.admittedSourceKind} = 'message' AND ${emailIngest.messagePersisted} = true))
    AND (${emailIngest.scoreStatus} = 'prepared' OR (
      ${emailIngest.scoreStatus} = 'unknown' AND ${emailIngest.scoreOutcome} = 'fallback_committed_unknown'))
  ))`;
}
