import { describe, expect, it } from 'vitest';
import {
  type OwnerMemoryProvenanceJsonValue,
  type OwnerMemoryProvenanceNativeVersion,
  type OwnerMemoryProvenancePayload,
  ownerMemoryProvenanceFingerprint,
  parseOwnerMemoryProvenancePayload,
} from './owner-memory-provenance.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const memoryId = '22222222-2222-4222-8222-222222222222';
const contentHash = 'a'.repeat(64);

function dependency(
  collection: OwnerMemoryProvenancePayload['dependencies'][number]['collection'],
  key: string,
  value: OwnerMemoryProvenanceJsonValue | null,
  state: 'present' | 'missing' = 'present',
  nativeVersion: OwnerMemoryProvenanceNativeVersion = null,
) {
  return {
    collection,
    key,
    state,
    value,
    nativeVersion,
  };
}

function payload(): OwnerMemoryProvenancePayload {
  return {
    version: 1,
    driver: 'postgres',
    ownerId,
    memoryId,
    contentHash,
    targetSource: {
      source: 'owner',
      sourceTaskId: null,
      subjectContactId: '33333333-3333-4333-8333-333333333333',
    },
    dependencies: [
      dependency('importSources', 'import-source:1', { status: 'active', sourceName: 'inbox' }),
      dependency('memoryTombstones', `content:${contentHash}`, { contentHash, state: 'active' }),
    ],
    queries: [
      {
        collection: 'importSources',
        scope: { ownerId, kinds: ['email', 'task'] },
        limit: 4,
        complete: true,
        keys: ['source:2', 'source:1'],
      },
      {
        collection: 'tasks',
        scope: { ownerId, status: 'open' },
        limit: 4,
        complete: true,
        keys: ['task:7'],
      },
    ],
  };
}

describe('owner-memory provenance fingerprint codec', () => {
  it('canonicalizes object keys, dependency/query order, and query physical keys', () => {
    const original = payload();
    const reordered = payload();
    reordered.dependencies.reverse();
    reordered.queries.reverse();
    reordered.queries[1] = {
      ...reordered.queries[1]!,
      scope: { kinds: ['email', 'task'], ownerId },
      keys: ['source:1', 'source:2'],
    };

    expect(ownerMemoryProvenanceFingerprint(original)).toMatch(/^[0-9a-f]{64}$/);
    expect(ownerMemoryProvenanceFingerprint(reordered)).toBe(
      ownerMemoryProvenanceFingerprint(original),
    );
    expect(parseOwnerMemoryProvenancePayload(reordered).dependencies.map(({ key }) => key)).toEqual(
      ['import-source:1', `content:${contentHash}`],
    );
  });

  it('changes the fingerprint for external value/key/presence and resulting-hash tombstone changes', () => {
    const original = payload();
    const originalFingerprint = ownerMemoryProvenanceFingerprint(original);
    expect(originalFingerprint).not.toBeNull();

    const changedValue = payload();
    changedValue.dependencies[0] = dependency('importSources', 'import-source:1', {
      status: 'inactive',
      sourceName: 'inbox',
    });
    expect(ownerMemoryProvenanceFingerprint(changedValue)).not.toBe(originalFingerprint);

    const changedKey = payload();
    changedKey.dependencies[0] = dependency('importSources', 'import-source:changed', {
      status: 'active',
      sourceName: 'inbox',
    });
    expect(ownerMemoryProvenanceFingerprint(changedKey)).not.toBe(originalFingerprint);

    const missing = payload();
    missing.dependencies[0] = dependency('importSources', 'import-source:1', null, 'missing');
    expect(ownerMemoryProvenanceFingerprint(missing)).not.toBe(originalFingerprint);

    const changedTombstone = payload();
    changedTombstone.dependencies[1] = dependency('memoryTombstones', `content:${contentHash}`, {
      contentHash: 'b'.repeat(64),
      state: 'active',
    });
    expect(ownerMemoryProvenanceFingerprint(changedTombstone)).not.toBe(originalFingerprint);
  });

  it('returns no fingerprint for incomplete queries or a result at its cap', () => {
    const incomplete = payload();
    incomplete.queries[0]!.complete = false;
    expect(ownerMemoryProvenanceFingerprint(incomplete)).toBeNull();

    const saturated = payload();
    saturated.queries[0]!.limit = saturated.queries[0]!.keys.length;
    expect(ownerMemoryProvenanceFingerprint(saturated)).toBeNull();
  });

  it('preserves exact PostgreSQL microseconds and Firestore nanoseconds', () => {
    const postgres = payload();
    postgres.dependencies[0]!.nativeVersion = {
      kind: 'postgres_timestamp',
      value: '2026-11-04T12:13:14.123456Z',
    };
    const postgresChanged = payload();
    postgresChanged.dependencies[0]!.nativeVersion = {
      kind: 'postgres_timestamp',
      value: '2026-11-04T12:13:14.123457Z',
    };
    expect(ownerMemoryProvenanceFingerprint(postgres)).not.toBe(
      ownerMemoryProvenanceFingerprint(postgresChanged),
    );

    const firestore: OwnerMemoryProvenancePayload = {
      ...payload(),
      driver: 'firestore',
    };
    firestore.dependencies.forEach((item, index) => {
      item.nativeVersion = {
        kind: 'firestore_timestamp',
        seconds: 1_798_688_000,
        nanoseconds: 123_456_789 + index,
      };
    });
    const firestoreChanged: OwnerMemoryProvenancePayload = {
      ...firestore,
      dependencies: firestore.dependencies.map((item) => ({ ...item })),
    };
    firestoreChanged.dependencies[0]!.nativeVersion = {
      kind: 'firestore_timestamp',
      seconds: 1_798_688_000,
      nanoseconds: 123_456_790,
    };
    expect(ownerMemoryProvenanceFingerprint(firestore)).not.toBe(
      ownerMemoryProvenanceFingerprint(firestoreChanged),
    );
    expect(
      parseOwnerMemoryProvenancePayload(firestore).dependencies[0]?.nativeVersion,
    ).toMatchObject({ nanoseconds: 123_456_789 });
  });

  it('keeps canonical timestamps stable across parse round-trips and rejects aliases', () => {
    const canonical = payload();
    canonical.dependencies[0]!.nativeVersion = {
      kind: 'postgres_timestamp',
      value: '2024-02-29T12:34:56.000001Z',
    };
    const parsed = parseOwnerMemoryProvenancePayload(canonical);
    expect(parsed.dependencies[0]?.nativeVersion).toEqual(canonical.dependencies[0]?.nativeVersion);
    expect(ownerMemoryProvenanceFingerprint(parsed)).toBe(
      ownerMemoryProvenanceFingerprint(canonical),
    );

    for (const timestamp of [
      '2026-11-04T12:13:14.123456+00:00',
      '2026-11-04T12:13:14.123456-05:00',
      '2026-11-04T12:13:14Z',
      '2026-11-04T12:13:14.123Z',
      '2026-11-04T12:13:14.1234560Z',
      '2026-02-30T12:13:14.123456Z',
      '2026-02-29T12:13:14.123456Z',
    ]) {
      const aliased = payload();
      aliased.dependencies[0]!.nativeVersion = { kind: 'postgres_timestamp', value: timestamp };
      expect(() => ownerMemoryProvenanceFingerprint(aliased), timestamp).toThrow();
    }
  });

  it('requires native update timestamps on present Firestore dependencies but allows explicit missing dependencies', () => {
    const firestore: OwnerMemoryProvenancePayload = {
      ...payload(),
      driver: 'firestore',
    };
    firestore.dependencies = firestore.dependencies.map((item, index) => ({
      ...item,
      nativeVersion: {
        kind: 'firestore_timestamp' as const,
        seconds: 1_798_688_000,
        nanoseconds: 987_654_321 - index,
      },
    }));
    expect(ownerMemoryProvenanceFingerprint(firestore)).not.toBeNull();

    const missingTimestamp: OwnerMemoryProvenancePayload = {
      ...firestore,
      dependencies: firestore.dependencies.map((item, index) =>
        index === 0 ? { ...item, nativeVersion: null } : item,
      ),
    };
    expect(() => ownerMemoryProvenanceFingerprint(missingTimestamp)).toThrow(
      'Present Firestore dependency requires a native update timestamp',
    );

    const missingDependency: OwnerMemoryProvenancePayload = {
      ...firestore,
      dependencies: [
        {
          collection: 'importSources',
          key: 'import-source:absent',
          state: 'missing',
          value: null,
          nativeVersion: null,
        },
      ],
    };
    expect(ownerMemoryProvenanceFingerprint(missingDependency)).not.toBeNull();
    expect(parseOwnerMemoryProvenancePayload(missingDependency).dependencies[0]).toMatchObject({
      state: 'missing',
      value: null,
      nativeVersion: null,
    });
  });

  it('rejects malformed payloads, unknown keys/classes, duplicate keys, and non-finite JSON', () => {
    const unknownTopKey = { ...payload(), extra: true };
    const unknownDependencyKey = payload();
    unknownDependencyKey.dependencies[0] = {
      ...unknownDependencyKey.dependencies[0]!,
      extra: true,
    } as OwnerMemoryProvenancePayload['dependencies'][number];
    const unknownCollection = payload();
    unknownCollection.dependencies[0] = {
      ...unknownCollection.dependencies[0]!,
      collection: 'unknown',
    } as unknown as OwnerMemoryProvenancePayload['dependencies'][number];
    const duplicateDependency = payload();
    duplicateDependency.dependencies.push({ ...duplicateDependency.dependencies[0]! });
    const duplicateQueryKey = payload();
    duplicateQueryKey.queries[0]!.keys = ['same', 'same'];
    const dateValue = payload();
    dateValue.dependencies[0] = dependency('importSources', 'import-source:1', {
      observedAt: new Date(),
    } as unknown as OwnerMemoryProvenanceJsonValue);
    const classValue = payload();
    classValue.queries[0]!.scope = new (class Scope {
      ownerId = ownerId;
    })() as unknown as OwnerMemoryProvenancePayload['queries'][number]['scope'];
    const nonFiniteValue = payload();
    nonFiniteValue.dependencies[0] = dependency('importSources', 'import-source:1', {
      score: Number.NaN,
    } as unknown as OwnerMemoryProvenanceJsonValue);
    const malformedMissing = payload();
    malformedMissing.dependencies[0] = dependency(
      'importSources',
      'import-source:1',
      { incorrectlyPresent: true },
      'missing',
    );
    const invalidNativeVersion = payload();
    invalidNativeVersion.dependencies[0]!.nativeVersion = {
      kind: 'postgres_timestamp',
      value: '2026-02-30T12:13:14.123456Z',
    };

    for (const candidate of [
      unknownTopKey,
      unknownDependencyKey,
      unknownCollection,
      duplicateDependency,
      duplicateQueryKey,
      dateValue,
      classValue,
      nonFiniteValue,
      malformedMissing,
      invalidNativeVersion,
      { ...payload(), version: 2 },
    ]) {
      expect(() => ownerMemoryProvenanceFingerprint(candidate)).toThrow();
    }
  });
});
