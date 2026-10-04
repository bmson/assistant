import { randomUUID } from 'node:crypto';
import type {
  NotificationsConversationRepository,
  OwnerNoticeRepository,
  Records,
} from '@assistant/persistence';
import type { DocumentSnapshot, Timestamp, Transaction } from '@google-cloud/firestore';
import { messageRecord } from './messages.js';
import { privacyErasureIsActive, readPrivacyErasureFence } from './privacy-erasure.js';
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
        encodeRecord({ ...destination.row, updatedAt: input.now, archived: false }),
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
  async notificationsConversationId(): Promise<string> {
    return this.store.db.runTransaction(async (tx) => {
      await this.owner(tx);
      const destination = await this.notifications(tx);
      const ref = this.store.doc('conversations', destination.row.id);
      if (destination.created)
        tx.create(ref, encodeRecord({ ...destination.row, archived: false }));
      else if (destination.row.archivedAt)
        tx.update(ref, { archivedAt: null, archived: false, updatedAt: this.store.now() });
      return destination.row.id;
    });
  }

  async getOrCreate(agentId: string): Promise<string> {
    if (!this.agentId || agentId !== this.agentId)
      throw new Error('Notifications conversation is outside the configured owner');
    return this.notificationsConversationId();
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
        tx.create(
          conversationRef,
          encodeRecord({ ...destination.row, updatedAt: now, archived: false }),
        );
      else
        tx.update(conversationRef, {
          updatedAt: now,
          ...(destination.row.archivedAt ? { archivedAt: null, archived: false } : {}),
        });
      tx.create(this.store.doc('messages', message.id), encodeRecord(message));
      return { conversationId: destination.row.id };
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
      tx.create(
        conversationRef,
        encodeRecord({ ...destination.row, updatedAt: now, archived: false }),
      );
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
        tx.create(
          conversationRef,
          encodeRecord({ ...destination.row, updatedAt: now, archived: false }),
        );
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
  };
}
