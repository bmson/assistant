import {
  embeddingSpaceIdentityKey,
  type LearnedSkill,
  type SkillContextRepository,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import type { ModelRouter } from '../model-router/router.js';
import { bumpSkillUse, recallSkills, recordSkillOutcome, renderSkillsBlock } from './skills.js';

const SPACE = {
  provider: 'synthetic',
  model: 'skill-wrapper-fixture',
  dimensions: 1536,
  revision: '1',
};
const embedding = [1, ...new Array(1535).fill(0)];
const learned: LearnedSkill = {
  id: 'skill-id',
  name: 'check the receipt',
  createdAt: new Date('2026-09-10T12:00:00.000Z'),
  updatedAt: new Date('2026-09-10T12:00:00.000Z'),
  agentId: 'owner-id',
  embeddingSpaceKey: embeddingSpaceIdentityKey(SPACE),
  sourceTaskId: null,
  preconditions: 'after placing an order',
  steps: 'verify the final total',
  gotchas: 'tax can change at checkout',
  originTrust: 'assistant',
  ownerAuthored: false,
  useCount: 0,
  successCount: 0,
  failureCount: 0,
  lastVerifiedAt: null,
  deprecated: false,
};

function harness() {
  const recall = vi.fn(async () => [{ skill: learned, similarity: 0.93 }]);
  const bumpUse = vi.fn(async () => undefined);
  const recordOutcome = vi.fn(async () => undefined);
  const repository: SkillContextRepository = {
    kind: 'skill-context-repository',
    recall,
    bumpUse,
    recordOutcome,
  };
  const embed = vi.fn(async () => [embedding]);
  const router = { embeddingSpace: async () => SPACE, embed } as unknown as ModelRouter;
  return { repository, recall, bumpUse, recordOutcome, router, embed };
}

describe('portable learned-skill wrappers', () => {
  it('embeds in core, retrieves through the adapter, and renders advice', async () => {
    const { repository, recall, router, embed } = harness();
    const found = await recallSkills(repository, router, 'owner-id', '  verify this order  ', {
      taskId: 'task-id',
    });

    expect(embed).toHaveBeenCalledWith(['verify this order'], {
      taskId: 'task-id',
      expectedSpace: SPACE,
    });
    expect(recall).toHaveBeenCalledWith({
      agentId: 'owner-id',
      embedding,
      embeddingSpaceKey: embeddingSpaceIdentityKey(SPACE),
      limit: 4,
      minSimilarity: 0.72,
    });
    expect(found).toEqual([learned]);
    expect(renderSkillsBlock(found)).toContain('tax can change at checkout');
  });

  it('requires owner scope for portable use and outcome updates', async () => {
    const { repository, bumpUse, recordOutcome } = harness();
    await bumpSkillUse(repository, ['skill-id'], 'owner-id');
    await recordSkillOutcome(repository, 'skill-id', false, 'owner-id');
    expect(bumpUse).toHaveBeenCalledWith({ agentId: 'owner-id', ids: ['skill-id'] });
    expect(recordOutcome).toHaveBeenCalledWith({
      agentId: 'owner-id',
      id: 'skill-id',
      success: false,
    });
    await expect(bumpSkillUse(repository, ['skill-id'])).rejects.toThrow('owner agent ID');
    await expect(recordSkillOutcome(repository, 'skill-id', true)).rejects.toThrow(
      'owner agent ID',
    );
  });

  it('rejects an incompatible embedding before querying persistence', async () => {
    const { repository, recall } = harness();
    const router = {
      embeddingSpace: async () => SPACE,
      embed: async () => [[1, 0, 0]],
    } as unknown as ModelRouter;
    await expect(recallSkills(repository, router, 'owner-id', 'query')).rejects.toThrow(
      'Invalid vector or incompatible embedding space',
    );
    expect(recall).not.toHaveBeenCalled();
  });
});
