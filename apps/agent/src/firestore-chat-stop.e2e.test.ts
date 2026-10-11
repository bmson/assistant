import { randomUUID } from 'node:crypto';
import type { Db } from '@assistant/db';
import {
  FirestoreApplicationChatPersistence,
  FirestoreApprovalPolicyRepository,
  FirestoreApprovalRepository,
  FirestoreCostRepository,
  FirestoreTaskRepository,
  FirestoreToolExecutionRepository,
  type InstallationStore,
} from '@assistant/firestore';
import type { ToolExecutionRepository } from '@assistant/persistence';
import { type ToolContext, ToolDispatcher, ToolRegistry } from '@assistant/tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

const enabled = /^(?:127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '');

const unavailableDb = new Proxy(
  {},
  {
    get: (_target, property) => {
      throw new Error(`Unexpected PostgreSQL access in Firestore Stop test: ${String(property)}`);
    },
  },
) as Db;

describe.skipIf(!enabled)('F19 Firestore chat Stop at tool boundaries', () => {
  let store: InstallationStore;
  let agentId: string;
  let chat: FirestoreApplicationChatPersistence;
  let approvals: FirestoreApprovalRepository;
  let tasks: FirestoreTaskRepository;
  let tools: FirestoreToolExecutionRepository;

  beforeEach(async () => {
    store = emulatorStore();
    agentId = randomUUID();
    chat = new FirestoreApplicationChatPersistence(store, agentId);
    approvals = new FirestoreApprovalRepository(store);
    tasks = new FirestoreTaskRepository(store);
    tools = new FirestoreToolExecutionRepository(store);
    await store.doc('agents', agentId).set({
      id: agentId,
      name: 'Synthetic Stop owner',
      email: `${agentId}@example.test`,
      timezone: 'UTC',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  function dispatcher(execution: ToolExecutionRepository, registry: ToolRegistry) {
    return new ToolDispatcher(
      unavailableDb,
      registry,
      execution,
      new FirestoreCostRepository(store),
      approvals,
      new FirestoreApprovalPolicyRepository(store),
    );
  }

  function context(taskId: string, conversationId: string): ToolContext {
    return {
      taskId,
      agentId,
      conversationId,
      trust: 'owner',
      tainted: false,
      db: unavailableDb,
      now: () => new Date(),
      signal: new AbortController().signal,
      log: async () => {},
    };
  }

  async function admittedTurn(text: string) {
    const conversation = await chat.createConversation(agentId);
    const clientOperationId = randomUUID();
    const result = await chat.admitChatTurn({
      agentId,
      conversationId: conversation.id,
      clientOperationId,
      requestHash: 'a'.repeat(64),
      text,
      autonomous: false,
      force: false,
      spoken: false,
    });
    if (result.kind !== 'admitted' || !result.lease)
      throw new Error('Expected an admitted Firestore chat task and lease');
    return { conversation, clientOperationId, task: result.task, lease: result.lease };
  }

  function registryFor(
    name: string,
    risk: 'autonomous' | 'approval',
    invoke: () => Promise<Record<string, unknown>>,
  ) {
    return new ToolRegistry().register({
      name,
      description: `Synthetic ${name}`,
      inputSchema: z.object({ value: z.string() }),
      risk,
      acceptsUntrustedInput: true,
      execute: invoke,
    });
  }

  it('rejects a pre-handler call after real Firestore chat cancellation and suppresses replay', async () => {
    const admitted = await admittedTurn('Run the synthetic local action.');
    let invocations = 0;
    const name = `test.firestore-stop-${randomUUID()}`;
    const registry = registryFor(name, 'autonomous', async () => {
      invocations += 1;
      return { completed: true };
    });

    let signalStart!: () => void;
    let releaseStart!: () => void;
    const startEntered = new Promise<void>((resolve) => {
      signalStart = resolve;
    });
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const executionRepository = new Proxy(tools, {
      get(target, property) {
        if (property === 'start')
          return async (input: Parameters<typeof tools.start>[0]) => {
            const row = await tools.start(input);
            if (!row) throw new Error('Firestore tool execution start was refused');
            signalStart();
            await startGate;
            return row;
          };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as ToolExecutionRepository;
    const run = dispatcher(executionRepository, registry);
    const input = {
      task: admitted.task,
      step: 1,
      toolName: name,
      args: { value: 'must not reach the handler' },
      modelToolCallId: randomUUID(),
      ctx: context(admitted.task.id, admitted.conversation.id),
      provenance: { plannerVersion: 1, promptVersion: 1, model: 'synthetic/no-provider' },
    };

    const pending = run.dispatch(input);
    try {
      const boundary = await Promise.race([
        startEntered.then(() => ({ type: 'started' as const })),
        pending.then(
          () => ({ type: 'dispatch_settled' as const }),
          (error: unknown) => ({ type: 'dispatch_rejected' as const, error: String(error) }),
        ),
      ]);
      expect(boundary).toMatchObject({ type: 'started' });
      await expect(
        chat.cancelChatTurn({
          agentId,
          conversationId: admitted.conversation.id,
          clientOperationId: admitted.clientOperationId,
        }),
      ).resolves.toMatchObject({
        kind: 'admitted_task',
        status: 'cancelled',
        transitioned: true,
        effectStatus: 'unknown',
      });
      releaseStart();

      await expect(pending).resolves.toMatchObject({ kind: 'rejected' });
      expect(invocations).toBe(0);
      const stoppedTask = await store.doc('tasks', admitted.task.id).get();
      expect(stoppedTask.exists).toBe(true);
      expect(stoppedTask.get('status')).toBe('cancelled');
      const calls = await store
        .collection('toolCalls')
        .where('taskId', '==', admitted.task.id)
        .get();
      expect(calls.size).toBe(1);
      expect(calls.docs[0]?.get('status')).toBe('failed');

      await expect(run.dispatch(input)).resolves.toMatchObject({ kind: 'rejected' });
      expect(invocations).toBe(0);
      const replayCalls = await store
        .collection('toolCalls')
        .where('taskId', '==', admitted.task.id)
        .get();
      expect(replayCalls.size).toBe(1);
    } finally {
      releaseStart();
      await pending.catch(() => {});
    }
  });

  it('keeps a cancelled waiting-approval chat stopped after a late approval and execution attempt', async () => {
    const admitted = await admittedTurn('Run the synthetic action only with owner approval.');
    let invocations = 0;
    const name = `test.firestore-stop-approval-${randomUUID()}`;
    const run = dispatcher(
      tools,
      registryFor(name, 'approval', async () => {
        invocations += 1;
        return { completed: true };
      }),
    );
    const input = {
      task: admitted.task,
      step: 1,
      toolName: name,
      args: { value: 'never execute after Stop' },
      modelToolCallId: randomUUID(),
      ctx: context(admitted.task.id, admitted.conversation.id),
      provenance: { plannerVersion: 1, promptVersion: 1, model: 'synthetic/no-provider' },
    };
    const parked = await run.dispatch(input);
    expect(parked.kind).toBe('awaiting_approval');
    if (parked.kind !== 'awaiting_approval') throw new Error('Expected an approval checkpoint');

    expect(
      await tasks.parkForApproval(admitted.lease, {}, [
        {
          approvalId: parked.approvalId,
          dbToolCallId: parked.toolCallId,
          toolCallId: input.modelToolCallId,
          toolName: name,
        },
      ]),
    ).toBe(true);
    await expect(
      chat.cancelChatTurn({
        agentId,
        conversationId: admitted.conversation.id,
        clientOperationId: admitted.clientOperationId,
      }),
    ).resolves.toMatchObject({
      kind: 'admitted_task',
      status: 'cancelled',
      transitioned: true,
      effectStatus: 'unknown',
    });

    const lateApproval = await approvals.resolve({
      approvalId: parked.approvalId,
      decision: 'approved',
      via: 'web',
      expectedAgentId: agentId,
    });
    expect(lateApproval).toMatchObject({
      ok: true,
      taskId: admitted.task.id,
      toolCallId: parked.toolCallId,
    });
    expect(lateApproval).not.toHaveProperty('wake');
    expect((await store.doc('tasks', admitted.task.id).get()).get('status')).toBe('cancelled');
    await expect(run.executeApproved(parked.toolCallId, input.ctx)).resolves.toMatchObject({
      kind: 'failed',
    });
    expect(invocations).toBe(0);
    expect((await store.doc('tasks', admitted.task.id).get()).get('status')).toBe('cancelled');
    expect((await store.doc('toolCalls', parked.toolCallId).get()).get('status')).toBe('approved');
  });
});
