import {
  type ConversationSearchMatch,
  type ConversationSearchRepository,
  conversationMessageSourceRevision,
  conversationMessageSpeakerRevision,
  conversationSearchCandidateLimit,
  type EmbeddingSpace,
  historyLimit,
  type Records,
  selectConversationSearchMatches,
  snapshotEmbeddingSpace,
  validateEmbedding,
  validateSkillEmbeddingSpace,
} from '@assistant/persistence';
import {
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
  Timestamp,
} from '@google-cloud/firestore';
import { embeddingSpaceKey } from './memory.js';
import {
  assertPrivacyErasureFenceUnchanged,
  privacyErasureGeneration,
  readPrivacyErasureFence,
} from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const TEXT_PAGE_SIZE = 500;
/** The substring fallback reads newest messages first and fails rather than search a partial history. */
const TEXT_SCAN_LIMIT = 5000;
const CONTEXT_PAGE_SIZE = 5;
const CONTEXT_SCAN_LIMIT = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVISION = /^[a-f0-9]{64}$/;
type ConversationContext = NonNullable<ConversationSearchRepository['context']>;

/** Shared source-ID shape check for bounded context and resumable search refs. */
export function validConversationSearchUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function transactionFence(snapshot: DocumentSnapshot, agentId: string): Timestamp | null {
  if (!snapshot.exists) return null;
  privacyErasureGeneration(snapshot, agentId);
  if (!snapshot.updateTime) throw new Error('Privacy erasure fence is malformed');
  return snapshot.updateTime;
}

function sameFence(left: Timestamp | null, right: Timestamp | null): boolean {
  return left === null ? right === null : right !== null && left.isEqual(right);
}

function compareStoredTime(left: Timestamp | Date, right: Timestamp | Date): number {
  const leftTimestamp = left instanceof Timestamp ? left : Timestamp.fromDate(left);
  const rightTimestamp = right instanceof Timestamp ? right : Timestamp.fromDate(right);
  return (
    leftTimestamp.seconds - rightTimestamp.seconds ||
    leftTimestamp.nanoseconds - rightTimestamp.nanoseconds
  );
}

function match(doc: DocumentSnapshot): ConversationSearchMatch | null {
  if (!doc.exists) return null;
  const data = doc.data();
  if (!data) return null;
  const row = decodeRecord<Records['messages']>(data);
  if (
    typeof row.id !== 'string' ||
    documentKey(row.id) !== doc.id ||
    typeof row.conversationId !== 'string' ||
    (row.hiddenAt !== null && row.hiddenAt !== undefined) ||
    (typeof row.channelMessageId === 'string' &&
      (row.channelMessageId.startsWith('visual-qa:') ||
        row.channelMessageId.startsWith('readability-'))) ||
    typeof row.text !== 'string' ||
    !(row.createdAt instanceof Date)
  )
    return null;
  return {
    messageId: row.id,
    sourceRevision: conversationMessageSourceRevision(row.id, row.text),
    conversationId: row.conversationId,
    text: row.text,
    role: typeof row.role === 'string' ? row.role : 'unknown',
    origin: typeof row.origin === 'string' ? row.origin : 'unknown',
    speakerRevision: conversationMessageSpeakerRevision(
      row.id,
      row.text,
      typeof row.role === 'string' ? row.role : 'unknown',
      typeof row.origin === 'string' ? row.origin : 'unknown',
    ),
    createdAt: row.createdAt,
  };
}

function atOrAfterCutoff(doc: DocumentSnapshot, cutoff: Timestamp | null): boolean {
  if (!cutoff) return true;
  const createdAt = doc.get('createdAt');
  if (createdAt instanceof Timestamp)
    return (
      createdAt.seconds > cutoff.seconds ||
      (createdAt.seconds === cutoff.seconds && createdAt.nanoseconds > cutoff.nanoseconds)
    );
  if (createdAt instanceof Date) return createdAt.getTime() > cutoff.toMillis();
  return false;
}

function eligibleAfterCutoff(
  doc: DocumentSnapshot,
  row: ConversationSearchMatch,
  cutoff: Timestamp | null,
  currentConversationId?: string,
): boolean {
  return row.conversationId === currentConversationId || atOrAfterCutoff(doc, cutoff);
}

/**
 * Message search for `conversations.search`. Messages carry no owner, so each
 * match is kept only when its conversation belongs to the requesting agent.
 * Like the SQL tool, every conversation of that owner is searchable; the tool
 * marks its results as untrusted content.
 */
export class FirestoreConversationSearchRepository implements ConversationSearchRepository {
  readonly space: EmbeddingSpace;

  constructor(
    readonly store: InstallationStore,
    space: EmbeddingSpace,
  ) {
    this.space = snapshotEmbeddingSpace(space);
    validateSkillEmbeddingSpace(this.space);
  }

  private async owned(agentId: string, conversationIds: string[]): Promise<Set<string>> {
    const unique = [...new Set(conversationIds)];
    const owned = new Set<string>();
    for (let offset = 0; offset < unique.length; offset += 200) {
      const ids = unique.slice(offset, offset + 200);
      const docs = await this.store.db.getAll(
        ...ids.map((id) => this.store.doc('conversations', id)),
      );
      docs.forEach((doc, index) => {
        const id = ids[index];
        if (
          id &&
          doc.exists &&
          doc.get('id') === id &&
          documentKey(id) === doc.id &&
          doc.get('agentId') === agentId
        )
          owned.add(id);
      });
    }
    return owned;
  }

  private async textAtFence(input: {
    agentId: string;
    query: string;
    limit: number;
    currentConversationId?: string;
    fence: Timestamp | null;
  }): Promise<ConversationSearchMatch[]> {
    const needle = input.query.toLocaleLowerCase();
    const matches: ConversationSearchMatch[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    for (let scanned = 0; scanned < TEXT_SCAN_LIMIT; ) {
      let query = this.store
        .collection('messages')
        .orderBy('createdAt', 'desc')
        .limit(TEXT_PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      scanned += page.size;
      const found = page.docs.flatMap((doc) => {
        const row = match(doc);
        return row?.text.toLocaleLowerCase().includes(needle) &&
          eligibleAfterCutoff(doc, row, input.fence, input.currentConversationId)
          ? [row]
          : [];
      });
      const owned = await this.owned(
        input.agentId,
        found.map((row) => row.conversationId),
      );
      for (const row of found) {
        if (owned.has(row.conversationId)) matches.push(row);
        if (matches.length === input.limit) return matches;
      }
      if (page.size < TEXT_PAGE_SIZE) return matches;
      cursor = page.docs.at(-1);
    }
    throw new Error('Conversation text search scan bound reached');
  }

  async context(input: Parameters<ConversationContext>[0]): ReturnType<ConversationContext> {
    const { anchors } = input;
    if (!Array.isArray(anchors) || anchors.length < 1 || anchors.length > 2)
      throw new Error('Conversation context requires one or two anchors');
    const ids = anchors.map((anchor) => anchor.messageId);
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate conversation context anchor');
    for (const anchor of anchors) {
      if (
        !validConversationSearchUuid(anchor.messageId) ||
        !validConversationSearchUuid(anchor.conversationId) ||
        !REVISION.test(anchor.sourceRevision) ||
        typeof anchor.speakerRevision !== 'string' ||
        !REVISION.test(anchor.speakerRevision)
      )
        throw new Error('Invalid conversation context anchor identity');
    }

    const fence = await readPrivacyErasureFence(this.store, input.agentId);
    const result = await this.store.db.runTransaction(
      async (transaction) => {
        const txFence = transactionFence(
          await transaction.get(this.store.doc('privacyErasureJobs', input.agentId)),
          input.agentId,
        );
        if (!sameFence(fence, txFence))
          throw new Error('Privacy erasure changed during conversation context read');
        const anchorDocs = await transaction.getAll(
          ...ids.map((id) => this.store.doc('messages', id)),
        );
        const candidateRows = anchorDocs.flatMap((doc) => {
          const row = doc.exists ? match(doc) : null;
          return row && eligibleAfterCutoff(doc, row, fence, input.currentConversationId)
            ? [row]
            : [];
        });
        const conversationIds = [...new Set(candidateRows.map((row) => row.conversationId))];
        const ownerDocs = conversationIds.length
          ? await transaction.getAll(
              ...conversationIds.map((id) => this.store.doc('conversations', id)),
            )
          : [];
        const owned = new Set<string>();
        ownerDocs.forEach((doc, index) => {
          const conversationId = conversationIds[index];
          if (
            conversationId &&
            doc.exists &&
            doc.get('id') === conversationId &&
            documentKey(conversationId) === doc.id &&
            doc.get('agentId') === input.agentId
          )
            owned.add(conversationId);
        });
        const rowsById = new Map(
          candidateRows
            .filter((row) => owned.has(row.conversationId))
            .map((row) => [row.messageId, row]),
        );
        const verifiedAnchors = anchors.map((ref) => {
          const row = rowsById.get(ref.messageId);
          if (
            !row ||
            row.conversationId !== ref.conversationId ||
            row.sourceRevision !== ref.sourceRevision ||
            row.speakerRevision !== ref.speakerRevision
          )
            throw new Error('Conversation context anchor is stale or unavailable');
          return row;
        });
        const anchorDocsById = new Map(
          anchorDocs.filter((doc) => doc.exists).map((doc) => [doc.get('id') as string, doc]),
        );
        const selected = new Map(
          verifiedAnchors.map((row) => {
            const doc = anchorDocsById.get(row.messageId);
            const storedTime = doc?.get('createdAt');
            if (!(storedTime instanceof Timestamp) && !(storedTime instanceof Date))
              throw new Error('Conversation context anchor timestamp is unavailable');
            return [row.messageId, { row, storedTime }] as const;
          }),
        );
        for (const anchor of verifiedAnchors) {
          const anchorDoc = anchorDocsById.get(anchor.messageId);
          if (!anchorDoc) throw new Error('Conversation context anchor is stale or unavailable');
          for (const direction of ['previous', 'following'] as const) {
            const needed = direction === 'previous' ? 3 : 1;
            const found: Array<{ row: ConversationSearchMatch; storedTime: Timestamp | Date }> = [];
            let scanned = 0;
            let cursor: QueryDocumentSnapshot | undefined;
            while (found.length < needed && scanned < CONTEXT_SCAN_LIMIT) {
              let query = this.store
                .collection('messages')
                .where('conversationId', '==', anchor.conversationId)
                .where('role', 'in', ['user', 'assistant'])
                .orderBy('createdAt', direction === 'previous' ? 'desc' : 'asc')
                .orderBy('id', direction === 'previous' ? 'desc' : 'asc');
              if (cursor) query = query.startAfter(cursor);
              else query = query.startAfter(anchorDoc);
              const pageLimit = Math.min(CONTEXT_PAGE_SIZE, CONTEXT_SCAN_LIMIT - scanned);
              const page = await transaction.get(query.limit(pageLimit));
              scanned += page.size;
              for (const doc of page.docs) {
                const row = match(doc);
                const storedTime = doc.get('createdAt');
                if (
                  row &&
                  storedTime instanceof Timestamp &&
                  row.messageId !== anchor.messageId &&
                  eligibleAfterCutoff(doc, row, fence, input.currentConversationId)
                )
                  found.push({ row, storedTime });
                else if (
                  row &&
                  storedTime instanceof Date &&
                  row.messageId !== anchor.messageId &&
                  eligibleAfterCutoff(doc, row, fence, input.currentConversationId)
                )
                  found.push({ row, storedTime });
                if (found.length === needed) break;
              }
              cursor = page.docs.at(-1);
              if (page.size < pageLimit) break;
            }
            if (found.length < needed && scanned === CONTEXT_SCAN_LIMIT)
              throw new Error('Conversation context bounded lookup unavailable');
            for (const item of found)
              if (!selected.has(item.row.messageId)) selected.set(item.row.messageId, item);
          }
        }
        const verifiedFence = transactionFence(
          await transaction.get(this.store.doc('privacyErasureJobs', input.agentId)),
          input.agentId,
        );
        if (!sameFence(txFence, verifiedFence))
          throw new Error('Privacy erasure changed during conversation context read');
        const matches = [...selected.values()]
          .sort(
            (left, right) =>
              compareStoredTime(left.storedTime, right.storedTime) ||
              (left.row.messageId < right.row.messageId
                ? -1
                : left.row.messageId > right.row.messageId
                  ? 1
                  : 0),
          )
          .map(({ row }) => row);
        if (matches.length > 10) throw new Error('Conversation context exceeded its row bound');
        return {
          matches,
          observationGeneration: fence ? `${fence.seconds}:${fence.nanoseconds}` : null,
        };
      },
      { readOnly: true },
    );
    await assertPrivacyErasureFenceUnchanged(this.store, input.agentId, fence);
    return result;
  }

  async validateSources(input: {
    agentId: string;
    currentConversationId?: string;
    sourceRefs: Parameters<ConversationSearchRepository['refreshForResume']>[0]['sourceRefs'];
  }): Promise<{ unchangedSourceRefs: boolean[]; observationGeneration: string | null }> {
    if (input.sourceRefs.length > 20) throw new Error('Too many conversation sources');
    const ids = input.sourceRefs.map((ref) => ref.messageId);
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate conversation source');
    for (const ref of input.sourceRefs) {
      if (
        !validConversationSearchUuid(ref.messageId) ||
        !validConversationSearchUuid(ref.conversationId) ||
        !/^[a-f0-9]{64}$/.test(ref.sourceRevision) ||
        (ref.speakerRevision !== undefined && !/^[a-f0-9]{64}$/.test(ref.speakerRevision))
      )
        throw new Error('Invalid conversation source identity');
    }
    const fence = await readPrivacyErasureFence(this.store, input.agentId);
    const docs = ids.length
      ? await this.store.db.getAll(...ids.map((id) => this.store.doc('messages', id)))
      : [];
    const eligible = docs.flatMap((doc) => {
      const row = doc.exists ? match(doc) : null;
      return row && eligibleAfterCutoff(doc, row, fence, input.currentConversationId) ? [row] : [];
    });
    const owned = await this.owned(
      input.agentId,
      eligible.map((row) => row.conversationId),
    );
    const byId = new Map(
      eligible.filter((row) => owned.has(row.conversationId)).map((row) => [row.messageId, row]),
    );
    const unchangedSourceRefs = input.sourceRefs.map((ref) => {
      const row = byId.get(ref.messageId);
      return (
        row?.conversationId === ref.conversationId &&
        row.sourceRevision === ref.sourceRevision &&
        (ref.speakerRevision === undefined || row.speakerRevision === ref.speakerRevision)
      );
    });
    await assertPrivacyErasureFenceUnchanged(this.store, input.agentId, fence);
    return {
      unchangedSourceRefs,
      observationGeneration: fence ? `${fence.seconds}:${fence.nanoseconds}` : null,
    };
  }

  async refreshForResume(
    input: Parameters<ConversationSearchRepository['refreshForResume']>[0],
  ): ReturnType<ConversationSearchRepository['refreshForResume']> {
    historyLimit(input.limit);
    if (typeof input.query !== 'string' || input.query.length < 2 || input.query.length > 500)
      throw new Error('Invalid resumed conversation search query');
    if (input.sourceRefs.length > 20) throw new Error('Too many resumed conversation sources');
    const ids = input.sourceRefs.map((ref) => ref.messageId);
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate resumed conversation source');
    for (const ref of input.sourceRefs) {
      if (
        !validConversationSearchUuid(ref.messageId) ||
        !validConversationSearchUuid(ref.conversationId) ||
        !/^[a-f0-9]{64}$/.test(ref.sourceRevision) ||
        (ref.speakerRevision !== undefined && !/^[a-f0-9]{64}$/.test(ref.speakerRevision))
      )
        throw new Error('Invalid resumed conversation source identity');
    }
    const fence = await readPrivacyErasureFence(this.store, input.agentId);
    const docs = ids.length
      ? await this.store.db.getAll(...ids.map((id) => this.store.doc('messages', id)))
      : [];
    const currentRows = docs.flatMap((doc) => {
      const row = doc.exists ? match(doc) : null;
      return row && eligibleAfterCutoff(doc, row, fence, input.currentConversationId) ? [row] : [];
    });
    const owned = await this.owned(
      input.agentId,
      currentRows.map((row) => row.conversationId),
    );
    const currentById = new Map(
      currentRows.filter((row) => owned.has(row.conversationId)).map((row) => [row.messageId, row]),
    );
    const unchangedSourceRefs = input.sourceRefs.map((ref) => {
      const row = currentById.get(ref.messageId);
      return (
        row !== undefined &&
        row.conversationId === ref.conversationId &&
        row.sourceRevision === ref.sourceRevision &&
        (ref.speakerRevision === undefined || row.speakerRevision === ref.speakerRevision)
      );
    });
    const matches = await this.textAtFence({
      agentId: input.agentId,
      query: input.query,
      limit: input.limit,
      ...(input.currentConversationId
        ? { currentConversationId: input.currentConversationId }
        : {}),
      fence,
    });
    await assertPrivacyErasureFenceUnchanged(this.store, input.agentId, fence);
    return {
      unchangedSourceRefs,
      matches,
      mode: 'text',
      observationGeneration: fence ? `${fence.seconds}:${fence.nanoseconds}` : null,
    };
  }

  async semantic(
    input: Parameters<ConversationSearchRepository['semantic']>[0],
  ): Promise<Array<ConversationSearchMatch & { similarity: number }>> {
    historyLimit(input.limit);
    if (input.embeddingSpaceKey !== embeddingSpaceKey(this.space))
      throw new Error('Conversation search embedding space changed');
    validateEmbedding(this.space, input.embedding);
    const fence = await readPrivacyErasureFence(this.store, input.agentId);
    // Firestore nearest-neighbor search is installation-wide. Read at most 200
    // raw hits to reduce foreign-conversation crowd-out within the finite window.
    // The owner/erasure filters still run before the 80-row selection window.
    const candidateLimit = Math.min(200, conversationSearchCandidateLimit(input.limit) * 4);
    const result = await this.store
      .collection('messages')
      .where('embeddingSpace', '==', embeddingSpaceKey(this.space))
      .findNearest({
        vectorField: 'embedding',
        queryVector: input.embedding,
        distanceMeasure: 'COSINE',
        limit: candidateLimit,
        distanceResultField: 'vectorDistance',
      })
      .get();
    const candidates = result.docs.flatMap((doc) => {
      const row = match(doc);
      const similarity = 1 - Number(doc.get('vectorDistance'));
      return row &&
        Number.isFinite(similarity) &&
        eligibleAfterCutoff(doc, row, fence, input.currentConversationId)
        ? [{ ...row, similarity }]
        : [];
    });
    const owned = await this.owned(
      input.agentId,
      candidates.map((row) => row.conversationId),
    );
    const rows = candidates.filter((row) => owned.has(row.conversationId));
    if (rows.length < input.limit && result.size === candidateLimit)
      throw new Error('Conversation search candidate bound reached');
    await assertPrivacyErasureFenceUnchanged(this.store, input.agentId, fence);
    return selectConversationSearchMatches(
      rows.slice(0, conversationSearchCandidateLimit(input.limit)),
      input.limit,
    );
  }

  async text(
    input: Parameters<ConversationSearchRepository['text']>[0],
  ): Promise<ConversationSearchMatch[]> {
    historyLimit(input.limit);
    const fence = await readPrivacyErasureFence(this.store, input.agentId);
    const matches = await this.textAtFence({ ...input, fence });
    await assertPrivacyErasureFenceUnchanged(this.store, input.agentId, fence);
    return matches;
  }
}
