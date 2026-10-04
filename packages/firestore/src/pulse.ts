import { createHash } from 'node:crypto';
import {
  type PulseCalendarSnapshot,
  type PulseCommitment,
  type PulseMail,
  type PulseNoticeInput,
  type PulseNoticeOutcome,
  type PulseRepository,
  pulseDailyCap,
  type Records,
  type SuggestionRecord,
  validatePulseNotice,
} from '@assistant/persistence';
import type { SituationPackView } from '@assistant/persistence/situations';
import type {
  DocumentReference,
  DocumentSnapshot,
  QueryDocumentSnapshot,
} from '@google-cloud/firestore';
import { FirestoreOwnerNoticeRepository } from './owner-notices.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { FirestoreSituationPackReadRepository } from './situation-packs.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';
import { suggestionIdFor } from './suggestions.js';

/** Stored calendar events per owner: a day and a half of events plus a day of stale ones. */
const SNAPSHOT_LIMIT = 2_000;
/** Moments of one kind the pulse has ever said; one per change, far below this. */
const MOMENT_KEY_LIMIT = 5_000;
/** Recent actionable mail read before the finished-task check. */
const MAIL_SCAN = 100;
/** Soon-due open loops read before snoozes are dropped. */
const COMMITMENT_SCAN = 100;

function snapshotKey(calendarId: string, eventId: string): string {
  return JSON.stringify([calendarId, eventId]);
}

/** A stable id per `(agentId, calendarId, eventId)`: re-seen events update in place. */
function snapshotIdFor(agentId: string, calendarId: string, eventId: string): string {
  return `calendar-snapshot:${createHash('sha256')
    .update(JSON.stringify([agentId, calendarId, eventId]))
    .digest('hex')}`;
}

/** A stable id per `(agentId, momentKey)`, so concurrent claims converge on one document. */
function momentIdFor(agentId: string, momentKey: string): string {
  return `pulse-moment:${createHash('sha256')
    .update(JSON.stringify([agentId, momentKey]))
    .digest('hex')}`;
}

/** UUID-shaped notice identity remains fixed across transaction and task retries. */
function messageIdFor(agentId: string, momentKey: string): string {
  const hex = createHash('sha256')
    .update(JSON.stringify(['pulse-notice', agentId, momentKey]))
    .digest('hex');
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function erasureGeneration(snapshot: DocumentSnapshot, agentId: string): string | null {
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

function assertOwnedIdentity(snapshot: DocumentSnapshot, agentId: string): void {
  const id = snapshot.get('id');
  if (
    typeof id !== 'string' ||
    documentKey(id) !== snapshot.id ||
    snapshot.get('agentId') !== agentId
  )
    throw new Error('Pulse record ownership or identity mismatch');
}

/**
 * The pulse on Firestore. The moment ledger is keyed by `(agentId, momentKey)`
 * like the PostgreSQL unique index; imported moments keep their random ids and
 * are found by query inside the admission transaction. A per-owner coordination
 * document serializes different moment keys as well as identical ones, and the
 * ledger, owner message and new suggestion commit together.
 */
export class FirestorePulseRepository implements PulseRepository {
  readonly kind = 'pulse-repository' as const;
  private readonly packs: FirestoreSituationPackReadRepository;

  constructor(readonly store: InstallationStore) {
    this.packs = new FirestoreSituationPackReadRepository(store);
  }

  async deliveredSince(agentId: string, since: Date): Promise<number> {
    const result = await this.store
      .collection('proactiveMoments')
      .where('agentId', '==', agentId)
      .where('deliveredAt', '>=', since)
      .count()
      .get();
    return result.data().count;
  }

  async ambientDailyCap(agentId: string): Promise<number | null> {
    const snapshot = await this.store.doc('notificationPrefs', agentId).get();
    if (!snapshot.exists || snapshot.get('agentId') !== agentId) return null;
    const cap = snapshot.get('ambientDailyCap');
    return typeof cap === 'number' && Number.isFinite(cap) ? cap : null;
  }

  async momentKeys(agentId: string, kind: string): Promise<string[]> {
    const snapshot = await this.store
      .collection('proactiveMoments')
      .where('agentId', '==', agentId)
      .where('kind', '==', kind)
      .select('momentKey')
      .limit(MOMENT_KEY_LIMIT + 1)
      .get();
    if (snapshot.size > MOMENT_KEY_LIMIT) throw new Error('Pulse moment scan exceeded bound');
    return snapshot.docs.flatMap((doc) => {
      const key = doc.get('momentKey');
      return typeof key === 'string' ? [key] : [];
    });
  }

  private async snapshotDocs(agentId: string): Promise<QueryDocumentSnapshot[]> {
    const snapshot = await this.store
      .collection('calendarEventSnapshots')
      .where('agentId', '==', agentId)
      .limit(SNAPSHOT_LIMIT + 1)
      .get();
    if (snapshot.size > SNAPSHOT_LIMIT) throw new Error('Calendar snapshot scan exceeded bound');
    return snapshot.docs;
  }

  async calendarSnapshot(agentId: string): Promise<PulseCalendarSnapshot[]> {
    return (await this.snapshotDocs(agentId)).flatMap((doc) => {
      const row = decodeRecord<Records['calendarEventSnapshots']>(doc.data());
      if (row.agentId !== agentId || typeof row.calendarId !== 'string') return [];
      return [
        {
          calendarId: row.calendarId,
          eventId: row.eventId,
          iCalUID: row.iCalUID ?? null,
          summary: row.summary,
          start: row.start,
          end: row.end,
          status: row.status ?? null,
          attendeeResponseHash: row.attendeeResponseHash ?? {},
        },
      ];
    });
  }

  async syncCalendarSnapshot(
    agentId: string,
    input: Parameters<PulseRepository['syncCalendarSnapshot']>[1],
  ): Promise<void> {
    const docs = await this.snapshotDocs(agentId);
    const existing = new Map<
      string,
      { ref: DocumentReference; id: string; updatedAt: Date | null }
    >();
    for (const doc of docs) {
      const row = decodeRecord<Records['calendarEventSnapshots']>(doc.data());
      if (row.agentId !== agentId || typeof row.id !== 'string') continue;
      existing.set(snapshotKey(row.calendarId, row.eventId), {
        ref: doc.ref,
        id: row.id,
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt : null,
      });
    }
    const writer = this.store.db.bulkWriter();
    const touched = new Set<string>();
    for (const { calendarId, eventId } of input.cancelled) {
      const key = snapshotKey(calendarId, eventId);
      const found = existing.get(key);
      if (found) writer.delete(found.ref);
      touched.add(key);
    }
    for (const row of input.seen) {
      const key = snapshotKey(row.calendarId, row.eventId);
      if (touched.has(key)) continue;
      touched.add(key);
      // Imported rows keep their ids; new rows get the stable id.
      const found = existing.get(key);
      const id = found?.id ?? snapshotIdFor(agentId, row.calendarId, row.eventId);
      const ref = found?.ref ?? this.store.doc('calendarEventSnapshots', id);
      const record: Records['calendarEventSnapshots'] = {
        id,
        agentId,
        calendarId: row.calendarId,
        eventId: row.eventId,
        iCalUID: row.iCalUID,
        summary: row.summary,
        start: row.start,
        end: row.end,
        status: row.status,
        attendeeResponseHash: row.attendeeResponseHash,
        updatedAt: input.now,
      };
      writer.set(ref, encodeRecord(record));
    }
    // Rows not seen for a day are long past or already reported.
    for (const [key, found] of existing) {
      if (touched.has(key)) continue;
      if (found.updatedAt && found.updatedAt < input.staleBefore) writer.delete(found.ref);
    }
    await writer.close();
  }

  async actionableMail(
    agentId: string,
    input: { since: Date; until: Date; minImportance: number; limit: number },
  ): Promise<PulseMail[]> {
    const snapshot = await this.store
      .collection('emailIngest')
      .where('agentId', '==', agentId)
      .where('actionable', '==', true)
      .where('createdAt', '>=', input.since)
      .orderBy('createdAt', 'desc')
      .limit(MAIL_SCAN)
      .get();
    const candidates = snapshot.docs
      .flatMap((doc) => {
        const row = decodeRecord<Records['emailIngest']>(doc.data());
        return typeof row.id === 'string' &&
          documentKey(row.id) === doc.id &&
          row.agentId === agentId &&
          Number(row.importance) >= input.minImportance &&
          row.createdAt <= input.until
          ? [row]
          : [];
      })
      .sort((a, b) => b.importance - a.importance);
    const rows: PulseMail[] = [];
    for (const row of candidates) {
      if (rows.length >= input.limit) break;
      // Nothing has picked it up: no triage task ran to completion on it.
      const handled = await this.store
        .collection('tasks')
        .where('externalEventId', '==', row.channelMessageId)
        .where('status', '==', 'done')
        .limit(1)
        .get();
      if (!handled.empty) continue;
      rows.push({
        channelMessageId: row.channelMessageId,
        fromEmail: row.fromEmail,
        fromName: row.fromName ?? null,
        subject: row.subject,
        category: row.category,
        importance: row.importance,
      });
    }
    return rows;
  }

  async dueCommitments(
    agentId: string,
    input: { now: Date; until: Date; limit: number },
  ): Promise<PulseCommitment[]> {
    const snapshot = await this.store
      .collection('commitments')
      .where('agentId', '==', agentId)
      .where('status', '==', 'open')
      .where('dueAt', '>=', input.now)
      .where('dueAt', '<=', input.until)
      .orderBy('dueAt', 'asc')
      .limit(COMMITMENT_SCAN)
      .get();
    return snapshot.docs
      .flatMap((doc) => {
        const row = decodeRecord<Records['commitments']>(doc.data());
        if (
          typeof row.id !== 'string' ||
          documentKey(row.id) !== doc.id ||
          row.agentId !== agentId ||
          !(row.dueAt instanceof Date) ||
          (row.snoozedUntil instanceof Date && row.snoozedUntil > input.now)
        )
          return [];
        return [{ id: row.id, title: row.title, nextAction: row.nextAction, dueAt: row.dueAt }];
      })
      .slice(0, input.limit);
  }

  async observationFence(agentId: string): Promise<string | null> {
    return erasureGeneration(await this.store.doc('privacyErasureJobs', agentId).get(), agentId);
  }

  async admitNotice(input: PulseNoticeInput): Promise<PulseNoticeOutcome> {
    validatePulseNotice(input);
    const id = momentIdFor(input.agentId, input.moment.key);
    const ref = this.store.doc('proactiveMoments', id);
    const messageId = messageIdFor(input.agentId, input.moment.key);
    const messageRef = this.store.doc('messages', messageId);
    const coordinationRef = this.store.doc('coordination', `pulse-admission:${input.agentId}`);
    const imported = this.store
      .collection('proactiveMoments')
      .where('agentId', '==', input.agentId)
      .where('momentKey', '==', input.moment.key)
      .limit(2);
    const notices = new FirestoreOwnerNoticeRepository(this.store, input.agentId);
    return this.store.db.runTransaction(async (tx) => {
      // A point read/write makes distinct candidates contend; query-only
      // deduplication would not serialize two previously absent moment keys.
      const coordination = await tx.get(coordinationRef);
      if (coordination.exists && coordination.get('agentId') !== input.agentId)
        throw new Error('Pulse coordination belongs to another owner');
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', input.agentId));
      if (erasureGeneration(erasure, input.agentId) !== input.observationFence)
        throw new Error('Privacy erasure changed during pulse observation');
      // Scope checks also apply to retries and suppressed candidates. Routing
      // resolves a destination without staging a marker or conversation write.
      const destination = await notices.prepareNoticeInTransaction(tx, input.taskId);
      const [byId, byKey] = await Promise.all([tx.get(ref), tx.get(imported)]);
      for (const existing of [byId, ...byKey.docs]) {
        if (!existing.exists) continue;
        assertOwnedIdentity(existing, input.agentId);
        if (existing.get('momentKey') !== input.moment.key)
          throw new Error('Pulse moment identity collision');
      }
      // Imported ledger-only claims are inert: their notice history is unknown.
      if (byId.exists || !byKey.empty) return { status: 'already-said' };
      const prefs = await tx.get(this.store.doc('notificationPrefs', input.agentId));
      if (prefs.exists && prefs.get('agentId') !== input.agentId)
        throw new Error('Notification preferences belong to another owner');
      const dailyCap = pulseDailyCap(
        input.pacing.dailyCap,
        (prefs.exists ? (prefs.get('ambientDailyCap') ?? null) : null) as number | null,
      );
      if (dailyCap === 0) return { status: 'daily-cap' };
      const used = await tx.get(
        this.store
          .collection('proactiveMoments')
          .where('agentId', '==', input.agentId)
          .where('deliveredAt', '>=', input.pacing.windowSince)
          .limit(dailyCap)
          .count(),
      );
      if (used.data().count >= dailyCap) return { status: 'daily-cap' };
      const recent = await tx.get(
        this.store
          .collection('proactiveMoments')
          .where('agentId', '==', input.agentId)
          .where('deliveredAt', '>=', input.pacing.gapSince)
          .limit(1),
      );
      if (!recent.empty) return { status: 'min-gap' };

      const existingMessage = await tx.get(messageRef);
      if (existingMessage.exists)
        throw new Error('Pulse notice exists without its admission ledger');
      let suggestion: SuggestionRecord | null = null;
      if (input.suggestion) {
        const proposal = input.suggestion;
        const suggestionId = suggestionIdFor(input.agentId, proposal.sourceRef);
        const suggestionRef = this.store.doc('suggestions', suggestionId);
        const existingSource = this.store
          .collection('suggestions')
          .where('agentId', '==', input.agentId)
          .where('sourceRef', '==', proposal.sourceRef)
          .limit(2);
        const [byProposalId, bySource] = await Promise.all([
          tx.get(suggestionRef),
          tx.get(existingSource),
        ]);
        for (const existing of [byProposalId, ...bySource.docs]) {
          if (!existing.exists) continue;
          assertOwnedIdentity(existing, input.agentId);
          if (existing.get('sourceRef') !== proposal.sourceRef)
            throw new Error('Pulse suggestion identity collision');
        }
        if (!byProposalId.exists && bySource.empty)
          suggestion = {
            id: suggestionId,
            agentId: input.agentId,
            conversationId: destination.row.id,
            summary: proposal.summary,
            proposedAction: proposal.proposedAction,
            sourceRef: proposal.sourceRef,
            origin: proposal.origin,
            status: 'pending',
            expiresAt: proposal.expiresAt,
            snoozedUntil: null,
            acceptedTaskId: null,
            createdAt: input.now,
            updatedAt: input.now,
          };
      }
      const row: Records['proactiveMoments'] = {
        id,
        agentId: input.agentId,
        kind: input.moment.kind,
        summary: input.moment.summary,
        momentKey: input.moment.key,
        pinged: false,
        deliveredAt: input.now,
      };
      // No transaction reads or external work follow this point.
      tx.set(coordinationRef, {
        agentId: input.agentId,
        momentId: id,
        updatedAt: input.now,
      });
      tx.create(ref, encodeRecord(row));
      if (suggestion)
        tx.create(this.store.doc('suggestions', suggestion.id), encodeRecord(suggestion));
      notices.appendNoticeInTransaction(tx, destination, {
        id: messageId,
        text: input.notice.text,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        now: input.now,
        extraParts: [
          ...input.notice.extraParts,
          ...(suggestion
            ? [
                {
                  type: 'suggestion',
                  suggestionId: suggestion.id,
                  summary: suggestion.summary,
                  proposedAction: suggestion.proposedAction,
                },
              ]
            : []),
        ],
      });
      return {
        status: 'persisted',
        momentId: id,
        messageId,
        conversationId: destination.row.id,
        suggestionCreated: suggestion !== null,
      };
    });
  }

  async markPinged(agentId: string, momentId: string, pinged: boolean): Promise<void> {
    await this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('proactiveMoments', momentId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('agentId') !== agentId) return;
      tx.update(ref, { pinged });
    });
  }

  async situationPacks(agentId: string): Promise<SituationPackView[]> {
    return this.packs.list(agentId);
  }
}
