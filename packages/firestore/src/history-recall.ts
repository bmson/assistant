import {
  type EmbeddingSpace,
  type HistoryMessage,
  type HistoryRecallRepository,
  type HistorySearch,
  type HistorySegment,
  historyLimit,
  type Records,
  snapshotEmbeddingSpace,
  validateEmbedding,
  validateSkillEmbeddingSpace,
} from '@assistant/persistence';
import type { DocumentSnapshot, QueryDocumentSnapshot } from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import { embeddingSpaceKey } from './memory.js';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

function trusted(snapshot: DocumentSnapshot, agentId: string): boolean {
  return (
    snapshot.exists &&
    snapshot.get('agentId') === agentId &&
    ['owner', 'assistant'].includes(snapshot.get('trust')) &&
    typeof snapshot.get('id') === 'string' &&
    documentKey(snapshot.get('id')) === snapshot.id
  );
}

const SEGMENT_SOURCE_SCAN_LIMIT = 5_000;

function fixtureNamespace(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (value.startsWith('visual-qa:') || value.startsWith('readability-'))
  );
}

function timestampWithin(value: unknown, start: Date, end: Date): boolean {
  const date = value instanceof Date ? value : value instanceof Timestamp ? value.toDate() : null;
  return date !== null && date >= start && date <= end;
}

function message(snapshot: DocumentSnapshot): HistoryMessage | null {
  if (!snapshot.exists) return null;
  const row = decodeRecord<Records['messages']>(snapshot.data());
  if (
    typeof row.id !== 'string' ||
    documentKey(row.id) !== snapshot.id ||
    typeof row.conversationId !== 'string' ||
    (typeof row.channelMessageId === 'string' &&
      (row.channelMessageId.startsWith('visual-qa:') ||
        row.channelMessageId.startsWith('readability-'))) ||
    !['user', 'assistant'].includes(row.role) ||
    typeof row.text !== 'string' ||
    (row.hiddenAt !== null && row.hiddenAt !== undefined) ||
    !(row.createdAt instanceof Date)
  )
    return null;
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    text: row.text,
    createdAt: row.createdAt,
  };
}

/** Native vector retrieval with a consistent owner/trust recheck before prompt exposure. */
export class FirestoreHistoryRecallRepository implements HistoryRecallRepository {
  readonly kind = 'history-recall-repository' as const;
  readonly space: EmbeddingSpace;
  constructor(
    readonly store: InstallationStore,
    space: EmbeddingSpace,
  ) {
    this.space = snapshotEmbeddingSpace(space);
    validateSkillEmbeddingSpace(this.space);
  }

  private async candidates(collection: 'messages' | 'conversationSegments', input: HistorySearch) {
    historyLimit(input.limit);
    validateEmbedding(this.space, input.embedding);
    if (input.embeddingSpaceKey !== embeddingSpaceKey(this.space))
      throw new Error('History query embedding space does not match the configured space');
    const candidateLimit = Math.min(200, input.limit * 4);
    const fence = await readPrivacyErasureFence(this.store, input.agentId);
    const nearest = async (options: {
      currentConversationOnly?: boolean;
      afterFence?: boolean;
    }) => {
      let query = this.store
        .collection(collection)
        .where('embeddingSpace', '==', embeddingSpaceKey(this.space));
      if (collection === 'conversationSegments')
        query = query.where('agentId', '==', input.agentId);
      if (options.currentConversationOnly) {
        query = query.where('conversationId', '==', input.exclude.conversationId);
        query = query.where(
          collection === 'messages' ? 'createdAt' : 'endedAt',
          '<',
          input.exclude.sinceCreatedAt,
        );
      }
      if (options.afterFence && fence)
        query = query.where(collection === 'messages' ? 'createdAt' : 'startedAt', '>', fence);
      return query
        .findNearest({
          vectorField: 'embedding',
          queryVector: input.embedding,
          distanceMeasure: 'COSINE',
          limit: candidateLimit,
          distanceResultField: 'vectorDistance',
        })
        .get();
    };
    const results = fence
      ? await Promise.all([
          nearest({ afterFence: true }),
          nearest({ currentConversationOnly: true }),
        ])
      : [await nearest({})];
    const docsById = new Map(results.flatMap((result) => result.docs).map((doc) => [doc.id, doc]));
    const docs = [...docsById.values()].sort(
      (left, right) =>
        Number(left.get('vectorDistance')) - Number(right.get('vectorDistance')) ||
        left.id.localeCompare(right.id),
    );
    const full = results.some((result) => result.size === candidateLimit);
    await assertPrivacyErasureFenceUnchanged(this.store, input.agentId, fence);
    return { docs, full, fence };
  }

  private unchanged(snapshot: DocumentSnapshot, candidate: QueryDocumentSnapshot): boolean {
    return Boolean(
      snapshot.exists &&
        snapshot.updateTime &&
        candidate.updateTime &&
        snapshot.updateTime.isEqual(candidate.updateTime) &&
        snapshot.get('embeddingSpace') === embeddingSpaceKey(this.space),
    );
  }

  async segments(input: HistorySearch): Promise<HistorySegment[]> {
    const candidates = await this.candidates('conversationSegments', input);
    if (candidates.docs.length === 0) return [];
    const result = await this.store.db.runTransaction(
      async (tx) => {
        const snapshots = await tx.getAll(...candidates.docs.map((doc) => doc.ref));
        const valid = snapshots.flatMap((snapshot, i) => {
          const candidate = candidates.docs[i];
          if (!candidate || !this.unchanged(snapshot, candidate)) return [];
          const row = decodeRecord<Records['conversationSegments']>(snapshot.data());
          const similarity = 1 - Number(candidate.get('vectorDistance'));
          if (
            typeof row.id !== 'string' ||
            documentKey(row.id) !== snapshot.id ||
            row.agentId !== input.agentId ||
            typeof row.conversationId !== 'string' ||
            typeof row.startMessageId !== 'string' ||
            typeof row.endMessageId !== 'string' ||
            !row.summary ||
            !(row.startedAt instanceof Date) ||
            !(row.endedAt instanceof Date) ||
            !Number.isFinite(similarity) ||
            (row.conversationId === input.exclude.conversationId &&
              row.endedAt >= input.exclude.sinceCreatedAt)
          )
            return [];
          return [{ row, similarity }];
        });
        if (valid.length === 0) {
          if (candidates.full) throw new Error('History segment candidate bound reached');
          return [];
        }
        const rangesByConversation = new Map<string, typeof valid>();
        for (const candidate of valid) {
          const group = rangesByConversation.get(candidate.row.conversationId) ?? [];
          group.push(candidate);
          rangesByConversation.set(candidate.row.conversationId, group);
        }
        const contaminated = new Set<string>();
        for (const [conversationId, group] of rangesByConversation) {
          const starts = group.map(({ row }) => row.startedAt.getTime());
          const ends = group.map(({ row }) => row.endedAt.getTime());
          const lower = new Date(Math.min(...starts));
          const upper = new Date(Math.max(...ends));
          const range = this.store
            .collection('messages')
            .where('conversationId', '==', conversationId)
            .where('createdAt', '>=', lower)
            .where('createdAt', '<=', upper)
            .orderBy('createdAt', 'desc')
            .orderBy('id', 'desc')
            .limit(SEGMENT_SOURCE_SCAN_LIMIT + 1);
          const sourceRows = await tx.get(range);
          if (sourceRows.size > SEGMENT_SOURCE_SCAN_LIMIT)
            throw new Error('History segment source validation bound reached');
          for (const source of sourceRows.docs) {
            const createdAt = source.get('createdAt');
            if (!fixtureNamespace(source.get('channelMessageId'))) continue;
            for (const { row } of group) {
              if (timestampWithin(createdAt, row.startedAt, row.endedAt)) contaminated.add(row.id);
            }
          }
        }
        const eligible = valid.filter(({ row }) => !contaminated.has(row.id));
        if (eligible.length === 0) {
          if (candidates.full) throw new Error('History segment candidate bound reached');
          return [];
        }
        const sources = await tx.getAll(
          ...eligible.flatMap(({ row }) => [
            this.store.doc('conversations', row.conversationId),
            this.store.doc('messages', row.startMessageId),
            this.store.doc('messages', row.endMessageId),
          ]),
        );
        const result = eligible.flatMap(({ row, similarity }, i) => {
          const conversation = sources[i * 3],
            key = sources[i * 3 + 1],
            end = sources[i * 3 + 2];
          if (!conversation || !trusted(conversation, input.agentId)) return [];
          if (
            !key ||
            !end ||
            message(key)?.id !== row.startMessageId ||
            message(end)?.id !== row.endMessageId
          )
            return [];
          if (
            candidates.fence &&
            row.conversationId !== input.exclude.conversationId &&
            (!key || !afterFence(key.get('createdAt'), candidates.fence))
          )
            return [];
          const keyMessage = key ? message(key) : null;
          return [
            {
              conversationId: row.conversationId,
              summary: row.summary,
              startMessageId: row.startMessageId,
              startedAt: row.startedAt,
              endedAt: row.endedAt,
              similarity,
              ...(keyMessage?.conversationId === row.conversationId ? { keyMessage } : {}),
            },
          ];
        });
        if (result.length < input.limit && candidates.full)
          throw new Error('History segment candidate bound reached');
        return result.slice(0, input.limit);
      },
      { readOnly: true },
    );
    await assertPrivacyErasureFenceUnchanged(this.store, input.agentId, candidates.fence);
    return result;
  }

  async messages(input: HistorySearch): Promise<Array<HistoryMessage & { similarity: number }>> {
    const candidates = await this.candidates('messages', input);
    if (candidates.docs.length === 0) return [];
    const result = await this.store.db.runTransaction(
      async (tx) => {
        const snapshots = await tx.getAll(...candidates.docs.map((doc) => doc.ref));
        const valid = snapshots.flatMap((snapshot, i) => {
          const candidate = candidates.docs[i];
          if (!candidate || !this.unchanged(snapshot, candidate)) return [];
          const row = message(snapshot),
            similarity = 1 - Number(candidate.get('vectorDistance'));
          if (
            !row?.text ||
            !Number.isFinite(similarity) ||
            (row.conversationId === input.exclude.conversationId &&
              row.createdAt >= input.exclude.sinceCreatedAt)
          )
            return [];
          return [{ ...row, similarity }];
        });
        if (valid.length === 0) {
          if (candidates.full) throw new Error('History message candidate bound reached');
          return [];
        }
        const conversations = await tx.getAll(
          ...valid.map((row) => this.store.doc('conversations', row.conversationId)),
        );
        const result = valid.filter(
          (_, i) => conversations[i] && trusted(conversations[i], input.agentId),
        );
        if (result.length < input.limit && candidates.full)
          throw new Error('History message candidate bound reached');
        return result.slice(0, input.limit);
      },
      { readOnly: true },
    );
    await assertPrivacyErasureFenceUnchanged(this.store, input.agentId, candidates.fence);
    return result;
  }

  async neighborhood(
    input: Parameters<HistoryRecallRepository['neighborhood']>[0],
  ): Promise<HistoryMessage[]> {
    const { agentId, anchor, radius, exclude } = input;
    if (!Number.isInteger(radius) || radius < 0 || radius > 20)
      throw new Error('Invalid history neighborhood radius');
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const result = await this.store.db.runTransaction(
      async (tx) => {
        const [conversation, snapshot] = await tx.getAll(
          this.store.doc('conversations', anchor.conversationId),
          this.store.doc('messages', anchor.id),
        );
        if (!conversation || !trusted(conversation, agentId) || !snapshot) return [];
        const current = message(snapshot);
        if (
          !current ||
          current.conversationId !== anchor.conversationId ||
          (fence && !afterFence(snapshot.get('createdAt'), fence)) ||
          (current.conversationId === exclude.conversationId &&
            current.createdAt >= exclude.sinceCreatedAt)
        )
          return [];
        if (radius === 0) return [current];
        let base = this.store
          .collection('messages')
          .where('conversationId', '==', current.conversationId)
          .where('role', 'in', ['user', 'assistant']);
        if (current.conversationId === exclude.conversationId)
          base = base.where('createdAt', '<', exclude.sinceCreatedAt);
        if (fence && current.conversationId !== exclude.conversationId)
          base = base.where('createdAt', '>', fence);
        const [before, after] = await Promise.all([
          tx.get(
            base
              .where('createdAt', '<', current.createdAt)
              .orderBy('createdAt', 'desc')
              .orderBy('id', 'desc')
              .limit(radius),
          ),
          tx.get(
            base
              .where('createdAt', '>', current.createdAt)
              .orderBy('createdAt', 'asc')
              .orderBy('id', 'asc')
              .limit(radius),
          ),
        ]);
        const result = [...before.docs.reverse(), snapshot, ...after.docs].flatMap((doc) => {
          const row = message(doc);
          return row && row.conversationId === current.conversationId ? [row] : [];
        });
        return result;
      },
      { readOnly: true },
    );
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return result;
  }

  async recentWindowStart({
    agentId,
    conversationId,
    size,
  }: Parameters<HistoryRecallRepository['recentWindowStart']>[0]): Promise<Date | null> {
    historyLimit(size);
    return this.store.db.runTransaction(
      async (tx) => {
        const conversation = await tx.get(this.store.doc('conversations', conversationId));
        if (!trusted(conversation, agentId)) return null;
        const selected: HistoryMessage[] = [];
        let cursor: QueryDocumentSnapshot | undefined;
        let scanned = 0;
        let exhausted = false;
        while (selected.length < size && scanned < 5000) {
          const requested = Math.min(100, 5000 - scanned);
          let query = this.store
            .collection('messages')
            .where('conversationId', '==', conversationId)
            .where('role', 'in', ['user', 'assistant'])
            .orderBy('createdAt', 'desc')
            .orderBy('id', 'desc')
            .limit(requested);
          if (cursor) query = query.startAfter(cursor);
          const page = await tx.get(query);
          scanned += page.size;
          selected.push(
            ...page.docs.flatMap((doc) => {
              const row = message(doc);
              return row?.conversationId === conversationId ? [row] : [];
            }),
          );
          if (selected.length >= size) break;
          if (page.size < requested) {
            exhausted = true;
            break;
          }
          cursor = page.docs.at(-1);
        }
        if (selected.length < size && !exhausted && scanned >= 5000)
          throw new Error('History window fixture-exclusion scan bound reached');
        return selected[size - 1]?.createdAt ?? null;
      },
      { readOnly: true },
    );
  }
}

function afterFence(value: unknown, fence: Timestamp): boolean {
  if (!value || typeof value !== 'object') return false;
  const timestamp = value as { seconds?: unknown; nanoseconds?: unknown };
  if (
    !Number.isSafeInteger(timestamp.seconds) ||
    !Number.isSafeInteger(timestamp.nanoseconds) ||
    (timestamp.nanoseconds as number) < 0 ||
    (timestamp.nanoseconds as number) >= 1_000_000_000
  )
    return false;
  const seconds = timestamp.seconds as number;
  const nanoseconds = timestamp.nanoseconds as number;
  return seconds > fence.seconds || (seconds === fence.seconds && nanoseconds > fence.nanoseconds);
}
