import { randomUUID } from 'node:crypto';
import { type ExecutorDeps, executeTask } from '@assistant/core';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import { type ExecutionPersistence, embeddingSpaceIdentityKey } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeRecord, type InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const HOUR = 3_600_000;
const SPACE = { provider: 'synthetic', model: 'skill-fixture', dimensions: 1536, revision: '1' };
const VECTOR = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));

interface Draft {
  worthSkill: boolean;
  name: string;
  preconditions: string;
  steps: string;
  gotchas: string;
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore skill reflection job',
  { timeout: 30_000 },
  () => {
    const agentId = randomUUID();
    let store: InstallationStore;
    let persistence: ExecutionPersistence;
    let deps: ExecutorDeps;
    let prompts: string[];
    let drafts: Map<string, Draft>;
    const now = Date.now();
    const hoursAgo = (hours: number) => new Date(now - hours * HOUR);

    beforeEach(async () => {
      store = emulatorStore();
      prompts = [];
      drafts = new Map();
      const unavailable = (name: string) =>
        new Proxy(
          {},
          {
            get: (_target, property) => {
              throw new Error(`Unexpected ${name} access: ${String(property)}`);
            },
          },
        );
      persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
      const router = {
        async embeddingSpace() {
          return SPACE;
        },
        async embeddingSpaceKey() {
          return embeddingSpaceIdentityKey(SPACE);
        },
        async object(_role: string, input: { prompt: string }) {
          prompts.push(input.prompt);
          const goal = /^Goal: (.*)$/m.exec(input.prompt)?.[1] ?? '';
          const object = drafts.get(goal) ?? {
            worthSkill: false,
            name: '',
            preconditions: '',
            steps: '',
            gotchas: '',
          };
          return { ok: true, modelId: 'fixture', degraded: false, object };
        },
        async embed(texts: string[]) {
          return texts.map(() => VECTOR);
        },
      };
      deps = {
        db: unavailable('db') as Db,
        router: router as unknown as ExecutorDeps['router'],
        dispatcher: unavailable('dispatcher') as ExecutorDeps['dispatcher'],
        persistence,
      };
      await store.doc('agents', agentId).set(
        encodeRecord({
          id: agentId,
          name: 'Ada',
          timezone: 'UTC',
          createdAt: hoursAgo(1000),
          updatedAt: hoursAgo(1000),
        }),
      );
    });

    afterEach(async () => {
      await disposeStore(store);
    });

    async function finishedTask(input: {
      goal: string;
      calls?: Array<{ toolName: string; status?: string; args?: Record<string, unknown> }>;
      trust?: string;
      hours?: number;
      status?: string;
      state?: Record<string, unknown>;
    }) {
      const id = randomUUID();
      await store.doc('tasks', id).set(
        encodeRecord({
          id,
          agentId,
          type: 'adhoc',
          trust: input.trust ?? 'owner',
          status: input.status ?? 'done',
          trigger: { source: 'chat', payload: { instruction: input.goal } },
          state: input.state ?? {},
          plan: null,
          progress: `Finished: ${input.goal}`,
          createdAt: hoursAgo(input.hours ?? 2),
          updatedAt: hoursAgo(input.hours ?? 2),
        }),
      );
      const calls = input.calls ?? [
        { toolName: 'web.search', args: { query: 'ferry times' } },
        { toolName: 'calendar.create_event', args: { title: 'Ferry', token: 'hidden' } },
      ];
      for (const [step, call] of calls.entries()) {
        const callId = randomUUID();
        await store.doc('toolCalls', callId).set(
          encodeRecord({
            id: callId,
            taskId: id,
            step,
            toolName: call.toolName,
            status: call.status ?? 'succeeded',
            error: null,
            args: call.args ?? {},
            risk: 'read',
            createdAt: hoursAgo(input.hours ?? 2),
          }),
        );
      }
      return id;
    }

    async function runJob(): Promise<string | undefined> {
      const { task } = await persistence.tasks.createTask({
        agentId,
        type: 'scheduled',
        trust: 'assistant',
        trigger: { source: 'schedule', payload: { job: 'skill.reflect' } },
      });
      const result = await executeTask(deps, task.id);
      expect(result.outcome).toBe('done');
      return result.detail;
    }

    async function skills() {
      const rows = await store.collection('skills').where('agentId', '==', agentId).get();
      return rows.docs.map((doc) => doc.data());
    }

    it('distils eligible multi-step work once and skips tainted, thin, and stale tasks', async () => {
      const ferry = await finishedTask({ goal: 'Book the ferry' });
      drafts.set('Book the ferry', {
        worthSkill: true,
        name: '  Booking ferries  ',
        preconditions: 'A crossing date is known',
        steps: 'Search the timetable, then hold the slot in the calendar.',
        gotchas: 'Timetables change in winter.',
      });
      await finishedTask({ goal: 'Tainted run', state: { untrustedContext: true } });
      await finishedTask({ goal: 'Stranger request', trust: 'unknown' });
      await finishedTask({ goal: 'One step', calls: [{ toolName: 'web.search' }] });
      await finishedTask({
        goal: 'Half failed',
        calls: [{ toolName: 'web.search' }, { toolName: 'gmail.send', status: 'failed' }],
      });
      await finishedTask({ goal: 'Last week', hours: 100 });
      await finishedTask({ goal: 'Still running', status: 'running' });
      await finishedTask({ goal: 'Routine chat' });

      expect(await runJob()).toBe('skill reflection: 1 skill(s) drafted from 2 reviewed task(s)');
      expect(prompts.map((prompt) => /^Goal: (.*)$/m.exec(prompt)?.[1]).sort()).toEqual([
        'Book the ferry',
        'Routine chat',
      ]);
      const ferryPrompt = prompts.find((prompt) => prompt.includes('Book the ferry')) ?? '';
      expect(ferryPrompt).toContain('- web.search(query: "ferry times") → succeeded');
      expect(ferryPrompt).toContain('calendar.create_event(title: "Ferry", token: …)');
      expect(ferryPrompt).toContain('Recorded outcome: Finished: Book the ferry');

      const saved = await skills();
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        name: 'Booking ferries',
        steps: 'Search the timetable, then hold the slot in the calendar.',
        sourceTaskId: ferry,
        originTrust: 'owner',
        ownerAuthored: false,
        deprecated: false,
      });
      expect(typeof saved[0]?.embeddingSpace).toBe('string');

      // The durable task receipt makes the next night skip it, even when a
      // reflection was recorded without creating a skill.
      prompts = [];
      expect(await runJob()).toBe('skill reflection: 0 skill(s) drafted from 0 reviewed task(s)');
      expect(prompts.some((prompt) => prompt.includes('Book the ferry'))).toBe(false);
    });

    it('revives a same-named reflected skill and never overwrites an owner-authored one', async () => {
      const existing = randomUUID();
      const owned = randomUUID();
      for (const [id, name, ownerAuthored] of [
        [existing, 'Booking ferries', false],
        [owned, 'Paying invoices', true],
      ] as const) {
        await store.doc('skills', id).set(
          encodeRecord({
            id,
            agentId,
            name,
            preconditions: '',
            steps: 'Old steps',
            gotchas: '',
            embedding: null,
            sourceTaskId: null,
            originTrust: ownerAuthored ? 'owner' : 'assistant',
            ownerAuthored,
            useCount: 0,
            successCount: 0,
            failureCount: 0,
            lastVerifiedAt: null,
            deprecated: true,
            createdAt: hoursAgo(500),
            updatedAt: hoursAgo(500),
          }),
        );
      }
      await finishedTask({ goal: 'Book the ferry' });
      await finishedTask({ goal: 'Pay the invoice' });
      drafts.set('Book the ferry', {
        worthSkill: true,
        name: 'Booking ferries',
        preconditions: '',
        steps: 'New ferry steps',
        gotchas: '',
      });
      drafts.set('Pay the invoice', {
        worthSkill: true,
        name: 'Paying invoices',
        preconditions: '',
        steps: 'Reflected invoice steps',
        gotchas: '',
      });

      expect(await runJob()).toBe('skill reflection: 0 skill(s) drafted from 2 reviewed task(s)');
      const byName = new Map((await skills()).map((row) => [row.name, row]));
      expect(byName.get('Booking ferries')).toMatchObject({
        steps: 'New ferry steps',
        deprecated: false,
      });
      expect(byName.get('Paying invoices')).toMatchObject({
        steps: 'Old steps',
        deprecated: true,
        ownerAuthored: true,
      });
    });
  },
);
