import type {
  OwnerAmbientSnapshot,
  OwnerCommitment,
  OwnerContextRepository,
  OwnerLocationPing,
} from '@assistant/persistence';
import {
  commitmentIsActive,
  isOwnerContextCommitmentSourceEligible,
  isOwnerContextFixtureConversationMetadata,
  isOwnerContextFixtureMessageSource,
} from '@assistant/persistence';
import type { QueryDocumentSnapshot } from '@google-cloud/firestore';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const COMMITMENT_PAGE_SIZE = 100;
const MAX_COMMITMENT_SCAN = 10_000;
const PROVENANCE_READ_BATCH_SIZE = 100;

function boundedCommitmentLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 60) {
    throw new Error('Owner context commitment limit must be between 1 and 60');
  }
  return limit;
}

function decodedIdentityMatches(
  doc: FirebaseFirestore.DocumentSnapshot,
  value: { id?: unknown },
): boolean {
  return typeof value.id === 'string' && documentKey(value.id) === doc.id;
}

/**
 * Firestore layout for private chat context, below the installation document:
 *
 * - `ownerCards/{base64url(agentId)}`: `{ agentId, content, compiledAt }`
 * - `ambientSnapshots/{base64url(agentId)}`: one current cache row per agent
 * - `locationPings/{base64url(pingId)}` and `commitments/{base64url(id)}`
 *
 * Owner-card reads address the authenticated agent's document directly and
 * require its stored `agentId` to match. A malformed or foreign document is
 * ignored; its content is never treated as installation-global context.
 */
export class FirestoreOwnerContextRepository implements OwnerContextRepository {
  readonly kind = 'owner-context-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async getOwnerCard(agentId: string) {
    const erasure = await this.store.doc('privacyErasureJobs', agentId).get();
    if (erasure.exists && privacyErasureIsActive(erasure.get('status'))) return null;
    const snapshot = await this.store.doc('ownerCards', agentId).get();
    if (!snapshot.exists) return null;
    const row = decodeRecord<{ agentId?: unknown; content?: unknown; compiledAt?: unknown }>(
      snapshot.data(),
    );
    if (
      row.agentId !== agentId ||
      typeof row.content !== 'string' ||
      !(row.compiledAt instanceof Date)
    ) {
      return null;
    }
    return { content: row.content, compiledAt: row.compiledAt };
  }

  async getAmbientSnapshot(agentId: string) {
    const snapshot = await this.store.doc('ambientSnapshots', agentId).get();
    if (!snapshot.exists) return null;
    const row = decodeRecord<OwnerAmbientSnapshot>(snapshot.data());
    if (
      row.agentId !== agentId ||
      typeof row.block !== 'string' ||
      !(row.computedAt instanceof Date)
    ) {
      return null;
    }
    return row;
  }

  async getLatestLocation({
    agentId,
    notBefore,
    notAfter,
    source,
  }: {
    agentId: string;
    notBefore: Date;
    notAfter: Date;
    source?: string;
  }) {
    let query = this.store
      .collection('locationPings')
      .where('agentId', '==', agentId)
      .where('capturedAt', '>=', notBefore)
      .where('capturedAt', '<=', notAfter);
    if (source) query = query.where('source', '==', source);
    const snapshot = await query.orderBy('capturedAt', 'desc').limit(1).get();
    const doc = snapshot.docs[0];
    if (!doc) return null;
    const row = decodeRecord<OwnerLocationPing>(doc.data());
    if (
      row.agentId !== agentId ||
      !decodedIdentityMatches(doc, row) ||
      !(row.capturedAt instanceof Date) ||
      row.capturedAt < notBefore ||
      row.capturedAt > notAfter ||
      (Boolean(source) && row.source !== source)
    ) {
      return null;
    }
    return row;
  }

  async listOpenCommitments({
    agentId,
    now,
    limit: requestedLimit,
  }: {
    agentId: string;
    now: Date;
    limit: number;
  }) {
    const limit = boundedCommitmentLimit(requestedLimit);
    const base = this.store.collection('commitments').where('agentId', '==', agentId);
    const [open, snoozed] = await Promise.all([
      this.listOpenStatusCommitments(base, agentId, now, limit),
      this.listElapsedSnoozes(base, agentId, now, limit),
    ]);
    return [...open, ...snoozed]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit);
  }

  private async listOpenStatusCommitments(
    base: FirebaseFirestore.Query,
    agentId: string,
    now: Date,
    limit: number,
  ): Promise<OwnerCommitment[]> {
    const eligible: OwnerCommitment[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    let scanned = 0;
    while (eligible.length < limit && scanned < MAX_COMMITMENT_SCAN) {
      const pageLimit = Math.min(COMMITMENT_PAGE_SIZE, MAX_COMMITMENT_SCAN - scanned);
      let query = base
        .where('status', 'in', ['open', 'stale'])
        .orderBy('updatedAt', 'desc')
        .limit(pageLimit);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      scanned += page.size;
      const candidates: OwnerCommitment[] = [];
      for (const doc of page.docs) {
        const row = decodeRecord<OwnerCommitment>(doc.data());
        if (
          row.agentId === agentId &&
          decodedIdentityMatches(doc, row) &&
          row.updatedAt instanceof Date &&
          commitmentIsActive(row, now)
        ) {
          candidates.push(row);
        }
      }
      eligible.push(...(await this.filterEligibleCommitmentProvenance(candidates, agentId)));
      cursor = page.docs.at(-1);
      if (page.size < pageLimit) break;
    }
    if (eligible.length < limit && scanned >= MAX_COMMITMENT_SCAN && cursor) {
      const overflow = await base
        .where('status', 'in', ['open', 'stale'])
        .orderBy('updatedAt', 'desc')
        .startAfter(cursor)
        .limit(1)
        .get();
      if (!overflow.empty) {
        throw new Error(`Owner context commitment scan exceeded ${MAX_COMMITMENT_SCAN}`);
      }
    }
    return eligible.slice(0, limit);
  }

  async filterEligibleCommitmentProvenance(
    rows: OwnerCommitment[],
    agentId: string,
  ): Promise<OwnerCommitment[]> {
    const candidates = rows.filter((row) =>
      isOwnerContextCommitmentSourceEligible({
        agentId: row.agentId,
        sourceMessageId: row.sourceMessageId,
        sourceOccurrenceKey: row.sourceOccurrenceKey,
        reopenedFromId: row.reopenedFromId,
        reopenOperationId: row.reopenOperationId,
      }),
    );
    const conversationIds = [...new Set(candidates.map((row) => row.conversationId))].filter(
      (id) => typeof id === 'string' && id.length > 0 && id.length <= 1000,
    );
    const messageIds = [
      ...new Set(
        candidates.flatMap((row) =>
          typeof row.sourceMessageId === 'string' &&
          row.sourceMessageId.length > 0 &&
          row.sourceMessageId.length <= 1000 &&
          !isOwnerContextFixtureMessageSource(row.sourceMessageId)
            ? [row.sourceMessageId]
            : [],
        ),
      ),
    ];
    const [conversationDocs, messageDocs] = await Promise.all([
      this.readDocuments('conversations', conversationIds),
      this.readDocuments('messages', messageIds),
    ]);
    const conversationsById = new Map(
      conversationDocs.map((snapshot) => {
        const row = snapshot.exists
          ? decodeRecord<{ id?: unknown; agentId?: unknown; metadata?: unknown }>(snapshot.data())
          : null;
        return [
          row && decodedIdentityMatches(snapshot, row) ? (row.id as string) : '',
          row,
        ] as const;
      }),
    );
    const messagesById = new Map(
      messageDocs.map((snapshot) => {
        const row = snapshot.exists
          ? decodeRecord<{
              id?: unknown;
              conversationId?: unknown;
              role?: unknown;
              channelMessageId?: unknown;
              hiddenAt?: unknown;
            }>(snapshot.data())
          : null;
        return [
          row && decodedIdentityMatches(snapshot, row) ? (row.id as string) : '',
          row,
        ] as const;
      }),
    );
    return candidates.filter((commitment) => {
      const conversation = conversationsById.get(commitment.conversationId);
      if (
        !conversation ||
        conversation.id !== commitment.conversationId ||
        conversation.agentId !== agentId ||
        isOwnerContextFixtureConversationMetadata(conversation.metadata)
      ) {
        return false;
      }
      if (commitment.sourceMessageId === null || commitment.sourceMessageId === undefined) {
        return true;
      }
      const message = messagesById.get(commitment.sourceMessageId);
      return (
        message?.id === commitment.sourceMessageId &&
        message.conversationId === commitment.conversationId &&
        message.role === 'user' &&
        (message.hiddenAt === null || message.hiddenAt === undefined) &&
        !isOwnerContextFixtureMessageSource(message.channelMessageId)
      );
    });
  }

  private async readDocuments(collection: string, ids: string[]) {
    const snapshots: FirebaseFirestore.DocumentSnapshot[] = [];
    for (let offset = 0; offset < ids.length; offset += PROVENANCE_READ_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + PROVENANCE_READ_BATCH_SIZE);
      const references = batch.flatMap((id) => {
        try {
          return [this.store.doc(collection, id)];
        } catch {
          // Malformed candidate keys are excluded; valid lookup failures propagate.
          return [];
        }
      });
      if (references.length) snapshots.push(...(await this.store.db.getAll(...references)));
    }
    return snapshots;
  }

  private async listElapsedSnoozes(
    base: FirebaseFirestore.Query,
    agentId: string,
    now: Date,
    limit: number,
  ): Promise<OwnerCommitment[]> {
    const eligible: OwnerCommitment[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    let scanned = 0;
    while (eligible.length < limit && scanned < MAX_COMMITMENT_SCAN) {
      const pageLimit = Math.min(COMMITMENT_PAGE_SIZE, MAX_COMMITMENT_SCAN - scanned);
      let query = base
        .where('status', '==', 'snoozed')
        .orderBy('updatedAt', 'desc')
        .limit(pageLimit);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      scanned += page.size;
      const candidates: OwnerCommitment[] = [];
      for (const doc of page.docs) {
        const row = decodeRecord<OwnerCommitment>(doc.data());
        if (
          row.agentId === agentId &&
          row.status === 'snoozed' &&
          row.snoozedUntil instanceof Date &&
          row.snoozedUntil <= now &&
          row.updatedAt instanceof Date &&
          decodedIdentityMatches(doc, row) &&
          commitmentIsActive(row, now)
        ) {
          candidates.push(row);
        }
      }
      eligible.push(...(await this.filterEligibleCommitmentProvenance(candidates, agentId)));
      cursor = page.docs.at(-1);
      if (page.size < pageLimit) break;
    }
    if (eligible.length < limit && scanned >= MAX_COMMITMENT_SCAN && cursor) {
      const overflow = await base
        .where('status', '==', 'snoozed')
        .orderBy('updatedAt', 'desc')
        .startAfter(cursor)
        .limit(1)
        .get();
      if (!overflow.empty) {
        throw new Error(`Owner context snoozed commitment scan exceeded ${MAX_COMMITMENT_SCAN}`);
      }
    }
    return eligible.slice(0, limit);
  }
}
