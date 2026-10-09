import type {
  ExecutionEvidenceRecord,
  ExecutionEvidenceRepository,
  ResponseCheckInput,
} from '@assistant/persistence';
import { evidenceLimit, type Records, taskEvidenceLimit } from '@assistant/persistence';
import { FieldPath } from '@google-cloud/firestore';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const MAX_SHARED_DOCUMENT_RECEIPT_SCAN = 500;
const EVIDENCE_PAGE_SIZE = 200;

function read<T>(snapshot: { exists: boolean; data(): unknown }, id?: string): T | null {
  if (!snapshot.exists) return null;
  const value = decodeRecord<T>(snapshot.data());
  return value &&
    typeof value === 'object' &&
    (id === undefined || (value as { id?: unknown }).id === id)
    ? value
    : null;
}

function evidence(row: Records['toolCalls']): ExecutionEvidenceRecord {
  return {
    id: row.id,
    toolName: row.toolName,
    status: row.status,
    args: row.args,
    result: row.result,
    error: row.error,
    step: row.step,
  };
}

async function ownedTask(store: InstallationStore, agentId: string, taskId: string) {
  const task = read<Records['tasks']>(await store.doc('tasks', taskId).get(), taskId);
  if (!task || task.agentId !== agentId)
    throw new Error('Execution evidence task is missing or outside the owner scope');
  return task;
}

export class FirestoreExecutionEvidenceRepository implements ExecutionEvidenceRepository {
  readonly kind = 'execution-evidence-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async taskEvidence({
    agentId,
    taskId,
    maxRows,
  }: {
    agentId: string;
    taskId: string;
    maxRows?: number;
  }) {
    await ownedTask(this.store, agentId, taskId);
    // When a caller supplies maxRows it asks for an explicit small window. The
    // normal workflow path needs complete evidence, so page up to a separate
    // safety ceiling instead of treating Firestore's 500-document batch size
    // as the task's evidence limit.
    const max = taskEvidenceLimit(maxRows);
    const rows: Records['toolCalls'][] = [];
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      const pageLimit = Math.min(EVIDENCE_PAGE_SIZE, max + 1 - rows.length);
      let query = this.store
        .collection('toolCalls')
        .where('taskId', '==', taskId)
        .orderBy(FieldPath.documentId())
        .limit(pageLimit);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        const row = read<Records['toolCalls']>({ exists: doc.exists, data: () => doc.data() });
        if (!row || row.taskId !== taskId || documentKey(row.id) !== doc.id)
          throw new Error('Execution evidence contains a corrupt tool-call identity');
        rows.push(row);
      }
      if (rows.length > max) throw new Error(`Execution evidence exceeds the ${max}-row bound`);
      if (page.size < pageLimit) break;
      cursor = page.docs.at(-1);
    }
    rows.sort(
      (a, b) =>
        a.step - b.step ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
    return rows.map(evidence);
  }

  async conversationEvidence({
    agentId,
    conversationId,
    excludeTaskId,
    maxRows,
  }: {
    agentId: string;
    conversationId: string;
    excludeTaskId: string;
    maxRows?: number;
  }) {
    const max = evidenceLimit(maxRows);
    const conversation = read<Records['conversations']>(
      await this.store.doc('conversations', conversationId).get(),
      conversationId,
    );
    if (!conversation || conversation.agentId !== agentId)
      throw new Error('Execution evidence conversation is missing or outside the owner scope');
    const excluded = await ownedTask(this.store, agentId, excludeTaskId);
    if (excluded.conversationId !== conversationId)
      throw new Error('Execution evidence task is outside the conversation scope');
    // Task start time cannot choose recent receipts: an old long-running task
    // can finish after a newly started one. Read only owned task identities.
    const priorTasks: string[] = [];
    let taskCursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let taskQuery = this.store
        .collection('tasks')
        .where('conversationId', '==', conversationId)
        .orderBy(FieldPath.documentId())
        .select('id', 'agentId')
        .limit(300);
      if (taskCursor) taskQuery = taskQuery.startAfter(taskCursor);
      const taskSnapshot = await taskQuery.get();
      for (const taskDoc of taskSnapshot.docs) {
        const task = read<Pick<Records['tasks'], 'id' | 'agentId'>>({
          exists: taskDoc.exists,
          data: () => taskDoc.data(),
        });
        if (!task || documentKey(task.id) !== taskDoc.id)
          throw new Error('Execution evidence contains a corrupt task identity');
        if (task.agentId !== agentId || task.id === excludeTaskId) continue;
        priorTasks.push(task.id);
      }
      if (taskSnapshot.size < 300) break;
      taskCursor = taskSnapshot.docs.at(-1);
    }
    // Query bounded groups of owned task IDs using the provisioned timestamp/id
    // index, then retain the global top K. Each group's top K contains every
    // possible global top-K receipt, so batching preserves exact recency while
    // avoiding one remote round trip per historical task. Memory stays at 2K.
    const toolRows: Records['toolCalls'][] = [];
    const newestFirst = (a: Records['toolCalls'], b: Records['toolCalls']) =>
      b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);
    for (let offset = 0; offset < priorTasks.length; offset += 30) {
      const taskIds = priorTasks.slice(offset, offset + 30);
      const snapshot = await this.store
        .collection('toolCalls')
        .where('taskId', 'in', taskIds)
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .limit(max)
        .get();
      const taskRows = snapshot.docs.map((doc) => {
        const row = read<Records['toolCalls']>({ exists: doc.exists, data: () => doc.data() });
        if (
          !row ||
          documentKey(row.id) !== doc.id ||
          !taskIds.includes(row.taskId) ||
          !(row.createdAt instanceof Date) ||
          !Number.isFinite(row.createdAt.getTime())
        )
          throw new Error('Execution evidence contains a corrupt tool-call identity');
        return row;
      });
      toolRows.push(...taskRows);
      toolRows.sort(newestFirst);
      toolRows.splice(max);
    }
    return toolRows.sort((a, b) => newestFirst(b, a)).map(evidence);
  }

  async hasConversationToolCall({
    agentId,
    conversationId,
    toolName,
    documentId,
  }: {
    agentId: string;
    conversationId: string;
    toolName: string;
    documentId: string;
  }) {
    const conversation = read<Records['conversations']>(
      await this.store.doc('conversations', conversationId).get(),
      conversationId,
    );
    if (!conversation || conversation.agentId !== agentId)
      throw new Error('Execution evidence conversation is missing or outside the owner scope');

    let callCursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    let scanned = 0;
    for (;;) {
      let query = this.store
        .collection('toolCalls')
        .where('toolName', '==', toolName)
        .where('args.documentId', '==', documentId)
        .orderBy(FieldPath.documentId())
        .limit(100);
      if (callCursor) query = query.startAfter(callCursor);
      const callSnapshot = await query.get();
      scanned += callSnapshot.size;
      if (scanned > MAX_SHARED_DOCUMENT_RECEIPT_SCAN)
        throw new Error('Shared document receipt lookup exceeds its explicit scan limit');
      for (const callDoc of callSnapshot.docs) {
        const call = read<Records['toolCalls']>({
          exists: callDoc.exists,
          data: () => callDoc.data(),
        });
        if (!call || documentKey(call.id) !== callDoc.id)
          throw new Error('Execution evidence contains a corrupt tool-call identity');
        if (
          call.status !== 'succeeded' ||
          (call.result as { ok?: boolean; deliveryStatus?: string } | null)?.ok === false ||
          (call.result as { deliveryStatus?: string } | null)?.deliveryStatus === 'unknown'
        )
          continue;
        const taskDoc = await this.store.doc('tasks', call.taskId).get();
        const task = read<Records['tasks']>(taskDoc, call.taskId);
        if (task?.agentId === agentId && task.conversationId === conversationId) return true;
      }
      if (callSnapshot.size < 100) return false;
      callCursor = callSnapshot.docs.at(-1);
    }
  }

  async finalMessageExists({
    agentId,
    taskId,
    conversationId,
    text,
  }: {
    agentId: string;
    taskId: string;
    conversationId: string | null;
    text: string;
  }) {
    const task = await ownedTask(this.store, agentId, taskId);
    if (conversationId) {
      const conversation = read<Records['conversations']>(
        await this.store.doc('conversations', conversationId).get(),
        conversationId,
      );
      if (!conversation || conversation.agentId !== agentId)
        throw new Error('Execution final-message conversation is outside the owner scope');
      if (task.conversationId !== null && task.conversationId !== conversationId)
        throw new Error('Execution final-message conversation does not match its task');
    }
    let messageCursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = this.store
        .collection('messages')
        .where('taskId', '==', taskId)
        .orderBy(FieldPath.documentId())
        .limit(100);
      if (messageCursor) query = query.startAfter(messageCursor);
      const snapshot = await query.get();
      for (const doc of snapshot.docs) {
        const message = read<Records['messages']>({ exists: doc.exists, data: () => doc.data() });
        if (!message) throw new Error('Execution evidence contains a corrupt message record');
        if (documentKey(message.id) !== doc.id)
          throw new Error('Execution evidence contains a corrupt message identity');
        if (message.role !== 'assistant' || message.origin !== 'assistant' || message.text !== text)
          continue;
        if (conversationId && message.conversationId !== conversationId) continue;
        const conversation = read<Records['conversations']>(
          await this.store.doc('conversations', message.conversationId).get(),
          message.conversationId,
        );
        if (conversation?.agentId === agentId) return true;
      }
      if (snapshot.size < 100) return false;
      messageCursor = snapshot.docs.at(-1);
    }
  }

  async hasOutboundReply({ agentId, taskId }: { agentId: string; taskId: string }) {
    await ownedTask(this.store, agentId, taskId);
    const snapshot = await this.store
      .collection('toolCalls')
      .where('taskId', '==', taskId)
      .limit(51)
      .get();
    if (snapshot.size > 50) throw new Error('Execution outbound lookup exceeds its bound');
    return snapshot.docs.some((doc) => {
      const row = read<Records['toolCalls']>({ exists: doc.exists, data: () => doc.data() });
      if (!row || documentKey(row.id) !== doc.id)
        throw new Error('Execution evidence contains a corrupt tool-call identity');
      return row.toolName === 'gmail.send' || row.toolName === 'gmail.create_draft';
    });
  }

  async checklistDecisions({ agentId, taskId }: { agentId: string; taskId: string }) {
    await ownedTask(this.store, agentId, taskId);
    const rows: Records['approvals'][] = [];
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = this.store
        .collection('approvals')
        .where('taskId', '==', taskId)
        .orderBy(FieldPath.documentId())
        .limit(Math.min(EVIDENCE_PAGE_SIZE, taskEvidenceLimit(undefined) + 1 - rows.length));
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        const row = read<Records['approvals']>({ exists: doc.exists, data: () => doc.data() });
        if (!row || row.taskId !== taskId)
          throw new Error('Execution evidence contains a corrupt approval record');
        if (documentKey(row.id) !== doc.id)
          throw new Error('Execution evidence contains a corrupt approval identity');
        rows.push(row);
      }
      if (rows.length > taskEvidenceLimit(undefined))
        throw new Error(
          `Execution checklist evidence exceeds the ${taskEvidenceLimit(undefined)}-row bound`,
        );
      if (page.size < EVIDENCE_PAGE_SIZE) break;
      cursor = page.docs.at(-1);
    }
    return rows.map((row) => ({ toolCallId: row.toolCallId, status: row.status }));
  }

  async recordResponseCheck({ agentId, check }: { agentId: string; check: ResponseCheckInput }) {
    const ref = this.store.doc('responseChecks', check.taskId);
    return this.store.db.runTransaction(async (tx) => {
      const task = read<Records['tasks']>(
        await tx.get(this.store.doc('tasks', check.taskId)),
        check.taskId,
      );
      if (!task || task.agentId !== agentId)
        throw new Error('Execution evidence task is missing or outside the owner scope');
      const existing = await tx.get(ref);
      if (existing.exists) return false;
      tx.create(ref, encodeRecord({ id: check.taskId, createdAt: this.store.now(), ...check }));
      return true;
    });
  }
}

export function createFirestoreExecutionEvidenceRepository(
  store: InstallationStore,
): ExecutionEvidenceRepository {
  return new FirestoreExecutionEvidenceRepository(store);
}
