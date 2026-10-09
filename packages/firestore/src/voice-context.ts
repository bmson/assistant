import { createHash, randomUUID } from 'node:crypto';
import {
  type EmailObserverEffectFence,
  type EmbeddingSpace,
  emailObserverMessageBody,
  emailObserverPreparedVoiceMatches,
  type Records,
  snapshotEmbeddingSpace,
  type VoiceContextRepository,
  type VoiceProfileText,
  validateEmbedding,
  validateSkillEmbeddingSpace,
} from '@assistant/persistence';
import { type DocumentSnapshot, FieldPath, FieldValue } from '@google-cloud/firestore';
import { embeddingSpaceKey } from './memory.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function privacyGeneration(snapshot: DocumentSnapshot): string | null {
  if (!snapshot.exists) return null;
  if (!snapshot.updateTime) throw new Error('Privacy erasure generation is unavailable');
  return `${snapshot.updateTime.seconds}:${snapshot.updateTime.nanoseconds}`;
}

/**
 * The owner's voice on Firestore: the singleton profile and a native vector
 * search over their writing samples in the installation's embedding space.
 */
export class FirestoreVoiceContextRepository implements VoiceContextRepository {
  readonly kind = 'voice-context-repository' as const;
  private readonly spaceKey: string;
  readonly space: EmbeddingSpace;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
    space: EmbeddingSpace,
  ) {
    this.space = snapshotEmbeddingSpace(space);
    validateSkillEmbeddingSpace(this.space);
    this.spaceKey = embeddingSpaceKey(this.space);
  }

  async profile(): Promise<VoiceProfileText | null> {
    const snapshot = await this.store.doc('voiceProfile', '1').get();
    if (!snapshot.exists) return null;
    const row = decodeRecord<Records['voiceProfile']>(snapshot.data());
    return {
      description: typeof row.description === 'string' ? row.description : '',
      dos: strings(row.dos),
      donts: strings(row.donts),
      signature: typeof row.signature === 'string' ? row.signature : '',
    };
  }

  private samples(register: string) {
    return this.store
      .collection('writingSamples')
      .where('agentId', '==', this.agentId)
      .where('register', '==', register)
      .where('embeddingSpace', '==', this.spaceKey);
  }

  async hasSamples(register: string, embeddingSpaceKey: string): Promise<boolean> {
    if (embeddingSpaceKey !== this.spaceKey)
      throw new Error('Voice sample query embedding space does not match the configured space');
    return !(await this.samples(register).limit(1).get()).empty;
  }

  async nearestSamples(
    register: string,
    embedding: number[],
    embeddingSpaceKey: string,
    limit: number,
  ): Promise<string[]> {
    if (embeddingSpaceKey !== this.spaceKey)
      throw new Error('Voice sample query embedding space does not match the configured space');
    validateEmbedding(this.space, embedding);
    const result = await this.samples(register)
      .findNearest({
        vectorField: 'embedding',
        queryVector: embedding,
        distanceMeasure: 'COSINE',
        limit,
      })
      .get();
    return result.docs.flatMap((doc) => {
      const text = doc.get('text');
      return typeof text === 'string' ? [text] : [];
    });
  }

  async hasSampleText(text: string, exactSpaceKey: string): Promise<boolean> {
    if (exactSpaceKey !== this.spaceKey)
      throw new Error('Voice sample lookup embedding space does not match the configured space');
    // Firestore cannot query an indexed value above 1,500 UTF-8 bytes. Voice
    // samples allow up to 4,000 characters, so compare long legacy/new samples
    // in bounded owner pages instead of putting private prose in that query.
    if (Buffer.byteLength(text, 'utf8') > 1500) {
      let cursor: DocumentSnapshot | undefined;
      let examined = 0;
      while (true) {
        let query = this.store
          .collection('writingSamples')
          .where('agentId', '==', this.agentId)
          .orderBy(FieldPath.documentId())
          .limit(50);
        if (cursor) query = query.startAfter(cursor);
        const page = await query.get();
        for (const document of page.docs) {
          if (document.get('agentId') !== this.agentId)
            throw new Error('Voice sample lookup is outside the configured owner');
          if (
            document.get('text') === text &&
            (document.get('embeddingSpaceKey') ?? document.get('embeddingSpace')) === exactSpaceKey
          )
            return true;
          examined++;
          if (examined >= 100000) throw new Error('Voice sample lookup exceeded its bounded scan');
        }
        if (page.size < 50) return false;
        cursor = page.docs.at(-1);
      }
    }
    const snapshot = await this.store
      .collection('writingSamples')
      .where('agentId', '==', this.agentId)
      .where('embeddingSpace', '==', exactSpaceKey)
      .where('text', '==', text)
      .limit(1)
      .get();
    return !snapshot.empty;
  }

  async countSamplesWithContextPrefix(prefix: string): Promise<number> {
    const result = await this.store
      .collection('writingSamples')
      .where('agentId', '==', this.agentId)
      .where('context', '>=', prefix)
      .where('context', '<', `${prefix}\uf8ff`)
      .count()
      .get();
    return result.data().count;
  }

  async observationGeneration(): Promise<string | null> {
    const snapshot = await this.store.doc('privacyErasureJobs', this.agentId).get();
    if (
      snapshot.exists &&
      (snapshot.get('agentId') !== this.agentId || privacyErasureIsActive(snapshot.get('status')))
    )
      throw new Error('Privacy erasure is in progress');
    return privacyGeneration(snapshot);
  }

  async addSample(
    input: {
      register: string;
      text: string;
      context: string;
      embedding: number[];
      embeddingSpaceKey: string;
    },
    observedGeneration: string | null,
    options?: { emailObserverEffectFence?: EmailObserverEffectFence },
  ): Promise<void> {
    validateEmbedding(this.space, input.embedding);
    if (input.embeddingSpaceKey !== this.spaceKey)
      throw new Error('Voice sample write embedding space does not match the configured space');
    // Exact content identity avoids querying indexed text that Firestore truncates.
    const digest = options?.emailObserverEffectFence
      ? createHash('sha256')
          .update(JSON.stringify([this.agentId, this.spaceKey, input.text]))
          .digest('hex')
      : null;
    const id = digest
      ? `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
      : randomUUID();
    const jobRef = this.store.doc('privacyErasureJobs', this.agentId);
    const sampleRef = this.store.doc('writingSamples', id);
    await this.store.db.runTransaction(async (tx) => {
      const job = await tx.get(jobRef);
      if (
        job.exists &&
        (job.get('agentId') !== this.agentId || privacyErasureIsActive(job.get('status')))
      )
        throw new Error('Privacy erasure is in progress');
      if (privacyGeneration(job) !== observedGeneration)
        throw new Error('Privacy erasure changed during voice sample observation');
      const fence = options?.emailObserverEffectFence;
      if (fence) {
        if (fence.agentId !== this.agentId) throw new Error('Email voice effect owner mismatch');
        if (
          (typeof job.get('generation') === 'string' ? job.get('generation') : null) !==
          fence.expectedPrivacyGeneration
        )
          throw new Error('Email voice effect privacy generation changed');
        const workSnapshot = await tx.get(this.store.doc('emailObserverWork', fence.id));
        const work = workSnapshot.exists
          ? decodeRecord<Records['emailObserverWork']>(workSnapshot.data())
          : null;
        const ingests = work
          ? await tx.get(
              this.store
                .collection('emailIngest')
                .where('agentId', '==', this.agentId)
                .where('channelMessageId', '==', work.channelMessageId)
                .limit(2),
            )
          : null;
        const [ingestDocument] = ingests?.docs ?? [];
        const ingest =
          ingests?.size === 1 && ingestDocument
            ? decodeRecord<Records['emailIngest']>(ingestDocument.data())
            : null;
        const source = ingest?.admittedSourceId
          ? await tx.get(this.store.doc('messages', ingest.admittedSourceId))
          : null;
        const conversation = source?.exists
          ? await tx.get(this.store.doc('conversations', String(source.get('conversationId'))))
          : null;
        const channel = work
          ? await tx.get(this.store.doc('messageChannelIds', work.channelMessageId))
          : null;
        if (
          !work ||
          !emailObserverPreparedVoiceMatches(
            work,
            fence,
            input,
            observedGeneration,
            this.store.now(),
          ) ||
          !ingest ||
          ingest.ingestMode !== 'direct' ||
          !ingest.authenticated ||
          ingest.contentTrust !== 'owner' ||
          ingest.hasExternalOrUnknown ||
          ingest.admittedSourceKind !== 'message' ||
          !source?.exists ||
          source.get('hiddenAt') ||
          source.get('id') !== ingest.admittedSourceId ||
          source.get('channelMessageId') !== work.channelMessageId ||
          emailObserverMessageBody(source.get('parts'))?.trim() !== input.text ||
          !conversation?.exists ||
          conversation.get('agentId') !== this.agentId ||
          !channel?.exists ||
          channel.get('messageId') !== ingest.admittedSourceId ||
          channel.get('conversationId') !== source.get('conversationId')
        )
          throw new Error('Email voice effect claim or source is no longer current');
        const duplicate = await tx.get(sampleRef);
        if (duplicate.exists) {
          if (
            duplicate.get('agentId') !== this.agentId ||
            duplicate.get('text') !== input.text ||
            duplicate.get('embeddingSpaceKey') !== this.spaceKey
          )
            throw new Error('Email voice sample identity conflicts');
          return;
        }
        if (
          !emailObserverPreparedVoiceMatches(
            work,
            fence,
            input,
            observedGeneration,
            this.store.now(),
          )
        )
          throw new Error('Email voice effect expired before sample write');
      }
      tx.create(sampleRef, {
        ...encodeRecord({
          id,
          agentId: this.agentId,
          register: input.register,
          text: input.text,
          context: input.context,
          embeddingSpaceKey: this.spaceKey,
          createdAt: this.store.now(),
        }),
        embedding: FieldValue.vector(input.embedding),
        embeddingSpace: this.spaceKey,
      });
    });
  }
}
