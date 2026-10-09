import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareOwnerCardFormTurn } from '../../application/src/card-form-admission.js';
import { createPostgresApplicationChatPersistence } from './application-chat-repository.js';
import { PostgresCardFormAdmissionRepository } from './card-form-admission-repository.js';
import { createDb, type Db } from './client.js';
import {
  agents,
  conversations,
  generatedCardRevisions,
  generatedCards,
  maintenanceCursors,
  messages,
  tasks,
} from './schema.js';

describe('PostgreSQL card form admission', () => {
  let db: Db;
  const cardIds: string[] = [];
  const conversationIds: string[] = [];
  const revisionIds: string[] = [];
  const agentIds: string[] = [];
  const privacyCursorNames: string[] = [];
  beforeAll(() => {
    const url = process.env.DATABASE_URL;
    if (!url || !new URL(url).pathname.endsWith('_test'))
      throw new Error('Requires isolated _test database');
    db = createDb(url);
  });
  afterAll(async () => {
    try {
      if (conversationIds.length) {
        await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
        await db.delete(tasks).where(inArray(tasks.conversationId, conversationIds));
      }
      if (cardIds.length) {
        if (revisionIds.length)
          await db
            .delete(generatedCardRevisions)
            .where(inArray(generatedCardRevisions.id, revisionIds));
        await db.delete(generatedCards).where(inArray(generatedCards.id, cardIds));
      }
      if (conversationIds.length)
        await db.delete(conversations).where(inArray(conversations.id, conversationIds));
      if (privacyCursorNames.length)
        await db
          .delete(maintenanceCursors)
          .where(inArray(maintenanceCursors.name, privacyCursorNames));
      if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds));
    } finally {
      await db.$client.end();
    }
  });
  it('commits one ordinary owner turn and replays it after card revision advances', async () => {
    const chat = createPostgresApplicationChatPersistence(db);
    const agent = { id: randomUUID() };
    agentIds.push(agent.id);
    await db.insert(agents).values({
      id: agent.id,
      name: 'Card form fixture',
      email: `${agent.id}@card-form.invalid`,
      workspacePrefix: `card-form/${agent.id}`,
    });
    const conversation = await chat.createConversation(agent.id);
    conversationIds.push(conversation.id);
    const cardId = randomUUID();
    const revisionId = randomUUID();
    const newerRevisionId = randomUUID();
    const operationId = randomUUID();
    cardIds.push(cardId);
    revisionIds.push(revisionId, newerRevisionId);
    const otherConversation = await chat.createConversation(agent.id);
    conversationIds.push(otherConversation.id);
    const form = {
      type: 'form',
      id: 'meeting',
      title: 'Meeting details',
      serverAction: 'submit_owner_chat_turn',
      submitLabel: 'Continue',
      warningFactIds: [],
      fields: [
        { id: 'date', type: 'date', label: 'Date', required: true, sensitive: false },
        { id: 'attendees', type: 'text', label: 'Attendees', required: false, sensitive: false },
      ],
    };
    const spec = {
      version: 1,
      title: 'Calendar request',
      accessibilityLabel: 'Calendar request',
      facts: [
        { id: 'private', value: 'owner-secret-token', source: 'private source', sensitive: true },
      ],
      blocks: [form],
      actions: [],
      sourceLabel: 'owner request',
    };
    await db.insert(generatedCards).values({
      id: cardId,
      agentId: agent.id,
      conversationId: conversation.id,
      messageId: null,
      status: 'active',
      sourceLabel: 'test',
      sourceFingerprint: `form-test:${cardId}`,
      currentRevisionId: revisionId,
      expiresAt: null,
      dismissedAt: null,
    });
    await db.insert(generatedCardRevisions).values([
      { id: revisionId, cardId, version: 1, spec },
      {
        id: newerRevisionId,
        cardId,
        version: 2,
        spec: {
          ...spec,
          title: 'Changed card',
          blocks: [form, { ...form, title: 'Duplicate form ID' }],
        },
      },
    ]);
    const submission = {
      protocol: 'card-form-v1',
      conversationId: conversation.id,
      cardId,
      expectedRevisionId: revisionId,
      formId: 'meeting',
      operationId,
      values: { date: '2026-10-10', attendees: 'Sam' },
      ownerMessageText: 'Please check whether 2026-10-10 works for the meeting.',
    };
    const repository = new PostgresCardFormAdmissionRepository(db);
    const wrongConversation = await repository.submit({
      agentId: agent.id,
      submission: {
        ...submission,
        conversationId: otherConversation.id,
        operationId: randomUUID(),
      },
      prepare: prepareOwnerCardFormTurn,
    });
    expect(wrongConversation).toMatchObject({ ok: false, status: 404 });
    expect(
      await db.select().from(tasks).where(eq(tasks.conversationId, otherConversation.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(messages).where(eq(messages.conversationId, otherConversation.id)),
    ).toHaveLength(0);
    const rejectedSecret = await repository.submit({
      agentId: agent.id,
      submission: {
        ...submission,
        operationId: randomUUID(),
        values: { ...submission.values, attendees: 'owner-secret-token' },
      },
      prepare: prepareOwnerCardFormTurn,
    });
    expect(rejectedSecret).toMatchObject({ ok: false, status: 422 });
    expect(
      await db.select().from(tasks).where(eq(tasks.conversationId, conversation.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(messages).where(eq(messages.conversationId, conversation.id)),
    ).toHaveLength(0);
    const privacyCursorName = `privacy-erasure-result:${agent.id}`;
    privacyCursorNames.push(privacyCursorName);
    await db.insert(maintenanceCursors).values({ name: privacyCursorName, cursor: 'active' });
    await expect(
      repository.submit({ agentId: agent.id, submission, prepare: prepareOwnerCardFormTurn }),
    ).rejects.toThrow('Privacy erasure is in progress');
    expect(
      await db.select().from(tasks).where(eq(tasks.conversationId, conversation.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(messages).where(eq(messages.conversationId, conversation.id)),
    ).toHaveLength(0);
    await db.delete(maintenanceCursors).where(eq(maintenanceCursors.name, privacyCursorName));
    const [first, concurrent] = await Promise.all([
      repository.submit({ agentId: agent.id, submission, prepare: prepareOwnerCardFormTurn }),
      repository.submit({ agentId: agent.id, submission, prepare: prepareOwnerCardFormTurn }),
    ]);
    expect(first).toMatchObject({ ok: true, taskStatus: 'pending' });
    expect(concurrent).toMatchObject({ ok: true, taskStatus: 'pending' });
    if (!first.ok || !concurrent.ok) throw new Error('form admission failed');
    expect(first.taskId).toBe(concurrent.taskId);
    expect([first, concurrent].filter((result) => result.ok && result.created)).toHaveLength(1);
    const created = [first, concurrent].find((result) => result.ok && result.created);
    if (!created?.ok) throw new Error('form task was not created');
    expect(created.dispatch).toBe('notify');
    const taskId = created.taskId;
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(task).toMatchObject({
      type: 'chat_turn',
      trust: 'owner',
      title: 'Owner form request',
      status: 'pending',
      conversationId: conversation.id,
    });
    expect(task?.trigger).toMatchObject({
      source: 'chat',
      payload: {
        text: 'Please check whether 2026-10-10 works for the meeting.',
        chatAdmission: { phase: 'queued', triageOutcome: 'actionable' },
      },
    });
    expect(task?.title).not.toContain('Sam');
    expect((task?.trigger as { payload?: { text?: string } } | undefined)?.payload?.text).toBe(
      'Please check whether 2026-10-10 works for the meeting.',
    );
    const payload = task?.trigger as { payload?: Record<string, unknown> } | null;
    const formReceipt = payload?.payload?.cardFormAdmission;
    expect(formReceipt).toMatchObject({
      protocol: 'card-form-v1',
      cardId,
      expectedRevisionId: revisionId,
      formId: 'meeting',
      operationId,
    });
    expect(JSON.stringify(formReceipt)).not.toContain('Sam');
    expect(JSON.stringify(formReceipt)).not.toContain('owner-secret-token');
    const nextSubmission = { ...submission, operationId: randomUUID() };
    const whileActive = await repository.submit({
      agentId: agent.id,
      submission: nextSubmission,
      prepare: prepareOwnerCardFormTurn,
    });
    expect(whileActive).toMatchObject({
      ok: false,
      status: 409,
      reason: 'active_form',
      activeTaskId: taskId,
      taskStatus: 'pending',
    });
    expect(
      await db.select().from(tasks).where(eq(tasks.conversationId, conversation.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(messages).where(eq(messages.conversationId, conversation.id)),
    ).toHaveLength(1);
    await db.update(tasks).set({ trust: 'known' }).where(eq(tasks.id, taskId));
    await expect(
      repository.submit({
        agentId: agent.id,
        submission: nextSubmission,
        prepare: prepareOwnerCardFormTurn,
      }),
    ).rejects.toThrow('Card form active-operation identity collision');
    await db.update(tasks).set({ trust: 'owner' }).where(eq(tasks.id, taskId));
    await db.update(tasks).set({ status: 'needs_attention' }).where(eq(tasks.id, taskId));
    expect(
      await repository.submit({
        agentId: agent.id,
        submission: nextSubmission,
        prepare: prepareOwnerCardFormTurn,
      }),
    ).toMatchObject({ ok: false, status: 409 });
    await db.update(tasks).set({ status: 'failed' }).where(eq(tasks.id, taskId));
    const secondOperation = await repository.submit({
      agentId: agent.id,
      submission: nextSubmission,
      prepare: prepareOwnerCardFormTurn,
    });
    expect(secondOperation).toMatchObject({ ok: true, created: true, taskStatus: 'pending' });
    if (!secondOperation.ok) throw new Error('second intentional operation failed');
    expect(secondOperation.taskId).not.toBe(taskId);
    expect(
      (await db.query.tasks.findFirst({ where: eq(tasks.id, secondOperation.taskId) }))?.trigger,
    ).toMatchObject({
      payload: { text: submission.ownerMessageText },
    });
    const secondMessage = await db.query.messages.findFirst({
      where: eq(messages.taskId, secondOperation.taskId),
    });
    expect(secondMessage?.text).toBe(submission.ownerMessageText);
    const thirdSubmission = { ...submission, operationId: randomUUID() };
    expect(
      await repository.submit({
        agentId: agent.id,
        submission: thirdSubmission,
        prepare: prepareOwnerCardFormTurn,
      }),
    ).toMatchObject({ ok: false, status: 409 });
    await db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, secondOperation.taskId));
    const thirdOperation = await repository.submit({
      agentId: agent.id,
      submission: thirdSubmission,
      prepare: prepareOwnerCardFormTurn,
    });
    expect(thirdOperation).toMatchObject({ ok: true, created: true, taskStatus: 'pending' });
    if (!thirdOperation.ok) throw new Error('third intentional operation failed');
    expect(thirdOperation.taskId).not.toBe(secondOperation.taskId);
    await db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, thirdOperation.taskId));
    const fourthSubmission = { ...submission, operationId: randomUUID() };
    const distinctOperations = await Promise.all([
      repository.submit({
        agentId: agent.id,
        submission: fourthSubmission,
        prepare: prepareOwnerCardFormTurn,
      }),
      repository.submit({
        agentId: agent.id,
        submission: { ...submission, operationId: randomUUID() },
        prepare: prepareOwnerCardFormTurn,
      }),
    ]);
    expect(distinctOperations.filter((result) => result.ok && result.created)).toHaveLength(1);
    expect(distinctOperations.filter((result) => !result.ok && result.status === 409)).toHaveLength(
      1,
    );
    const fourthOperation = distinctOperations.find((result) => result.ok && result.created);
    if (!fourthOperation)
      throw new Error('Concurrent device submissions did not produce one admission');
    expect(fourthOperation).toMatchObject({ ok: true, created: true, taskStatus: 'pending' });
    if (!fourthOperation.ok) throw new Error('fourth intentional operation failed');
    await db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, fourthOperation.taskId));
    const countBefore = await db
      .select()
      .from(tasks)
      .where(eq(tasks.externalEventId, task?.externalEventId ?? ''));
    await db
      .update(generatedCards)
      .set({ currentRevisionId: newerRevisionId })
      .where(eq(generatedCards.id, cardId));
    const originalTrigger = task?.trigger;
    if (!originalTrigger || typeof originalTrigger !== 'object')
      throw new Error('form task trigger is missing');
    const triggerObject = originalTrigger as { payload?: Record<string, unknown> };
    await db
      .update(tasks)
      .set({
        trigger: {
          ...triggerObject,
          payload: { ...triggerObject.payload, text: 'tampered trigger text' },
        },
      })
      .where(eq(tasks.id, taskId));
    expect(
      await repository.submit({ agentId: agent.id, submission, prepare: prepareOwnerCardFormTurn }),
    ).toMatchObject({ ok: false, status: 409 });
    await db.update(tasks).set({ trigger: originalTrigger }).where(eq(tasks.id, taskId));
    await db
      .update(messages)
      .set({ text: 'tampered owner message' })
      .where(eq(messages.id, created.messageId));
    expect(
      await repository.submit({ agentId: agent.id, submission, prepare: prepareOwnerCardFormTurn }),
    ).toMatchObject({ ok: false, status: 409 });
    await db
      .update(messages)
      .set({ text: submission.ownerMessageText })
      .where(eq(messages.id, created.messageId));
    const replay = await repository.submit({
      agentId: agent.id,
      submission,
      prepare: prepareOwnerCardFormTurn,
    });
    expect(replay).toMatchObject({
      ok: true,
      created: false,
      taskId,
      messageId: created.messageId,
    });
    expect(
      await db
        .select()
        .from(tasks)
        .where(eq(tasks.externalEventId, task?.externalEventId ?? '')),
    ).toHaveLength(countBefore.length);
    const conflict = await repository.submit({
      agentId: agent.id,
      submission: { ...submission, values: { ...submission.values, attendees: 'Alex' } },
      prepare: prepareOwnerCardFormTurn,
    });
    expect(conflict).toMatchObject({ ok: false, status: 409 });
    expect(conflict).not.toHaveProperty('reason', 'stale_revision');
    const editedTextConflict = await repository.submit({
      agentId: agent.id,
      submission: { ...submission, ownerMessageText: 'Please schedule another date.' },
      prepare: prepareOwnerCardFormTurn,
    });
    expect(editedTextConflict).toMatchObject({ ok: false, status: 409 });
    expect(editedTextConflict).not.toHaveProperty('reason', 'stale_revision');
    const staleNewOperation = await repository.submit({
      agentId: agent.id,
      submission: { ...submission, operationId: randomUUID() },
      prepare: prepareOwnerCardFormTurn,
    });
    expect(staleNewOperation).toMatchObject({ ok: false, status: 409, reason: 'stale_revision' });
    const ambiguousForm = await repository.submit({
      agentId: agent.id,
      submission: { ...submission, expectedRevisionId: newerRevisionId, operationId: randomUUID() },
      prepare: prepareOwnerCardFormTurn,
    });
    expect(ambiguousForm).toMatchObject({ ok: false, status: 422 });
    expect(
      await db.select().from(tasks).where(eq(tasks.conversationId, conversation.id)),
    ).toHaveLength(4);
    const projected = await chat.listMessages(agent.id, conversation.id, { fromStart: true });
    const admittedMessages =
      projected?.messages.filter((message) =>
        [taskId, secondOperation.taskId, thirdOperation.taskId, fourthOperation.taskId].includes(
          message.taskId ?? '',
        ),
      ) ?? [];
    expect(admittedMessages).toHaveLength(4);
    expect(admittedMessages.map((message) => message.text)).toEqual(
      Array(4).fill(submission.ownerMessageText),
    );
    expect(
      admittedMessages.every((message) => message.appendSequence !== '00000000000000000000'),
    ).toBe(true);
  });
});
