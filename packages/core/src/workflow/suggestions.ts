import {
  conversations,
  type Db,
  emailBookingOccurrences,
  messages,
  type SuggestionRow,
  suggestions,
  type TaskRow,
} from '@assistant/db';
import type {
  MaintenanceRepository,
  SuggestionRecord,
  SuggestionRepository,
} from '@assistant/persistence';
import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { getOrCreatePrimaryConversation } from '../chat.js';
import { getQueueNotifier } from '../queue.js';
import { enqueueTask } from './machine.js';

/**
 * The suggestion surface: how the assistant proposes work without doing it.
 *
 * The anticipation layer's invariant is that untrusted content may inform the
 * owner but never author an outward action. A suggestion honours that literally
 * — it is a row of text. Nothing about it is queued, frozen, or scheduled. When
 * the owner accepts, `acceptSuggestion` enqueues an ordinary task whose
 * instruction is the proposal, and that task runs the full planner and the full
 * approval spine like any other. The suggestion did not act; the owner asked.
 *
 * The accepted task carries `taintedOrigin`, because the proposal was written
 * from a third party's email. Without it the child would start clean and its
 * outward calls would run unapproved — the same laundering hole `task.schedule`
 * closes. Accepting a suggestion therefore buys the owner one decision, not a
 * blanket exemption: a calendar entry on their own calendar goes through, and
 * anything that reaches a person still stops for approval.
 */

const DEFAULT_TTL_DAYS = 7;
const MAX_PENDING = 25;

/** Recover the deadline of our deterministic briefing proposals, including old cards. */
export function suggestionDeadline(suggestion: {
  origin: string;
  proposedAction: string;
}): Date | undefined {
  if (suggestion.origin !== 'briefing') return undefined;
  const calendar =
    /^Create a calendar event on the owner's own calendar with no attendees for: [\s\S]*\. It starts at (\S+)(?: \([^)]+\))?\. This came from an email from [\s\S]*\. Check the calendar first[\s\S]*\.$/.exec(
      suggestion.proposedAction,
    )?.[1];
  const allDay =
    /^Create an all-day calendar event on the owner's own calendar with no attendees for: [\s\S]*\. Use start (\d{4}-\d{2}-\d{2}), exclusive end \d{4}-\d{2}-\d{2}, and allDay true\./.exec(
      suggestion.proposedAction,
    )?.[1];
  const reminder = /^Set a reminder two days before (\S+) about: /.exec(
    suggestion.proposedAction,
  )?.[1];
  const raw = calendar ?? allDay ?? reminder;
  if (
    !raw ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(raw)
  )
    return undefined;
  const instant =
    new Date(raw).getTime() +
    (allDay ? 24 * 3600 * 1000 : 0) -
    (reminder ? 2 * 24 * 3600 * 1000 : 0);
  return Number.isFinite(instant) ? new Date(instant) : undefined;
}

export function suggestionExpiresAt(suggestion: {
  origin: string;
  proposedAction: string;
  expiresAt: Date;
}): Date {
  const deadline = suggestionDeadline(suggestion);
  return deadline && deadline < suggestion.expiresAt ? deadline : suggestion.expiresAt;
}

export interface CreateSuggestionInput {
  agentId: string;
  conversationId?: string;
  summary: string;
  proposedAction: string;
  /** Stable per proposal, so re-running the producer proposes nothing twice. */
  sourceRef: string;
  bookingKey?: string;
  bookingVersion?: number;
  bookingCancellation?: { calendarEventId: string; bookingIdentity: string };
  origin?: string;
  ttlDays?: number;
  now?: Date;
}

/**
 * Record a proposal. Idempotent on `(agentId, sourceRef)`: a producer that runs
 * on a schedule will see the same source again, and the owner should not be
 * asked the same question twice — least of all one they already dismissed.
 * Returns the row when it was newly created, and null when it already existed.
 */
export async function createSuggestion(
  store: Db | SuggestionRepository,
  input: CreateSuggestionInput,
): Promise<SuggestionRow | SuggestionRecord | null> {
  if (
    input.bookingCancellation &&
    (!input.bookingKey ||
      !Number.isInteger(input.bookingVersion) ||
      !input.bookingCancellation.calendarEventId.trim() ||
      !input.bookingCancellation.bookingIdentity.trim())
  )
    throw new Error('Invalid booking cancellation binding');
  const now = input.now ?? new Date();
  const values = {
    agentId: input.agentId,
    summary: input.summary.slice(0, 500),
    proposedAction: input.proposedAction.slice(0, 2000),
    origin: input.origin ?? 'briefing',
    sourceRef: input.sourceRef,
    expiresAt: new Date(now.getTime() + (input.ttlDays ?? DEFAULT_TTL_DAYS) * 24 * 3600 * 1000),
  };
  if (isSuggestionRepository(store))
    return store.create({
      ...values,
      ...(input.bookingKey
        ? { bookingKey: input.bookingKey, bookingVersion: input.bookingVersion }
        : {}),
      ...(input.bookingCancellation ? { bookingCancellation: input.bookingCancellation } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    });
  const [row] = await store
    .insert(suggestions)
    .values({
      ...values,
      bookingKey: input.bookingKey ?? null,
      bookingVersion: input.bookingVersion ?? null,
      bookingCancellation: input.bookingCancellation ?? null,
      conversationId: input.conversationId,
    })
    .onConflictDoNothing({ target: [suggestions.agentId, suggestions.sourceRef] })
    .returning();
  return row ?? null;
}

function isSuggestionRepository(store: Db | SuggestionRepository): store is SuggestionRepository {
  return 'kind' in store && store.kind === 'suggestion-repository';
}

/** A decision applies only to this exact source revision, never a later occurrence. */
export async function inactiveSuggestionSourceRefs(
  store: Db | SuggestionRepository,
  agentId: string,
  sourceRefs: readonly string[],
): Promise<string[]> {
  const refs = [...new Set(sourceRefs)];
  if (refs.length > 64 || refs.some((ref) => !ref || ref.length > 2048))
    throw new Error('Invalid suggestion identity batch');
  if (!refs.length) return [];
  if (isSuggestionRepository(store)) return store.inactiveSourceRefs(agentId, refs);
  const rows = await store
    .select({ sourceRef: suggestions.sourceRef })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.agentId, agentId),
        inArray(suggestions.sourceRef, refs),
        ne(suggestions.status, 'pending'),
      ),
    );
  return rows.map((row) => row.sourceRef);
}

export type AcceptOutcome = { ok: true; taskId: string } | { ok: false; reason: string };
type SuggestionAcceptanceCommit = { outcome: AcceptOutcome; notify?: TaskRow };

/**
 * Promote a suggestion into real work.
 *
 * Status-guarded: the update only matches a row still `pending` or `snoozed`,
 * so a double-tap or a racing tab creates one task, not two. The task is only
 * enqueued once that guard has claimed the row.
 */
export async function acceptSuggestion(
  db: Db,
  suggestionId: string,
  opts: { now?: Date } = {},
): Promise<AcceptOutcome> {
  const now = opts.now ?? new Date();
  const committed = await db.transaction(async (tx): Promise<SuggestionAcceptanceCommit> => {
    const txDb = tx as unknown as Db;
    const [claimed] = await txDb
      .update(suggestions)
      .set({ status: 'accepted', updatedAt: now })
      .where(
        and(
          eq(suggestions.id, suggestionId),
          or(eq(suggestions.status, 'pending'), eq(suggestions.status, 'snoozed')),
        ),
      )
      .returning();
    if (!claimed) return { outcome: { ok: false, reason: 'This suggestion is no longer open.' } };
    if (suggestionExpiresAt(claimed) <= now) {
      await txDb
        .update(suggestions)
        .set({ status: 'expired', updatedAt: now })
        .where(eq(suggestions.id, suggestionId));
      return { outcome: { ok: false, reason: 'This suggestion has expired.' } };
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
    if (claimed.bookingKey && claimed.bookingVersion !== null) {
      if (
        claimed.bookingCancellation &&
        (!claimed.bookingCancellation.calendarEventId?.trim() ||
          !claimed.bookingCancellation.bookingIdentity?.trim())
      ) {
        await txDb
          .update(suggestions)
          .set({ status: 'superseded', updatedAt: now })
          .where(eq(suggestions.id, claimed.id));
        return {
          outcome: { ok: false, reason: 'This cancellation binding is incomplete.' },
        };
      }
      const [occurrence] = await txDb
        .select({
          version: emailBookingOccurrences.version,
          lifecycle: emailBookingOccurrences.lifecycle,
        })
        .from(emailBookingOccurrences)
        .where(
          and(
            eq(emailBookingOccurrences.agentId, claimed.agentId),
            eq(emailBookingOccurrences.bookingKey, claimed.bookingKey),
          ),
        )
        .for('update')
        .limit(1);
      if (
        !occurrence ||
        occurrence.version !== claimed.bookingVersion ||
        !(claimed.bookingCancellation
          ? occurrence.lifecycle === 'cancelled'
          : ['confirmed', 'rescheduled'].includes(occurrence.lifecycle))
      ) {
        await txDb
          .update(suggestions)
          .set({ status: 'superseded', updatedAt: now })
          .where(eq(suggestions.id, claimed.id));
        return {
          outcome: {
            ok: false,
            reason: 'This booking changed. Review the latest email before accepting.',
          },
        };
      }
      bookingOccurrence = {
        agentId: claimed.agentId,
        bookingKey: claimed.bookingKey,
        version: claimed.bookingVersion,
        ...(claimed.bookingCancellation
          ? {
              operation: 'cancel_existing',
              calendarEventId: claimed.bookingCancellation.calendarEventId,
              bookingIdentity: claimed.bookingCancellation.bookingIdentity,
            }
          : {}),
      };
    } else if (claimed.bookingCancellation) {
      await txDb
        .update(suggestions)
        .set({ status: 'superseded', updatedAt: now })
        .where(eq(suggestions.id, claimed.id));
      return {
        outcome: { ok: false, reason: 'This booking cancellation is no longer current.' },
      };
    }

    let conversationId = claimed.conversationId;
    if (!conversationId) {
      // Older pulse/briefing producers created the suggestion before posting
      // its card and never linked the conversation. Without a chat destination
      // accepted work completes silently, leaving "Working on it" forever.
      const [source] = await txDb
        .select({ conversationId: messages.conversationId })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(
          and(
            eq(conversations.agentId, claimed.agentId),
            eq(conversations.channel, 'chat'),
            eq(messages.role, 'assistant'),
            sql`${messages.parts} @> ${JSON.stringify([{ type: 'suggestion', suggestionId: claimed.id }])}::jsonb`,
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(1);
      conversationId =
        source?.conversationId ?? (await getOrCreatePrimaryConversation(txDb, claimed.agentId)).id;
    }

    const { task, created } = await enqueueTask(txDb, {
      type: 'adhoc',
      // Queue delivery is deliberately deferred until the transaction commits:
      // a worker must never see a task whose suggestion link later rolls back.
      deferNotification: true,
      event: {
        source: 'internal',
        externalEventId: `suggestion:${claimed.id}`,
        agentId: claimed.agentId,
        conversationId,
        trust: 'owner',
        payload: {
          instruction: claimed.proposedAction,
          // The proposal was written from third-party content, so the work runs
          // tainted and every outward call stays gated. Accepting is one
          // decision, not an exemption.
          taintedOrigin: true,
          suggestionId: claimed.id,
          ...(claimed.origin === 'known_sender_reply'
            ? {
                acceptedProposal: {
                  version: 1,
                  suggestionId: claimed.id,
                  kind: 'known_sender_reply',
                  scopes: ['external_send'],
                },
              }
            : {}),
          ...(bookingOccurrence ? { bookingOccurrence } : {}),
        },
      },
    });

    await txDb
      .update(suggestions)
      .set({ acceptedTaskId: task.id, conversationId, updatedAt: now })
      .where(eq(suggestions.id, claimed.id));
    return {
      outcome: { ok: true, taskId: task.id } as const,
      notify: created && task.status === 'pending' ? task : undefined,
    };
  });

  if (committed.notify) {
    getQueueNotifier().notify(committed.notify.id, committed.notify.queueGeneration);
  }
  return committed.outcome;
}

/** Close a suggestion the owner does not want. Dismissal is permanent. */
export async function dismissSuggestion(
  db: Db,
  suggestionId: string,
  opts: { now?: Date } = {},
): Promise<boolean> {
  const [row] = await db
    .update(suggestions)
    .set({ status: 'dismissed', updatedAt: opts.now ?? new Date() })
    .where(
      and(
        eq(suggestions.id, suggestionId),
        or(eq(suggestions.status, 'pending'), eq(suggestions.status, 'snoozed')),
      ),
    )
    .returning({ id: suggestions.id });
  return Boolean(row);
}

/** Put a suggestion down for a while without answering it. */
export async function snoozeSuggestion(
  db: Db,
  suggestionId: string,
  until: Date,
  opts: { now?: Date } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  if (!Number.isFinite(until.getTime()) || until <= now) return false;
  const [current] = await db.select().from(suggestions).where(eq(suggestions.id, suggestionId));
  if (!current || suggestionExpiresAt(current) <= now) return false;
  const deadline = suggestionDeadline(current);
  // A dated proposal cannot wake up after its calendar/reminder action is useful.
  if (deadline && until >= deadline) return false;
  const expiresAfterSnooze = new Date(until.getTime() + DEFAULT_TTL_DAYS * 24 * 3600 * 1000);
  const [row] = await db
    .update(suggestions)
    .set({
      status: 'snoozed',
      snoozedUntil: until,
      // Give the owner time to answer after it wakes up. Expiring at `until`
      // would retire the card at exactly the instant it should reappear.
      expiresAt: deadline
        ? sql`LEAST(GREATEST(${suggestions.expiresAt}, ${expiresAfterSnooze.toISOString()}::timestamptz), ${deadline.toISOString()}::timestamptz)`
        : sql`GREATEST(${suggestions.expiresAt}, ${expiresAfterSnooze.toISOString()}::timestamptz)`,
      updatedAt: now,
    })
    .where(
      and(
        eq(suggestions.id, suggestionId),
        gt(suggestions.expiresAt, now),
        // A snooze that has run out reads as pending again, buttons and all, so
        // "Later" has to work on it a second time.
        or(
          eq(suggestions.status, 'pending'),
          and(eq(suggestions.status, 'snoozed'), lte(suggestions.snoozedUntil, now)),
        ),
      ),
    )
    .returning({ id: suggestions.id });
  return Boolean(row);
}

/** Suggestions the owner should see now: pending, unexpired, done snoozing. */
export async function listOpenSuggestions(
  store: Db | SuggestionRepository,
  agentId: string,
  opts: { now?: Date; limit?: number } = {},
): Promise<Array<SuggestionRow | SuggestionRecord>> {
  const now = opts.now ?? new Date();
  const rows = isSuggestionRepository(store)
    ? await store.listOpen(agentId, now)
    : await store
        .select()
        .from(suggestions)
        .where(
          and(
            eq(suggestions.agentId, agentId),
            or(eq(suggestions.status, 'pending'), eq(suggestions.status, 'snoozed')),
            gt(suggestions.expiresAt, now),
            or(isNull(suggestions.snoozedUntil), lte(suggestions.snoozedUntil, now)),
          ),
        )
        .orderBy(asc(suggestions.createdAt));
  // Filter legacy dated proposals before the display cap so stale cards cannot
  // crowd out current work. The query already excludes records beyond their TTL.
  return rows.filter((row) => suggestionExpiresAt(row) > now).slice(0, opts.limit ?? MAX_PENDING);
}

/**
 * Retire suggestions nobody answered. An unanswered proposal is not a task the
 * owner owes anyone — it goes quiet on its own rather than accumulating into a
 * backlog that has to be cleared.
 */
export async function expireStaleSuggestions(
  store: Db | MaintenanceRepository,
  now?: Date,
): Promise<number> {
  if ('kind' in store && store.kind === 'maintenance-repository')
    return (store as MaintenanceRepository).expireSuggestions(now);
  const db = store as Db;
  now ??= new Date();
  const rows = await db
    .update(suggestions)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        or(eq(suggestions.status, 'pending'), eq(suggestions.status, 'snoozed')),
        lte(suggestions.expiresAt, now),
      ),
    )
    .returning({ id: suggestions.id });
  return rows.length;
}
