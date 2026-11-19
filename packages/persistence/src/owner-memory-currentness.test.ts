import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  classifyOwnerMemoryCurrentness,
  type OwnerMemoryCorrectionReceiptProof,
  type OwnerMemoryCurrentnessRead,
  type OwnerMemoryCurrentnessRequest,
} from './owner-memory-currentness.js';
import {
  type OwnerMemoryProvenancePayload,
  ownerMemoryProvenanceFingerprint,
} from './owner-memory-provenance.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const memoryId = '22222222-2222-4222-8222-222222222222';
const contactId = '33333333-3333-4333-8333-333333333333';
const writeVersion = '44444444-4444-4444-8444-444444444444';
const otherId = '55555555-5555-4555-8555-555555555555';
const content = 'Synthetic corrected note';
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const currentHash = hash(content);
const priorHash = hash('Synthetic old note');
const request: OwnerMemoryCurrentnessRequest = {
  ownerId,
  memoryId,
  operationKey: 'a'.repeat(64),
  requestHash: 'b'.repeat(64),
};

function evidence(contentHash: string): OwnerMemoryProvenancePayload {
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
        value: { id: contactId, name: 'Synthetic contact', aliases: [] },
        nativeVersion: { kind: 'postgres_timestamp', value: '2026-11-04T10:00:00.123456Z' },
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

function fixture() {
  const prewrite = evidence(priorHash);
  const current = evidence(currentHash);
  const prewriteFingerprint = ownerMemoryProvenanceFingerprint(prewrite)!;
  // Synthetic expected payload only: no adapter projection/transaction is proved.
  const proof: OwnerMemoryCorrectionReceiptProof = {
    version: 1,
    writeVersion,
    contentHash: currentHash,
    provenanceFingerprint: prewriteFingerprint,
    expectedCurrentProvenanceFingerprint: ownerMemoryProvenanceFingerprint(current),
  };
  const witness = {
    version: 1,
    writeVersion,
    contentHash: currentHash,
    attribution: {
      operationKey: request.operationKey,
      requestHash: request.requestHash,
      provenanceFingerprint: prewriteFingerprint,
    },
  };
  const read: OwnerMemoryCurrentnessRead = {
    receipt: {
      ...request,
      command: 'correct_owner_memory',
      status: 'committed',
      outcome: 'saved',
      proof,
    },
    memory: {
      id: memoryId,
      agentId: ownerId,
      content,
      contentHash: currentHash,
      category: 'knowledge',
      source: 'manual',
      sourceTaskId: null,
      subjectContactId: contactId,
      expiresAt: null,
      supersededById: null,
      quarantined: false,
      ownerCorrection: null,
      memoryWriteWitness: witness,
    },
    currentProvenance: current,
    readAt: new Date('2026-11-04T12:00:00.000Z'),
    eligibilityProof: {
      complete: true,
      tombstoned: false,
      shared: false,
      conflictingLineage: false,
      subjectValid: true,
      provenance: { kind: 'manual' },
    },
  };
  return { read, proof, witness, current, prewrite };
}

describe('owner-memory currentness pure receipt contract (not adapter qualification)', () => {
  it('binds distinct prewrite and current evidence at one supplied read instant', () => {
    const { read, proof } = fixture();
    expect(proof.provenanceFingerprint).not.toBe(proof.expectedCurrentProvenanceFingerprint);
    expect(classifyOwnerMemoryCurrentness(request, read)).toEqual({
      disposition: 'saved_current',
      contentHash: currentHash,
    });
  });

  it('uses exact Firestore external versions without hashing the written memory version', () => {
    const { read, proof, current } = fixture();
    current.driver = 'firestore';
    current.dependencies[0]!.nativeVersion = {
      kind: 'firestore_timestamp',
      seconds: 1_793_836_800,
      nanoseconds: 123_456_789,
    };
    proof.expectedCurrentProvenanceFingerprint = ownerMemoryProvenanceFingerprint(current);
    expect(classifyOwnerMemoryCurrentness(request, read).disposition).toBe('saved_current');
    current.dependencies[0]!.nativeVersion.nanoseconds++;
    expect(classifyOwnerMemoryCurrentness(request, read).disposition).toBe('not_current');
  });

  const mismatches: [string, (f: ReturnType<typeof fixture>) => void][] = [
    [
      'receipt owner',
      ({ read }) => {
        read.receipt!.ownerId = otherId;
      },
    ],
    [
      'receipt memory',
      ({ read }) => {
        read.receipt!.memoryId = otherId;
      },
    ],
    [
      'receipt operation',
      ({ read }) => {
        read.receipt!.operationKey = 'c'.repeat(64);
      },
    ],
    [
      'receipt request',
      ({ read }) => {
        read.receipt!.requestHash = 'c'.repeat(64);
      },
    ],
    [
      'memory owner',
      ({ read }) => {
        read.memory!.agentId = otherId;
      },
    ],
    [
      'memory identity',
      ({ read }) => {
        read.memory!.id = otherId;
      },
    ],
    [
      'witness operation',
      ({ witness }) => {
        witness.attribution.operationKey = 'c'.repeat(64);
      },
    ],
    [
      'witness request',
      ({ witness }) => {
        witness.attribution.requestHash = 'c'.repeat(64);
      },
    ],
    [
      'witness prewrite fingerprint',
      ({ witness }) => {
        witness.attribution.provenanceFingerprint = 'c'.repeat(64);
      },
    ],
    [
      'receipt prewrite fingerprint',
      ({ proof }) => {
        proof.provenanceFingerprint = 'c'.repeat(64);
      },
    ],
    [
      'receipt expected current fingerprint',
      ({ proof }) => {
        proof.expectedCurrentProvenanceFingerprint = 'c'.repeat(64);
      },
    ],
    [
      'receipt write version',
      ({ proof }) => {
        proof.writeVersion = otherId;
      },
    ],
    [
      'witness write version',
      ({ witness }) => {
        witness.writeVersion = otherId;
      },
    ],
    [
      'receipt content hash',
      ({ proof }) => {
        proof.contentHash = 'c'.repeat(64);
      },
    ],
    [
      'witness content hash',
      ({ witness }) => {
        witness.contentHash = 'c'.repeat(64);
      },
    ],
    [
      'row content hash',
      ({ read }) => {
        read.memory!.contentHash = 'c'.repeat(64);
      },
    ],
    [
      'actual body',
      ({ read }) => {
        read.memory!.content = 'Synthetic later content';
      },
    ],
    [
      'provenance owner',
      ({ current }) => {
        current.ownerId = otherId;
      },
    ],
    [
      'provenance memory',
      ({ current }) => {
        current.memoryId = otherId;
      },
    ],
    [
      'prewrite hash substituted for current',
      ({ current }) => {
        current.contentHash = priorHash;
      },
    ],
    [
      'source identity',
      ({ current }) => {
        current.targetSource.source = 'other';
      },
    ],
    [
      'subject identity',
      ({ current }) => {
        current.targetSource.subjectContactId = otherId;
      },
    ],
    [
      'same-ID contact name',
      ({ current }) => {
        current.dependencies[0]!.value = {
          id: contactId,
          name: 'Synthetic changed name',
          aliases: [],
        };
      },
    ],
    [
      'same-ID contact alias',
      ({ current }) => {
        current.dependencies[0]!.value = {
          id: contactId,
          name: 'Synthetic contact',
          aliases: ['Synthetic alias'],
        };
      },
    ],
    [
      'external native version',
      ({ current }) => {
        current.dependencies[0]!.nativeVersion = {
          kind: 'postgres_timestamp',
          value: '2026-11-04T10:00:00.123457Z',
        };
      },
    ],
    [
      'missing dependency',
      ({ current }) => {
        current.dependencies[0] = {
          ...current.dependencies[0]!,
          state: 'missing',
          value: null,
          nativeVersion: null,
        };
      },
    ],
    [
      'uncaptured dependency',
      ({ current }) => {
        current.dependencies.shift();
      },
    ],
    [
      'new query member',
      ({ current }) => {
        current.queries[0]!.keys.push('new-lineage');
      },
    ],
    [
      'current-hash tombstone',
      ({ current, read }) => {
        current.dependencies[1] = {
          ...current.dependencies[1]!,
          state: 'present',
          value: { contentHash: currentHash },
          nativeVersion: null,
        };
        read.eligibilityProof.tombstoned = true;
      },
    ],
    [
      'quarantine',
      ({ read }) => {
        read.memory!.quarantined = true;
      },
    ],
    [
      'supersession',
      ({ read }) => {
        read.memory!.supersededById = otherId;
      },
    ],
    [
      'expiry',
      ({ read }) => {
        read.memory!.expiresAt = new Date('2026-11-04T11:00:00.000Z');
      },
    ],
    [
      'invalid source subject',
      ({ read }) => {
        read.eligibilityProof.subjectValid = false;
      },
    ],
  ];
  it.each(mismatches)('rejects %s', (_name, mutate) => {
    const f = fixture();
    mutate(f);
    expect(classifyOwnerMemoryCurrentness(request, f.read).disposition).toBe('not_current');
  });

  it.each(['unchanged', 'conflict', 'invalid', 'unavailable', 'not_applied'])(
    'rejects non-saved outcome %s',
    (outcome) => {
      const { read } = fixture();
      read.receipt!.outcome = outcome;
      expect(classifyOwnerMemoryCurrentness(request, read).disposition).toBe('not_current');
    },
  );
  it.each(['preparing', 'terminal_rejected', 'abandoned'] as const)(
    'rejects %s status',
    (status) => {
      const { read } = fixture();
      read.receipt!.status = status;
      expect(classifyOwnerMemoryCurrentness(request, read).disposition).toBe('not_current');
    },
  );
  it('cannot qualify an owner creation as a saved correction', () => {
    const { read } = fixture();
    read.receipt!.command = 'create_owner_memory';
    expect(classifyOwnerMemoryCurrentness(request, read).disposition).toBe('not_current');
  });

  const unknowns: [string, (f: ReturnType<typeof fixture>) => void][] = [
    [
      'legacy receipt',
      ({ read }) => {
        read.receipt!.proof = null;
      },
    ],
    [
      'unknown projection',
      ({ proof }) => {
        proof.expectedCurrentProvenanceFingerprint = null;
      },
    ],
    [
      'legacy witness',
      ({ read }) => {
        read.memory!.memoryWriteWitness = null;
      },
    ],
    [
      'unattributed witness',
      ({ read, witness }) => {
        read.memory!.memoryWriteWitness = { ...witness, attribution: null };
      },
    ],
    [
      'malformed witness',
      ({ read, witness }) => {
        read.memory!.memoryWriteWitness = { ...witness, extra: true };
      },
    ],
    [
      'malformed receipt extension',
      ({ read, proof }) => {
        read.receipt!.proof = { ...proof, extra: true };
      },
    ],
    [
      'incomplete query',
      ({ current }) => {
        current.queries[0]!.complete = false;
      },
    ],
    [
      'saturated query',
      ({ current }) => {
        current.queries[0]!.limit = 1;
        current.queries[0]!.keys = ['member'];
      },
    ],
    [
      'incomplete eligibility evidence',
      ({ read }) => {
        read.eligibilityProof.complete = false;
      },
    ],
    [
      'unknown included native version',
      ({ current }) => {
        current.driver = 'firestore';
        current.dependencies[0]!.nativeVersion = null;
      },
    ],
  ];
  it.each(unknowns)('keeps %s unknown', (_name, mutate) => {
    const f = fixture();
    mutate(f);
    expect(classifyOwnerMemoryCurrentness(request, f.read)).toEqual({
      disposition: 'unknown',
      contentHash: null,
    });
  });

  it('returns no source data and allows a later read to become non-current', () => {
    const { read } = fixture();
    expect(classifyOwnerMemoryCurrentness(request, read)).toEqual({
      disposition: 'saved_current',
      contentHash: currentHash,
    });
    read.memory!.content = 'Synthetic later mutation';
    expect(classifyOwnerMemoryCurrentness(request, read)).toEqual({
      disposition: 'not_current',
      contentHash: null,
    });
  });
});
