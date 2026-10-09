import type {
  ActivityTaskRecord,
  TaskActivityDetail,
  TaskActivityDetailRepository,
  TaskActivityRepository,
  TaskTimelineCursor,
} from '@assistant/persistence';
import { isChatAdmissionCancellationProjection } from '@assistant/persistence';
import {
  FieldPath,
  type Query,
  type QueryDocumentSnapshot,
  Timestamp,
} from '@google-cloud/firestore';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const PAGE_SIZE = 100;
const MAX_OWNER_TASKS = 25_000;
const MAX_APPROVALS_PER_TASK = 500;
const MAX_FILES_PER_TASK = 5_000;
const FIELDS = [
  'id',
  'agentId',
  'conversationId',
  'externalEventId',
  'type',
  'status',
  'title',
  'progress',
  'trust',
  'spentUsd',
  'budgetUsdLimit',
  'updatedAt',
  'archivedAt',
  'autonomyGrant',
  'trigger',
] as const;

function taskFromDocument(value: unknown, documentId: string, agentId: string): ActivityTaskRecord {
  const row = decodeRecord<Record<string, unknown>>(value);
  if (
    row.agentId !== agentId ||
    !(
      row.conversationId === undefined ||
      row.conversationId === null ||
      typeof row.conversationId === 'string'
    ) ||
    !(
      row.externalEventId === undefined ||
      row.externalEventId === null ||
      typeof row.externalEventId === 'string'
    ) ||
    typeof row.id !== 'string' ||
    documentKey(row.id) !== documentId ||
    typeof row.type !== 'string' ||
    typeof row.status !== 'string' ||
    !(row.title === null || typeof row.title === 'string') ||
    typeof row.progress !== 'string' ||
    typeof row.trust !== 'string' ||
    typeof row.spentUsd !== 'string' ||
    typeof row.budgetUsdLimit !== 'string' ||
    !(row.updatedAt instanceof Date) ||
    !Number.isFinite(row.updatedAt.getTime()) ||
    !(
      row.archivedAt === null ||
      (row.archivedAt instanceof Date && Number.isFinite(row.archivedAt.getTime()))
    ) ||
    !row.trigger ||
    typeof row.trigger !== 'object' ||
    Array.isArray(row.trigger)
  )
    throw new Error('Invalid owner activity task');
  return {
    ...row,
    conversationId: row.conversationId ?? null,
    externalEventId: row.externalEventId ?? null,
  } as ActivityTaskRecord;
}

function isCanary(trigger: unknown): boolean {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return false;
  const payload = (trigger as { payload?: unknown }).payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const value = (payload as { canary?: unknown }).canary;
  return value === true || value === 'true';
}

/** A bounded owner scan preserves SQL's archived count, filters, and updated ordering. */
export class FirestoreTaskActivityRepository
  implements TaskActivityRepository, TaskActivityDetailRepository
{
  readonly kind = 'task-activity-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async list(agentId: string, input: { archived: boolean; statuses?: string[]; limit: number }) {
    if (!agentId || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500)
      throw new Error('Invalid owner activity request');
    const agents = await this.store.collection('agents').limit(2).get();
    const agent = agents.docs[0];
    if (
      agents.size !== 1 ||
      !agent ||
      agent.id !== documentKey(agentId) ||
      agent.get('id') !== agentId
    )
      throw new Error('Activity requires one matching configured agent');
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const statuses = input.statuses ? new Set(input.statuses) : null;
    const owned = this.store.collection('tasks').where('agentId', '==', agentId);

    // The list is the newest `limit` tasks, so it is read newest-first and the
    // read stops as soon as it has them. It used to read every task the
    // assistant had ever created (15,000+ in production, in pages of 250) just to
    // keep fifty, which made every refresh of the app wait several seconds.
    // `agentId ASC, updatedAt DESC` and `agentId, status, updatedAt DESC` already
    // exist, so this needs no new index.
    const wanted = (row: ActivityTaskRecord) =>
      (input.archived ? row.archivedAt !== null : row.archivedAt === null) &&
      !isCanary(row.trigger) &&
      !isChatAdmissionCancellationProjection(row) &&
      (!statuses || statuses.has(row.status));
    const newestFirst = async (query: Query): Promise<ActivityTaskRecord[]> => {
      const found: ActivityTaskRecord[] = [];
      // Once `limit` rows are in hand, keep reading only through rows that share
      // the last one's timestamp, so the id tie-break below picks the same rows a
      // full read would (a bulk archive stamps hundreds of tasks with one instant).
      let boundary: number | null = null;
      let scanned = 0;
      let cursor: QueryDocumentSnapshot | undefined;
      for (;;) {
        let page = query
          .orderBy('updatedAt', 'desc')
          .select(...FIELDS)
          .limit(PAGE_SIZE);
        if (cursor) page = page.startAfter(cursor);
        const snapshot = await page.get();
        for (const doc of snapshot.docs) {
          const row = taskFromDocument(doc.data(), doc.id, agentId);
          if (boundary !== null && row.updatedAt.getTime() < boundary) return found;
          if (wanted(row)) {
            found.push(row);
            if (boundary === null && found.length >= input.limit)
              boundary = row.updatedAt.getTime();
          }
        }
        scanned += snapshot.size;
        if (scanned > MAX_OWNER_TASKS)
          throw new Error('Owner activity exceeds the bounded task scan');
        if (snapshot.size < PAGE_SIZE) return found;
        cursor = snapshot.docs.at(-1);
      }
    };

    // A status filter reads each status through its own ordered index so a rare
    // status (needs_attention) is not found by walking past every done task.
    const [candidates, total, live] = await Promise.all([
      statuses
        ? Promise.all(
            [...statuses].map((status) => newestFirst(owned.where('status', '==', status))),
          ).then((lists) => lists.flat())
        : newestFirst(owned),
      owned.count().get(),
      owned.where('archivedAt', '==', null).count().get(),
    ]);
    const archivedCount = total.data().count - live.data().count;
    const tasks = candidates
      .sort(
        (left, right) =>
          right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id),
      )
      .slice(0, input.limit);

    // One lookup per task waiting on approval, side by side rather than in turn.
    const waiting = tasks.filter((row) => row.status === 'waiting_approval');
    const pendingApprovalTaskIds = (
      await Promise.all(
        waiting.map(async (task) => {
          const approvals = await this.store
            .collection('approvals')
            .where('taskId', '==', task.id)
            .select('id', 'taskId', 'status')
            .limit(MAX_APPROVALS_PER_TASK + 1)
            .get();
          if (approvals.size > MAX_APPROVALS_PER_TASK)
            throw new Error('Activity approval history exceeds the bounded scan');
          const hasPending = approvals.docs.some((doc) => {
            const row = decodeRecord<Record<string, unknown>>(doc.data());
            if (
              row.taskId !== task.id ||
              typeof row.id !== 'string' ||
              documentKey(row.id) !== doc.id ||
              typeof row.status !== 'string'
            )
              throw new Error('Invalid activity approval');
            return row.status === 'pending';
          });
          return hasPending ? task.id : null;
        }),
      )
    ).filter((id): id is string => id !== null);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return { tasks, archivedCount, pendingApprovalTaskIds };
  }

  async getDetail(
    agentId: string,
    taskId: string,
    input: { pageSize: number; before?: Date; cursor?: TaskTimelineCursor },
  ): Promise<TaskActivityDetail | null> {
    if (
      !agentId ||
      !taskId ||
      !Number.isSafeInteger(input.pageSize) ||
      input.pageSize < 1 ||
      input.pageSize > 500 ||
      (input.before && !Number.isFinite(input.before.getTime()))
    )
      throw new Error('Invalid owner activity detail request');
    const agents = await this.store.collection('agents').limit(2).get();
    const agent = agents.docs[0];
    if (
      agents.size !== 1 ||
      !agent ||
      agent.id !== documentKey(agentId) ||
      agent.get('id') !== agentId
    )
      throw new Error('Activity requires one matching configured agent');
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const taskSnapshot = await this.store
      .collection('tasks')
      .where(FieldPath.documentId(), '==', documentKey(taskId))
      .select(
        'id',
        'agentId',
        'conversationId',
        'externalEventId',
        'trigger',
        'type',
        'status',
        'title',
        'trust',
        'spentUsd',
        'budgetUsdLimit',
        'updatedAt',
        'deadline',
        'nextAction',
        'progress',
        'progressPercent',
        'plan',
        'state.requestChecklist',
        'archivedAt',
        'autonomyGrant',
      )
      .limit(1)
      .get();
    const taskDocument = taskSnapshot.docs[0];
    if (!taskDocument) return null;
    const task = decodeRecord<Record<string, unknown>>(taskDocument.data());
    if (task.agentId !== agentId) return null;
    if (isChatAdmissionCancellationProjection(task)) return null;
    if (
      task.id !== taskId ||
      documentKey(taskId) !== taskDocument.id ||
      typeof task.type !== 'string' ||
      typeof task.status !== 'string' ||
      !(task.title === null || typeof task.title === 'string') ||
      typeof task.trust !== 'string' ||
      typeof task.spentUsd !== 'string' ||
      typeof task.budgetUsdLimit !== 'string' ||
      !(task.updatedAt instanceof Date) ||
      !(task.deadline === null || task.deadline instanceof Date) ||
      typeof task.nextAction !== 'string' ||
      typeof task.progress !== 'string' ||
      !(task.progressPercent === null || typeof task.progressPercent === 'number') ||
      !(task.archivedAt === null || task.archivedAt instanceof Date)
    )
      throw new Error('Invalid owner activity task');

    const timedQuery = (
      collection: string,
      timeField: 'createdAt' | 'requestedAt',
      fields: string[],
    ) => {
      let query = this.store
        .collection(collection)
        .where('taskId', '==', taskId)
        .select(...fields);
      if (input.cursor) {
        const kinds: Record<string, string> = {
          toolCalls: 'tool',
          modelCalls: 'model',
          approvals: 'approval',
          messages: 'message',
        };
        const kind = kinds[collection] ?? '';
        const at = new Timestamp(
          Math.floor(new Date(input.cursor.at).getTime() / 1000),
          Number(input.cursor.at.slice(20, 29)),
        );
        query = query.orderBy(timeField, 'desc').orderBy('id', 'desc');
        if (kind === input.cursor.kind) query = query.startAfter(at, input.cursor.id);
        else query = query.where(timeField, kind < input.cursor.kind ? '<=' : '<', at);
        return query.limit(input.pageSize + 1).get();
      }
      if (input.before) query = query.where(timeField, '<', input.before);
      return query
        .orderBy(timeField, 'desc')
        .orderBy('id', 'desc')
        .limit(input.pageSize + 1)
        .get();
    };
    const [
      toolSnapshot,
      modelSnapshot,
      approvalSnapshot,
      messageSnapshot,
      filesSnapshot,
      actionsSnapshot,
      pendingSnapshot,
    ] = await Promise.all([
      timedQuery('toolCalls', 'createdAt', [
        'id',
        'taskId',
        'createdAt',
        'finishedAt',
        'toolName',
        'step',
        'status',
        'decision',
        'args',
        'result',
        'error',
      ]),
      timedQuery('modelCalls', 'createdAt', [
        'id',
        'taskId',
        'createdAt',
        'role',
        'model',
        'costUsd',
        'latencyMs',
      ]),
      timedQuery('approvals', 'requestedAt', [
        'id',
        'taskId',
        'requestedAt',
        'status',
        'summary',
        'shortCode',
        'resolvedVia',
        'resolvedAt',
      ]),
      timedQuery('messages', 'createdAt', ['id', 'taskId', 'createdAt', 'role', 'text']),
      this.store
        .collection('files')
        .where('taskId', '==', taskId)
        .select('id', 'taskId', 'workspacePath', 'bytes')
        .orderBy('createdAt', 'asc')
        .orderBy('id', 'asc')
        .limit(MAX_FILES_PER_TASK + 1)
        .get(),
      this.store
        .collection('toolCalls')
        .where('taskId', '==', taskId)
        .select(
          'id',
          'taskId',
          'createdAt',
          'finishedAt',
          'toolName',
          'step',
          'status',
          'result',
          'error',
        )
        .orderBy('step', 'asc')
        .orderBy('id', 'asc')
        .limit(5001)
        .get(),
      this.store
        .collection('approvals')
        .where('taskId', '==', taskId)
        .where('status', '==', 'pending')
        .limit(1)
        .get(),
    ]);
    if (actionsSnapshot.size > 5000) throw new Error('Activity action history exceeds its bound');
    if (filesSnapshot.size > MAX_FILES_PER_TASK)
      throw new Error('Activity file list exceeds its bound');
    const rows = <T>(snapshot: {
      docs: Array<{ id: string; data(): FirebaseFirestore.DocumentData }>;
    }) =>
      snapshot.docs.map((doc) => {
        const row = decodeRecord<Record<string, unknown>>(doc.data());
        if (row.taskId !== taskId || typeof row.id !== 'string' || documentKey(row.id) !== doc.id)
          throw new Error('Invalid owner activity audit record');
        const rawAt = doc.data().requestedAt ?? doc.data().createdAt;
        if (rawAt instanceof Timestamp) {
          const seconds = new Date(rawAt.seconds * 1000).toISOString().slice(0, 19);
          row.timelineAt = `${seconds}.${String(rawAt.nanoseconds).padStart(9, '0')}Z`;
        }
        return row as T;
      });
    const [toolCalls, modelCalls, approvals, messages, files, actions] = [
      rows<TaskActivityDetail['toolCalls'][number]>(toolSnapshot),
      rows<TaskActivityDetail['modelCalls'][number]>(modelSnapshot),
      rows<TaskActivityDetail['approvals'][number]>(approvalSnapshot),
      rows<TaskActivityDetail['messages'][number]>(messageSnapshot),
      rows<TaskActivityDetail['files'][number]>(filesSnapshot),
      rows<TaskActivityDetail['actions'][number]>(actionsSnapshot),
    ];
    const validDate = (value: unknown) => value instanceof Date && Number.isFinite(value.getTime());
    if (
      toolCalls.some(
        (row) =>
          !validDate(row.createdAt) ||
          !(row.finishedAt === null || validDate(row.finishedAt)) ||
          typeof row.toolName !== 'string' ||
          !Number.isSafeInteger(row.step) ||
          typeof row.status !== 'string',
      ) ||
      modelCalls.some(
        (row) =>
          !validDate(row.createdAt) ||
          typeof row.role !== 'string' ||
          typeof row.model !== 'string' ||
          typeof row.costUsd !== 'string' ||
          !(row.latencyMs === null || typeof row.latencyMs === 'number'),
      ) ||
      approvals.some(
        (row) =>
          !validDate(row.requestedAt) ||
          typeof row.status !== 'string' ||
          typeof row.summary !== 'string' ||
          typeof row.shortCode !== 'string' ||
          !(row.resolvedVia === null || typeof row.resolvedVia === 'string') ||
          !(row.resolvedAt === null || validDate(row.resolvedAt)),
      ) ||
      messages.some(
        (row) =>
          !validDate(row.createdAt) || typeof row.role !== 'string' || typeof row.text !== 'string',
      ) ||
      files.some(
        (row) => typeof row.workspacePath !== 'string' || !Number.isSafeInteger(row.bytes),
      ) ||
      actions.some(
        (row) =>
          !validDate(row.createdAt) ||
          !(row.finishedAt === null || validDate(row.finishedAt)) ||
          typeof row.toolName !== 'string' ||
          typeof row.status !== 'string' ||
          !(row.error === null || typeof row.error === 'string'),
      )
    )
      throw new Error('Invalid owner activity audit record');
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return {
      timezone: typeof agent.get('timezone') === 'string' ? agent.get('timezone') : 'UTC',
      task: task as TaskActivityDetail['task'],
      toolCalls,
      modelCalls,
      approvals,
      messages,
      files,
      actions,
      hasPendingApproval: pendingSnapshot.size > 0,
    };
  }
}
