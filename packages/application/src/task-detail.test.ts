import { getAgent } from '@assistant/core/chat';
import { createDb, type Db, tasks, toolCalls } from '@assistant/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTaskDetail } from './tasks/queries.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId = '';
const createdTaskIds: string[] = [];

async function newTask(): Promise<string> {
  const [task] = await db
    .insert(tasks)
    .values({ agentId, type: 'adhoc', trust: 'owner', title: 'task-detail-test' })
    .returning();
  const id = (task as NonNullable<typeof task>).id;
  createdTaskIds.push(id);
  return id;
}

/** One recorded step, `at` seconds apart so the timeline has a real order. */
async function step(
  taskId: string,
  index: number,
  options: { result?: unknown; status?: string } = {},
) {
  await db.insert(toolCalls).values({
    taskId,
    toolName: 'web.fetch',
    step: index,
    risk: 'autonomous',
    status: options.status ?? 'succeeded',
    args: { url: `https://example.com/${index}` },
    result: options.result ?? { ok: true, index },
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
  });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('task-detail.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp && createdTaskIds.length) {
    await db.delete(toolCalls).where(inArray(toolCalls.taskId, createdTaskIds));
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('getTaskDetail', () => {
  it('projects only the validated checklist, never the task scratchpad or card receipts', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const taskId = await newTask();
    const items = [
      {
        id: 'outcome1',
        label: 'Find hotel',
        kind: 'lookup',
        targetTerms: ['hotel'],
        status: 'completed',
        evidence: [{ id: 'call1', toolName: 'gmail.search' }],
      },
    ];
    await db
      .update(tasks)
      .set({
        state: {
          scratchpad: 'PRIVATE-SCRATCHPAD',
          requestChecklist: {
            version: 1,
            request: 'PRIVATE-REQUEST',
            items,
            savedCards: [{ id: 'PRIVATE-CARD', revisionId: 'v1', title: 'Hotel' }],
          },
        },
      })
      .where(eq(tasks.id, taskId));
    const detail = await getTaskDetail(db, taskId);
    expect(detail?.task.checklist).toEqual({ items });
    expect(JSON.stringify(detail)).not.toContain('PRIVATE-');
    await db
      .update(tasks)
      .set({ state: { requestChecklist: { version: 99 } } })
      .where(eq(tasks.id, taskId));
    expect((await getTaskDetail(db, taskId))?.task.checklist).toBeUndefined();
  });

  it('pages the timeline from the newest end and walks back with `before`', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const taskId = await newTask();
    for (let index = 0; index < 12; index += 1) await step(taskId, index);

    const page = await getTaskDetail(db, taskId, { pageSize: 5 });
    expect(page).not.toBeNull();
    const first = page as NonNullable<typeof page>;
    // Newest five, handed back oldest-first for reading.
    expect(first.toolCalls.map((call) => call.step)).toEqual([7, 8, 9, 10, 11]);
    expect(first.hasMoreTimeline).toBe(true);

    const older = await getTaskDetail(db, taskId, {
      pageSize: 5,
      before: (first.toolCalls[0] as NonNullable<(typeof first.toolCalls)[number]>).createdAt,
    });
    expect((older as NonNullable<typeof older>).toolCalls.map((call) => call.step)).toEqual([
      2, 3, 4, 5, 6,
    ]);
  });

  it('reaches every equal-time and sub-millisecond event exactly once', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const taskId = await newTask();
    await db.insert(toolCalls).values(
      Array.from({ length: 121 }, (_, index) => ({
        taskId,
        toolName: 'web.fetch',
        step: index,
        risk: 'autonomous',
        status: 'succeeded',
        createdAt: sql`'2026-01-01T12:00:00Z'::timestamptz + ${index < 101 ? 0 : index} * interval '1 microsecond'`,
      })),
    );
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let pages = 0; pages < 10; pages++) {
      const page = await getTaskDetail(db, taskId, { pageSize: 25, cursor });
      expect(page).not.toBeNull();
      if (!page) throw new Error('Missing timeline page');
      expect(page.toolCalls.length).toBeLessThanOrEqual(25);
      for (const row of page.toolCalls) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      if (!page.hasMoreTimeline) break;
      expect(page.nextTimelineCursor).toBeTruthy();
      if (!page.nextTimelineCursor) throw new Error('Missing timeline cursor');
      cursor = page.nextTimelineCursor;
    }
    expect(seen.size).toBe(121);
  });

  it('reports no more entries once the whole record fits on one page', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const taskId = await newTask();
    await step(taskId, 0);
    const detail = await getTaskDetail(db, taskId, { pageSize: 50 });
    expect((detail as NonNullable<typeof detail>).hasMoreTimeline).toBe(false);
  });

  // The finding: a browser step is budgeted to 400KB and a fetched page can be
  // larger still, and every one of them used to reach the page in full.
  it('clips a large recorded result and says how much it clipped', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const taskId = await newTask();
    await step(taskId, 0, { result: { body: 'x'.repeat(50_000) } });

    const detail = await getTaskDetail(db, taskId);
    const call = (detail as NonNullable<typeof detail>).toolCalls[0];
    expect(call?.result?.truncated).toBe(true);
    expect(call?.result?.text.length).toBeLessThan(5_000);
    expect(call?.result?.totalChars).toBeGreaterThan(50_000);
  });

  // The "what actually happened" section reads the WHOLE task, not the page,
  // so it must still see every call — just without the payloads.
  it('summarizes every call in the task even when the timeline is paged', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const taskId = await newTask();
    for (let index = 0; index < 12; index += 1) await step(taskId, index);
    // A provider that answered "no" inside a succeeded call is not completed.
    await step(taskId, 12, { result: { ok: false } });

    const detail = await getTaskDetail(db, taskId, { pageSize: 2 });
    const record = detail as NonNullable<typeof detail>;
    expect(record.toolCalls).toHaveLength(2);
    expect(record.actions).toHaveLength(13);
    expect(record.actions.filter((action) => action.completed)).toHaveLength(12);
  });
});
