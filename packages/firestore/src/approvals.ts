import { createHash, randomInt, randomUUID } from 'node:crypto';
import {
  type ApprovalInbox,
  type ApprovalInboxQuery,
  type ApprovalNoticeGroup,
  type ApprovalNoticeQuery,
  type ApprovalRepository,
  type ApprovalResolution,
  type ApprovalWake,
  approvalInboxLimit,
  approvalIsResolved,
  approvalSweepBatch,
  type CreateApprovalInput,
  type CreatedApproval,
  parkedApprovalIds,
  type Records,
  type RememberableApproval,
  type ResolveApprovalInput,
  type ResolvedApprovalItem,
} from '@assistant/persistence';
import { type QueryDocumentSnapshot, Timestamp } from '@google-cloud/firestore';
import { createWakeIntent } from './outbox.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, v]) => [key, canonical(v)]),
    );
  return value;
}
function policyId(policy: NonNullable<ResolveApprovalInput['policy']>) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(policy)))
    .digest('hex');
}

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const CODE_SUFFIX_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const APPROVAL_NOTICE_CURSOR = 'approval-notices-cursor';
const INBOX_PENDING_LIMIT = 50;
const INBOX_PAGE_SIZE = 100;
const INBOX_SCAN_LIMIT = 1000;

function randomCodeSuffix(): string {
  const pick = () => CODE_SUFFIX_ALPHABET.charAt(randomInt(CODE_SUFFIX_ALPHABET.length));
  return pick() + pick();
}

function approvalNoticeBatch(batch: number | undefined): number {
  const value = batch ?? 50;
  if (!Number.isInteger(value) || value < 1 || value > 200)
    throw new Error('Invalid approval notice batch');
  return value;
}

function approvalNoticeAge(minutes: number | undefined): number {
  const value = minutes ?? 5;
  if (!Number.isFinite(value) || value < 0 || value > 365 * 24 * 60)
    throw new Error('Invalid approval notice age');
  return value;
}

function validDate(value: Date | undefined, message: string): Date {
  const date = value ?? new Date();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error(message);
  return date;
}

function inboxDate(value: Date | undefined): Date {
  return validDate(value, 'Invalid approval inbox time');
}

function historyOrder(left: ResolvedApprovalItem, right: ResolvedApprovalItem): number {
  const leftTime = (left.approval.resolvedAt ?? left.approval.expiresAt).getTime();
  const rightTime = (right.approval.resolvedAt ?? right.approval.expiresAt).getTime();
  if (leftTime !== rightTime) return rightTime - leftTime;
  return right.approval.id.localeCompare(left.approval.id);
}

function validPersistedDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validDocumentIdentifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    documentKey(value);
    return true;
  } catch {
    return false;
  }
}

function validApprovalDocument(
  approval: Records['approvals'],
  candidate: QueryDocumentSnapshot,
): boolean {
  return (
    validDocumentIdentifier(approval.id) &&
    validPersistedDate(approval.requestedAt) &&
    documentKey(approval.id) === candidate.ref.id
  );
}

async function ownedTask(
  store: InstallationStore,
  approval: Records['approvals'],
  agentId: string,
): Promise<Records['tasks'] | null> {
  if (!validDocumentIdentifier(approval.taskId)) return null;
  const snapshot = await store.doc('tasks', approval.taskId).get();
  if (!snapshot.exists) return null;
  const task = decodeRecord<Records['tasks']>(snapshot.data());
  return task.id === approval.taskId && task.agentId === agentId && typeof task.type === 'string'
    ? task
    : null;
}

const INBOX_ACCEPT_BATCH = 10;

async function collectInboxCandidates<T>(
  baseQuery: import('@google-cloud/firestore').Query,
  target: number,
  accept: (candidate: QueryDocumentSnapshot) => Promise<T | null>,
  errorMessage: string,
): Promise<T[]> {
  const accepted: T[] = [];
  let cursor: QueryDocumentSnapshot | undefined;
  let scanned = 0;
  for (;;) {
    const page = await (cursor ? baseQuery.startAfter(cursor) : baseQuery)
      .limit(INBOX_PAGE_SIZE)
      .get();
    scanned += page.size;
    // Each candidate needs its own task lookup. Ten at a time, in order: far
    // fewer round trips than one by one, without reading a whole page the
    // target will never reach.
    for (let at = 0; at < page.docs.length; at += INBOX_ACCEPT_BATCH) {
      const items = await Promise.all(page.docs.slice(at, at + INBOX_ACCEPT_BATCH).map(accept));
      for (const item of items) {
        if (item !== null) accepted.push(item);
        if (accepted.length >= target) return accepted;
      }
    }
    if (page.size < INBOX_PAGE_SIZE) return accepted;
    if (scanned >= INBOX_SCAN_LIMIT) throw new Error(errorMessage);
    cursor = page.docs.at(-1);
    if (!cursor) throw new Error(`${errorMessage}: cursor did not advance`);
  }
}

export class FirestoreApprovalRepository implements ApprovalRepository {
  readonly kind = 'approval-repository' as const;
  constructor(readonly store: InstallationStore) {}

  async getRememberable(agentId: string, approvalId: string): Promise<RememberableApproval | null> {
    if (!validDocumentIdentifier(approvalId)) return null;
    const approvalSnapshot = await this.store.doc('approvals', approvalId).get();
    if (!approvalSnapshot.exists) return null;
    try {
      const approval = decodeRecord<Records['approvals']>(approvalSnapshot.data());
      if (
        !validDocumentIdentifier(approval.id) ||
        documentKey(approval.id) !== approvalSnapshot.ref.id ||
        !validPersistedDate(approval.requestedAt) ||
        !validPersistedDate(approval.expiresAt) ||
        approval.status !== 'pending' ||
        !validDocumentIdentifier(approval.taskId) ||
        !validDocumentIdentifier(approval.toolCallId)
      )
        return null;
      const taskSnapshot = await this.store.doc('tasks', approval.taskId).get();
      const toolSnapshot = await this.store.doc('toolCalls', approval.toolCallId).get();
      if (!taskSnapshot.exists || !toolSnapshot.exists) return null;
      const task = decodeRecord<Records['tasks']>(taskSnapshot.data());
      const tool = decodeRecord<Records['toolCalls']>(toolSnapshot.data());
      if (
        task.id !== approval.taskId ||
        task.agentId !== agentId ||
        tool.id !== approval.toolCallId ||
        tool.taskId !== approval.taskId ||
        typeof tool.toolName !== 'string' ||
        tool.toolName.length === 0
      )
        return null;
      if (approval.expiresAt <= validDate(this.store.now(), 'Invalid approval time')) return null;
      return { approval, toolName: tool.toolName };
    } catch {
      return null;
    }
  }

  async listInbox(agentId: string, options: ApprovalInboxQuery = {}): Promise<ApprovalInbox> {
    const recentLimit = approvalInboxLimit(options.recentLimit);
    const now = inboxDate(options.now ?? this.store.now());
    const pendingQuery = this.store
      .collection('approvals')
      .where('status', '==', 'pending')
      .orderBy('requestedAt', 'asc')
      .orderBy('id', 'asc');
    const pendingRead = collectInboxCandidates(
      pendingQuery,
      INBOX_PENDING_LIMIT,
      async (candidate) => {
        const approval = decodeRecord<Records['approvals']>(candidate.data());
        if (
          !validApprovalDocument(approval, candidate) ||
          approval.status !== 'pending' ||
          !validPersistedDate(approval.expiresAt) ||
          approval.expiresAt <= now ||
          !validDocumentIdentifier(approval.toolCallId)
        )
          return null;
        const task = await ownedTask(this.store, approval, agentId);
        if (!task) return null;
        const toolSnapshot = await this.store.doc('toolCalls', approval.toolCallId).get();
        if (!toolSnapshot.exists) return null;
        const tool = decodeRecord<Records['toolCalls']>(toolSnapshot.data());
        if (
          tool.id !== approval.toolCallId ||
          tool.taskId !== approval.taskId ||
          typeof task.trust !== 'string' ||
          typeof tool.toolName !== 'string'
        )
          return null;
        return {
          approval,
          taskType: task.type,
          taskTrust: task.trust,
          toolName: tool.toolName,
          decision: tool.decision,
        };
      },
      'Approval inbox pending scan exceeded its safety bound',
    );

    const terminalQuery = this.store
      .collection('approvals')
      .where('status', 'in', ['approved', 'denied', 'expired'])
      .where('resolvedAt', '!=', null)
      .orderBy('resolvedAt', 'desc')
      .orderBy('id', 'desc');
    const datedRead = collectInboxCandidates(
      terminalQuery,
      recentLimit,
      async (candidate) => this.resolvedInboxItem(candidate, agentId),
      'Approval inbox resolved scan exceeded its safety bound',
    );

    const nullResolvedTerminalQuery = this.store
      .collection('approvals')
      .where('status', 'in', ['approved', 'denied', 'expired'])
      .where('resolvedAt', '==', null)
      .orderBy('expiresAt', 'desc')
      .orderBy('id', 'desc');
    const nullResolvedRead = collectInboxCandidates(
      nullResolvedTerminalQuery,
      recentLimit,
      async (candidate) => this.resolvedInboxItem(candidate, agentId),
      'Approval inbox unresolved terminal scan exceeded its safety bound',
    );

    const expiredPendingQuery = this.store
      .collection('approvals')
      .where('status', '==', 'pending')
      .where('expiresAt', '<=', now)
      .orderBy('expiresAt', 'desc')
      .orderBy('id', 'desc');
    const expiredRead = collectInboxCandidates(
      expiredPendingQuery,
      recentLimit,
      async (candidate) => {
        const approval = decodeRecord<Records['approvals']>(candidate.data());
        if (
          !validApprovalDocument(approval, candidate) ||
          approval.status !== 'pending' ||
          !validPersistedDate(approval.expiresAt) ||
          approval.expiresAt > now
        )
          return null;
        return this.resolvedInboxItem(candidate, agentId, true);
      },
      'Approval inbox expired scan exceeded its safety bound',
    );

    // Four independent reads, started together. They used to run one after
    // another, each waiting on every approval's task lookup in turn.
    const [pending, dated, nullResolved, expired] = await Promise.all([
      pendingRead,
      datedRead,
      nullResolvedRead,
      expiredRead,
    ]);

    const resolved = [...dated, ...nullResolved, ...expired];
    resolved.sort(historyOrder);
    return { pending, resolved: resolved.slice(0, recentLimit) };
  }

  private async resolvedInboxItem(
    candidate: QueryDocumentSnapshot,
    agentId: string,
    allowExpiredPending = false,
  ): Promise<ResolvedApprovalItem | null> {
    const approval = decodeRecord<Records['approvals']>(candidate.data());
    if (
      !validApprovalDocument(approval, candidate) ||
      !(
        approvalIsResolved(approval.status) ||
        (allowExpiredPending && approval.status === 'pending')
      ) ||
      !validPersistedDate(approval.expiresAt) ||
      (approval.resolvedAt !== null && !validPersistedDate(approval.resolvedAt))
    )
      return null;
    const task = await ownedTask(this.store, approval, agentId);
    if (!task) return null;
    return {
      approval: {
        id: approval.id,
        taskId: approval.taskId,
        shortCode: approval.shortCode,
        summary: approval.summary,
        status: approval.status,
        requestedAt: approval.requestedAt,
        resolvedAt: approval.resolvedAt,
        resolvedVia: approval.resolvedVia,
        expiresAt: approval.expiresAt,
        edited: approval.resolutionPayload != null,
      },
      taskType: task.type,
    };
  }

  async create(input: CreateApprovalInput): Promise<CreatedApproval> {
    const toolCallId = randomUUID();
    const approvalId = randomUUID();
    const suffix = randomCodeSuffix();
    const now = validDate(this.store.now(), 'Invalid approval time');
    const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS);
    const taskRef = this.store.doc('tasks', input.taskId);
    const toolRef = this.store.doc('toolCalls', toolCallId);
    const approvalRef = this.store.doc('approvals', approvalId);
    const counterRef = this.store.doc('coordination', 'approval-codes');

    return this.store.db.runTransaction(async (tx) => {
      const [task, counter] = await tx.getAll(taskRef, counterRef);
      if (!task?.exists || task.get('id') !== input.taskId)
        throw new Error('Approval task does not exist or has mismatched identity');

      let nextNumber: number;
      if (!counter?.exists) {
        const historical = await tx.get(this.store.collection('approvals').limit(1));
        if (historical.size > 0)
          throw new Error('Missing approval code counter; initialize its verified high-water mark');
        nextNumber = 1;
      } else {
        nextNumber = counter.get('next');
        if (!Number.isSafeInteger(nextNumber) || nextNumber < 1)
          throw new Error('Invalid approval code counter');
      }
      if (!Number.isSafeInteger(nextNumber + 1)) throw new Error('Approval code counter exhausted');

      const shortCode = `A${nextNumber}${suffix}`;
      const collision = await tx.get(
        this.store.collection('approvals').where('shortCode', '==', shortCode).limit(1),
      );
      if (collision.size > 0) throw new Error('Approval code collision');

      tx.set(counterRef, { next: nextNumber + 1, updatedAt: now });
      tx.create(
        toolRef,
        encodeRecord({
          id: toolCallId,
          taskId: input.taskId,
          step: input.step,
          toolName: input.toolName,
          args: input.args,
          risk: 'approval',
          status: 'awaiting_approval',
          startedAt: null,
          idempotencyKey: null,
          result: null,
          error: null,
          approvalId,
          decision: input.decision,
          finishedAt: null,
          createdAt: now,
        }),
      );
      tx.create(
        approvalRef,
        encodeRecord({
          id: approvalId,
          taskId: input.taskId,
          toolCallId,
          shortCode,
          summary: input.summary,
          payload: input.args,
          resolutionPayload: null,
          status: 'pending',
          requestedAt: now,
          resolvedAt: null,
          resolvedVia: null,
          expiresAt,
          notifiedChannels: [],
          createdPolicyId: null,
        }),
      );
      return { toolCallId, approvalId, shortCode, summary: input.summary };
    });
  }

  async listStalledNotices(options: ApprovalNoticeQuery = {}): Promise<ApprovalNoticeGroup[]> {
    const batch = approvalNoticeBatch(options.batch);
    const ageMinutes = approvalNoticeAge(options.olderThanMinutes);
    const now = validDate(options.now ?? this.store.now(), 'Invalid approval notice time');
    const cutoff = new Date(now.getTime() - ageMinutes * 60_000);
    const cursorRef = this.store.doc('coordination', APPROVAL_NOTICE_CURSOR);
    const candidates = await this.store.db.runTransaction(async (tx) => {
      const cursorSnapshot = await tx.get(cursorRef);
      const rawCursor = cursorSnapshot.exists ? cursorSnapshot.get('cursor') : null;
      let cursor: { requestedAt: Timestamp; id: string } | null = null;
      if (rawCursor !== null) {
        const requestedAt = (rawCursor as { requestedAt?: unknown })?.requestedAt;
        const id = (rawCursor as { id?: unknown })?.id;
        if (!(requestedAt instanceof Timestamp) || typeof id !== 'string' || id.length === 0)
          throw new Error('Invalid approval notice cursor');
        cursor = { requestedAt, id };
      }
      const baseQuery = this.store
        .collection('approvals')
        .where('status', '==', 'pending')
        .where('requestedAt', '<=', cutoff)
        .orderBy('requestedAt', 'asc')
        .orderBy('id', 'asc');
      const query = cursor ? baseQuery.startAfter(cursor.requestedAt, cursor.id) : baseQuery;
      let page = await tx.get(query.limit(batch));
      if (page.empty && cursor !== null) page = await tx.get(baseQuery.limit(batch));
      const last = page.docs.at(-1);
      const requestedAt = last?.get('requestedAt');
      const id = last?.get('id');
      if (page.size === batch && (!(requestedAt instanceof Timestamp) || typeof id !== 'string')) {
        throw new Error('Invalid approval notice candidate');
      }
      tx.set(cursorRef, {
        cursor: page.size === batch && last ? { requestedAt, id } : null,
        updatedAt: now,
      });
      return page.docs;
    });

    const groups: ApprovalNoticeGroup[] = [];
    const byTask = new Map<string, ApprovalNoticeGroup>();
    for (const candidate of candidates) {
      const current = await this.store.db.runTransaction(async (tx) => {
        const approvalSnapshot = await tx.get(candidate.ref);
        if (!approvalSnapshot.exists) return null;
        const approval = decodeRecord<Records['approvals']>(approvalSnapshot.data());
        const notifiedChannels = Array.isArray(approval.notifiedChannels)
          ? approval.notifiedChannels.filter(
              (channel): channel is string => typeof channel === 'string',
            )
          : [];
        if (
          approvalSnapshot.get('status') !== 'pending' ||
          !(approval.requestedAt instanceof Date) ||
          approval.requestedAt > cutoff ||
          notifiedChannels.includes('conversation')
        )
          return null;
        try {
          if (
            typeof approval.id !== 'string' ||
            documentKey(approval.id) !== approvalSnapshot.ref.id
          )
            return null;
        } catch {
          return null;
        }
        const taskRef = this.store.doc('tasks', approval.taskId);
        const toolRef = this.store.doc('toolCalls', approval.toolCallId);
        const [taskSnapshot, toolSnapshot] = await tx.getAll(taskRef, toolRef);
        if (!taskSnapshot?.exists || !toolSnapshot?.exists) return null;
        const task = decodeRecord<Records['tasks']>(taskSnapshot.data());
        const tool = decodeRecord<Records['toolCalls']>(toolSnapshot.data());
        if (
          task.id !== approval.taskId ||
          task.status !== 'waiting_approval' ||
          tool.id !== approval.toolCallId ||
          tool.taskId !== approval.taskId ||
          typeof tool.toolName !== 'string'
        )
          return null;
        try {
          if (documentKey(task.id) !== taskRef.id) return null;
        } catch {
          return null;
        }
        return {
          approval: { ...approval, notifiedChannels },
          task,
          toolName: tool.toolName,
        };
      });
      if (!current) continue;
      const { approval, task, toolName } = current;
      let group = byTask.get(task.id);
      if (!group) {
        group = { task, notices: [] };
        byTask.set(task.id, group);
        groups.push(group);
      }
      group.notices.push({ ...approval, toolName });
    }
    return groups;
  }

  async markNotified(approvalIds: string[], channels: string[]): Promise<void> {
    const ids = [...new Set(approvalIds)];
    const requested = [...new Set(channels)].filter(
      (channel): channel is string => typeof channel === 'string' && channel.length > 0,
    );
    if (ids.length === 0 || requested.length === 0) return;
    for (let start = 0; start < ids.length; start += 200) {
      const chunk = ids.slice(start, start + 200);
      await this.store.db.runTransaction(async (tx) => {
        const refs = chunk.map((id) => this.store.doc('approvals', id));
        const snapshots = await tx.getAll(...refs);
        for (const [index, snapshot] of snapshots.entries()) {
          if (!snapshot?.exists || snapshot.get('status') !== 'pending') continue;
          const existing = snapshot.get('notifiedChannels');
          const current = Array.isArray(existing)
            ? [
                ...new Set(
                  existing.filter((channel): channel is string => typeof channel === 'string'),
                ),
              ]
            : [];
          const all = new Set([...current, ...requested]);
          const known = [
            ...(all.has('owner') ? ['owner'] : []),
            ...(all.has('conversation') ? ['conversation'] : []),
          ];
          const other = [...all].filter(
            (channel) => channel !== 'owner' && channel !== 'conversation',
          );
          const next = [...known, ...other];
          const ref = refs[index];
          if (
            ref &&
            (next.length !== current.length || next.some((channel, i) => channel !== current[i]))
          )
            tx.update(ref, { notifiedChannels: next });
        }
      });
    }
  }

  async resolve(input: ResolveApprovalInput): Promise<ApprovalResolution> {
    if (!input.approvalId && !input.shortCode)
      return { ok: false, reason: 'approvalId or shortCode required' };
    const newPolicyId = randomUUID();
    return this.store.db.runTransaction(async (tx) => {
      const snapshot = input.approvalId
        ? await tx.get(this.store.doc('approvals', input.approvalId))
        : null;
      const matches = !input.approvalId
        ? await tx.get(
            this.store
              .collection('approvals')
              .where('shortCode', '==', input.shortCode)
              .where('status', '==', 'pending')
              .limit(2),
          )
        : null;
      if (matches && matches.size > 1)
        return { ok: false, reason: 'ambiguous approval code; use the approval ID' };
      const selected = snapshot ?? matches?.docs[0];
      if (!selected?.exists || selected.get('status') !== 'pending')
        return { ok: false, reason: 'no pending approval matched (already resolved or expired?)' };
      const approval = decodeRecord<Records['approvals']>(selected.data());
      if (!(approval.expiresAt instanceof Date) || !Number.isFinite(approval.expiresAt.getTime()))
        return { ok: false, reason: 'no pending approval matched (already resolved or expired?)' };
      const taskRef = this.store.doc('tasks', approval.taskId);
      const toolRef = this.store.doc('toolCalls', approval.toolCallId);
      const [task, tool] = await tx.getAll(taskRef, toolRef);
      if (!task?.exists || !tool?.exists || tool.get('taskId') !== approval.taskId) {
        throw new Error('Approval references missing or mismatched task/tool records');
      }
      const agentId = task.get('agentId');
      if (typeof agentId !== 'string' || !agentId)
        throw new Error('Approval task owner is missing');
      if (input.expectedAgentId && agentId !== input.expectedAgentId)
        return { ok: false, reason: 'no pending approval matched (already resolved or expired?)' };
      const requestedPolicy = input.via === 'web' ? input.policy : undefined;
      const ownerRef = requestedPolicy ? this.store.doc('agents', agentId) : null;
      if (ownerRef) {
        const owner = await tx.get(ownerRef);
        if (!owner.exists || owner.get('id') !== agentId)
          throw new Error('Approval task owner is unavailable');
      }
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
      if (
        erasure.exists &&
        (erasure.get('agentId') !== agentId || erasure.get('status') !== 'complete')
      )
        throw new Error('Privacy erasure is in progress');
      if (
        requestedPolicy &&
        (requestedPolicy.agentId !== task.get('agentId') ||
          requestedPolicy.toolName !== tool.get('toolName'))
      ) {
        throw new Error('Approval policy must match the task owner and tool');
      }
      const policyKey = requestedPolicy
        ? this.store.doc('approvalPolicyKeys', policyId(requestedPolicy))
        : null;
      const keySnapshot = policyKey ? await tx.get(policyKey) : null;
      const resolvedPolicyId = keySnapshot?.exists
        ? String(keySnapshot.get('policyId'))
        : newPolicyId;
      const policyRef = requestedPolicy
        ? this.store.doc('approvalPolicies', resolvedPolicyId)
        : null;
      const existingPolicy = policyRef ? await tx.get(policyRef) : null;
      // Sample the installation clock only after every transactional read. A
      // slow task/tool/privacy/policy read must not let an answer cross its
      // deadline while retaining an earlier `now` value.
      const now = validDate(this.store.now(), 'Invalid approval time');
      if (approval.expiresAt.getTime() <= now.getTime())
        return { ok: false, reason: 'no pending approval matched (already resolved or expired?)' };
      tx.update(
        selected.ref,
        encodeRecord({
          status: input.decision,
          resolvedAt: now,
          resolvedVia: input.via,
          resolutionPayload: input.editedPayload ?? null,
          ...(policyRef && requestedPolicy ? { createdPolicyId: resolvedPolicyId } : {}),
        }),
      );
      tx.update(toolRef, { status: input.decision });
      if (policyRef && requestedPolicy && ownerRef) {
        // The owner document is the Firestore serialization point shared with
        // approved-call claims and every policy writer.
        tx.update(ownerRef, { updatedAt: now });
        if (policyKey && !keySnapshot?.exists) tx.create(policyKey, { policyId: resolvedPolicyId });
        if (existingPolicy?.exists) tx.update(policyRef, { enabled: true, updatedAt: now });
        else
          tx.create(
            policyRef,
            encodeRecord({
              ...requestedPolicy,
              id: resolvedPolicyId,
              enabled: true,
              createdVia: 'approval_dialog',
              version: 1,
              createdAt: now,
              updatedAt: now,
            }),
          );
      }
      const wake = task.get('status') === 'waiting_approval';
      const generation = Number(task.get('queueGeneration')) + 1;
      if (wake) {
        tx.update(taskRef, {
          status: 'pending',
          runAfter: null,
          lockedUntil: null,
          leaseToken: null,
          queueGeneration: generation,
          attempt: 0,
          updatedAt: now,
        });
        // Always retain the repair intent, including callers that defer immediate notification.
        createWakeIntent(tx, this.store, { taskId: approval.taskId, generation, availableAt: now });
      }
      return {
        ok: true,
        taskId: approval.taskId,
        toolCallId: approval.toolCallId,
        approvalId: approval.id,
        ...(wake ? { wake: { taskId: approval.taskId, generation } } : {}),
      };
    });
  }

  async expireStale(batch = 200, suppliedNow?: Date): Promise<ApprovalWake[]> {
    const limit = approvalSweepBatch(batch);
    const now = suppliedNow ?? this.store.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
      throw new Error('Invalid approval sweep time');
    const due = await this.store
      .collection('approvals')
      .where('status', '==', 'pending')
      .where('expiresAt', '<=', now)
      .orderBy('expiresAt', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .get();
    const wakes: ApprovalWake[] = [];
    for (const candidate of due.docs) {
      const wake = await this.store.db.runTransaction(async (tx) => {
        const approvalRef = candidate.ref;
        const snapshot = await tx.get(approvalRef);
        if (!snapshot.exists || snapshot.get('status') !== 'pending') return null;
        const approval = decodeRecord<Records['approvals']>(snapshot.data());
        if (!(approval.expiresAt instanceof Date) || approval.expiresAt > now) return null;
        const taskRef = this.store.doc('tasks', approval.taskId);
        const toolRef = this.store.doc('toolCalls', approval.toolCallId);
        const [task, tool] = await tx.getAll(taskRef, toolRef);
        if (
          !task?.exists ||
          !tool?.exists ||
          task.get('id') !== approval.taskId ||
          tool.get('taskId') !== approval.taskId
        )
          throw new Error('Approval references missing or mismatched task/tool records');

        const generation = Number(task.get('queueGeneration')) + 1;
        if (!Number.isSafeInteger(generation) || generation < 1)
          throw new Error('Invalid task queue generation');
        tx.update(approvalRef, encodeRecord({ status: 'expired', resolvedAt: now }));
        tx.update(toolRef, { status: 'denied', error: 'approval expired' });

        if (task.get('status') !== 'waiting_approval') return null;
        tx.update(taskRef, {
          status: 'pending',
          runAfter: null,
          lockedUntil: null,
          leaseToken: null,
          queueGeneration: generation,
          attempt: 0,
          attentionNotifiedAt: null,
          updatedAt: now,
        });
        createWakeIntent(tx, this.store, {
          taskId: approval.taskId,
          generation,
          availableAt: now,
        });
        return { taskId: approval.taskId, generation };
      });
      if (wake) wakes.push(wake);
    }
    return wakes;
  }

  async resumeResolved(batch = 200, suppliedNow?: Date): Promise<ApprovalWake[]> {
    const limit = approvalSweepBatch(batch);
    const now = suppliedNow ?? this.store.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
      throw new Error('Invalid approval sweep time');
    const cursorRef = this.store.doc('coordination', 'approval-recovery-cursor');
    const parked = await this.store.db.runTransaction(async (tx) => {
      const cursorSnapshot = await tx.get(cursorRef);
      const cursor = cursorSnapshot.exists ? cursorSnapshot.get('cursor') : null;
      if (cursor !== null && typeof cursor !== 'string')
        throw new Error('Invalid approval recovery cursor');
      const baseQuery = this.store
        .collection('tasks')
        .where('status', '==', 'waiting_approval')
        .orderBy('id', 'asc');
      const query = cursor ? baseQuery.startAfter(cursor) : baseQuery;
      let page = await tx.get(query.limit(limit));
      if (page.empty && cursor !== null) page = await tx.get(baseQuery.limit(limit));
      const lastId = page.docs.at(-1)?.get('id');
      if (page.size === limit && typeof lastId !== 'string')
        throw new Error('Invalid approval recovery task ID');
      tx.set(cursorRef, {
        cursor: page.size === limit ? lastId : null,
        updatedAt: now,
      });
      return page.docs.map((candidate) => candidate.ref);
    });
    const wakes: ApprovalWake[] = [];
    for (const taskRef of parked) {
      const wake = await this.store.db.runTransaction(async (tx) => {
        const snapshot = await tx.get(taskRef);
        if (!snapshot.exists || snapshot.get('status') !== 'waiting_approval') return null;
        const task = decodeRecord<Records['tasks']>(snapshot.data());
        if (typeof task.id !== 'string') return null;
        try {
          if (documentKey(task.id) !== taskRef.id) return null;
        } catch {
          return null;
        }
        const ids = parkedApprovalIds(task.state);
        if (!ids) return null;
        const approvalSnapshots = await tx.getAll(
          ...ids.map((id) => this.store.doc('approvals', id)),
        );
        for (const approval of approvalSnapshots) {
          if (
            !approval.exists ||
            approval.get('taskId') !== task.id ||
            !approvalIsResolved(approval.get('status'))
          )
            return null;
        }
        const generation = Number(task.queueGeneration) + 1;
        if (!Number.isSafeInteger(generation) || generation < 1) return null;
        tx.update(taskRef, {
          status: 'pending',
          runAfter: null,
          lockedUntil: null,
          leaseToken: null,
          queueGeneration: generation,
          attempt: 0,
          attentionNotifiedAt: null,
          updatedAt: now,
        });
        createWakeIntent(tx, this.store, {
          taskId: task.id,
          generation,
          availableAt: now,
        });
        return { taskId: task.id, generation };
      });
      if (wake) wakes.push(wake);
    }
    return wakes;
  }
}
