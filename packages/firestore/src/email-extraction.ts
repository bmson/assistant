import { randomUUID } from 'node:crypto';
import {
  type EmailExtractionRepository,
  type EmailExtractionRow,
  type EmailFactHashState,
  type EmbeddingSpace,
  type Records,
  snapshotEmbeddingSpace,
  validateEmbedding,
} from '@assistant/persistence';
import { FieldValue, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { resolveFirestoreSubjectContact } from './contact-lookup.js';
import { embeddingSpaceKey, FirestoreMemoryRepository } from './memory.js';
import { FirestoreOccasionToolRepository } from './occasion-tools.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

/**
 * `email.extract` on Firestore. Facts are saved through the memory writer, so
 * they carry the installation's embedding space and its content-hash and
 * tombstone markers; occasions go through the occasion tool writer, quarantined.
 */
export class FirestoreEmailExtractionRepository implements EmailExtractionRepository {
  readonly kind = 'email-extraction-repository' as const;
  readonly storageEmbeddingSpaceKey: string;
  readonly space: EmbeddingSpace;
  private readonly memories: FirestoreMemoryRepository;
  private readonly occasions: FirestoreOccasionToolRepository;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
    space: EmbeddingSpace,
  ) {
    this.space = snapshotEmbeddingSpace(space);
    this.storageEmbeddingSpaceKey = embeddingSpaceKey(this.space);
    this.memories = new FirestoreMemoryRepository(store, this.space);
    this.occasions = new FirestoreOccasionToolRepository(store, agentId);
  }

  async pending(limit: number): Promise<EmailExtractionRow[]> {
    const rows: EmailExtractionRow[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    let scanned = 0;
    const scanLimit = Math.max(2_000, Math.min(10_000, limit * 20));
    while (rows.length < limit && scanned < scanLimit) {
      let query = this.store
        .collection('emailIngest')
        .where('agentId', '==', this.agentId)
        .where('extractedAt', '==', null)
        .orderBy('createdAt', 'asc')
        .limit(Math.min(200, scanLimit - scanned));
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      rows.push(
        ...page.docs.flatMap((doc) => {
          const row = decodeRecord<Records['emailIngest']>(doc.data());
          if (
            typeof row.id !== 'string' ||
            documentKey(row.id) !== doc.id ||
            row.agentId !== this.agentId ||
            (row.pipelineStage !== undefined && row.pipelineStage !== 'complete')
          )
            return [];
          return [
            {
              id: row.id,
              agentId: row.agentId,
              channelMessageId: row.channelMessageId,
              fromEmail: row.fromEmail,
              subject: row.subject,
              category: row.category,
              importance: Number(row.importance) || 0,
              preparedExtraction: row.preparedExtraction ?? null,
            },
          ];
        }),
      );
      scanned += page.size;
      if (page.size < 200) break;
      cursor = page.docs[page.docs.length - 1];
    }
    if (rows.length < limit && scanned >= scanLimit)
      throw new Error('Email extraction scan exceeded bound before finding a complete page');
    return rows.slice(0, limit);
  }

  async messageText(channelMessageId: string): Promise<string | null> {
    const dedupe = await this.store.doc('messageChannelIds', channelMessageId).get();
    const messageId = dedupe.exists ? dedupe.get('messageId') : null;
    const snapshot =
      typeof messageId === 'string'
        ? await this.store.doc('messages', messageId).get()
        : (
            await this.store
              .collection('messages')
              .where('channelMessageId', '==', channelMessageId)
              .limit(1)
              .get()
          ).docs[0];
    const text = snapshot?.exists ? snapshot.get('text') : null;
    return typeof text === 'string' ? text : null;
  }

  async savePrepared(
    id: string,
    agentId: string,
    payload: Parameters<EmailExtractionRepository['savePrepared']>[2],
  ): Promise<void> {
    if (agentId !== this.agentId)
      throw new Error('Email extraction is outside the configured owner');
    const ref = this.store.doc('emailIngest', id);
    await this.store.db.runTransaction(async (tx) => {
      const [snapshot, erasure] = await tx.getAll(
        ref,
        this.store.doc('privacyErasureJobs', agentId),
      );
      if (!snapshot?.exists || snapshot.get('agentId') !== agentId || snapshot.get('extractedAt'))
        throw new Error('Email extraction source changed before prepared output was saved');
      if (erasure?.exists && privacyErasureIsActive(erasure.get('status')))
        throw new Error('Privacy erasure is in progress');
      tx.update(ref, { preparedExtraction: encodeRecord(payload), updatedAt: this.store.now() });
    });
  }

  async screenFactHashes(
    agentId: string,
    hashes: string[],
  ): Promise<Record<string, EmailFactHashState>> {
    if (agentId !== this.agentId)
      throw new Error('Email extraction is outside the configured owner');
    if (hashes.length > 30)
      throw new Error('Email extraction hash preflight exceeds the Firestore query bound');
    if (!hashes.length) return {};
    const [existing, tombstones] = await Promise.all([
      this.store
        .collection('memories')
        .where('agentId', '==', agentId)
        .where('contentHash', 'in', hashes)
        .get(),
      Promise.all(hashes.map((hash) => this.store.doc('memoryTombstones', hash).get())),
    ]);
    const existingByHash = new Map(
      existing.docs.map((doc) => [
        String(doc.get('contentHash')),
        doc.get('embeddingSpace') ?? null,
      ]),
    );
    const tombstonedHashes = new Set(hashes.filter((_, index) => tombstones[index]?.exists));
    return Object.fromEntries(
      hashes.map((hash) => [
        hash,
        tombstonedHashes.has(hash)
          ? { state: 'tombstoned' as const }
          : existingByHash.has(hash)
            ? {
                state: 'duplicate' as const,
                embeddingSpaceKey: existingByHash.get(hash) as string | null,
              }
            : { state: 'new' as const },
      ]),
    );
  }

  async refreshFactEmbedding(
    agentId: string,
    contentHash: string,
    embedding: number[],
  ): Promise<boolean> {
    if (agentId !== this.agentId)
      throw new Error('Email extraction is outside the configured owner');
    validateEmbedding(this.space, embedding);
    const hashRef = this.store.doc('memoryContentHashes', contentHash);
    const tombstoneRef = this.store.doc('memoryTombstones', contentHash);
    const erasureRef = this.store.doc('privacyErasureJobs', agentId);
    return this.store.db.runTransaction(async (tx) => {
      const [hash, tombstone, erasure] = await tx.getAll(hashRef, tombstoneRef, erasureRef);
      if (!hash?.exists || tombstone?.exists) return false;
      if (erasure?.exists && privacyErasureIsActive(erasure.get('status')))
        throw new Error('Privacy erasure is in progress');
      const memoryId = hash.get('memoryId');
      if (typeof memoryId !== 'string') throw new Error('Memory content index is invalid');
      const memoryRef = this.store.doc('memories', memoryId);
      const memory = await tx.get(memoryRef);
      if (
        !memory.exists ||
        memory.get('agentId') !== agentId ||
        memory.get('contentHash') !== contentHash
      )
        return false;
      tx.update(memoryRef, {
        embedding: FieldValue.vector(embedding),
        embeddingSpace: embeddingSpaceKey(this.space),
        retrievalRevision: randomUUID(),
      });
      return true;
    });
  }

  async stamp(id: string, now: Date): Promise<void> {
    await this.store
      .doc('emailIngest', id)
      .update(encodeRecord({ extractedAt: now, preparedExtraction: null, updatedAt: now }));
  }

  async saveFact(input: Parameters<EmailExtractionRepository['saveFact']>[0]) {
    if (input.agentId !== this.agentId)
      throw new Error('Email extraction is outside the configured owner');
    const { fact } = input;
    if ((await this.store.doc('memoryTombstones', fact.contentHash).get()).exists)
      return 'tombstoned' as const;
    const subjectContactId = await resolveFirestoreSubjectContact(
      this.store,
      input.agentId,
      fact.subject,
      fact.relationship,
    );
    const now = this.store.now();
    const memory: Records['memories'] = {
      id: randomUUID(),
      createdAt: now,
      agentId: input.agentId,
      expiresAt: fact.expiresAt,
      embedding: fact.embedding,
      embeddingSpaceKey: input.embeddingSpaceKey,
      sourceTaskId: input.taskId ?? null,
      kind: fact.kind,
      confidence: fact.confidence,
      contentHash: fact.contentHash,
      goalId: null,
      originTrust: 'unknown',
      category: fact.category,
      content: fact.content,
      importance: fact.importance,
      quarantined: input.quarantined,
      subjectContactId,
      domain: fact.domain,
      validFrom: fact.validFrom,
      validUntil: null,
      supersededById: null,
      ownerConfirmed: false,
      pinned: false,
      source: 'email-ingest',
      lastAccessedAt: null,
      lastConsolidatedAt: null,
    };
    return (await this.memories.save(memory)) ? ('saved' as const) : ('duplicate' as const);
  }

  async saveOccasion(input: Parameters<EmailExtractionRepository['saveOccasion']>[0]) {
    try {
      const result = await this.occasions.save({
        agentId: input.agentId,
        subject: input.subject,
        kind: input.kind,
        label: input.label,
        month: input.month,
        day: input.day,
        year: input.year,
        leadDays: 7,
        notes: input.notes,
        originTrust: 'unknown',
        quarantined: true,
        source: 'email-ingest',
      });
      return result ? result.saved : null;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'This occasion date was explicitly corrected by the owner'
      ) {
        return false;
      }
      throw error;
    }
  }

  async pendingCount(): Promise<number> {
    let count = 0;
    let scanned = 0;
    let cursor: QueryDocumentSnapshot | undefined;
    const scanLimit = 10_000;
    while (scanned < scanLimit) {
      let query = this.store
        .collection('emailIngest')
        .where('agentId', '==', this.agentId)
        .where('extractedAt', '==', null)
        .orderBy('createdAt', 'asc')
        .limit(Math.min(200, scanLimit - scanned));
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      count += page.docs.filter((doc) => {
        const row = decodeRecord<Records['emailIngest']>(doc.data());
        return row.pipelineStage === undefined || row.pipelineStage === 'complete';
      }).length;
      scanned += page.size;
      if (page.size < 200) return count;
      cursor = page.docs[page.docs.length - 1];
    }
    throw new Error('Email extraction pending count exceeded scan bound');
  }
}
