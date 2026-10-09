import {
  FirestoreApprovalPolicyRepository,
  FirestoreApprovalRepository,
  FirestoreCostRepository,
  FirestoreMaintenanceRepository,
  FirestoreMemoryToolRepository,
  FirestoreToolExecutionRepository,
} from '@assistant/firestore';
import type { EmbeddingSpace } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { disposeStore, emulatorStore, seedBudget } from '../../firestore/src/test-store.js';
import { registerPortableMemoryTools } from './builtin/index.js';
import { ToolDispatcher } from './dispatcher.js';
import { ToolRegistry } from './registry.js';
import type { ToolContext } from './types.js';

const maintenanceSpace: EmbeddingSpace = {
  provider: 'synthetic',
  model: 'dispatcher-retention-test',
  dimensions: 1536,
  revision: '1',
};

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'ToolDispatcher Firestore composition',
  () => {
    it('returns a compact recorded effect after retention without executing it again', async () => {
      const store = emulatorStore();
      try {
        const agentId = 'agent';
        const taskId = 'retained-effect-task';
        const operationId = 'retained-effect-model-call';
        const idempotencyKey = 'retained-effect-once';
        await store.doc('agents', agentId).set({ id: agentId, timezone: 'UTC' });
        const task = {
          id: taskId,
          agentId,
          type: 'adhoc',
          trust: 'owner',
          status: 'running',
          createdAt: new Date(),
          trigger: null,
          conversationId: null,
          goalId: null,
        } as never;
        await store.doc('tasks', taskId).set({
          id: taskId,
          agentId,
          type: 'adhoc',
          trust: 'owner',
          status: 'running',
          state: {},
        });
        const ctx = {
          taskId,
          agentId,
          trust: 'owner',
          tainted: false,
          db: {} as never,
          now: () => new Date(),
          signal: new AbortController().signal,
          log: async () => {},
        } as ToolContext;
        const invoked = vi.fn(async () => ({ privateResult: 'this must be scrubbed' }));
        const execution = new FirestoreToolExecutionRepository(store);
        const dispatcher = new ToolDispatcher(
          {} as never,
          new ToolRegistry()
            .register({
              name: 'test.retention.once',
              description: 'retention replay',
              inputSchema: z.object({ value: z.string() }),
              risk: 'autonomous',
              acceptsUntrustedInput: true,
              idempotencyKey: () => idempotencyKey,
              execute: invoked,
            })
            .register({
              name: 'test.retention.different-tool',
              description: 'must not inherit another tool receipt',
              inputSchema: z.object({ value: z.string() }),
              risk: 'autonomous',
              acceptsUntrustedInput: true,
              idempotencyKey: () => idempotencyKey,
              execute: vi.fn(async () => ({ wrongTool: true })),
            }),
          execution,
          new FirestoreCostRepository(store),
          new FirestoreApprovalRepository(store),
          new FirestoreApprovalPolicyRepository(store),
        );
        const dispatchInput = {
          task,
          step: 1,
          toolName: 'test.retention.once',
          args: { value: 'private input' },
          ctx,
          modelToolCallId: operationId,
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        } as const;
        const first = await dispatcher.dispatch(dispatchInput);
        expect(first).toMatchObject({
          kind: 'executed',
          result: { privateResult: 'this must be scrubbed' },
        });
        expect(invoked).toHaveBeenCalledTimes(1);
        if (first.kind !== 'executed') throw new Error('first effect did not execute');

        const liveWrongModelTool = await dispatcher.dispatch({
          ...dispatchInput,
          toolName: 'test.retention.different-tool',
        });
        expect(liveWrongModelTool).toMatchObject({ kind: 'rejected' });
        const liveWrongIdempotencyTool = await dispatcher.dispatch({
          ...dispatchInput,
          toolName: 'test.retention.different-tool',
          modelToolCallId: `${operationId}:live-other-tool`,
        });
        expect(liveWrongIdempotencyTool).toMatchObject({ kind: 'rejected' });
        expect(invoked).toHaveBeenCalledTimes(1);

        const aged = new Date(Date.now() - 100 * 86_400_000);
        await store.doc('toolCalls', first.toolCallId).update({ createdAt: aged });
        await store.doc('tasks', taskId).update({
          status: 'done',
          updatedAt: aged,
          state: {},
        });
        const maintenance = new FirestoreMaintenanceRepository(store, agentId, maintenanceSpace);
        const [counts, racingReplay] = await Promise.all([
          maintenance.purgeAgedHistory({ historyDays: 30, costDays: 0, batch: 50 }),
          dispatcher.dispatch(dispatchInput),
        ]);
        expect(['executed', 'recorded']).toContain(racingReplay.kind);
        expect(invoked).toHaveBeenCalledTimes(1);
        expect(counts.toolCalls).toBe(1);
        expect((await store.doc('toolCalls', first.toolCallId).get()).exists).toBe(false);
        const receipt = (await store.doc('toolCallReceipts', first.toolCallId).get()).data();
        expect(receipt).toMatchObject({
          id: first.toolCallId,
          agentId,
          taskId,
          toolCallId: first.toolCallId,
          effectOutcome: 'completed',
        });
        expect(receipt).not.toHaveProperty('args');
        expect(receipt).not.toHaveProperty('result');
        expect(receipt).not.toHaveProperty('error');
        expect(receipt).not.toHaveProperty('idempotencyKey');
        expect(receipt).not.toHaveProperty('modelToolCallId');
        expect((await store.doc('toolCallIdempotency', idempotencyKey).get()).exists).toBe(false);

        await store.doc('tasks', taskId).update({ status: 'running', updatedAt: new Date() });
        const replay = await dispatcher.dispatch(dispatchInput);
        expect(replay).toMatchObject({
          kind: 'recorded',
          toolCallId: first.toolCallId,
          effectOutcome: 'completed',
          detailsExpired: true,
          requestedArgumentsVerified: false,
        });
        expect(invoked).toHaveBeenCalledTimes(1);
        const changedArguments = await dispatcher.dispatch({
          ...dispatchInput,
          args: { value: 'changed after argument retention expired' },
        });
        expect(changedArguments).toMatchObject({
          kind: 'recorded',
          effectOutcome: 'completed',
          requestedArgumentsVerified: false,
        });
        await expect(
          dispatcher.executeApproved(first.toolCallId, ctx, 'test.retention.different-tool'),
        ).resolves.toMatchObject({ kind: 'failed' });
        const wrongModelTool = await dispatcher.dispatch({
          ...dispatchInput,
          toolName: 'test.retention.different-tool',
          args: { value: 'different tool under same model call id' },
        });
        expect(wrongModelTool).toMatchObject({ kind: 'rejected' });
        const wrongIdempotencyTool = await dispatcher.dispatch({
          ...dispatchInput,
          toolName: 'test.retention.different-tool',
          modelToolCallId: `${operationId}:other-model-id`,
          args: { value: 'different tool under same idempotency key' },
        });
        expect(wrongIdempotencyTool).toMatchObject({ kind: 'rejected' });
        expect(invoked).toHaveBeenCalledTimes(1);
        const otherTaskId = 'retained-effect-other-task';
        const otherTask = {
          id: otherTaskId,
          agentId,
          type: 'adhoc',
          trust: 'owner',
          status: 'running',
          createdAt: new Date(),
          trigger: null,
          conversationId: null,
          goalId: null,
        } as never;
        await store.doc('tasks', otherTaskId).set({
          id: otherTaskId,
          agentId,
          type: 'adhoc',
          trust: 'owner',
          status: 'running',
          state: {},
        });
        const crossTaskReplay = await dispatcher.dispatch({
          ...dispatchInput,
          task: otherTask,
          ctx: { ...ctx, taskId: otherTaskId },
          modelToolCallId: `${operationId}:different-task`,
        });
        expect(crossTaskReplay).toMatchObject({ kind: 'rejected' });
        expect(invoked).toHaveBeenCalledTimes(1);

        await store.doc('tasks', taskId).update({ status: 'done', updatedAt: new Date() });
        const compactKeys = await store
          .collection('toolCallReceiptKeys')
          .where('receiptId', '==', first.toolCallId)
          .get();
        for (const key of compactKeys.docs) await key.ref.delete();
        await store.doc('toolCallReceipts', first.toolCallId).delete();
        const afterReceiptErasure = await dispatcher.dispatch(dispatchInput);
        expect(afterReceiptErasure).toMatchObject({ kind: 'rejected' });
        expect(invoked).toHaveBeenCalledTimes(1);

        const unknownTaskId = 'retained-effect-unknown-task';
        const unknownModelCallId = 'retained-effect-unknown-model-call';
        const unknownCallId = 'retained-effect-unknown-db-call';
        const unknownAged = new Date(aged.getTime() + 1_000);
        await store.doc('tasks', unknownTaskId).set({
          id: unknownTaskId,
          agentId,
          type: 'adhoc',
          trust: 'owner',
          status: 'done',
          updatedAt: unknownAged,
          state: {},
        });
        await store.doc('toolCalls', unknownCallId).set({
          id: unknownCallId,
          taskId: unknownTaskId,
          step: 1,
          toolName: 'test.retention.once',
          risk: 'autonomous',
          status: 'failed',
          args: { private: 'unknown provider request' },
          error: 'the provider outcome is unknown; the action was not retried',
          decision: { modelToolCallId: unknownModelCallId },
          idempotencyKey: null,
          createdAt: unknownAged,
          startedAt: unknownAged,
          finishedAt: unknownAged,
        });
        const unknownCounts = await maintenance.purgeAgedHistory({
          historyDays: 30,
          costDays: 0,
          batch: 50,
        });
        expect(unknownCounts.toolCalls).toBe(1);
        const unknownTask = {
          id: unknownTaskId,
          agentId,
          type: 'adhoc',
          trust: 'owner',
          status: 'running',
          createdAt: new Date(),
          trigger: null,
          conversationId: null,
          goalId: null,
        } as never;
        const unknownDispatch = await dispatcher.dispatch({
          ...dispatchInput,
          task: unknownTask,
          ctx: { ...ctx, taskId: unknownTaskId },
          modelToolCallId: unknownModelCallId,
        });
        expect(unknownDispatch).toMatchObject({ kind: 'recorded', effectOutcome: 'unknown' });
        expect(invoked).toHaveBeenCalledTimes(1);

        const failedTaskId = 'retained-effect-failed-task';
        const failedModelCallId = 'retained-effect-failed-model-call';
        const failedCallId = 'retained-effect-failed-db-call';
        const failedAged = new Date(unknownAged.getTime() + 1_000);
        await store.doc('tasks', failedTaskId).set({
          id: failedTaskId,
          agentId,
          type: 'adhoc',
          trust: 'owner',
          status: 'done',
          updatedAt: failedAged,
          state: {},
        });
        await store.doc('toolCalls', failedCallId).set({
          id: failedCallId,
          taskId: failedTaskId,
          step: 1,
          toolName: 'test.retention.once',
          risk: 'autonomous',
          status: 'failed',
          args: { private: 'failed provider request' },
          error: 'provider rejected the request before applying it',
          decision: { modelToolCallId: failedModelCallId },
          idempotencyKey: null,
          createdAt: failedAged,
          startedAt: failedAged,
          finishedAt: failedAged,
        });
        const failedCounts = await maintenance.purgeAgedHistory({
          historyDays: 30,
          costDays: 0,
          batch: 50,
        });
        expect(failedCounts.toolCalls).toBe(1);
        expect((await store.doc('toolCallReceipts', failedCallId).get()).get('effectOutcome')).toBe(
          'failed',
        );
        const failedDispatch = await dispatcher.dispatch({
          ...dispatchInput,
          task: {
            id: failedTaskId,
            agentId,
            type: 'adhoc',
            trust: 'owner',
            status: 'running',
            createdAt: new Date(),
            trigger: null,
            conversationId: null,
            goalId: null,
          } as never,
          ctx: { ...ctx, taskId: failedTaskId },
          modelToolCallId: failedModelCallId,
        });
        expect(failedDispatch).toMatchObject({ kind: 'recorded', effectOutcome: 'failed' });
        expect(invoked).toHaveBeenCalledTimes(1);
      } finally {
        await disposeStore(store);
      }
    });

    it('saves and recalls memory through the portable registry with PostgreSQL unavailable', async () => {
      const store = emulatorStore();
      try {
        const agentId = 'agent';
        const taskId = 'memory-task';
        await store.doc('tasks', taskId).set({
          id: taskId,
          agentId,
          type: 'adhoc',
          status: 'running',
        });
        const registry = registerPortableMemoryTools(new ToolRegistry(), {
          memory: new FirestoreMemoryToolRepository(store, {
            provider: 'test',
            model: 'unit',
            dimensions: 3,
            revision: '1',
          }),
          embed: async () => [[1, 0, 0]],
        });
        const db = new Proxy({} as ToolContext['db'], {
          get() {
            throw new Error('PostgreSQL access is unavailable');
          },
        });
        const dispatcher = new ToolDispatcher(
          db,
          registry,
          new FirestoreToolExecutionRepository(store),
          new FirestoreCostRepository(store),
          new FirestoreApprovalRepository(store),
          new FirestoreApprovalPolicyRepository(store),
        );
        const task = {
          id: taskId,
          agentId,
          type: 'adhoc',
          trust: 'owner',
          status: 'running',
          createdAt: new Date(),
          trigger: null,
          conversationId: null,
          goalId: null,
        } as never;
        const ctx = {
          taskId,
          agentId,
          trust: 'owner',
          tainted: false,
          db,
          now: () => new Date(),
          signal: new AbortController().signal,
          log: async () => {},
        } as ToolContext;
        const dispatch = (step: number, toolName: string, args: Record<string, unknown>) =>
          dispatcher.dispatch({
            task,
            step,
            toolName,
            args,
            ctx,
            provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
          });
        expect(
          await dispatch(1, 'memory.save', {
            content: 'The owner prefers coffee in the morning.',
            category: 'knowledge',
            kind: 'preference',
            subject: '',
            importance: 3,
            confidence: 0.9,
          }),
        ).toMatchObject({ kind: 'executed', result: { saved: true } });
        expect(await dispatch(2, 'memory.recall', { query: 'coffee', limit: 5 })).toMatchObject({
          kind: 'executed',
          result: {
            memories: [expect.objectContaining({ content: expect.stringContaining('coffee') })],
          },
        });
      } finally {
        await disposeStore(store);
      }
    });

    it('executes an idempotent autonomous call once under concurrent retries and reuses cache', async () => {
      const store = emulatorStore();
      try {
        const execution = new FirestoreToolExecutionRepository(store);
        const costs = new FirestoreCostRepository(store);
        const approvals = new FirestoreApprovalRepository(store);
        const policies = new FirestoreApprovalPolicyRepository(store);
        const calls = { count: 0 };
        const registry = new ToolRegistry()
          .register({
            name: 'test.firestore',
            description: 'test',
            inputSchema: z.object({ value: z.string() }),
            risk: 'autonomous',
            acceptsUntrustedInput: true,
            idempotencyKey: () => 'same-call',
            execute: async () => {
              calls.count += 1;
              return { ok: true };
            },
          })
          .register({
            name: 'test.firestore.cache',
            description: 'cache test',
            inputSchema: z.object({ value: z.string() }),
            risk: 'autonomous',
            acceptsUntrustedInput: true,
            cacheTtlSeconds: 60,
            execute: async () => {
              calls.count += 1;
              return { cached: true };
            },
          });
        const dispatcher = new ToolDispatcher(
          {} as never,
          registry,
          execution,
          costs,
          approvals,
          policies,
        );
        const task = {
          id: 'task',
          agentId: 'agent',
          type: 'adhoc',
          trust: 'owner',
          status: 'running',
          createdAt: new Date(),
          trigger: null,
          conversationId: null,
          goalId: null,
        } as never;
        await store
          .doc('tasks', 'task')
          .set({ id: 'task', agentId: 'agent', type: 'adhoc', status: 'running' });
        const ctx = {
          taskId: 'task',
          agentId: 'agent',
          trust: 'owner',
          tainted: false,
          db: {} as never,
          now: () => new Date(),
          signal: new AbortController().signal,
          log: async () => {},
        } as ToolContext;
        const results = await Promise.all([
          dispatcher.dispatch({
            task,
            step: 1,
            toolName: 'test.firestore',
            args: { value: 'x' },
            ctx,
            provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
          }),
          dispatcher.dispatch({
            task,
            step: 1,
            toolName: 'test.firestore',
            args: { value: 'x' },
            ctx,
            provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
          }),
        ]);
        expect(calls.count).toBe(1);
        expect(results.filter((result) => result.kind === 'executed')).toHaveLength(1);
        expect(
          (
            await dispatcher.dispatch({
              task,
              step: 2,
              toolName: 'test.firestore',
              args: { value: 'x' },
              ctx,
              provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
            })
          ).kind,
        ).toBe('executed');
        expect(calls.count).toBe(1);
        const cachedTask = Object.assign({}, task, { id: 'cache-task' }) as never;
        await store
          .doc('tasks', 'cache-task')
          .set({ id: 'cache-task', agentId: 'agent', type: 'adhoc', status: 'running' });
        const firstCache = await dispatcher.dispatch({
          task: cachedTask,
          step: 1,
          toolName: 'test.firestore.cache',
          args: { value: 'x' },
          ctx: { ...ctx, taskId: 'cache-task' },
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        });
        const secondCache = await dispatcher.dispatch({
          task: cachedTask,
          step: 2,
          toolName: 'test.firestore.cache',
          args: { value: 'x' },
          ctx: { ...ctx, taskId: 'cache-task' },
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        });
        expect(firstCache.kind).toBe('executed');
        expect(secondCache.kind).toBe('executed');
        expect(calls.count).toBe(2);
        await store.doc('rateLimits', 'tool:test.firestore.cache').set({
          scope: 'tool:test.firestore.cache',
          maxPerHour: 1,
          maxPerDay: null,
        });
        const capped = await dispatcher.dispatch({
          task: cachedTask,
          step: 3,
          toolName: 'test.firestore.cache',
          args: { value: 'different' },
          ctx: { ...ctx, taskId: 'cache-task' },
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        });
        expect(capped).toMatchObject({
          kind: 'rejected',
          reason: expect.stringContaining('rate limit'),
        });
      } finally {
        await disposeStore(store);
      }
    }, 30_000);

    it('preserves a timely approval through a Firestore budget wait past its answer deadline', async () => {
      const store = emulatorStore();
      try {
        await seedBudget(store);
        await store.doc('rateTable', 'external_api').set({ unit: 'call', unitPriceUsd: 0.1 });
        // Approved-call execution now verifies its owner document in the
        // atomic claim transaction. Keep this fixture representative of a
        // configured Firestore installation.
        await store.doc('agents', 'agent').set({ id: 'agent', timezone: 'UTC' });
        await store.doc('tasks', 'approved-budget-task').set({
          id: 'approved-budget-task',
          agentId: 'agent',
          type: 'adhoc',
          trust: 'owner',
          status: 'running',
          spentUsd: '0',
          budgetUsdLimit: '0',
        });
        const execution = new FirestoreToolExecutionRepository(store);
        const costs = new FirestoreCostRepository(store);
        const approvals = new FirestoreApprovalRepository(store);
        const paidExecute = vi.fn(async () => ({ ok: true }));
        const dispatcher = new ToolDispatcher(
          {} as never,
          new ToolRegistry().register({
            name: 'test.approved-budget',
            description: 'approval budget test',
            inputSchema: z.object({ value: z.string() }),
            risk: 'approval',
            acceptsUntrustedInput: true,
            estimateCost: () => ({ source: 'external_api', rateKey: 'external_api', quantity: 1 }),
            execute: paidExecute,
          }),
          execution,
          costs,
          approvals,
          new FirestoreApprovalPolicyRepository(store),
        );
        const task = {
          id: 'approved-budget-task',
          agentId: 'agent',
          type: 'adhoc',
          trust: 'owner',
          status: 'running',
          createdAt: new Date(),
          trigger: null,
          conversationId: null,
          goalId: null,
        } as never;
        const ctx = {
          taskId: 'approved-budget-task',
          agentId: 'agent',
          trust: 'owner',
          tainted: false,
          db: {} as never,
          now: () => new Date(),
          signal: new AbortController().signal,
          log: async () => {},
        } as ToolContext;
        const parked = await dispatcher.dispatch({
          task,
          step: 1,
          toolName: 'test.approved-budget',
          args: { value: 'approved once' },
          ctx,
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        });
        expect(parked.kind).toBe('awaiting_approval');
        if (parked.kind !== 'awaiting_approval') return;

        const resolution = await approvals.resolve({
          approvalId: parked.approvalId,
          decision: 'approved',
          via: 'web',
        });
        expect(resolution.ok).toBe(true);
        // Resolution queues the task; model the worker reclaiming it before the
        // approved tool call resumes.
        await store.doc('tasks', 'approved-budget-task').update({ status: 'running' });
        expect(await dispatcher.executeApproved(parked.toolCallId, ctx)).toMatchObject({
          kind: 'budget_blocked',
        });

        await store.doc('approvals', parked.approvalId).update({
          expiresAt: new Date(store.now().getTime() - 60_000),
        });
        await store.doc('tasks', 'approved-budget-task').update({ budgetUsdLimit: '1' });
        const resumed = await dispatcher.executeApproved(parked.toolCallId, ctx);
        expect(resumed.kind).toBe('executed');
        expect(paidExecute).toHaveBeenCalledOnce();
        expect((await store.doc('approvals', parked.approvalId).get()).get('status')).toBe(
          'approved',
        );
      } finally {
        await disposeStore(store);
      }
    });

    it('suppresses retries when terminal persistence reports a conflict after paid execution', async () => {
      const store = emulatorStore();
      try {
        await seedBudget(store);
        await store.doc('rateTable', 'external_api').set({ unit: 'call', unitPriceUsd: 0.1 });
        await store.doc('tasks', 'paid-task').set({
          id: 'paid-task',
          agentId: 'agent',
          type: 'adhoc',
          status: 'running',
          spentUsd: '0',
          budgetUsdLimit: '1',
        });
        const execution = new FirestoreToolExecutionRepository(store);
        const costs = new FirestoreCostRepository(store);
        const paidExecute = vi.fn(async () => ({ ok: true }));
        const dispatcher = new ToolDispatcher(
          {} as never,
          new ToolRegistry().register({
            name: 'test.paid',
            description: 'paid',
            inputSchema: z.object({ value: z.string() }),
            risk: 'autonomous',
            acceptsUntrustedInput: true,
            idempotencyKey: () => 'paid-once',
            estimateCost: () => ({ source: 'external_api', rateKey: 'external_api', quantity: 1 }),
            execute: paidExecute,
          }),
          execution,
          costs,
          new FirestoreApprovalRepository(store),
          new FirestoreApprovalPolicyRepository(store),
        );
        vi.spyOn(execution, 'outcome').mockResolvedValue(false);
        const task = {
          id: 'paid-task',
          agentId: 'agent',
          type: 'adhoc',
          trust: 'owner',
          status: 'running',
          createdAt: new Date(),
          trigger: null,
          conversationId: null,
          goalId: null,
        } as never;
        const ctx = {
          taskId: 'paid-task',
          agentId: 'agent',
          trust: 'owner',
          tainted: false,
          db: {} as never,
          now: () => new Date(),
          signal: new AbortController().signal,
          log: async () => {},
        } as ToolContext;
        const first = await dispatcher.dispatch({
          task,
          step: 1,
          toolName: 'test.paid',
          args: { value: 'x' },
          ctx,
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        });
        const second = await dispatcher.dispatch({
          task,
          step: 2,
          toolName: 'test.paid',
          args: { value: 'x' },
          ctx,
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        });
        expect(first.kind).toBe('rejected');
        expect(second.kind).toBe('rejected');
        expect(paidExecute).toHaveBeenCalledTimes(1);
        const persistedCalls = await store.collection('toolCalls').limit(1).get();
        expect(persistedCalls.size).toBe(1);
        expect(persistedCalls.docs[0]?.get('status')).toBe('executing');
        expect((await costs.totals()).heldUsd).toBe(0);
        expect((await costs.totals()).dailySpentUsd).toBeGreaterThan(0);
        const throwingExecution = new FirestoreToolExecutionRepository(store);
        const throwingExecute = vi.fn(async () => ({ ok: true }));
        const throwingDispatcher = new ToolDispatcher(
          {} as never,
          new ToolRegistry().register({
            name: 'test.throwing',
            description: 'throwing persistence',
            inputSchema: z.object({ value: z.string() }),
            risk: 'autonomous',
            acceptsUntrustedInput: true,
            idempotencyKey: () => 'throw-once',
            estimateCost: () => ({ source: 'external_api', rateKey: 'external_api', quantity: 1 }),
            execute: throwingExecute,
          }),
          throwingExecution,
          costs,
          new FirestoreApprovalRepository(store),
          new FirestoreApprovalPolicyRepository(store),
        );
        vi.spyOn(throwingExecution, 'outcome').mockRejectedValue(
          new Error('persistence unavailable'),
        );
        const throwTask = Object.assign({}, task, { id: 'throw-task' }) as never;
        await store.doc('tasks', 'throw-task').set({
          id: 'throw-task',
          agentId: 'agent',
          type: 'adhoc',
          status: 'running',
          spentUsd: '0',
          budgetUsdLimit: '1',
        });
        const throwCtx = { ...ctx, taskId: 'throw-task' };
        const thrown = await throwingDispatcher.dispatch({
          task: throwTask,
          step: 1,
          toolName: 'test.throwing',
          args: { value: 'x' },
          ctx: throwCtx,
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        });
        const thrownRetry = await throwingDispatcher.dispatch({
          task: throwTask,
          step: 2,
          toolName: 'test.throwing',
          args: { value: 'x' },
          ctx: throwCtx,
          provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
        });
        expect(thrown.kind).toBe('rejected');
        expect(thrownRetry.kind).toBe('rejected');
        expect(throwingExecute).toHaveBeenCalledTimes(1);
        expect((await costs.totals()).heldUsd).toBe(0);
        expect((await costs.totals()).dailySpentUsd).toBeCloseTo(0.2);
        expect(
          (
            await store.collection('toolCalls').where('taskId', '==', 'throw-task').limit(1).get()
          ).docs[0]?.get('status'),
        ).toBe('executing');
      } finally {
        await disposeStore(store);
      }
    });
  },
);
