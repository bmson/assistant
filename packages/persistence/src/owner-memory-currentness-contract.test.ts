import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  nextOwnerCorrection,
  type OwnerMemoryCorrectionEligibilityInput,
  ownerMemoryCorrectionEligibility,
} from './owner-memory-correction.js';
import {
  type OwnerMemoryProvenancePayload,
  ownerMemoryProvenanceFingerprint,
} from './owner-memory-provenance.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const memoryId = '22222222-2222-4222-8222-222222222222';
const contactId = '33333333-3333-4333-8333-333333333333';
const oldHash = createHash('sha256').update('Synthetic old note').digest('hex');
const currentHash = createHash('sha256').update('Synthetic corrected note').digest('hex');

function provenance(contentHash: string, name = 'Synthetic contact'): OwnerMemoryProvenancePayload {
  return {
    version: 1,
    driver: 'postgres',
    ownerId,
    memoryId,
    contentHash,
    targetSource: { source: 'manual', sourceTaskId: null, subjectContactId: contactId },
    dependencies: [
      {
        collection: 'contacts',
        key: contactId,
        state: 'present',
        value: { id: contactId, name, aliases: [] },
        nativeVersion: null,
      },
      {
        collection: 'memoryTombstones',
        key: contentHash,
        state: 'missing',
        value: null,
        nativeVersion: null,
      },
    ],
    queries: [
      {
        collection: 'memoryImportLineage',
        scope: { memoryId },
        limit: 2,
        complete: true,
        keys: [],
      },
    ],
  };
}

// These normalized inputs expose contract counterexamples only. They do not
// establish that either adapter performed a canonical transaction or complete read.
function eligibility(tombstones: ReadonlySet<string>) {
  const input: OwnerMemoryCorrectionEligibilityInput = {
    ownerId,
    now: new Date('2026-11-04T12:00:00.000Z'),
    memory: {
      id: memoryId,
      agentId: ownerId,
      contentHash: currentHash,
      category: 'knowledge',
      source: 'manual',
      sourceTaskId: null,
      expiresAt: null,
      supersededById: null,
      quarantined: false,
      subjectContactId: contactId,
      ownerCorrection: nextOwnerCorrection({
        previous: null,
        priorContentHash: oldHash,
        currentContentHash: currentHash,
        correctedAt: '2026-11-04T11:00:00.000Z',
      }),
    },
    proof: {
      complete: true,
      tombstoned: tombstones.has(currentHash),
      shared: false,
      conflictingLineage: false,
      subjectValid: true,
      provenance: { kind: 'manual' },
    },
  };
  return ownerMemoryCorrectionEligibility(input);
}

describe('owner-memory currentness contract counterexamples (source-only)', () => {
  it('distinguishes the expected old-hash tombstone from a current-hash tombstone', () => {
    expect(eligibility(new Set([oldHash])).eligible).toBe(true);
    expect(eligibility(new Set([oldHash, currentHash]))).toMatchObject({
      eligible: false,
      readOnlyReason: 'tombstoned',
    });
  });

  it('does not equate prewrite evidence with an otherwise eligible corrected row', () => {
    const prewrite = ownerMemoryProvenanceFingerprint(provenance(oldHash));
    const corrected = ownerMemoryProvenanceFingerprint(provenance(currentHash));
    expect(prewrite).not.toBeNull();
    expect(corrected).not.toBeNull();
    expect(corrected).not.toBe(prewrite);
    expect(eligibility(new Set([oldHash])).eligible).toBe(true);
    // This difference is expected for a successful correction. It cannot itself
    // classify that operation as not-current or justify changing hash semantics.
  });

  it('shows matching receipt/witness copies plus eligibility cannot detect contact changes', () => {
    const fingerprint = ownerMemoryProvenanceFingerprint(provenance(oldHash));
    const receiptFingerprint = fingerprint;
    const witnessFingerprint = fingerprint;
    // Keep the prewrite hash fixed solely to isolate the external dependency.
    // This is not a proposed postwrite projection or a readback implementation.
    const changedContactEvidence = provenance(oldHash, 'Synthetic changed name');
    expect(changedContactEvidence.targetSource.subjectContactId).toBe(contactId);
    expect(eligibility(new Set([oldHash])).eligible).toBe(true);
    expect(receiptFingerprint).toBe(witnessFingerprint);
    expect(ownerMemoryProvenanceFingerprint(changedContactEvidence)).not.toBe(fingerprint);
    // A currentness implementation must resolve this gap through verified
    // canonical evidence or complete invalidation; copied hashes are insufficient.
  });
});
