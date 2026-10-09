import { randomUUID } from 'node:crypto';
import { type ExecutorDeps, executeTask } from '@assistant/core';
import type { Db } from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  FirestoreSelfImprovementRepository,
} from '@assistant/firestore';
import type { ExecutionPersistence } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeRecord, type InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SPACE = { provider: 'synthetic', model: 'improve-fixture', dimensions: 1536, revision: '1' };
const VECTOR = Array.from({ length: 1536 }, (_, i) => (i === 2 ? 1 : 0));

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore self-improvement review job',
  { timeout: 30_000 },
  () => {
    const agentId = randomUUID();
    let store: InstallationStore;
    let persistence: ExecutionPersistence;
    let deps: ExecutorDeps;
    let prompts: string[];
    const now = Date.now();
    const hoursAgo = (hours: number) => new Date(now - hours * HOUR);
    const proposals = [
      {
        kind: 'note',
        title: 'Browser selectors are brittle',
        rationale: 'Two failures',
        role: '',
        primaryModel: '',
        fallbackModel: '',
        toolName: '',
        suggestion: 'Prefer the site API.',
      },
      {
        kind: 'model_role',
        title: 'Swap the draft model',
        rationale: 'Degraded steps',
        role: 'draft',
        primaryModel: 'fixture/strong',
        fallbackModel: '',
        toolName: '',
        suggestion: '',
      },
    ];

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
        async object(_role: string, input: { prompt: string }) {
          prompts.push(input.prompt);
          return { ok: true, modelId: 'fixture', degraded: false, object: { proposals } };
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
    });

    afterEach(async () => {
      await disposeStore(store);
    });

    async function put(collection: string, row: Record<string, unknown>) {
      const id = typeof row.id === 'string' ? row.id : randomUUID();
      await store.doc(collection, id).set(encodeRecord({ ...row, id }));
      return id;
    }

    async function task(input: {
      status: string;
      attempt?: number;
      agent?: string;
      hours?: number;
    }) {
      return put('tasks', {
        agentId: input.agent ?? agentId,
        type: 'adhoc',
        trust: 'owner',
        status: input.status,
        attempt: input.attempt ?? 1,
        progress: '',
        createdAt: hoursAgo((input.hours ?? 2) + 1),
        updatedAt: hoursAgo(input.hours ?? 2),
      });
    }

    async function seedWeek() {
      const mine = await task({ status: 'failed', attempt: 3 });
      await task({ status: 'needs_attention', attempt: 1 });
      await task({ status: 'failed', attempt: 2, hours: 10 * 24 });
      const foreign = await task({ status: 'failed', attempt: 5, agent: randomUUID() });
      for (const id of [
        '1111aaaa-0000-4000-8000-000000000001',
        '2222bbbb-0000-4000-8000-000000000002',
      ])
        await put('toolCalls', {
          taskId: mine,
          step: 0,
          toolName: 'browser.click',
          status: 'failed',
          error: `selector ${id} not found after 30 ms`,
          createdAt: hoursAgo(3),
        });
      await put('toolCalls', {
        taskId: foreign,
        step: 0,
        toolName: 'gmail.send',
        status: 'failed',
        error: 'foreign failure',
        createdAt: hoursAgo(3),
      });
      await put('toolCalls', {
        taskId: foreign,
        step: 1,
        toolName: 'gmail.send',
        status: 'failed',
        error: 'foreign failure',
        createdAt: hoursAgo(3),
      });
      for (const [taskId, costUsd, role] of [
        [mine, '0.250000', 'plan'],
        [mine, '0.050000', 'draft'],
        [foreign, '0.900000', 'reason'],
      ] as const)
        await put('modelCalls', {
          taskId,
          role,
          model: 'fixture',
          inputTokens: 1,
          outputTokens: 1,
          costUsd,
          latencyMs: null,
          finishReason: null,
          openrouterGenerationId: null,
          createdAt: hoursAgo(4),
        });
      for (const taskId of [mine, mine, foreign])
        await put('responseChecks', {
          taskId,
          promptVersion: 1,
          plannerVersion: null,
          blocked: true,
          unsupportedCount: 2,
          mustActRetries: 0,
          degradedSteps: 1,
          outputVerificationAttempted: true,
          outputVerificationRevised: false,
          outputVerificationUnavailable: false,
          createdAt: hoursAgo(5),
        });
      for (const [status, hours] of [
        ['failed', 30],
        ['failed', 30],
        // Fresh graph work is expected, so this lease is not a signal.
        ['pending', 0],
      ] as const)
        await put('knowledgeGraphSources', {
          agentId,
          memoryId: randomUUID(),
          status,
          lastError: null,
          contentHash: randomUUID(),
          subjectContactId: null,
          extractionVersion: 1,
          nextRetryAt: null,
          attempts: 1,
          createdAt: hoursAgo(hours + 1),
          updatedAt: hoursAgo(hours),
        });
    }

    async function runJob(): Promise<string | undefined> {
      const { task: created } = await persistence.tasks.createTask({
        agentId,
        type: 'scheduled',
        trust: 'assistant',
        trigger: { source: 'schedule', payload: { job: 'self.improve' } },
      });
      const result = await executeTask(deps, created.id);
      expect(result.outcome).toBe('done');
      return result.detail;
    }

    it("reviews only the owner's week, saves the experience, and drafts proposals once", async () => {
      await seedWeek();
      await put('improvementProposals', {
        agentId,
        kind: 'model_role',
        title: 'Swap the draft model',
        status: 'dismissed',
        rationale: 'Imported',
        change: {},
        evidenceIds: [],
        createdAt: new Date(now - 3 * DAY),
        updatedAt: new Date(now - 3 * DAY),
      });

      expect(await runJob()).toBe(
        'self-improve: 1 proposal(s) from 6 failure pattern(s), experience saved',
      );
      const prompt = prompts[0] ?? '';
      expect(prompt).toContain('- browser.click failed 2× — "selector <id> not found after # ms"');
      expect(prompt).toContain('- 1 task(s) needed attention after retries');
      expect(prompt).toContain('- expensive plan call: $0.250');
      expect(prompt).toContain(
        '- response contract corrected 2 response(s) with 4 unsupported claim(s)',
      );
      expect(prompt).toContain('- 2 step(s) used fallback models');
      expect(prompt).toContain('- GraphRAG has 2 failed source extraction(s)');
      expect(prompt).not.toContain('pending for over 10 minutes');
      for (const excluded of ['gmail.send', 'reason call', 'draft call'])
        expect(prompt).not.toContain(excluded);

      const experience = await store
        .collection('memories')
        .where('agentId', '==', agentId)
        .where('source', '==', 'self-improve')
        .get();
      expect(experience.size).toBe(1);
      expect(experience.docs[0]?.data()).toMatchObject({
        category: 'experience',
        kind: 'episode',
        quarantined: false,
        originTrust: 'assistant',
      });

      const drafted = await store
        .collection('improvementProposals')
        .where('agentId', '==', agentId)
        .get();
      expect(drafted.docs.map((doc) => [doc.get('title'), doc.get('status')]).sort()).toEqual([
        ['Browser selectors are brittle', 'open'],
        ['Swap the draft model', 'dismissed'],
      ]);
      const note = drafted.docs.find((doc) => doc.get('kind') === 'note');
      expect(note?.get('change')).toEqual({ suggestion: 'Prefer the site API.' });
      expect(note?.get('evidenceIds')).toContain(
        'browser.click:selector <id> not found after # ms',
      );

      const marker = await store.doc('notificationConversations', agentId).get();
      const messages = await store
        .collection('messages')
        .where('conversationId', '==', marker.get('conversationId'))
        .get();
      expect(messages.docs.map((doc) => doc.get('text'))).toEqual([
        expect.stringContaining('I drafted 1 improvement proposal from'),
      ]);
    });

    it('stays quiet on a healthy week', async () => {
      await task({ status: 'done' });
      expect(await runJob()).toBe('self-improve: 0 proposal(s) from 0 failure pattern(s)');
      expect(prompts).toEqual([]);
    });

    it('keeps ordered fields available to cursors after projected signal scans exceed one page', async () => {
      const ownerTaskId = await task({ status: 'done' });
      for (let start = 0; start < 501; start += 250) {
        const batch = store.db.batch();
        for (let index = start; index < Math.min(start + 250, 501); index += 1) {
          const createdAt = hoursAgo(1);
          const toolCallId = `paged-failure-${String(index).padStart(3, '0')}`;
          batch.set(store.doc('toolCalls', toolCallId), {
            id: toolCallId,
            taskId: ownerTaskId,
            toolName: 'test.paged_failure',
            status: 'failed',
            error: 'synthetic paged failure',
            createdAt,
          });
          const modelCallId = `paged-model-${String(index).padStart(3, '0')}`;
          batch.set(store.doc('modelCalls', modelCallId), {
            id: modelCallId,
            taskId: ownerTaskId,
            role: 'draft',
            model: 'fixture',
            costUsd: '0.020000',
            createdAt,
          });
        }
        await batch.commit();
      }

      for (let start = 0; start < 501; start += 250) {
        const batch = store.db.batch();
        for (let index = start; index < Math.min(start + 250, 501); index += 1) {
          const taskId = `paged-stuck-${String(index).padStart(3, '0')}`;
          batch.set(store.doc('tasks', taskId), {
            id: taskId,
            agentId,
            type: 'adhoc',
            trust: 'owner',
            status: 'needs_attention',
            attempt: 2,
            progress: '',
            createdAt: hoursAgo(2),
            updatedAt: hoursAgo(1),
          });
        }
        await batch.commit();
      }

      const signals = await new FirestoreSelfImprovementRepository(store, agentId).signals({
        agentId,
        since: hoursAgo(24),
        staleBefore: hoursAgo(10),
        costOutlierUsd: 0.01,
        outlierLimit: 10,
      });
      expect(signals.failedCalls).toHaveLength(501);
      expect(signals.costOutliers).toHaveLength(10);
      expect(signals.stuckCount).toBe(501);
    });
  },
);
