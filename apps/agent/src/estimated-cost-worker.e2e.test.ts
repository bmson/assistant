import { createHash, randomUUID } from 'node:crypto';
import { handleChatTurn } from '@assistant/application';
import { loadConfig, resetConfigForTest } from '@assistant/config';
import { type ModelProvider, ModelRouter } from '@assistant/core/model-router';
import {
  createFirestoreEstimatedCostQuotePreparer,
  createFirestoreEstimatedCostTurnParking,
  createFirestoreExecutionPersistence,
  FirestoreApplicationChatPersistence,
  FirestoreModelRoutingRepository,
} from '@assistant/firestore';
import { type EmbeddingSpace, MODEL_ROLE_NAMES } from '@assistant/persistence';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirestoreCostRepository } from '../../../packages/firestore/src/costs.js';
import {
  approveFirestoreEstimatedCost,
  storePreparedFirestoreQuote,
} from '../../../packages/firestore/src/estimated-cost-approval-transactions.js';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import {
  disposeStore,
  emulatorStore,
  seedBudget,
} from '../../../packages/firestore/src/test-store.js';
import type { AgentDeps } from './deps.js';
import { executeAgentTask } from './task-runner.js';

const SPACE: EmbeddingSpace = {
  provider: 'synthetic',
  model: 'worker-test',
  dimensions: 1536,
  revision: '1',
};
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'estimated cost worker operation isolation',
  () => {
    let store: InstallationStore;
    afterEach(async () => {
      vi.restoreAllMocks();
      if (store) await disposeStore(store);
    });
    it.each([
      'classify',
      'draft',
      'lost_park',
      'lost_decision',
      'exhausted',
      'expired',
      'transition_exhausted',
      'lost_renewal',
    ] as const)(
      'parks A at %s, completes B, then resumes A under its grant',
      async (boundary) => {
        resetConfigForTest();
        store = emulatorStore();
        const agentId = randomUUID();
        await store.doc('agents', agentId).set({
          id: agentId,
          name: 'Synthetic owner',
          email: `${agentId}@example.test`,
          timezone: 'UTC',
        });
        await seedBudget(store, 1, 10);
        await store.doc('models', 'test/model').set({
          id: 'test/model',
          label: 'Synthetic',
          enabled: true,
          capabilities: {},
          promptCostPerMTok: '100',
          completionCostPerMTok: '0.001',
          latencyClass: 'fast',
        });
        await store.doc('models', 'test/cheap').set({
          id: 'test/cheap',
          label: 'Cheap synthetic',
          enabled: true,
          capabilities: {},
          promptCostPerMTok: '0.001',
          completionCostPerMTok: '0.001',
          latencyClass: 'fast',
        });
        await store.doc('models', 'test/draft').set({
          id: 'test/draft',
          label: 'Draft synthetic',
          enabled: true,
          capabilities: {},
          promptCostPerMTok: '30',
          completionCostPerMTok: '0.001',
          latencyClass: 'fast',
        });
        await store.doc('modelConnections', 'openrouter').set({
          id: 'openrouter',
          kind: 'openrouter',
          enabled: true,
          apiKeyEncrypted: 'synthetic',
        });
        for (const role of MODEL_ROLE_NAMES)
          await store
            .doc('modelRoles', role)
            .set({ role, primaryModel: 'test/model', fallbackModel: 'test/model', params: {} });
        for (const role of boundary !== 'draft' ? ['draft', 'reason'] : ['classify'])
          await store
            .doc('modelRoles', role)
            .update({ primaryModel: 'test/cheap', fallbackModel: 'test/cheap' });
        if (boundary === 'draft')
          for (const role of ['draft', 'reason'])
            await store
              .doc('modelRoles', role)
              .update({ primaryModel: 'test/draft', fallbackModel: 'test/draft' });
        const costs = new FirestoreCostRepository(store);
        const historical = await costs.reserve({ source: 'model', estimatedUsd: 0.95 });
        if (!historical.ok) throw new Error('fixture reservation failed');
        await store.doc('costReservations', historical.reservationId).update({ status: 'unknown' });
        const rows = [{ reservationId: historical.reservationId, estimatedMicros: 950_000 }];
        await store.doc('estimatedCostBaselines', store.installationId).set({
          installationId: store.installationId,
          ownerId: agentId,
          rows,
          digest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
          createdAt: new Date(),
        });
        const model = new MockLanguageModelV3({
          doGenerate: {
            content: [{ type: 'text', text: '{"needsAction":false}' }],
            finishReason: { unified: 'stop', raw: undefined },
            usage,
            warnings: [],
          },
          doStream: async () => ({
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: '1' },
                { type: 'text-delta', id: '1', delta: 'Synthetic completed reply.' },
                { type: 'text-end', id: '1' },
                { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
              ] as const,
            }),
          }),
        });
        const provider: ModelProvider = {
          kind: 'openrouter',
          assertModelId: vi.fn(),
          chat: () => model as unknown as LanguageModel,
          textEmbeddingModel: () => {
            throw new Error('No embedding');
          },
          optionsFor: () => undefined,
          embeddingOptions: () => undefined,
          cacheHint: () => undefined,
          normalizeUsage: () => ({ inputTokens: 10, outputTokens: 5, costUsd: 0.00001 }),
        };
        const router = new ModelRouter(
          new FirestoreModelRoutingRepository(store, agentId),
          '',
          'off',
          provider,
        );
        const chat = new FirestoreApplicationChatPersistence(store, agentId);
        const persistence = createFirestoreExecutionPersistence(store, agentId, SPACE);
        const config = loadConfig({
          NODE_ENV: 'test',
          PERSISTENCE_DRIVER: 'firestore',
          FIRESTORE_AGENT_ID: agentId,
          ASSISTANT_WORKSPACE_ID: store.installationId,
          FIRESTORE_EMBEDDING_SPACE: JSON.stringify(SPACE),
          OPENROUTER_API_KEY: 'synthetic',
          QUEUE_DRIVER: 'local',
          CHAT_RECALL_ENABLED: 'false',
          GRAPH_RAG_ENABLED: 'false',
          ESTIMATED_COST_APPROVAL_ENABLED: 'true',
        });
        const conversation = await chat.createConversation(agentId);
        const conversationB =
          boundary !== 'draft' ? conversation : await chat.createConversation(agentId);
        await store.doc('conversations', conversationB.id).update({ modelOverride: 'test/cheap' });
        const operationA = randomUUID(),
          operationB = randomUUID();
        const request = (operation: string, text: string, conversationId = conversation.id) =>
          new Request('http://localhost/api/chat', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-assistant-estimated-cost-approval': 'v1',
            },
            body: JSON.stringify({
              conversationId,
              clientOperationId: operation,
              messages: [{ id: randomUUID(), role: 'user', parts: [{ type: 'text', text }] }],
            }),
          });
        const parking = createFirestoreEstimatedCostTurnParking(store, {
          mutationsEnabled: () => true,
        });
        const hook =
          boundary === 'lost_park'
            ? {
                async park(input: Parameters<typeof parking.park>[0]) {
                  const saved = await parking.park(input);
                  if (saved.ok) throw new Error('synthetic lost response');
                  return saved;
                },
              }
            : parking;
        const textA = 'A '.repeat(3000);
        const a = await handleChatTurn(request(operationA, textA), {
          config,
          router,
          chat,
          persistence,
          estimatedCostTurnParking: hook,
        });
        const firstBody = await a.text();
        if (boundary === 'lost_park') expect(a.status).toBe(503);
        else expect(a.headers.get('x-estimated-cost-operation-id')).toBe(operationA);
        const taskId =
          boundary === 'lost_park'
            ? (JSON.parse(firstBody) as { taskId: string }).taskId
            : a.headers.get('x-async-task');
        if (!taskId) throw new Error('Missing task A');
        expect((await persistence.tasks.getTask(taskId))?.status).toBe('waiting_estimated_cost');
        if (boundary === 'lost_park')
          expect(
            await costs.readEstimatedCostView(
              { installationId: store.installationId, ownerId: agentId },
              operationA,
            ),
          ).toMatchObject({ request: { status: 'pending', operationId: operationA } });
        expect(model.doGenerateCalls).toHaveLength(boundary !== 'draft' ? 0 : 1);
        expect(model.doStreamCalls).toHaveLength(0);
        const b = await handleChatTurn(request(operationB, 'Hello B', conversationB.id), {
          config,
          router,
          chat,
          persistence,
          estimatedCostTurnParking: parking,
        });
        await b.arrayBuffer();
        expect(b.status).toBe(200);
        const before = await chat.listMessages(agentId, conversationB.id, { limit: 30 });
        const bTaskId = before!.messages.find(
          (row) => row.role === 'user' && row.text === 'Hello B',
        )?.taskId;
        if (!bTaskId) throw new Error('Missing task B');
        expect((await persistence.tasks.getTask(bTaskId))?.status).toBe('done');
        const bRows = before!.messages.filter((row) => row.taskId === bTaskId);
        const prepared = await createFirestoreEstimatedCostQuotePreparer(store, {
          mutationsEnabled: () => true,
        }).prepare(
          { installationId: store.installationId, ownerId: agentId },
          { operationId: operationA, quoteRequestId: randomUUID() },
        );
        if (!prepared.ok) throw new Error(`refresh unavailable: ${JSON.stringify(prepared)}`);
        expect((await storePreparedFirestoreQuote(store, prepared.prepared)).ok).toBe(true);
        const quote = prepared.prepared.quote;
        const decisionId = randomUUID();
        const decision = {
          operationId: operationA,
          quoteId: quote.quoteId,
          quoteVersion: quote.quoteVersion,
          decisionId,
          decision: 'approve' as const,
        };
        const approve = () =>
          approveFirestoreEstimatedCost(store, prepared.prepared.actor, decision);
        let approved: Awaited<ReturnType<typeof approve>>;
        if (boundary === 'lost_decision') {
          await expect(
            (async () => {
              await approve();
              throw new Error('synthetic response lost');
            })(),
          ).rejects.toThrow('synthetic response lost');
          approved = await costs
            .estimatedCostApprovalRepository()
            .getDecisionReceipt(prepared.prepared.actor, { operationId: operationA, decisionId });
        } else approved = await approve();
        expect(approved).toMatchObject({ ok: true, receipt: { status: 'approved' } });
        const task = await persistence.tasks.getTask(taskId);
        const marker = (
          task!.state as { estimatedCostApproval: { grantId: string; bindingDigest: string } }
        ).estimatedCostApproval;
        if (boundary === 'exhausted') {
          const exhaustedAttemptId = randomUUID();
          expect(
            await costs.drawEstimatedCostGrant({
              actor: prepared.prepared.actor,
              operationId: operationA,
              taskId,
              grantId: marker.grantId,
              bindingDigest: marker.bindingDigest,
              attemptId: exhaustedAttemptId,
              source: 'model',
              estimatedMicros: quote.allowanceMicros,
              description: 'synthetic exhausted allowance',
            }),
          ).toMatchObject({ ok: true });
          await store.doc('costReservations', exhaustedAttemptId).update({ status: 'dispatching' });
          await costs.reconcile(exhaustedAttemptId, { usd: 0.00001 });
        }
        let uncertainAttemptId: string | undefined;
        if (boundary === 'expired' || boundary === 'lost_renewal') {
          uncertainAttemptId = randomUUID();
          expect(
            await costs.drawEstimatedCostGrant({
              actor: prepared.prepared.actor,
              operationId: operationA,
              taskId,
              grantId: marker.grantId,
              bindingDigest: marker.bindingDigest,
              attemptId: uncertainAttemptId,
              source: 'model',
              estimatedMicros: 1,
              description: 'synthetic uncertain dispatch',
            }),
          ).toMatchObject({ ok: true });
          await store.doc('costReservations', uncertainAttemptId).update({ status: 'dispatching' });
          await costs.markAttemptUnknown(uncertainAttemptId, 'synthetic uncertain outcome');
          await store
            .doc('estimatedCostGrants', marker.grantId)
            .update({ expiresAt: new Date(Date.now() - 1000) });
        }
        const attemptsBeforeResume = model.doGenerateCalls.length + model.doStreamCalls.length;
        if (boundary === 'lost_renewal') {
          const repark = FirestoreCostRepository.prototype.parkEstimatedCostGrantRenewal;
          vi.spyOn(
            FirestoreCostRepository.prototype,
            'parkEstimatedCostGrantRenewal',
          ).mockImplementation(async function (this: FirestoreCostRepository, input) {
            const result = await repark.call(this, input);
            if (result) throw new Error('synthetic renewal response lost');
            return result;
          });
        }
        if (boundary === 'transition_exhausted') {
          const draw = FirestoreCostRepository.prototype.drawEstimatedCostGrant;
          let consumed = false;
          vi.spyOn(FirestoreCostRepository.prototype, 'drawEstimatedCostGrant').mockImplementation(
            async function (this: FirestoreCostRepository, input) {
              if (
                !consumed &&
                input.operationId === operationA &&
                input.description.startsWith('draft:')
              ) {
                consumed = true;
                const current = await store.doc('estimatedCostGrants', marker.grantId).get();
                const remaining = current.get('allowanceMicros') - current.get('consumedMicros');
                const attemptId = randomUUID();
                const reserved = await draw.call(this, {
                  ...input,
                  attemptId,
                  estimatedMicros: remaining,
                  description: 'synthetic remaining grant',
                });
                if (!reserved.ok) throw new Error('Cannot exhaust synthetic grant');
                await store.doc('costReservations', attemptId).update({ status: 'dispatching' });
                await this.reconcile(attemptId, { usd: 0.00001 });
              }
              return draw.call(this, input);
            },
          );
        }
        const deps = {
          config,
          router,
          persistence,
          firestoreStore: store,
          db: {},
          modules: { taskHandlerFor: () => undefined, taskKindUnavailable: () => null },
        } as unknown as AgentDeps;
        expect(await executeAgentTask(deps, taskId, task!.queueGeneration)).toMatchObject({
          outcome: 'admission_recovered',
          status: boundary === 'lost_renewal' ? 503 : 200,
        });
        const after = await chat.listMessages(agentId, conversationB.id, { limit: 30 });
        expect(after!.messages.filter((row) => row.taskId === bTaskId)).toEqual(bRows);
        if (
          boundary === 'exhausted' ||
          boundary === 'expired' ||
          boundary === 'transition_exhausted' ||
          boundary === 'lost_renewal'
        ) {
          expect(model.doGenerateCalls.length + model.doStreamCalls.length).toBe(
            attemptsBeforeResume + (boundary === 'transition_exhausted' ? 1 : 0),
          );
          expect((await persistence.tasks.getTask(taskId))?.status).toBe('waiting_estimated_cost');
          if (uncertainAttemptId)
            expect(
              (await store.doc('costReservations', uncertainAttemptId).get()).get('status'),
            ).toBe('unknown');
          if (boundary === 'expired' || boundary === 'lost_renewal')
            expect(await costs.expireEstimatedCostGrant(marker.grantId)).toBe(false);
          if (boundary === 'lost_renewal')
            expect(
              await costs.readEstimatedCostView(prepared.prepared.actor, operationA),
            ).toMatchObject({
              request: { status: 'expired_or_needs_refresh', operationId: operationA },
            });
          const renewal = await createFirestoreEstimatedCostQuotePreparer(store, {
            mutationsEnabled: () => true,
          }).prepare(prepared.prepared.actor, {
            operationId: operationA,
            quoteRequestId: randomUUID(),
          });
          if (!renewal.ok) throw new Error(`renewal unavailable: ${JSON.stringify(renewal)}`);
          expect(renewal.prepared.quote.totalHeldMicros).toBe(
            950_000 + (uncertainAttemptId ? 1 : 0),
          );
          expect(
            (
              await store
                .collection('estimatedCostGrants')
                .where('operationId', '==', operationA)
                .get()
            ).size,
          ).toBe(1);
          expect((await storePreparedFirestoreQuote(store, renewal.prepared)).ok).toBe(true);
          expect(model.doGenerateCalls.length + model.doStreamCalls.length).toBe(
            attemptsBeforeResume + (boundary === 'transition_exhausted' ? 1 : 0),
          );
          const fresh = renewal.prepared.quote;
          expect(
            await approveFirestoreEstimatedCost(store, renewal.prepared.actor, {
              operationId: operationA,
              quoteId: fresh.quoteId,
              quoteVersion: fresh.quoteVersion,
              decisionId: randomUUID(),
              decision: 'approve',
            }),
          ).toMatchObject({ ok: true, receipt: { status: 'approved' } });
          expect(
            (
              await store
                .collection('estimatedCostGrants')
                .where('operationId', '==', operationA)
                .get()
            ).size,
          ).toBe(2);
          const renewedTask = await persistence.tasks.getTask(taskId);
          expect(await executeAgentTask(deps, taskId, renewedTask!.queueGeneration)).toMatchObject({
            outcome: 'admission_recovered',
            status: 200,
          });
          expect((await persistence.tasks.getTask(taskId))?.status).toBe('done');
          if (uncertainAttemptId)
            expect(
              (await store.doc('costReservations', uncertainAttemptId).get()).get('status'),
            ).toBe('unknown');
          return;
        }
        expect((await persistence.tasks.getTask(taskId))?.status).toBe('done');
        const conversationA = await chat.listMessages(agentId, conversation.id, { limit: 30 });
        expect(
          conversationA?.messages.some(
            (row) =>
              row.taskId === taskId &&
              row.role === 'assistant' &&
              row.text.includes('Synthetic completed reply.'),
          ),
        ).toBe(true);
        const observed = JSON.stringify(
          boundary !== 'draft' ? model.doGenerateCalls.at(-1) : model.doStreamCalls.at(-1),
        );
        expect(observed).toContain('A A A');
        expect(observed).not.toContain('Hello B');
        const reservations = await store
          .collection('costReservations')
          .where('taskId', '==', taskId)
          .get();
        const grantRows = (
          await store
            .collection('costReservations')
            .where('costGrantId', '==', marker.grantId)
            .get()
        ).docs;
        expect(grantRows.every((row) => row.get('taskId') === taskId)).toBe(true);
        expect(
          reservations.docs.filter(
            (row) =>
              row.get('costGrantId') === marker.grantId && row.get('reservationKind') === 'attempt',
          ).length,
        ).toBe(boundary === 'draft' ? 1 : 2);
      },
      60_000,
    );
  },
);
