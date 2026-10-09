import { embeddingSpaceIdentityKey, type SkillContextRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import type { ModelRouter } from '../model-router/router.js';
import { recallSkills } from './skills.js';

describe('configured skill embedding width', () => {
  it('forwards a validated 768-wide query to the configured Firestore repository', async () => {
    const space = {
      provider: 'synthetic',
      model: 'skill-context-width',
      dimensions: 768,
      revision: 'r1',
    };
    const vector = new Array(768).fill(0.01);
    const recall = vi.fn(async () => []);
    const repository = {
      kind: 'skill-context-repository' as const,
      recall,
      bumpUse: vi.fn(async () => undefined),
      recordOutcome: vi.fn(async () => undefined),
    } satisfies SkillContextRepository;
    const router = {
      embeddingSpace: vi.fn(async () => space),
      embed: vi.fn(async () => [vector]),
    } as unknown as ModelRouter;

    await expect(recallSkills(repository, router, 'owner', 'relevant procedure')).resolves.toEqual(
      [],
    );
    expect(recall).toHaveBeenCalledWith({
      agentId: 'owner',
      embedding: vector,
      embeddingSpaceKey: embeddingSpaceIdentityKey(space),
      limit: 4,
      minSimilarity: 0.72,
    });
  });
});
