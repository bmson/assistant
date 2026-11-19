import { describe, expect, it } from 'vitest';
import { decodeMemoryRecord } from './memory-record.js';

describe('decodeMemoryRecord', () => {
  it('normalizes absent legacy identity to unknown without stamping a current space', () => {
    expect(decodeMemoryRecord({ id: 'legacy', agentId: 'owner' })).toMatchObject({
      id: 'legacy',
      embeddingSpaceKey: null,
    });
  });

  it('normalizes an absent or explicit-null write witness to unknown without mutating input', () => {
    const absent = { id: 'legacy-witness-absent', agentId: 'owner' };
    const explicitNull = {
      id: 'legacy-witness-null',
      agentId: 'owner',
      memoryWriteWitness: null,
    };
    const absentBefore = structuredClone(absent);
    const explicitNullBefore = structuredClone(explicitNull);

    expect(decodeMemoryRecord(absent).memoryWriteWitness).toBeNull();
    expect(decodeMemoryRecord(explicitNull).memoryWriteWitness).toBeNull();
    expect(absent).toEqual(absentBefore);
    expect(explicitNull).toEqual(explicitNullBefore);
    expect(Object.hasOwn(absent, 'memoryWriteWitness')).toBe(false);
    expect(Object.hasOwn(explicitNull, 'memoryWriteWitness')).toBe(true);
  });

  it('preserves a non-null write witness payload and leaves the Firestore source unchanged', () => {
    const witness = {
      version: 1 as const,
      writeVersion: '7f8bc5ce-8806-4e03-936c-30eedc5d3228',
      contentHash: 'a'.repeat(64),
      attribution: null,
    };
    const source = {
      id: 'witness-present',
      agentId: 'owner',
      embeddingSpace: 'b'.repeat(64),
      memoryWriteWitness: witness,
    };
    const before = structuredClone(source);

    const decoded = decodeMemoryRecord(source);

    expect(decoded.memoryWriteWitness).toEqual(witness);
    expect(decoded.embeddingSpaceKey).toBe(source.embeddingSpace);
    expect(decoded).not.toHaveProperty('embeddingSpace');
    expect(source).toEqual(before);
    expect(Object.hasOwn(source, 'embeddingSpaceKey')).toBe(false);
  });

  it('maps the explicit Firestore alias when the typed field is null or missing', () => {
    const key = 'a'.repeat(64);
    expect(
      decodeMemoryRecord({ id: 'null-key', embeddingSpaceKey: null, embeddingSpace: key })
        .embeddingSpaceKey,
    ).toBe(key);
    expect(decodeMemoryRecord({ id: 'missing-key', embeddingSpace: key }).embeddingSpaceKey).toBe(
      key,
    );
  });

  it('accepts matching identities and rejects malformed or disagreeing metadata', () => {
    const key = 'a'.repeat(64);
    const matching = decodeMemoryRecord({
      id: 'matching',
      embeddingSpaceKey: key,
      embeddingSpace: key,
    });
    expect(matching.embeddingSpaceKey).toBe(key);
    expect(matching).not.toHaveProperty('embeddingSpace');
    expect(() => decodeMemoryRecord({ id: 'bad-key', embeddingSpaceKey: 'bad' })).toThrow(
      'Memory embedding space identity is malformed or inconsistent',
    );
    expect(() => decodeMemoryRecord({ id: 'bad-alias', embeddingSpace: 'bad' })).toThrow(
      'Memory embedding space identity is malformed or inconsistent',
    );
    expect(() =>
      decodeMemoryRecord({
        id: 'disagreeing',
        embeddingSpaceKey: key,
        embeddingSpace: 'b'.repeat(64),
      }),
    ).toThrow('Memory embedding space identity is malformed or inconsistent');
  });
});
