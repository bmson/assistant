import { randomUUID } from 'node:crypto';
import {
  type ConversationSegmentationRepository,
  type ConversationSegmentInput,
  type EmbeddingSpace,
  type Records,
  type SegmentableMessage,
  snapshotEmbeddingSpace,
  validateEmbedding,
  validateSkillEmbeddingSpace,
} from '@assistant/persistence';
import { FieldValue, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { embeddingSpaceKey } from './memory.js';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const PAGE = 200;
/**
 * Messages read per conversation per run while collecting segmentable turns.
 * A bounded scan cap prevents one job from walking an unbounded transcript.
 */
const SCAN_LIMIT = 5_000;
const TRUSTED = ['owner', 'assistant'];

/**
 * `chat.segment` on Firestore. Only vectors in the installation's embedding
 * space are grouped, and new segment vectors are stamped with that space, so
 * history recall matches them exactly as it matches imported segments.
 */
export class FirestoreConversationSegmentationRepository
  implements ConversationSegmentationRepository
{
  readonly kind = 'conversation-segmentation-repository' as const;
  private readonly spaceKey: string;
  readonly space: EmbeddingSpace;

  constructor(
    readonly store: InstallationStore,
    space: EmbeddingSpace,
  ) {
    this.space = snapshotEmbeddingSpace(space);
    validateSkillEmbeddingSpace(this.space);
    this.spaceKey = embeddingSpaceKey(this.space);
  }

  async recentConversations(agentId: string, limit: number): Promise<Array<{ id: string }>> {
    const snapshot = await this.store
      .collection('conversations')
      .where('agentId', '==', agentId)
      .where('trust', 'in', TRUSTED)
      .orderBy('updatedAt', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs.flatMap((doc) => {
      const id = doc.get('id');
      return typeof id === 'string' && documentKey(id) === doc.id ? [{ id }] : [];
    });
  }

  async unsegmentedMessages(
    agentId: string,
    conversationId: string,
    limit: number,
    embeddingSpaceKey: string,
  ): Promise<SegmentableMessage[]> {
    const conversation = await this.store.doc('conversations', conversationId).get();
    if (
      !conversation.exists ||
      conversation.get('agentId') !== agentId ||
      !TRUSTED.includes(conversation.get('trust'))
    )
      return [];
    const latest = await this.store
      .collection('conversationSegments')
      .where('conversationId', '==', conversationId)
      .orderBy('endedAt', 'desc')
      .orderBy('endMessageId', 'desc')
      .limit(1)
      .get();
    const latestSegment = latest.docs[0]
      ? decodeRecord<Records['conversationSegments']>(latest.docs[0].data())
      : null;
    const endedAt = latestSegment?.endedAt instanceof Date ? latestSegment.endedAt : null;
    const endMessageId =
      typeof latestSegment?.endMessageId === 'string' ? latestSegment.endMessageId : null;

    const rows: SegmentableMessage[] = [];
    let scanned = 0;
    let cursor: QueryDocumentSnapshot | undefined;
    while (rows.length < limit && scanned < SCAN_LIMIT) {
      let query = this.store
        .collection('messages')
        .where('conversationId', '==', conversationId)
        .where('role', 'in', ['user', 'assistant']);
      query = query.orderBy('createdAt', 'asc').orderBy('id', 'asc').limit(PAGE);
      if (endedAt && endMessageId) query = query.startAfter(endedAt, endMessageId);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        const row = decodeRecord<Records['messages'] & { embeddingSpace?: unknown }>(doc.data());
        if (
          typeof row.id !== 'string' ||
          documentKey(row.id) !== doc.id ||
          (row.role !== 'user' && row.role !== 'assistant') ||
          typeof row.text !== 'string' ||
          (typeof row.channelMessageId === 'string' &&
            (row.channelMessageId.startsWith('visual-qa:') ||
              row.channelMessageId.startsWith('readability-'))) ||
          row.text.length === 0 ||
          !(row.createdAt instanceof Date)
        )
          continue;
        rows.push({
          id: row.id,
          role: row.role,
          text: row.text,
          createdAt: row.createdAt,
          embeddingSpaceKey:
            typeof row.embeddingSpaceKey === 'string'
              ? row.embeddingSpaceKey
              : typeof row.embeddingSpace === 'string'
                ? row.embeddingSpace
                : null,
          embedding:
            (row.embeddingSpaceKey ?? row.embeddingSpace) === embeddingSpaceKey &&
            Array.isArray(row.embedding)
              ? row.embedding
              : null,
        });
        if (rows.length >= limit) break;
      }
      scanned += page.size;
      if (page.size < PAGE) break;
      cursor = page.docs[page.docs.length - 1];
    }
    return rows;
  }

  async commitSegment(input: ConversationSegmentInput): Promise<boolean> {
    if (input.embedding) validateEmbedding(this.space, input.embedding);
    const existing = this.store
      .collection('conversationSegments')
      .where('conversationId', '==', input.conversationId)
      .where('startMessageId', '==', input.startMessageId)
      .limit(1);
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const conversation = await tx.get(this.store.doc('conversations', input.conversationId));
      if (!conversation.exists || conversation.get('agentId') !== input.agentId)
        throw new Error('Segment conversation is outside the configured owner');
      if (!(await tx.get(existing)).empty) return false;
      const id = randomUUID();
      const now = this.store.now();
      const segment: Omit<Records['conversationSegments'], 'embedding'> = {
        id,
        createdAt: now,
        updatedAt: now,
        agentId: input.agentId,
        conversationId: input.conversationId,
        startMessageId: input.startMessageId,
        endMessageId: input.endMessageId,
        summary: input.summary,
        messageCount: input.messageCount,
        embeddingSpaceKey: input.embedding ? this.spaceKey : null,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
      };
      tx.create(this.store.doc('conversationSegments', id), {
        ...encodeRecord(segment),
        ...(input.embedding
          ? {
              embedding: FieldValue.vector(input.embedding),
              embeddingSpace: this.spaceKey,
              embeddingSpaceKey: this.spaceKey,
            }
          : { embedding: null }),
      });
      return true;
    });
  }
}
