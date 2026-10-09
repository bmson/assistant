import { describe, expect, it } from 'vitest';
import {
  embeddingModelId,
  embeddingSpaceIdentityKey,
  snapshotEmbeddingSpace,
  validateEmbedding,
} from './embedding.js';
import { validateSkillEmbedding, validateSkillEmbeddingSpace } from './skill-context.js';

describe('embedding model identity', () => {
  it('keeps OpenRouter vendor-qualified IDs and prefixes direct providers', () => {
    const base = { dimensions: 1536, revision: '1' };
    expect(
      embeddingModelId({ ...base, provider: 'openrouter', model: 'openai/text-embedding-3-small' }),
    ).toBe('openai/text-embedding-3-small');
    expect(embeddingModelId({ ...base, provider: 'vertex', model: 'gemini-embedding-001' })).toBe(
      'vertex/gemini-embedding-001',
    );
  });

  it('snapshots and freezes exact identity before the caller can mutate its input', () => {
    const input = { provider: 'vertex', model: 'embedding', dimensions: 768, revision: 'r1' };
    const captured = snapshotEmbeddingSpace(input);
    const capturedKey = embeddingSpaceIdentityKey(captured);
    input.provider = 'openrouter';
    input.model = 'other/model';
    input.dimensions = 1536;
    input.revision = 'r2';

    expect(captured).toEqual({
      provider: 'vertex',
      model: 'embedding',
      dimensions: 768,
      revision: 'r1',
    });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(embeddingSpaceIdentityKey(captured)).toBe(capturedKey);
  });

  it('rejects invalid values instead of freezing them as an identity', () => {
    expect(() =>
      snapshotEmbeddingSpace({ provider: 'test', model: 'unit', dimensions: 0, revision: 'r1' }),
    ).toThrow('Invalid vector or incompatible embedding space');
  });

  it('allows Firestore skills to follow bounded configured widths while preserving PostgreSQL width', () => {
    for (const dimensions of [384, 768, 1536, 2048]) {
      expect(() =>
        validateSkillEmbeddingSpace({
          provider: 'test',
          model: 'skills',
          dimensions,
          revision: 'r1',
        }),
      ).not.toThrow();
      expect(() =>
        validateSkillEmbedding(new Array(dimensions).fill(0.01), dimensions),
      ).not.toThrow();
    }
    expect(() => validateSkillEmbedding(new Array(768).fill(0.01))).toThrow(
      'Invalid learned-skill embedding',
    );
    for (const dimensions of [0, 2049])
      expect(() =>
        validateSkillEmbeddingSpace({
          provider: 'test',
          model: 'skills',
          dimensions,
          revision: 'r1',
        }),
      ).toThrow('Invalid learned-skill embedding space');
  });

  it('rejects sparse vectors at the shared memory and skill storage boundary', () => {
    const space = { provider: 'test', model: 'unit', dimensions: 768, revision: 'r1' };
    const sparse = new Array<number>(768);
    sparse[0] = 1;
    expect(() => validateEmbedding(space, sparse)).toThrow('Invalid vector');
    expect(() => validateSkillEmbedding(sparse, 768)).toThrow('Invalid learned-skill embedding');
    const dense = new Array<number>(768).fill(0);
    dense[0] = 1;
    expect(() => validateEmbedding(space, dense)).not.toThrow();
    expect(() => validateSkillEmbedding(dense, 768)).not.toThrow();
  });

  it.each(['provider', 'model', 'revision'] as const)(
    'rejects non-string and blank %s fields at a runtime identity boundary',
    (field) => {
      const space = { provider: 'test', model: 'unit', dimensions: 768, revision: 'r1' };
      for (const invalid of [1, {}, true, '   ']) {
        const runtimeSpace = { ...space, [field]: invalid } as unknown as typeof space;
        expect(() => snapshotEmbeddingSpace(runtimeSpace)).toThrow('Invalid vector');
      }
    },
  );
});
