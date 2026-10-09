import { randomUUID } from 'node:crypto';
import { type ExecutorDeps, executeTask } from '@assistant/core';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const DAY = 24 * 3600 * 1000;

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore open-loop sweep job', () => {
  const agentId = randomUUID();
  let store: InstallationStore;
  let deps: ExecutorDeps;
  let sqlAccesses: string[];
  const now = new Date();
  const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

  beforeEach(async () => {
    store = emulatorStore();
    sqlAccesses = [];
    const unavailable = (name: string) =>
      new Proxy(
        {},
        {
          get: (_target, property) => {
            sqlAccesses.push(`${name}.${String(property)}`);
            throw new Error(`Unexpected ${name} access: ${String(property)}`);
          },
        },
      );
    deps = {
      db: unavailable('db') as Db,
      router: unavailable('router') as ExecutorDeps['router'],
      dispatcher: unavailable('dispatcher') as ExecutorDeps['dispatcher'],
      persistence: createFirestoreExecutionPersistence(store, agentId, {
        provider: 'synthetic',
        model: 'sweep-fixture',
        dimensions: 1536,
        revision: '1',
      }),
    };
    await store.doc('agents', agentId).set({ id: agentId, name: 'Owner', timezone: 'UTC' });
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  async function seed(
    rows: Array<{
      key: string;
      kind: string;
      idleDays: number;
      status?: string;
      snoozedUntil?: Date;
      dueAt?: Date;
      agent?: string;
    }>,
  ) {
    for (const row of rows) {
      const id = randomUUID();
      await store.doc('commitments', id).set({
        id,
        agentId: row.agent ?? agentId,
        conversationId: randomUUID(),
        sourceMessageId: null,
        sourceTaskId: null,
        kind: row.kind,
        title: row.key,
        details: '',
        nextAction: '',
        status: row.status ?? 'open',
        snoozedUntil: row.snoozedUntil ?? null,
        dueAt: row.dueAt ?? null,
        resolvedAt: null,
        resolution: null,
        confidence: '0.9',
        contentHash: row.key,
        createdAt: daysAgo(row.idleDays),
        updatedAt: daysAgo(row.idleDays),
      });
    }
  }

  async function statuses(): Promise<Record<string, string>> {
    const rows = await store.collection('commitments').get();
    return Object.fromEntries(rows.docs.map((doc) => [doc.get('title'), doc.get('status')]));
  }

  async function runSweep(): Promise<string | undefined> {
    const { task } = await (deps.persistence?.tasks ?? unavailableTasks()).createTask({
      agentId,
      type: 'scheduled',
      trust: 'assistant',
      trigger: { source: 'schedule', payload: { job: 'memory.sweep_loops' } },
    });
    const result = await executeTask(deps, task.id);
    expect(result.outcome).toBe('done');
    return result.detail;
  }

  function unavailableTasks(): never {
    throw new Error('missing task repository');
  }

  it('preserves obligations and wakes expired snoozes without SQL or model work', async () => {
    await seed([
      { key: 'fresh-question', kind: 'question', idleDays: 10 },
      { key: 'cold-question', kind: 'question', idleDays: 31 },
      { key: 'waiting', kind: 'waiting_on', idleDays: 31 },
      { key: 'promise-inside-window', kind: 'promise', idleDays: 31 },
      { key: 'cold-promise', kind: 'promise', idleDays: 46 },
      { key: 'decision-inside-window', kind: 'decision', idleDays: 46 },
      { key: 'cold-decision', kind: 'decision', idleDays: 91 },
      { key: 'just-overdue', kind: 'promise', idleDays: 1, dueAt: daysAgo(13) },
      { key: 'long-overdue', kind: 'promise', idleDays: 1, dueAt: daysAgo(15) },
      {
        key: 'snoozed-until-tomorrow',
        kind: 'question',
        idleDays: 60,
        status: 'snoozed',
        snoozedUntil: new Date(now.getTime() + DAY),
      },
      {
        key: 'snooze-expired',
        kind: 'question',
        idleDays: 60,
        status: 'snoozed',
        snoozedUntil: daysAgo(2),
      },
      { key: 'resolved', kind: 'question', idleDays: 200, status: 'resolved' },
      { key: 'dismissed', kind: 'question', idleDays: 200, status: 'dismissed' },
      { key: 'foreign', kind: 'question', idleDays: 200, agent: randomUUID() },
      {
        key: 'future-promise',
        kind: 'promise',
        idleDays: 200,
        dueAt: new Date(now.getTime() + 180 * DAY),
      },
    ]);

    expect(await runSweep()).toBe('open loops: 1 snooze(s) woken, 0 legacy obligation(s) restored');
    expect(await statuses()).toEqual({
      'fresh-question': 'open',
      'cold-question': 'open',
      waiting: 'open',
      'promise-inside-window': 'open',
      'cold-promise': 'open',
      'decision-inside-window': 'open',
      'cold-decision': 'open',
      'just-overdue': 'open',
      'long-overdue': 'open',
      'snoozed-until-tomorrow': 'snoozed',
      'snooze-expired': 'open',
      resolved: 'resolved',
      dismissed: 'dismissed',
      foreign: 'open',
      'future-promise': 'open',
    });
    // A second run does not change already woken obligations.
    expect(await runSweep()).toBe('open loops: 0 snooze(s) woken, 0 legacy obligation(s) restored');
    expect(sqlAccesses).toEqual([]);
  });

  it('restores legacy age-retired obligations and preserves closed states', async () => {
    await seed([
      { key: 'legacy', kind: 'promise', idleDays: 200, status: 'stale' },
      { key: 'resolved', kind: 'promise', idleDays: 200, status: 'resolved' },
      { key: 'dismissed', kind: 'promise', idleDays: 200, status: 'dismissed' },
    ]);
    expect(await runSweep()).toBe('open loops: 0 snooze(s) woken, 1 legacy obligation(s) restored');
    expect(await statuses()).toEqual({
      legacy: 'open',
      resolved: 'resolved',
      dismissed: 'dismissed',
    });
    expect(await runSweep()).toBe('open loops: 0 snooze(s) woken, 0 legacy obligation(s) restored');
  });

  it('pages through more loops than a single query returns', async () => {
    await seed(
      Array.from({ length: 205 }, (_, index) => ({
        key: `cold-${index}`,
        kind: 'question',
        idleDays: 40,
        status: 'snoozed',
        snoozedUntil: daysAgo(1),
      })),
    );
    expect(await runSweep()).toBe(
      'open loops: 205 snooze(s) woken, 0 legacy obligation(s) restored',
    );
    expect(sqlAccesses).toEqual([]);
  }, 60_000);
});
