import { randomUUID } from 'node:crypto';
import { handleChatTurn } from '@assistant/application';
import { loadConfig, resetConfigForTest } from '@assistant/config';
import type { ModelRouter } from '@assistant/core';
import {
  contacts,
  createPostgresApplicationChatPersistence,
  occasions,
  tasks,
} from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import { FirestoreApplicationChatPersistence } from '@assistant/firestore';
import { chatAdmissionPayload, type EmbeddingSpace } from '@assistant/persistence';
import type { ModelMessage } from 'ai';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { disposeStore, seedBudget } from '../../../packages/firestore/src/test-store.js';
import { buildDeps, composeFirestoreAgent } from './deps.js';
import { executeAgentTask } from './task-runner.js';

const SPACE: EmbeddingSpace = {
  provider: 'offline-test',
  model: 'f1-occasion-correction',
  dimensions: 1536,
  revision: '1',
};
const MODEL_ID = 'synthetic/f1-occasion-correction';
const LABEL = 'Pottery Club Day';
const CORRECTION =
  'Change Mira Vale’s saved occasion named Pottery Club Day from April 12 to April 14.';
const READ = 'List the upcoming saved occasions for Mira Vale and Rowan Reed.';
const CHANGE_ARGS = {
  subject: 'Mira Vale',
  kind: 'custom',
  label: LABEL,
  expectedDate: { month: 4, day: 12 },
  date: { month: 4, day: 14 },
};
type ReadOccasion = { person: string; kind: string; date: string };

function scriptedRouter(operationId: string, toolName: string, input: unknown): ModelRouter {
  let called = false;
  const result = { ok: true, modelId: MODEL_ID, degraded: false };
  return {
    async route() {
      return {
        ...result,
        model: {} as never,
        thinking: false,
        decision: { mode: 'primary' },
        params: {},
        promptCostPerMTok: 0,
        completionCostPerMTok: 0,
      };
    },
    async object(role: string) {
      let object: unknown = { decision: 'publish', reasons: [] };
      if (role === 'classify') object = { needsAction: true };
      if (role === 'plan') {
        object = {
          action: 'workflow',
          reasoning: 'The owner asked to use saved recurring occasions.',
          steps: ['Use the saved-occasion tool for the request.'],
          missingInfo: [],
        };
      }
      return { ...result, object };
    },
    async embeddingSpace() {
      return SPACE;
    },
    async embed(values: string[]) {
      return values.map(() =>
        Array.from({ length: SPACE.dimensions }, (_, index) => (index === 0 ? 1 : 0)),
      );
    },
    async step(
      _role: string,
      opts: { tools?: Record<string, unknown>; messages?: ModelMessage[] },
    ) {
      if (!called) {
        expect(opts.tools?.[toolName]).toBeDefined();
        called = true;
        return {
          ...result,
          text: '',
          toolCalls: [{ toolCallId: operationId, toolName, input }],
          finishReason: 'tool-calls',
        };
      }
      // The correction draft intentionally overclaims, including on ambiguity.
      // The answer must be grounded in the current operation's result.
      let text = 'I changed Mira Vale’s anniversary to April 16.';
      if (toolName === 'occasions.list') {
        const read = opts.messages
          ?.flatMap((message) => (message.role === 'tool' ? message.content : []))
          .find(
            (part) =>
              part.type === 'tool-result' &&
              part.toolCallId === operationId &&
              part.toolName === toolName,
          );
        if (read?.type !== 'tool-result' || read.output.type !== 'json')
          throw new Error('Missing current occasions read result');
        const { occasions } = read.output.value as { occasions: ReadOccasion[] };
        text = occasions
          .map((item) => `${item.person} has ${item.kind} on ${item.date}.`)
          .join(' ');
      }
      return {
        ...result,
        text,
        toolCalls: [],
        finishReason: 'stop',
      };
    },
  } as unknown as ModelRouter;
}

describe.each(['postgres', 'firestore'] as const)(
  'F1 occasion correction through owner chat (%s)',
  (driver) => {
    it.skipIf(driver === 'firestore' && !process.env.FIRESTORE_EMULATOR_HOST)(
      'recovers one update and deletion from the same chat turns and verifies fresh readback',
      async () => {
        const databaseUrl = process.env.DATABASE_URL;
        const firestore = driver === 'firestore';
        const fsAgentId = randomUUID();
        const installationId = `f1-${randomUUID()}`;
        if (firestore) {
          expect(process.env.FIRESTORE_EMULATOR_HOST).toMatch(/^(?:127\.0\.0\.1|localhost):\d+$/);
        } else {
          assertAllocatedTestTarget({
            databaseUrl,
            testDatabaseUrl: process.env.TEST_DATABASE_URL,
            token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
            kind: 'standard',
          });
        }
        vi.stubEnv('PERSISTENCE_DRIVER', driver);
        vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-not-a-real-key');
        vi.stubEnv('QUEUE_DRIVER', 'local');
        vi.stubEnv('CHAT_RECALL_ENABLED', 'false');
        vi.stubEnv('GRAPH_RAG_ENABLED', 'false');
        vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
        resetConfigForTest();
        const deps = firestore
          ? composeFirestoreAgent(
              loadConfig({
                NODE_ENV: 'test',
                PERSISTENCE_DRIVER: driver,
                OPENROUTER_API_KEY: 'synthetic-not-a-real-key',
                QUEUE_DRIVER: 'local',
                CHAT_RECALL_ENABLED: 'false',
                GRAPH_RAG_ENABLED: 'false',
                GCP_PROJECT: 'demo-assistant-test',
                FIRESTORE_AGENT_ID: fsAgentId,
                ASSISTANT_WORKSPACE_ID: installationId,
                FIRESTORE_EMBEDDING_SPACE: JSON.stringify(SPACE),
              }),
            )
          : buildDeps();
        const store = deps.firestoreStore;
        const persistence = deps.persistence;
        if (!persistence) throw new Error('Missing execution persistence');
        const chat = store
          ? new FirestoreApplicationChatPersistence(store, fsAgentId)
          : createPostgresApplicationChatPersistence(deps.db);

        try {
          if (store) {
            await store.doc('agents', fsAgentId).set({
              id: fsAgentId,
              name: 'Synthetic owner',
              timezone: 'UTC',
            });
            await seedBudget(store);
          }
          const { id: agentId } = await chat.resolveAgent();
          const mira = { id: randomUUID(), name: 'Mira Vale' };
          const rowan = { id: randomUUID(), name: 'Rowan Reed' };
          const contactFields = {
            aliases: [],
            emails: [],
            phones: [],
            relationship: '',
            trust: 'known',
            identityAuthority: 'owner' as const,
            notes: '',
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          const addContact = async (person: typeof mira) => {
            const contact = { ...contactFields, ...person };
            if (store) await store.doc('contacts', person.id).set({ ...contact, agentId });
            else await deps.db.insert(contacts).values(contact);
          };
          await addContact(mira);
          await addContact(rowan);
          const readRowan = async () =>
            store
              ? (await store.doc('contacts', rowan.id).get()).data()
              : (await deps.db.select().from(contacts).where(eq(contacts.id, rowan.id)))[0];
          const rowanBefore = await readRowan();
          expect(rowanBefore).toMatchObject(rowan);
          const fixtureRows = [mira, rowan].map((person, index) => ({
            id: randomUUID(),
            agentId,
            contactId: person.id,
            kind: 'custom',
            label: LABEL,
            month: 4,
            day: index === 0 ? 12 : 18,
            year: 2020,
            recurrence: 'annual',
            leadDays: 5,
            notes: 'Bring a handmade card.',
            originTrust: 'owner',
            ownerConfirmed: true,
            quarantined: false,
            source: 'profile',
            createdAt: new Date(),
            updatedAt: new Date(),
          }));
          if (store) {
            for (const row of fixtureRows) await store.doc('occasions', row.id).set(row);
          } else {
            await deps.db.insert(occasions).values(fixtureRows);
          }
          const readStored = async () =>
            store
              ? (
                  await store.collection('occasions').where('agentId', '==', agentId).get()
                ).docs.map((row) => row.data() as (typeof fixtureRows)[number])
              : deps.db.select().from(occasions).where(eq(occasions.agentId, agentId));

          const turn = async (
            text: string,
            toolName: string,
            args: unknown,
            options: {
              allowClarification?: boolean;
              recover?: 'updated' | 'deleted';
              reviseAfterRollback?: () => Promise<void>;
            } = {},
          ) => {
            const conversation = await chat.createConversation(agentId);
            const clientOperationId = randomUUID();
            const modelOperationId = randomUUID();
            const router = scriptedRouter(modelOperationId, toolName, args);
            const response = await handleChatTurn(
              new Request('https://assistant.example/api/chat', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  conversationId: conversation.id,
                  clientOperationId,
                  messages: [{ id: randomUUID(), role: 'user', parts: [{ type: 'text', text }] }],
                }),
              }),
              {
                config: deps.config,
                router,
                chat,
                persistence,
                ...(!store ? { db: deps.db } : {}),
              },
            );
            const body = await response.text();
            expect(response.status, body).toBe(200);
            const taskId = response.headers.get('x-async-task');
            const ownerMessageId = response.headers.get('x-owner-message-id');
            if (!taskId || !ownerMessageId)
              throw new Error(`Chat did not queue an owner turn: ${body}`);
            const task = await persistence.tasks.getTask(taskId);
            if (!task) throw new Error('Missing admitted task');
            expect(chatAdmissionPayload(task)).toMatchObject({
              clientOperationId,
              triggerMessageId: ownerMessageId,
              phase: 'queued',
            });
            const runTurn = () => executeAgentTask({ ...deps, router }, taskId);
            const due = async () => {
              const runAfter = new Date(0);
              if (store) await store.doc('tasks', taskId).update({ runAfter });
              else await deps.db.update(tasks).set({ runAfter }).where(eq(tasks.id, taskId));
            };
            const readReceipt = async () =>
              (await persistence.executionEvidence.taskEvidence({ agentId, taskId })).find(
                (entry) => entry.toolName === toolName,
              );
            type PhaseEvidence = {
              records: Awaited<ReturnType<typeof readStored>>;
              receipt: Awaited<ReturnType<typeof readReceipt>>;
              worker: Awaited<ReturnType<typeof runTurn>>;
            };
            let completed: Awaited<ReturnType<typeof runTurn>>;
            let recovery:
              | {
                  beforeCommitFailure: PhaseEvidence;
                  afterCommitFailure: PhaseEvidence;
                  afterResume: PhaseEvidence;
                  mismatches: unknown[];
                }
              | undefined;
            if (options.recover) {
              const operationId = `${taskId}-${toolName.replace('.', '-')}`;
              const failBeforeCommit = <T>(result: T): T => {
                const mutation = result as { operationId?: string; outcome?: string } | null;
                if (mutation?.operationId === operationId && mutation?.outcome === options.recover)
                  throw new Error('synthetic stop before commit');
                return result;
              };
              const before = await readStored();
              const postgresTransaction = store ? undefined : deps.db.transaction.bind(deps.db);
              const firestoreTransaction = store?.db.runTransaction.bind(store.db);
              const preCommitHook =
                store && firestoreTransaction
                  ? vi
                      .spyOn(store.db, 'runTransaction')
                      .mockImplementation((work, transactionOptions) =>
                        firestoreTransaction(
                          async (tx) => failBeforeCommit(await work(tx)),
                          transactionOptions,
                        ),
                      )
                  : postgresTransaction
                    ? vi
                        .spyOn(deps.db, 'transaction')
                        .mockImplementation((work, transactionOptions) =>
                          postgresTransaction(
                            async (tx) => failBeforeCommit(await work(tx)),
                            transactionOptions,
                          ),
                        )
                    : undefined;
              const failedBeforeCommit = await runTurn().finally(() =>
                preCommitHook?.mockRestore(),
              );
              expect(failedBeforeCommit).toMatchObject({
                outcome: 'failed',
                detail: expect.stringContaining('synthetic stop before commit'),
              });
              const beforeCommitFailure = {
                records: await readStored(),
                receipt: await readReceipt(),
                worker: failedBeforeCommit,
              };
              expect(beforeCommitFailure.records).toEqual(expect.arrayContaining(before));
              expect(beforeCommitFailure.records).toHaveLength(before.length);
              expect(beforeCommitFailure.receipt).toMatchObject({
                status: 'executing',
                result: null,
                decision: {
                  modelToolCallId: operationId,
                  occasionMutation: {
                    occasionId: fixtureRows[0]?.id,
                    contactId: mira.id,
                    expectedVersion: expect.any(String),
                  },
                },
              });
              await options.reviseAfterRollback?.();
              const beforeResume = await readStored();

              const load = persistence.toolExecution.load.bind(persistence.toolExecution);
              const postCommitHook = vi
                .spyOn(persistence.toolExecution, 'load')
                .mockImplementation(async (...loadArgs) => {
                  const row = await load(...loadArgs);
                  if (
                    row?.task.id === taskId &&
                    row.toolCall.toolName === toolName &&
                    row.toolCall.status === 'succeeded'
                  )
                    throw new Error('synthetic stop after durable write');
                  return row;
                });
              let failedAfterCommit: Awaited<ReturnType<typeof runTurn>>;
              try {
                await due();
                failedAfterCommit = await runTurn();
              } finally {
                postCommitHook.mockRestore();
              }
              expect(failedAfterCommit).toMatchObject({
                outcome: 'failed',
                detail: expect.stringContaining('synthetic stop after durable write'),
              });
              const afterCommitFailure = {
                records: await readStored(),
                receipt: await readReceipt(),
                worker: failedAfterCommit,
              };
              expect(afterCommitFailure.receipt).toMatchObject({
                id: beforeCommitFailure.receipt?.id,
                status: 'succeeded',
                decision: beforeCommitFailure.receipt?.decision,
                result: {
                  operationId,
                  outcome: options.reviseAfterRollback ? 'stale_target' : options.recover,
                },
              });
              if (options.reviseAfterRollback) {
                expect(afterCommitFailure.records).toEqual(expect.arrayContaining(beforeResume));
                expect(afterCommitFailure.records).toHaveLength(beforeResume.length);
              }
              const originalDispatch = deps.dispatcher.dispatch.bind(deps.dispatcher);
              const mismatches: unknown[] = [];
              const resumeHook = vi
                .spyOn(deps.dispatcher, 'dispatch')
                .mockImplementation(async (input) => {
                  if (input.task.id === taskId && input.toolName === toolName) {
                    mismatches.push(
                      await originalDispatch({
                        ...input,
                        args: { ...input.args, subject: 'Rowan Reed' },
                      }),
                    );
                  }
                  return originalDispatch(input);
                });
              try {
                await due();
                completed = await runTurn();
              } finally {
                resumeHook.mockRestore();
              }
              const afterResume = {
                records: await readStored(),
                receipt: await readReceipt(),
                worker: completed,
              };
              expect(mismatches).toEqual([
                { kind: 'rejected', reason: 'transactional call arguments cannot be verified' },
              ]);
              expect(afterResume.records).toEqual(
                expect.arrayContaining(afterCommitFailure.records),
              );
              expect(afterResume.records).toHaveLength(afterCommitFailure.records.length);
              expect(afterResume.receipt).toEqual(afterCommitFailure.receipt);
              recovery = { beforeCommitFailure, afterCommitFailure, afterResume, mismatches };
            } else {
              completed = await runTurn();
            }
            const evidence = await persistence.executionEvidence.taskEvidence({ agentId, taskId });
            expect(
              options.allowClarification ? ['done', 'needs_attention'] : ['done'],
              JSON.stringify({ completed, evidence }),
            ).toContain(completed.outcome);
            const toolReceipts = evidence.filter((entry) => entry.toolName === toolName);
            expect(toolReceipts).toHaveLength(1);
            const receipt = toolReceipts[0];
            expect(receipt).toMatchObject({ status: 'succeeded', args });
            const history = await chat.listMessages(agentId, conversation.id, { limit: 20 });
            expect(history?.messages).toContainEqual(
              expect.objectContaining({ id: ownerMessageId, taskId, role: 'user', text }),
            );
            const reply = history?.messages.find(
              (row) => row.taskId === taskId && row.role === 'assistant',
            )?.text;
            expect(reply).toBeTruthy();
            return {
              conversationId: conversation.id,
              clientOperationId,
              modelOperationId,
              taskId,
              ownerMessageId,
              receipt,
              reply,
              recovery,
            };
          };

          const before = await readStored();
          const original = before.find((row) => row.contactId === mira.id);
          const unrelated = before.find((row) => row.contactId === rowan.id);
          expect(original).toMatchObject({ month: 4, day: 12 });
          expect(unrelated).toMatchObject({ month: 4, day: 18 });

          const edit = await turn(CORRECTION, 'occasions.update', CHANGE_ARGS, {
            recover: 'updated',
          });
          const toolOperationId = (edit.receipt?.decision as { modelToolCallId?: string })
            ?.modelToolCallId;
          expect(toolOperationId).toBeTruthy();
          expect(edit.receipt?.result).toMatchObject({
            ok: true,
            outcome: 'updated',
            operationId: toolOperationId,
            occasion: { id: original?.id, contactId: mira.id, month: 4, day: 14, year: 2020 },
          });
          expect(edit.reply).toMatch(/April 14|04-14|4\/14/i);
          expect(edit.reply).not.toMatch(/April 16|04-16|4\/16/i);
          const after = await readStored();
          const changed = after.find((row) => row.contactId === mira.id);
          expect(after).toHaveLength(before.length);
          expect(changed).toEqual({ ...original, day: 14, updatedAt: changed?.updatedAt });
          expect(after.find((row) => row.contactId === rowan.id)).toEqual(unrelated);

          const fresh = await turn(READ, 'occasions.list', { withinDays: 366 });
          expect(fresh.conversationId).not.toBe(edit.conversationId);
          expect(fresh.reply).toMatch(/Mira Vale.*04-14/);
          expect(fresh.reply).toMatch(/Rowan Reed.*04-18/);
          expect(fresh.reply).not.toContain('04-12');
          expect(fresh.receipt?.result).toMatchObject({
            occasions: expect.arrayContaining([
              expect.objectContaining({
                person: mira.name,
                date: expect.stringMatching(/-04-14$/),
              }),
              expect.objectContaining({
                person: rowan.name,
                date: expect.stringMatching(/-04-18$/),
              }),
            ]),
          });
          const duplicate = { id: randomUUID(), name: mira.name };
          await addContact(duplicate);
          const ambiguous = await turn(
            'Change Mira Vale’s saved occasion named Pottery Club Day from April 14 to April 15.',
            'occasions.update',
            { ...CHANGE_ARGS, expectedDate: { month: 4, day: 14 }, date: { month: 4, day: 15 } },
            { allowClarification: true },
          );
          const ambiguousOperationId = (ambiguous.receipt?.decision as { modelToolCallId?: string })
            ?.modelToolCallId;
          expect(ambiguousOperationId).toBeTruthy();
          expect(ambiguous.receipt?.result).toMatchObject({
            ok: false,
            outcome: 'ambiguous_contact',
            operationId: ambiguousOperationId,
          });
          expect(ambiguous.reply).toMatch(/which|clarif|more than one|multiple/i);
          expect(ambiguous.reply).not.toMatch(/I changed/i);
          const afterAmbiguous = await readStored();
          expect(afterAmbiguous).toEqual(expect.arrayContaining(after));
          expect(afterAmbiguous).toHaveLength(after.length);
          if (store) await store.doc('contacts', duplicate.id).delete();
          else await deps.db.delete(contacts).where(eq(contacts.id, duplicate.id));
          const { date: savedDate, ...target } = CHANGE_ARGS;
          if (!original) throw new Error('Mira’s fixture occasion is missing');
          const stale = await turn(
            'Change Mira Vale’s saved occasion named Pottery Club Day from April 14 to April 15.',
            'occasions.update',
            { ...target, expectedDate: savedDate, date: { month: 4, day: 15 } },
            {
              recover: 'updated',
              allowClarification: true,
              async reviseAfterRollback() {
                // Change the saved row version between attempts without changing the target date.
                const updatedAt = new Date('2026-10-01T00:00:00.000Z');
                if (store) await store.doc('occasions', original.id).update({ updatedAt });
                else
                  await deps.db
                    .update(occasions)
                    .set({ updatedAt })
                    .where(eq(occasions.id, original.id));
              },
            },
          );
          expect(stale.receipt?.result).toMatchObject({ ok: false, outcome: 'stale_target' });
          expect(stale.reply).toMatch(/saved occasion changed/i);
          const deletion = await turn(
            'Remove Mira Vale’s saved occasion named Pottery Club Day on April 14.',
            'occasions.delete',
            { ...target, expectedDate: savedDate },
            { recover: 'deleted' },
          );
          expect(deletion.receipt?.result).toMatchObject({
            ok: true,
            outcome: 'deleted',
            operationId: `${deletion.taskId}-occasions-delete`,
            occasion: { id: original?.id, contactId: mira.id, month: 4, day: 14, year: 2020 },
          });
          expect(deletion.reply).toMatch(/Deleted Mira Vale/i);
          const afterDelete = await readStored();
          expect(afterDelete).toEqual(after.filter((row) => row.id !== original?.id));
          const freshAfterDelete = await turn(READ, 'occasions.list', { withinDays: 366 });
          expect(freshAfterDelete.conversationId).not.toBe(deletion.conversationId);
          expect(freshAfterDelete.reply).toMatch(/Rowan Reed.*04-18/);
          expect(freshAfterDelete.reply).not.toContain('Mira Vale');
          expect(freshAfterDelete.receipt?.result).toMatchObject({
            occasions: expect.not.arrayContaining([expect.objectContaining({ person: mira.name })]),
          });
          const rowanAfter = await readRowan();
          expect(rowanAfter).toEqual(rowanBefore);

          console.info(
            'F1_OCCASION_EVIDENCE',
            JSON.stringify({
              driver,
              before,
              edit,
              after,
              fresh,
              ambiguous,
              afterAmbiguous,
              stale,
              deletion,
              afterDelete,
              freshAfterDelete,
              rowanBefore,
              rowanAfter,
            }),
          );
        } finally {
          try {
            if (store) await disposeStore(store);
            else
              await (deps.db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
          } finally {
            resetConfigForTest();
            vi.unstubAllEnvs();
          }
        }
      },
      45_000,
    );
  },
);
