import { randomUUID } from 'node:crypto';
import {
  agents,
  conversations,
  createDb,
  type Db,
  messages,
  schedules,
  type TaskRow,
  tasks,
} from '@assistant/db';
import type {
  ExecutionPersistence,
  KnowledgeGraphSyncRepository,
  ReminderEventDependency,
} from '@assistant/persistence';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigForTest } from '../config.js';
import type { InboundEvent } from '../events.js';
import type { ModelRouter } from '../model-router/router.js';
import type { ScoreboardGame } from '../sports/index.js';
import type { DispatcherPort } from '../workflow/executor.js';
import { executeTask } from '../workflow/executor.js';
import { enqueueTask } from '../workflow/machine.js';
import {
  codeJobName,
  isCodeJobEnabled,
  isExactCompletedSportsOccurrence,
  runCodeJob,
} from './jobs.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
const createdTaskIds: string[] = [];
const createdScheduleIds: string[] = [];

describe('event-completion reminder verification', () => {
  const dependency: ReminderEventDependency = {
    provider: 'sports',
    eventId: 'fixture-1',
    league: 'mlb',
    startsAt: '2026-10-08T02:00:00.000Z',
    eventDate: '2026-10-07',
    timezone: 'America/Los_Angeles',
    homeTeamId: 'sf',
    awayTeamId: 'la',
    homeTeam: 'San Francisco Giants',
    awayTeam: 'Los Angeles Dodgers',
    verifiedAt: '2026-10-07T06:35:00.000Z',
  };
  const game: ScoreboardGame = {
    id: dependency.eventId,
    league: dependency.league,
    leagueLabel: 'MLB',
    state: 'post',
    statusText: 'Final',
    startsAt: dependency.startsAt,
    home: {
      id: dependency.homeTeamId,
      name: dependency.homeTeam,
      shortName: 'Giants',
      abbreviation: 'SF',
    },
    away: {
      id: dependency.awayTeamId,
      name: dependency.awayTeam,
      shortName: 'Dodgers',
      abbreviation: 'LA',
    },
    line: 'Los Angeles Dodgers at San Francisco Giants: 3-4, Final',
  };

  it('only treats the exact bound fixture as complete after the provider reports post', () => {
    expect(isExactCompletedSportsOccurrence(dependency, [game])).toBe(true);
    expect(isExactCompletedSportsOccurrence(dependency, [{ ...game, state: 'in' }])).toBe(false);
    expect(
      isExactCompletedSportsOccurrence(dependency, [
        { ...game, startsAt: '2026-10-08T03:00:00.000Z' },
      ]),
    ).toBe(false);
    expect(isExactCompletedSportsOccurrence(dependency, [{ ...game, id: 'another-game' }])).toBe(
      false,
    );
    expect(isExactCompletedSportsOccurrence(dependency, [game, game])).toBe(false);
  });

  it('withholds delivery while the exact game is live and delivers only after final status', async () => {
    const deliver = vi.fn(async () => ({ delivered: true as const, conversationId: 'chat-1' }));
    const task = {
      id: 'task-reminder',
      agentId: 'agent-reminder',
      conversationId: null,
      lockedUntil: new Date(Date.now() + 60_000),
      leaseToken: 'lease',
      trigger: {
        payload: {
          job: 'reminder.notify',
          scheduleId: 'reminder-1',
          occurrenceId: 'schedule:reminder-1:occurrence',
          reminderKind: 'event_completion',
          reminderText: 'Check the game result.',
          reminderEventDependency: dependency,
        },
      },
    } as unknown as TaskRow;
    const run = (state: ScoreboardGame['state']) =>
      runCodeJob(
        {
          db: {} as never,
          router: fakeRouter,
          persistence: { reminderDelivery: { deliver } } as unknown as ExecutionPersistence,
          reminderSportsScoreboardReader: async () => [{ ...game, state }],
        },
        'reminder.notify',
        task,
      );

    const pending = await run('in');
    expect(pending.summary).toMatch(/has not finished/);
    expect(deliver).not.toHaveBeenCalled();
    const completed = await run('post');
    expect(completed.summary).toMatch(/delivered/);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

/** Extraction with no extractable conversations returns empty — the fake never gets called for facts. */
const fakeRouter = {
  async object() {
    return {
      ok: true,
      modelId: 'fake',
      degraded: false,
      object: { facts: [], commitments: [], resolvedTitles: [] },
    };
  },
  async embed(texts: string[]) {
    return texts.map(() => new Array(1536).fill(0.01));
  },
} as unknown as ModelRouter;

/** Code jobs must never reach the tool dispatcher. */
const explodingDispatcher: DispatcherPort = {
  toolDefs: () => {
    throw new Error('code job must not build a tool set');
  },
  resultIsUntrusted: () => false,
  dispatch: async () => {
    throw new Error('code job must not dispatch tools');
  },
  executeApproved: async () => {
    throw new Error('code job must not execute approvals');
  },
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      name: 'Isolated code jobs',
      email: `${agentId}@jobs.invalid`,
      workspacePrefix: `jobs/${agentId}`,
    });
    dbUp = true;
  } catch {
    console.warn('jobs.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp && createdTaskIds.length) {
    await db.delete(messages).where(inArray(messages.taskId, createdTaskIds));
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  if (dbUp && createdScheduleIds.length) {
    await db.delete(schedules).where(inArray(schedules.id, createdScheduleIds));
  }
  if (dbUp) {
    const owned = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.agentId, agentId));
    if (owned.length) {
      await db.delete(messages).where(
        inArray(
          messages.conversationId,
          owned.map((row) => row.id),
        ),
      );
      await db.delete(conversations).where(eq(conversations.agentId, agentId));
    }
    await db.delete(agents).where(eq(agents.id, agentId));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

afterEach(() => resetConfigForTest());

describe('codeJobName', () => {
  const taskWith = (payload: Record<string, unknown>) =>
    ({ trigger: { source: 'schedule', payload } }) as never;
  it('recognizes registered jobs and rejects everything else', () => {
    expect(codeJobName(taskWith({ job: 'memory.extract' }))).toBe('memory.extract');
    expect(codeJobName(taskWith({ job: 'memory.consolidate' }))).toBe('memory.consolidate');
    expect(codeJobName(taskWith({ job: 'memory.graph_sync' }))).toBe('memory.graph_sync');
    expect(codeJobName(taskWith({ job: 'memory.graph_date_backfill' }))).toBe(
      'memory.graph_date_backfill',
    );
    expect(codeJobName(taskWith({ job: 'voice.ingest' }))).toBe('voice.ingest');
    expect(codeJobName(taskWith({ job: 'documents.extract' }))).toBe('documents.extract');
    expect(codeJobName(taskWith({ job: 'documents.process' }))).toBe('documents.process');
    expect(codeJobName(taskWith({ job: 'ambient.refresh' }))).toBe('ambient.refresh');
    expect(codeJobName(taskWith({ job: 'dream.run' }))).toBe('dream.run');
    expect(codeJobName(taskWith({ job: 'self.maintain' }))).toBe('self.maintain');
    expect(codeJobName(taskWith({ job: 'health.monitor' }))).toBe('health.monitor');
    expect(codeJobName(taskWith({ job: 'reminder.notify' }))).toBe('reminder.notify');
    expect(codeJobName(taskWith({ job: 'rm -rf /' }))).toBeNull();
    expect(codeJobName(taskWith({ instruction: 'do things' }))).toBeNull();
    expect(codeJobName({ trigger: null } as never)).toBeNull();
  });
});

describe('feature-gated code jobs', () => {
  it('skips graph sync until GraphRAG is explicitly enabled', async () => {
    loadConfig({ GRAPH_RAG_ENABLED: 'false' });
    expect(isCodeJobEnabled('memory.graph_sync')).toBe(false);
    expect(isCodeJobEnabled('memory.extract')).toBe(true);

    const result = await runCodeJob({ db: {} as Db, router: fakeRouter }, 'memory.graph_sync', {
      id: 'unused',
      agentId: 'unused',
    } as TaskRow);
    expect(result).toEqual({ done: true, summary: 'knowledge graph: disabled' });
  });

  // The date backfill reads the graph, so it is gated on the same flag even
  // though it never spends anything.
  it('gates the date backfill behind the same flag', async () => {
    loadConfig({ GRAPH_RAG_ENABLED: 'false' });
    expect(isCodeJobEnabled('memory.graph_date_backfill')).toBe(false);

    const result = await runCodeJob(
      { db: {} as Db, router: fakeRouter },
      'memory.graph_date_backfill',
      { id: 'unused', agentId: 'unused' } as TaskRow,
    );
    expect(result).toEqual({ done: true, summary: 'knowledge graph dates: disabled' });
  });

  it('routes a scheduled graph sync through the selected persistence repository', async () => {
    loadConfig({ GRAPH_RAG_ENABLED: 'true' });
    const calls: string[] = [];
    const graphSync = {
      kind: 'knowledge-graph-sync-repository',
      now: () => new Date(),
      async hydrateContactLabels() {
        calls.push('hydrate');
      },
      async candidates() {
        calls.push('candidates');
        return [];
      },
      async removeOrphanedEntities() {
        calls.push('orphans');
        return 0;
      },
      async pendingCount() {
        calls.push('pending');
        return 0;
      },
      async taskSpendUsd() {
        calls.push('spend');
        return 0;
      },
    } as unknown as KnowledgeGraphSyncRepository;
    const result = await runCodeJob(
      {
        db: {} as Db,
        persistence: { graphSync } as ExecutionPersistence,
        router: fakeRouter,
      },
      'memory.graph_sync',
      { id: 'graph-task', agentId: 'graph-owner' } as TaskRow,
    );
    expect(result).toMatchObject({ done: true });
    expect(result.summary).toContain('0 pending');
    expect(calls).toEqual(['hydrate', 'candidates', 'orphans', 'pending', 'spend']);
  });

  it('fails closed before SQL when selected persistence lacks graph sync', async () => {
    loadConfig({ GRAPH_RAG_ENABLED: 'true' });
    const sqlCall = vi.fn(() => {
      throw new Error('unexpected SQL call');
    });
    await expect(
      runCodeJob(
        {
          db: { select: sqlCall, transaction: sqlCall, execute: sqlCall } as unknown as Db,
          persistence: {} as ExecutionPersistence,
          router: fakeRouter,
        },
        'memory.graph_sync',
        { id: 'graph-task', agentId: 'graph-owner' } as TaskRow,
      ),
    ).rejects.toThrow('Knowledge graph sync repository is missing');
    expect(sqlCall).not.toHaveBeenCalled();
  });
});

describe('code job execution (integration)', () => {
  it('a scheduled task with a job payload runs the job, not the model loop', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const event: InboundEvent = {
      source: 'schedule',
      agentId,
      trust: 'assistant',
      payload: { schedule: 'memory-extraction', job: 'memory.extract' },
    };
    const { task } = await enqueueTask(db, { event, type: 'scheduled' });
    createdTaskIds.push(task.id);

    const result = await executeTask(
      { db, router: fakeRouter, dispatcher: explodingDispatcher },
      task.id,
    );
    expect(result.outcome).toBe('done');

    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.status).toBe('done');
    expect(row?.progress).toMatch(/^extraction:/);
  });

  it('delivers the exact reminder payload without inheriting stale chat history', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const reminderText = 'Get sunglasses from the car and pack them';
    const event: InboundEvent = {
      source: 'schedule',
      agentId,
      trust: 'assistant',
      payload: {
        schedule: 'reminder-test',
        job: 'reminder.notify',
        reminderText,
        instruction: `Reminder for the owner: ${reminderText}\n\nOld chat: Pull the photos`,
      },
    };
    const { task } = await enqueueTask(db, { event, type: 'scheduled' });
    createdTaskIds.push(task.id);

    const result = await executeTask(
      { db, router: fakeRouter, dispatcher: explodingDispatcher },
      task.id,
    );
    expect(result.outcome).toBe('done');
    const delivered = await db.select().from(messages).where(eq(messages.taskId, task.id));
    expect(delivered.map((message) => message.text)).toEqual([reminderText]);
    expect(delivered[0]?.text).not.toContain('photos');
  });

  it('suppresses a queued reminder after its schedule is cancelled', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const reminderText = 'This must not be delivered';
    const [schedule] = await db
      .insert(schedules)
      .values({
        agentId,
        name: `reminder:${randomUUID()}`,
        cron: '0 9 * * *',
        enabled: false,
        taskTemplate: {
          reminderKind: 'recurring',
          reminderText,
          reminderCancelledAt: new Date().toISOString(),
        },
      })
      .returning();
    if (!schedule) throw new Error('failed to create reminder schedule fixture');
    createdScheduleIds.push(schedule.id);
    const event: InboundEvent = {
      source: 'schedule',
      agentId,
      trust: 'assistant',
      payload: {
        scheduleId: schedule.id,
        schedule: schedule.name,
        job: 'reminder.notify',
        reminderText,
      },
    };
    const { task } = await enqueueTask(db, { event, type: 'scheduled' });
    createdTaskIds.push(task.id);

    const result = await executeTask(
      { db, router: fakeRouter, dispatcher: explodingDispatcher },
      task.id,
    );
    expect(result.outcome).toBe('done');
    const delivered = await db.select().from(messages).where(eq(messages.taskId, task.id));
    expect(delivered).toEqual([]);
  });
});
