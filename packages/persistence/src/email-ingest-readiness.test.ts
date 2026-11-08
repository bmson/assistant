import { describe, expect, it } from 'vitest';
import { emailIngestReadable } from './email-ingest-readiness.js';
import type { Records } from './records.js';

const admitted: Partial<Records['emailIngest']> = {
  pipelineStage: 'message_persisted',
  ingestMode: 'direct',
  authenticated: true,
  admittedSourceKind: 'automated_source',
  admittedSourceId: 'canonical-source',
  messagePersisted: false,
  scoreStatus: 'prepared',
};

describe('email source readiness independent of observers', () => {
  it('includes legacy, completed and atomically admitted automated sources', () => {
    for (const row of [
      {},
      { pipelineStage: 'complete' },
      admitted,
      { ...admitted, admittedSourceKind: 'message', messagePersisted: true },
      { ...admitted, scoreStatus: 'unknown', scoreOutcome: 'fallback_committed_unknown' },
    ])
      expect(emailIngestReadable(row)).toBe(true);
  });
  it('excludes unadmitted, unauthenticated, ambiguous and unfinished forwarded work', () => {
    for (const patch of [
      { pipelineStage: 'pending_score' },
      { pipelineStage: 'needs_attention' },
      { ingestMode: 'forwarded' },
      { admittedSourceId: null },
      { authenticated: false },
      { admittedSourceKind: 'message' },
      { scoreStatus: 'in_progress' },
      { scoreStatus: 'unknown', scoreOutcome: undefined },
    ])
      expect(emailIngestReadable({ ...admitted, ...patch })).toBe(false);
  });
});
