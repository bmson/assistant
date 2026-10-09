import { createHash, randomUUID } from 'node:crypto';
import type {
  ApplicationChatApproval,
  ApplicationChatConversation,
  ApplicationChatHydrationState,
  ApplicationChatMessage,
  ApplicationChatPersistence,
  Records,
  TaskLease,
} from '@assistant/persistence';
import {
  assertChatAdmissionOperationId,
  boundedChatConversationLimit,
  boundedChatMessageLimit,
  chatAdmissionCancellationPayload,
  chatAdmissionCancellationTrigger,
  chatAdmissionExternalEventId,
  chatAdmissionPayload,
  isChatAdmissionCancellationProjection,
  newTaskRecord,
  normalizeTaskBudget,
  recallSurfaceRefs,
  withChatAdmissionPhase,
} from '@assistant/persistence';
import { type Query, type QueryDocumentSnapshot, Timestamp } from '@google-cloud/firestore';
import { conversationDocument } from './conversation-document.js';
import { FirestoreExecutionEvidenceRepository } from './execution-evidence.js';
import { assertFirestoreInstallationOwner } from './installation-owner.js';
import { createWakeIntent } from './outbox.js';
import {
  assertPrivacyErasureGenerationInTransaction,
  assertPrivacyErasureInactiveInTransaction,
  readPrivacyErasureFence,
} from './privacy-erasure.js';
import { deterministicUuid } from './stable-id.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'];
const MAX_ACTIVE_TASKS = 500;
const MAX_MODELS = 100;
const MAX_LOOKUP_IDS = 200;
const GOAL_BLOCKED_PREFIX = 'Waiting on the owner:';
const DIRECT_CHAT_LEASE_MS = 10 * 60_000;
const FIRST_APPEND_ID = '00000000-0000-0000-0000-000000000000';

function conciseTitle(value: string | undefined): string | undefined {
  const title = value?.replace(/\s+/g, ' ').trim() ?? '';
  if (!title) return undefined;
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

function decodeConversation(snapshot: QueryDocumentSnapshot): ApplicationChatConversation {
  return decodeRecord<ApplicationChatConversation>(snapshot.data());
}

function decodeMessage(snapshot: QueryDocumentSnapshot): ApplicationChatMessage {
  return decodeMessageData(snapshot.data(), snapshot.get('createdAt'), snapshot.get('appendedAt'));
}

function decodeMessageData(
  data: FirebaseFirestore.DocumentData,
  createdAt: unknown,
  appendedAt: unknown,
): ApplicationChatMessage {
  const message = decodeRecord<ApplicationChatMessage & { embeddingSpace?: unknown }>(data);
  const appendSequence =
    appendedAt instanceof Timestamp
      ? (BigInt(appendedAt.seconds) * 1_000_000_000n + BigInt(appendedAt.nanoseconds))
          .toString()
          .padStart(20, '0')
      : undefined;
  const wholeSecond =
    createdAt instanceof Timestamp
      ? new Date(Number(createdAt.seconds) * 1_000)
          .toISOString()
          .slice(0, 'YYYY-MM-DDTHH:mm:ss'.length)
      : undefined;
  return {
    ...message,
    embeddingSpaceKey:
      typeof message.embeddingSpaceKey === 'string'
        ? message.embeddingSpaceKey
        : typeof message.embeddingSpace === 'string'
          ? message.embeddingSpace
          : null,
    ...(wholeSecond && createdAt instanceof Timestamp
      ? { createdAtExact: `${wholeSecond}.${String(createdAt.nanoseconds).padStart(9, '0')}Z` }
      : {}),
    ...(appendSequence ? { appendSequence } : {}),
  };
}

function appendedTimestamp(sequence: string): Timestamp {
  const value = BigInt(sequence);
  const seconds = value / 1_000_000_000n;
  const nanos = value % 1_000_000_000n;
  return new Timestamp(Number(seconds), Number(nanos));
}

function chunks<T>(values: T[], size = 30): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function boundedIds(values: string[]): string[] {
  const unique = [...new Set(values)];
  if (unique.length > MAX_LOOKUP_IDS) throw new Error('Chat lookup exceeds bounded page size');
  return unique;
}

function isOwnedChat(data: FirebaseFirestore.DocumentData | undefined, agentId: string): boolean {
  return Boolean(data && data.agentId === agentId && data.channel === 'chat');
}

async function assertRecalledMessagesCurrent(
  tx: FirebaseFirestore.Transaction,
  store: InstallationStore,
  agentId: string,
  refs: ReturnType<typeof recallSurfaceRefs>,
) {
  const ids = [...new Set(refs.flatMap((ref) => ref.sourceMessageIds ?? []))];
  if (!ids.length) return;
  const snapshots = await Promise.all(
    chunks(ids, 30).map((group) => tx.getAll(...group.map((id) => store.doc('messages', id)))),
  );
  const messagesById = new Map<string, FirebaseFirestore.DocumentSnapshot>();
  for (const snapshot of snapshots.flat()) {
    const id = snapshot.get('id');
    if (typeof id === 'string') messagesById.set(id, snapshot);
  }
  const conversationIds = [
    ...new Set(
      ids
        .map((id) => messagesById.get(id)?.get('conversationId'))
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
  const conversations = await Promise.all(
    chunks(conversationIds, 30).map((group) =>
      tx.getAll(...group.map((id) => store.doc('conversations', id))),
    ),
  );
  const ownedConversationIds = new Set(
    conversations
      .flat()
      .filter((snapshot) => snapshot.exists && isOwnedChat(snapshot.data(), agentId))
      .map((snapshot) => snapshot.get('id'))
      .filter((id): id is string => typeof id === 'string'),
  );
  for (const ref of refs) {
    const sourceIds = ref.sourceMessageIds;
    if (!sourceIds?.length) continue;
    const sourceRows = sourceIds.map((id) => messagesById.get(id));
    if (
      sourceRows.some(
        (row) =>
          !row?.exists ||
          row.get('hiddenAt') != null ||
          typeof row.get('conversationId') !== 'string' ||
          !ownedConversationIds.has(row.get('conversationId')),
      )
    )
      throw new Error('Recalled source changed before chat publication');
    if (ref.representation === 'message_excerpts') {
      const revision = createHash('sha256')
        .update(
          JSON.stringify(sourceRows.map((row, index) => [sourceIds[index], row?.get('text')])),
        )
        .digest('hex');
      if (revision !== ref.sourceRevision)
        throw new Error('Recalled source changed before chat publication');
    }
  }
}

/** Firestore adapter for the owner-facing application chat read/write model. */
export class FirestoreApplicationChatPersistence implements ApplicationChatPersistence {
  readonly kind = 'application-chat-persistence' as const;

  constructor(
    readonly store: InstallationStore,
    private readonly configuredAgentId?: string,
  ) {}

  async privacyObservationGeneration(agentId: string): Promise<string | null> {
    if (agentId !== this.configuredAgentId)
      throw new Error('Privacy observation is outside the configured Firestore owner');
    const fence = await readPrivacyErasureFence(this.store, agentId);
    return fence ? `${fence.seconds}:${fence.nanoseconds}` : null;
  }

  async resolveAgent() {
    const ownerId = await assertFirestoreInstallationOwner(this.store, this.configuredAgentId);
    if (!ownerId) throw new Error('no agent row — run pnpm seed');
    const snapshot = await this.store.doc('agents', ownerId).get();
    if (!snapshot.exists) throw new Error('installation owner changed during lookup');
    const agent = decodeRecord<Awaited<ReturnType<ApplicationChatPersistence['resolveAgent']>>>(
      snapshot.data(),
    );
    if (agent.id !== ownerId) throw new Error('installation owner identity mismatch');
    return agent;
  }

  async getOrCreatePrimaryConversation(agentId: string) {
    if (this.configuredAgentId && this.configuredAgentId !== agentId)
      throw new Error('Primary conversation owner is outside this installation');
    return this.store.db.runTransaction(async (tx) => {
      const owner = await tx.get(this.store.doc('agents', agentId));
      if (!owner.exists || owner.get('id') !== agentId)
        throw new Error('Primary conversation owner is missing');
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      const markerRef = this.store.doc('primaryConversations', agentId);
      const marker = await tx.get(markerRef);
      const ownerPurpose = (document: FirebaseFirestore.DocumentSnapshot) => {
        const metadata = document.get('metadata') as Record<string, unknown> | undefined;
        return (
          isOwnedChat(document.data(), agentId) &&
          document.get('trust') === 'owner' &&
          !metadata?.goalId &&
          (metadata?.purpose === undefined || metadata.purpose === 'owner-chat')
        );
      };
      const demote = new Map<string, FirebaseFirestore.DocumentReference>();
      let marked: FirebaseFirestore.DocumentSnapshot | undefined;
      if (marker.exists) {
        const id = marker.get('conversationId');
        if (marker.get('agentId') !== agentId || typeof id !== 'string' || !id)
          throw new Error('Primary conversation marker is malformed');
        marked = await tx.get(this.store.doc('conversations', id));
        if (
          !marked.exists ||
          !isOwnedChat(marked.data(), agentId) ||
          marked.get('id') !== id ||
          marked.get('isPrimary') !== true
        )
          throw new Error('Primary conversation marker does not match an owned chat');
        if (!ownerPurpose(marked)) demote.set(marked.id, marked.ref);
      }
      const primarySnapshot = await tx.get(
        this.store
          .collection('conversations')
          .where('agentId', '==', agentId)
          .where('isPrimary', '==', true)
          .limit(3),
      );
      if (primarySnapshot.size > 2) throw new Error('Ambiguous primary conversation');
      const valid = primarySnapshot.docs.filter((document) => {
        if (
          document.get('id') === undefined ||
          this.store.doc('conversations', document.get('id')).id !== document.id
        )
          throw new Error('Primary conversation identity mismatch');
        if (!isOwnedChat(document.data(), agentId))
          throw new Error('Primary conversation belongs to another agent');
        if (ownerPurpose(document)) return true;
        demote.set(document.id, document.ref);
        return false;
      });
      if (valid.length > 1) throw new Error('Ambiguous primary conversation');
      let selected: FirebaseFirestore.QueryDocumentSnapshot | undefined = valid[0];
      if (!selected) {
        // Bound the candidate read; a thread that has no suitable legacy chat
        // gets a new stable primary rather than an unbounded bootstrap scan.
        const candidates = await tx.get(
          this.store
            .collection('conversations')
            .where('agentId', '==', agentId)
            .where('channel', '==', 'chat')
            .where('trust', '==', 'owner')
            .where('archived', '==', false)
            .orderBy('updatedAt', 'desc')
            .orderBy('id', 'desc')
            .limit(100),
        );
        selected = candidates.docs.find(ownerPurpose);
      }
      const now = this.store.now();
      for (const ref of demote.values()) tx.update(ref, { isPrimary: false, updatedAt: now });
      if (selected) {
        if (
          typeof selected.get('id') !== 'string' ||
          this.store.doc('conversations', selected.get('id')).id !== selected.id
        )
          throw new Error('Primary conversation identity mismatch');
        const conversation = decodeConversation(selected);
        const alreadyCanonical =
          marker.exists &&
          marked?.id === selected.id &&
          demote.size === 0 &&
          selected.get('isPrimary') === true &&
          selected.get('archived') === false &&
          selected.get('archivedAt') === null &&
          (conversation.metadata as { purpose?: unknown } | null)?.purpose === 'owner-chat';
        if (alreadyCanonical) return conversation;
        const metadata = { ...(conversation.metadata as object), purpose: 'owner-chat' };
        tx.update(selected.ref, {
          isPrimary: true,
          archivedAt: null,
          archived: false,
          metadata,
          updatedAt: now,
        });
        tx.set(markerRef, {
          agentId,
          conversationId: conversation.id,
          createdAt: marker.get('createdAt') ?? now,
        });
        return { ...conversation, isPrimary: true, archivedAt: null, metadata, updatedAt: now };
      }
      const id = randomUUID();
      const created: ApplicationChatConversation = {
        id,
        agentId,
        channel: 'chat',
        title: '',
        trust: 'owner',
        modelOverride: null,
        isPrimary: true,
        metadata: { purpose: 'owner-chat' },
        archivedAt: null,
        lastReadAt: null,
        messageSequence: 0,
        createdAt: now,
        updatedAt: now,
      };
      tx.create(this.store.doc('conversations', id), conversationDocument(created));
      tx.set(markerRef, { agentId, conversationId: id, createdAt: now });
      return created;
    });
  }

  async createConversation(agentId: string) {
    const id = randomUUID();
    const now = this.store.now();
    const row: ApplicationChatConversation = {
      id,
      agentId,
      channel: 'chat',
      title: '',
      trust: 'owner',
      modelOverride: null,
      isPrimary: false,
      metadata: { purpose: 'owner-chat' },
      archivedAt: null,
      lastReadAt: null,
      messageSequence: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.doc('conversations', id).create(conversationDocument(row));
    return row;
  }

  async getConversation(agentId: string, conversationId: string) {
    const snapshot = await this.store.doc('conversations', conversationId).get();
    if (!snapshot.exists || !isOwnedChat(snapshot.data(), agentId)) return null;
    return decodeRecord<ApplicationChatConversation>(snapshot.data());
  }

  async listConversations(
    agentId: string,
    input: Parameters<ApplicationChatPersistence['listConversations']>[1],
  ) {
    const limit = boundedChatConversationLimit(input.limit);
    let query: Query = this.store
      .collection('conversations')
      .where('agentId', '==', agentId)
      .where('channel', '==', 'chat')
      .where('archived', '==', input.archived)
      .orderBy('updatedAt', 'desc')
      .orderBy('id', 'desc');
    if (input.after) query = query.startAfter(input.after.updatedAt, input.after.id);
    const snapshot = await query.limit(limit + 1).get();
    const rows = snapshot.docs.slice(0, limit).map(decodeConversation);
    const tail = rows.at(-1);
    return {
      conversations: rows,
      hasMore: snapshot.size > limit,
      nextCursor: tail ? { updatedAt: tail.updatedAt, id: tail.id } : null,
    };
  }

  async countConversations(agentId: string, archived: boolean) {
    const snapshot = await this.store
      .collection('conversations')
      .where('agentId', '==', agentId)
      .where('channel', '==', 'chat')
      .where('archived', '==', archived)
      .count()
      .get();
    return snapshot.data().count;
  }

  async listActiveConversationIds(agentId: string) {
    const snapshot = await this.store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .where('status', 'not-in', TERMINAL_TASK_STATUSES)
      .limit(MAX_ACTIVE_TASKS + 1)
      .get();
    if (snapshot.size > MAX_ACTIVE_TASKS)
      throw new Error('Active chat task set exceeds safety bound');
    return [
      ...new Set(
        snapshot.docs
          .map((doc) => doc.get('conversationId'))
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];
  }

  async archiveConversation(agentId: string, conversationId: string) {
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('conversations', conversationId);
      const conversation = await tx.get(ref);
      if (!conversation.exists || !isOwnedChat(conversation.data(), agentId)) {
        throw new Error('chat not found');
      }
      if (conversation.get('isPrimary') === true) return 'primary' as const;
      const active = await tx.get(
        this.store
          .collection('tasks')
          .where('agentId', '==', agentId)
          .where('conversationId', '==', conversationId)
          .where('status', 'not-in', TERMINAL_TASK_STATUSES)
          .limit(1),
      );
      if (!active.empty) return 'active' as const;
      const now = this.store.now();
      tx.update(ref, { archivedAt: now, archived: true, updatedAt: now });
      return 'archived' as const;
    });
  }

  async restoreConversation(agentId: string, conversationId: string) {
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('conversations', conversationId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || !isOwnedChat(snapshot.data(), agentId)) return false;
      if (snapshot.get('archivedAt') === null) return false;
      tx.update(ref, { archivedAt: null, archived: false, updatedAt: this.store.now() });
      return true;
    });
  }

  async archiveInactiveConversations(agentId: string, olderThan: Date, requestedLimit = 100) {
    const limit = boundedChatConversationLimit(requestedLimit);
    const candidates = await this.store
      .collection('conversations')
      .where('agentId', '==', agentId)
      .where('channel', '==', 'chat')
      .where('isPrimary', '==', false)
      .where('archived', '==', false)
      .where('updatedAt', '<', olderThan)
      .orderBy('updatedAt', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .get();
    let archived = 0;
    for (const candidate of candidates.docs) {
      archived += await this.store.db.runTransaction(async (tx) => {
        const current = await tx.get(candidate.ref);
        if (
          !current.exists ||
          !isOwnedChat(current.data(), agentId) ||
          current.get('isPrimary') === true ||
          current.get('archivedAt') !== null ||
          (decodeRecord<Date>(current.get('updatedAt'))?.getTime?.() ?? Number.POSITIVE_INFINITY) >=
            olderThan.getTime()
        ) {
          return 0;
        }
        const active = await tx.get(
          this.store
            .collection('tasks')
            .where('agentId', '==', agentId)
            .where('conversationId', '==', candidate.get('id'))
            .where('status', 'not-in', TERMINAL_TASK_STATUSES)
            .limit(1),
        );
        if (!active.empty) return 0;
        const now = this.store.now();
        tx.update(candidate.ref, { archivedAt: now, archived: true, updatedAt: now });
        return 1;
      });
    }
    return archived;
  }

  async setConversationModel(agentId: string, conversationId: string, modelId: string | null) {
    return this.updateOwned(agentId, conversationId, {
      modelOverride: modelId,
      updatedAt: this.store.now(),
    });
  }

  async setConversationTitleIfEmpty(agentId: string, conversationId: string, title: string) {
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('conversations', conversationId);
      const snapshot = await tx.get(ref);
      if (
        !snapshot.exists ||
        !isOwnedChat(snapshot.data(), agentId) ||
        snapshot.get('title') !== ''
      ) {
        return false;
      }
      tx.update(ref, { title });
      return true;
    });
  }

  async markConversationRead(
    agentId: string,
    conversationId: string,
    readAt: Date,
    settleSeconds = 30,
  ) {
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('conversations', conversationId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || !isOwnedChat(snapshot.data(), agentId)) return false;
      const lastReadAt = snapshot.get('lastReadAt');
      const lastRead = lastReadAt ? decodeRecord<Date>(lastReadAt) : null;
      if (lastRead && lastRead.getTime() >= readAt.getTime() - Math.max(0, settleSeconds) * 1000) {
        return false;
      }
      tx.update(ref, { lastReadAt: readAt });
      return true;
    });
  }

  async getGoalTitle(agentId: string, goalId: string) {
    const snapshot = await this.store.doc('goals', goalId).get();
    return snapshot.exists && snapshot.get('agentId') === agentId
      ? String(snapshot.get('title') ?? '')
      : null;
  }

  async clearGoalBlockedOnOwnerReply(agentId: string, goalId: string) {
    await this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('goals', goalId);
      const snapshot = await tx.get(ref);
      if (
        !snapshot.exists ||
        snapshot.get('agentId') !== agentId ||
        !String(snapshot.get('nextAction') ?? '').startsWith(GOAL_BLOCKED_PREFIX)
      ) {
        return;
      }
      tx.update(ref, { nextAction: '', updatedAt: this.store.now() });
    });
  }

  async countActiveTasks(agentId: string, conversationId: string) {
    const snapshot = await this.store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .where('conversationId', '==', conversationId)
      .where('status', 'not-in', TERMINAL_TASK_STATUSES)
      .count()
      .get();
    return snapshot.data().count;
  }

  async getTaskStatus(agentId: string, conversationId: string, taskId: string) {
    const snapshot = await this.store.doc('tasks', taskId).get();
    if (!snapshot.exists) return null;
    const task = decodeRecord<Record<string, unknown>>(snapshot.data());
    if (
      task.id !== taskId ||
      documentKey(taskId) !== snapshot.id ||
      task.agentId !== agentId ||
      task.conversationId !== conversationId ||
      isChatAdmissionCancellationProjection(task)
    )
      return null;
    return typeof task.status === 'string' ? task.status : null;
  }

  async listTaskActivity(
    agentId: string,
    conversationId: string,
    taskId: string,
    requestedLimit = 3,
  ) {
    if ((await this.getTaskStatus(agentId, conversationId, taskId)) === null) return [];
    const limit = Math.max(1, Math.min(10, Math.floor(requestedLimit)));
    const snapshot = await this.store
      .collection('toolCalls')
      .where('taskId', '==', taskId)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs
      .map((doc) => ({
        toolName: String(doc.get('toolName')),
        status: String(doc.get('status')),
        step: Number(doc.get('step')),
      }))
      .reverse();
  }

  async listEnabledModels() {
    const snapshot = await this.store
      .collection('models')
      .where('enabled', '==', true)
      .orderBy('label', 'asc')
      .limit(MAX_MODELS + 1)
      .get();
    if (snapshot.size > MAX_MODELS) throw new Error('Enabled model set exceeds safety bound');
    return snapshot.docs
      .filter((doc) => doc.get('capabilities.embedding') !== true)
      .map((doc) => ({ id: String(doc.get('id')), label: String(doc.get('label')) }));
  }

  async listMessages(
    agentId: string,
    conversationId: string,
    input: Parameters<ApplicationChatPersistence['listMessages']>[2] = {},
  ) {
    if (!(await this.getConversation(agentId, conversationId))) return null;
    const limit = boundedChatMessageLimit(input.limit);
    let query: Query = this.store
      .collection('messages')
      .where('conversationId', '==', conversationId)
      .where('hiddenAt', '==', null);
    let afterSequence = input.after?.appendSequence;
    if (input.after && !afterSequence) {
      // Older clients only sent the createdAt/id pair. Resolve that stable
      // message identity to its commit-ordered position before paging so a
      // late-created message cannot be skipped by the legacy timestamp.
      const anchor = await this.store.doc('messages', input.after.id).get();
      const appendedAt = anchor.get('appendedAt');
      if (
        anchor.exists &&
        anchor.get('conversationId') === conversationId &&
        anchor.get('hiddenAt') === null &&
        appendedAt instanceof Timestamp
      ) {
        afterSequence = (
          BigInt(appendedAt.seconds) * 1_000_000_000n +
          BigInt(appendedAt.nanoseconds)
        )
          .toString()
          .padStart(20, '0');
      }
    }
    if (afterSequence) {
      query = query
        .orderBy('appendedAt', 'asc')
        .orderBy('id', 'asc')
        .startAfter(appendedTimestamp(afterSequence), input.after?.id ?? '')
        .limit(limit + 1);
      const snapshot = await query.get();
      return {
        messages: snapshot.docs.slice(0, limit).map(decodeMessage),
        hasMore: snapshot.size > limit,
      };
    }
    if (input.fromStart || input.after) {
      query = query.orderBy('appendedAt', 'asc').orderBy('id', 'asc');
      query = query.startAfter(new Timestamp(0, 0), FIRST_APPEND_ID).limit(limit + 1);
      const snapshot = await query.get();
      return {
        messages: snapshot.docs.slice(0, limit).map(decodeMessage),
        hasMore: snapshot.size > limit,
      };
    }
    const [chronological, appendOrdered] = await Promise.all([
      query.orderBy('createdAt', 'desc').orderBy('id', 'desc').limit(limit).get(),
      query.orderBy('appendedAt', 'asc').orderBy('id', 'asc').limitToLast(limit).get(),
    ]);
    const chronologicalRows = chronological.docs.map(decodeMessage).reverse();
    const appendedRows = appendOrdered.docs.map(decodeMessage);
    const byId = new Map(appendedRows.map((message) => [message.id, message]));
    for (const message of chronologicalRows) {
      if (!byId.has(message.id) && byId.size < limit) byId.set(message.id, message);
    }
    return {
      messages: [...byId.values()].sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
      ),
      hasMore: false,
    };
  }

  async listMessagesByIds(agentId: string, conversationId: string, rawIds: string[]) {
    if (!(await this.getConversation(agentId, conversationId))) return null;
    const ids = boundedIds(rawIds);
    if (!ids.length) return [];
    const snapshots = await this.store.db.getAll(
      ...ids.map((id) => this.store.doc('messages', id)),
    );
    return snapshots
      .filter(
        (snapshot) =>
          snapshot.exists &&
          snapshot.get('conversationId') === conversationId &&
          snapshot.get('hiddenAt') === null,
      )
      .map((snapshot) => decodeRecord<ApplicationChatMessage>(snapshot.data()))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  async listRuntimeMessages(
    agentId: string,
    conversationId: string,
    rawTaskIds: string[],
    requestedLimit = 200,
  ) {
    if (!(await this.getConversation(agentId, conversationId))) return null;
    const taskIds = boundedIds(rawTaskIds);
    if (!taskIds.length) return [];
    const limit = boundedChatMessageLimit(requestedLimit);
    const pages = await Promise.all(
      chunks(taskIds).map((ids) =>
        this.store
          .collection('messages')
          .where('conversationId', '==', conversationId)
          .where('taskId', 'in', ids)
          .where('role', '==', 'assistant')
          .where('hiddenAt', '==', null)
          .orderBy('createdAt', 'asc')
          .orderBy('id', 'asc')
          .limit(limit)
          .get(),
      ),
    );
    const rows = pages
      .flatMap((page) => page.docs.map(decodeMessage))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    return rows.slice(0, limit);
  }

  async setMessageHidden(
    agentId: string,
    conversationId: string,
    messageId: string,
    hidden: boolean,
  ) {
    return this.store.db.runTransaction(async (tx) => {
      const conversation = await tx.get(this.store.doc('conversations', conversationId));
      if (!conversation.exists || !isOwnedChat(conversation.data(), agentId)) return false;
      const ref = this.store.doc('messages', messageId);
      const message = await tx.get(ref);
      if (!message.exists || message.get('conversationId') !== conversationId) return false;
      tx.update(ref, { hiddenAt: hidden ? this.store.now() : null });
      return true;
    });
  }

  async acknowledgeMessageDelivery(
    agentId: string,
    conversationId: string,
    messageId: string,
    clientId: string,
  ): Promise<boolean> {
    return this.store.db.runTransaction(async (tx) => {
      const conversationRef = this.store.doc('conversations', conversationId);
      const messageRef = this.store.doc('messages', messageId);
      const conversation = await tx.get(conversationRef);
      if (!conversation.exists || !isOwnedChat(conversation.data(), agentId)) return false;
      const message = await tx.get(messageRef);
      if (
        !message.exists ||
        message.get('conversationId') !== conversationId ||
        message.get('role') !== 'assistant'
      )
        return false;
      const deliveredBy = message.get('clientDeliveredBy');
      if (typeof deliveredBy === 'string') return deliveredBy === clientId;
      const taskId = message.get('taskId');
      if (typeof taskId !== 'string') return false;
      const taskSnapshot = await tx.get(this.store.doc('tasks', taskId));
      if (!taskSnapshot.exists) return false;
      const task = decodeRecord<Records['tasks']>(taskSnapshot.data());
      const admission = chatAdmissionPayload(task);
      if (
        task.agentId !== agentId ||
        task.conversationId !== conversationId ||
        task.type !== 'chat_turn' ||
        task.trust !== 'owner' ||
        task.status !== 'done' ||
        !admission
      )
        return false;
      const request = await tx.get(this.store.doc('messages', admission.triggerMessageId));
      if (
        !request.exists ||
        request.get('conversationId') !== conversationId ||
        request.get('taskId') !== taskId ||
        request.get('role') !== 'user' ||
        request.get('origin') !== 'owner' ||
        request.get('clientId') !== clientId
      )
        return false;
      tx.update(messageRef, {
        clientDeliveredAt: this.store.now(),
        clientDeliveredBy: clientId,
      });
      return true;
    });
  }

  async getTaskKinds(agentId: string, rawTaskIds: string[]) {
    const ids = boundedIds(rawTaskIds);
    if (!ids.length) return new Map();
    const snapshots = await this.store.db.getAll(...ids.map((id) => this.store.doc('tasks', id)));
    return new Map(
      snapshots
        .filter((snapshot) => snapshot.exists && snapshot.get('agentId') === agentId)
        .map((snapshot) => [String(snapshot.get('id')), String(snapshot.get('type'))]),
    );
  }

  async getHydrationState(
    agentId: string,
    input: Parameters<ApplicationChatPersistence['getHydrationState']>[1],
  ): Promise<ApplicationChatHydrationState> {
    const approvalIds = boundedIds(input.approvalIds);
    const approvalTaskIds = boundedIds(input.approvalTaskIds);
    const budgetTaskIds = boundedIds(input.budgetTaskIds);
    const suggestionIds = boundedIds(input.suggestionIds);
    const [approvalDocs, taskApprovalPages, budgetDocs, suggestionDocs] = await Promise.all([
      approvalIds.length
        ? this.store.db.getAll(...approvalIds.map((id) => this.store.doc('approvals', id)))
        : [],
      Promise.all(
        chunks(approvalTaskIds).map((ids) =>
          this.store
            .collection('approvals')
            .where('taskId', 'in', ids)
            .limit(MAX_LOOKUP_IDS + 1)
            .get(),
        ),
      ),
      budgetTaskIds.length
        ? this.store.db.getAll(...budgetTaskIds.map((id) => this.store.doc('tasks', id)))
        : [],
      suggestionIds.length
        ? this.store.db.getAll(...suggestionIds.map((id) => this.store.doc('suggestions', id)))
        : [],
    ]);
    if (taskApprovalPages.some((page) => page.size > MAX_LOOKUP_IDS)) {
      throw new Error('Approval hydration exceeds bounded page size');
    }
    const rawApprovals = [
      ...new Map(
        [
          ...approvalDocs.filter((doc) => doc.exists),
          ...taskApprovalPages.flatMap((page) => page.docs),
        ].map((doc) => [doc.id, doc]),
      ).values(),
    ];
    const approvalTaskRefs = boundedIds(
      rawApprovals
        .map((doc) => doc.get('taskId'))
        .filter((id): id is string => typeof id === 'string'),
    );
    const approvalTasks = approvalTaskRefs.length
      ? await this.store.db.getAll(...approvalTaskRefs.map((id) => this.store.doc('tasks', id)))
      : [];
    const acceptedTaskRefs = boundedIds(
      suggestionDocs
        .map((doc) => doc.get('acceptedTaskId'))
        .filter((id): id is string => typeof id === 'string'),
    );
    const acceptedTasks = acceptedTaskRefs.length
      ? await this.store.db.getAll(...acceptedTaskRefs.map((id) => this.store.doc('tasks', id)))
      : [];
    const acceptedTaskById = new Map(
      acceptedTasks
        .filter((doc) => doc.exists && doc.get('agentId') === agentId)
        .map((doc) => [String(doc.get('id')), doc]),
    );
    const ownedTaskIds = new Set(
      approvalTasks
        .filter((doc) => doc.exists && doc.get('agentId') === agentId)
        .map((doc) => String(doc.get('id'))),
    );
    const toolCallIds = boundedIds(
      rawApprovals
        .filter((doc) => ownedTaskIds.has(String(doc.get('taskId'))))
        .map((doc) => doc.get('toolCallId'))
        .filter((id): id is string => typeof id === 'string'),
    );
    const toolCallDocs = toolCallIds.length
      ? await this.store.db.getAll(...toolCallIds.map((id) => this.store.doc('toolCalls', id)))
      : [];
    const toolNameById = new Map(
      toolCallDocs
        .filter((doc) => doc.exists && ownedTaskIds.has(String(doc.get('taskId'))))
        .map((doc) => [
          String(doc.get('id')),
          { taskId: String(doc.get('taskId')), toolName: String(doc.get('toolName')) },
        ]),
    );
    const decodeApproval = (doc: FirebaseFirestore.DocumentSnapshot): ApplicationChatApproval => ({
      id: String(doc.get('id')),
      taskId: String(doc.get('taskId')),
      summary: String(doc.get('summary')),
      status: String(doc.get('status')),
      payload: decodeRecord(doc.get('payload')),
      toolName:
        toolNameById.get(String(doc.get('toolCallId')))?.taskId === String(doc.get('taskId'))
          ? toolNameById.get(String(doc.get('toolCallId')))?.toolName
          : undefined,
      expiresAt: decodeRecord<Date>(doc.get('expiresAt')),
    });
    const directIdSet = new Set(approvalIds);
    const approvals = rawApprovals
      .filter(
        (doc) =>
          directIdSet.has(String(doc.get('id'))) && ownedTaskIds.has(String(doc.get('taskId'))),
      )
      .map(decodeApproval);
    const taskApprovals = rawApprovals
      .filter(
        (doc) =>
          approvalTaskIds.includes(String(doc.get('taskId'))) &&
          ownedTaskIds.has(String(doc.get('taskId'))),
      )
      .map(decodeApproval);
    return {
      approvals,
      taskApprovals,
      budgetTasks: budgetDocs
        .filter((doc) => doc.exists && doc.get('agentId') === agentId)
        .map((doc) => ({
          id: String(doc.get('id')),
          status: String(doc.get('status')),
          budgetUsdLimit: String(doc.get('budgetUsdLimit')),
        })),
      suggestions: suggestionDocs
        .filter((doc) => doc.exists && doc.get('agentId') === agentId)
        .map((doc) => {
          const acceptedTaskId =
            typeof doc.get('acceptedTaskId') === 'string'
              ? String(doc.get('acceptedTaskId'))
              : null;
          const acceptedTask = acceptedTaskId ? acceptedTaskById.get(acceptedTaskId) : undefined;
          return {
            id: String(doc.get('id')),
            status: String(doc.get('status')),
            expiresAt: decodeRecord<Date>(doc.get('expiresAt')),
            origin: String(doc.get('origin') ?? ''),
            proposedAction: String(doc.get('proposedAction') ?? ''),
            snoozedUntil: doc.get('snoozedUntil')
              ? decodeRecord<Date>(doc.get('snoozedUntil'))
              : null,
            acceptedTaskId,
            acceptedTaskStatus: acceptedTask ? String(acceptedTask.get('status')) : null,
            acceptedTaskProgress: acceptedTask ? String(acceptedTask.get('progress') ?? '') : null,
            acceptedTaskConversationId:
              acceptedTask && typeof acceptedTask.get('conversationId') === 'string'
                ? String(acceptedTask.get('conversationId'))
                : null,
          };
        }),
    };
  }

  async appendOwned(
    agentId: string,
    input: Parameters<ApplicationChatPersistence['appendOwned']>[1],
  ) {
    const id = randomUUID();
    const conversation = this.store.doc('conversations', input.conversationId);
    const dedupe = input.channelMessageId
      ? this.store.doc('messageChannelIds', input.channelMessageId)
      : null;
    const row = await this.store.db.runTransaction(async (tx) => {
      const parent = await tx.get(conversation);
      if (!parent.exists || !isOwnedChat(parent.data(), agentId)) throw new Error('chat not found');
      const existing = dedupe ? await tx.get(dedupe) : null;
      if (existing?.exists) {
        if (existing.get('conversationId') !== input.conversationId) {
          throw new Error('Channel message ID belongs to another conversation');
        }
        return undefined;
      }
      const now = this.store.now();
      const row: ApplicationChatMessage = {
        ...input,
        id,
        createdAt: now,
        taskId: input.taskId ?? null,
        channelMessageId: input.channelMessageId ?? null,
        clientId: null,
        clientDeliveredAt: null,
        clientDeliveredBy: null,
        embedding: null,
        embeddingSpaceKey: null,
        hiddenAt: null,
        appendSequence: '00000000000000000000',
      };
      if (Buffer.byteLength(JSON.stringify(row), 'utf8') > 900_000) {
        throw new Error('Message exceeds inline storage limit; store its payload in Cloud Storage');
      }
      tx.create(this.store.doc('messages', id), encodeRecord(row));
      if (dedupe) tx.create(dedupe, { messageId: id, conversationId: input.conversationId });
      tx.update(conversation, { updatedAt: now });
      return row;
    });
    if (!row) return undefined;
    const committed = await this.store.doc('messages', id).get();
    if (!committed.exists) throw new Error('Committed chat message is missing');
    return decodeMessageData(
      committed.data() ?? {},
      committed.get('createdAt'),
      committed.get('appendedAt'),
    );
  }

  async cancelChatTurn(input: Parameters<ApplicationChatPersistence['cancelChatTurn']>[0]) {
    assertChatAdmissionOperationId(input.clientOperationId);
    const externalEventId = chatAdmissionExternalEventId(input);
    const eventRef = this.store.doc(
      'taskEventKeys',
      createHash('sha256').update(externalEventId).digest('hex'),
    );
    return this.store.db.runTransaction(async (tx) => {
      const conversationRef = this.store.doc('conversations', input.conversationId);
      const conversationSnapshot = await tx.get(conversationRef);
      if (!conversationSnapshot.exists || !isOwnedChat(conversationSnapshot.data(), input.agentId))
        throw new Error('chat not found');
      const key = await tx.get(eventRef);
      if (key.exists) {
        const taskId = key.get('taskId');
        if (typeof taskId !== 'string' || !taskId)
          throw new Error('Chat admission index is malformed');
        const taskRef = this.store.doc('tasks', taskId);
        const taskSnapshot = await tx.get(taskRef);
        if (!taskSnapshot.exists) throw new Error('Chat admission index points to a missing task');
        const task = decodeRecord<Records['tasks']>(taskSnapshot.data());
        if (task.id !== taskId || task.externalEventId !== externalEventId)
          throw new Error('Chat admission index points to a mismatched task');
        if (task.agentId !== input.agentId || task.conversationId !== input.conversationId)
          throw new Error('Chat operation ID was already used for a different request');
        const cancellation = chatAdmissionCancellationPayload(task);
        if (cancellation) {
          if (cancellation.clientOperationId !== input.clientOperationId)
            throw new Error('Chat operation ID was already used for a different request');
          return {
            kind: 'cancelled_before_admission',
            task,
            status: 'cancelled',
            transitioned: false,
            effectStatus: 'not_started',
          } as const;
        }
        const admission = chatAdmissionPayload(task);
        if (!admission || admission.clientOperationId !== input.clientOperationId)
          throw new Error('Chat operation ID was already used for a different request');
        const messageSnapshot = await tx.get(
          this.store.doc('messages', admission.triggerMessageId),
        );
        if (
          !messageSnapshot.exists ||
          messageSnapshot.get('conversationId') !== input.conversationId ||
          messageSnapshot.get('taskId') !== taskId ||
          messageSnapshot.get('role') !== 'user'
        )
          throw new Error('Chat admission is missing its owner message');
        if (['done', 'failed', 'cancelled'].includes(task.status))
          return {
            kind: 'admitted_task',
            task,
            status: task.status,
            transitioned: false,
            effectStatus: 'unknown',
          } as const;
        const now = this.store.now();
        tx.update(taskRef, {
          status: 'cancelled',
          lockedUntil: null,
          leaseToken: null,
          runAfter: null,
          attempt: 0,
          updatedAt: now,
        });
        return {
          kind: 'admitted_task',
          task: {
            ...task,
            status: 'cancelled',
            lockedUntil: null,
            leaseToken: null,
            runAfter: null,
            attempt: 0,
            updatedAt: now,
          },
          status: 'cancelled',
          transitioned: true,
          effectStatus: 'unknown',
        } as const;
      }

      const taskId = randomUUID();
      const now = this.store.now();
      const task = {
        ...newTaskRecord(
          {
            agentId: input.agentId,
            conversationId: input.conversationId,
            type: 'chat_turn',
            trust: 'owner',
            trigger: chatAdmissionCancellationTrigger(input),
            externalEventId,
          },
          taskId,
          now,
        ),
        status: 'cancelled',
      };
      tx.create(this.store.doc('tasks', taskId), encodeRecord(task));
      tx.create(eventRef, { taskId, createdAt: now });
      return {
        kind: 'cancelled_before_admission',
        task,
        status: 'cancelled',
        transitioned: true,
        effectStatus: 'not_started',
      } as const;
    });
  }

  async admitChatTurn(input: Parameters<ApplicationChatPersistence['admitChatTurn']>[0]) {
    const taskId = randomUUID();
    const messageId = randomUUID();
    const leaseToken = randomUUID();
    const externalEventId = chatAdmissionExternalEventId(input);
    const eventRef = this.store.doc(
      'taskEventKeys',
      createHash('sha256').update(externalEventId).digest('hex'),
    );
    const result = await this.store.db.runTransaction(async (tx) => {
      const conversationRef = this.store.doc('conversations', input.conversationId);
      const conversationSnapshot = await tx.get(conversationRef);
      if (!conversationSnapshot.exists || !isOwnedChat(conversationSnapshot.data(), input.agentId))
        throw new Error('chat not found');

      const key = await tx.get(eventRef);
      if (key.exists) {
        const existingId = key.get('taskId');
        if (typeof existingId !== 'string') throw new Error('Chat admission index is malformed');
        const taskSnapshot = await tx.get(this.store.doc('tasks', existingId));
        if (!taskSnapshot.exists) throw new Error('Chat admission index points to a missing task');
        const task = decodeRecord<Records['tasks']>(taskSnapshot.data());
        if (task.id !== existingId || task.externalEventId !== externalEventId)
          throw new Error('Chat admission index points to a mismatched task');
        const cancellation = chatAdmissionCancellationPayload(task);
        if (cancellation) {
          if (
            task.agentId !== input.agentId ||
            task.conversationId !== input.conversationId ||
            cancellation.clientOperationId !== input.clientOperationId
          )
            throw new Error('Chat operation ID was already used for a different request');
          return {
            kind: 'cancelled_before_admission',
            created: false,
            task,
            status: 'cancelled',
            effectStatus: 'not_started',
          } as const;
        }
        const admission = chatAdmissionPayload(task);
        if (
          task.agentId !== input.agentId ||
          task.conversationId !== input.conversationId ||
          !admission ||
          admission.clientOperationId !== input.clientOperationId ||
          admission.requestHash !== input.requestHash
        )
          throw new Error('Chat operation ID was already used for a different request');
        const messageSnapshot = await tx.get(
          this.store.doc('messages', admission.triggerMessageId),
        );
        if (
          !messageSnapshot.exists ||
          messageSnapshot.get('conversationId') !== input.conversationId ||
          messageSnapshot.get('role') !== 'user'
        )
          throw new Error('Chat admission is missing its owner message');
        return {
          kind: 'admitted',
          created: false,
          task,
          message: decodeMessageData(
            messageSnapshot.data() ?? {},
            messageSnapshot.get('createdAt'),
            messageSnapshot.get('appendedAt'),
          ),
        } as const;
      }

      const budget = await tx.get(this.store.doc('budgets', 'task_default'));
      const now = this.store.now();
      const trigger = {
        source: 'chat',
        agentId: input.agentId,
        conversationId: input.conversationId,
        trust: 'owner',
        payload: {
          text: input.text,
          triggerMessageId: messageId,
          requestAt: now.toISOString(),
          intentRevision: 1,
          clientOperationId: input.clientOperationId,
          autonomous: input.autonomous,
          force: input.force,
          spoken: input.spoken,
          chatAdmission: {
            protocol: 'owner-chat-v1',
            clientOperationId: input.clientOperationId,
            requestHash: input.requestHash,
            triggerMessageId: messageId,
            phase: 'classifying',
          },
        },
      };
      const task = newTaskRecord(
        {
          agentId: input.agentId,
          conversationId: input.conversationId,
          type: 'chat_turn',
          trust: 'owner',
          title: input.text,
          goalId: input.goalId,
          trigger,
          externalEventId,
          budgetUsdLimit: budget.get('limitUsd') ?? '0.50',
          autonomyGrant: input.autonomyGrant,
        },
        taskId,
        now,
      );
      const lease: TaskLease = {
        ...task,
        status: 'running',
        updatedAt: now,
        lockedUntil: new Date(now.getTime() + DIRECT_CHAT_LEASE_MS),
        leaseToken,
      };
      const message: ApplicationChatMessage = {
        id: messageId,
        conversationId: input.conversationId,
        taskId,
        role: 'user',
        origin: 'owner',
        clientId: input.clientId ?? null,
        clientDeliveredAt: null,
        clientDeliveredBy: null,
        parts: [{ type: 'text', text: input.text }],
        text: input.text,
        channelMessageId: null,
        embedding: null,
        embeddingSpaceKey: null,
        hiddenAt: null,
        createdAt: now,
        appendSequence: '00000000000000000000',
      };
      tx.create(this.store.doc('tasks', taskId), encodeRecord(lease));
      tx.create(eventRef, { taskId, createdAt: now });
      tx.create(this.store.doc('messages', messageId), encodeRecord(message));
      tx.update(conversationRef, { updatedAt: now });
      return { kind: 'admitted', created: true, task: lease, message, lease } as const;
    });
    if (!result.created || result.kind !== 'admitted') return result;
    const messageSnapshot = await this.store.doc('messages', result.message.id).get();
    if (!messageSnapshot.exists) throw new Error('Committed chat admission message is missing');
    return {
      ...result,
      message: decodeMessageData(
        messageSnapshot.data() ?? {},
        messageSnapshot.get('createdAt'),
        messageSnapshot.get('appendedAt'),
      ),
    };
  }

  async queueAdmittedChatTurn(
    input: Parameters<ApplicationChatPersistence['queueAdmittedChatTurn']>[0],
  ) {
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('tasks', input.task.id);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('agentId') !== input.agentId) return null;
      const task = decodeRecord<TaskLease>(snapshot.data());
      if (task.status !== 'running' || task.leaseToken !== input.task.leaseToken) return null;
      const admission = chatAdmissionPayload(task);
      if (!admission || admission.phase === 'queued') return null;
      const now = this.store.now();
      const queueGeneration = task.queueGeneration + 1;
      tx.update(
        ref,
        encodeRecord({
          status: 'pending',
          trigger: withChatAdmissionPhase(task.trigger, 'queued', input.triagedActionable),
          lockedUntil: null,
          leaseToken: null,
          queueGeneration,
          updatedAt: now,
        }),
      );
      createWakeIntent(tx, this.store, {
        taskId: task.id,
        generation: queueGeneration,
        availableAt: now,
      });
      return { id: task.id, queueGeneration };
    });
  }

  async markChatTurnStreaming(
    input: Parameters<ApplicationChatPersistence['markChatTurnStreaming']>[0],
  ) {
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('tasks', input.task.id);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('agentId') !== input.agentId) return false;
      const task = decodeRecord<TaskLease>(snapshot.data());
      if (task.status !== 'running' || task.leaseToken !== input.task.leaseToken) return false;
      const admission = chatAdmissionPayload(task);
      if (!admission || admission.phase === 'queued') return false;
      tx.update(ref, {
        trigger: withChatAdmissionPhase(task.trigger, 'streaming', false, input.triageOutcome),
        updatedAt: this.store.now(),
      });
      return true;
    });
  }

  async createDirectChatTask(input: {
    agentId: string;
    conversationId: string;
    goalId?: string;
    title?: string;
  }) {
    const id = randomUUID();
    return this.store.db.runTransaction(async (tx) => {
      const conversation = await tx.get(this.store.doc('conversations', input.conversationId));
      if (!conversation.exists || !isOwnedChat(conversation.data(), input.agentId)) {
        throw new Error('chat not found');
      }
      const budget = await tx.get(this.store.doc('budgets', 'task_default'));
      const now = this.store.now();
      const task = newTaskRecord(
        {
          agentId: input.agentId,
          conversationId: input.conversationId,
          type: 'chat_turn',
          trust: 'owner',
          budgetUsdLimit: budget.get('limitUsd') ?? '0.50',
          goalId: input.goalId,
          title: conciseTitle(input.title),
          trigger: { source: 'chat', conversationId: input.conversationId },
        },
        id,
        now,
      );
      const lease: TaskLease = {
        ...task,
        status: 'running',
        updatedAt: now,
        lockedUntil: new Date(now.getTime() + DIRECT_CHAT_LEASE_MS),
        leaseToken: randomUUID(),
      };
      tx.create(this.store.doc('tasks', id), encodeRecord(lease));
      return lease;
    });
  }

  async completeDirectChatTask(input: {
    agentId: string;
    task: TaskLease;
    status: 'done' | 'failed';
    progress?: string;
    privacyObservationGeneration?: string | null;
    messages: Parameters<ApplicationChatPersistence['appendOwned']>[1][];
  }) {
    return this.store.db.runTransaction(async (tx) => {
      const taskRef = this.store.doc('tasks', input.task.id);
      const taskSnapshot = await tx.get(taskRef);
      if (!taskSnapshot.exists) return false;
      const task = decodeRecord<TaskLease>(taskSnapshot.data());
      const now = this.store.now();
      if (
        task.agentId !== input.agentId ||
        task.status !== 'running' ||
        !input.task.leaseToken ||
        task.leaseToken !== input.task.leaseToken ||
        !task.lockedUntil ||
        task.lockedUntil <= now
      ) {
        return false;
      }
      const conversationRef = task.conversationId
        ? this.store.doc('conversations', task.conversationId)
        : null;
      const conversation = conversationRef ? await tx.get(conversationRef) : null;
      if (
        conversation &&
        (!conversation.exists || !isOwnedChat(conversation.data(), input.agentId))
      ) {
        throw new Error('Chat completion conversation is outside the owner scope');
      }
      for (const message of input.messages) {
        if (message.conversationId !== task.conversationId || message.taskId !== task.id) {
          throw new Error('Chat completion message does not match its task');
        }
      }
      const persistedMessages = input.messages.map((message) => {
        const id = randomUUID();
        const row: ApplicationChatMessage = {
          ...message,
          id,
          createdAt: now,
          taskId: message.taskId ?? null,
          channelMessageId: message.channelMessageId ?? null,
          clientId: null,
          clientDeliveredAt: null,
          clientDeliveredBy: null,
          embedding: null,
          embeddingSpaceKey: null,
          hiddenAt: null,
          appendSequence: '00000000000000000000',
        };
        return {
          row,
          refs:
            input.status === 'done' && message.role === 'assistant'
              ? recallSurfaceRefs(message.parts)
              : [],
        };
      });
      const surfaced = persistedMessages.flatMap(({ row, refs }) =>
        refs.map((source) => ({ source, messageId: row.id })),
      );
      if (input.status === 'done')
        await assertRecalledMessagesCurrent(
          tx,
          this.store,
          input.agentId,
          surfaced.map(({ source }) => source),
        );
      if (input.privacyObservationGeneration !== undefined) {
        await assertPrivacyErasureGenerationInTransaction(
          tx,
          this.store,
          input.agentId,
          input.privacyObservationGeneration,
        );
      } else if (surfaced.length > 0) {
        if (!conversation || conversation.get('agentId') !== input.agentId)
          throw new Error('Chat completion conversation is outside the owner scope');
        await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      }
      const uniqueSurfaced = [
        ...new Map(surfaced.map((entry) => [entry.source.sourceKey, entry])).values(),
      ];
      const surfaceTargets = uniqueSurfaced.map(({ source, messageId }) => ({
        source,
        messageId,
        doc: this.store.doc(
          'recallSurfaces',
          deterministicUuid('assistant:recall-surface', input.agentId, source.sourceKey),
        ),
      }));
      const priorSurfaces = surfaceTargets.length
        ? await tx.getAll(...surfaceTargets.map((target) => target.doc))
        : [];
      for (const [index, target] of surfaceTargets.entries()) {
        const prior = priorSurfaces[index];
        if (
          prior?.exists &&
          prior.get('agentId') === input.agentId &&
          prior.get('sourceKey') === target.source.sourceKey &&
          prior.get('sourceRevision') === target.source.sourceRevision &&
          prior.get('suppressedAt') != null
        )
          throw new Error('Recalled source was hidden before chat publication');
      }
      tx.update(
        taskRef,
        encodeRecord({
          status: input.status,
          progress: input.progress,
          lockedUntil: null,
          leaseToken: null,
          updatedAt: now,
        }),
      );
      for (const { row } of persistedMessages) {
        tx.create(this.store.doc('messages', row.id), encodeRecord(row));
      }
      surfaceTargets.forEach(({ source, messageId, doc }, index) => {
        const prior = priorSurfaces[index];
        if (prior?.exists) {
          const current = decodeRecord<Records['recallSurfaces']>(prior.data());
          if (current.agentId !== input.agentId || current.sourceKey !== source.sourceKey)
            throw new Error('Recall surface ownership mismatch');
          const revised = current.sourceRevision !== source.sourceRevision;
          tx.update(
            doc,
            encodeRecord({
              suppressedAt: revised ? null : current.suppressedAt,
              sourceRevision: source.sourceRevision,
              kind: source.kind,
              lastSurfacedAt: now,
              lastMessageId: messageId,
              surfaceCount: current.surfaceCount + 1,
              version: current.version + (revised ? 1 : 0),
            }),
          );
          return;
        }
        const id = deterministicUuid('assistant:recall-surface', input.agentId, source.sourceKey);
        tx.create(
          doc,
          encodeRecord({
            id,
            agentId: input.agentId,
            sourceKey: source.sourceKey,
            sourceRevision: source.sourceRevision,
            kind: source.kind,
            firstSurfacedAt: now,
            lastSurfacedAt: now,
            lastMessageId: messageId,
            surfaceCount: 1,
            suppressedAt: null,
            version: 1,
          }),
        );
      });
      if (conversationRef && input.messages.length) tx.update(conversationRef, { updatedAt: now });
      return true;
    });
  }

  async raiseTaskBudget(agentId: string, taskId: string, requested: number) {
    if (normalizeTaskBudget(requested, 0.01) === null) {
      throw new Error(
        'task budget must be between $0.01 and $9,999.9999 with at most four decimal places',
      );
    }
    await this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('tasks', taskId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('agentId') !== agentId) {
        throw new Error('activity item not found');
      }
      const task = decodeRecord<TaskLease>(snapshot.data());
      if (task.status !== 'needs_attention') throw new Error('only stalled tasks can be retried');
      if (requested <= Number(task.budgetUsdLimit) || requested < Number(task.spentUsd)) {
        throw new Error('new task budget must be above its current cap and spend');
      }
      const now = this.store.now();
      const queueGeneration = task.queueGeneration + 1;
      tx.update(
        ref,
        encodeRecord({
          status: 'pending',
          budgetUsdLimit: requested.toFixed(4),
          runAfter: null,
          lockedUntil: null,
          leaseToken: null,
          queueGeneration,
          updatedAt: now,
        }),
      );
      createWakeIntent(tx, this.store, { taskId, generation: queueGeneration, availableAt: now });
    });
  }

  listConversationEvidence(agentId: string, conversationId: string, excludeTaskId: string) {
    return new FirestoreExecutionEvidenceRepository(this.store).conversationEvidence({
      agentId,
      conversationId,
      excludeTaskId,
    });
  }

  private async updateOwned(
    agentId: string,
    conversationId: string,
    patch: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>,
  ) {
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('conversations', conversationId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || !isOwnedChat(snapshot.data(), agentId)) return false;
      tx.update(ref, patch);
      return true;
    });
  }
}
