import { describe, expect, it } from 'vitest';
import { decodeMemoryRecord } from './memory-record.js';

describe('decodeMemoryRecord', () => {
  it('normalizes absent legacy identity to unknown without stamping a current space', () => {
    expect(decodeMemoryRecord({ id: 'legacy', agentId: 'owner' })).toMatchObject({
      id: 'legacy',
      embeddingSpaceKey: null,
    });
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
