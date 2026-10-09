import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  EmailAdmissionCommitInput,
  EmailAdmissionCommitResult,
  EmailIngestRecord,
  EmailObligationDecision,
  EmailObligationRecord,
  EmailObserverClaim,
  EmailObserverClaimResult,
  EmailObserverIdentity,
  EmailObserverSource,
  EmailObserverWorkRecord,
  EmailSyncLease,
  EmailSyncRepository,
  EmailSyncState,
  NewEmailIngest,
  PreparedEmailScore,
  Records,
  RecoverableDirectIngest,
  SecurityIncidentAttentionCandidate,
  SecurityIncidentObservation,
  SecurityIncidentRecord,
  SecurityIncidentSourceRecord,
} from '@assistant/persistence';
import {
  emailBookingKey,
  emailBookingObservationIsNewer,
  emailBookingOccurrenceId,
  emailObserverBudgetId,
  emailObserverDeliveryKey,
  emailObserverMessageBody,
  emailObserverSourceId,
  emailObserverWorkId,
  isValidEmailContentProvenanceSnapshot,
  isValidEmailObserverPreparedResult,
  notificationDashboardMessageId,
  safeEmailObserverErrorCode,
  sameEmailObserverPreparedResult,
  securityIncidentId,
  securityIncidentIdentity,
  securityIncidentMailboxHash,
} from '@assistant/persistence';
import { FieldPath, type Transaction } from '@google-cloud/firestore';
import { conversationDocument } from './conversation-document.js';
import { messageRecord } from './messages.js';
import {
  assertPrivacyErasureFenceUnchanged,
  assertPrivacyErasureGenerationInTransaction,
  assertPrivacyErasureInactiveInTransaction,
  privacyErasureIsActive,
  readPrivacyErasureFence,
} from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

/** Contacts are read whole to map addresses to trust; past this the read fails loudly. */
const CONTACT_LIMIT = 5_000;
/** How long one sync may hold the mailbox lock before another instance may take it over. */
const LOCK_MS = 10 * 60_000;
const LOCK_DOC = 'gmail-sync-lock';

function dateFromFirestore(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (value && typeof value === 'object' && 'toDate' in value) {
    const toDate = (value as { toDate?: unknown }).toDate;
    if (typeof toDate === 'function') {
      const date = toDate.call(value);
      return date instanceof Date ? date : null;
    }
  }
  return null;
}

function uuidFrom(parts: unknown[]): string {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function normalizeObserverSnapshot(observers: EmailAdmissionCommitInput['observers']) {
  const snapshot = [...observers]
    .map(({ key, version, workClass }) => ({ key, version, workClass }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.version - b.version);
  if (
    snapshot.length > 40 ||
    snapshot.some(
      (item, index) =>
        !item.key.trim() ||
        !Number.isInteger(item.version) ||
        item.version < 1 ||
        (index > 0 &&
          item.key === snapshot[index - 1]?.key &&
          item.version === snapshot[index - 1]?.version),
    )
  )
    throw new Error('Email observer registry is invalid or exceeds the transaction bound');
  return snapshot;
}

function observerSnapshotHash(
  snapshot: readonly { key: string; version: number; workClass: string }[],
) {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function observerRecord(snapshot: FirebaseFirestore.DocumentSnapshot): EmailObserverWorkRecord {
  const row = decodeRecord<Records['emailObserverWork']>(snapshot.data());
  if (!snapshot.exists || documentKey(row.id) !== snapshot.id || !row.agentId)
    throw new Error('Email observer work identity is malformed');
  return row;
}

function bigintOrNull(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

/**
 * Gmail sync on Firestore. The mailbox lock is a leased coordination document,
 * the history baseline only ever rises, and thread bindings and ingest rows
 * use stable ids so concurrent instances converge; imported rows are found by
 * query.
 */
export class FirestoreEmailSyncRepository implements EmailSyncRepository {
  readonly kind = 'email-sync-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}

  async privacyObservationFence(agentId: string): Promise<string | null> {
    if (agentId !== this.agentId) throw new Error('Email source is outside the configured owner');
    const snapshot = await this.store.doc('privacyErasureJobs', agentId).get();
    if (!snapshot.exists) return null;
    const generation = snapshot.get('generation');
    if (
      snapshot.get('agentId') !== agentId ||
      privacyErasureIsActive(snapshot.get('status')) ||
      typeof generation !== 'string' ||
      !generation
    )
      throw new Error('Privacy erasure is in progress or malformed');
    return generation;
  }

  async mailbox(): Promise<{ agentId: string; name: string; email: string }> {
    const agent = await this.store.doc('agents', this.agentId).get();
    const email = agent.exists ? agent.get('email') : null;
    const name = agent.exists ? agent.get('name') : null;
    if (typeof email !== 'string' || !email) throw new Error('Gmail sync owner has no email');
    return { agentId: this.agentId, name: typeof name === 'string' ? name : '', email };
  }

  async contactTrust(): Promise<Array<{ email: string; trust: 'owner' | 'known' }>> {
    const snapshot = await this.store
      .collection('contacts')
      .limit(CONTACT_LIMIT + 1)
      .get();
    if (snapshot.size > CONTACT_LIMIT) throw new Error('Contact scan exceeded bound');
    return snapshot.docs.flatMap((doc) => {
      const trust = doc.get('trust');
      const emails = doc.get('emails');
      if ((trust !== 'owner' && trust !== 'known') || !Array.isArray(emails)) return [];
      return emails
        .filter((email): email is string => typeof email === 'string')
        .map((email) => ({ email: email.toLowerCase(), trust }));
    });
  }

  private state(mailbox: string) {
    return this.store.doc('gmailSyncState', mailbox);
  }

  /** Check owner and activation in the same transaction as each state write. */
  private async assertOperationalInTransaction(tx: Transaction): Promise<void> {
    const [owner, migration] = await Promise.all([
      tx.get(this.store.doc('agents', this.agentId)),
      tx.get(this.store.doc('coordination', 'migration')),
    ]);
    if (!owner.exists || owner.get('id') !== this.agentId) {
      throw new Error('Configured Firestore owner is unavailable');
    }
    if (migration.exists && migration.get('status') !== 'active') {
      throw new Error('Firestore installation is not operationally ready');
    }
  }

  private async assertLeaseInTransaction(tx: Transaction, lease: EmailSyncLease): Promise<void> {
    const snapshot = await tx.get(this.store.doc('coordination', LOCK_DOC));
    const expiresAt = snapshot.exists ? dateFromFirestore(snapshot.get('expiresAt')) : null;
    if (
      !snapshot.exists ||
      snapshot.get('holder') !== lease.holder ||
      snapshot.get('generation') !== lease.generation ||
      !expiresAt ||
      expiresAt <= this.store.now()
    ) {
      throw new Error('Gmail sync lease is no longer current');
    }
  }

  async syncState(mailbox: string): Promise<EmailSyncState | null> {
    const snapshot = await this.state(mailbox).get();
    if (!snapshot.exists) return null;
    const row = decodeRecord<Records['gmailSyncState']>(snapshot.data());
    return { lastHistoryId: bigintOrNull(row.lastHistoryId), cursor: row.cursor ?? null };
  }

  private async raise(
    mailbox: string,
    historyId: bigint,
    clearCursor: boolean,
    lease: EmailSyncLease,
  ): Promise<void> {
    const ref = this.state(mailbox);
    await this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      const [current] = await Promise.all([tx.get(ref), this.assertLeaseInTransaction(tx, lease)]);
      const previous = current.exists
        ? bigintOrNull(decodeRecord<{ lastHistoryId?: unknown }>(current.data()).lastHistoryId)
        : null;
      const next = previous !== null && previous > historyId ? previous : historyId;
      tx.set(
        ref,
        encodeRecord({
          mailbox,
          lastHistoryId: next,
          ...(clearCursor ? { cursor: {} } : {}),
          updatedAt: this.store.now(),
        }),
        { merge: true },
      );
    });
  }

  raiseBaseline(mailbox: string, historyId: bigint, lease: EmailSyncLease): Promise<void> {
    return this.raise(mailbox, historyId, false, lease);
  }

  async saveCursor(mailbox: string, cursor: unknown, lease: EmailSyncLease): Promise<void> {
    const ref = this.state(mailbox);
    await this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      await this.assertLeaseInTransaction(tx, lease);
      tx.set(ref, encodeRecord({ cursor, updatedAt: this.store.now() }), { merge: true });
    });
  }

  completeDrain(mailbox: string, targetHistoryId: bigint, lease: EmailSyncLease): Promise<void> {
    return this.raise(mailbox, targetHistoryId, true, lease);
  }

  async setWatchExpiration(mailbox: string, expiration: Date): Promise<void> {
    const ref = this.state(mailbox);
    await this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      tx.set(
        ref,
        encodeRecord({ mailbox, watchExpiration: expiration, updatedAt: this.store.now() }),
        { merge: true },
      );
    });
  }

  async withLock<T>(run: (lease: EmailSyncLease) => Promise<T>): Promise<{ value: T } | null> {
    const ref = this.store.doc('coordination', LOCK_DOC);
    const holder = randomUUID();
    const generation = await this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      const current = await tx.get(ref);
      const expiresAt = current.exists ? dateFromFirestore(current.get('expiresAt')) : null;
      if (expiresAt && expiresAt > this.store.now()) return null;
      const previous = current.exists ? current.get('generation') : null;
      let nextGeneration = 1;
      if (previous !== null && previous !== undefined) {
        if (typeof previous !== 'number' || !Number.isSafeInteger(previous)) {
          throw new Error('Gmail sync lease generation is malformed');
        }
        nextGeneration = previous + 1;
      }
      if (!Number.isSafeInteger(nextGeneration)) throw new Error('Gmail sync generation exhausted');
      tx.set(ref, {
        holder,
        generation: nextGeneration,
        expiresAt: new Date(this.store.now().getTime() + LOCK_MS),
      });
      return nextGeneration;
    });
    if (generation === null) return null;
    const lease: EmailSyncLease = {
      holder,
      generation,
      renew: async () => {
        await this.store.db.runTransaction(async (tx) => {
          await this.assertOperationalInTransaction(tx);
          await this.assertLeaseInTransaction(tx, lease);
          tx.update(ref, { expiresAt: new Date(this.store.now().getTime() + LOCK_MS) });
        });
      },
      assertCurrent: async () => {
        await this.store.db.runTransaction(async (tx) => {
          await this.assertOperationalInTransaction(tx);
          await this.assertLeaseInTransaction(tx, lease);
        });
      },
    };
    try {
      return { value: await run(lease) };
    } finally {
      await this.store.db
        .runTransaction(async (tx) => {
          const current = await tx.get(ref);
          if (
            current.exists &&
            current.get('holder') === holder &&
            current.get('generation') === generation
          ) {
            // Retain the generation so a later owner advances monotonically.
            tx.update(ref, { expiresAt: new Date(0) });
          }
        })
        .catch((error) => console.error('email-sync: failed to release mailbox lock', error));
    }
  }

  async inboundMessage(
    channelMessageId: string,
  ): Promise<{ conversationId: string; origin: string } | null> {
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
    if (!snapshot?.exists) return null;
    const conversationId = snapshot.get('conversationId');
    const origin = snapshot.get('origin');
    return typeof conversationId === 'string' && typeof origin === 'string'
      ? { conversationId, origin }
      : null;
  }

  async hasTaskForEvent(externalEventId: string): Promise<boolean> {
    const snapshot = await this.store
      .collection('tasks')
      .where('externalEventId', '==', externalEventId)
      .limit(1)
      .get();
    return !snapshot.empty;
  }

  async conversationForThread(
    agentId: string,
    threadId: string,
    trust: string,
    subject: string,
    options?: { expectedPrivacyGeneration: string | null },
  ): Promise<string> {
    if (agentId !== this.agentId) throw new Error('Email thread is outside the configured owner');
    const bindingId = `channel-binding:${createHash('sha256')
      .update(JSON.stringify(['email', threadId]))
      .digest('hex')}`;
    const bindingRef = this.store.doc('channelBindings', bindingId);
    const imported = this.store
      .collection('channelBindings')
      .where('channel', '==', 'email')
      .where('externalId', '==', threadId)
      .limit(1);
    return this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, agentId);
      if (options) {
        const erasureJob = await tx.get(this.store.doc('privacyErasureJobs', agentId));
        const generation = erasureJob.exists ? erasureJob.get('generation') : null;
        if (
          (erasureJob.exists && erasureJob.get('agentId') !== agentId) ||
          (typeof generation === 'string' ? generation : null) !== options.expectedPrivacyGeneration
        )
          throw new Error('Privacy erasure changed during email conversation admission');
      }
      const [byId, byThread] = await Promise.all([tx.get(bindingRef), tx.get(imported)]);
      const existing = byId.exists ? byId : byThread.docs[0];
      if (existing) {
        const conversationId = existing.get('conversationId');
        if (typeof conversationId !== 'string') throw new Error('Email binding is malformed');
        return conversationId;
      }
      const now = this.store.now();
      const conversation: Records['conversations'] = {
        id: randomUUID(),
        agentId,
        channel: 'email',
        trust,
        title: subject.slice(0, 80) || '(no subject)',
        isPrimary: false,
        metadata: {},
        archivedAt: null,
        modelOverride: null,
        lastReadAt: null,
        messageSequence: 0,
        createdAt: now,
        updatedAt: now,
      };
      tx.create(
        this.store.doc('conversations', conversation.id),
        conversationDocument(conversation),
      );
      tx.create(
        bindingRef,
        encodeRecord({
          id: bindingId,
          createdAt: now,
          updatedAt: now,
          channel: 'email',
          conversationId: conversation.id,
          externalId: threadId,
        }),
      );
      return conversation.id;
    });
  }

  private ingestQuery(channelMessageId: string) {
    return this.store
      .collection('emailIngest')
      .where('channelMessageId', '==', channelMessageId)
      .limit(1);
  }

  async ingestRecord(channelMessageId: string): Promise<EmailIngestRecord | null> {
    const byId = await this.store
      .doc('emailIngest', uuidFrom(['email-ingest', channelMessageId]))
      .get();
    const snapshot = byId.exists ? byId : (await this.ingestQuery(channelMessageId).get()).docs[0];
    if (!snapshot?.exists) return null;
    const row = decodeRecord<Records['emailIngest']>(snapshot.data());
    if (typeof row.id !== 'string' || documentKey(row.id) !== snapshot.id) return null;
    return {
      id: row.id,
      agentId: row.agentId,
      providerMessageId: row.providerMessageId ?? null,
      conversationId: row.conversationId ?? null,
      importance: row.importance,
      category: row.category,
      contentTrust: row.contentTrust,
      triaged: row.triaged === true,
      actionable: row.actionable === true,
      reason: row.reason ?? '',
      dates: row.dates ?? [],
      cardCandidate: row.cardCandidate === true,
      nextStep: row.nextStep ?? null,
      pipelineStage: row.pipelineStage ?? 'complete',
      scoreStatus: row.scoreStatus ?? 'prepared',
      scoreClaimToken: row.scoreClaimToken ?? null,
      messagePersisted: row.messagePersisted !== false,
      triageTaskId: row.triageTaskId ?? null,
      providerThreadId: row.providerThreadId ?? null,
      providerReceivedAt: row.providerReceivedAt ?? null,
      obligationStatus: row.obligationStatus ?? 'unknown',
      obligationVersion: row.obligationVersion ?? 0,
      obligationDecision: row.obligationDecision ?? null,
      obligationDecisionAt: row.obligationDecisionAt ?? null,
      obligationSnoozedUntil: row.obligationSnoozedUntil ?? null,
      sourceMessageId: row.sourceMessageId ?? null,
      securityEvidence: row.securityEvidence ?? null,
      securityIncidentId: row.securityIncidentId ?? null,
      classificationStatus: row.classificationStatus ?? 'not_required',
      classificationClaimToken: row.classificationClaimToken ?? null,
      preparedClassification: row.preparedClassification ?? null,
      scoreOutcome: row.scoreOutcome ?? 'model_prepared',
      ingestMode: row.ingestMode ?? 'forwarded',
      hasExternalOrUnknown: row.hasExternalOrUnknown ?? true,
      observerRegistrySnapshot: row.observerRegistrySnapshot ?? null,
      observerRegistryHash: row.observerRegistryHash ?? null,
      admittedSourceKind: row.admittedSourceKind ?? null,
      admittedSourceId: row.admittedSourceId ?? null,
      directRouting: row.directRouting ?? null,
      directRecoveryReason: row.directRecoveryReason ?? null,
      emailContentProvenance: row.emailContentProvenance ?? null,
    };
  }

  async listRecoverableDirectIngests(input: {
    agentId: string;
    mailbox: string;
    expectedPrivacyGeneration: string | null;
    lease: EmailSyncLease;
    limit: number;
  }): Promise<RecoverableDirectIngest[]> {
    if (input.agentId !== this.agentId) throw new Error('Email ingest owner mismatch');
    const mailbox = input.mailbox.trim().toLowerCase();
    if (!mailbox || !Number.isFinite(input.limit)) throw new Error('Invalid recovery scan bounds');
    await input.lease.assertCurrent();
    return this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        this.store,
        input.agentId,
        input.expectedPrivacyGeneration,
      );
      await this.assertLeaseInTransaction(tx, input.lease);
      const owner = await tx.get(this.store.doc('agents', input.agentId));
      if (
        !owner.exists ||
        typeof owner.get('email') !== 'string' ||
        owner.get('email').trim().toLowerCase() !== mailbox
      )
        throw new Error('Direct recovery mailbox is outside owner');
      const cap = Math.max(1, Math.min(20, Math.floor(input.limit)));
      const query = this.store
        .collection('emailIngest')
        .where('agentId', '==', input.agentId)
        .where('mailbox', '==', mailbox)
        .where('ingestMode', '==', 'direct')
        .where('authenticated', '==', true)
        .where('messagePersisted', '==', false)
        .where('admittedSourceKind', '==', null)
        .orderBy('updatedAt', 'asc')
        .limit(200);
      const snapshot = await tx.get(query);
      const result: RecoverableDirectIngest[] = [];
      for (const doc of snapshot.docs) {
        const row = decodeRecord<Records['emailIngest']>(doc.data());
        if (
          row.agentId !== input.agentId ||
          row.mailbox !== mailbox ||
          row.ingestMode !== 'direct' ||
          row.authenticated !== true ||
          row.messagePersisted !== false ||
          row.admittedSourceKind != null ||
          row.admittedSourceId != null ||
          row.pipelineStage === 'needs_attention'
        )
          continue;
        const classificationReusable =
          ['pending', 'in_progress', 'prepared'].includes(row.classificationStatus) ||
          (row.classificationStatus === 'unknown' && row.preparedClassification != null);
        const scoreReusable =
          ['pending', 'in_progress', 'prepared'].includes(row.scoreStatus) ||
          (row.scoreStatus === 'unknown' && row.scoreOutcome === 'fallback_committed_unknown');
        if (
          !classificationReusable ||
          !scoreReusable ||
          ![
            'pending_classification',
            'classifying',
            'pending_score',
            'scoring',
            'score_prepared',
          ].includes(row.pipelineStage)
        )
          continue;
        result.push({
          id: row.id,
          agentId: row.agentId,
          mailbox: row.mailbox,
          channelMessageId: row.channelMessageId,
          providerMessageId: row.providerMessageId ?? null,
          providerThreadId: row.providerThreadId ?? null,
          sourceMessageId: row.sourceMessageId ?? null,
          conversationId: row.conversationId ?? null,
          authenticated: true,
          fromEmail: row.fromEmail,
          fromName: row.fromName ?? null,
          subject: row.subject,
          contentTrust: row.contentTrust as RecoverableDirectIngest['contentTrust'],
          hasExternalOrUnknown: row.hasExternalOrUnknown === true,
          emailContentProvenance: isValidEmailContentProvenanceSnapshot(row.emailContentProvenance)
            ? row.emailContentProvenance
            : null,
          directRouting: row.directRouting as RecoverableDirectIngest['directRouting'],
          directRecoveryReason:
            row.directRecoveryReason as RecoverableDirectIngest['directRecoveryReason'],
          classificationStatus:
            row.classificationStatus as RecoverableDirectIngest['classificationStatus'],
          classificationClaimToken: row.classificationClaimToken ?? null,
          preparedClassification: row.preparedClassification ?? null,
          scoreStatus: row.scoreStatus as RecoverableDirectIngest['scoreStatus'],
          scoreClaimToken: row.scoreClaimToken ?? null,
          scoreOutcome: row.scoreOutcome,
          score: {
            category: row.category,
            importance: row.importance,
            actionable: row.actionable,
            reason: row.reason,
            dates: row.dates,
            cardCandidate: row.cardCandidate,
            nextStep: row.nextStep,
          },
          pipelineStage: row.pipelineStage,
          admittedSourceKind: null,
          admittedSourceId: null,
          messagePersisted: false,
          updatedAt: row.updatedAt,
        });
        if (result.length >= cap) break;
      }
      return result;
    });
  }

  async markDirectIngestRecoveryUnavailable(input: {
    agentId: string;
    mailbox: string;
    ingestId: string;
    expectedPrivacyGeneration: string | null;
    lease: EmailSyncLease;
    reason:
      | 'provider_message_missing'
      | 'provider_access_denied'
      | 'provider_temporarily_unavailable'
      | 'checkpoint_inconsistent';
  }): Promise<boolean> {
    if (input.agentId !== this.agentId) throw new Error('Email ingest owner mismatch');
    if (
      ![
        'provider_message_missing',
        'provider_access_denied',
        'provider_temporarily_unavailable',
        'checkpoint_inconsistent',
      ].includes(input.reason)
    )
      throw new Error('Invalid direct recovery reason');
    const mailbox = input.mailbox.trim().toLowerCase();
    await input.lease.assertCurrent();
    return this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        this.store,
        input.agentId,
        input.expectedPrivacyGeneration,
      );
      const owner = await tx.get(this.store.doc('agents', input.agentId));
      if (
        !owner.exists ||
        typeof owner.get('email') !== 'string' ||
        owner.get('email').trim().toLowerCase() !== mailbox
      )
        throw new Error('Direct recovery mailbox is outside owner');
      await this.assertLeaseInTransaction(tx, input.lease);
      const ref = this.store.doc('emailIngest', input.ingestId);
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const row = decodeRecord<Records['emailIngest']>(snap.data());
      if (
        row.agentId !== input.agentId ||
        row.mailbox !== mailbox ||
        row.ingestMode !== 'direct' ||
        row.authenticated !== true ||
        row.messagePersisted !== false ||
        row.admittedSourceKind != null ||
        row.admittedSourceId != null ||
        row.pipelineStage === 'needs_attention'
      )
        return false;
      tx.update(ref, {
        pipelineStage: 'needs_attention',
        directRouting: 'needs_attention',
        directRecoveryReason: input.reason,
        classificationStatus:
          row.classificationStatus === 'in_progress' ? 'unknown' : row.classificationStatus,
        classificationClaimToken: null,
        scoreStatus: row.scoreStatus === 'in_progress' ? 'unknown' : row.scoreStatus,
        scoreOutcome:
          row.scoreStatus === 'in_progress' ? 'provider_outcome_unknown' : row.scoreOutcome,
        scoreClaimToken: null,
        updatedAt: this.store.now(),
      });
      return true;
    });
  }

  async beginForwardedIngest(
    input: NewEmailIngest & { mailbox: string; providerMessageId: string },
    options: { expectedPrivacyGeneration: string | null; lease?: EmailSyncLease } = {
      expectedPrivacyGeneration: null,
    },
  ): Promise<EmailIngestRecord> {
    if (input.agentId !== this.agentId)
      throw new Error('Email ingest is outside the configured owner');
    if (input.ingestMode === 'direct')
      throw new Error('Forwarded email ingest cannot use direct mode');
    if (
      input.emailContentProvenance != null ||
      input.directRouting != null ||
      input.directRecoveryReason != null
    )
      throw new Error('Forwarded email cannot carry direct recovery metadata');
    const id = uuidFrom(['email-ingest', input.channelMessageId]);
    const ref = this.store.doc('emailIngest', id);
    await this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        this.store,
        input.agentId,
        options.expectedPrivacyGeneration,
      );
      if (options.lease) await this.assertLeaseInTransaction(tx, options.lease);
      const [byId, bySource] = await Promise.all([
        tx.get(ref),
        tx.get(this.ingestQuery(input.channelMessageId)),
      ]);
      if (byId.exists || !bySource.empty) {
        const existing = byId.exists ? byId : bySource.docs[0];
        if (!existing || existing.get('agentId') !== input.agentId)
          throw new Error('Email source belongs to another owner');
        return;
      }
      const now = this.store.now();
      const row: Records['emailIngest'] = {
        ...input,
        id,
        createdAt: now,
        updatedAt: now,
        ingestMode: 'forwarded',
        hasExternalOrUnknown: input.hasExternalOrUnknown ?? true,
        observerRegistrySnapshot: null,
        observerRegistryHash: null,
        admittedSourceKind: null,
        admittedSourceId: null,
        directRouting: input.directRouting ?? null,
        directRecoveryReason: input.directRecoveryReason ?? null,
        emailContentProvenance: input.emailContentProvenance ?? null,
        classificationStatus: 'not_required',
        classificationClaimToken: null,
        preparedClassification: null,
        scoreOutcome: 'provider_outcome_unknown',
        pipelineStage: 'pending_score',
        scoreStatus: 'pending',
        scoreClaimToken: null,
        cardCandidate: false,
        nextStep: null,
        messagePersisted: false,
        triageTaskId: null,
        triaged: false,
        extractedAt: null,
        preparedExtraction: null,
        providerThreadId: input.providerThreadId ?? null,
        providerReceivedAt: input.providerReceivedAt ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        securityEvidence: input.securityEvidence ?? null,
        securityIncidentId: input.securityIncidentId ?? null,
        obligationStatus: 'unknown',
        obligationVersion: 0,
        obligationDecision: null,
        obligationDecisionAt: null,
        obligationSnoozedUntil: null,
      };
      tx.create(ref, encodeRecord(row));
    });
    const record = await this.ingestRecord(input.channelMessageId);
    if (!record) throw new Error('email ingest stage could not be created or loaded');
    return record;
  }

  async beginDirectEmailIngest(
    input: NewEmailIngest & { mailbox: string; providerMessageId: string },
    options: { expectedPrivacyGeneration: string | null; lease?: EmailSyncLease },
  ): Promise<EmailIngestRecord> {
    if (
      input.agentId !== this.agentId ||
      input.ingestMode !== 'direct' ||
      input.authenticated !== true
    )
      throw new Error('Direct email ingest requires configured owner and receiver authentication');
    if (input.channelMessageId !== `gmail:${input.providerMessageId}`)
      throw new Error('Direct email source identity is malformed');
    if (
      input.emailContentProvenance != null &&
      (!isValidEmailContentProvenanceSnapshot(input.emailContentProvenance) ||
        input.emailContentProvenance.mode !== 'direct' ||
        input.emailContentProvenance.authenticated !== true ||
        input.emailContentProvenance.hasExternalOrUnknown !== (input.hasExternalOrUnknown ?? true))
    )
      throw new Error('Direct email provenance is invalid or inconsistent');
    if (input.directRouting === 'needs_attention' || input.directRecoveryReason != null)
      throw new Error('Direct recovery terminal state cannot be set during ingest creation');
    const id = uuidFrom(['email-ingest', input.channelMessageId]);
    const ref = this.store.doc('emailIngest', id);
    await this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        this.store,
        input.agentId,
        options.expectedPrivacyGeneration,
      );
      if (options.lease) await this.assertLeaseInTransaction(tx, options.lease);
      const existing = await tx.get(ref);
      if (existing.exists) {
        if (existing.get('agentId') !== input.agentId)
          throw new Error('Email source belongs to another owner');
        return;
      }
      const now = this.store.now();
      const row: Records['emailIngest'] = {
        ...input,
        id,
        createdAt: now,
        updatedAt: now,
        ingestMode: 'direct',
        hasExternalOrUnknown: input.hasExternalOrUnknown ?? true,
        observerRegistrySnapshot: null,
        observerRegistryHash: null,
        admittedSourceKind: null,
        admittedSourceId: null,
        directRouting: input.directRouting ?? null,
        directRecoveryReason: input.directRecoveryReason ?? null,
        emailContentProvenance: input.emailContentProvenance ?? null,
        classificationStatus: input.classificationStatus ?? 'pending',
        classificationClaimToken: null,
        preparedClassification: null,
        scoreOutcome: 'provider_outcome_unknown',
        pipelineStage: 'pending_classification',
        scoreStatus: 'pending',
        scoreClaimToken: null,
        cardCandidate: false,
        nextStep: null,
        messagePersisted: false,
        triageTaskId: null,
        triaged: false,
        extractedAt: null,
        preparedExtraction: null,
        providerThreadId: input.providerThreadId ?? null,
        providerReceivedAt: input.providerReceivedAt ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        securityEvidence: input.securityEvidence ?? null,
        securityIncidentId: input.securityIncidentId ?? null,
        obligationStatus: 'unknown',
        obligationVersion: 0,
        obligationDecision: null,
        obligationDecisionAt: null,
        obligationSnoozedUntil: null,
      };
      tx.create(ref, encodeRecord(row));
    });
    const record = await this.ingestRecord(input.channelMessageId);
    if (!record) throw new Error('direct email ingest stage could not be created or loaded');
    return record;
  }

  async claimIngestClassification(
    agentId: string,
    ingestId: string,
    token: string,
    expectedPrivacyGeneration: string | null,
    lease?: EmailSyncLease,
  ): Promise<boolean> {
    if (agentId !== this.agentId) throw new Error('Email ingest owner mismatch');
    const ref = this.store.doc('emailIngest', ingestId);
    return this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      if (lease) await this.assertLeaseInTransaction(tx, lease);
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        this.store,
        agentId,
        expectedPrivacyGeneration,
      );
      const row = await tx.get(ref);
      if (
        !row.exists ||
        row.get('agentId') !== agentId ||
        row.get('ingestMode') !== 'direct' ||
        row.get('authenticated') !== true ||
        row.get('classificationStatus') !== 'pending'
      )
        return false;
      tx.update(
        ref,
        encodeRecord({
          pipelineStage: 'classifying',
          classificationStatus: 'in_progress',
          classificationClaimToken: token,
          updatedAt: this.store.now(),
        }),
      );
      return true;
    });
  }

  async prepareIngestClassification(
    agentId: string,
    ingestId: string,
    token: string,
    result: { automated: boolean },
    expectedPrivacyGeneration: string | null,
    lease?: EmailSyncLease,
  ): Promise<void> {
    if (agentId !== this.agentId) throw new Error('Email ingest owner mismatch');
    const ref = this.store.doc('emailIngest', ingestId);
    await this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      if (lease) await this.assertLeaseInTransaction(tx, lease);
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        this.store,
        agentId,
        expectedPrivacyGeneration,
      );
      const row = await tx.get(ref);
      if (
        !row.exists ||
        row.get('agentId') !== agentId ||
        row.get('classificationStatus') !== 'in_progress' ||
        row.get('classificationClaimToken') !== token
      )
        throw new Error('Email classification claim is no longer current');
      tx.update(
        ref,
        encodeRecord({
          classificationStatus: 'prepared',
          preparedClassification: result,
          pipelineStage: 'pending_score',
          updatedAt: this.store.now(),
        }),
      );
    });
  }

  async markIngestClassificationUnknown(
    agentId: string,
    ingestId: string,
    token: string,
    fallback: { automated: boolean } | null,
    expectedPrivacyGeneration: string | null,
    lease?: EmailSyncLease,
  ): Promise<void> {
    if (agentId !== this.agentId) throw new Error('Email ingest owner mismatch');
    const ref = this.store.doc('emailIngest', ingestId);
    await this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      if (lease) await this.assertLeaseInTransaction(tx, lease);
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        this.store,
        agentId,
        expectedPrivacyGeneration,
      );
      const row = await tx.get(ref);
      if (
        !row.exists ||
        row.get('agentId') !== agentId ||
        row.get('classificationStatus') !== 'in_progress' ||
        row.get('classificationClaimToken') !== token
      )
        throw new Error('Email classification claim is no longer current');
      tx.update(
        ref,
        encodeRecord({
          classificationStatus: 'unknown',
          preparedClassification: fallback,
          pipelineStage: fallback ? 'pending_score' : 'needs_attention',
          updatedAt: this.store.now(),
        }),
      );
    });
  }

  async claimIngestScore(
    agentId: string,
    ingestId: string,
    token: string,
    expectedPrivacyGeneration: string | null,
    lease?: EmailSyncLease,
    claimOutcome: 'model_prepared' | 'deterministic_no_model' = 'model_prepared',
  ): Promise<boolean> {
    if (agentId !== this.agentId) throw new Error('Email ingest owner mismatch');
    const ref = this.store.doc('emailIngest', ingestId);
    return this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      if (lease) await this.assertLeaseInTransaction(tx, lease);
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        this.store,
        agentId,
        expectedPrivacyGeneration,
      );
      const snapshot = await tx.get(ref);
      if (
        !snapshot.exists ||
        snapshot.get('agentId') !== agentId ||
        snapshot.get('pipelineStage') !== 'pending_score' ||
        snapshot.get('scoreStatus') !== 'pending'
      )
        return false;
      tx.update(
        ref,
        encodeRecord({
          pipelineStage: 'scoring',
          scoreStatus: 'in_progress',
          scoreClaimToken: token,
          scoreOutcome: claimOutcome,
          updatedAt: this.store.now(),
        }),
      );
      return true;
    });
  }

  async markIngestScoreBudgetBlocked(
    agentId: string,
    ingestId: string,
    token: string,
    expectedPrivacyGeneration: string | null,
    lease?: EmailSyncLease,
  ): Promise<void> {
    if (agentId !== this.agentId) throw new Error('Email ingest owner mismatch');
    const ref = this.store.doc('emailIngest', ingestId);
    await this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      if (lease) await this.assertLeaseInTransaction(tx, lease);
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        this.store,
        agentId,
        expectedPrivacyGeneration,
      );
      const snapshot = await tx.get(ref);
      if (
        !snapshot.exists ||
        snapshot.get('agentId') !== agentId ||
        snapshot.get('pipelineStage') !== 'scoring' ||
        snapshot.get('scoreStatus') !== 'in_progress' ||
        snapshot.get('scoreOutcome') !== 'model_prepared' ||
        snapshot.get('scoreClaimToken') !== token
      )
        return;
      tx.update(
        ref,
        encodeRecord({
          pipelineStage: 'pending_score',
          scoreStatus: 'pending',
          scoreClaimToken: null,
          scoreOutcome: 'budget_blocked',
          updatedAt: this.store.now(),
        }),
      );
    });
  }

  async markIngestScoreUnknown(
    agentId: string,
    ingestId: string,
    token: string,
    expectedPrivacyGeneration: string | null,
    lease?: EmailSyncLease,
  ): Promise<void> {
    if (agentId !== this.agentId) throw new Error('Email ingest owner mismatch');
    const ref = this.store.doc('emailIngest', ingestId);
    await this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      if (lease) await this.assertLeaseInTransaction(tx, lease);
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        this.store,
        agentId,
        expectedPrivacyGeneration,
      );
      const snapshot = await tx.get(ref);
      if (
        !snapshot.exists ||
        snapshot.get('agentId') !== agentId ||
        snapshot.get('pipelineStage') !== 'scoring' ||
        snapshot.get('scoreStatus') !== 'in_progress' ||
        snapshot.get('scoreClaimToken') !== token
      )
        return;
      tx.update(
        ref,
        encodeRecord({
          pipelineStage: 'needs_attention',
          scoreStatus: 'unknown',
          scoreOutcome: 'provider_outcome_unknown',
          updatedAt: this.store.now(),
        }),
      );
    });
  }

  async prepareIngestScore(
    agentId: string,
    ingestId: string,
    token: string,
    score: PreparedEmailScore,
    expectedPrivacyGeneration: string | null,
    lease?: EmailSyncLease,
    expectedClaimOutcome: 'model_prepared' | 'deterministic_no_model' = 'model_prepared',
  ): Promise<void> {
    if (agentId !== this.agentId) throw new Error('Email ingest owner mismatch');
    const ref = this.store.doc('emailIngest', ingestId);
    await this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      if (lease) await this.assertLeaseInTransaction(tx, lease);
      const [snapshot, erasureJob] = await Promise.all([
        tx.get(ref),
        tx.get(this.store.doc('privacyErasureJobs', this.agentId)),
      ]);
      const generation = erasureJob.exists ? erasureJob.get('generation') : null;
      if (
        (erasureJob.exists &&
          (erasureJob.get('agentId') !== agentId ||
            privacyErasureIsActive(erasureJob.get('status')))) ||
        (typeof generation === 'string' ? generation : null) !== expectedPrivacyGeneration
      )
        throw new Error('Privacy erasure changed during email scoring');
      if (
        !snapshot.exists ||
        snapshot.get('agentId') !== agentId ||
        snapshot.get('pipelineStage') !== 'scoring' ||
        snapshot.get('scoreClaimToken') !== token ||
        snapshot.get('scoreOutcome') !== expectedClaimOutcome
      )
        throw new Error('email scoring claim is no longer current');

      const source = decodeRecord<Records['emailIngest']>(snapshot.data());
      const lifecycleDates = (
        source.authenticated === true && source.providerReceivedAt instanceof Date
          ? (Array.isArray(score.dates) ? score.dates : []).flatMap((candidate: unknown) => {
              if (
                !candidate ||
                typeof candidate !== 'object' ||
                !('lifecycle' in candidate) ||
                !['confirmed', 'cancelled', 'rescheduled', 'tentative'].includes(
                  String(candidate.lifecycle),
                ) ||
                !('bookingIdentity' in candidate) ||
                typeof candidate.bookingIdentity !== 'string'
              )
                return [];
              return [{ ...candidate, bookingIdentity: candidate.bookingIdentity }];
            })
          : []
      ) as Array<Record<string, unknown> & { lifecycle: string; bookingIdentity: string }>;
      const grouped = new Map<string, typeof lifecycleDates>();
      for (const candidate of lifecycleDates) {
        const key = emailBookingKey(this.agentId, candidate.bookingIdentity);
        grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
      }
      const occurrenceWork = [] as Array<{
        key: string;
        ref: ReturnType<InstallationStore['doc']>;
        dates: typeof lifecycleDates;
        current: Records['emailBookingOccurrences'] | null;
        apply: boolean;
      }>;
      for (const [key, dates] of grouped) {
        const ref = this.store.doc(
          'emailBookingOccurrences',
          emailBookingOccurrenceId(this.agentId, key),
        );
        const currentSnapshot = await tx.get(ref);
        const current = currentSnapshot.exists
          ? decodeRecord<Records['emailBookingOccurrences']>(currentSnapshot.data())
          : null;
        const receivedAt = source.providerReceivedAt;
        const apply = emailBookingObservationIsNewer(receivedAt!, source.channelMessageId, current);
        occurrenceWork.push({ key, ref, dates, current, apply });
      }
      const supersedeSnapshots = await Promise.all(
        occurrenceWork
          .filter(
            (item) =>
              item.apply && ['cancelled', 'rescheduled'].includes(String(item.dates[0]?.lifecycle)),
          )
          .map((item) =>
            tx.get(
              this.store
                .collection('suggestions')
                .where('agentId', '==', this.agentId)
                .where('bookingKey', '==', item.key)
                .where('status', 'in', ['pending', 'snoozed'])
                .limit(200),
            ),
          ),
      );
      tx.update(
        ref,
        encodeRecord({
          ...score,
          securityEvidence: score.securityEvidence ?? null,
          pipelineStage: 'score_prepared',
          scoreStatus: 'prepared',
          scoreOutcome: expectedClaimOutcome,
          updatedAt: this.store.now(),
        }),
      );
      const now = this.store.now();
      for (const item of occurrenceWork) {
        if (!item.apply) continue;
        const row: Records['emailBookingOccurrences'] = {
          id: item.ref.id,
          agentId: this.agentId,
          bookingKey: item.key,
          lifecycle: String(item.dates[0]?.lifecycle ?? 'unknown'),
          dates: item.dates,
          sourceChannelMessageId: source.channelMessageId,
          sourceReceivedAt: source.providerReceivedAt!,
          sourceAuthenticated: true,
          version: (item.current?.version ?? 0) + 1,
          createdAt: item.current?.createdAt ?? now,
          updatedAt: now,
        };
        if (item.current) tx.set(item.ref, encodeRecord(row));
        else tx.create(item.ref, encodeRecord(row));
      }
      for (const page of supersedeSnapshots) {
        for (const suggestion of page.docs) {
          const data = decodeRecord<Records['suggestions']>(suggestion.data());
          if (data.agentId === this.agentId && ['pending', 'snoozed'].includes(data.status))
            tx.update(suggestion.ref, encodeRecord({ status: 'superseded', updatedAt: now }));
        }
      }
    });
  }

  async prepareIngestScoreDeterministic(
    agentId: string,
    ingestId: string,
    token: string,
    score: PreparedEmailScore,
    expectedPrivacyGeneration: string | null,
    lease?: EmailSyncLease,
  ): Promise<void> {
    await this.prepareIngestScore(
      agentId,
      ingestId,
      token,
      score,
      expectedPrivacyGeneration,
      lease,
      'deterministic_no_model',
    );
  }

  async prepareIngestScoreFallbackUnknown(
    agentId: string,
    ingestId: string,
    token: string,
    score: PreparedEmailScore,
    expectedPrivacyGeneration: string | null,
    lease?: EmailSyncLease,
  ): Promise<void> {
    if (agentId !== this.agentId) throw new Error('Email ingest owner mismatch');
    const ref = this.store.doc('emailIngest', ingestId);
    await this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      if (lease) await this.assertLeaseInTransaction(tx, lease);
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        this.store,
        agentId,
        expectedPrivacyGeneration,
      );
      const snapshot = await tx.get(ref);
      if (
        !snapshot.exists ||
        snapshot.get('agentId') !== agentId ||
        snapshot.get('pipelineStage') !== 'scoring' ||
        snapshot.get('scoreStatus') !== 'in_progress' ||
        snapshot.get('scoreClaimToken') !== token
      )
        throw new Error('Email scoring claim is no longer current');
      tx.update(
        ref,
        encodeRecord({
          ...score,
          securityEvidence: score.securityEvidence ?? null,
          pipelineStage: 'score_prepared',
          scoreStatus: 'unknown',
          scoreOutcome: 'fallback_committed_unknown',
          scoreClaimToken: token,
          updatedAt: this.store.now(),
        }),
      );
    });
  }

  async markIngestMessagePersisted(
    ingestId: string,
    conversationId: string,
    lease?: EmailSyncLease,
  ): Promise<void> {
    const ref = this.store.doc('emailIngest', ingestId);
    await this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      if (lease) await this.assertLeaseInTransaction(tx, lease);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) throw new Error('email ingest stage is unavailable');
      if (snapshot.get('scoreStatus') !== 'prepared') {
        if (snapshot.get('messagePersisted') === true) return;
        throw new Error('email ingest score is not prepared for source checkpoint');
      }
      tx.update(
        ref,
        encodeRecord({
          conversationId,
          messagePersisted: true,
          pipelineStage: 'message_persisted',
          updatedAt: this.store.now(),
        }),
      );
    });
  }

  async commitEmailAdmission(
    input: EmailAdmissionCommitInput,
  ): Promise<EmailAdmissionCommitResult> {
    if (input.agentId !== this.agentId || input.finalizedIngest.agentId !== this.agentId)
      throw new Error('Email admission owner mismatch');
    const channelMessageId = input.finalizedIngest.channelMessageId;
    if (!channelMessageId.startsWith('gmail:'))
      throw new Error('Email channel message id is invalid');
    if (
      input.source.kind === 'message' &&
      input.source.message.channelMessageId !== channelMessageId
    )
      throw new Error('Email message source id does not match its ingest row');
    if (input.source.kind === 'automated_source' && input.source.body.length > 20_000)
      throw new Error('Automated email source body exceeds its durable bound');
    const snapshot = normalizeObserverSnapshot(input.observers);
    const registryHash = observerSnapshotHash(snapshot);
    const ingestRef = this.store.doc('emailIngest', uuidFrom(['email-ingest', channelMessageId]));
    return this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        this.store,
        input.agentId,
        input.expectedPrivacyGeneration,
      );
      const storedSnapshot = await tx.get(ingestRef);
      if (
        !storedSnapshot.exists ||
        storedSnapshot.get('id') !== input.ingestId ||
        storedSnapshot.get('agentId') !== input.agentId ||
        storedSnapshot.get('channelMessageId') !== channelMessageId
      )
        throw new Error('Email admission checkpoint is unavailable or belongs to another owner');
      const stored = decodeRecord<Records['emailIngest']>(storedSnapshot.data());
      if (
        input.finalizedIngest.emailContentProvenance != null &&
        (!isValidEmailContentProvenanceSnapshot(input.finalizedIngest.emailContentProvenance) ||
          input.finalizedIngest.emailContentProvenance.mode !== 'direct' ||
          input.finalizedIngest.emailContentProvenance.authenticated !== stored.authenticated ||
          input.finalizedIngest.emailContentProvenance.hasExternalOrUnknown !==
            stored.hasExternalOrUnknown)
      )
        throw new Error('Direct email provenance is invalid or inconsistent');
      if (
        stored.emailContentProvenance != null &&
        !isValidEmailContentProvenanceSnapshot(stored.emailContentProvenance)
      )
        throw new Error('Stored direct email provenance is malformed');
      if (stored.ingestMode === 'direct' && stored.authenticated !== true)
        throw new Error('Unauthenticated direct email cannot be admitted');
      const requestedRoute = input.finalizedIngest.directRouting;
      if (
        requestedRoute !== undefined &&
        requestedRoute !== null &&
        !['application_confirmation', 'email_triage'].includes(requestedRoute)
      )
        throw new Error('Direct email admission route is invalid');
      if (stored.ingestMode !== 'direct' && requestedRoute != null)
        throw new Error('Only direct email may carry a direct routing decision');
      if (
        stored.directRouting != null &&
        requestedRoute != null &&
        stored.directRouting !== requestedRoute
      )
        throw new Error('Direct email routing decision is immutable');
      if (
        stored.emailContentProvenance != null &&
        input.finalizedIngest.emailContentProvenance != null &&
        !isDeepStrictEqual(
          stored.emailContentProvenance,
          input.finalizedIngest.emailContentProvenance,
        )
      )
        throw new Error('Direct email provenance is immutable');
      const storedClassification = stored.preparedClassification as { automated?: unknown } | null;
      if (
        input.source.kind === 'automated_source' &&
        (stored.ingestMode !== 'direct' ||
          stored.authenticated !== true ||
          stored.classificationStatus !== 'prepared' ||
          storedClassification?.automated !== true)
      )
        throw new Error(
          'Canonical automated source requires the stored authenticated direct automated verdict',
        );
      if (input.lease) await this.assertLeaseInTransaction(tx, input.lease);

      const frozenSnapshotValue = storedSnapshot.get('observerRegistrySnapshot');
      if (frozenSnapshotValue !== null && frozenSnapshotValue !== undefined) {
        const frozen = normalizeObserverSnapshot(
          frozenSnapshotValue as EmailAdmissionCommitInput['observers'],
        );
        if (storedSnapshot.get('observerRegistryHash') !== observerSnapshotHash(frozen))
          throw new Error('Stored email observer registry snapshot is corrupt');
        const frozenIds = frozen.map((item) =>
          emailObserverWorkId(input.agentId, channelMessageId, item.key, item.version),
        );
        const refs = frozenIds.map((id) => this.store.doc('emailObserverWork', id));
        const rows = refs.length ? await tx.getAll(...refs) : [];
        if (rows.some((row) => !row.exists || row.get('agentId') !== input.agentId))
          throw new Error(
            'Frozen email observer work rows are incomplete; explicit repair is required',
          );
        const channelRef = this.store.doc('messageChannelIds', channelMessageId);
        const automatedRef = this.store.doc(
          'emailObserverSources',
          emailObserverSourceId(input.agentId, channelMessageId),
        );
        const [channel, automated, automatedByChannel] = await Promise.all([
          tx.get(channelRef),
          tx.get(automatedRef),
          tx.get(
            this.store
              .collection('emailObserverSources')
              .where('channelMessageId', '==', channelMessageId),
          ),
        ]);
        if (
          automatedByChannel.size > 1 ||
          (automatedByChannel.size === 1 && automatedByChannel.docs[0]?.id !== automatedRef.id)
        )
          throw new Error('Email automated source identity is already bound to another owner');
        if (channel.exists && automated.exists)
          throw new Error('Email source exists in both canonical body stores');
        const kind = stored.admittedSourceKind;
        const id = stored.admittedSourceId;
        if (!kind || !id)
          throw new Error('Frozen email admission is missing its canonical source pointer');
        if (kind === 'message') {
          if (!channel.exists || channel.get('messageId') !== id || automated.exists)
            throw new Error('Frozen visible email source is missing or mismatched');
          const messageRef = this.store.doc('messages', id);
          const message = await tx.get(messageRef);
          if (
            !message.exists ||
            typeof message.get('conversationId') !== 'string' ||
            channel.get('conversationId') !== message.get('conversationId')
          )
            throw new Error('Frozen visible email message is missing');
          const conversation = await tx.get(
            this.store.doc('conversations', String(message.get('conversationId'))),
          );
          if (!conversation.exists || conversation.get('agentId') !== input.agentId)
            throw new Error('Frozen visible email source belongs to another owner');
          return {
            messageId: id,
            sourceId: id,
            ingestId: input.ingestId,
            observerIds: frozenIds,
            duplicate: true,
          };
        }
        if (
          kind !== 'automated_source' ||
          !automated.exists ||
          automated.get('id') !== id ||
          channel.exists ||
          automated.get('agentId') !== input.agentId ||
          automated.get('sourceKey') !== channelMessageId ||
          automated.get('privacyGeneration') !== input.expectedPrivacyGeneration
        )
          throw new Error('Frozen automated email source is missing or mismatched');
        return {
          messageId: null,
          sourceId: id,
          ingestId: input.ingestId,
          observerIds: frozenIds,
          duplicate: true,
        };
      }
      if (
        stored.messagePersisted ||
        stored.pipelineStage === 'message_persisted' ||
        stored.admittedSourceKind !== null ||
        stored.admittedSourceId !== null
      )
        throw new Error('Legacy persisted email requires explicit bounded observer reprocessing');
      const scorePrepared =
        stored.scoreStatus === 'prepared' && stored.scoreClaimToken === input.scoreClaimToken;
      const fallbackCommitted =
        stored.scoreStatus === 'unknown' &&
        stored.scoreOutcome === 'fallback_committed_unknown' &&
        stored.scoreClaimToken === input.scoreClaimToken;
      if (!scorePrepared && !fallbackCommitted)
        throw new Error(
          'Email admission requires a durably prepared score or explicit stored fallback',
        );

      const channelRef = this.store.doc('messageChannelIds', channelMessageId);
      const automatedRef = this.store.doc(
        'emailObserverSources',
        emailObserverSourceId(input.agentId, channelMessageId),
      );
      const [channel, automated, automatedByChannel] = await Promise.all([
        tx.get(channelRef),
        tx.get(automatedRef),
        tx.get(
          this.store
            .collection('emailObserverSources')
            .where('channelMessageId', '==', channelMessageId),
        ),
      ]);
      if (
        automatedByChannel.size > 1 ||
        (automatedByChannel.size === 1 && automatedByChannel.docs[0]?.id !== automatedRef.id)
      )
        throw new Error('Email automated source identity is already bound to another owner');
      if (channel.exists && automated.exists)
        throw new Error('Email source exists in both canonical body stores');
      let messageId: string | null = null;
      let sourceId: string;
      let sourceKind: 'message' | 'automated_source';
      let conversationRef: FirebaseFirestore.DocumentReference | null = null;
      let conversationSnapshot: FirebaseFirestore.DocumentSnapshot | null = null;
      if (input.source.kind === 'message') {
        if (automated.exists)
          throw new Error('Email source already exists in the automated canonical store');
        sourceKind = 'message';
        conversationRef = this.store.doc('conversations', input.source.message.conversationId);
        conversationSnapshot = await tx.get(conversationRef);
        if (!conversationSnapshot.exists || conversationSnapshot.get('agentId') !== input.agentId)
          throw new Error('Email conversation belongs to another owner');
        if (channel.exists) {
          const existingId = channel.get('messageId');
          if (
            typeof existingId !== 'string' ||
            channel.get('conversationId') !== input.source.message.conversationId
          )
            throw new Error('Email channel identity is already bound to another conversation');
          const existingMessage = await tx.get(this.store.doc('messages', existingId));
          if (
            !existingMessage.exists ||
            existingMessage.get('conversationId') !== input.source.message.conversationId
          )
            throw new Error('Existing email source message is missing or mismatched');
          messageId = existingId;
        }
      } else {
        if (channel.exists) throw new Error('Email source already exists as a visible message');
        sourceKind = 'automated_source';
        if (
          automated.exists &&
          (automated.get('agentId') !== input.agentId ||
            automated.get('sourceKey') !== channelMessageId ||
            automated.get('privacyGeneration') !== input.expectedPrivacyGeneration ||
            automated.get('body') !== input.source.body)
        )
          throw new Error('Canonical automated source conflicts with an existing owner or body');
      }
      const workRefs = snapshot.map((item) =>
        this.store.doc(
          'emailObserverWork',
          emailObserverWorkId(input.agentId, channelMessageId, item.key, item.version),
        ),
      );
      const existingWork = workRefs.length ? await tx.getAll(...workRefs) : [];
      if (existingWork.some((row) => row.exists))
        throw new Error('Email observer work existed before its atomic admission');
      const now = this.store.now();
      if (input.source.kind === 'message') {
        if (!messageId) {
          messageId = randomUUID();
          const messageRef = this.store.doc('messages', messageId);
          tx.create(
            messageRef,
            encodeRecord(
              messageRecord(
                {
                  ...input.source.message,
                  role: 'user',
                  origin:
                    stored.contentTrust === 'owner'
                      ? 'owner'
                      : stored.contentTrust === 'known'
                        ? 'known_contact'
                        : 'unknown',
                },
                messageId,
                now,
              ),
            ),
          );
          tx.create(
            channelRef,
            encodeRecord({ messageId, conversationId: input.source.message.conversationId }),
          );
          tx.update(conversationRef!, encodeRecord({ updatedAt: now }));
        }
        sourceId = messageId;
      } else {
        const automatedId = emailObserverSourceId(input.agentId, channelMessageId);
        if (!automated.exists) {
          const sourceRow: Records['emailObserverSources'] = {
            id: automatedId,
            agentId: input.agentId,
            sourceKey: channelMessageId,
            channelMessageId,
            body: input.source.body,
            privacyGeneration: input.expectedPrivacyGeneration,
            createdAt: now,
            updatedAt: now,
          };
          tx.create(automatedRef, encodeRecord(sourceRow));
        }
        sourceId = automatedId;
      }
      const updatedIngest: Records['emailIngest'] = {
        ...stored,
        conversationId:
          input.source.kind === 'message' ? input.source.message.conversationId : null,
        messagePersisted: input.source.kind === 'message',
        pipelineStage: 'message_persisted',
        observerRegistrySnapshot: snapshot,
        observerRegistryHash: registryHash,
        admittedSourceKind: sourceKind,
        admittedSourceId: sourceId,
        directRouting: input.finalizedIngest.directRouting ?? stored.directRouting ?? null,
        emailContentProvenance:
          input.finalizedIngest.emailContentProvenance ?? stored.emailContentProvenance ?? null,
        updatedAt: now,
      };
      tx.set(ingestRef, encodeRecord(updatedIngest));
      for (let index = 0; index < snapshot.length; index++) {
        const observer = snapshot[index]!;
        const workId = emailObserverWorkId(
          input.agentId,
          channelMessageId,
          observer.key,
          observer.version,
        );
        const row: Records['emailObserverWork'] = {
          id: workId,
          agentId: input.agentId,
          sourceKey: channelMessageId,
          channelMessageId,
          sourceKind,
          observerKey: observer.key,
          observerVersion: observer.version,
          workClass: observer.workClass,
          status: 'pending',
          attemptCount: 0,
          claimToken: null,
          claimGeneration: 0,
          leaseExpiresAt: null,
          privacyGeneration: input.expectedPrivacyGeneration,
          budgetKey: null,
          budgetWindowStart: null,
          budgetReserved: false,
          preparedResult: null,
          deliveryKey: null,
          lastErrorCode: null,
          claimedAt: null,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        tx.create(workRefs[index]!, encodeRecord(row));
      }
      return {
        messageId,
        sourceId,
        ingestId: input.ingestId,
        observerIds: snapshot.map((item) =>
          emailObserverWorkId(input.agentId, channelMessageId, item.key, item.version),
        ),
        duplicate: false,
      };
    });
  }
  async listDueEmailObservers(
    agentId: string,
    now: Date,
    limit: number,
    excludedObserverIdentities?: readonly EmailObserverIdentity[],
  ): Promise<EmailObserverWorkRecord[]> {
    if (agentId !== this.agentId) throw new Error('Email observer owner mismatch');
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const collection = this.store.collection('emailObserverWork').where('agentId', '==', agentId);
    const excluded = [...(excludedObserverIdentities ?? [])];
    if (
      excluded.length > 10 ||
      excluded.some(
        ({ key, version, workClass }) =>
          !key.trim() ||
          !Number.isSafeInteger(version) ||
          version < 1 ||
          !['idempotent_db', 'paid_ambiguous', 'external_provider'].includes(workClass),
      ) ||
      new Set(excluded.map(({ key, version }) => `${key}\u0000${version}`)).size !== excluded.length
    )
      throw new Error('Email observer exclusions are invalid or exceed the registry bound');
    const excludedKeys = [...new Set(excluded.map(({ key }) => key))];
    // Firestore's not-in filter accepts at most ten values. Reject larger
    // disabled registries rather than fall back to a page that can starve
    // enabled work behind disabled rows.
    const queryStatus = async (status: string, expiredOnly = false) => {
      const base = () => {
        let due = collection.where('status', '==', status);
        if (expiredOnly) due = due.where('leaseExpiresAt', '<=', now);
        return due;
      };
      let eligible = base();
      if (excludedKeys.length) {
        eligible = eligible.where('observerKey', 'not-in', excludedKeys);
        if (expiredOnly) eligible = eligible.orderBy('leaseExpiresAt', 'asc');
        eligible = eligible.orderBy('observerKey', 'asc');
      } else if (expiredOnly) {
        eligible = eligible.orderBy('leaseExpiresAt', 'asc');
      }
      const baseDocs = (await eligible.limit(bounded).get()).docs;
      const extraDocs = await Promise.all(
        [...new Set(excluded.map(({ key }) => key))].map(async (key) => {
          const identities = excluded.filter((identity) => identity.key === key);
          const versions = [...new Set(identities.map(({ version }) => version))];
          let otherVersionQuery = base()
            .where('observerKey', '==', key)
            .where('observerVersion', 'not-in', versions);
          if (expiredOnly)
            otherVersionQuery = otherVersionQuery
              .orderBy('leaseExpiresAt', 'asc')
              .orderBy('observerVersion', 'asc');
          else otherVersionQuery = otherVersionQuery.orderBy('observerVersion', 'asc');
          const otherVersions = await otherVersionQuery.limit(bounded).get();
          const otherClasses = await Promise.all(
            identities.map(async (identity) => {
              let otherClassQuery = base()
                .where('observerKey', '==', key)
                .where('observerVersion', '==', identity.version)
                .where('workClass', '!=', identity.workClass);
              if (expiredOnly)
                otherClassQuery = otherClassQuery
                  .orderBy('leaseExpiresAt', 'asc')
                  .orderBy('workClass', 'asc');
              else otherClassQuery = otherClassQuery.orderBy('workClass', 'asc');
              return otherClassQuery.limit(bounded).get();
            }),
          );
          return [...otherVersions.docs, ...otherClasses.flatMap((snapshot) => snapshot.docs)];
        }),
      );
      return [...baseDocs, ...extraDocs.flat()];
    };
    const [readyByStatus, expired] = await Promise.all([
      Promise.all(['pending', 'retryable_failed', 'prepared'].map((status) => queryStatus(status))),
      queryStatus('claimed', true),
    ]);
    const byId = new Map<string, EmailObserverWorkRecord>();
    const excludedSet = new Set(
      excluded.map(({ key, version, workClass }) => `${key}\u0000${version}\u0000${workClass}`),
    );
    for (const doc of [...readyByStatus.flat(), ...expired]) {
      const row = observerRecord(doc);
      const identityKey = `${row.observerKey}\u0000${row.observerVersion}\u0000${row.workClass}`;
      if (!excludedSet.has(identityKey)) byId.set(doc.id, row);
    }
    return [...byId.values()]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, bounded);
  }

  async claimEmailObserver(input: {
    id: string;
    agentId: string;
    token: string;
    now: Date;
    leaseMs: number;
    expectedPrivacyGeneration: string | null;
    paidBudget?: import('@assistant/persistence').EmailObserverBudgetInput;
  }): Promise<EmailObserverClaimResult> {
    if (input.agentId !== this.agentId) throw new Error('Email observer owner mismatch');
    if (!input.token || input.leaseMs < 1 || input.leaseMs > 600_000)
      throw new Error('Email observer claim lease is invalid');
    const ref = this.store.doc('emailObserverWork', input.id);
    return this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        this.store,
        input.agentId,
        input.expectedPrivacyGeneration,
      );
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return { kind: 'none' } as const;
      const row = observerRecord(snapshot);
      if (
        row.agentId !== input.agentId ||
        row.privacyGeneration !== input.expectedPrivacyGeneration
      )
        return { kind: 'none' } as const;
      const now = this.store.now();
      const expired =
        ['claimed', 'prepared'].includes(row.status) &&
        (!row.leaseExpiresAt || row.leaseExpiresAt <= now);
      const preparedResume =
        row.preparedResult !== null &&
        (row.status === 'prepared' || row.status === 'retryable_failed' || expired);
      if (['claimed', 'prepared'].includes(row.status) && !expired)
        return { kind: 'none' } as const;
      if (row.status === 'prepared' && row.preparedResult === null) {
        tx.update(
          ref,
          encodeRecord({
            status: 'unknown',
            claimToken: null,
            leaseExpiresAt: null,
            updatedAt: now,
          }),
        );
        return { kind: 'none' } as const;
      }
      if (
        preparedResume &&
        row.workClass === 'paid_ambiguous' &&
        (!row.budgetReserved || row.budgetKey !== row.observerKey || !row.budgetWindowStart)
      )
        throw new Error('Prepared paid observer is missing its original budget reservation');
      if (expired && !preparedResume && row.workClass !== 'idempotent_db') {
        tx.update(
          ref,
          encodeRecord({
            status: 'unknown',
            claimToken: null,
            leaseExpiresAt: null,
            updatedAt: now,
          }),
        );
        return { kind: 'none' } as const;
      }
      if (
        !['pending', 'retryable_failed', 'prepared'].includes(row.status) &&
        !(expired && row.workClass === 'idempotent_db')
      )
        return { kind: 'none' } as const;
      let budgetReserved = row.budgetReserved;
      let budgetKey = row.budgetKey;
      let budgetWindowStart = row.budgetWindowStart;
      let budgetRef: FirebaseFirestore.DocumentReference | null = null;
      let budget: Records['emailObserverBudgets'] | null = null;
      if (row.workClass === 'paid_ambiguous' && !budgetReserved) {
        const config = input.paidBudget;
        if (
          !config ||
          config.budgetKey !== row.observerKey ||
          config.observerKey !== row.observerKey ||
          !Number.isInteger(config.limit) ||
          config.limit < 0 ||
          config.limit > 1000 ||
          config.windowStart.getUTCHours() ||
          config.windowStart.getUTCMinutes() ||
          config.windowStart.getUTCSeconds() ||
          config.windowStart.getUTCMilliseconds() ||
          config.windowEnd.getTime() - config.windowStart.getTime() !== 86_400_000 ||
          now < config.windowStart ||
          now >= config.windowEnd
        )
          throw new Error('Paid email observer claim requires a matching UTC-day budget');
        const bucketId = emailObserverBudgetId(input.agentId, row.observerKey, config.windowStart);
        budgetRef = this.store.doc('emailObserverBudgets', bucketId);
        const bucketSnapshot = await tx.get(budgetRef);
        if (bucketSnapshot.exists) {
          budget = decodeRecord<Records['emailObserverBudgets']>(bucketSnapshot.data());
          if (
            budget.agentId !== input.agentId ||
            budget.observerKey !== row.observerKey ||
            budget.limit !== config.limit ||
            budget.utcWindowEnd.getTime() !== config.windowEnd.getTime()
          )
            throw new Error(
              'Paid email observer budget configuration changed for an active window',
            );
        } else {
          budget = {
            id: bucketId,
            agentId: input.agentId,
            observerKey: row.observerKey,
            utcWindowStart: config.windowStart,
            utcWindowEnd: config.windowEnd,
            reservedCount: 0,
            limit: config.limit,
            createdAt: now,
            updatedAt: now,
          };
        }
        if (config.limit === 0 || budget.reservedCount >= config.limit) {
          tx.update(
            ref,
            encodeRecord({
              status: 'skipped_budget',
              claimToken: null,
              leaseExpiresAt: null,
              updatedAt: now,
            }),
          );
          return { kind: 'skipped_budget', id: row.id } as const;
        }
        budgetReserved = true;
        budgetKey = row.observerKey;
        budgetWindowStart = config.windowStart;
      }
      if (budgetRef && budget) {
        tx.set(
          budgetRef,
          encodeRecord({ ...budget, reservedCount: budget.reservedCount + 1, updatedAt: now }),
        );
      }
      const claim: EmailObserverClaim = {
        ...row,
        status: preparedResume ? 'prepared' : 'claimed',
        attemptCount: row.attemptCount + (preparedResume ? 0 : 1),
        claimToken: input.token,
        claimGeneration: row.claimGeneration + 1,
        leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
        claimedAt: now,
        budgetReserved,
        budgetKey,
        budgetWindowStart,
        updatedAt: now,
      };
      tx.set(ref, encodeRecord(claim));
      return { kind: 'claimed', claim } as const;
    });
  }

  async claimNextEmailObserver(input: {
    agentId: string;
    token: string;
    now: Date;
    leaseMs: number;
    limit?: number;
    expectedPrivacyGeneration: string | null;
    paidBudget?: import('@assistant/persistence').EmailObserverBudgetInput;
  }): Promise<EmailObserverClaimResult> {
    for (const row of await this.listDueEmailObservers(
      input.agentId,
      input.now,
      input.limit ?? 32,
    )) {
      const result = await this.claimEmailObserver({ ...input, id: row.id });
      if (result.kind !== 'none') return result;
    }
    return { kind: 'none' };
  }

  async loadEmailObserverSource(claim: EmailObserverClaim): Promise<EmailObserverSource | null> {
    if (claim.agentId !== this.agentId) return null;
    return this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        this.store,
        claim.agentId,
        claim.privacyGeneration,
      );
      const workRef = this.store.doc('emailObserverWork', claim.id);
      const [workSnapshot] = await tx.getAll(workRef);
      if (!workSnapshot?.exists) return null;
      const work = observerRecord(workSnapshot);
      if (
        work.agentId !== claim.agentId ||
        work.claimToken !== claim.claimToken ||
        work.claimGeneration !== claim.claimGeneration ||
        work.sourceKey !== claim.sourceKey ||
        work.channelMessageId !== claim.channelMessageId ||
        work.sourceKind !== claim.sourceKind ||
        work.privacyGeneration !== claim.privacyGeneration
      )
        return null;
      const ingestSnapshot = await tx.get(
        this.store.doc('emailIngest', uuidFrom(['email-ingest', work.channelMessageId])),
      );
      if (!ingestSnapshot?.exists) return null;
      const ingest = decodeRecord<Records['emailIngest']>(ingestSnapshot.data());
      if (
        work.agentId !== claim.agentId ||
        work.claimToken !== claim.claimToken ||
        work.claimGeneration !== claim.claimGeneration ||
        work.sourceKey !== claim.sourceKey ||
        work.channelMessageId !== claim.channelMessageId ||
        work.sourceKind !== claim.sourceKind ||
        !['claimed', 'prepared'].includes(work.status) ||
        (work.leaseExpiresAt?.getTime() ?? 0) <= this.store.now().getTime() ||
        ingest.agentId !== claim.agentId ||
        work.privacyGeneration !== claim.privacyGeneration ||
        ingest.admittedSourceKind !== work.sourceKind ||
        (ingest.ingestMode === 'direct' && ingest.authenticated !== true) ||
        (ingest.ingestMode !== 'direct' && ingest.ingestMode !== 'forwarded')
      )
        return null;
      if (!['owner', 'known', 'unknown'].includes(ingest.contentTrust)) return null;
      let body: string;
      let messageId: string | null = null;
      let origin: EmailObserverSource['origin'] = null;
      let sourceId: string;
      if (work.sourceKind === 'automated_source') {
        const sourceRef = this.store.doc(
          'emailObserverSources',
          emailObserverSourceId(claim.agentId, work.sourceKey),
        );
        const sourceSnapshot = await tx.get(sourceRef);
        if (
          !sourceSnapshot.exists ||
          sourceSnapshot.get('agentId') !== claim.agentId ||
          sourceSnapshot.get('privacyGeneration') !== claim.privacyGeneration ||
          sourceSnapshot.get('id') !== ingest.admittedSourceId
        )
          return null;
        const source = decodeRecord<Records['emailObserverSources']>(sourceSnapshot.data());
        body = source.body;
        sourceId = source.id;
      } else {
        const channelRef = this.store.doc('messageChannelIds', work.channelMessageId);
        const channel = await tx.get(channelRef);
        const resolvedId = channel.exists ? channel.get('messageId') : null;
        if (typeof resolvedId !== 'string' || ingest.admittedSourceId !== resolvedId) return null;
        const messageSnapshot = await tx.get(this.store.doc('messages', resolvedId));
        if (!messageSnapshot.exists) return null;
        const message = decodeRecord<Records['messages']>(messageSnapshot.data());
        const conversationSnapshot = await tx.get(
          this.store.doc('conversations', message.conversationId),
        );
        if (
          !conversationSnapshot.exists ||
          conversationSnapshot.get('agentId') !== claim.agentId ||
          message.hiddenAt ||
          channel.get('conversationId') !== message.conversationId
        )
          return null;
        const canonicalBody = emailObserverMessageBody(message.parts);
        if (canonicalBody === null) return null;
        body = canonicalBody;
        messageId = message.id;
        sourceId = message.id;
        origin = message.origin;
      }
      return {
        agentId: claim.agentId,
        messageId,
        sourceId,
        from: ingest.fromEmail,
        subject: ingest.subject,
        body,
        authenticated: ingest.authenticated,
        origin,
        contentTrust: ingest.contentTrust as 'owner' | 'known' | 'unknown',
        directRouting: ingest.directRouting,
        emailContentProvenance: ingest.emailContentProvenance,
        ingestMode: ingest.ingestMode,
        sourceVerification:
          ingest.ingestMode === 'forwarded' ? 'forwarded_unverified' : 'authenticated',
        hasExternalOrUnknown: ingest.hasExternalOrUnknown,
      };
    });
  }

  async prepareEmailObserver(
    input: import('@assistant/persistence').EmailObserverPrepareInput,
  ): Promise<boolean> {
    if (input.agentId !== this.agentId) return false;
    const ref = this.store.doc('emailObserverWork', input.id);
    return this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        this.store,
        input.agentId,
        input.expectedPrivacyGeneration,
      );
      const row = await tx.get(ref);
      const now = this.store.now();
      if (
        !row.exists ||
        row.get('agentId') !== input.agentId ||
        row.get('claimToken') !== input.claimToken ||
        row.get('claimGeneration') !== input.claimGeneration ||
        row.get('privacyGeneration') !== input.expectedPrivacyGeneration ||
        !['claimed', 'prepared'].includes(String(row.get('status'))) ||
        (dateFromFirestore(row.get('leaseExpiresAt'))?.getTime() ?? 0) <= now.getTime()
      )
        return false;
      const current = observerRecord(row);
      if (!isValidEmailObserverPreparedResult(current.observerKey, input.result)) return false;
      if (current.status === 'prepared')
        return sameEmailObserverPreparedResult(
          current.observerKey,
          current.preparedResult,
          input.result,
        );
      tx.update(
        ref,
        encodeRecord({
          status: 'prepared',
          preparedResult: input.result,
          deliveryKey: emailObserverDeliveryKey(
            input.agentId,
            current.sourceKey,
            current.observerKey,
            current.observerVersion,
          ),
          lastErrorCode: null,
          updatedAt: now,
        }),
      );
      return true;
    });
  }

  async completeEmailObserver(
    input: import('@assistant/persistence').EmailObserverTransitionInput,
  ): Promise<boolean> {
    return this.transitionEmailObserver(input, 'complete');
  }

  async failEmailObserver(
    input: import('@assistant/persistence').EmailObserverTransitionInput & {
      outcome: 'retryable_failed' | 'unknown' | 'no_op' | 'budget_blocked';
      errorCode?: string;
    },
  ): Promise<boolean> {
    return this.transitionEmailObserver(input, input.outcome, input.errorCode);
  }

  private async transitionEmailObserver(
    input: import('@assistant/persistence').EmailObserverTransitionInput,
    outcome: 'complete' | 'retryable_failed' | 'unknown' | 'no_op' | 'budget_blocked',
    errorCode?: string,
  ): Promise<boolean> {
    if (input.agentId !== this.agentId) return false;
    const ref = this.store.doc('emailObserverWork', input.id);
    return this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      await assertPrivacyErasureGenerationInTransaction(
        tx,
        this.store,
        input.agentId,
        input.expectedPrivacyGeneration,
      );
      const row = await tx.get(ref);
      const now = this.store.now();
      if (
        !row.exists ||
        row.get('agentId') !== input.agentId ||
        row.get('claimToken') !== input.claimToken ||
        row.get('claimGeneration') !== input.claimGeneration ||
        row.get('privacyGeneration') !== input.expectedPrivacyGeneration ||
        !['claimed', 'prepared'].includes(String(row.get('status'))) ||
        (dateFromFirestore(row.get('leaseExpiresAt'))?.getTime() ?? 0) <= now.getTime()
      )
        return false;
      if (outcome === 'budget_blocked') {
        const current = observerRecord(row);
        if (
          current.status !== 'claimed' ||
          current.workClass !== 'paid_ambiguous' ||
          current.preparedResult !== null ||
          !current.budgetReserved ||
          current.budgetKey !== current.observerKey ||
          !current.budgetWindowStart
        )
          return false;
        const budgetRef = this.store.doc(
          'emailObserverBudgets',
          emailObserverBudgetId(input.agentId, current.observerKey, current.budgetWindowStart),
        );
        const budgetSnapshot = await tx.get(budgetRef);
        if (!budgetSnapshot.exists) return false;
        const budget = decodeRecord<Records['emailObserverBudgets']>(budgetSnapshot.data());
        if (
          budget.agentId !== input.agentId ||
          budget.observerKey !== current.observerKey ||
          budget.reservedCount < 1
        )
          return false;
        tx.update(
          budgetRef,
          encodeRecord({ ...budget, reservedCount: budget.reservedCount - 1, updatedAt: now }),
        );
        tx.update(
          ref,
          encodeRecord({
            status: 'retryable_failed',
            budgetReserved: false,
            budgetKey: null,
            budgetWindowStart: null,
            claimToken: null,
            leaseExpiresAt: null,
            completedAt: null,
            lastErrorCode: safeEmailObserverErrorCode(errorCode ?? 'email_observer_budget_blocked'),
            updatedAt: now,
          }),
        );
        return true;
      }
      tx.update(
        ref,
        encodeRecord({
          status: outcome,
          ...(outcome === 'complete' || outcome === 'no_op'
            ? { preparedResult: null, deliveryKey: null }
            : {}),
          claimToken: null,
          leaseExpiresAt: null,
          lastErrorCode: safeEmailObserverErrorCode(errorCode),
          completedAt: outcome === 'complete' || outcome === 'no_op' ? now : null,
          updatedAt: now,
        }),
      );
      return true;
    });
  }

  async eraseEmailObserverData(
    agentId: string,
    newPrivacyGeneration: string,
    now: Date,
  ): Promise<{ workRows: number; sources: number }> {
    if (agentId !== this.agentId || !newPrivacyGeneration)
      throw new Error('Email observer erasure owner is invalid');
    let workRows = 0;
    let sources = 0;
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let query: FirebaseFirestore.Query = this.store
        .collection('emailObserverWork')
        .where('agentId', '==', agentId)
        .orderBy(FieldPath.documentId())
        .limit(100);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (!page.size) break;
      await this.store.db.runTransaction(async (tx) => {
        const owner = await tx.get(this.store.doc('agents', agentId));
        if (!owner.exists || owner.get('id') !== agentId)
          throw new Error('Email observer erasure owner is unavailable');
        const snapshots = await tx.getAll(...page.docs.map((doc) => doc.ref));
        for (const snapshot of snapshots) {
          const row = observerRecord(snapshot);
          if (row.agentId !== agentId)
            throw new Error('Email observer erasure found a cross-owner row');
          tx.update(
            snapshot.ref,
            encodeRecord({
              status:
                row.status === 'pending' || row.status === 'retryable_failed'
                  ? 'skipped_erased'
                  : row.status === 'claimed' || row.status === 'prepared'
                    ? 'unknown'
                    : row.status,
              privacyGeneration: newPrivacyGeneration,
              preparedResult: null,
              deliveryKey: null,
              claimToken: null,
              leaseExpiresAt: null,
              lastErrorCode: 'privacy_erased',
              updatedAt: now,
            }),
          );
          workRows++;
        }
      });
      for (const workDoc of page.docs) {
        const observerWork = observerRecord(workDoc);
        if (observerWork.agentId !== agentId)
          throw new Error('Email observer notice erasure found a cross-owner work row');
        let outboxCursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
        for (;;) {
          let outboxQuery: FirebaseFirestore.Query = this.store
            .collection('notificationOutbox')
            .where('producerWorkId', '==', observerWork.id)
            .orderBy(FieldPath.documentId())
            .limit(100);
          if (outboxCursor) outboxQuery = outboxQuery.startAfter(outboxCursor);
          const outboxPage = await outboxQuery.get();
          if (!outboxPage.size) break;
          await this.store.db.runTransaction(async (tx) => {
            const owner = await tx.get(this.store.doc('agents', agentId));
            if (!owner.exists || owner.get('id') !== agentId)
              throw new Error('Email observer notice erasure owner is unavailable');
            const rows = await tx.getAll(...outboxPage.docs.map((doc) => doc.ref));
            const dashboardIds = rows
              .filter((snapshot) => snapshot.exists)
              .map((snapshot) => decodeRecord<Records['notificationOutbox']>(snapshot.data()))
              .filter((row) => row.agentId === agentId && row.adapter === 'dashboard')
              .map((row) => notificationDashboardMessageId(agentId, row.deliveryKey, row.legKey));
            const channelRefs = dashboardIds.map((id) => this.store.doc('messageChannelIds', id));
            const channelRows = channelRefs.length ? await tx.getAll(...channelRefs) : [];
            const messageIds = channelRows
              .filter(
                (snapshot) => snapshot.exists && typeof snapshot.get('messageId') === 'string',
              )
              .map((snapshot) => snapshot.get('messageId') as string);
            const messageRefs = messageIds.map((id) => this.store.doc('messages', id));
            const messageRows = messageRefs.length ? await tx.getAll(...messageRefs) : [];
            rows.forEach((snapshot) => {
              if (!snapshot.exists) return;
              const row = decodeRecord<Records['notificationOutbox']>(snapshot.data());
              if (row.agentId !== agentId || row.producerWorkId !== observerWork.id)
                throw new Error('Email observer notice erasure found a cross-owner outbox row');
              tx.update(
                snapshot.ref,
                encodeRecord({
                  status:
                    row.status === 'sending'
                      ? 'unknown'
                      : row.status === 'pending' || row.status === 'failed'
                        ? 'skipped'
                        : row.status,
                  retryable: false,
                  destination: null,
                  payload: null,
                  leaseToken: null,
                  leaseUntil: null,
                  result: { reason: 'privacy-erased' },
                  finishedAt: now,
                  updatedAt: now,
                }),
              );
            });
            channelRows.forEach((snapshot, index) => {
              if (!snapshot.exists) return;
              const correspondingOutbox = rows.find(
                (row) =>
                  row.exists &&
                  notificationDashboardMessageId(
                    agentId,
                    decodeRecord<Records['notificationOutbox']>(row.data()).deliveryKey,
                    decodeRecord<Records['notificationOutbox']>(row.data()).legKey,
                  ) === dashboardIds[index],
              );
              if (!correspondingOutbox) return;
              tx.delete(snapshot.ref);
            });
            messageRows.forEach((snapshot) => {
              if (snapshot.exists) tx.delete(snapshot.ref);
            });
          });
          outboxCursor = outboxPage.docs.at(-1);
          if (outboxPage.size < 100) break;
        }
      }
      cursor = page.docs.at(-1);
      if (page.size < 100) break;
    }
    for (;;) {
      const page = await this.store
        .collection('emailObserverSources')
        .where('agentId', '==', agentId)
        .limit(100)
        .get();
      if (!page.size) break;
      await this.store.db.runTransaction(async (tx) => {
        const owner = await tx.get(this.store.doc('agents', agentId));
        if (!owner.exists || owner.get('id') !== agentId)
          throw new Error('Email observer erasure owner is unavailable');
        const snapshots = await tx.getAll(...page.docs.map((doc) => doc.ref));
        for (const snapshot of snapshots) {
          const row = decodeRecord<Records['emailObserverSources']>(snapshot.data());
          if (row.agentId !== agentId || documentKey(row.id) !== snapshot.id)
            throw new Error('Email observer source erasure identity mismatch');
          tx.delete(snapshot.ref);
          sources++;
        }
      });
    }
    return { workRows, sources };
  }

  async completeForwardedIngest(
    ingestId: string,
    input: { triaged: boolean; taskId?: string | null; now: Date },
    lease?: EmailSyncLease,
  ): Promise<void> {
    const ref = this.store.doc('emailIngest', ingestId);
    await this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      if (lease) await this.assertLeaseInTransaction(tx, lease);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('messagePersisted') !== true)
        throw new Error('email ingest source is not ready to complete');
      tx.update(
        ref,
        encodeRecord({
          pipelineStage: 'complete',
          triaged: input.triaged,
          triageTaskId: input.taskId ?? null,
          updatedAt: input.now,
        }),
      );
    });
  }

  async isBookingOccurrenceCurrent(input: {
    agentId: string;
    bookingKey: string;
    expectedVersion: number;
    allowedLifecycle?: readonly string[];
  }): Promise<boolean> {
    if (input.agentId !== this.agentId) return false;
    const ref = this.store.doc(
      'emailBookingOccurrences',
      emailBookingOccurrenceId(input.agentId, input.bookingKey),
    );
    const snapshot = await ref.get();
    if (!snapshot.exists) return false;
    const row = decodeRecord<Records['emailBookingOccurrences']>(snapshot.data());
    return (
      row.id === ref.id &&
      row.agentId === input.agentId &&
      row.bookingKey === input.bookingKey &&
      row.sourceAuthenticated === true &&
      row.version === input.expectedVersion &&
      (input.allowedLifecycle === undefined || input.allowedLifecycle.includes(row.lifecycle))
    );
  }

  async recordIngest(
    input: NewEmailIngest,
    observationFence?: string | null,
  ): Promise<string | null> {
    if (input.agentId !== this.agentId)
      throw new Error('Email ingest is outside the configured owner');
    const id = uuidFrom(['email-ingest', input.channelMessageId]);
    const ref = this.store.doc('emailIngest', id);
    return this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const [byId, bySource, erasureJob] = await Promise.all([
        tx.get(ref),
        tx.get(this.ingestQuery(input.channelMessageId)),
        tx.get(this.store.doc('privacyErasureJobs', input.agentId)),
      ]);
      if (observationFence !== undefined) {
        const generation = erasureJob.exists ? erasureJob.get('generation') : null;
        if (
          (erasureJob.exists &&
            (erasureJob.get('agentId') !== input.agentId ||
              privacyErasureIsActive(erasureJob.get('status')))) ||
          (typeof generation === 'string' ? generation : null) !== observationFence
        )
          throw new Error('Privacy erasure changed during email source commit');
      }
      if (byId.exists || !bySource.empty) return null;
      const now = this.store.now();
      const row: Records['emailIngest'] = {
        ...input,
        mailbox: input.mailbox ?? '',
        providerMessageId: input.providerMessageId ?? null,
        ingestMode: input.ingestMode ?? 'forwarded',
        hasExternalOrUnknown: input.hasExternalOrUnknown ?? true,
        observerRegistrySnapshot: input.observerRegistrySnapshot ?? null,
        observerRegistryHash: input.observerRegistryHash ?? null,
        admittedSourceKind: input.admittedSourceKind ?? null,
        admittedSourceId: input.admittedSourceId ?? null,
        directRouting: input.directRouting ?? null,
        directRecoveryReason: input.directRecoveryReason ?? null,
        emailContentProvenance: input.emailContentProvenance ?? null,
        classificationStatus: input.classificationStatus ?? 'not_required',
        classificationClaimToken: input.classificationClaimToken ?? null,
        preparedClassification: input.preparedClassification ?? null,
        scoreOutcome: input.scoreOutcome ?? 'model_prepared',
        pipelineStage: input.pipelineStage ?? 'complete',
        scoreStatus: input.scoreStatus ?? 'prepared',
        scoreClaimToken: input.scoreClaimToken ?? null,
        cardCandidate: input.cardCandidate ?? false,
        nextStep: input.nextStep ?? null,
        messagePersisted: input.messagePersisted ?? true,
        triageTaskId: input.triageTaskId ?? null,
        id,
        createdAt: now,
        updatedAt: now,
        triaged: false,
        extractedAt: null,
        preparedExtraction: null,
        providerThreadId: input.providerThreadId ?? null,
        providerReceivedAt: input.providerReceivedAt ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        securityEvidence: input.securityEvidence ?? null,
        securityIncidentId: input.securityIncidentId ?? null,
        obligationStatus: 'unknown',
        obligationVersion: 0,
        obligationDecision: null,
        obligationDecisionAt: null,
        obligationSnoozedUntil: null,
      };
      tx.create(ref, encodeRecord(row));
      return id;
    });
  }

  async observeSecurityIncident(input: SecurityIncidentObservation) {
    if (input.agentId !== this.agentId)
      throw new Error('Security incident is outside the configured owner');
    if (!(input.observedAt instanceof Date) || !Number.isFinite(input.observedAt.getTime()))
      throw new Error('Invalid security incident observation time');
    if (
      !input.channelMessageId ||
      input.channelMessageId.length > 500 ||
      input.mailbox.length > 320 ||
      input.sourceText.length > 20_000
    )
      throw new Error('Invalid security incident source identity');
    const identity = securityIncidentIdentity({
      agentId: input.agentId,
      channelMessageId: input.channelMessageId,
      sourceMessageId: input.sourceMessageId,
      authenticated: input.authenticated,
      evidence: input.evidence,
      sourceText: input.sourceText,
    });
    const id = securityIncidentId(input.agentId, identity.incidentKey);
    const incidentRef = this.store.doc('securityIncidents', id);
    const sourceId = securityIncidentId(input.agentId, `source:${input.channelMessageId}`);
    const sourceRef = this.store.doc('securityIncidentSources', sourceId);
    const sourceQuery = this.store
      .collection('securityIncidentSources')
      .where('agentId', '==', input.agentId)
      .where('channelMessageId', '==', input.channelMessageId)
      .limit(2);
    const emailQuery = this.ingestQuery(input.channelMessageId);
    return this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const [incidentSnapshot, sourceSnapshot, existingSourceQuery, emailSnapshot, erasureJob] =
        await Promise.all([
          tx.get(incidentRef),
          tx.get(sourceRef),
          tx.get(sourceQuery),
          tx.get(emailQuery),
          tx.get(this.store.doc('privacyErasureJobs', input.agentId)),
        ]);
      if (input.observationFence !== undefined) {
        const generation = erasureJob.exists ? erasureJob.get('generation') : null;
        if (
          (erasureJob.exists &&
            (erasureJob.get('agentId') !== input.agentId ||
              privacyErasureIsActive(erasureJob.get('status')))) ||
          (typeof generation === 'string' ? generation : null) !== input.observationFence
        )
          throw new Error('Privacy erasure changed during source observation');
      }
      const emailDoc = emailSnapshot.docs[0];
      if (emailSnapshot.size > 1 || !emailDoc || emailDoc.get('agentId') !== input.agentId)
        throw new Error('Security incident source message is unavailable');
      if (existingSourceQuery.size > 1)
        throw new Error('Security incident source identity is ambiguous');
      const existingSourceDoc = existingSourceQuery.docs[0];
      if (existingSourceDoc && existingSourceDoc.id !== documentKey(sourceId))
        throw new Error('Security incident source id mismatch');
      const priorIncident = incidentSnapshot.exists
        ? decodeRecord<Records['securityIncidents']>(incidentSnapshot.data())
        : null;
      if (priorIncident && (priorIncident.id !== id || priorIncident.agentId !== input.agentId))
        throw new Error('Security incident owner mismatch');
      const previousSource = existingSourceDoc
        ? decodeRecord<Records['securityIncidentSources']>(existingSourceDoc.data())
        : sourceSnapshot.exists
          ? decodeRecord<Records['securityIncidentSources']>(sourceSnapshot.data())
          : null;
      if (
        previousSource &&
        (previousSource.agentId !== input.agentId || previousSource.incidentId !== id)
      )
        throw new Error('Security incident source was already attached elsewhere');
      const evidenceQuery = this.store
        .collection('securityIncidentSources')
        .where('agentId', '==', input.agentId)
        .where('incidentId', '==', id)
        .where('evidenceFingerprint', '==', identity.evidenceFingerprint)
        .limit(2);
      const [matchingEvidenceSnapshot] = await Promise.all([tx.get(evidenceQuery)]);
      if (matchingEvidenceSnapshot.size > 2)
        throw new Error('Security incident evidence scan exceeded bound');
      const repeatedSameSource =
        previousSource?.evidenceFingerprint === identity.evidenceFingerprint;
      const duplicateEvidence =
        repeatedSameSource ||
        matchingEvidenceSnapshot.docs.some((doc) => doc.id !== documentKey(sourceId));
      if (repeatedSameSource) {
        tx.update(
          emailDoc.ref,
          encodeRecord({ securityIncidentId: id, securityEvidence: input.evidence }),
        );
        return {
          incident: priorIncident as SecurityIncidentRecord,
          source: previousSource as SecurityIncidentSourceRecord,
          duplicateEvidence: true,
          reassessmentReason: null,
        };
      }
      const incident: Records['securityIncidents'] = priorIncident
        ? {
            ...priorIncident,
            confidence: identity.confidence,
            revision: priorIncident.revision + (duplicateEvidence ? 0 : 1),
            materialChangeReason:
              duplicateEvidence || priorIncident.revision === 0
                ? priorIncident.materialChangeReason
                : 'New source-quoted security evidence changed the incident evidence fingerprint.',
            updatedAt: duplicateEvidence ? priorIncident.updatedAt : input.observedAt,
          }
        : {
            id,
            agentId: input.agentId,
            incidentKey: identity.incidentKey,
            confidence: identity.confidence,
            revision: 1,
            disposition: 'unreviewed',
            decisionRevision: null,
            decisionReason: null,
            materialChangeReason: null,
            createdAt: input.observedAt,
            updatedAt: input.observedAt,
          };
      const source: Records['securityIncidentSources'] = {
        ...(previousSource ?? {}),
        id: sourceId,
        agentId: input.agentId,
        incidentId: id,
        channelMessageId: input.channelMessageId,
        sourceMessageId: input.sourceMessageId,
        mailboxHash: securityIncidentMailboxHash(input.mailbox),
        evidenceFingerprint: identity.evidenceFingerprint,
        observedAt: input.observedAt,
        createdAt: previousSource?.createdAt ?? input.observedAt,
      };
      if (incidentSnapshot.exists) tx.set(incidentRef, encodeRecord(incident));
      else tx.create(incidentRef, encodeRecord(incident));
      if (sourceSnapshot.exists) tx.set(sourceRef, encodeRecord(source));
      else tx.create(sourceRef, encodeRecord(source));
      tx.update(
        emailDoc.ref,
        encodeRecord({ securityIncidentId: id, securityEvidence: input.evidence }),
      );
      return {
        incident,
        source,
        duplicateEvidence,
        reassessmentReason:
          !duplicateEvidence && priorIncident && priorIncident.revision > 0
            ? incident.materialChangeReason
            : null,
      };
    });
  }

  async securityIncidentForMessage(agentId: string, channelMessageId: string) {
    if (agentId !== this.agentId) return null;
    const snapshot = await this.store
      .collection('securityIncidentSources')
      .where('agentId', '==', agentId)
      .where('channelMessageId', '==', channelMessageId)
      .limit(2)
      .get();
    if (snapshot.size > 1) throw new Error('Security incident source identity is ambiguous');
    const sourceDoc = snapshot.docs[0];
    if (!sourceDoc) return null;
    const source = decodeRecord<Records['securityIncidentSources']>(sourceDoc.data());
    if (documentKey(source.id) !== sourceDoc.id || source.agentId !== agentId) return null;
    const incidentDoc = await this.store.doc('securityIncidents', source.incidentId).get();
    if (!incidentDoc.exists) return null;
    const incident = decodeRecord<Records['securityIncidents']>(incidentDoc.data());
    return documentKey(incident.id) === incidentDoc.id && incident.agentId === agentId
      ? (incident as SecurityIncidentRecord)
      : null;
  }

  async listSecurityAttentionCandidates(
    agentId: string,
    limit: number,
  ): Promise<SecurityIncidentAttentionCandidate[]> {
    if (agentId !== this.agentId) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Security incident candidate limit must be from one to one hundred');
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const sourceSnapshot = await this.store
      .collection('securityIncidentSources')
      .where('agentId', '==', agentId)
      .orderBy('observedAt', 'asc')
      .limit(10_001)
      .get();
    if (sourceSnapshot.size > 10_000)
      throw new Error('Security incident source scan exceeded bound');
    const rows: SecurityIncidentAttentionCandidate[] = [];
    const seenIncidents = new Set<string>();
    for (const sourceDoc of sourceSnapshot.docs) {
      const source = decodeRecord<Records['securityIncidentSources']>(sourceDoc.data());
      if (
        documentKey(source.id) !== sourceDoc.id ||
        source.agentId !== agentId ||
        !source.incidentId ||
        seenIncidents.has(source.incidentId)
      )
        continue;
      seenIncidents.add(source.incidentId);
      const incidentDoc = await this.store.doc('securityIncidents', source.incidentId).get();
      if (!incidentDoc.exists) continue;
      const incident = decodeRecord<Records['securityIncidents']>(incidentDoc.data());
      if (
        documentKey(incident.id) !== incidentDoc.id ||
        incident.agentId !== agentId ||
        incident.revision < 1 ||
        (incident.decisionRevision === incident.revision &&
          (incident.disposition === 'expected' || incident.disposition === 'dismissed'))
      )
        continue;
      const attentionId = securityIncidentId(
        agentId,
        `attention:${incident.id}:${incident.revision}`,
      );
      if ((await this.store.doc('securityIncidentAttention', attentionId).get()).exists) continue;
      const emailSnapshot = await this.ingestQuery(source.channelMessageId).limit(2).get();
      if (emailSnapshot.size !== 1) continue;
      const email = decodeRecord<Records['emailIngest']>(emailSnapshot.docs[0]!.data());
      if (email.agentId !== agentId || email.category !== 'security') continue;
      rows.push({
        channelMessageId: source.channelMessageId,
        incidentId: incident.id,
        revision: incident.revision,
        confidence: incident.confidence as SecurityIncidentAttentionCandidate['confidence'],
        disposition: incident.disposition as SecurityIncidentAttentionCandidate['disposition'],
        decisionRevision: incident.decisionRevision,
        materialChangeReason: incident.materialChangeReason,
        observedAt: source.observedAt,
        category: email.category,
        importance: email.importance,
        subject: email.subject,
        fromName: email.fromName,
        evidence: email.securityEvidence ?? null,
      });
      if (rows.length >= limit) break;
    }
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return rows;
  }

  async decideSecurityIncident(input: {
    agentId: string;
    incidentId: string;
    expectedRevision: number;
    disposition: 'expected' | 'dismissed';
    reason: string;
    now: Date;
  }): Promise<boolean> {
    if (input.agentId !== this.agentId || !input.reason.trim() || input.reason.length > 500)
      return false;
    const ref = this.store.doc('securityIncidents', input.incidentId);
    return this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false;
      const incident = decodeRecord<Records['securityIncidents']>(snapshot.data());
      if (
        incident.id !== input.incidentId ||
        incident.agentId !== input.agentId ||
        incident.revision !== input.expectedRevision
      )
        return false;
      tx.update(
        ref,
        encodeRecord({
          disposition: input.disposition,
          decisionRevision: input.expectedRevision,
          decisionReason: input.reason.slice(0, 500),
          updatedAt: input.now,
        }),
      );
      return true;
    });
  }

  async claimSecurityAttention(input: {
    agentId: string;
    incidentId: string;
    revision: number;
    producer: 'arrival' | 'pulse' | 'briefing';
    now: Date;
  }): Promise<boolean> {
    if (input.agentId !== this.agentId) return false;
    const id = securityIncidentId(input.agentId, `attention:${input.incidentId}:${input.revision}`);
    const incidentRef = this.store.doc('securityIncidents', input.incidentId);
    const attentionRef = this.store.doc('securityIncidentAttention', id);
    return this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const [incidentSnapshot, attentionSnapshot] = await Promise.all([
        tx.get(incidentRef),
        tx.get(attentionRef),
      ]);
      if (attentionSnapshot.exists) return false;
      if (!incidentSnapshot.exists) return false;
      const incident = decodeRecord<Records['securityIncidents']>(incidentSnapshot.data());
      if (
        incident.id !== input.incidentId ||
        incident.agentId !== input.agentId ||
        incident.revision !== input.revision ||
        (incident.decisionRevision === incident.revision &&
          (incident.disposition === 'expected' || incident.disposition === 'dismissed'))
      )
        return false;
      const row: Records['securityIncidentAttention'] = {
        id,
        agentId: input.agentId,
        incidentId: input.incidentId,
        revision: input.revision,
        producer: input.producer,
        deliveryStatus: 'claimed',
        createdAt: input.now,
        updatedAt: input.now,
      };
      tx.create(attentionRef, encodeRecord(row));
      return true;
    });
  }

  async completeSecurityAttention(input: {
    agentId: string;
    incidentId: string;
    revision: number;
    deliveryStatus: 'accepted' | 'unknown';
    now: Date;
  }): Promise<boolean> {
    if (input.agentId !== this.agentId) return false;
    const id = securityIncidentId(input.agentId, `attention:${input.incidentId}:${input.revision}`);
    const ref = this.store.doc('securityIncidentAttention', id);
    return this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false;
      const row = decodeRecord<Records['securityIncidentAttention']>(snapshot.data());
      if (
        row.id !== id ||
        row.agentId !== input.agentId ||
        row.incidentId !== input.incidentId ||
        row.revision !== input.revision ||
        row.deliveryStatus !== 'claimed'
      )
        return false;
      tx.update(ref, encodeRecord({ deliveryStatus: input.deliveryStatus, updatedAt: input.now }));
      return true;
    });
  }

  async listEmailObligations(_now: Date): Promise<EmailObligationRecord[]> {
    const snapshot = await this.store
      .collection('emailIngest')
      .where('agentId', '==', this.agentId)
      .limit(10_001)
      .get();
    if (snapshot.size > 10_000) throw new Error('Email obligation scan exceeded bound');
    const rows = snapshot.docs.map((doc) => decodeRecord<Records['emailIngest']>(doc.data()));
    const latest = new Map<string, Records['emailIngest']>();
    const newer = (a: Records['emailIngest'], b: Records['emailIngest']) => {
      const at = a.providerReceivedAt?.getTime() ?? a.createdAt.getTime();
      const bt = b.providerReceivedAt?.getTime() ?? b.createdAt.getTime();
      return at === bt
        ? String(a.providerMessageId ?? a.channelMessageId) >
            String(b.providerMessageId ?? b.channelMessageId)
        : at > bt;
    };
    for (const row of rows) {
      if (row.agentId !== this.agentId || !row.providerThreadId) continue;
      const prior = latest.get(row.providerThreadId);
      if (!prior || newer(row, prior)) latest.set(row.providerThreadId, row);
    }
    return [...latest.values()]
      .filter(
        (row) =>
          row.actionable === true &&
          (row.pipelineStage == null || row.pipelineStage === 'complete'),
      )
      .map((row) => ({
        id: row.id,
        channelMessageId: row.channelMessageId,
        providerThreadId: row.providerThreadId,
        providerReceivedAt: row.providerReceivedAt ?? null,
        subject: row.subject,
        fromEmail: row.fromEmail,
        fromName: row.fromName ?? null,
        obligationStatus: row.obligationStatus ?? 'unknown',
        obligationVersion: row.obligationVersion ?? 0,
        obligationDecision: row.obligationDecision ?? null,
        obligationDecisionAt: row.obligationDecisionAt ?? null,
        obligationSnoozedUntil: row.obligationSnoozedUntil ?? null,
      }))
      .sort(
        (a, b) => (b.providerReceivedAt?.getTime() ?? 0) - (a.providerReceivedAt?.getTime() ?? 0),
      )
      .slice(0, 100);
  }

  async decideEmailObligation(input: {
    channelMessageId: string;
    expectedVersion: number;
    decision: EmailObligationDecision;
    now: Date;
    snoozedUntil?: Date;
  }): Promise<boolean> {
    if (input.decision === 'snooze' && (!input.snoozedUntil || input.snoozedUntil <= input.now)) {
      throw new Error('A snooze must end in the future');
    }
    const ref = this.store.doc('emailIngest', uuidFrom(['email-ingest', input.channelMessageId]));
    return this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, this.agentId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false;
      const row = decodeRecord<Records['emailIngest']>(snapshot.data());
      if (
        row.agentId !== this.agentId ||
        row.channelMessageId !== input.channelMessageId ||
        !row.providerThreadId ||
        row.actionable !== true ||
        row.pipelineStage !== 'complete' ||
        (input.decision === 'reopen'
          ? row.obligationStatus !== 'resolved'
          : row.obligationStatus === 'resolved') ||
        (row.obligationVersion ?? 0) !== input.expectedVersion
      )
        return false;
      const threadRows = await tx.get(
        this.store
          .collection('emailIngest')
          .where('agentId', '==', this.agentId)
          .where('providerThreadId', '==', row.providerThreadId)
          .limit(10_001),
      );
      if (threadRows.size > 10_000) throw new Error('Email thread source scan exceeded bound');
      const created = row.providerReceivedAt?.getTime() ?? row.createdAt.getTime();
      const identity = String(row.providerMessageId ?? row.channelMessageId);
      for (const candidateDoc of threadRows.docs) {
        if (candidateDoc.id === ref.id) continue;
        const candidate = decodeRecord<Records['emailIngest']>(candidateDoc.data());
        const received = candidate.providerReceivedAt?.getTime() ?? candidate.createdAt.getTime();
        const candidateIdentity = String(candidate.providerMessageId ?? candidate.channelMessageId);
        if (received > created || (received === created && candidateIdentity > identity))
          return false;
      }
      const status =
        input.decision === 'resolve'
          ? 'resolved'
          : input.decision === 'snooze'
            ? 'snoozed'
            : 'open';
      tx.update(
        ref,
        encodeRecord({
          obligationStatus: status,
          obligationVersion: input.expectedVersion + 1,
          obligationDecision: input.decision,
          obligationDecisionAt: input.now,
          obligationSnoozedUntil: input.decision === 'snooze' ? (input.snoozedUntil ?? null) : null,
          updatedAt: input.now,
        }),
      );
      return true;
    });
  }

  async triagedSince(since: Date): Promise<number> {
    const result = await this.store
      .collection('emailIngest')
      .where('triaged', '==', true)
      .where('createdAt', '>=', since)
      .count()
      .get();
    return result.data().count;
  }

  async markTriaged(ingestId: string, now: Date): Promise<void> {
    const ref = this.store.doc('emailIngest', ingestId);
    await this.store.db.runTransaction(async (tx) => {
      await this.assertOperationalInTransaction(tx);
      await tx.get(ref);
      tx.update(ref, encodeRecord({ triaged: true, updatedAt: now }));
    });
  }

  async replyThread(conversationId: string) {
    const conversation = await this.store.doc('conversations', conversationId).get();
    if (!conversation.exists || conversation.get('agentId') !== this.agentId) return null;
    const [bindings, origins] = await Promise.all([
      this.store
        .collection('channelBindings')
        .where('conversationId', '==', conversationId)
        .where('channel', '==', 'email')
        .limit(1)
        .get(),
      this.store
        .collection('tasks')
        .where('agentId', '==', this.agentId)
        .where('conversationId', '==', conversationId)
        .where('type', '==', 'email_triage')
        .where('trust', '==', 'owner')
        .orderBy('createdAt', 'asc')
        .limit(1)
        .get(),
    ]);
    const threadId = bindings.docs[0]?.get('externalId');
    const origin = origins.docs[0];
    return {
      channel: String(conversation.get('channel')),
      threadId: typeof threadId === 'string' ? threadId : null,
      ownerOriginTrigger: origin
        ? (decodeRecord<{ trigger?: unknown }>(origin.data()).trigger ?? null)
        : null,
    };
  }
}
