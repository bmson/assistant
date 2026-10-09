import {
  compareTimelineRows,
  decodeTaskTimelineCursor,
  type TaskActivityDetail,
  type TaskActivityDetailRepository,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { getTaskDetailWithRepository } from './tasks/queries.js';

const taskId = '11111111-1111-4111-8111-111111111111';
const timestamp = new Date('2026-09-22T12:00:00Z');

function detail(overrides: Partial<TaskActivityDetail> = {}): TaskActivityDetail {
  return {
    timezone: 'UTC',
    task: {
      id: taskId,
      type: 'root',
      status: 'waiting_approval',
      title: 'Review a document',
      trust: 'owner',
      spentUsd: '0.10',
      budgetUsdLimit: '2.00',
      updatedAt: timestamp,
      deadline: null,
      nextAction: 'Ask owner',
      progress: 'Waiting',
      progressPercent: 50,
      plan: { summary: 'Plan' },
      state: {
        requestChecklist: {
          version: 1,
          request: 'Review a document',
          items: [
            {
              id: 'review',
              label: 'Read the document',
              kind: 'lookup',
              targetTerms: [],
              status: 'completed',
              evidence: [],
            },
          ],
        },
      },
      archivedAt: null,
      autonomyGrant: null,
    },
    toolCalls: [
      {
        id: 'tool-1',
        createdAt: timestamp,
        finishedAt: timestamp,
        toolName: 'documents.read',
        step: 1,
        status: 'succeeded',
        decision: { riskTier: 'low', policyId: 'owner-read' },
        args: { path: 'private.pdf' },
        result: { content: 'x'.repeat(5000) },
        error: null,
      },
    ],
    modelCalls: [],
    approvals: [],
    messages: [{ id: 'message-1', createdAt: timestamp, role: 'assistant', text: 'x'.repeat(250) }],
    files: [{ id: 'file-1', workspacePath: 'documents/private.pdf', bytes: 100 }],
    actions: [
      {
        id: 'tool-1',
        createdAt: timestamp,
        finishedAt: timestamp,
        toolName: 'documents.read',
        status: 'succeeded',
        result: { content: 'x'.repeat(1000) },
        error: null,
      },
    ],
    hasPendingApproval: false,
    ...overrides,
  };
}

describe('portable Activity task detail', () => {
  it('forwards the owner and bounded page request, clips recorded values, and preserves timeline flags', async () => {
    const getDetail = vi.fn().mockResolvedValue(detail());
    const result = await getTaskDetailWithRepository({ getDetail }, 'owner-agent', taskId, {
      pageSize: 700,
      before: timestamp,
    });

    expect(getDetail).toHaveBeenCalledWith('owner-agent', taskId, {
      pageSize: 500,
      before: timestamp,
    });
    expect(result).toMatchObject({
      task: {
        id: taskId,
        plan: { text: '{\n  "summary": "Plan"\n}', truncated: false },
        checklist: { items: [{ id: 'review' }] },
      },
      toolCalls: [{ riskTier: 'low', policyId: 'owner-read', result: { truncated: true } }],
      messages: [{ text: `${'x'.repeat(200)}…` }],
      actions: [{ completed: true, resultPreview: { truncated: true } }],
      hasMoreTimeline: false,
      stuckWaiting: true,
    });
  });

  it('uses one total-order cursor across mixed equal-time streams', async () => {
    const all = detail({
      toolCalls: Array.from({ length: 101 }, (_, index) => ({
        ...(detail().toolCalls[0] as TaskActivityDetail['toolCalls'][number]),
        id: `tool-${String(index).padStart(3, '0')}`,
      })),
      modelCalls: [
        {
          id: 'model-1',
          createdAt: timestamp,
          role: 'planner',
          model: 'test',
          costUsd: '0',
          latencyMs: 0,
        },
      ],
      approvals: [
        {
          id: 'approval-1',
          requestedAt: timestamp,
          status: 'approved',
          summary: 'test',
          shortCode: 'one',
          resolvedAt: timestamp,
          resolvedVia: 'test',
        },
      ],
    });
    const getDetail = vi.fn(
      async (
        _owner: string,
        _task: string,
        input: Parameters<TaskActivityDetailRepository['getDetail']>[2],
      ) => {
        const before = input.cursor;
        const filter = <T extends { id: string }>(
          rows: T[],
          kind: 'tool' | 'model' | 'approval' | 'message',
        ) =>
          rows
            .filter(
              (r) =>
                !before ||
                compareTimelineRows(
                  { kind, id: r.id, at: '2026-09-22T12:00:00.000000000Z' },
                  before,
                ) > 0,
            )
            .sort((a, b) => b.id.localeCompare(a.id))
            .slice(0, input.pageSize + 1);
        return {
          ...all,
          toolCalls: filter(all.toolCalls, 'tool'),
          modelCalls: filter(all.modelCalls, 'model'),
          approvals: filter(all.approvals, 'approval'),
          messages: filter(all.messages, 'message'),
        };
      },
    );
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let pages = 0; pages < 20; pages++) {
      const page = await getTaskDetailWithRepository({ getDetail }, 'owner-agent', taskId, {
        pageSize: 10,
        cursor,
      });
      if (!page) throw new Error('Missing timeline page');
      const ids = [...page.toolCalls, ...page.modelCalls, ...page.approvals, ...page.messages].map(
        (r) => r.id,
      );
      expect(ids.length).toBeLessThanOrEqual(10);
      for (const id of ids) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
      if (!page.hasMoreTimeline) break;
      if (!page.nextTimelineCursor) throw new Error('Missing timeline cursor');
      cursor = page.nextTimelineCursor;
      expect(decodeTaskTimelineCursor(cursor).at).toBe('2026-09-22T12:00:00.000000000Z');
    }
    expect(seen.size).toBe(104);
  });

  it('returns null for a missing or non-owner task', async () => {
    const getDetail = vi.fn().mockResolvedValue(null);
    await expect(
      getTaskDetailWithRepository({ getDetail }, 'owner-agent', taskId),
    ).resolves.toBeNull();
  });
});
