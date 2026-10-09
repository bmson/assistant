import { FieldPath } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreExecutionEvidenceRepository } from './execution-evidence.js';
import { documentKey, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore execution evidence', () => {
  let store: InstallationStore;
  let repository: FirestoreExecutionEvidenceRepository;

  beforeEach(async () => {
    store = emulatorStore(() => new Date('2026-09-12T12:00:00Z'));
    repository = new FirestoreExecutionEvidenceRepository(store);
    await store
      .doc('tasks', 'task')
      .set({ id: 'task', agentId: 'owner', conversationId: 'conversation' });
    await store
      .doc('tasks', 'foreign-task')
      .set({ id: 'foreign-task', agentId: 'other', conversationId: 'conversation' });
    await store.doc('conversations', 'conversation').set({ id: 'conversation', agentId: 'owner' });
    await store.doc('toolCalls', 'call-1').set({
      id: 'call-1',
      taskId: 'task',
      step: 1,
      toolName: 'test.one',
      status: 'succeeded',
      args: {},
      result: { ok: true },
      error: null,
      createdAt: new Date('2026-09-12T12:00:01Z'),
    });
    await store.doc('toolCalls', 'call-2').set({
      id: 'call-2',
      taskId: 'task',
      step: 2,
      toolName: 'test.two',
      status: 'failed',
      args: {},
      result: null,
      error: 'nope',
      createdAt: new Date('2026-09-12T12:00:02Z'),
    });
  });

  afterEach(async () => disposeStore(store));

  it('scopes task evidence and fails closed at the bound', async () => {
    await expect(repository.taskEvidence({ agentId: 'other', taskId: 'task' })).rejects.toThrow(
      'owner scope',
    );
    await expect(
      repository.taskEvidence({ agentId: 'owner', taskId: 'task', maxRows: 1 }),
    ).rejects.toThrow('row bound');
    await expect(repository.taskEvidence({ agentId: 'owner', taskId: 'task' })).resolves.toEqual([
      expect.objectContaining({ id: 'call-1', step: 1 }),
      expect.objectContaining({ id: 'call-2', step: 2 }),
    ]);
  });

  it('pages through more than one Firestore page and returns complete task evidence and decisions', async () => {
    for (let start = 0; start < 501; start += 400) {
      const batch = store.db.batch();
      for (let index = start; index < Math.min(start + 400, 501); index += 1) {
        const id = `large-call-${String(index).padStart(3, '0')}`;
        batch.set(store.doc('toolCalls', id), {
          id,
          taskId: 'task',
          step: index,
          toolName: 'test.large',
          status: 'succeeded',
          args: {},
          result: { index },
          error: null,
          createdAt: new Date(Date.UTC(2026, 8, 12, 12, 0, index)),
        });
        const approvalId = `large-approval-${String(index).padStart(3, '0')}`;
        batch.set(store.doc('approvals', approvalId), {
          id: approvalId,
          taskId: 'task',
          toolCallId: id,
          status: 'approved',
          createdAt: new Date(Date.UTC(2026, 8, 12, 12, 0, index)),
        });
      }
      await batch.commit();
    }

    const calls = await repository.taskEvidence({ agentId: 'owner', taskId: 'task' });
    expect(calls).toHaveLength(503);
    expect(calls.filter((row) => row.toolName === 'test.large').map((row) => row.step)).toEqual([
      ...Array(501).keys(),
    ]);

    const decisions = await repository.checklistDecisions({ agentId: 'owner', taskId: 'task' });
    expect(decisions).toHaveLength(501);
    expect(decisions.filter((row) => row.toolCallId.startsWith('large-call-'))).toHaveLength(501);
  });

  it('fails closed when complete task evidence exceeds the explicit safety ceiling', async () => {
    for (let start = 0; start < 10_001; start += 500) {
      const batch = store.db.batch();
      for (let index = start; index < Math.min(start + 500, 10_001); index += 1) {
        const id = `ceiling-call-${String(index).padStart(5, '0')}`;
        batch.set(store.doc('toolCalls', id), {
          id,
          taskId: 'task',
          step: index,
          toolName: 'test.ceiling',
          status: 'succeeded',
          args: {},
          result: null,
          error: null,
          createdAt: new Date(Date.UTC(2026, 8, 12, 12, 0, index % 60)),
        });
      }
      await batch.commit();
    }

    await expect(
      repository.taskEvidence({ agentId: 'owner', taskId: 'task', maxRows: 10_000 }),
    ).rejects.toThrow('Execution evidence exceeds the 10000-row bound');
  });

  it('does not accept a foreign conversation task as prior evidence', async () => {
    await expect(
      repository.conversationEvidence({
        agentId: 'owner',
        conversationId: 'conversation',
        excludeTaskId: 'task',
      }),
    ).resolves.toEqual([]);
  });

  it('finds only an exact document tool call successful document evidence in the owner conversation', async () => {
    await store.doc('toolCalls', 'foreign-doc-read').set({
      id: 'foreign-doc-read',
      taskId: 'foreign-task',
      step: 1,
      toolName: 'docs.get',
      status: 'succeeded',
      args: { documentId: 'doc-1' },
      result: { title: 'Foreign' },
      error: null,
      createdAt: new Date('2026-09-12T12:00:03Z'),
    });
    await store.doc('toolCalls', 'doc-read').set({
      id: 'doc-read',
      taskId: 'task',
      step: 2,
      toolName: 'docs.get',
      status: 'failed',
      args: { documentId: 'doc-1' },
      result: null,
      error: 'permission denied',
      createdAt: new Date('2026-09-12T12:00:04Z'),
    });
    const input = {
      agentId: 'owner',
      conversationId: 'conversation',
      toolName: 'docs.get',
      documentId: 'doc-1',
    };

    await expect(repository.hasConversationToolCall(input)).resolves.toBe(false);
    await store
      .doc('toolCalls', 'doc-read')
      .update({ status: 'succeeded', result: { content: 'Current document' }, error: null });
    await expect(repository.hasConversationToolCall(input)).resolves.toBe(true);
    await expect(
      repository.hasConversationToolCall({ ...input, documentId: 'doc-2' }),
    ).resolves.toBe(false);
    await expect(
      repository.hasConversationToolCall({ ...input, toolName: 'sheets.get' }),
    ).resolves.toBe(false);
  });

  it('fails explicitly when matching document receipts exceed the lookup bound', async () => {
    for (let start = 0; start < 501; start += 500) {
      const batch = store.db.batch();
      for (let index = start; index < Math.min(start + 500, 501); index += 1) {
        const id = `crowded-doc-${index}`;
        batch.set(store.doc('toolCalls', id), {
          id,
          taskId: 'foreign-task',
          toolName: 'docs.get',
          args: { documentId: 'crowded-doc' },
        });
      }
      await batch.commit();
    }

    await expect(
      repository.hasConversationToolCall({
        agentId: 'owner',
        conversationId: 'conversation',
        toolName: 'docs.get',
        documentId: 'crowded-doc',
      }),
    ).rejects.toThrow('exceeds its explicit scan limit');
  });

  it('finds an exact final beyond one message page without weakening outbound bounds', async () => {
    const messageBatch = store.db.batch();
    const messageIds = Array.from({ length: 121 }, (_, index) => `message-${index}`);
    const finalMessageId = messageIds.toSorted((a, b) =>
      Buffer.compare(Buffer.from(documentKey(a), 'utf8'), Buffer.from(documentKey(b), 'utf8')),
    )[120];
    if (!finalMessageId) throw new Error('The final-message pagination fixture is empty');
    for (const id of messageIds) {
      messageBatch.set(store.doc('messages', id), {
        id,
        taskId: 'task',
        conversationId: 'conversation',
        role: 'assistant',
        origin: 'assistant',
        text: id === finalMessageId ? 'final' : `irrelevant-${id}`,
      });
    }
    await messageBatch.commit();
    const firstPage = await store
      .collection('messages')
      .where('taskId', '==', 'task')
      .orderBy(FieldPath.documentId())
      .limit(100)
      .get();
    expect(firstPage.size).toBe(100);
    expect(firstPage.docs.map((doc) => doc.id)).not.toContain(documentKey(finalMessageId));
    expect(
      await repository.finalMessageExists({
        agentId: 'owner',
        taskId: 'task',
        conversationId: 'conversation',
        text: 'final',
      }),
    ).toBe(true);
    expect(
      await repository.finalMessageExists({
        agentId: 'owner',
        taskId: 'task',
        conversationId: 'conversation',
        text: 'missing final',
      }),
    ).toBe(false);

    const toolBatch = store.db.batch();
    for (let index = 0; index < 51; index += 1) {
      const id = `outbound-${index}`;
      toolBatch.set(store.doc('toolCalls', id), {
        id,
        taskId: 'task',
        step: index + 10,
        toolName: index === 50 ? 'gmail.send' : 'test.one',
        status: 'succeeded',
        args: {},
        result: {},
        error: null,
        createdAt: new Date(`2026-09-12T12:01:${String(index).padStart(2, '0')}Z`),
      });
    }
    await toolBatch.commit();
    await expect(repository.hasOutboundReply({ agentId: 'owner', taskId: 'task' })).rejects.toThrow(
      'outbound lookup exceeds',
    );
  });

  it('rejects a final-message target outside the task owner scope', async () => {
    await store
      .doc('conversations', 'foreign-conversation')
      .set({ id: 'foreign-conversation', agentId: 'other' });
    await store.doc('tasks', 'task').update({ conversationId: 'foreign-conversation' });
    await expect(
      repository.finalMessageExists({
        agentId: 'owner',
        taskId: 'task',
        conversationId: 'foreign-conversation',
        text: 'final',
      }),
    ).rejects.toThrow('conversation is outside the owner scope');
  });

  it('pages through more than 500 prior tasks while bounding actual evidence rows', async () => {
    const first = store.db.batch();
    for (let index = 0; index < 500; index += 1) {
      const id = `prior-${index}`;
      first.set(store.doc('tasks', id), { id, agentId: 'owner', conversationId: 'conversation' });
    }
    await first.commit();
    await store
      .doc('tasks', 'prior-500')
      .set({ id: 'prior-500', agentId: 'owner', conversationId: 'conversation' });
    await store.doc('toolCalls', 'late-evidence').set({
      id: 'late-evidence',
      taskId: 'prior-500',
      step: 1,
      toolName: 'test.late',
      status: 'succeeded',
      args: {},
      result: { ok: true },
      error: null,
      createdAt: new Date('2026-09-12T12:05:00Z'),
    });
    await expect(
      repository.conversationEvidence({
        agentId: 'owner',
        conversationId: 'conversation',
        excludeTaskId: 'task',
      }),
    ).resolves.toEqual([expect.objectContaining({ id: 'late-evidence' })]);
  });
  it('keeps the newest evidence window when a thread outgrows the bound', async () => {
    const minute = (n: number) => new Date(Date.UTC(2026, 8, 12, 12, n));
    for (let t = 0; t < 3; t += 1) {
      const id = `older-${t}`;
      await store
        .doc('tasks', id)
        .set({ id, agentId: 'owner', conversationId: 'conversation', createdAt: minute(t * 10) });
      for (let step = 1; step <= 2; step += 1)
        await store.doc('toolCalls', `${id}-${step}`).set({
          id: `${id}-${step}`,
          taskId: id,
          step,
          toolName: 'test.step',
          status: 'succeeded',
          args: {},
          result: null,
          error: null,
          createdAt: minute(t * 10 + step),
        });
    }
    const window = await repository.conversationEvidence({
      agentId: 'owner',
      conversationId: 'conversation',
      excludeTaskId: 'task',
      maxRows: 3,
    });
    // Six prior rows exist; the three newest come back, oldest first.
    expect(window.map((row) => row.id)).toEqual(['older-1-2', 'older-2-1', 'older-2-2']);
  });

  it('merges latest receipts across task starts and beyond document-ID page boundaries', async () => {
    const time = (minute: number) => new Date(Date.UTC(2026, 8, 12, 12, minute));
    for (const [id, minute] of [
      ['old-long-running', 0],
      ['new-short', 30],
    ] as const)
      await store
        .doc('tasks', id)
        .set({ id, agentId: 'owner', conversationId: 'conversation', createdAt: time(minute) });
    for (const [id, taskId, minute] of [
      ['a-early', 'old-long-running', 1],
      ['b-early', 'old-long-running', 2],
      ['c-early', 'old-long-running', 3],
      ['z-latest', 'old-long-running', 50],
      ['new-result', 'new-short', 31],
      ['tied-result', 'new-short', 50],
    ] as const)
      await store.doc('toolCalls', id).set({
        id,
        taskId,
        step: 1,
        toolName: 'test.merge',
        status: 'succeeded',
        args: {},
        result: { minute },
        error: null,
        createdAt: time(minute),
      });
    const window = await repository.conversationEvidence({
      agentId: 'owner',
      conversationId: 'conversation',
      excludeTaskId: 'task',
      maxRows: 3,
    });
    expect(window.map((row) => row.id)).toEqual(['new-result', 'tied-result', 'z-latest']);
  });

  it('deduplicates notification finals for conversationless tasks and quality writes', async () => {
    await store.doc('tasks', 'task').update({ conversationId: null });
    await store.doc('messages', 'notification-final').set({
      id: 'notification-final',
      taskId: 'task',
      conversationId: 'conversation',
      role: 'assistant',
      origin: 'assistant',
      text: 'final',
    });
    expect(
      await repository.finalMessageExists({
        agentId: 'owner',
        taskId: 'task',
        conversationId: 'conversation',
        text: 'final',
      }),
    ).toBe(true);
    const input = {
      agentId: 'owner',
      check: {
        taskId: 'task',
        promptVersion: 1,
        plannerVersion: 1,
        blocked: false,
        unsupportedCount: 0,
        mustActRetries: 0,
        degradedSteps: 0,
        outputVerificationAttempted: false,
        outputVerificationRevised: false,
        outputVerificationUnavailable: false,
      },
    };
    expect(
      (
        await Promise.all([
          repository.recordResponseCheck(input),
          repository.recordResponseCheck(input),
        ])
      ).sort(),
    ).toEqual([false, true]);
    await expect(repository.recordResponseCheck({ ...input, agentId: 'other' })).rejects.toThrow(
      'owner scope',
    );
    expect((await store.collection('responseChecks').get()).size).toBe(1);
  });

  it('rejects mismatched evidence identity instead of quietly omitting a receipt', async () => {
    await store.doc('toolCalls', 'call-1').update({ id: 'different-record' });
    await expect(repository.taskEvidence({ agentId: 'owner', taskId: 'task' })).rejects.toThrow(
      'corrupt tool-call identity',
    );
  });
});
