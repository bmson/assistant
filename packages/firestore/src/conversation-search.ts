import {
  type ConversationSearchMatch,
  type ConversationSearchRepository,
  conversationMessageSourceRevision,
  type EmbeddingSpace,
  historyLimit,
  type Records,
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
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const TEXT_PAGE_SIZE = 500;
/** The substring fallback reads newest messages first and fails rather than search a partial history. */
const TEXT_SCAN_LIMIT = 5000;

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
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.messageId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          ref.conversationId,
        ) ||
        !/^[a-f0-9]{64}$/.test(ref.sourceRevision)
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
        row?.conversationId === ref.conversationId && row.sourceRevision === ref.sourceRevision
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
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.messageId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          ref.conversationId,
        ) ||
        !/^[a-f0-9]{64}$/.test(ref.sourceRevision)
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
        row.sourceRevision === ref.sourceRevision
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
    const candidateLimit = Math.min(200, input.limit * 4);
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
    return rows.slice(0, input.limit);
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
