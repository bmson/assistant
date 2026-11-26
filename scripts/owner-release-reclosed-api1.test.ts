import { describe, expect, it } from 'vitest';
import { verifyReclosedPredecessorJournal } from './owner-release-reclosed-api1.js';

const source = 'a'.repeat(40);
const runId = '44632388669';
const manifestDigest = 'b'.repeat(64);
const proofSha256 = 'c'.repeat(64);
const identity = { source, runId, attempt: '1', manifestDigest } as const;
const journal = {
  'start.json': {
    format: 1,
    source,
    runId,
    attempt: '1',
    phase: 'started',
    decision: 'verified',
    proofSha256,
    mutationAuthorized: false,
    observationRequired: false,
  },
  'outcome.json': {
    format: 1,
    source,
    runId,
    attempt: '1',
    phase: 'interrupted',
    decision: 'rehydrate_original_children',
    proofSha256,
    mutationAuthorized: false,
    observationRequired: true,
  },
};

describe('failed predecessor admission journal', () => {
  it('requires exact authenticated pre-admission outcome and no admission seal', () => {
    expect(verifyReclosedPredecessorJournal(identity, proofSha256, journal)).toMatchObject(
      identity,
    );
    for (const files of [
      { ...journal, 'admission.json': {} },
      { 'start.json': journal['start.json'] },
      {
        ...journal,
        'outcome.json': { ...journal['outcome.json'], decision: 'observation_required' },
      },
      { ...journal, 'outcome.json': { ...journal['outcome.json'], proofSha256: 'f'.repeat(64) } },
    ]) {
      expect(() => verifyReclosedPredecessorJournal(identity, proofSha256, files)).toThrow();
    }
  });
});
