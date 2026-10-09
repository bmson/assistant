import type {
  Records,
  ScheduleOccurrence,
  ScheduleRecord,
  ScheduleRepository,
  TaskCreateResult,
} from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { runScheduleBatch } from './schedule-runner.js';

const NOW = new Date('2025-06-01T12:00:00.000Z');
const DUE = new Date('2025-06-01T11:59:00.000Z');

function schedule(patch: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: patch.id ?? 'schedule-1',
    agentId: patch.agentId ?? '00000000-0000-4000-8000-000000000001',
    name: patch.name ?? 'reminder:contract',
    cron: patch.cron ?? '* * * * *',
    taskTemplate:
      patch.taskTemplate === undefined
        ? { type: 'scheduled', instruction: 'contract' }
        : patch.taskTemplate,
    enabled: patch.enabled ?? true,
    createdAt: patch.createdAt ?? new Date('2025-06-01T00:00:00.000Z'),
    updatedAt: patch.updatedAt ?? new Date('2025-06-01T00:00:00.000Z'),
    seedTemplateKey: null,
    seedTemplateRevision: null,
    seedDefinition: null,
    seedReviewRequired: false,
    lastRunAt: patch.lastRunAt ?? null,
    nextRunAt: patch.nextRunAt === undefined ? DUE : patch.nextRunAt,
  };
}

function taskResult(id: string, agentId: string, created: boolean): TaskCreateResult {
  return {
    created,
    task: {
      id,
      agentId,
      queueGeneration: 0,
    } as Records['tasks'],
  };
}

function repository(
  rows: ScheduleRecord[],
  commit: (
    input: ScheduleOccurrence,
  ) => Promise<Awaited<ReturnType<ScheduleRepository['commitOccurrence']>>>,
) {
  const commits: ScheduleOccurrence[] = [];
  const repo: ScheduleRepository = {
    kind: 'schedule-repository',
    listPage: async () => ({ items: [], nextCursor: null }),
    setOwnerEnabled: async () => true,
    ensure: async (input) => schedule(input),
    getByName: async () => null,
    listUninitialized: async () => [],
    listDue: async () => rows.filter((row) => row.enabled && row.nextRunAt),
    initialize: async () => true,
    commitOccurrence: async (input) => {
      commits.push(input);
      return commit(input);
    },
  };
  return { repo, commits };
}

describe('runScheduleBatch', () => {
  it('normalizes the occurrence identity and advances recurring schedules', async () => {
    const row = schedule();
    const { repo, commits } = repository([row], async (input) => ({
      schedule: {
        ...row,
        lastRunAt: input.now,
        nextRunAt: input.nextRunAt,
      },
      task: input.task ? taskResult('task-1', row.agentId, true) : null,
    }));
    const notifications: Array<[string, number]> = [];

    const fired = await runScheduleBatch(repo, 'UTC', {
      now: NOW,
      onCreated: (id, generation) => notifications.push([id, generation]),
    });

    expect(fired).toEqual([{ schedule: row.name, taskId: 'task-1' }]);
    expect(notifications).toEqual([['task-1', 0]]);
    const input = commits[0];
    expect(input?.enabled).toBe(true);
    expect(input?.nextRunAt).toEqual(new Date('2025-06-01T12:01:00.000Z'));
    expect(input?.task).toMatchObject({
      externalEventId: `schedule:${row.id}:${DUE.toISOString()}`,
      trigger: {
        source: 'schedule',
        payload: {
          scheduleId: row.id,
          occurrenceId: `schedule:${row.id}:${DUE.toISOString()}`,
        },
      },
    });
  });

  it('disables a one-time schedule while retaining its created task', async () => {
    const row = schedule({
      taskTemplate: { type: 'scheduled', reminderKind: 'once', reminderText: 'once' },
    });
    const { repo, commits } = repository([row], async (input) => ({
      schedule: { ...row, enabled: false, nextRunAt: null, lastRunAt: input.now },
      task: input.task ? taskResult('task-once', row.agentId, true) : null,
    }));

    await runScheduleBatch(repo, 'UTC', { now: NOW });

    expect(commits[0]).toMatchObject({ enabled: false, nextRunAt: null });
    expect(commits[0]?.task?.externalEventId).toBe(`schedule:${row.id}:${DUE.toISOString()}`);
  });

  it('falls back from a null task template to the schedule name and scheduled type', async () => {
    const row = schedule({
      id: 'schedule-null-template',
      name: 'schedule:null-template',
      taskTemplate: null,
    });
    const { repo, commits } = repository([row], async (input) => ({
      schedule: { ...row, lastRunAt: input.now, nextRunAt: input.nextRunAt },
      task: input.task ? taskResult('task-null-template', row.agentId, true) : null,
    }));

    await runScheduleBatch(repo, 'UTC', { now: NOW });

    expect(commits[0]?.task).toMatchObject({
      type: 'scheduled',
      title: row.name,
      trigger: { payload: { instruction: row.name } },
    });
  });

  it('advances a disabled code job without creating a task', async () => {
    const row = schedule({ taskTemplate: { type: 'scheduled', job: 'memory.graph_sync' } });
    const { repo, commits } = repository([row], async (input) => ({
      schedule: { ...row, lastRunAt: input.now, nextRunAt: input.nextRunAt },
      task: null,
    }));

    expect(
      await runScheduleBatch(repo, 'UTC', {
        now: NOW,
        isJobEnabled: () => false,
      }),
    ).toEqual([]);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.task).toBeNull();
    expect(commits[0]?.enabled).toBe(true);
    expect(commits[0]?.nextRunAt).toEqual(new Date('2025-06-01T12:01:00.000Z'));
  });

  it('throws for a portable goal schedule without a goal preparation adapter', async () => {
    const row = schedule({ taskTemplate: { type: 'scheduled', goalId: 'goal-1' } });
    let commitCount = 0;
    const { repo } = repository([row], async () => {
      commitCount += 1;
      return null;
    });

    await expect(runScheduleBatch(repo, 'UTC', { now: NOW })).rejects.toThrow(
      'Goal schedule requires a goal preparation adapter',
    );
    expect(commitCount).toBe(0);
  });

  it('calls the creation callback only for a newly created task after a successful commit', async () => {
    const first = schedule({ id: 'schedule-existing' });
    const second = schedule({ id: 'schedule-created', name: 'reminder:created' });
    const { repo } = repository([first, second], async (input) => ({
      schedule: input.expected,
      task:
        input.expected.id === first.id
          ? taskResult('task-existing', first.agentId, false)
          : taskResult('task-created', second.agentId, true),
    }));
    const notifications: string[] = [];

    const fired = await runScheduleBatch(repo, 'UTC', {
      now: NOW,
      onCreated: (id) => notifications.push(id),
    });

    expect(fired).toEqual([{ schedule: second.name, taskId: 'task-created' }]);
    expect(notifications).toEqual(['task-created']);
  });
});
