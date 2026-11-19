import type { ActivityTaskRecord, TaskActivityRepository } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { activityProgress } from './presentation.js';
import { getActivityStatusWithRepository, listActivityWithRepository } from './queries.js';

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
      async getStatus() {
        return { task, hasPendingApproval: false };
      },
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

  it('projects only live Activity fields as a task advances', async () => {
    const base = {
      id: 'task-live',
      agentId: 'owner-1',
      conversationId: null,
      externalEventId: null,
      type: 'adhoc',
      status: 'pending',
      title: 'Keep the original title',
      progress: 'Queued',
      trust: 'owner',
      spentUsd: '0',
      budgetUsdLimit: '1',
      updatedAt: new Date('2026-10-11T12:00:00Z'),
      archivedAt: null,
      autonomyGrant: null,
      trigger: { source: 'chat', payload: {} },
    } satisfies ActivityTaskRecord;
    let status = 'pending';
    const repository: TaskActivityRepository = {
      kind: 'task-activity-repository',
      async getStatus() {
        return {
          task: { ...base, status, progress: status === 'done' ? 'Finished' : status },
          hasPendingApproval: status === 'waiting_approval',
        };
      },
      async list() {
        return { tasks: [], archivedCount: 0, pendingApprovalTaskIds: [] };
      },
    };

    for (const next of ['pending', 'running', 'done']) {
      status = next;
      const projection = await getActivityStatusWithRepository(repository, 'owner-1', 'task-live');
      expect(projection?.status).toBe(next);
      expect(projection?.progress).toBe(next === 'done' ? 'Finished' : next);
      expect(projection).not.toHaveProperty('title');
      expect(projection).not.toHaveProperty('conversationId');
    }
  });
  it('includes a parked spending operation in the default activity list without checkpoint contents', async () => {
    const task = {
      id: 'task',
      agentId: 'owner',
      conversationId: null,
      externalEventId: null,
      type: 'chat_turn',
      status: 'waiting_estimated_cost',
      title: 'Request',
      progress: '',
      trust: 'owner',
      spentUsd: '0',
      budgetUsdLimit: '1',
      updatedAt: new Date(),
      archivedAt: null,
      autonomyGrant: null,
      trigger: {},
      state: {
        privateDraft: 'private-data',
        estimatedCostApproval: {
          operationId: 'op-123',
          status: 'pending',
          bindingDigest: 'private-binding',
        },
      },
    } satisfies ActivityTaskRecord;
    let requestedStatuses: string[] | undefined;
    const repository: TaskActivityRepository = {
      kind: 'task-activity-repository',
      async getStatus() {
        return { task, hasPendingApproval: false };
      },
      async list(_owner, input) {
        requestedStatuses = input.statuses;
        return { tasks: [task], archivedCount: 0, pendingApprovalTaskIds: [] };
      },
    };
    const result = await listActivityWithRepository(repository, 'owner', {
      archived: false,
      filter: 'needs-you',
    });
    expect(requestedStatuses).toContain('waiting_estimated_cost');
    expect(result.items[0]).toMatchObject({
      status: 'waiting_estimated_cost',
      estimatedCostOperationId: 'op-123',
    });
    expect(JSON.stringify(result)).not.toContain('private-data');
    expect(JSON.stringify(result)).not.toContain('private-binding');
    expect(await getActivityStatusWithRepository(repository, 'owner', 'task')).toMatchObject({
      estimatedCostOperationId: 'op-123',
    });
  });
});
