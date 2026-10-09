import { randomUUID } from 'node:crypto';
import type {
  ApplicationConfirmationNoticeFence,
  EmailObserverEffectFence,
  NotificationsConversationRepository,
  OwnerNoticeDecisionFenceInput,
  OwnerNoticeDecisionFenceResult,
  OwnerNoticeRepository,
  Records,
} from '@assistant/persistence';
import {
  matchesApplicationConfirmationNoticeLineage,
  matchesPreparedEmailObserverClaim,
  securityIncidentId,
} from '@assistant/persistence';
import { type DocumentSnapshot, Timestamp, type Transaction } from '@google-cloud/firestore';
import { conversationDocument } from './conversation-document.js';
import { messageRecord } from './messages.js';
import {
  assertPrivacyErasureGenerationInTransaction,
  privacyErasureIsActive,
  readPrivacyErasureFence,
} from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Conversation = Records['conversations'];

/** Resolved without writes so a producer can finish all transaction reads first. */
interface OwnerNoticeDestination {
  row: Conversation;
  created: boolean;
  createNotificationsMarker: boolean;
}

function ownedConversation(snapshot: DocumentSnapshot, agentId: string): Conversation {
  const row = decodeRecord<Conversation>(snapshot.data());
  if (
    !snapshot.exists ||
    row.agentId !== agentId ||
    documentKey(row.id) !== snapshot.id ||
    row.channel !== 'chat'
  )
    throw new Error('Owner notice conversation identity mismatch');
  return row;
}

/** Durable dashboard sink for background work in a customer-owned installation. */
export class FirestoreOwnerNoticeRepository implements NotificationsConversationRepository {
  readonly kind = 'notifications-conversation-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
  ) {}

  private async owner(tx: Transaction): Promise<void> {
    const owners = await tx.get(this.store.collection('agents').limit(2));
    const owner = owners.docs[0];
    if (
      !this.agentId ||
      owners.size !== 1 ||
      !owner ||
      owner.get('id') !== this.agentId ||
      owner.id !== documentKey(this.agentId)
    )
      throw new Error('Owner notices require exactly one configured owner');
  }

  private async primary(tx: Transaction): Promise<Conversation | null> {
    const marker = await tx.get(this.store.doc('primaryConversations', this.agentId));
    if (marker.exists) {
      const id = marker.get('conversationId');
      if (marker.get('agentId') !== this.agentId || typeof id !== 'string' || !id)
        throw new Error('Primary conversation marker is malformed');
      const snapshot = await tx.get(this.store.doc('conversations', id));
      if (!snapshot.exists) throw new Error('Primary conversation marker is stale');
      const row = ownedConversation(snapshot, this.agentId);
      if (!row.isPrimary) throw new Error('Primary conversation marker is stale');
      return row.archivedAt ? null : row;
    }
    // Migrated installations may have a primary chat but no derived marker yet.
    const matches = await tx.get(
      this.store
        .collection('conversations')
        .where('agentId', '==', this.agentId)
        .where('isPrimary', '==', true)
        .limit(2),
    );
    if (matches.size > 1) throw new Error('Ambiguous primary conversation');
    const snapshot = matches.docs[0];
    if (!snapshot) return null;
    const row = ownedConversation(snapshot, this.agentId);
    return row.archivedAt ? null : row;
  }

  async primaryConversationId(): Promise<string | null> {
    const fence = await readPrivacyErasureFence(this.store, this.agentId);
    const result = await this.store.db.runTransaction(async (tx) => {
      await this.owner(tx);
      const primary = await this.primary(tx);
      return primary?.id ?? null;
    });
    const after = await readPrivacyErasureFence(this.store, this.agentId);
    if (fence === null ? after !== null : !after?.isEqual(fence))
      throw new Error('Privacy erasure changed during owner notice read');
    return result;
  }

  async observationFence(agentId: string): Promise<string | null> {
    if (agentId !== this.agentId)
      throw new Error('Owner notice is outside the configured installation');
    const snapshot = await this.store.doc('privacyErasureJobs', agentId).get();
    if (!snapshot.exists) return null;
    const generation = snapshot.get('generation');
    if (
      snapshot.get('agentId') !== agentId ||
      privacyErasureIsActive(snapshot.get('status')) ||
      typeof generation !== 'string' ||
      !generation ||
      generation.length > 100
    )
      throw new Error('Privacy erasure generation is malformed or in progress');
    return generation;
  }

  private async resolveNotifications(tx: Transaction): Promise<OwnerNoticeDestination> {
    const markerRef = this.store.doc('notificationConversations', this.agentId);
    const marker = await tx.get(markerRef);
    if (marker.exists) {
      const id = marker.get('conversationId');
      if (marker.get('agentId') !== this.agentId || typeof id !== 'string' || !id)
        throw new Error('Notifications conversation marker is malformed');
      const snapshot = await tx.get(this.store.doc('conversations', id));
      if (!snapshot.exists) throw new Error('Notifications conversation marker is stale');
      const row = ownedConversation(snapshot, this.agentId);
      if (row.title !== 'Notifications' || row.isPrimary)
        throw new Error('Notifications conversation marker is stale');
      return { row, created: false, createNotificationsMarker: false };
    }
    const matches = await tx.get(
      this.store
        .collection('conversations')
        .where('agentId', '==', this.agentId)
        .where('title', '==', 'Notifications')
        .limit(2),
    );
    if (matches.size > 1) throw new Error('Ambiguous Notifications conversation');
    const snapshot = matches.docs[0];
    if (snapshot) {
      const row = ownedConversation(snapshot, this.agentId);
      if (row.isPrimary) throw new Error('Notifications conversation is primary');
      return { row, created: false, createNotificationsMarker: true };
    }
    const now = this.store.now();
    const row: Conversation = {
      id: randomUUID(),
      agentId: this.agentId,
      channel: 'chat',
      trust: 'assistant',
      title: 'Notifications',
      isPrimary: false,
      metadata: {},
      archivedAt: null,
      modelOverride: null,
      lastReadAt: null,
      messageSequence: 0,
      createdAt: now,
      updatedAt: now,
    };
    return { row, created: true, createNotificationsMarker: true };
  }

  private async notifications(tx: Transaction): Promise<OwnerNoticeDestination> {
    const destination = await this.resolveNotifications(tx);
    if (destination.createNotificationsMarker)
      tx.create(this.store.doc('notificationConversations', this.agentId), {
        agentId: this.agentId,
        conversationId: destination.row.id,
        createdAt: this.store.now(),
      });
    return destination;
  }

  /** Read-only routing/ownership half of a producer's atomic notice admission. */
  async prepareNoticeInTransaction(
    tx: Transaction,
    taskId?: string,
  ): Promise<OwnerNoticeDestination> {
    await this.owner(tx);
    if (taskId) {
      const task = await tx.get(this.store.doc('tasks', taskId));
      if (!task.exists || task.get('id') !== taskId || task.get('agentId') !== this.agentId)
        throw new Error('Owner notice task is outside the configured installation');
    }
    const primary = await this.primary(tx);
    return primary
      ? { row: primary, created: false, createNotificationsMarker: false }
      : this.resolveNotifications(tx);
  }

  /** Write-only half; its caller has already checked the observation's privacy fence. */
  appendNoticeInTransaction(
    tx: Transaction,
    destination: OwnerNoticeDestination,
    input: {
      id: string;
      text: string;
      taskId?: string;
      extraParts: readonly unknown[];
      now: Date;
    },
  ): void {
    const message = messageRecord(
      {
        conversationId: destination.row.id,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        role: 'assistant',
        origin: 'assistant',
        parts: [{ type: 'text', text: input.text }, ...input.extraParts],
        text: input.text,
      },
      input.id,
      input.now,
    );
    if (destination.createNotificationsMarker)
      tx.create(this.store.doc('notificationConversations', this.agentId), {
        agentId: this.agentId,
        conversationId: destination.row.id,
        createdAt: input.now,
      });
    const conversationRef = this.store.doc('conversations', destination.row.id);
    if (destination.created)
      tx.create(
        conversationRef,
        conversationDocument({ ...destination.row, updatedAt: input.now }),
      );
    else
      tx.update(conversationRef, {
        updatedAt: input.now,
        ...(destination.row.archivedAt ? { archivedAt: null, archived: false } : {}),
      });
    tx.create(this.store.doc('messages', input.id), encodeRecord(message));
  }

  /**
   * The owner's Notifications chat for background work without its own chat,
   * created on first use. The `notificationConversations` marker is the
   * uniqueness record: concurrent first uses contend on it and converge on the
   * one conversation it names.
   */
  async notificationsConversationId(
    fence?: EmailObserverEffectFence,
    noticeFence?: ApplicationConfirmationNoticeFence,
  ): Promise<string> {
    return this.store.db.runTransaction(async (tx) => {
      await this.owner(tx);
      if (fence && noticeFence)
        throw new Error('Notifications conversation accepts one producer fence');
      if (fence) {
        if (fence.agentId !== this.agentId)
          throw new Error('Email observer notification conversation is outside the owner');
        await assertPrivacyErasureGenerationInTransaction(
          tx,
          this.store,
          this.agentId,
          fence.expectedPrivacyGeneration,
        );
        const workRef = this.store.doc('emailObserverWork', fence.id);
        const workSnapshot = await tx.get(workRef);
        const work = workSnapshot.exists
          ? decodeRecord<Records['emailObserverWork']>(workSnapshot.data())
          : null;
        if (!matchesPreparedEmailObserverClaim(work, fence, this.store.now()))
          throw new Error('Email observer notification conversation claim is stale');
      }
      if (noticeFence) {
        if (noticeFence.agentId !== this.agentId)
          throw new Error('Application confirmation conversation is outside the owner');
        await assertPrivacyErasureGenerationInTransaction(
          tx,
          this.store,
          this.agentId,
          noticeFence.producerPrivacyGeneration,
        );
        const [taskSnapshot, applicationSnapshot] = await tx.getAll(
          this.store.doc('tasks', noticeFence.taskId),
          this.store.doc('applicationConfirmations', noticeFence.applicationId),
        );
        if (
          !matchesApplicationConfirmationNoticeLineage(
            taskSnapshot?.exists ? decodeRecord<Records['tasks']>(taskSnapshot.data()) : null,
            applicationSnapshot?.exists
              ? decodeRecord<Records['applicationConfirmations']>(applicationSnapshot.data())
              : null,
            noticeFence,
            { now: this.store.now(), requireLiveTaskLease: true },
          )
        )
          throw new Error('Application confirmation conversation fence is stale');
      }
      const destination = await this.resolveNotifications(tx);
      if (fence) {
        // Resolve marker/conversation reads before writing anything, then
        // refresh the lease immediately before the transaction's first write.
        const workSnapshot = await tx.get(this.store.doc('emailObserverWork', fence.id));
        const work = workSnapshot.exists
          ? decodeRecord<Records['emailObserverWork']>(workSnapshot.data())
          : null;
        if (!matchesPreparedEmailObserverClaim(work, fence, this.store.now()))
          throw new Error('Email observer notification conversation claim expired');
      }
      if (noticeFence) {
        const [taskSnapshot, applicationSnapshot] = await tx.getAll(
          this.store.doc('tasks', noticeFence.taskId),
          this.store.doc('applicationConfirmations', noticeFence.applicationId),
        );
        if (
          !matchesApplicationConfirmationNoticeLineage(
            taskSnapshot?.exists ? decodeRecord<Records['tasks']>(taskSnapshot.data()) : null,
            applicationSnapshot?.exists
              ? decodeRecord<Records['applicationConfirmations']>(applicationSnapshot.data())
              : null,
            noticeFence,
            { now: this.store.now(), requireLiveTaskLease: true },
          )
        )
          throw new Error('Application confirmation conversation claim expired');
      }
      const now = this.store.now();
      if (destination.createNotificationsMarker)
        tx.create(this.store.doc('notificationConversations', this.agentId), {
          agentId: this.agentId,
          conversationId: destination.row.id,
          createdAt: now,
        });
      const ref = this.store.doc('conversations', destination.row.id);
      if (destination.created)
        tx.create(ref, conversationDocument({ ...destination.row, updatedAt: now }));
      else if (destination.row.archivedAt)
        tx.update(ref, { archivedAt: null, archived: false, updatedAt: now });
      return destination.row.id;
    });
  }

  async getOrCreate(
    agentId: string,
    fence?: EmailObserverEffectFence,
    noticeFence?: ApplicationConfirmationNoticeFence,
  ): Promise<string> {
    if (!this.agentId || agentId !== this.agentId)
      throw new Error('Notifications conversation is outside the configured owner');
    return this.notificationsConversationId(fence, noticeFence);
  }

  async post(input: {
    text: string;
    taskId?: string;
    sourceConversationId?: string | null;
    extraParts?: readonly unknown[];
  }): Promise<{ conversationId: string } | null> {
    const fence = await readPrivacyErasureFence(this.store, this.agentId);
    return this.store.db.runTransaction(async (tx) => {
      await this.owner(tx);
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', this.agentId));
      if (erasure.exists) {
        if (
          erasure.get('agentId') !== this.agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime ||
          !fence?.isEqual(erasure.updateTime)
        )
          throw new Error('Privacy erasure changed during owner notice');
      } else if (fence) {
        throw new Error('Privacy erasure changed during owner notice');
      }
      if (input.taskId) {
        const task = await tx.get(this.store.doc('tasks', input.taskId));
        if (!task.exists || task.get('id') !== input.taskId || task.get('agentId') !== this.agentId)
          throw new Error('Owner notice task is outside the configured installation');
      }
      const primary = await this.primary(tx);
      if (primary && input.sourceConversationId === primary.id) return null;
      const destination = primary ? { row: primary, created: false } : await this.notifications(tx);
      if (input.sourceConversationId === destination.row.id) return null;
      const now = this.store.now();
      const message = messageRecord(
        {
          conversationId: destination.row.id,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          role: 'assistant',
          origin: 'assistant',
          parts: [{ type: 'text', text: input.text }, ...(input.extraParts ?? [])],
          text: input.text,
        },
        randomUUID(),
        now,
      );
      const conversationRef = this.store.doc('conversations', destination.row.id);
      if (destination.created)
        tx.create(conversationRef, conversationDocument({ ...destination.row, updatedAt: now }));
      else
        tx.update(conversationRef, {
          updatedAt: now,
          ...(destination.row.archivedAt ? { archivedAt: null, archived: false } : {}),
        });
      tx.create(this.store.doc('messages', message.id), encodeRecord(message));
      return { conversationId: destination.row.id };
    });
  }

  async postWithDecisionFence(
    input: OwnerNoticeDecisionFenceInput,
  ): Promise<OwnerNoticeDecisionFenceResult> {
    if (input.agentId !== this.agentId)
      throw new Error('Owner notice is outside the configured installation');
    const refs = [...new Set(input.suggestionSourceRefs)];
    const requiredRefs = [...new Set(input.requiredSuggestionSourceRefs)];
    const incidents = [
      ...new Map(
        input.securityIncidents.map((entry) => [`${entry.incidentId}:r${entry.revision}`, entry]),
      ).values(),
    ];
    if (
      refs.length > 64 ||
      refs.some((ref) => !ref || ref.length > 2048) ||
      requiredRefs.length > 64 ||
      requiredRefs.some((ref) => !refs.includes(ref)) ||
      incidents.length > 32 ||
      incidents.some(
        (entry) => !entry.incidentId || !Number.isSafeInteger(entry.revision) || entry.revision < 0,
      )
    )
      throw new Error('Invalid owner notice decision fence');
    const fence = await readPrivacyErasureFence(this.store, this.agentId);
    return this.store.db.runTransaction(async (tx) => {
      await this.owner(tx);
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', this.agentId));
      let currentGeneration: string | null = null;
      if (erasure.exists) {
        currentGeneration = erasure.get('generation');
        if (
          erasure.get('agentId') !== this.agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          typeof currentGeneration !== 'string' ||
          !currentGeneration ||
          currentGeneration.length > 100
        )
          throw new Error('Privacy erasure generation is malformed or in progress');
      }
      if (currentGeneration !== input.observationFence)
        throw new Error('Privacy erasure changed during owner notice composition');
      await this.assertErasureUnchanged(tx, fence);

      const inactiveSuggestionSourceRefs: string[] = [];
      const pendingSuggestionWindows: Array<{
        sourceRef: string;
        expiresAt: Date;
        snoozedUntil: Date | null;
      }> = [];
      for (const sourceRef of refs) {
        const matches = await tx.get(
          this.store
            .collection('suggestions')
            .where('agentId', '==', this.agentId)
            .where('sourceRef', '==', sourceRef)
            .limit(2),
        );
        if (matches.size > 1) throw new Error('Ambiguous owner suggestion source');
        const snapshot = matches.docs[0];
        if (!snapshot) {
          if (requiredRefs.includes(sourceRef)) inactiveSuggestionSourceRefs.push(sourceRef);
          continue;
        }
        const suggestion = decodeRecord<Records['suggestions']>(snapshot.data());
        if (
          suggestion.agentId !== this.agentId ||
          documentKey(suggestion.id) !== snapshot.id ||
          suggestion.sourceRef !== sourceRef
        )
          throw new Error('Owner suggestion source identity mismatch');
        const expiresAt = snapshot.get('expiresAt');
        const snoozedUntil = snapshot.get('snoozedUntil');
        const expiresAtDate = expiresAt instanceof Timestamp ? expiresAt.toDate() : null;
        const snoozedUntilDate = snoozedUntil instanceof Timestamp ? snoozedUntil.toDate() : null;
        if (suggestion.status !== 'pending' || !expiresAtDate) {
          inactiveSuggestionSourceRefs.push(sourceRef);
        } else {
          pendingSuggestionWindows.push({
            sourceRef,
            expiresAt: expiresAtDate,
            snoozedUntil: snoozedUntilDate,
          });
        }
      }

      const inactiveSecurityIncidents: Array<{ incidentId: string; revision: number }> = [];
      const attentionToAccept: Array<{
        ref: ReturnType<InstallationStore['doc']>;
        snapshot: DocumentSnapshot;
      }> = [];
      for (const expected of incidents) {
        const attentionId = securityIncidentId(
          this.agentId,
          `attention:${expected.incidentId}:${expected.revision}`,
        );
        const [snapshot, attentionSnapshot] = await Promise.all([
          tx.get(this.store.doc('securityIncidents', expected.incidentId)),
          tx.get(this.store.doc('securityIncidentAttention', attentionId)),
        ]);
        if (!snapshot.exists) {
          inactiveSecurityIncidents.push(expected);
          continue;
        }
        const incident = decodeRecord<Records['securityIncidents']>(snapshot.data());
        if (
          incident.id !== expected.incidentId ||
          incident.agentId !== this.agentId ||
          incident.revision !== expected.revision ||
          (incident.decisionRevision === incident.revision &&
            (incident.disposition === 'dismissed' || incident.disposition === 'expected'))
        )
          inactiveSecurityIncidents.push(expected);
        else if (!attentionSnapshot.exists) {
          throw new Error('Claimed briefing attention receipt is missing');
        } else {
          const attention = decodeRecord<Records['securityIncidentAttention']>(
            attentionSnapshot.data(),
          );
          if (
            attention.id !== attentionId ||
            attention.agentId !== this.agentId ||
            attention.incidentId !== expected.incidentId ||
            attention.revision !== expected.revision ||
            attention.producer !== 'briefing' ||
            attention.deliveryStatus !== 'claimed'
          )
            throw new Error('Claimed briefing attention receipt changed');
          attentionToAccept.push({
            ref: this.store.doc('securityIncidentAttention', attentionId),
            snapshot: attentionSnapshot,
          });
        }
      }
      if (inactiveSuggestionSourceRefs.length || inactiveSecurityIncidents.length)
        return {
          status: 'stale',
          inactiveSuggestionSourceRefs,
          inactiveSecurityIncidents,
        };

      const destination = await this.prepareNoticeInTransaction(tx, input.taskId);
      // Sample the clock only after all source and destination reads have
      // completed. A delayed transaction read must not let an item expire
      // against a timestamp captured before that wait.
      const publicationNow = this.store.now();
      for (const row of pendingSuggestionWindows) {
        if (
          row.expiresAt <= publicationNow ||
          (row.snoozedUntil !== null && row.snoozedUntil > publicationNow)
        )
          inactiveSuggestionSourceRefs.push(row.sourceRef);
      }
      if (inactiveSuggestionSourceRefs.length)
        return {
          status: 'stale',
          inactiveSuggestionSourceRefs,
          inactiveSecurityIncidents,
        };
      const conversationId = destination.row.id;
      this.appendNoticeInTransaction(tx, destination, {
        id: randomUUID(),
        text: input.text,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        extraParts: input.extraParts ?? [],
        now: publicationNow,
      });
      for (const attention of attentionToAccept)
        tx.update(attention.ref, { deliveryStatus: 'accepted', updatedAt: publicationNow });
      return { status: 'posted', conversationId };
    });
  }

  private async assertErasureUnchanged(tx: Transaction, fence: Timestamp | null): Promise<void> {
    const erasure = await tx.get(this.store.doc('privacyErasureJobs', this.agentId));
    if (erasure.exists) {
      if (
        erasure.get('agentId') !== this.agentId ||
        privacyErasureIsActive(erasure.get('status')) ||
        !erasure.updateTime ||
        !fence?.isEqual(erasure.updateTime)
      )
        throw new Error('Privacy erasure changed during owner notice');
    } else if (fence) {
      throw new Error('Privacy erasure changed during owner notice');
    }
  }

  private appendIn(
    tx: Transaction,
    destination: { row: Conversation; created: boolean },
    input: { text: string; taskId?: string; parts: readonly unknown[] },
  ): void {
    const now = this.store.now();
    const message = messageRecord(
      {
        conversationId: destination.row.id,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        role: 'assistant',
        origin: 'assistant',
        parts: [...input.parts],
        text: input.text,
      },
      randomUUID(),
      now,
    );
    const conversationRef = this.store.doc('conversations', destination.row.id);
    if (destination.created)
      tx.create(conversationRef, conversationDocument({ ...destination.row, updatedAt: now }));
    else tx.update(conversationRef, { updatedAt: now });
    tx.create(this.store.doc('messages', message.id), encodeRecord(message));
  }

  /**
   * A waiting-on-owner task notice: into the task's own conversation (any
   * channel), or into Notifications for conversation-less assistant work.
   * Null when the task has neither, matching the PostgreSQL sweep.
   */
  async postTaskNotice(input: {
    taskId: string;
    text: string;
    parts: readonly unknown[];
  }): Promise<{ conversationId: string } | null> {
    if (!input.text || !input.taskId) throw new Error('Task notice requires text and task');
    const fence = await readPrivacyErasureFence(this.store, this.agentId);
    return this.store.db.runTransaction(async (tx) => {
      await this.owner(tx);
      await this.assertErasureUnchanged(tx, fence);
      const task = await tx.get(this.store.doc('tasks', input.taskId));
      if (!task.exists || task.get('id') !== input.taskId || task.get('agentId') !== this.agentId)
        throw new Error('Task notice task is outside the configured installation');
      const conversationId = task.get('conversationId');
      let destination: { row: Conversation; created: boolean } | null = null;
      if (typeof conversationId === 'string' && conversationId) {
        const snapshot = await tx.get(this.store.doc('conversations', conversationId));
        const row = snapshot.exists ? decodeRecord<Conversation>(snapshot.data()) : null;
        if (!row || row.agentId !== this.agentId || documentKey(row.id) !== snapshot.id)
          throw new Error('Task notice conversation identity mismatch');
        destination = { row, created: false };
      } else if (task.get('trust') === 'assistant') {
        destination = await this.notifications(tx);
      }
      if (!destination) return null;
      this.appendIn(tx, destination, { ...input });
      return { conversationId: destination.row.id };
    });
  }

  /**
   * Post to Notifications at most once per dedupe key. The key is a tool-cache
   * entry that expires with its period, committed with the message.
   */
  async postNotificationOnce(input: {
    text: string;
    cacheKey: string;
    toolName: string;
    result: unknown;
    expiresAt: Date;
  }): Promise<boolean> {
    if (!input.text || !input.cacheKey) throw new Error('Notification requires text and key');
    const fence = await readPrivacyErasureFence(this.store, this.agentId);
    return this.store.db.runTransaction(async (tx) => {
      await this.owner(tx);
      await this.assertErasureUnchanged(tx, fence);
      const keyRef = this.store.doc('toolCache', input.cacheKey);
      if ((await tx.get(keyRef)).exists) return false;
      const destination = await this.notifications(tx);
      this.appendIn(tx, destination, {
        text: input.text,
        parts: [{ type: 'text', text: input.text }],
      });
      tx.create(
        keyRef,
        encodeRecord({
          cacheKey: input.cacheKey,
          toolName: input.toolName,
          result: input.result,
          expiresAt: input.expiresAt,
        }),
      );
      return true;
    });
  }

  /** The owner.notify tool writes to its task chat, or to Notifications without one. */
  async postToolNotice(input: {
    text: string;
    taskId: string;
    conversationId?: string | null;
  }): Promise<{ conversationId: string }> {
    if (!input.text || !input.taskId) throw new Error('Owner tool notice requires text and task');
    const fence = await readPrivacyErasureFence(this.store, this.agentId);
    return this.store.db.runTransaction(async (tx) => {
      await this.owner(tx);
      const [erasure, task] = await tx.getAll(
        this.store.doc('privacyErasureJobs', this.agentId),
        this.store.doc('tasks', input.taskId),
      );
      if (!erasure || !task) throw new Error('Owner tool notice state is unavailable');
      if (erasure.exists) {
        if (
          erasure.get('agentId') !== this.agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime ||
          !fence?.isEqual(erasure.updateTime)
        )
          throw new Error('Privacy erasure changed during owner tool notice');
      } else if (fence) {
        throw new Error('Privacy erasure changed during owner tool notice');
      }
      if (!task.exists || task.get('id') !== input.taskId || task.get('agentId') !== this.agentId)
        throw new Error('Owner tool notice task is outside the configured installation');
      if (
        input.conversationId &&
        task.get('conversationId') &&
        task.get('conversationId') !== input.conversationId
      )
        throw new Error('Owner tool notice conversation does not match its task');
      const destination = input.conversationId
        ? {
            row: ownedConversation(
              await tx.get(this.store.doc('conversations', input.conversationId)),
              this.agentId,
            ),
            created: false,
          }
        : await this.notifications(tx);
      const now = this.store.now();
      const message = messageRecord(
        {
          conversationId: destination.row.id,
          taskId: input.taskId,
          role: 'assistant',
          origin: 'assistant',
          parts: [{ type: 'text', text: input.text }],
          text: input.text,
        },
        randomUUID(),
        now,
      );
      const conversationRef = this.store.doc('conversations', destination.row.id);
      if (destination.created)
        tx.create(conversationRef, conversationDocument({ ...destination.row, updatedAt: now }));
      else
        tx.update(conversationRef, {
          updatedAt: now,
          ...(destination.row.archivedAt ? { archivedAt: null, archived: false } : {}),
        });
      tx.create(this.store.doc('messages', message.id), encodeRecord(message));
      return { conversationId: destination.row.id };
    });
  }
}

/** Background producers' notices through the owner-notice sink: primary chat, else Notifications. */
export function firestoreOwnerNotices(
  notices: FirestoreOwnerNoticeRepository,
): OwnerNoticeRepository {
  return {
    kind: 'owner-notice-repository',
    observationFence(agentId) {
      if (agentId !== notices.agentId)
        throw new Error('Owner notice is outside the configured owner');
      return notices.observationFence(agentId);
    },
    async post(input) {
      if (input.agentId !== notices.agentId)
        throw new Error('Owner notice is outside the configured owner');
      const posted = await notices.post({
        text: input.text,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.extraParts ? { extraParts: input.extraParts } : {}),
      });
      // Only a notice mirrored from its own conversation is skipped, and a
      // producer's notice has no source conversation.
      if (!posted) throw new Error('Owner notice was not posted');
      return posted;
    },
    async postWithDecisionFence(input) {
      if (input.agentId !== notices.agentId)
        throw new Error('Owner notice is outside the configured owner');
      return notices.postWithDecisionFence(input);
    },
  };
}
