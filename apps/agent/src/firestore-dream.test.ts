import { createHash, randomUUID } from 'node:crypto';
import { type ExecutorDeps, executeTask } from '@assistant/core';
import type { Db } from '@assistant/db';
import { createFirestoreExecutionPersistence } from '@assistant/firestore';
import { type ExecutionPersistence, embeddingSpaceIdentityKey } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decodeRecord,
  encodeRecord,
  type InstallationStore,
} from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SPACE = { provider: 'synthetic', model: 'dream-fixture', dimensions: 1536, revision: '1' };
const VECTOR = Array.from({ length: 1536 }, (_, i) => (i === 1 ? 1 : 0));

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore overnight dream job',
  { timeout: 30_000 },
  () => {
    const agentId = randomUUID();
    const ownerContactId = randomUUID();
    let store: InstallationStore;
    let persistence: ExecutionPersistence;
    let deps: ExecutorDeps;
    let prompts: string[];
    const now = Date.now();
    const hoursAgo = (hours: number) => new Date(now - hours * HOUR);
    const dream = {
      footnotes: [
        'The browse of the ferry site failed on a stale selector — use the timetable API.',
      ],
      hypotheses: [
        { subject: 'owner', claim: 'The owner declines meetings before 10am.', confidence: 0.55 },
        { subject: 'Maria', claim: 'Maria prefers calls to email.', confidence: 0.2 },
        { subject: '', claim: 'A forgotten pattern.', confidence: 0.3 },
      ],
      anticipations: ['A ferry booking is likely tomorrow; the timetable is pre-read.'],
    };

    beforeEach(async () => {
      store = emulatorStore();
      prompts = [];
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
          return { ok: true, modelId: 'fixture', degraded: false, object: dream };
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
      await store.doc('agents', agentId).set({ id: agentId, name: 'Owner', timezone: 'UTC' });
      await store.doc('contacts', ownerContactId).set(
        encodeRecord({
          id: ownerContactId,
          name: 'Sam Owner',
          aliases: [],
          emails: [],
          phones: [],
          relationship: 'self',
          notes: '',
          trust: 'owner',
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
    });

    afterEach(async () => {
      await disposeStore(store);
    });

    async function task(input: {
      status: string;
      hours: number;
      agent?: string;
      progress?: string;
    }) {
      const id = randomUUID();
      await store.doc('tasks', id).set(
        encodeRecord({
          id,
          agentId: input.agent ?? agentId,
          type: 'adhoc',
          trust: 'owner',
          status: input.status,
          progress: input.progress ?? '',
          createdAt: hoursAgo(input.hours + 1),
          updatedAt: hoursAgo(input.hours),
        }),
      );
      return id;
    }

    async function failedCall(taskId: string, toolName: string, error: string, hours = 2) {
      const id = randomUUID();
      await store.doc('toolCalls', id).set(
        encodeRecord({
          id,
          taskId,
          step: 0,
          toolName,
          status: 'failed',
          error,
          args: {},
          risk: 'read',
          createdAt: hoursAgo(hours),
        }),
      );
    }

    async function decision(taskId: string, status: string, summary: string, days = 1) {
      const id = randomUUID();
      await store.doc('approvals', id).set(
        encodeRecord({
          id,
          taskId,
          status,
          summary,
          toolCallId: randomUUID(),
          shortCode: id.slice(0, 4),
          payload: {},
          resolutionPayload: null,
          requestedAt: new Date(now - days * DAY),
          expiresAt: new Date(now + DAY),
          resolvedAt: null,
          resolvedVia: null,
          notifiedChannels: [],
          createdPolicyId: null,
        }),
      );
    }

    async function runJob(): Promise<{ detail: string | undefined; taskId: string }> {
      const { task: created } = await persistence.tasks.createTask({
        agentId,
        type: 'scheduled',
        trust: 'assistant',
        trigger: { source: 'schedule', payload: { job: 'dream.run' } },
      });
      const result = await executeTask(deps, created.id);
      expect(result.outcome).toBe('done');
      return { detail: result.detail, taskId: created.id };
    }

    it("reflects on the owner's day and keeps what it learns quarantined", async () => {
      const failed = await task({ status: 'failed', hours: 3, progress: 'Ferry browse broke' });
      await task({ status: 'needs_attention', hours: 30, progress: 'Yesterday, out of window' });
      const foreign = await task({ status: 'failed', hours: 3, agent: randomUUID() });
      await failedCall(failed, 'browser.open', 'selector #times not found');
      await failedCall(failed, 'browser.click', 'too old', 30);
      await failedCall(foreign, 'gmail.send', 'someone else');
      await decision(failed, 'approved', 'Send the invoice');
      await decision(failed, 'denied', 'Book a 9am meeting');
      await decision(failed, 'pending', 'Still waiting');
      await decision(failed, 'approved', 'A month ago', 30);
      // The owner already rejected this pattern once.
      const tombstoned = createHash('sha256').update('dream:A forgotten pattern.').digest('hex');
      await store.doc('memoryTombstones', tombstoned).set({ contentHash: tombstoned });

      const { detail, taskId } = await runJob();
      expect(detail).toBe('dream: 1 footnote(s), 2 hypothesis(es), 1 anticipation(s)');

      const prompt = prompts[0] ?? '';
      expect(prompt).toContain('- adhoc: Ferry browse broke');
      expect(prompt).toContain('- browser.open: selector #times not found');
      expect(prompt).toContain('- [approved] Send the invoice');
      expect(prompt).toContain('- [denied] Book a 9am meeting');
      for (const excluded of [
        'Yesterday',
        'too old',
        'someone else',
        'Still waiting',
        'A month ago',
      ])
        expect(prompt).not.toContain(excluded);

      const memories = (
        await store.collection('memories').where('agentId', '==', agentId).get()
      ).docs.map((doc) => decodeRecord<Record<string, unknown>>(doc.data()));
      expect(memories.map((memory) => memory.content).sort()).toEqual([
        'Maria prefers calls to email.',
        'The owner declines meetings before 10am.',
      ]);
      for (const memory of memories) {
        expect(memory).toMatchObject({
          source: 'dream',
          quarantined: true,
          originTrust: 'assistant',
          kind: 'preference',
          sourceTaskId: taskId,
        });
        expect((memory.expiresAt as Date).getTime()).toBeGreaterThan(now + 59 * DAY);
      }
      const ownerMemory = memories.find((memory) => String(memory.content).startsWith('The owner'));
      expect(ownerMemory).toMatchObject({ confidence: '0.40', subjectContactId: ownerContactId });
      const maria = await store.collection('contacts').where('name', '==', 'Maria').get();
      expect(maria.size).toBe(1);
      expect(
        memories.find((memory) => String(memory.content).startsWith('Maria'))?.subjectContactId,
      ).toBe(maria.docs[0]?.get('id'));

      const notes = (await store.collection('dreamNotes').where('agentId', '==', agentId).get())
        .docs;
      expect(notes.map((doc) => doc.get('kind')).sort()).toEqual(['anticipation', 'footnote']);

      const marker = await store.doc('notificationConversations', agentId).get();
      const messages = await store
        .collection('messages')
        .where('conversationId', '==', marker.get('conversationId'))
        .get();
      expect(messages.docs.map((doc) => doc.get('text'))).toEqual([
        expect.stringContaining('2 patterns I noticed are waiting'),
      ]);
    });

    it('skips a quiet day without calling the model', async () => {
      const done = await task({ status: 'done', hours: 2 });
      await decision(done, 'approved', 'Only one decision');
      expect((await runJob()).detail).toBe(
        'dream: 0 footnote(s), 0 hypothesis(es), 0 anticipation(s)',
      );
      expect(prompts).toEqual([]);
    });
  },
);
