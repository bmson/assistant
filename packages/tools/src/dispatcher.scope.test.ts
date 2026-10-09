import { extractOwnerIntent, latestOwnerIntent } from '@assistant/core';
import type { Db } from '@assistant/db';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolDispatcher } from './dispatcher.js';
import { ToolRegistry } from './registry.js';
import type { ToolContext } from './types.js';

describe('ToolDispatcher task scope', () => {
  it('treats a future-watch request as watch creation authority only', async () => {
    const watchExecute = vi.fn(async () => ({ status: 'active' }));
    const reminderExecute = vi.fn(async () => ({ created: true }));
    const registry = new ToolRegistry()
      .register(
        {
          name: 'watch.create',
          description: 'create watch',
          inputSchema: z.object({}),
          risk: 'autonomous',
          acceptsUntrustedInput: true,
          execute: watchExecute,
        },
        { privateWrite: true },
      )
      .register(
        {
          name: 'reminders.create',
          description: 'create reminder',
          inputSchema: z.object({}),
          risk: 'autonomous',
          acceptsUntrustedInput: true,
          execute: reminderExecute,
        },
        { privateWrite: true },
      );
    let sequence = 0;
    const dispatcher = new ToolDispatcher(
      {} as Db,
      registry,
      {
        kind: 'tool-execution-repository',
        findByModelToolCallId: async () => null,
        underRateLimit: async () => true,
        findIdempotent: async () => null,
        start: async () => ({ id: `call-${++sequence}` }),
        outcome: async () => true,
      } as never,
      undefined,
      undefined,
      { kind: 'approval-policy-repository', list: async () => [] } as never,
    );
    const task = {
      id: 'task-1',
      agentId: 'agent-1',
      type: 'chat_turn',
      trust: 'owner',
      trigger: { source: 'chat', payload: { text: 'Tell me if Alex emails me.' } },
    } as never;
    const ctx: ToolContext = {
      taskId: 'task-1',
      agentId: 'agent-1',
      trust: 'owner',
      tainted: true,
      ownerIntent: extractOwnerIntent({
        trust: 'owner',
        text: 'Tell me if Alex emails me.',
      }),
      db: {} as Db,
      now: () => new Date(),
      signal: new AbortController().signal,
      log: async () => {},
    };
    const dispatch = (toolName: string) =>
      dispatcher.dispatch({
        task,
        step: 1,
        modelToolCallId: `model-${toolName}`,
        toolName,
        args: {},
        ctx,
        provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
      });

    expect(await dispatch('watch.create')).toMatchObject({ kind: 'executed' });
    expect(await dispatch('reminders.create')).toMatchObject({ kind: 'rejected' });
    expect(watchExecute).toHaveBeenCalledTimes(1);
    expect(reminderExecute).not.toHaveBeenCalled();
  });

  it('exposes mission.update but hides separate root creation from a mission session', () => {
    const registry = new ToolRegistry()
      .register({
        name: 'mission.update',
        description: 'update mission',
        inputSchema: z.object({}),
        risk: 'autonomous',
        acceptsUntrustedInput: true,
        execute: async () => ({ updated: true }),
      })
      .register({
        name: 'web.fetch',
        description: 'fetch web page',
        inputSchema: z.object({}),
        risk: 'autonomous',
        acceptsUntrustedInput: true,
        execute: async () => ({}),
      })
      .register({
        name: 'task.schedule',
        description: 'schedule separate work',
        inputSchema: z.object({}),
        risk: 'autonomous',
        acceptsUntrustedInput: true,
        execute: async () => ({}),
      })
      .register({
        name: 'goals.create',
        description: 'create a goal',
        inputSchema: z.object({}),
        risk: 'approval',
        acceptsUntrustedInput: false,
        execute: async () => ({}),
      });
    const dispatcher = new ToolDispatcher({} as Db, registry);

    expect(dispatcher.toolDefs('owner').map((tool) => tool.name)).toEqual([
      'web.fetch',
      'task.schedule',
      'goals.create',
    ]);
    expect(
      dispatcher.toolDefs('owner', { isMissionSession: true }).map((tool) => tool.name),
    ).toEqual(['mission.update', 'web.fetch']);
  });

  it.each(['task.schedule', 'goals.create'])(
    'rejects guessed mission root tool %s',
    async (toolName) => {
      const execute = vi.fn(async () => ({ created: true }));
      const registry = new ToolRegistry().register({
        name: toolName,
        description: toolName,
        inputSchema: z.object({}).passthrough(),
        risk: toolName === 'goals.create' ? 'approval' : 'autonomous',
        acceptsUntrustedInput: true,
        execute,
      });
      const dispatcher = new ToolDispatcher({} as Db, registry);
      const missionId = 'mission-1';
      const task = {
        id: 'child-1',
        agentId: 'agent-1',
        type: 'adhoc',
        parentTaskId: missionId,
        trust: 'owner',
        trigger: { source: 'mission_wake', payload: { missionId } },
      } as never;
      const result = await dispatcher.dispatch({
        task,
        step: 0,
        toolName,
        args: {},
        ctx: {
          taskId: 'child-1',
          agentId: 'agent-1',
          trust: 'owner',
          tainted: false,
          db: {} as Db,
          now: () => new Date(),
          signal: new AbortController().signal,
          log: async () => {},
        },
        provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
      });

      expect(result).toMatchObject({ kind: 'rejected' });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('fails an already-approved root creation instead of executing it from a mission child', async () => {
    const execute = vi.fn(async () => ({ created: true }));
    const registry = new ToolRegistry().register({
      name: 'goals.create',
      description: 'create a goal',
      inputSchema: z.object({}).passthrough(),
      risk: 'approval',
      acceptsUntrustedInput: true,
      execute,
    });
    const missionId = 'mission-1';
    const task = {
      id: 'child-1',
      agentId: 'agent-1',
      type: 'adhoc',
      parentTaskId: missionId,
      trust: 'owner',
      trigger: { source: 'mission_wake', payload: { missionId } },
    } as never;
    const outcome = vi.fn(async () => true);
    const dispatcher = new ToolDispatcher({} as Db, registry, {
      kind: 'tool-execution-repository',
      load: async () => ({
        task,
        toolCall: {
          id: 'call-1',
          toolName: 'goals.create',
          status: 'approved',
          result: null,
          args: {},
          approvalId: null,
        },
        approval: null,
      }),
      outcome,
    } as never);

    const result = await dispatcher.executeApproved('call-1', {
      taskId: 'child-1',
      agentId: 'agent-1',
      trust: 'owner',
      tainted: false,
      db: {} as Db,
      now: () => new Date(),
      signal: new AbortController().signal,
      log: async () => {},
    });

    expect(result).toMatchObject({ kind: 'failed' });
    expect(outcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', fromStatus: 'approved' }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('reconciles an executing model call as unknown without inventing a success receipt', async () => {
    const execute = vi.fn(async () => ({ sent: true }));
    const registry = new ToolRegistry().register({
      name: 'test.send',
      description: 'send a test effect',
      inputSchema: z.object({}).passthrough(),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute,
    });
    const task = {
      id: 'task-1',
      agentId: 'agent-1',
      type: 'chat_turn',
      trust: 'owner',
      trigger: { source: 'chat', payload: { text: 'Send it.' } },
    } as never;
    const findByModelToolCallId = vi.fn(async () => ({
      toolCall: {
        id: 'db-call-1',
        taskId: 'task-1',
        toolName: 'test.send',
        status: 'executing',
        result: null,
        error: null,
      },
      approval: null,
    }));
    const outcome = vi.fn(async () => true);
    const dispatcher = new ToolDispatcher({} as Db, registry, {
      kind: 'tool-execution-repository',
      findByModelToolCallId,
      outcome,
    } as never);

    const result = await dispatcher.dispatch({
      task,
      step: 1,
      modelToolCallId: 'model-call-1',
      toolName: 'test.send',
      args: {},
      ctx: {
        taskId: 'task-1',
        agentId: 'agent-1',
        trust: 'owner',
        tainted: false,
        db: {} as Db,
        now: () => new Date(),
        signal: new AbortController().signal,
        log: async () => {},
      },
      provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
    });

    expect(result).toEqual({
      kind: 'rejected',
      reason: 'the provider outcome is unknown; the call was not retried automatically',
    });
    expect(findByModelToolCallId).toHaveBeenCalledWith('agent-1', 'task-1', 'model-call-1');
    expect(outcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', fromStatus: 'executing' }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('scopes autonomous cache keys to the installation owner', async () => {
    const execute = vi.fn(async () => ({ value: 'private result' }));
    const registry = new ToolRegistry().register({
      name: 'fixture.cached_read',
      description: 'cached private read',
      inputSchema: z.object({ query: z.string() }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      cacheTtlSeconds: 60,
      execute,
    });
    const readKeys: string[] = [];
    const writeKeys: string[] = [];
    let callSequence = 0;
    const executionRepository = {
      kind: 'tool-execution-repository',
      findByModelToolCallId: async () => null,
      underRateLimit: async () => true,
      cacheGet: async (key: string) => {
        readKeys.push(key);
        return null;
      },
      cachePut: async ({ cacheKey }: { cacheKey: string }) => {
        writeKeys.push(cacheKey);
      },
      findIdempotent: async () => null,
      start: async () => ({ id: `call-${++callSequence}` }),
      outcome: async () => true,
    };
    const dispatcher = new ToolDispatcher(
      {} as Db,
      registry,
      executionRepository as never,
      undefined,
      undefined,
      { kind: 'approval-policy-repository', list: async () => [] } as never,
    );

    const dispatchFor = async (agentId: string, taskId: string) =>
      dispatcher.dispatch({
        task: {
          id: taskId,
          agentId,
          type: 'chat_turn',
          trust: 'owner',
          trigger: { source: 'chat', payload: { text: 'Read the private result.' } },
        } as never,
        step: 1,
        modelToolCallId: `model-${agentId}`,
        toolName: 'fixture.cached_read',
        args: { query: 'same' },
        ctx: {
          taskId,
          agentId,
          trust: 'owner',
          tainted: false,
          db: {} as Db,
          now: () => new Date(),
          signal: new AbortController().signal,
          log: async () => {},
        },
        provenance: { plannerVersion: 1, promptVersion: 1, model: 'test' },
      });

    await dispatchFor('agent-one', 'task-one');
    await dispatchFor('agent-two', 'task-two');

    expect(new Set(readKeys).size).toBe(2);
    expect(new Set(writeKeys).size).toBe(2);
    expect(readKeys).toEqual(writeKeys);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('clarification continuation dispatch boundary', () => {
  it('uses positive clarification context only to reach the original approval gate', async () => {
    const sendExecute = vi.fn(async () => ({ sent: true }));
    const reminderExecute = vi.fn(async () => ({ created: true }));
    const registry = new ToolRegistry()
      .register(
        {
          name: 'message.send',
          description: 'send an owner-requested message',
          inputSchema: z.object({ to: z.string(), body: z.string() }),
          risk: 'approval',
          acceptsUntrustedInput: true,
          execute: sendExecute,
        },
        { outwardFacing: true },
      )
      .register(
        {
          name: 'reminders.create',
          description: 'create an owner reminder',
          inputSchema: z.object({ title: z.string() }),
          risk: 'autonomous',
          acceptsUntrustedInput: true,
          execute: reminderExecute,
        },
        { privateWrite: true },
      );
    const approvalCreate = vi.fn(async () => ({
      toolCallId: 'tool-call-1',
      approvalId: 'approval-1',
      shortCode: '123456',
      summary: 'Send message',
    }));
    const dispatcher = new ToolDispatcher(
      {} as Db,
      registry,
      {
        kind: 'tool-execution-repository',
        findByModelToolCallId: async () => null,
        findReceiptByModelToolCallId: async () => null,
      } as never,
      undefined,
      { kind: 'approval-repository', create: approvalCreate } as never,
      { kind: 'approval-policy-repository', list: async () => [] } as never,
    );
    const task = {
      id: 'answer-task',
      agentId: 'agent-1',
      type: 'chat_turn',
      trust: 'owner',
      trigger: { source: 'chat', payload: { text: 'Use planning@example.test.' } },
    } as never;
    const continuation = {
      sourceTaskId: 'clarification-task',
      ownerAuthoredText: 'Email the agenda to the planning group.',
      question: 'Which recipient should receive it?',
      authorizedScopes: ['external_send'],
      tainted: false,
      answerStatus: 'answer',
    } satisfies NonNullable<Parameters<typeof latestOwnerIntent>[1]['clarificationContinuation']>;
    const ownerIntent = latestOwnerIntent(
      [{ role: 'user', content: 'Use planning@example.test.' }],
      { trust: 'owner', clarificationContinuation: continuation },
    );
    expect(ownerIntent.authorizedScopes).toEqual(['external_send']);
    const ctx: ToolContext = {
      taskId: 'answer-task',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      trust: 'owner',
      tainted: true,
      ownerIntent,
      db: {} as Db,
      now: () => new Date(),
      signal: new AbortController().signal,
      log: async () => {},
    };
    const base = {
      task,
      step: 1,
      ctx,
      provenance: { plannerVersion: 1, promptVersion: 1, model: 'synthetic' },
    };

    const originalAction = await dispatcher.dispatch({
      ...base,
      modelToolCallId: 'send-from-clarification',
      toolName: 'message.send',
      args: { to: 'planning@example.test', body: 'The agenda is ready.' },
    });
    expect(originalAction).toMatchObject({ kind: 'awaiting_approval', approvalId: 'approval-1' });
    expect(approvalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'answer-task',
        toolName: 'message.send',
        args: { to: 'planning@example.test', body: 'The agenda is ready.' },
      }),
    );
    expect(sendExecute).not.toHaveBeenCalled();

    const unrelatedAction = await dispatcher.dispatch({
      ...base,
      modelToolCallId: 'reminder-from-clarification',
      toolName: 'reminders.create',
      args: { title: 'Send the planning group a reminder' },
    });
    expect(unrelatedAction).toMatchObject({ kind: 'rejected' });
    expect(reminderExecute).not.toHaveBeenCalled();
  });
});
