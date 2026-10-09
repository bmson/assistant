import { randomUUID } from 'node:crypto';
import { chatAdmissionCancellationPayload, chatAdmissionPayload } from '@assistant/persistence';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresApplicationChatPersistence } from './application-chat-repository.js';
import { createDb, type Db } from './client.js';
import { agents, conversations, messages, tasks } from './schema.js';

describe('PostgreSQL application chat persistence', () => {
  let db: Db;
  const conversationIds: string[] = [];

  beforeAll(() => {
    db = createDb(
      process.env.DATABASE_URL ?? 'postgres://assistant@127.0.0.1:55432/assistant_test',
    );
  });

  afterAll(async () => {
    if (conversationIds.length) {
      await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
      await db.delete(tasks).where(inArray(tasks.conversationId, conversationIds));
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
    await db.$client.end();
  });

  it('enforces ownership and preserves idempotent message delivery', async () => {
    const repository = createPostgresApplicationChatPersistence(db);
    const agent = await repository.resolveAgent();
    const conversation = await repository.createConversation(agent.id);
    conversationIds.push(conversation.id);

    await expect(repository.getConversation(randomUUID(), conversation.id)).resolves.toBeNull();
    await expect(
      repository.appendOwned(randomUUID(), {
        conversationId: conversation.id,
        role: 'user',
        origin: 'owner',
        parts: [{ type: 'text', text: 'private' }],
        text: 'private',
      }),
    ).rejects.toThrow('chat not found');

    const channelMessageId = `chat-test:${randomUUID()}`;
    const input = {
      conversationId: conversation.id,
      role: 'user' as const,
      origin: 'owner' as const,
      parts: [{ type: 'text', text: 'hello' }],
      text: 'hello',
      channelMessageId,
    };
    const first = await repository.appendOwned(agent.id, input);
    expect(first?.text).toBe('hello');
    await expect(repository.appendOwned(agent.id, input)).resolves.toBeUndefined();
    expect((await repository.listMessages(agent.id, conversation.id))?.messages).toHaveLength(1);
  });

  it('refuses unsupported coexisting owners rather than selecting the oldest', async () => {
    await db.transaction(async (tx) => {
      const foreignId = randomUUID();
      await tx.insert(agents).values({
        id: foreignId,
        name: 'Second owner',
        email: `${foreignId}@example.test`,
        workspacePrefix: `test/${foreignId}`,
      });
      await expect(
        createPostgresApplicationChatPersistence(tx as unknown as Db).resolveAgent(),
      ).rejects.toThrow('exactly one owner');
      // Leave the allocator-owned fixture unchanged for the following cases.
      await tx.delete(agents).where(inArray(agents.id, [foreignId]));
    });
  });

  it('atomically deduplicates chat operation admissions and preserves distinct identical sends', async () => {
    const repository = createPostgresApplicationChatPersistence(db);
    const agent = await repository.resolveAgent();
    const conversation = await repository.createConversation(agent.id);
    conversationIds.push(conversation.id);
    const firstOperationId = randomUUID();
    const input = {
      agentId: agent.id,
      conversationId: conversation.id,
      clientOperationId: firstOperationId,
      requestHash: 'a'.repeat(64),
      text: 'Remind me to call Sam tomorrow.',
      autonomous: false,
      force: false,
      spoken: false,
    };

    const [first, concurrent] = await Promise.all([
      repository.admitChatTurn(input),
      repository.admitChatTurn(input),
    ]);
    expect([first.created, concurrent.created].sort()).toEqual([false, true]);
    if (first.kind !== 'admitted' || concurrent.kind !== 'admitted')
      throw new Error('expected normal chat admission results');
    expect(first.task.id).toBe(concurrent.task.id);
    expect(first.message.id).toBe(concurrent.message.id);
    expect(first.lease ?? concurrent.lease).toBeDefined();
    expect(first.task.externalEventId).toContain(firstOperationId);
    expect(first.message.taskId).toBe(first.task.id);

    await expect(
      repository.admitChatTurn({
        ...input,
        text: 'Send an email to Sam.',
        requestHash: 'c'.repeat(64),
      }),
    ).rejects.toThrow('already used for a different request');

    const second = await repository.admitChatTurn({
      ...input,
      clientOperationId: randomUUID(),
    });
    if (second.kind !== 'admitted') throw new Error('expected a normal chat admission result');
    expect(second.created).toBe(true);
    expect(second.task.id).not.toBe(first.task.id);
    expect(second.task.trigger).toMatchObject({
      payload: { triggerMessageId: second.message.id, text: input.text },
    });
    expect(first.task.trigger).toMatchObject({
      payload: { triggerMessageId: first.message.id, text: input.text },
    });
    expect((await repository.listMessages(agent.id, conversation.id))?.messages).toHaveLength(2);
    const directLease = second.lease;
    if (!directLease) throw new Error('newly admitted task did not return its lease');
    await expect(
      repository.markChatTurnStreaming({
        agentId: agent.id,
        task: directLease,
        triageOutcome: 'conversational',
      }),
    ).resolves.toBe(true);
    const [directTask] = await db
      .select()
      .from(tasks)
      .where(inArray(tasks.id, [second.task.id]));
    expect(directTask && chatAdmissionPayload(directTask)).toMatchObject({
      phase: 'streaming',
      triageOutcome: 'conversational',
    });

    const queueLease = first.lease ?? concurrent.lease;
    if (!queueLease) throw new Error('newly admitted task did not return its lease');
    const queued = await repository.queueAdmittedChatTurn({
      agentId: agent.id,
      task: queueLease,
      triagedActionable: true,
    });
    expect(queued).toMatchObject({ id: first.task.id, queueGeneration: 1 });
    const [queuedTask] = await db
      .select()
      .from(tasks)
      .where(inArray(tasks.id, [first.task.id]));
    expect(queuedTask && chatAdmissionPayload(queuedTask)).toMatchObject({ phase: 'queued' });
    expect(queuedTask?.trigger).toMatchObject({ payload: { triagedActionable: true } });
    expect(
      await repository.queueAdmittedChatTurn({
        agentId: agent.id,
        task: queueLease,
        triagedActionable: true,
      }),
    ).toBeNull();
  });

  it('durably cancels before admission and replays without creating owner content', async () => {
    const repository = createPostgresApplicationChatPersistence(db);
    const agent = await repository.resolveAgent();
    const conversation = await repository.createConversation(agent.id);
    conversationIds.push(conversation.id);
    const clientOperationId = randomUUID();
    await expect(
      repository.cancelChatTurn({
        agentId: agent.id,
        conversationId: conversation.id,
        clientOperationId: 'not-a-uuid',
      }),
    ).rejects.toThrow('Invalid chat admission operation identity');
    const input = {
      agentId: agent.id,
      conversationId: conversation.id,
      clientOperationId,
      requestHash: 'e'.repeat(64),
      text: 'Send a private message that must never be admitted.',
      autonomous: false,
      force: false,
      spoken: false,
    };

    const first = await repository.cancelChatTurn({
      agentId: agent.id,
      conversationId: conversation.id,
      clientOperationId,
    });
    expect(first).toMatchObject({
      kind: 'cancelled_before_admission',
      status: 'cancelled',
      transitioned: true,
      effectStatus: 'not_started',
    });
    expect(first.task).toMatchObject({
      status: 'cancelled',
      title: null,
      plan: null,
      state: {},
      queueGeneration: 0,
      spentUsd: '0.000000',
      lockedUntil: null,
      leaseToken: null,
      runAfter: null,
      attempt: 0,
      trust: 'owner',
    });
    expect(chatAdmissionCancellationPayload(first.task)).toMatchObject({ clientOperationId });
    await expect(
      repository.getTaskStatus(agent.id, conversation.id, first.task.id),
    ).resolves.toBeNull();
    await expect(
      repository.listTaskActivity(agent.id, conversation.id, first.task.id),
    ).resolves.toEqual([]);
    expect(first.task.trigger).not.toHaveProperty('payload.text');
    expect((await repository.listMessages(agent.id, conversation.id))?.messages).toEqual([]);

    const replay = await repository.admitChatTurn(input);
    expect(replay).toMatchObject({
      kind: 'cancelled_before_admission',
      created: false,
      status: 'cancelled',
      effectStatus: 'not_started',
    });
    expect(replay.task.id).toBe(first.task.id);
    expect((await repository.listMessages(agent.id, conversation.id))?.messages).toEqual([]);
    await expect(
      repository.cancelChatTurn({
        agentId: agent.id,
        conversationId: conversation.id,
        clientOperationId,
      }),
    ).resolves.toMatchObject({
      kind: 'cancelled_before_admission',
      transitioned: false,
      effectStatus: 'not_started',
    });
  });

  it('linearizes a concurrent stop against admission without ghosting owner text', async () => {
    const repository = createPostgresApplicationChatPersistence(db);
    const agent = await repository.resolveAgent();
    const conversation = await repository.createConversation(agent.id);
    conversationIds.push(conversation.id);
    const clientOperationId = randomUUID();
    const input = {
      agentId: agent.id,
      conversationId: conversation.id,
      clientOperationId,
      requestHash: '9'.repeat(64),
      text: 'This text must either be admitted once or remain absent.',
      autonomous: false,
      force: false,
      spoken: false,
    };
    const [stopped, admitted] = await Promise.all([
      repository.cancelChatTurn({
        agentId: agent.id,
        conversationId: conversation.id,
        clientOperationId,
      }),
      repository.admitChatTurn(input),
    ]);
    if (admitted.kind === 'cancelled_before_admission') {
      expect(stopped).toMatchObject({
        kind: 'cancelled_before_admission',
        effectStatus: 'not_started',
      });
      expect(stopped.task.id).toBe(admitted.task.id);
      expect((await repository.listMessages(agent.id, conversation.id))?.messages).toEqual([]);
    } else {
      expect(stopped).toMatchObject({
        kind: 'admitted_task',
        status: 'cancelled',
        effectStatus: 'unknown',
      });
      expect(stopped.task.id).toBe(admitted.task.id);
      expect(
        (await repository.listMessages(agent.id, conversation.id))?.messages.map(
          (message) => message.text,
        ),
      ).toEqual([input.text]);
    }
    const [stored] = await db
      .select()
      .from(tasks)
      .where(inArray(tasks.id, [stopped.task.id]));
    expect(stored).toMatchObject({
      status: 'cancelled',
      lockedUntil: null,
      leaseToken: null,
      runAfter: null,
      queueGeneration: 0,
    });
  });

  it('cancels an admitted task conservatively and preserves already-terminal tasks', async () => {
    const repository = createPostgresApplicationChatPersistence(db);
    const agent = await repository.resolveAgent();
    const conversation = await repository.createConversation(agent.id);
    conversationIds.push(conversation.id);
    const activeOperationId = randomUUID();
    const active = await repository.admitChatTurn({
      agentId: agent.id,
      conversationId: conversation.id,
      clientOperationId: activeOperationId,
      requestHash: 'f'.repeat(64),
      text: 'Start work.',
      autonomous: false,
      force: false,
      spoken: false,
    });
    if (active.kind !== 'admitted') throw new Error('expected a normal chat admission result');
    const stopped = await repository.cancelChatTurn({
      agentId: agent.id,
      conversationId: conversation.id,
      clientOperationId: activeOperationId,
    });
    expect(stopped).toMatchObject({
      kind: 'admitted_task',
      status: 'cancelled',
      transitioned: true,
      effectStatus: 'unknown',
    });
    expect(stopped.task.id).toBe(active.task.id);

    const terminalOperationId = randomUUID();
    const terminal = await repository.admitChatTurn({
      agentId: agent.id,
      conversationId: conversation.id,
      clientOperationId: terminalOperationId,
      requestHash: '1'.repeat(64),
      text: 'Already completed work.',
      autonomous: false,
      force: false,
      spoken: false,
    });
    if (terminal.kind !== 'admitted') throw new Error('expected a normal chat admission result');
    await db
      .update(tasks)
      .set({ status: 'done', leaseToken: null, lockedUntil: null })
      .where(inArray(tasks.id, [terminal.task.id]));
    await expect(
      repository.cancelChatTurn({
        agentId: agent.id,
        conversationId: conversation.id,
        clientOperationId: terminalOperationId,
      }),
    ).resolves.toMatchObject({
      kind: 'admitted_task',
      status: 'done',
      transitioned: false,
      effectStatus: 'unknown',
    });
  });

  it('accepts an idempotent client delivery receipt only for the completed matching owner turn', async () => {
    const repository = createPostgresApplicationChatPersistence(db);
    const agent = await repository.resolveAgent();
    const conversation = await repository.createConversation(agent.id);
    conversationIds.push(conversation.id);
    const clientId = randomUUID();
    const admission = await repository.admitChatTurn({
      agentId: agent.id,
      conversationId: conversation.id,
      clientOperationId: randomUUID(),
      clientId,
      requestHash: 'd'.repeat(64),
      text: 'What time is it?',
      autonomous: false,
      force: false,
      spoken: false,
    });
    if (admission.kind !== 'admitted') throw new Error('expected a normal chat admission result');
    expect(admission.lease).toBeDefined();
    if (!admission.lease) throw new Error('chat admission did not return a lease');
    await expect(
      repository.acknowledgeMessageDelivery(agent.id, conversation.id, randomUUID(), clientId),
    ).resolves.toBe(false);
    await repository.completeDirectChatTask({
      agentId: agent.id,
      task: admission.lease,
      status: 'done',
      messages: [
        {
          conversationId: conversation.id,
          taskId: admission.task.id,
          role: 'assistant',
          origin: 'assistant',
          parts: [{ type: 'text', text: 'It is noon.' }],
          text: 'It is noon.',
        },
      ],
    });
    const page = await repository.listMessages(agent.id, conversation.id);
    const reply = page?.messages.find((message) => message.role === 'assistant');
    if (!reply) throw new Error('completed turn did not persist its reply');
    await expect(
      repository.acknowledgeMessageDelivery(agent.id, conversation.id, reply.id, randomUUID()),
    ).resolves.toBe(false);
    await expect(
      repository.acknowledgeMessageDelivery(agent.id, conversation.id, reply.id, clientId),
    ).resolves.toBe(true);
    await expect(
      repository.acknowledgeMessageDelivery(agent.id, conversation.id, reply.id, clientId),
    ).resolves.toBe(true);
    await expect(
      repository.acknowledgeMessageDelivery(agent.id, conversation.id, reply.id, randomUUID()),
    ).resolves.toBe(false);
  });

  it('resolves the same live primary conversation on repeated bootstrap reads', async () => {
    const repository = createPostgresApplicationChatPersistence(db);
    const agent = await repository.resolveAgent();
    const first = await repository.getOrCreatePrimaryConversation(agent.id);
    const second = await repository.getOrCreatePrimaryConversation(agent.id);
    conversationIds.push(first.id);

    expect(first.isPrimary).toBe(true);
    expect(first.archivedAt).toBeNull();
    expect(second.id).toBe(first.id);
  });

  it('uses a chronological keyset cursor and never leaks another owner’s chat', async () => {
    const repository = createPostgresApplicationChatPersistence(db);
    const agent = await repository.resolveAgent();
    const conversation = await repository.createConversation(agent.id);
    conversationIds.push(conversation.id);
    for (const text of ['one', 'two', 'three']) {
      await repository.appendOwned(agent.id, {
        conversationId: conversation.id,
        role: 'user',
        origin: 'owner',
        parts: [{ type: 'text', text }],
        text,
      });
    }

    const initial = await repository.listMessages(agent.id, conversation.id, { limit: 2 });
    expect(initial?.messages.map((message) => message.text)).toEqual(['two', 'three']);
    const first = initial?.messages[0];
    expect(first).toBeDefined();
    const page = await repository.listMessages(agent.id, conversation.id, {
      limit: 1,
      after: first,
    });
    expect(page?.messages.map((message) => message.text)).toEqual(['three']);
    expect(page?.hasMore).toBe(false);
    await expect(
      repository.listMessages(randomUUID(), conversation.id, { limit: 2 }),
    ).resolves.toBeNull();
  });

  it('hides and restores messages through the owner-scoped repository', async () => {
    const repository = createPostgresApplicationChatPersistence(db);
    const agent = await repository.resolveAgent();
    const conversation = await repository.createConversation(agent.id);
    conversationIds.push(conversation.id);
    const message = await repository.appendOwned(agent.id, {
      conversationId: conversation.id,
      role: 'user',
      origin: 'owner',
      parts: [{ type: 'text', text: 'private detail' }],
      text: 'private detail',
    });
    expect(message).toBeDefined();
    if (!message) throw new Error('message was not persisted');
    await expect(
      repository.setMessageHidden(randomUUID(), conversation.id, message.id, true),
    ).resolves.toBe(false);
    await expect(
      repository.setMessageHidden(agent.id, conversation.id, message.id, true),
    ).resolves.toBe(true);
    await expect(repository.listMessages(agent.id, conversation.id)).resolves.toMatchObject({
      messages: [],
    });
    await expect(
      repository.setMessageHidden(agent.id, conversation.id, message.id, false),
    ).resolves.toBe(true);
  });

  it('refuses to archive a primary or active conversation', async () => {
    const repository = createPostgresApplicationChatPersistence(db);
    const agent = await repository.resolveAgent();
    const conversation = await repository.createConversation(agent.id);
    conversationIds.push(conversation.id);
    const [task] = await db
      .insert(tasks)
      .values({
        agentId: agent.id,
        conversationId: conversation.id,
        type: 'adhoc',
        trust: 'owner',
      })
      .returning({ id: tasks.id });
    expect(task).toBeDefined();
    await expect(repository.archiveConversation(agent.id, conversation.id)).resolves.toBe('active');
    if (task)
      await db
        .update(tasks)
        .set({ status: 'done' })
        .where(inArray(tasks.id, [task.id]));
    await expect(repository.archiveConversation(agent.id, conversation.id)).resolves.toBe(
      'archived',
    );
    expect(
      (await repository.getConversation(agent.id, conversation.id))?.archivedAt,
    ).toBeInstanceOf(Date);
  });

  it('fences a direct chat completion and persists its reply atomically', async () => {
    const repository = createPostgresApplicationChatPersistence(db);
    const agent = await repository.resolveAgent();
    const conversation = await repository.createConversation(agent.id);
    conversationIds.push(conversation.id);
    const task = await repository.createDirectChatTask({
      agentId: agent.id,
      conversationId: conversation.id,
      title: 'Explain a rainbow',
    });
    expect(task.status).toBe('running');
    const completion = {
      agentId: agent.id,
      task,
      status: 'done' as const,
      messages: [
        {
          conversationId: conversation.id,
          taskId: task.id,
          role: 'assistant' as const,
          origin: 'assistant' as const,
          parts: [{ type: 'text', text: 'Light bends through water.' }],
          text: 'Light bends through water.',
        },
      ],
    };
    await expect(repository.completeDirectChatTask(completion)).resolves.toBe(true);
    await expect(repository.completeDirectChatTask(completion)).resolves.toBe(false);
    expect((await repository.listMessages(agent.id, conversation.id))?.messages).toMatchObject([
      { taskId: task.id, text: 'Light bends through water.' },
    ]);
  });
});
