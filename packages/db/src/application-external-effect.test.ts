import { randomUUID } from 'node:crypto';
import { applicationExternalEffectArgsDigest } from '@assistant/persistence';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerApplicationTools } from '../../tools/src/applications.js';
import { GoogleApiError } from '../../tools/src/google/client.js';
import { ToolRegistry } from '../../tools/src/registry.js';
import { createPostgresApplicationConfirmationRepository } from './application-confirmation-repository.js';
import { createDb, type Db } from './client.js';
import {
  createPostgresPrivacyErasureRepository,
  postgresPrivacyObservationFence,
} from './privacy-erasure-repository.js';
import {
  agents,
  applicationConfirmations,
  conversations,
  maintenanceCursors,
  tasks,
  toolCalls,
} from './schema.js';
import { createPostgresTaskRepository } from './task-lifecycle-repository.js';

const DATABASE_URL = process.env.DATABASE_URL;
function testUrl() {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
}

describe('PostgreSQL application external-effect gate', () => {
  let db: Db;
  let agentId: string;
  let conversationId: string;
  const applicationIds: string[] = [];
  const taskIds: string[] = [];
  const toolCallIds: string[] = [];
  const erasureCursorNames: string[] = [];

  beforeAll(async () => {
    db = createDb(testUrl());
    const [owner] = await db.select({ id: agents.id }).from(agents).limit(1);
    if (!owner) throw new Error('Seed the isolated test database');
    agentId = owner.id;
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'Effect gate fixture' })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('conversation insert failed');
    conversationId = conversation.id;
  });

  afterAll(async () => {
    for (const id of toolCallIds) await db.delete(toolCalls).where(eq(toolCalls.id, id));
    for (const id of applicationIds)
      await db
        .delete(applicationConfirmations)
        .where(
          and(eq(applicationConfirmations.agentId, agentId), eq(applicationConfirmations.id, id)),
        );
    for (const id of taskIds) await db.delete(tasks).where(eq(tasks.id, id));
    for (const name of erasureCursorNames)
      await db.delete(maintenanceCursors).where(eq(maintenanceCursors.name, name));
    if (conversationId) await db.delete(conversations).where(eq(conversations.id, conversationId));
    await db.$client.end();
  });

  async function fixture(action: 'sheet' | 'document', activeErasure = false) {
    const producerPrivacyGeneration = activeErasure
      ? ((
          await db
            .select({ cursor: maintenanceCursors.cursor })
            .from(maintenanceCursors)
            .where(eq(maintenanceCursors.name, `privacy-erasure-generation:${agentId}`))
            .limit(1)
        )[0]?.cursor ?? null)
      : await postgresPrivacyObservationFence(db, agentId);
    const applicationId = randomUUID();
    const toolCallId = randomUUID();
    const toolName =
      action === 'sheet'
        ? 'applications.apply_confirmation'
        : 'applications.append_confirmation_doc';
    const idempotencyKey =
      action === 'sheet'
        ? `application-confirmation-apply-${applicationId}`
        : `application-confirmation-doc-${applicationId}`;
    const trackerUpdate = {
      spreadsheetId: 'spreadsheet_123456789',
      sheetName: 'Applications',
      startCell: 'A2',
      rows: [['Example Corp', 'Engineer']],
    };
    const documentUpdate = { documentId: 'document_123456789', content: 'Application received.' };
    const trigger = {
      source: 'internal',
      externalEventId: `application-confirmation:gmail:effect-${applicationId}`,
      payload: {
        kind: 'application_confirmation',
        applicationId,
        confirmationMessageId: `gmail:effect-${applicationId}`,
        producerPrivacyGeneration,
      },
    };
    const taskRepository = createPostgresTaskRepository(db);
    const taskResult = await taskRepository.createTask({
      agentId,
      type: 'adhoc',
      trust: 'assistant',
      trigger,
      externalEventId: `application-confirmation:gmail:effect-${applicationId}`,
      conversationId,
    });
    const exactTaskId = taskResult.task.id;
    taskIds.push(exactTaskId);
    const lease = await taskRepository.claim(exactTaskId);
    if (!lease?.leaseToken) throw new Error('application task lease was not claimed');
    await db.insert(applicationConfirmations).values({
      id: applicationId,
      agentId,
      sourceTaskId: exactTaskId,
      conversationId,
      company: 'Example Corp',
      role: 'Engineer',
      expectedSenderEmails: ['sender@example.test'],
      confirmationTokenHash: 'a'.repeat(64),
      confirmationTokenHint: '1234',
      trackerUpdate: action === 'sheet' ? trackerUpdate : null,
      documentUpdate: action === 'document' ? documentUpdate : null,
      actionState:
        action === 'sheet' ? { sheet: { status: 'pending' } } : { document: { status: 'pending' } },
      status: 'confirmation_received',
      expiresAt: new Date(Date.now() + 60_000),
      confirmationMessageId: `gmail:effect-${applicationId}`,
      producerPrivacyGeneration,
    });
    applicationIds.push(applicationId);
    await db.insert(toolCalls).values({
      id: toolCallId,
      taskId: exactTaskId,
      step: 1,
      toolName,
      args: { applicationId },
      risk: 'autonomous',
      status: 'executing',
      idempotencyKey,
      decision: {},
    });
    toolCallIds.push(toolCallId);

    let activeName: string | undefined;
    if (activeErasure) {
      activeName = `privacy-erasure-active:${agentId}`;
      erasureCursorNames.push(activeName);
      await db.insert(maintenanceCursors).values({
        name: activeName,
        cursor: JSON.stringify({
          version: 1,
          generation: '1',
          phase: 'attachments',
          afterId: null,
        }),
      });
    }

    return {
      applicationId,
      taskId: exactTaskId,
      taskLeaseToken: lease.leaseToken,
      toolCallId,
      toolName,
      idempotencyKey,
      action,
      args: action === 'sheet' ? trackerUpdate : documentUpdate,
      producerPrivacyGeneration,
    };
  }

  function claim(input: Awaited<ReturnType<typeof fixture>>) {
    return createPostgresApplicationConfirmationRepository(db).claimExternalEffect({
      agentId,
      applicationId: input.applicationId,
      action: input.action,
      expectedProducerPrivacyGeneration: input.producerPrivacyGeneration,
      taskId: input.taskId,
      taskLeaseToken: input.taskLeaseToken,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      idempotencyKey: input.idempotencyKey,
      argsDigest: applicationExternalEffectArgsDigest(input.action, input.args),
      now: new Date(),
    });
  }

  it('commits unknown before dispatch, blocks replay, and only settles the matching claim token', async () => {
    const input = await fixture('sheet');
    const repository = createPostgresApplicationConfirmationRepository(db);
    const claimed = await claim(input);
    expect(claimed.status).toBe('claimed');
    if (claimed.status !== 'claimed') return;
    expect(claimed.record.actionState).toMatchObject({ sheet: { status: 'unknown' } });
    expect(
      (claimed.record.actionState as { sheet?: { effectReceipt?: Record<string, unknown> } }).sheet
        ?.effectReceipt,
    ).not.toHaveProperty('rows');
    expect(await claim(input)).toEqual({ status: 'blocked' });
    expect(
      await repository.settleExternalEffect({
        agentId,
        applicationId: input.applicationId,
        action: 'sheet',
        claimToken: '00000000-0000-4000-8000-000000000000',
        status: 'succeeded',
        now: new Date(),
      }),
    ).toBeNull();
    const settled = await repository.settleExternalEffect({
      agentId,
      applicationId: input.applicationId,
      action: 'sheet',
      claimToken: claimed.claimToken,
      status: 'succeeded',
      now: new Date(),
    });
    expect(settled?.actionState).toMatchObject({ sheet: { status: 'succeeded' } });
  });

  it('blocks a provider claim when the owner erasure fence already won', async () => {
    const input = await fixture('document', true);
    expect(await claim(input)).toEqual({ status: 'blocked' });
    await db
      .delete(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `privacy-erasure-active:${agentId}`));
  });

  it('rejects mismatched task, call, owner, trigger, generation, args, and lease identities', async () => {
    const input = await fixture('sheet');
    const repository = createPostgresApplicationConfirmationRepository(db);
    const base = {
      agentId,
      applicationId: input.applicationId,
      action: input.action,
      expectedProducerPrivacyGeneration: input.producerPrivacyGeneration,
      taskId: input.taskId,
      taskLeaseToken: input.taskLeaseToken,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      idempotencyKey: input.idempotencyKey,
      argsDigest: applicationExternalEffectArgsDigest(input.action, input.args),
      now: new Date(),
    };
    const foreignAgentId = randomUUID();
    await db.insert(agents).values({
      id: foreignAgentId,
      name: 'Foreign fixture',
      email: `${foreignAgentId}@example.test`,
      workspacePrefix: `effect-gate-${foreignAgentId}`,
    });
    const invalid = [
      { toolName: 'applications.append_confirmation_doc' },
      { idempotencyKey: 'wrong-idempotency-key' },
      { toolCallId: randomUUID() },
      { taskLeaseToken: 'wrong-lease-token' },
      { argsDigest: 'f'.repeat(64) },
      { agentId: foreignAgentId },
    ];
    for (const override of invalid)
      expect(await repository.claimExternalEffect({ ...base, ...override } as typeof base)).toEqual(
        { status: 'blocked' },
      );

    const [task] = await db.select().from(tasks).where(eq(tasks.id, input.taskId));
    await db
      .update(tasks)
      .set({ trigger: { source: 'internal', payload: { kind: 'application_confirmation' } } })
      .where(eq(tasks.id, input.taskId));
    expect(await repository.claimExternalEffect(base)).toEqual({ status: 'blocked' });
    await db.update(tasks).set({ trigger: task?.trigger }).where(eq(tasks.id, input.taskId));

    await db
      .update(tasks)
      .set({ lockedUntil: new Date(Date.now() - 1_000) })
      .where(eq(tasks.id, input.taskId));
    expect(await repository.claimExternalEffect(base)).toEqual({ status: 'blocked' });
    await db.delete(agents).where(eq(agents.id, foreignAgentId));
  });

  it('performs zero Sheet writes when the dispatcher task lease expires before claim', async () => {
    const input = await fixture('sheet');
    const repository = createPostgresApplicationConfirmationRepository(db);
    let enteredApplicationRead!: () => void;
    let releaseApplicationRead!: () => void;
    const readEntered = new Promise<void>((resolve) => (enteredApplicationRead = resolve));
    const readBarrier = new Promise<void>((resolve) => (releaseApplicationRead = resolve));
    const applications = {
      ...repository,
      get: async (id: string) => {
        const current = await repository.get(id);
        enteredApplicationRead();
        await readBarrier;
        return current;
      },
    };
    const provider = vi.fn(async () => ({}));
    const registry = new ToolRegistry();
    registerApplicationTools(registry, {
      client: { api: provider } as never,
      applications,
      tasks: {
        getTask: async (id) => {
          const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
          return (row as never) ?? null;
        },
      },
    });
    const registered = registry.get(input.toolName)?.tool;
    if (!registered) throw new Error('Sheet tool was not registered');
    const execute = registered.execute as (args: unknown, context: unknown) => Promise<unknown>;
    const ctx = {
      taskId: input.taskId,
      taskLeaseToken: input.taskLeaseToken,
      agentId,
      trust: 'assistant',
      tainted: false,
      db,
      now: () => new Date(),
      signal: new AbortController().signal,
      log: async () => {},
      execution: {
        dbToolCallId: input.toolCallId,
        modelToolCallId: 'model-call-expired-lease',
        toolName: input.toolName,
      },
    };
    const pending = execute({ applicationId: input.applicationId }, ctx);
    await readEntered;
    await db
      .update(tasks)
      .set({ lockedUntil: new Date(Date.now() - 1_000) })
      .where(eq(tasks.id, input.taskId));
    releaseApplicationRead();
    await expect(pending).rejects.toThrow(
      'Sheet confirmation was blocked before provider dispatch',
    );
    expect(provider).not.toHaveBeenCalled();
  });

  it('runs the registered Sheet tool through the PG gate and suppresses ambiguous replay', async () => {
    const input = await fixture('sheet');
    const repository = createPostgresApplicationConfirmationRepository(db);
    const calls: Array<{ url: string; method: string }> = [];
    const client = {
      api: vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, method: init.method ?? 'GET' });
        const [current] = await db
          .select({ actionState: applicationConfirmations.actionState })
          .from(applicationConfirmations)
          .where(eq(applicationConfirmations.id, input.applicationId));
        expect(current?.actionState).toMatchObject({ sheet: { status: 'unknown' } });
        throw new Error('transport interrupted after dispatch');
      }),
    };
    const registry = new ToolRegistry();
    registerApplicationTools(registry, {
      client: client as never,
      applications: repository,
      tasks: {
        getTask: async (id) => {
          const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
          return (row as never) ?? null;
        },
      },
    });
    const registered = registry.get(input.toolName)?.tool;
    if (!registered) throw new Error('Sheet tool was not registered');
    const [taskFixture] = await db.select().from(tasks).where(eq(tasks.id, input.taskId));
    const [callFixture] = await db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.id, input.toolCallId));
    expect(taskFixture?.trigger).toEqual({
      source: 'internal',
      externalEventId: `application-confirmation:gmail:effect-${input.applicationId}`,
      payload: {
        kind: 'application_confirmation',
        applicationId: input.applicationId,
        confirmationMessageId: `gmail:effect-${input.applicationId}`,
        producerPrivacyGeneration: input.producerPrivacyGeneration,
      },
    });
    expect(callFixture).toMatchObject({
      taskId: input.taskId,
      toolName: input.toolName,
      idempotencyKey: input.idempotencyKey,
      status: 'executing',
      args: { applicationId: input.applicationId },
    });
    const ctx = {
      taskId: input.taskId,
      agentId,
      trust: 'assistant',
      tainted: false,
      db,
      now: () => new Date(),
      signal: new AbortController().signal,
      log: async () => {},
      execution: {
        dbToolCallId: input.toolCallId,
        modelToolCallId: 'model-call-1',
        toolName: input.toolName,
      },
      taskLeaseToken: input.taskLeaseToken,
    };
    const execute = registered.execute as (args: unknown, context: unknown) => Promise<unknown>;
    const outcome = await execute({ applicationId: input.applicationId }, ctx);
    expect(outcome).toMatchObject({ status: 'unknown' });
    expect(calls).toHaveLength(1);
    await expect(execute({ applicationId: input.applicationId }, ctx)).rejects.toThrow(
      'Sheet confirmation action is unknown; automatic retry is forbidden',
    );
    expect(calls).toHaveLength(1);
  });

  it('performs zero registered-tool provider writes when erasure wins the fence', async () => {
    const input = await fixture('sheet', true);
    const provider = vi.fn(async () => ({}));
    const registry = new ToolRegistry();
    registerApplicationTools(registry, {
      client: { api: provider } as never,
      applications: createPostgresApplicationConfirmationRepository(db),
      tasks: {
        getTask: async (id) => {
          const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
          return (row as never) ?? null;
        },
      },
    });
    const registered = registry.get(input.toolName)?.tool;
    if (!registered) throw new Error('Sheet tool was not registered');
    const execute = registered.execute as (args: unknown, context: unknown) => Promise<unknown>;
    const ctx = {
      taskId: input.taskId,
      agentId,
      trust: 'assistant',
      tainted: false,
      db,
      now: () => new Date(),
      signal: new AbortController().signal,
      log: async () => {},
      execution: {
        dbToolCallId: input.toolCallId,
        modelToolCallId: 'model-call-erasure',
        toolName: input.toolName,
      },
      taskLeaseToken: input.taskLeaseToken,
    };
    await expect(execute({ applicationId: input.applicationId }, ctx)).rejects.toThrow(
      'Sheet confirmation was blocked before provider dispatch',
    );
    expect(provider).not.toHaveBeenCalled();
    await db
      .delete(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `privacy-erasure-active:${agentId}`));
  });

  it('settles a claimed Doc write after actual memory erasure without recreating its payload', async () => {
    const input = await fixture('document');
    let enteredProvider!: () => void;
    let releaseProvider!: () => void;
    const providerEntered = new Promise<void>((resolve) => (enteredProvider = resolve));
    const providerBarrier = new Promise<void>((resolve) => (releaseProvider = resolve));
    const provider = vi.fn(async (_url: string, init: RequestInit = {}) => {
      if ((init.method ?? 'GET') === 'GET') return { body: { content: [{ endIndex: 1 }] } };
      enteredProvider();
      await providerBarrier;
      return {};
    });
    const repository = createPostgresApplicationConfirmationRepository(db);
    const registry = new ToolRegistry();
    registerApplicationTools(registry, {
      client: { api: provider } as never,
      applications: repository,
      tasks: {
        getTask: async (id) => {
          const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
          return (row as never) ?? null;
        },
      },
    });
    const registered = registry.get(input.toolName)?.tool;
    if (!registered) throw new Error('Doc tool was not registered');
    const execute = registered.execute as (args: unknown, context: unknown) => Promise<unknown>;
    const ctx = {
      taskId: input.taskId,
      agentId,
      trust: 'assistant',
      tainted: false,
      db,
      now: () => new Date(),
      signal: new AbortController().signal,
      log: async () => {},
      execution: {
        dbToolCallId: input.toolCallId,
        modelToolCallId: 'model-call-doc-claim-first',
        toolName: input.toolName,
      },
      taskLeaseToken: input.taskLeaseToken,
    };
    const pending = execute({ applicationId: input.applicationId }, ctx);
    await providerEntered;
    const claimed = await repository.get(input.applicationId);
    expect(claimed?.actionState).toMatchObject({ document: { status: 'unknown' } });
    await createPostgresPrivacyErasureRepository(db).erase();
    releaseProvider();
    const outcome = await pending;
    expect(outcome).toMatchObject({ action: 'document', status: 'succeeded' });
    const settled = await repository.get(input.applicationId);
    expect(settled?.documentUpdate).toEqual(input.args);
    expect(settled?.actionState).toMatchObject({ document: { status: 'succeeded' } });
    await db
      .delete(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `privacy-erasure-result:${agentId}`));
    await db
      .delete(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `privacy-erasure-active:${agentId}`));
  });

  it.each([408, 403])(
    'suppresses a second Doc batchUpdate after an HTTP %i error',
    async (status) => {
      const input = await fixture('document');
      const provider = vi.fn(async (_url: string, init: RequestInit = {}) => {
        if ((init.method ?? 'GET') === 'GET') return { body: { content: [{ endIndex: 1 }] } };
        throw new GoogleApiError(status, 'Provider returned an error', _url);
      });
      const registry = new ToolRegistry();
      registerApplicationTools(registry, {
        client: { api: provider } as never,
        applications: createPostgresApplicationConfirmationRepository(db),
        tasks: {
          getTask: async (id) => {
            const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
            return (row as never) ?? null;
          },
        },
      });
      const registered = registry.get(input.toolName)?.tool;
      if (!registered) throw new Error('Doc tool was not registered');
      const execute = registered.execute as (args: unknown, context: unknown) => Promise<unknown>;
      const ctx = {
        taskId: input.taskId,
        taskLeaseToken: input.taskLeaseToken,
        agentId,
        trust: 'assistant',
        tainted: false,
        db,
        now: () => new Date(),
        signal: new AbortController().signal,
        log: async () => {},
        execution: {
          dbToolCallId: input.toolCallId,
          modelToolCallId: 'model-call-doc-timeout',
          toolName: input.toolName,
        },
      };
      const outcome = await execute({ applicationId: input.applicationId }, ctx);
      expect(outcome).toMatchObject({ action: 'document', status: 'unknown' });
      expect(provider.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['GET', 'POST']);
      await expect(execute({ applicationId: input.applicationId }, ctx)).rejects.toThrow(
        'Google Doc confirmation action is unknown; automatic retry is forbidden',
      );
      expect(provider.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['GET', 'POST']);
    },
  );

  it('blocks a Doc mutation when erasure changes generation during preflight GET', async () => {
    const input = await fixture('document');
    let enteredGet!: () => void;
    let releaseGet!: () => void;
    const getEntered = new Promise<void>((resolve) => (enteredGet = resolve));
    const getBarrier = new Promise<void>((resolve) => (releaseGet = resolve));
    const provider = vi.fn(async (_url: string, init: RequestInit = {}) => {
      if ((init.method ?? 'GET') === 'GET') {
        enteredGet();
        await getBarrier;
        return { body: { content: [{ endIndex: 1 }] } };
      }
      return {};
    });
    const registry = new ToolRegistry();
    registerApplicationTools(registry, {
      client: { api: provider } as never,
      applications: createPostgresApplicationConfirmationRepository(db),
      tasks: {
        getTask: async (id) => {
          const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
          return (row as never) ?? null;
        },
      },
    });
    const registered = registry.get(input.toolName)?.tool;
    if (!registered) throw new Error('Doc tool was not registered');
    const execute = registered.execute as (args: unknown, context: unknown) => Promise<unknown>;
    const ctx = {
      taskId: input.taskId,
      agentId,
      trust: 'assistant',
      tainted: false,
      db,
      now: () => new Date(),
      signal: new AbortController().signal,
      log: async () => {},
      execution: {
        dbToolCallId: input.toolCallId,
        modelToolCallId: 'model-call-doc-erasure-first',
        toolName: input.toolName,
      },
      taskLeaseToken: input.taskLeaseToken,
    };
    const pending = execute({ applicationId: input.applicationId }, ctx);
    await getEntered;
    await createPostgresPrivacyErasureRepository(db).erase();
    releaseGet();
    await expect(pending).rejects.toThrow('Doc confirmation was blocked before provider dispatch');
    expect(provider.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['GET']);
    const current = await createPostgresApplicationConfirmationRepository(db).get(
      input.applicationId,
    );
    expect(current?.actionState).toMatchObject({ document: { status: 'pending' } });
    await db
      .delete(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `privacy-erasure-result:${agentId}`));
    await db
      .delete(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `privacy-erasure-active:${agentId}`));
  });
});
