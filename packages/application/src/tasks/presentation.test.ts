import type { ActivityTaskRecord, TaskActivityRepository } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { activityProgress } from './presentation.js';
import { listActivityWithRepository } from './queries.js';

describe('owner-facing Activity progress', () => {
  it('replaces persisted provider diagnostics without exposing provider URLs', () => {
    const progress =
      'attempt 4 failed: AI_APICallError: model unavailable https://provider.example/private';

    expect(activityProgress('needs_attention', progress)).toBe('A service request failed.');
  });

  it('uses neutral copy for cancelled tasks even when their last progress was a provider error', () => {
    expect(activityProgress('cancelled', 'AI_APICallError https://provider.example/private')).toBe(
      'This task was cancelled.',
    );
  });

  it('preserves ordinary progress and useful links', () => {
    const progress = 'The draft is ready: https://docs.example.test/draft';
    expect(activityProgress('done', progress)).toBe(progress);
  });

  it('sanitizes historical progress in the shared Activity projection', async () => {
    const task = {
      id: 'task-1',
      agentId: 'owner-1',
      conversationId: null,
      externalEventId: null,
      type: 'adhoc',
      status: 'needs_attention',
      title: 'Provider retry',
      progress: 'AI_APICallError https://provider.example/private',
      trust: 'owner',
      spentUsd: '0',
      budgetUsdLimit: '1',
      updatedAt: new Date('2026-10-11T12:00:00Z'),
      archivedAt: null,
      autonomyGrant: null,
      trigger: { source: 'chat', payload: {} },
    } satisfies ActivityTaskRecord;
    const repository: TaskActivityRepository = {
      kind: 'task-activity-repository',
      async list() {
        return { tasks: [task], archivedCount: 0, pendingApprovalTaskIds: [] };
      },
    };

    const result = await listActivityWithRepository(repository, 'owner-1', {
      archived: false,
      filter: 'all',
    });

    expect(result.items[0]?.progress).toBe('A service request failed.');
  });
});
