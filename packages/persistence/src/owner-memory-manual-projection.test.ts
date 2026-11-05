import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { projectManualOwnerMemoryCorrection } from './owner-memory-manual-projection.js';
import { ownerMemoryProvenanceFingerprint } from './owner-memory-provenance.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const memoryId = '22222222-2222-4222-8222-222222222222';
const contactId = '33333333-3333-4333-8333-333333333333';
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const oldBody = 'Synthetic old manual note';
const newBody = 'Synthetic corrected manual note';
const oldHash = hash(oldBody);
const newHash = hash(newBody);
const missing = (bodyHash: string) => ({
  collection: 'memoryTombstones',
  key: `content:${bodyHash}`,
  state: 'missing',
  value: null,
  nativeVersion: null,
});
const contactNativeVersion = (driver: string) =>
  driver === 'postgres'
    ? { kind: 'postgres_timestamp', value: '2026-11-04T12:13:14.123456Z' }
    : { kind: 'firestore_timestamp', seconds: 1_798_688_000, nanoseconds: 123_456_789 };

function fixture(driver = 'postgres', contact = true) {
  return {
    version: 2,
    driver,
    ownerId,
    memoryId,
    observedAt: '2026-11-04T14:00:00.000Z',
    memory: {
      id: memoryId,
      agentId: ownerId,
      content: oldBody,
      contentHash: oldHash,
      category: 'knowledge',
      source: 'manual',
      sourceTaskId: null,
      subjectContactId: contact ? contactId : null,
      expiresAt: null,
      supersededById: null,
      quarantined: false,
      ownerCorrection: null,
    },
    oldHashTombstone: missing(oldHash),
    newHashTombstone: missing(newHash),
    subjectContact: contact
      ? {
          collection: 'contacts',
          key: contactId,
          state: 'present',
          value: {
            id: contactId,
            name: 'Synthetic contact',
            aliases: ['Synthetic alias'],
            trust: 'known',
            identityAuthority: null,
          },
          nativeVersion: contactNativeVersion(driver),
        }
      : null,
    lineageQuery: {
      collection: 'memoryImportLineage',
      scope: { memoryId },
      limit: 2,
      complete: true,
      keys: [],
    },
    replacement: { content: newBody, contentHash: newHash },
  };
}

function subject(input: ReturnType<typeof fixture>) {
  if (!input.subjectContact) throw new Error('Expected synthetic contact');
  return input.subjectContact;
}

describe('internal pure manual owner-memory projection', () => {
  for (const driver of ['postgres', 'firestore']) {
    for (const contact of [true, false]) {
      it(`projects distinct old/new hash evidence for ${driver}, contact=${contact}`, () => {
        const input = fixture(driver, contact);
        const before = structuredClone(input);
        expect(input.version).toBe(2);
        expect(Object.hasOwn(input, 'memoryNativeVersion')).toBe(false);
        const result = projectManualOwnerMemoryCorrection(input);
        expect(result).not.toBeNull();
        expect(result?.prewrite.contentHash).toBe(oldHash);
        expect(result?.current.contentHash).toBe(newHash);
        expect(result?.prewriteFingerprint).not.toBe(result?.expectedCurrentFingerprint);
        expect(result?.prewriteFingerprint).toBe(
          ownerMemoryProvenanceFingerprint(result?.prewrite),
        );
        expect(result?.expectedCurrentFingerprint).toBe(
          ownerMemoryProvenanceFingerprint(result?.current),
        );
        expect(
          result?.prewrite.dependencies.find((d) => d.collection === 'memoryTombstones'),
        ).toEqual(missing(oldHash));
        expect(
          result?.current.dependencies.find((d) => d.collection === 'memoryTombstones'),
        ).toEqual(missing(newHash));
        const prewriteContact = result?.prewrite.dependencies.find(
          (dependency) => dependency.collection === 'contacts',
        );
        const currentContact = result?.current.dependencies.find(
          (dependency) => dependency.collection === 'contacts',
        );
        if (contact) {
          expect(Object.keys(subject(input).value).sort()).toEqual([
            'aliases',
            'id',
            'identityAuthority',
            'name',
            'trust',
          ]);
          expect(prewriteContact?.value).toEqual(subject(input).value);
          expect(currentContact?.value).toEqual(subject(input).value);
          expect(Object.keys(prewriteContact?.value ?? {}).sort()).toEqual([
            'aliases',
            'id',
            'identityAuthority',
            'name',
            'trust',
          ]);
          expect(prewriteContact?.nativeVersion).toEqual(subject(input).nativeVersion);
          expect(currentContact?.nativeVersion).toEqual(subject(input).nativeVersion);
        } else {
          expect(prewriteContact).toBeUndefined();
          expect(currentContact).toBeUndefined();
        }
        expect(input).toEqual(before);
      });
    }
  }

  it('treats its own old-hash tombstone as post-write history, never as valid pre-write evidence', () => {
    const result = projectManualOwnerMemoryCorrection(fixture());
    expect(result).not.toBeNull();
    // Canonical NEW-hash provenance need not contain unrelated old-hash history.
    expect(result?.current.dependencies.some((d) => d.key === `content:${oldHash}`)).toBe(false);
    const alreadyTombstoned = fixture();
    Object.assign(alreadyTombstoned.oldHashTombstone, {
      state: 'present',
      value: { contentHash: oldHash, reason: 'previous deletion' },
      nativeVersion: contactNativeVersion('postgres'),
    });
    expect(projectManualOwnerMemoryCorrection(alreadyTombstoned)).toBeNull();
  });

  for (const driver of ['postgres', 'firestore']) {
    it.each([
      ['name', 'Synthetic renamed contact'] as [string, string | string[]],
      ['aliases', ['Synthetic changed alias']],
      ['trust', 'owner'],
      ['identityAuthority', 'owner'],
    ])(`binds contact %s values for ${driver} at the same ID/native version`, (field, changed) => {
      const input = fixture(driver);
      const original = projectManualOwnerMemoryCorrection(input);
      Object.assign(subject(input).value, { [field]: changed });
      const result = projectManualOwnerMemoryCorrection(input);
      expect(result).not.toBeNull();
      expect(result?.prewriteFingerprint).not.toBe(original?.prewriteFingerprint);
      expect(result?.expectedCurrentFingerprint).not.toBe(original?.expectedCurrentFingerprint);
    });
  }

  it.each(['postgres', 'firestore'])('preserves exact %s contact native revisions', (driver) => {
    const input = fixture(driver);
    const original = projectManualOwnerMemoryCorrection(input);
    subject(input).nativeVersion =
      driver === 'postgres'
        ? { kind: 'postgres_timestamp', value: '2026-11-04T12:13:14.123457Z' }
        : { kind: 'firestore_timestamp', seconds: 1_798_688_000, nanoseconds: 123_456_790 };
    const result = projectManualOwnerMemoryCorrection(input);
    expect(result?.prewriteFingerprint).not.toBe(original?.prewriteFingerprint);
    expect(result?.expectedCurrentFingerprint).not.toBe(original?.expectedCurrentFingerprint);
  });

  it.each(['postgres', 'firestore'])(
    'requires a known external %s contact native version',
    (driver) => {
      for (const value of [null, { kind: 'unknown_revision', value: 'opaque' }]) {
        const input = fixture(driver);
        (subject(input) as unknown as { nativeVersion: unknown }).nativeVersion = value;
        expect(projectManualOwnerMemoryCorrection(input)).toBeNull();
      }
    },
  );

  it('rejects wrong-driver and precision-losing contact native versions', () => {
    const postgresWrongDriver = fixture('postgres');
    subject(postgresWrongDriver).nativeVersion = {
      kind: 'firestore_timestamp',
      seconds: 1_798_688_000,
      nanoseconds: 123_456_789,
    };
    expect(projectManualOwnerMemoryCorrection(postgresWrongDriver)).toBeNull();

    const firestoreWrongDriver = fixture('firestore');
    subject(firestoreWrongDriver).nativeVersion = {
      kind: 'postgres_timestamp',
      value: '2026-11-04T12:13:14.123456Z',
    };
    expect(projectManualOwnerMemoryCorrection(firestoreWrongDriver)).toBeNull();

    for (const value of [
      { kind: 'postgres_timestamp', value: '2026-11-04T12:13:14.123Z' },
      { kind: 'postgres_timestamp', value: '2026-11-04T12:13:14.1234567Z' },
      { kind: 'firestore_timestamp', seconds: 1_798_688_000, nanoseconds: 1_000_000_000 },
      { kind: 'firestore_timestamp', seconds: 1_798_688_000, nanoseconds: 123.5 },
    ]) {
      const driver = value.kind === 'postgres_timestamp' ? 'postgres' : 'firestore';
      const input = fixture(driver);
      subject(input).nativeVersion = value;
      expect(projectManualOwnerMemoryCorrection(input)).toBeNull();
    }
  });

  it('rejects the legacy v1 manifest and v2 manifests with obsolete target-version/contact fields', () => {
    const legacyVersion = fixture();
    legacyVersion.version = 1;
    expect(projectManualOwnerMemoryCorrection(legacyVersion)).toBeNull();

    const obsoleteMemoryVersion = fixture();
    Object.assign(obsoleteMemoryVersion, {
      memoryNativeVersion: { kind: 'postgres_timestamp', value: '2026-11-04T12:13:14.123456Z' },
    });
    expect(projectManualOwnerMemoryCorrection(obsoleteMemoryVersion)).toBeNull();

    const legacyContactFields = fixture();
    Object.assign(subject(legacyContactFields).value, {
      emails: ['old-shape@example.invalid'],
      phones: [],
      relationship: 'old shape',
      notes: 'old shape',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-04T12:13:14.123456Z',
    });
    expect(projectManualOwnerMemoryCorrection(legacyContactFields)).toBeNull();
  });

  const negatives: Array<[string, (input: ReturnType<typeof fixture>) => void]> = [
    ['array-coerced category', (x) => Object.assign(x.memory, { category: ['knowledge'] })],
    ['array-coerced contact trust', (x) => Object.assign(subject(x).value, { trust: ['known'] })],
    [
      'preexisting new-hash tombstone',
      (x) => Object.assign(x.newHashTombstone, { state: 'present' }),
    ],
    [
      'old read reused for new hash',
      (x) => {
        x.newHashTombstone = x.oldHashTombstone;
      },
    ],
    [
      'new read reused for old hash',
      (x) => {
        x.oldHashTombstone = x.newHashTombstone;
      },
    ],
    [
      'missing old lookup',
      (x) => {
        Reflect.deleteProperty(x, 'oldHashTombstone');
      },
    ],
    [
      'missing independent new lookup',
      (x) => {
        Reflect.deleteProperty(x, 'newHashTombstone');
      },
    ],
    [
      'missing lineage query',
      (x) => {
        Reflect.deleteProperty(x, 'lineageQuery');
      },
    ],
    [
      'incomplete lineage',
      (x) => {
        x.lineageQuery.complete = false;
      },
    ],
    ['added lineage member', (x) => Object.assign(x.lineageQuery, { keys: ['new-lineage'] })],
    ['cap-saturated lineage', (x) => Object.assign(x.lineageQuery, { keys: ['a', 'b'] })],
    [
      'wrong lineage scope',
      (x) => {
        x.lineageQuery.scope.memoryId = ownerId;
      },
    ],
    ['extra lineage scope', (x) => Object.assign(x.lineageQuery.scope, { source: 'manual' })],
    [
      'wrong lineage collection',
      (x) => {
        x.lineageQuery.collection = 'importSources';
      },
    ],
    [
      'wrong query bound',
      (x) => {
        x.lineageQuery.limit = 3;
      },
    ],
    [
      'wrong owner',
      (x) => {
        x.ownerId = contactId;
      },
    ],
    [
      'wrong memory identity',
      (x) => {
        x.memory.id = contactId;
      },
    ],
    [
      'wrong old body',
      (x) => {
        x.memory.content += ' mismatch';
      },
    ],
    [
      'wrong old hash',
      (x) => {
        x.memory.contentHash = newHash;
      },
    ],
    [
      'wrong new body',
      (x) => {
        x.replacement.content += ' mismatch';
      },
    ],
    [
      'wrong new hash',
      (x) => {
        x.replacement.contentHash = oldHash;
      },
    ],
    [
      'unchanged body',
      (x) => {
        x.replacement = { content: oldBody, contentHash: oldHash };
      },
    ],
    [
      'unsupported graph source',
      (x) => {
        x.memory.source = 'knowledge-graph-owner';
      },
    ],
    [
      'unsupported extracted source',
      (x) => {
        x.memory.source = 'extraction';
      },
    ],
    [
      'unsupported imported source',
      (x) => {
        x.memory.source = 'synthetic-import';
      },
    ],
    ['source task present', (x) => Object.assign(x.memory, { sourceTaskId: contactId })],
    [
      'wrong category',
      (x) => {
        x.memory.category = 'preference';
      },
    ],
    [
      'quarantined lifecycle',
      (x) => {
        x.memory.quarantined = true;
      },
    ],
    ['superseded lifecycle', (x) => Object.assign(x.memory, { supersededById: contactId })],
    ['expired lifecycle', (x) => Object.assign(x.memory, { expiresAt: x.observedAt })],
    [
      'invalid observation instant',
      (x) => {
        x.observedAt = 'not-a-time';
      },
    ],
    [
      'missing subject',
      (x) => {
        x.subjectContact = null;
      },
    ],
    ['missing subject value', (x) => Object.assign(subject(x), { state: 'missing', value: null })],
    [
      'wrong subject key',
      (x) => {
        subject(x).key = memoryId;
      },
    ],
    [
      'wrong subject identity',
      (x) => {
        subject(x).value.id = memoryId;
      },
    ],
    [
      'missing contact aliases',
      (x) => {
        Reflect.deleteProperty(subject(x).value, 'aliases');
      },
    ],
    ['unmodeled contact field', (x) => Object.assign(subject(x).value, { futureField: true })],
    [
      'unknown manifest version',
      (x) => {
        x.version = 3;
      },
    ],
    [
      'unknown driver',
      (x) => {
        x.driver = 'future';
      },
    ],
    ['unmodeled self-write', (x) => Object.assign(x, { writesContact: true })],
    ['caller validity assertion', (x) => Object.assign(x, { proofValid: true })],
    [
      'caller post fingerprint',
      (x) => Object.assign(x, { expectedCurrentFingerprint: 'a'.repeat(64) }),
    ],
    [
      'malformed prior correction',
      (x) => Object.assign(x.memory, { ownerCorrection: { version: 2 } }),
    ],
  ];
  it.each(negatives)('returns no projection for %s', (_, mutate) => {
    const input = fixture();
    mutate(input);
    expect(projectManualOwnerMemoryCorrection(input)).toBeNull();
  });

  it('rejects sparse/accessor/symbol/prototype/cyclic data without invoking getters', () => {
    let calls = 0;
    const getter = fixture();
    Object.defineProperty(subject(getter).value, 'aliases', {
      get() {
        calls++;
        return [];
      },
    });
    expect(projectManualOwnerMemoryCorrection(getter)).toBeNull();
    expect(calls).toBe(0);
    const sparse = fixture();
    subject(sparse).value.aliases = Array(1);
    const symbol = fixture();
    Object.assign(symbol, { [Symbol('unmodeled')]: true });
    const inherited = Object.assign(Object.create({ injected: true }), fixture());
    const cycle = fixture();
    Object.assign(cycle, { cycle });
    for (const input of [sparse, symbol, inherited, cycle, null, []]) {
      expect(projectManualOwnerMemoryCorrection(input)).toBeNull();
    }
  });

  it('returns detached payloads and does not reuse later mutated input objects', () => {
    const input = fixture();
    const result = projectManualOwnerMemoryCorrection(input);
    const before = structuredClone(result);
    subject(input).value.aliases.push('Later mutation');
    input.newHashTombstone.key = 'changed';
    expect(result).toEqual(before);
  });
});
