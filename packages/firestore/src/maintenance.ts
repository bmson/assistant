import { createHash } from 'node:crypto';
import {
  type AgedHistoryCounts,
  compactToolCallReceipt,
  type EmbeddingSpace,
  type ExpiredDataCounts,
  type MaintenanceRepository,
  type Records,
  snapshotEmbeddingSpace,
  toolCallReceiptKeysForReceipt,
  validateEmbedding,
  validateSkillEmbeddingSpace,
} from '@assistant/persistence';
import {
  type DocumentReference,
  FieldValue,
  type Query,
  type QueryDocumentSnapshot,
  Timestamp,
  type Transaction,
  type WhereFilterOp,
} from '@google-cloud/firestore';
import { embeddingSpaceKey } from './memory.js';
import { FirestoreOwnerNoticeRepository } from './owner-notices.js';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const ATTENTION_CURSOR = 'attention-notices-cursor';
const EMBEDDING_CURSOR = 'message-embedding-cursor';
const MESSAGE_RETENTION_CURSOR = 'message-retention-cursor';
const TOOL_CALL_RETENTION_CURSOR = 'tool-call-retention-cursor';
const DAY_MS = 86_400_000;
/** Firestore's `in` filter accepts at most 30 values. */
const IN_LIMIT = 30;
/** Documents read per embedding pass, so skipped short or tool rows are not re-read. */
const EMBEDDING_SCAN = 200;
/** Messages this recent may still be committing out of createdAt order; the next pass takes them. */
const EMBEDDING_SETTLE_MS = 60_000;
/** Dependent rows one retention transaction may touch before it fails explicitly. */
const CASCADE_LIMIT = 100;
/** A retention scan that reached the end restarts from the oldest row at most this often. */
const RESCAN_MS = DAY_MS;
const SUGGESTION_BATCH = 200;

type Position = { createdAt: Timestamp; id: string };

function batchLimit(batch: number, max = 500): number {
  if (!Number.isSafeInteger(batch) || batch < 1) throw new Error('Invalid maintenance batch');
  return Math.min(batch, max);
}

function validDate(value: Date, message: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(message);
  return value;
}

/**
 * Return the unresolved tool-call IDs named by a task checkpoint, or null when
 * its execution checkpoint is malformed. A malformed checkpoint retains the
 * task's receipts: maintenance must not turn corrupt recovery state into a
 * missing effect result.
 */
function unresolvedCheckpointToolCalls(state: unknown): Set<string> | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const checkpoint = state as Record<string, unknown>;
  const references = new Set<string>();
  if (
    'pendingFinal' in checkpoint &&
    checkpoint.pendingFinal !== null &&
    (!checkpoint.pendingFinal ||
      typeof checkpoint.pendingFinal !== 'object' ||
      Array.isArray(checkpoint.pendingFinal))
  ) {
    return null;
  }
  if ('pendingJob' in checkpoint && checkpoint.pendingJob !== null) {
    const pending = checkpoint.pendingJob;
    if (!pending || typeof pending !== 'object' || Array.isArray(pending)) return null;
    const id = (pending as Record<string, unknown>).dbToolCallId;
    if (typeof id !== 'string' || id.length === 0) return null;
    references.add(id);
  }
  if ('pendingToolBatch' in checkpoint && checkpoint.pendingToolBatch !== null) {
    const batch = checkpoint.pendingToolBatch;
    if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return null;
    const calls = (batch as Record<string, unknown>).calls;
    if (!Array.isArray(calls) || calls.length > 1000) return null;
    for (const call of calls) {
      if (!call || typeof call !== 'object' || Array.isArray(call)) return null;
      const row = call as Record<string, unknown>;
      if (!['queued', 'awaiting_approval', 'budget', 'job', 'settled'].includes(String(row.status)))
        return null;
      if ('dbToolCallId' in row && row.dbToolCallId !== undefined) {
        if (typeof row.dbToolCallId !== 'string' || row.dbToolCallId.length === 0) return null;
        if (row.status !== 'settled') references.add(row.dbToolCallId);
      }
    }
  }
  return references;
}

function chunks<T>(rows: T[], size = IN_LIMIT): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function bounded(tx: Transaction, query: Query, message: string) {
  const rows = await tx.get(query.limit(CASCADE_LIMIT + 1));
  if (rows.size > CASCADE_LIMIT) throw new Error(message);
  return rows.docs;
}

function position(doc: QueryDocumentSnapshot | undefined): Position | null {
  const createdAt = doc?.get('createdAt');
  const id = doc?.get('id');
  if (!doc) return null;
  if (!(createdAt instanceof Timestamp) || typeof id !== 'string' || !id)
    throw new Error('Invalid maintenance scan row');
  return { createdAt, id };
}

function readPosition(raw: unknown, message: string): Position | null {
  if (raw === null || raw === undefined) return null;
  const createdAt = (raw as { createdAt?: unknown }).createdAt;
  const id = (raw as { id?: unknown }).id;
  if (!(createdAt instanceof Timestamp) || typeof id !== 'string' || !id) throw new Error(message);
  return { createdAt, id };
}

/** Owns the sweep's maintenance steps for one configured installation. */
export class FirestoreMaintenanceRepository implements MaintenanceRepository {
  readonly kind = 'maintenance-repository' as const;
  private readonly notices: FirestoreOwnerNoticeRepository;
  readonly space: EmbeddingSpace;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
    space: EmbeddingSpace,
  ) {
    this.space = snapshotEmbeddingSpace(space);
    validateSkillEmbeddingSpace(this.space);
    this.notices = new FirestoreOwnerNoticeRepository(store, agentId);
  }

  async expireSuggestions(suppliedNow?: Date): Promise<number> {
    const now = validDate(suppliedNow ?? this.store.now(), 'Invalid suggestion expiry time');
    // Expired rows leave the query, so a bounded page never starves later ones.
    return this.store.db.runTransaction(async (tx) => {
      const page = await tx.get(
        this.store
          .collection('suggestions')
          .where('status', 'in', ['pending', 'snoozed'])
          .where('expiresAt', '<=', now)
          .orderBy('expiresAt', 'asc')
          .orderBy('id', 'asc')
          .limit(SUGGESTION_BATCH),
      );
      for (const doc of page.docs) tx.update(doc.ref, { status: 'expired', updatedAt: now });
      return page.size;
    });
  }

  async listStalledAttention(input: {
    olderThanMinutes: number;
    batch: number;
    now?: Date;
  }): Promise<Records['tasks'][]> {
    const batch = batchLimit(input.batch, 200);
    if (!Number.isFinite(input.olderThanMinutes) || input.olderThanMinutes < 0)
      throw new Error('Invalid attention notice age');
    const now = validDate(input.now ?? this.store.now(), 'Invalid attention notice time');
    const cutoff = new Date(now.getTime() - input.olderThanMinutes * 60_000);
    const cursorRef = this.store.doc('coordination', ATTENTION_CURSOR);
    // A task whose notice cannot be delivered stays unstamped. The durable
    // cursor walks past it, so a run of those cannot starve later tasks.
    const page = await this.store.db.runTransaction(async (tx) => {
      const cursorSnapshot = await tx.get(cursorRef);
      const rawCursor = cursorSnapshot.exists ? cursorSnapshot.get('cursor') : null;
      let cursor: { updatedAt: Timestamp; id: string } | null = null;
      if (rawCursor !== null) {
        const updatedAt = (rawCursor as { updatedAt?: unknown })?.updatedAt;
        const id = (rawCursor as { id?: unknown })?.id;
        if (!(updatedAt instanceof Timestamp) || typeof id !== 'string' || id.length === 0)
          throw new Error('Invalid attention notice cursor');
        cursor = { updatedAt, id };
      }
      const baseQuery = this.store
        .collection('tasks')
        .where('agentId', '==', this.agentId)
        .where('status', 'in', ['needs_attention', 'waiting_event'])
        .where('attentionNotifiedAt', '==', null)
        .where('updatedAt', '<=', cutoff)
        .orderBy('updatedAt', 'asc')
        .orderBy('id', 'asc');
      const query = cursor ? baseQuery.startAfter(cursor.updatedAt, cursor.id) : baseQuery;
      let result = await tx.get(query.limit(batch));
      if (result.empty && cursor !== null) result = await tx.get(baseQuery.limit(batch));
      const last = result.docs.at(-1);
      const updatedAt = last?.get('updatedAt');
      const id = last?.get('id');
      if (result.size === batch && (!(updatedAt instanceof Timestamp) || typeof id !== 'string'))
        throw new Error('Invalid attention notice candidate');
      tx.set(cursorRef, {
        cursor: result.size === batch && last ? { updatedAt, id } : null,
        updatedAt: now,
      });
      return result.docs;
    });
    return page.flatMap((doc) => {
      const task = decodeRecord<Records['tasks']>(doc.data());
      try {
        if (typeof task.id !== 'string' || documentKey(task.id) !== doc.id) return [];
      } catch {
        return [];
      }
      return task.agentId === this.agentId ? [task] : [];
    });
  }

  async postAttentionNotice(input: {
    taskId: string;
    text: string;
    parts: unknown[];
  }): Promise<boolean> {
    return (await this.notices.postTaskNotice(input)) !== null;
  }

  postBudgetNotice(input: {
    cacheKey: string;
    pct: number;
    expiresAt: Date;
    text: string;
  }): Promise<boolean> {
    return this.notices.postNotificationOnce({
      text: input.text,
      cacheKey: input.cacheKey,
      toolName: 'budget.notice',
      result: { pct: input.pct },
      expiresAt: input.expiresAt,
    });
  }

  async embedMissingMessages(input: {
    batch: number;
    embeddingSpaceKey: string;
    embed: (texts: string[]) => Promise<number[][]>;
  }): Promise<number> {
    const batch = batchLimit(input.batch, 100);
    const space = embeddingSpaceKey(this.space);
    if (input.embeddingSpaceKey !== space)
      throw new Error('Message embedding identity does not match the configured Firestore space');
    // Progress is isolated per embedding space. A model/revision change starts
    // its own pass instead of inheriting a cursor that may be beyond older
    // history. The hash keeps arbitrary provider/model labels out of doc paths.
    const spaceId = createHash('sha256').update(space).digest('hex').slice(0, 32);
    const cursorRef = this.store.doc('coordination', `${EMBEDDING_CURSOR}-${spaceId}`);
    const cursorSnapshot = await cursorRef.get();
    const cursor = readPosition(
      cursorSnapshot.exists ? cursorSnapshot.get('cursor') : null,
      'Invalid message embedding cursor',
    );
    // Walk messages in creation order behind a durable cursor. A completed
    // sweep clears its cursor, so a late import inserted behind the cursor is
    // discovered on the next sweep. Existing vectors from another or unknown
    // space are left untouched; changing model identity never triggers a
    // silent paid regeneration.
    const settled = new Date(this.store.now().getTime() - EMBEDDING_SETTLE_MS);
    const base = this.store
      .collection('messages')
      .where('createdAt', '<=', settled)
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc');
    const page = await (cursor ? base.startAfter(cursor.createdAt, cursor.id) : base)
      .limit(EMBEDDING_SCAN)
      .get();
    const candidates: Array<{ ref: DocumentReference; id: string; text: string }> = [];
    let last: QueryDocumentSnapshot | undefined;
    for (const doc of page.docs) {
      last = doc;
      const row = doc.data();
      if (
        (row.role === 'user' || row.role === 'assistant') &&
        typeof row.text === 'string' &&
        !(
          typeof row.channelMessageId === 'string' &&
          (row.channelMessageId.startsWith('visual-qa:') ||
            row.channelMessageId.startsWith('readability-'))
        ) &&
        // PostgreSQL's length() counts characters, not UTF-16 code units.
        [...row.text].length > 20 &&
        row.embedding == null &&
        typeof row.id === 'string'
      )
        candidates.push({ ref: doc.ref, id: row.id, text: row.text });
      if (candidates.length >= batch) break;
    }
    const next = position(last);
    if (!next) {
      // Clear only the cursor snapshot we observed. A concurrent scan may have
      // advanced it since the initial read; that owner must finish its pass.
      await this.store.db.runTransaction(async (tx) => {
        const current = await tx.get(cursorRef);
        if (
          cursorSnapshot.exists &&
          current.exists &&
          cursorSnapshot.updateTime &&
          current.updateTime?.isEqual(cursorSnapshot.updateTime)
        )
          tx.delete(cursorRef);
      });
      return 0;
    }
    const vectors = candidates.length ? await input.embed(candidates.map((row) => row.text)) : [];
    if (vectors.length !== candidates.length)
      throw new Error('Embedding count does not match the messages sent');
    for (const vector of vectors) validateEmbedding(this.space, vector);
    return this.store.db.runTransaction(async (tx) => {
      const [current, ...snapshots] = await tx.getAll(
        cursorRef,
        ...candidates.map((row) => row.ref),
      );
      let stored = 0;
      snapshots.forEach((snapshot, index) => {
        const candidate = candidates[index];
        const vector = vectors[index];
        if (!snapshot?.exists || !candidate || !vector) return;
        if (snapshot.get('id') !== candidate.id || snapshot.get('text') !== candidate.text) return;
        if (snapshot.get('embedding') != null) return;
        tx.update(snapshot.ref, {
          embedding: FieldValue.vector(vector),
          embeddingSpace: space,
          embeddingSpaceKey: space,
        });
        stored += 1;
      });
      // A concurrent pass that already moved the cursor keeps its position.
      const unchanged = cursorSnapshot.exists
        ? Boolean(
            current?.exists &&
              cursorSnapshot.updateTime &&
              current.updateTime?.isEqual(cursorSnapshot.updateTime),
          )
        : !current?.exists;
      if (unchanged) tx.set(cursorRef, { cursor: next, updatedAt: this.store.now() });
      return stored;
    });
  }

  async purgeExpired(input: {
    now?: Date;
    batch: number;
    locationRetentionDays: number;
    proactivePingRetentionDays: number;
    auditRetentionDays: number;
  }): Promise<ExpiredDataCounts> {
    const now = validDate(input.now ?? this.store.now(), 'Invalid retention time');
    const limit = batchLimit(input.batch);
    const pingDays = Number.isFinite(input.proactivePingRetentionDays)
      ? Math.max(1, Math.trunc(input.proactivePingRetentionDays))
      : 90;
    const auditDays = Number.isFinite(input.auditRetentionDays)
      ? Math.max(1, Math.trunc(input.auditRetentionDays))
      : 14;
    const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
    // The same comparisons as the PostgreSQL purges, class by class.
    const [cache, memories, locations, dreamNotes, proactivePings, modelCallAudit] =
      await Promise.all([
        this.deleteWhere('toolCache', 'expiresAt', '<=', now, limit),
        this.purgeExpiredMemories(now, limit),
        this.deleteWhere(
          'locationPings',
          'capturedAt',
          '<',
          ago(input.locationRetentionDays),
          limit,
        ),
        this.deleteWhere('dreamNotes', 'expiresAt', '<', now, limit),
        this.deleteWhere('proactivePings', 'createdAt', '<', ago(pingDays), limit),
        this.deleteWhere('modelCallAudit', 'createdAt', '<', ago(auditDays), limit),
      ]);
    return { cache, memories, locations, dreamNotes, proactivePings, modelCallAudit };
  }

  async purgeAgedHistory(input: {
    now?: Date;
    historyDays: number;
    costDays: number;
    batch: number;
  }): Promise<AgedHistoryCounts> {
    const now = validDate(input.now ?? this.store.now(), 'Invalid retention time');
    const limit = batchLimit(input.batch, 1000);
    const counts: AgedHistoryCounts = { messages: 0, toolCalls: 0, modelCalls: 0, costEvents: 0 };
    // Cost first: deleting an aged cost event frees its tool call for the
    // history pass below within the same sweep.
    if (input.costDays > 0)
      counts.costEvents = await this.deleteWhere(
        'costEvents',
        'createdAt',
        '<=',
        new Date(now.getTime() - input.costDays * DAY_MS),
        Math.min(limit, 500),
      );
    if (input.historyDays > 0) {
      const cutoff = new Date(now.getTime() - input.historyDays * DAY_MS);
      const [messages, toolCalls, modelCalls] = await Promise.all([
        this.purgeAgedMessages(cutoff, limit, now),
        this.purgeAgedToolCalls(cutoff, limit, now),
        this.purgeAgedModelCalls(cutoff, limit),
      ]);
      Object.assign(counts, { messages, toolCalls, modelCalls });
    }
    return counts;
  }

  private async deleteWhere(
    collection: string,
    field: string,
    op: WhereFilterOp,
    value: Date,
    limit: number,
  ): Promise<number> {
    validDate(value, 'Invalid retention cutoff');
    return this.store.db.runTransaction(async (tx) => {
      const rows = await tx.get(
        this.store.collection(collection).where(field, op, value).limit(Math.min(limit, 500)),
      );
      for (const row of rows.docs) tx.delete(row.ref);
      return rows.size;
    });
  }

  /** Memory expiry removes what PostgreSQL's cascades remove: graph sources and relations. */
  private async purgeExpiredMemories(now: Date, limit: number): Promise<number> {
    const due = await this.store
      .collection('memories')
      .where('expiresAt', '<=', now)
      .limit(limit)
      .get();
    let deleted = 0;
    for (const candidate of due.docs) {
      try {
        if (await this.deleteExpiredMemory(candidate.ref, now)) deleted += 1;
      } catch (err) {
        // One oversized memory must not block the rest of the batch.
        console.error('expired memory purge failed', { memory: candidate.id }, err);
      }
    }
    return deleted;
  }

  private deleteExpiredMemory(ref: DocumentReference, now: Date): Promise<boolean> {
    return this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false;
      const row = decodeRecord<unknown>(snapshot.data());
      if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
      const raw = row as Record<string, unknown>;
      const id = raw.id;
      const agentId = raw.agentId;
      const expiresAt = raw.expiresAt;
      const contentHash = raw.contentHash;
      if (
        typeof id !== 'string' ||
        documentKey(id) !== snapshot.id ||
        typeof agentId !== 'string' ||
        !agentId ||
        !(expiresAt instanceof Date) ||
        expiresAt > now
      )
        return false;
      const relations = await bounded(
        tx,
        this.store
          .collection('knowledgeGraphRelations')
          .where('agentId', '==', agentId)
          .where('sourceMemoryId', '==', id),
        'Expired memory has more graph relations than one retention transaction removes',
      );
      const hashRef =
        typeof contentHash === 'string' && contentHash
          ? this.store.doc('memoryContentHashes', contentHash)
          : null;
      const sourceRef = this.store.doc('knowledgeGraphSources', id);
      const [source, hash] = await tx.getAll(sourceRef, ...(hashRef ? [hashRef] : []));
      tx.delete(ref);
      for (const relation of relations) tx.delete(relation.ref);
      if (source?.exists) tx.delete(sourceRef);
      if (hash?.exists && hash.get('memoryId') === id) tx.delete(hash.ref);
      return true;
    });
  }

  /**
   * One page of rows at or before the cutoff, after a durable cursor. Rows the
   * pass must keep stay behind the cursor instead of being re-read every sweep.
   * Once the scan reaches the end it restarts from the oldest row at most once
   * a day, so a row that has since lost its anchor is still removed.
   */
  private async agedPage(
    collection: 'messages' | 'toolCalls',
    cursorName: string,
    cutoff: Date,
    limit: number,
    now: Date,
  ): Promise<QueryDocumentSnapshot[]> {
    const cursorRef = this.store.doc('coordination', cursorName);
    return this.store.db.runTransaction(async (tx) => {
      const cursorSnapshot = await tx.get(cursorRef);
      let cursor = readPosition(
        cursorSnapshot.exists ? cursorSnapshot.get('cursor') : null,
        'Invalid retention cursor',
      );
      const restartedAt = cursorSnapshot.exists ? cursorSnapshot.get('restartedAt') : null;
      let restarted = restartedAt instanceof Timestamp ? restartedAt.toDate() : null;
      const base = this.store
        .collection(collection)
        .where('createdAt', '<=', cutoff)
        .orderBy('createdAt', 'asc')
        .orderBy('id', 'asc');
      let page = await tx.get(
        (cursor ? base.startAfter(cursor.createdAt, cursor.id) : base).limit(limit),
      );
      if (
        page.empty &&
        cursor !== null &&
        (!restarted || now.getTime() - restarted.getTime() >= RESCAN_MS)
      ) {
        cursor = null;
        restarted = now;
        page = await tx.get(base.limit(limit));
      }
      tx.set(cursorRef, {
        cursor: position(page.docs.at(-1)) ?? cursor,
        restartedAt: restarted ?? now,
        updatedAt: now,
      });
      return page.docs;
    });
  }

  /** Messages anchoring a conversation segment stay: the segment references its range by id. */
  private async purgeAgedMessages(cutoff: Date, limit: number, now: Date): Promise<number> {
    const page = await this.agedPage('messages', MESSAGE_RETENTION_CURSOR, cutoff, limit, now);
    let deleted = 0;
    for (const chunk of chunks(page)) {
      deleted += await this.store.db.runTransaction(async (tx) => {
        await assertPrivacyErasureInactiveInTransaction(tx, this.store, this.agentId);
        const snapshots = await tx.getAll(...chunk.map((doc) => doc.ref));
        const rows = snapshots.flatMap((snapshot) => {
          if (!snapshot.exists) return [];
          const row = decodeRecord<Records['messages']>(snapshot.data());
          return row.createdAt instanceof Date && row.createdAt <= cutoff
            ? [{ row, ref: snapshot.ref }]
            : [];
        });
        if (rows.length === 0) return 0;
        const ids = rows.map(({ row }) => row.id);
        const segments = this.store.collection('conversationSegments');
        const tooMany = 'Aged messages have more dependents than one retention transaction removes';
        const [starts, ends] = await Promise.all([
          bounded(tx, segments.where('startMessageId', 'in', ids), tooMany),
          bounded(tx, segments.where('endMessageId', 'in', ids), tooMany),
        ]);
        const anchored = new Set([
          ...starts.map((doc) => doc.get('startMessageId')),
          ...ends.map((doc) => doc.get('endMessageId')),
        ]);
        const doomed = rows.filter(({ row }) => !anchored.has(row.id));
        if (doomed.length === 0) return 0;
        const doomedIds = doomed.map(({ row }) => row.id);
        const channelRefs = doomed.flatMap(({ row }) =>
          row.channelMessageId ? [this.store.doc('messageChannelIds', row.channelMessageId)] : [],
        );
        // PostgreSQL's foreign keys null generated-card and commitment
        // provenance and delete recall feedback with the message.
        const [cards, commitments, feedback, channels] = await Promise.all([
          bounded(
            tx,
            this.store.collection('generatedCards').where('messageId', 'in', doomedIds),
            tooMany,
          ),
          bounded(
            tx,
            this.store.collection('commitments').where('sourceMessageId', 'in', doomedIds),
            tooMany,
          ),
          bounded(
            tx,
            this.store.collection('recallFeedback').where('messageId', 'in', doomedIds),
            tooMany,
          ),
          channelRefs.length ? tx.getAll(...channelRefs) : Promise.resolve([]),
        ]);
        const doomedSet = new Set(doomedIds);
        for (const { ref } of doomed) tx.delete(ref);
        for (const card of cards) tx.update(card.ref, { messageId: null });
        for (const commitment of commitments) tx.update(commitment.ref, { sourceMessageId: null });
        for (const row of feedback) tx.delete(row.ref);
        for (const channel of channels)
          if (channel.exists && doomedSet.has(channel.get('messageId'))) tx.delete(channel.ref);
        return doomed.length;
      });
    }
    return deleted;
  }

  /** Tool calls an approval or a retained cost event references stay. */
  private async purgeAgedToolCalls(cutoff: Date, limit: number, now: Date): Promise<number> {
    const page = await this.agedPage('toolCalls', TOOL_CALL_RETENTION_CURSOR, cutoff, limit, now);
    let deleted = 0;
    for (const chunk of chunks(page)) {
      deleted += await this.store.db.runTransaction(async (tx) => {
        const snapshots = await tx.getAll(...chunk.map((doc) => doc.ref));
        const rows = snapshots.flatMap((snapshot) => {
          if (!snapshot.exists) return [];
          const row = decodeRecord<Records['toolCalls']>(snapshot.data());
          return row.createdAt instanceof Date && row.createdAt <= cutoff
            ? [{ row, ref: snapshot.ref }]
            : [];
        });
        if (rows.length === 0) return 0;
        const ids = rows.map(({ row }) => row.id);
        const tooMany = 'Aged tool calls have more references than one retention transaction reads';
        const [approvals, costEvents] = await Promise.all([
          bounded(tx, this.store.collection('approvals').where('toolCallId', 'in', ids), tooMany),
          bounded(tx, this.store.collection('costEvents').where('toolCallId', 'in', ids), tooMany),
        ]);
        const referenced = new Set([
          ...approvals.map((doc) => doc.get('toolCallId')),
          ...costEvents.map((doc) => doc.get('toolCallId')),
        ]);
        const purgeableTasks = new Map<string, boolean>();
        const checkpointReferences = new Map<string, Set<string>>();
        for (const taskId of new Set(rows.map(({ row }) => row.taskId))) {
          const pending = [taskId];
          const visited = new Set<string>();
          const unresolved = new Set<string>();
          let purgeable = true;
          while (pending.length && purgeable) {
            const id = pending.pop();
            if (!id || visited.has(id)) continue;
            visited.add(id);
            // Bounded scans fail closed; a huge continuation tree retains its
            // receipts instead of silently truncating the dependency graph.
            if (visited.size > CASCADE_LIMIT) {
              purgeable = false;
              break;
            }
            const task = await tx.get(this.store.doc('tasks', id));
            const updatedAt = task.get('updatedAt');
            const taskRow = task.exists ? decodeRecord<Records['tasks']>(task.data()) : null;
            if (
              !task.exists ||
              !taskRow ||
              taskRow.id !== id ||
              documentKey(taskRow.id) !== task.id ||
              taskRow.agentId !== this.agentId ||
              task.get('agentId') !== this.agentId ||
              !['done', 'failed', 'cancelled'].includes(task.get('status')) ||
              !(updatedAt instanceof Timestamp) ||
              updatedAt.toDate() > cutoff
            ) {
              purgeable = false;
              break;
            }
            const refs = unresolvedCheckpointToolCalls(taskRow.state);
            if (!refs) {
              purgeable = false;
              break;
            }
            for (const ref of refs) unresolved.add(ref);
            const children = await tx.get(
              this.store
                .collection('tasks')
                .where('parentTaskId', '==', id)
                .limit(CASCADE_LIMIT + 1),
            );
            if (children.size > CASCADE_LIMIT) {
              purgeable = false;
              break;
            }
            for (const child of children.docs) {
              const childRow = decodeRecord<Records['tasks']>(child.data());
              if (
                !childRow?.id ||
                documentKey(childRow.id) !== child.id ||
                childRow.agentId !== this.agentId ||
                childRow.parentTaskId !== id
              ) {
                purgeable = false;
                break;
              }
              pending.push(childRow.id);
            }
          }
          purgeableTasks.set(taskId, purgeable);
          checkpointReferences.set(taskId, unresolved);
        }
        const doomed = rows.filter(
          ({ row }) =>
            ['succeeded', 'failed', 'denied'].includes(row.status) &&
            !referenced.has(row.id) &&
            !checkpointReferences.get(row.taskId)?.has(row.id) &&
            purgeableTasks.get(row.taskId),
        );
        const keyRefs = doomed.flatMap(({ row }) =>
          row.idempotencyKey ? [this.store.doc('toolCallIdempotency', row.idempotencyKey)] : [],
        );
        const keys = keyRefs.length ? await tx.getAll(...keyRefs) : [];
        const plans = doomed.map(({ row, ref }) => {
          const receipt = compactToolCallReceipt(row, {
            agentId: this.agentId,
            recordedAt: this.store.now(),
          });
          return receipt
            ? { row, ref, receipt, receiptKeys: toolCallReceiptKeysForReceipt(receipt) }
            : null;
        });
        if (plans.some((plan) => !plan)) return 0;
        const validPlans = plans.filter((plan): plan is NonNullable<typeof plan> => plan !== null);
        const receiptRefs = validPlans.map(({ receipt }) =>
          this.store.doc('toolCallReceipts', receipt.id),
        );
        const replayKeyRefs = validPlans.flatMap(({ receiptKeys }) =>
          receiptKeys.map((key) => this.store.doc('toolCallReceiptKeys', key.id)),
        );
        const existingReceipts = receiptRefs.length ? await tx.getAll(...receiptRefs) : [];
        const existingReplayKeys = replayKeyRefs.length ? await tx.getAll(...replayKeyRefs) : [];
        const doomedSet = new Set(validPlans.map(({ row }) => row.id));
        const validExistingReceipts = new Map<string, Records['toolCallReceipts']>();
        const receiptSnapshotsById = new Map(
          existingReceipts.map((snapshot) => [snapshot.id, snapshot]),
        );
        for (const plan of validPlans) {
          const snapshot = receiptSnapshotsById.get(documentKey(plan.receipt.id));
          if (!snapshot?.exists) continue;
          const existing = decodeRecord<Records['toolCallReceipts']>(snapshot.data());
          if (
            !existing ||
            existing.id !== plan.receipt.id ||
            existing.agentId !== plan.receipt.agentId ||
            existing.taskId !== plan.receipt.taskId ||
            existing.toolCallId !== plan.receipt.toolCallId ||
            existing.modelToolCallIdHash !== plan.receipt.modelToolCallIdHash ||
            existing.idempotencyKeyHash !== plan.receipt.idempotencyKeyHash ||
            existing.toolName !== plan.receipt.toolName ||
            existing.effectOutcome !== plan.receipt.effectOutcome
          )
            return 0;
          validExistingReceipts.set(existing.id, existing);
        }
        const replayKeySnapshotsById = new Map(
          existingReplayKeys.map((snapshot) => [snapshot.id, snapshot]),
        );
        for (const plan of validPlans) {
          for (const expected of plan.receiptKeys) {
            const snapshot = replayKeySnapshotsById.get(documentKey(expected.id));
            if (!snapshot?.exists) continue;
            const existing = decodeRecord<Records['toolCallReceiptKeys']>(snapshot.data());
            if (
              !existing ||
              existing.id !== expected.id ||
              existing.agentId !== expected.agentId ||
              existing.taskId !== expected.taskId ||
              existing.receiptId !== expected.receiptId ||
              existing.kind !== expected.kind ||
              existing.digest !== expected.digest
            )
              return 0;
          }
        }
        // All reads, ownership checks, and conflict checks complete before the first write.
        for (const plan of validPlans) {
          if (!validExistingReceipts.has(plan.receipt.id))
            tx.create(
              this.store.doc('toolCallReceipts', plan.receipt.id),
              encodeRecord(plan.receipt),
            );
          for (const key of plan.receiptKeys) {
            const keySnapshot = replayKeySnapshotsById.get(documentKey(key.id));
            if (!keySnapshot?.exists)
              tx.create(this.store.doc('toolCallReceiptKeys', key.id), encodeRecord(key));
          }
        }
        for (const { ref } of validPlans) tx.delete(ref);
        // Preserve global idempotency exclusion via the digest projection after raw-row deletion.
        for (const key of keys)
          if (key.exists && doomedSet.has(key.get('toolCallId'))) tx.delete(key.ref);
        return validPlans.length;
      });
    }
    return deleted;
  }

  /** Captured prompts cascade with their model call, as in PostgreSQL. */
  private async purgeAgedModelCalls(cutoff: Date, limit: number): Promise<number> {
    const due = await this.store
      .collection('modelCalls')
      .where('createdAt', '<=', cutoff)
      .limit(limit)
      .get();
    let deleted = 0;
    for (const chunk of chunks(due.docs)) {
      deleted += await this.store.db.runTransaction(async (tx) => {
        const snapshots = await tx.getAll(...chunk.map((doc) => doc.ref));
        const live = snapshots.filter((snapshot) => {
          if (!snapshot.exists) return false;
          const createdAt = decodeRecord<Records['modelCalls']>(snapshot.data()).createdAt;
          return createdAt instanceof Date && createdAt <= cutoff;
        });
        if (live.length === 0) return 0;
        const audit = await bounded(
          tx,
          this.store.collection('modelCallAudit').where(
            'modelCallId',
            'in',
            live.map((snapshot) => snapshot.get('id')),
          ),
          'Aged model calls have more captured prompts than one retention transaction removes',
        );
        for (const snapshot of live) tx.delete(snapshot.ref);
        for (const row of audit) tx.delete(row.ref);
        return live.length;
      });
    }
    return deleted;
  }
}
