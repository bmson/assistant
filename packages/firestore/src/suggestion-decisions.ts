import { createHash, randomUUID } from 'node:crypto';
import {
  emailBookingOccurrenceId,
  newTaskRecord,
  type Records,
  type TaskCreateInput,
} from '@assistant/persistence';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { createWakeIntent } from './outbox.js';
import { privacyErasureIsActive, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Suggestion = Records['suggestions'];
type Conversation = Records['conversations'];
export type SuggestionDecisionResult = {
  ok: boolean;
  taskId?: string;
  snoozedUntil?: string;
  reason?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function deadline(row: Suggestion): Date | null {
  if (row.origin !== 'briefing') return null;
  const calendar =
    /^Create a calendar event on the owner's own calendar with no attendees for: [\s\S]*\. It starts at (\S+)(?: \([^)]+\))?\. This came from an email from [\s\S]*\. Check the calendar first[\s\S]*\.$/.exec(
      row.proposedAction,
    )?.[1];
  const allDay =
    /^Create an all-day calendar event on the owner's own calendar with no attendees for: [\s\S]*\. Use start (\d{4}-\d{2}-\d{2}), exclusive end \d{4}-\d{2}-\d{2}, and allDay true\./.exec(
      row.proposedAction,
    )?.[1];
  const reminder = /^Set a reminder two days before (\S+) about: /.exec(row.proposedAction)?.[1];
  const raw = calendar ?? allDay ?? reminder;
  if (
    !raw ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(raw)
  )
    return null;
  const time = new Date(raw).getTime() + (allDay ? DAY_MS : 0) - (reminder ? 2 * DAY_MS : 0);
  return Number.isFinite(time) ? new Date(time) : null;
}

function expiresAt(row: Suggestion): Date {
  const dated = deadline(row);
  return dated && dated < row.expiresAt ? dated : row.expiresAt;
}

function ownedConversation(snapshot: DocumentSnapshot, agentId: string): Conversation {
  const row = decodeRecord<Conversation>(snapshot.data());
  if (
    !snapshot.exists ||
    row.agentId !== agentId ||
    documentKey(row.id) !== snapshot.id ||
    row.channel !== 'chat' ||
    row.archivedAt
  )
    throw new Error('Suggestion conversation is unavailable');
  return row;
}

/** Atomic owner decisions for imported and newly produced suggestion cards. */
export class FirestoreSuggestionDecisionRepository {
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
      owner.id !== documentKey(this.agentId) ||
      owner.get('id') !== this.agentId
    )
      throw new Error('Suggestion decisions require exactly one configured owner');
  }

  private async destination(
    tx: Transaction,
    row: Suggestion,
    now: Date,
  ): Promise<{ conversation: Conversation; create: boolean; marker: boolean }> {
    if (row.conversationId) {
      const snapshot = await tx.get(this.store.doc('conversations', row.conversationId));
      return {
        conversation: ownedConversation(snapshot, this.agentId),
        create: false,
        marker: false,
      };
    }
    const markerRef = this.store.doc('primaryConversations', this.agentId);
    const marker = await tx.get(markerRef);
    if (marker.exists) {
      const id = marker.get('conversationId');
      if (marker.get('agentId') !== this.agentId || typeof id !== 'string' || !id)
        throw new Error('Primary conversation marker is malformed');
      const snapshot = await tx.get(this.store.doc('conversations', id));
      const conversation = ownedConversation(snapshot, this.agentId);
      if (!conversation.isPrimary) throw new Error('Primary conversation marker is stale');
      return { conversation, create: false, marker: false };
    }
    const matches = await tx.get(
      this.store
        .collection('conversations')
        .where('agentId', '==', this.agentId)
        .where('isPrimary', '==', true)
        .limit(2),
    );
    if (matches.size > 1) throw new Error('Ambiguous primary conversation');
    const existing = matches.docs[0];
    if (existing) {
      const conversation = ownedConversation(existing, this.agentId);
      return { conversation, create: false, marker: true };
    }
    return {
      conversation: {
        id: randomUUID(),
        agentId: this.agentId,
        channel: 'chat',
        trust: 'owner',
        title: 'Chat',
        isPrimary: true,
        metadata: {},
        archivedAt: null,
        modelOverride: null,
        lastReadAt: null,
        messageSequence: 0,
        createdAt: now,
        updatedAt: now,
      },
      create: true,
      marker: true,
    };
  }

  async decide(
    id: string,
    decision: 'accepted' | 'dismissed' | 'snoozed',
    now = this.store.now(),
  ): Promise<SuggestionDecisionResult> {
    if (!id || !Number.isFinite(now.getTime())) throw new Error('Invalid suggestion decision');
    const erasureFence = await readPrivacyErasureFence(this.store, this.agentId);
    return this.store.db.runTransaction(async (tx) => {
      await this.owner(tx);
      const [snapshot, erasure] = await tx.getAll(
        this.store.doc('suggestions', id),
        this.store.doc('privacyErasureJobs', this.agentId),
      );
      if (!snapshot || !erasure) throw new Error('Suggestion state is unavailable');
      if (erasure.exists) {
        if (
          erasure.get('agentId') !== this.agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime ||
          !erasureFence?.isEqual(erasure.updateTime)
        )
          throw new Error('Privacy erasure is in progress');
      } else if (erasureFence) {
        throw new Error('Privacy erasure changed during suggestion decision');
      }
      if (!snapshot.exists) return { ok: false, reason: 'This suggestion is no longer open.' };
      const row = decodeRecord<Suggestion>(snapshot.data());
      if (row.id !== id || documentKey(row.id) !== snapshot.id || row.agentId !== this.agentId)
        return { ok: false, reason: 'This suggestion is no longer open.' };
      if (decision === 'accepted' && row.status === 'accepted' && row.acceptedTaskId) {
        const task = await tx.get(this.store.doc('tasks', row.acceptedTaskId));
        if (
          task.exists &&
          task.get('agentId') === this.agentId &&
          task.get('id') === row.acceptedTaskId
        )
          return { ok: true, taskId: row.acceptedTaskId };
        throw new Error('Accepted suggestion task is unavailable');
      }
      if (decision === 'dismissed' && row.status === 'dismissed') return { ok: true };
      if (
        decision === 'snoozed' &&
        row.status === 'snoozed' &&
        row.snoozedUntil &&
        row.snoozedUntil > now &&
        expiresAt(row) > now
      )
        return { ok: true, snoozedUntil: row.snoozedUntil.toISOString() };
      if (!['pending', 'snoozed'].includes(row.status) || expiresAt(row) <= now) {
        return { ok: false, reason: 'This suggestion is no longer open.' };
      }
      if (decision === 'dismissed') {
        tx.update(snapshot.ref, { status: 'dismissed', updatedAt: now });
        return { ok: true };
      }
      if (decision === 'snoozed') {
        if (row.snoozedUntil && row.snoozedUntil > now)
          return { ok: true, snoozedUntil: row.snoozedUntil.toISOString() };
        const until = new Date(now.getTime() + DAY_MS);
        const dated = deadline(row);
        if (dated && until >= dated)
          return {
            ok: false,
            reason: 'This suggestion needs a decision sooner. Please accept or dismiss it now.',
          };
        const extended = new Date(Math.max(row.expiresAt.getTime(), until.getTime() + 7 * DAY_MS));
        tx.update(snapshot.ref, {
          status: 'snoozed',
          snoozedUntil: until,
          expiresAt: dated && extended > dated ? dated : extended,
          updatedAt: now,
        });
        return { ok: true, snoozedUntil: until.toISOString() };
      }
      let bookingOccurrence:
        | {
            agentId: string;
            bookingKey: string;
            version: number;
            operation?: 'cancel_existing';
            calendarEventId?: string;
            bookingIdentity?: string;
          }
        | undefined;
      if (
        row.bookingCancellation &&
        (!row.bookingCancellation.calendarEventId?.trim() ||
          !row.bookingCancellation.bookingIdentity?.trim() ||
          !row.bookingKey ||
          !Number.isInteger(row.bookingVersion))
      ) {
        tx.update(snapshot.ref, { status: 'superseded', updatedAt: now });
        return { ok: false, reason: 'This cancellation binding is incomplete.' };
      }
      if (row.bookingKey && row.bookingVersion !== null) {
        const occurrenceRef = this.store.doc(
          'emailBookingOccurrences',
          emailBookingOccurrenceId(this.agentId, row.bookingKey),
        );
        const occurrenceSnapshot = await tx.get(occurrenceRef);
        const occurrence = occurrenceSnapshot.exists
          ? decodeRecord<Records['emailBookingOccurrences']>(occurrenceSnapshot.data())
          : null;
        if (
          !occurrence ||
          occurrence.agentId !== this.agentId ||
          occurrence.bookingKey !== row.bookingKey ||
          occurrence.version !== row.bookingVersion ||
          occurrence.sourceAuthenticated !== true ||
          !(row.bookingCancellation
            ? occurrence.lifecycle === 'cancelled'
            : ['confirmed', 'rescheduled'].includes(occurrence.lifecycle))
        ) {
          tx.update(snapshot.ref, { status: 'superseded', updatedAt: now });
          return {
            ok: false,
            reason: 'This booking changed. Review the latest email before accepting.',
          };
        }
        bookingOccurrence = {
          agentId: this.agentId,
          bookingKey: row.bookingKey,
          version: row.bookingVersion,
          ...(row.bookingCancellation
            ? {
                operation: 'cancel_existing' as const,
                calendarEventId: row.bookingCancellation.calendarEventId,
                bookingIdentity: row.bookingCancellation.bookingIdentity,
              }
            : {}),
        };
      } else if (row.bookingCancellation) {
        tx.update(snapshot.ref, { status: 'superseded', updatedAt: now });
        return {
          ok: false,
          reason: 'This booking cancellation is no longer current.',
        };
      }
      const destination = await this.destination(tx, row, now);
      const eventId = `suggestion:${id}`;
      const eventRef = this.store.doc(
        'taskEventKeys',
        createHash('sha256').update(eventId).digest('hex'),
      );
      const event = await tx.get(eventRef);
      if (event.exists) throw new Error('Open suggestion already has a task event');
      const taskId = randomUUID();
      const trigger = {
        source: 'internal',
        externalEventId: eventId,
        agentId: this.agentId,
        conversationId: destination.conversation.id,
        trust: 'owner',
        payload: {
          instruction: row.proposedAction,
          taintedOrigin: true,
          suggestionId: id,
          ...(row.origin === 'known_sender_reply'
            ? {
                acceptedProposal: {
                  version: 1,
                  suggestionId: id,
                  kind: 'known_sender_reply',
                  scopes: ['external_send'],
                },
              }
            : {}),
          ...(bookingOccurrence ? { bookingOccurrence } : {}),
        },
      } satisfies TaskCreateInput['trigger'];
      const task = newTaskRecord(
        {
          agentId: this.agentId,
          conversationId: destination.conversation.id,
          type: 'adhoc',
          trust: 'owner',
          externalEventId: eventId,
          trigger,
        },
        taskId,
        now,
      );
      if (destination.create)
        tx.create(
          this.store.doc('conversations', destination.conversation.id),
          encodeRecord(destination.conversation),
        );
      if (destination.marker)
        tx.create(this.store.doc('primaryConversations', this.agentId), {
          agentId: this.agentId,
          conversationId: destination.conversation.id,
          createdAt: now,
        });
      tx.create(this.store.doc('tasks', taskId), encodeRecord(task));
      tx.create(eventRef, { taskId, createdAt: now });
      tx.update(snapshot.ref, {
        status: 'accepted',
        acceptedTaskId: taskId,
        conversationId: destination.conversation.id,
        updatedAt: now,
      });
      createWakeIntent(tx, this.store, { taskId, generation: 0, availableAt: now });
      return { ok: true, taskId };
    });
  }
}
