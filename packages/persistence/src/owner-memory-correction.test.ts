import { describe, expect, it } from 'vitest';
import {
  nextOwnerCorrection,
  type OwnerMemoryCorrectionEligibilityInput,
  ownerMemoryCorrectionEligibility,
  parseOwnerCorrection,
  validSingleOwnerMemoryImportUnit,
} from './owner-memory-correction.js';

const first = 'a'.repeat(64),
  second = 'b'.repeat(64),
  third = 'c'.repeat(64);
const now = new Date('2026-10-25T00:00:00.000Z');
const owner = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const fixture = (): OwnerMemoryCorrectionEligibilityInput => ({
  ownerId: owner,
  now,
  memory: {
    id,
    agentId: owner,
    contentHash: first,
    category: 'knowledge',
    source: 'manual',
    sourceTaskId: null,
    subjectContactId: null,
    expiresAt: null,
    supersededById: null,
    quarantined: false,
  },
  proof: {
    complete: true,
    tombstoned: false,
    shared: false,
    conflictingLineage: false,
    subjectValid: true,
    provenance: { kind: 'manual' },
  },
});
describe('owner correction attribution, not original document replacement', () => {
  it('keeps legacy absence and same-hash no-op unmarked', () => {
    expect(parseOwnerCorrection(undefined, first)).toBeNull();
    expect(
      nextOwnerCorrection({
        previous: null,
        priorContentHash: first,
        currentContentHash: first,
        correctedAt: now,
      }),
    ).toBeNull();
  });
  it('tracks each immediately preceding saved note and preserves valid no-op marker', () => {
    const one = nextOwnerCorrection({
      previous: null,
      priorContentHash: first,
      currentContentHash: second,
      correctedAt: now,
    });
    expect(one).toMatchObject({
      priorContentHash: first,
      currentContentHash: second,
      correctedByOwner: true,
    });
    expect(
      nextOwnerCorrection({
        previous: one,
        priorContentHash: second,
        currentContentHash: second,
        correctedAt: new Date(),
      }),
    ).toEqual(one);
    expect(
      nextOwnerCorrection({
        previous: one,
        priorContentHash: second,
        currentContentHash: third,
        correctedAt: now,
      }),
    ).toMatchObject({ priorContentHash: second, currentContentHash: third });
  });
  it('rejects malformed/stale/extra/private marker content rather than resetting attribution', () => {
    const marker = nextOwnerCorrection({
      previous: null,
      priorContentHash: first,
      currentContentHash: second,
      correctedAt: now,
    });
    for (const bad of [
      { ...marker, currentContentHash: first },
      { ...marker, correctedAt: 'yesterday' },
      { ...marker, content: 'private draft' },
      { ...marker, priorContentHash: second },
    ])
      expect(() => parseOwnerCorrection(bad, second)).toThrow();
    expect(() =>
      nextOwnerCorrection({
        previous: marker,
        priorContentHash: first,
        currentContentHash: third,
        correctedAt: now,
      }),
    ).toThrow();
  });
});
describe('bounded normalized source proof eligibility', () => {
  it('permits known manual/graph owner notes, not unknown provenance', () => {
    const x = fixture();
    expect(ownerMemoryCorrectionEligibility(x).eligible).toBe(true);
    x.memory.source = 'knowledge-graph-owner';
    x.proof.provenance = { kind: 'graph_owner' };
    expect(ownerMemoryCorrectionEligibility(x).eligible).toBe(true);
    x.proof.provenance = { kind: 'unknown' };
    expect(ownerMemoryCorrectionEligibility(x).readOnlyReason).toBe('unknown_provenance');
  });
  it('requires actual extracted task + source relationship and configured owners', () => {
    const x = fixture();
    x.memory.sourceTaskId = id;
    x.memory.source = 'conversation';
    x.proof.provenance = {
      kind: 'extracted',
      taskId: id,
      taskOwnerId: owner,
      sourceRelationship: 'conversation_message',
      sourceOwnerId: owner,
      exactSourceMatch: true,
    };
    expect(ownerMemoryCorrectionEligibility(x).eligible).toBe(true);
    x.proof.provenance.exactSourceMatch = false;
    expect(ownerMemoryCorrectionEligibility(x).eligible).toBe(false);
  });
  it('allows exactly one canonical owned import unit, rejects multi/aggregate/unverified imports', () => {
    const x = fixture();
    x.memory.source = 'import-one';
    x.proof.provenance = {
      kind: 'import',
      canonicalOwnerId: owner,
      canonicalSource: 'import-one',
      lineageCount: 1,
      unitCount: 1,
      strictUnit: true,
    };
    expect(ownerMemoryCorrectionEligibility(x).eligible).toBe(true);
    x.proof.provenance.unitCount = 2;
    expect(ownerMemoryCorrectionEligibility(x).readOnlyReason).toBe(
      'unsupported_import_provenance',
    );
  });
  it.each(['complete', 'shared', 'conflictingLineage', 'tombstoned'] as const)(
    'fails closed on %s boundary',
    (key) => {
      const x = fixture();
      x.proof[key] = key !== 'complete';
      expect(ownerMemoryCorrectionEligibility(x).eligible).toBe(false);
    },
  );
  it('rejects stale lifecycle, unowned subject and malformed correction marker', () => {
    const x = fixture();
    x.memory.expiresAt = now;
    expect(ownerMemoryCorrectionEligibility(x).eligible).toBe(false);
    x.memory.expiresAt = null;
    x.memory.subjectContactId = id;
    x.proof.subjectValid = false;
    expect(ownerMemoryCorrectionEligibility(x).readOnlyReason).toBe('unverified_subject');
    x.memory.ownerCorrection = { version: 1 };
    expect(ownerMemoryCorrectionEligibility(x).readOnlyReason).toBe('malformed_owner_correction');
  });
});

it('strict single import unit rejects extra fields, noncanonical dates and unbounded offsets/header', () => {
  const unit = {
    sourceOffset: 0,
    unitOffset: 1,
    observedAt: '2026-10-25T00:00:00.000Z',
    authorEmail: null,
    header: 'Synthetic source',
    hasQuotedContent: false,
    unitTextHash: first,
  };
  expect(validSingleOwnerMemoryImportUnit(unit)).toBe(true);
  for (const bad of [
    { ...unit, extra: true },
    { ...unit, sourceOffset: Infinity },
    { ...unit, unitOffset: -1 },
    { ...unit, observedAt: '2026-10-25' },
    { ...unit, header: 'x'.repeat(8001) },
    { ...unit, unitTextHash: 'nohash' },
  ])
    expect(validSingleOwnerMemoryImportUnit(bad)).toBe(false);
});
