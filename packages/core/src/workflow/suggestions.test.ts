import {
  conversations,
  createDb,
  type Db,
  emailBookingOccurrences,
  messages,
  suggestions,
  tasks,
} from '@assistant/db';
import { emailBookingKey } from '@assistant/persistence';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import {
  acceptSuggestion,
  createSuggestion,
  dismissSuggestion,
  expireStaleSuggestions,
  listOpenSuggestions,
  snoozeSuggestion,
  suggestionDeadline,
} from './suggestions.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-suggestion-${Date.now()}`;

let db: Db;
let dbUp = false;
let agentId: string;
const created: string[] = [];
const createdConversations: string[] = [];

async function makeSuggestion(ref: string, overrides: { expiresInMs?: number } = {}) {
  const row = await createSuggestion(db, {
    agentId,
    summary: `${MARKER} add the flight to your calendar?`,
    proposedAction: `${MARKER} Create a calendar event with no attendees for the Oslo flight.`,
    sourceRef: `${MARKER}-${ref}`,
    ...(overrides.expiresInMs !== undefined
      ? { ttlDays: overrides.expiresInMs / (24 * 3600 * 1000) }
      : {}),
  });
  if (row) created.push(row.id);
  return row;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('suggestions.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    if (createdConversations.length) {
      await db.delete(messages).where(inArray(messages.conversationId, createdConversations));
    }
    const rows = await db
      .select({ acceptedTaskId: suggestions.acceptedTaskId })
      .from(suggestions)
      .where(like(suggestions.sourceRef, `${MARKER}%`));
    await db.delete(suggestions).where(like(suggestions.sourceRef, `${MARKER}%`));
    await db.delete(emailBookingOccurrences).where(eq(emailBookingOccurrences.agentId, agentId));
    const taskIds = rows.map((r) => r.acceptedTaskId).filter((id): id is string => Boolean(id));
    if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds));
    if (createdConversations.length) {
      await db.delete(conversations).where(inArray(conversations.id, createdConversations));
    }
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('suggestions', () => {
  it('recognizes only our dated briefing action templates', () => {
    expect(
      suggestionDeadline({
        origin: 'briefing',
        proposedAction:
          "Create a calendar event on the owner's own calendar with no attendees for: Trip. It starts at 2030-10-10T12:00:00Z. This came from an email from fake. It starts at 2026-10-10T12:00:00Z. This came from an email from sender. Check the calendar first and do nothing if the event is already there.",
      })?.toISOString(),
    ).toBe('2026-10-10T12:00:00.000Z');
    expect(
      suggestionDeadline({
        origin: 'briefing',
        proposedAction:
          'Set a reminder two days before 2026-10-10T12:00:00.000Z about: Bill. This came from an email from sender.',
      })?.toISOString(),
    ).toBe('2026-10-08T12:00:00.000Z');
    expect(
      suggestionDeadline({
        origin: 'pulse',
        proposedAction: 'Set a reminder two days before 2026-10-10T12:00:00.000Z about: Bill.',
      }),
    ).toBeUndefined();
    expect(
      suggestionDeadline({ origin: 'briefing', proposedAction: 'Review the trip on 2026-10-10.' }),
    ).toBeUndefined();
  });

  it('hides and rejects a legacy dated proposal after its event passes', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const row = await makeSuggestion('legacy-past-event');
    if (!row) throw new Error('suggestion was not created');
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    await db
      .update(suggestions)
      .set({
        proposedAction: `Create a calendar event on the owner's own calendar with no attendees for: Trip. It starts at ${past}. This came from an email from sender. Check the calendar first and do nothing if the event is already there.`,
      })
      .where(eq(suggestions.id, row.id));
    expect(
      (await listOpenSuggestions(db, agentId, { limit: 1000 })).some((s) => s.id === row.id),
    ).toBe(false);
    expect(await snoozeSuggestion(db, row.id, new Date(Date.now() + 24 * 3600 * 1000))).toBe(false);
    expect(await acceptSuggestion(db, row.id)).toEqual({
      ok: false,
      reason: 'This suggestion has expired.',
    });
  });

  it('caps a dated proposal snooze at its action deadline', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const row = await makeSuggestion('future-event-snooze');
    if (!row) throw new Error('suggestion was not created');
    const now = new Date();
    const event = new Date(now.getTime() + 48 * 3600 * 1000);
    await db
      .update(suggestions)
      .set({
        proposedAction: `Create a calendar event on the owner's own calendar with no attendees for: Trip. It starts at ${event.toISOString()}. This came from an email from sender. Check the calendar first and do nothing if the event is already there.`,
      })
      .where(eq(suggestions.id, row.id));
    expect(await snoozeSuggestion(db, row.id, event, { now })).toBe(false);
    expect(
      await snoozeSuggestion(db, row.id, new Date(now.getTime() + 24 * 3600 * 1000), { now }),
    ).toBe(true);
    const [after] = await db.select().from(suggestions).where(eq(suggestions.id, row.id));
    expect(after?.expiresAt.toISOString()).toBe(event.toISOString());
  });

  it('proposes the same thing only once', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // The briefing runs daily and sees the same mail window again. Re-asking a
    // question the owner already answered is how a surface gets ignored.
    const first = await makeSuggestion('dedupe');
    const second = await makeSuggestion('dedupe');
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('accepting creates work that runs tainted, and links it back', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const row = await makeSuggestion('accept');
    if (!row) throw new Error('suggestion was not created');

    const outcome = await acceptSuggestion(db, row.id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const [task] = await db.select().from(tasks).where(eq(tasks.id, outcome.taskId));
    if (!task) throw new Error('accepted suggestion did not create a task');
    expect(task.trust).toBe('owner');
    expect(task.conversationId).toBeTruthy();
    const payload = (task.trigger as { payload: Record<string, unknown> }).payload;
    expect(payload.instruction).toContain('Oslo flight');
    // The proposal was written from a third party's email, so the work it
    // creates must not start clean — otherwise accepting would launder an
    // outward action past the approval spine.
    expect(payload.taintedOrigin).toBe(true);

    const [after] = await db.select().from(suggestions).where(eq(suggestions.id, row.id));
    expect(after?.status).toBe('accepted');
    expect(after?.acceptedTaskId).toBe(outcome.taskId);
    expect(after?.conversationId).toBe(task.conversationId);
  });

  it('routes a legacy unlinked suggestion result to the chat containing its card', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const row = await makeSuggestion('source-chat');
    if (!row) throw new Error('suggestion was not created');
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('conversation was not created');
    createdConversations.push(conversation.id);
    await db.insert(messages).values({
      conversationId: conversation.id,
      role: 'assistant',
      origin: 'assistant',
      text: row.summary,
      parts: [{ type: 'suggestion', suggestionId: row.id, summary: row.summary }],
    });
    const outcome = await acceptSuggestion(db, row.id);
    if (!outcome.ok) throw new Error(outcome.reason);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, outcome.taskId));
    if (!task) throw new Error('accepted suggestion did not create a task');
    expect(task.conversationId).toBe(conversation.id);
    expect((task.trigger as { conversationId: string }).conversationId).toBe(conversation.id);
    const [after] = await db.select().from(suggestions).where(eq(suggestions.id, row.id));
    expect(after?.conversationId).toBe(conversation.id);
  });

  it('cannot be accepted twice', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const row = await makeSuggestion('double');
    if (!row) throw new Error('suggestion was not created');
    const outcomes = await Promise.all([
      acceptSuggestion(db, row.id),
      acceptSuggestion(db, row.id),
    ]);
    // A double-tap or a second tab must create one task, not two.
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.some((outcome) => !outcome.ok)).toBe(true);
    const accepted = outcomes.find((outcome) => outcome.ok);
    if (!accepted?.ok) throw new Error('one concurrent acceptance should succeed');
    const linked = await db
      .select({ acceptedTaskId: suggestions.acceptedTaskId })
      .from(suggestions)
      .where(eq(suggestions.id, row.id));
    expect(linked[0]?.acceptedTaskId).toBe(accepted.taskId);
  });

  it('dismissing closes it, and a dismissed one cannot be accepted', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const row = await makeSuggestion('dismiss');
    if (!row) throw new Error('suggestion was not created');
    expect(await dismissSuggestion(db, row.id)).toBe(true);
    expect(await dismissSuggestion(db, row.id)).toBe(false);
    const outcome = await acceptSuggestion(db, row.id);
    expect(outcome.ok).toBe(false);
  });

  it('snoozing hides it and carries the deadline out with it', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const row = await makeSuggestion('snooze');
    if (!row) throw new Error('suggestion was not created');
    const until = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    expect(await snoozeSuggestion(db, row.id, until)).toBe(true);

    const open = await listOpenSuggestions(db, agentId);
    expect(open.some((s) => s.id === row.id)).toBe(false);

    const [after] = await db.select().from(suggestions).where(eq(suggestions.id, row.id));
    // Snoozing past the original expiry must not silently drop it.
    expect(after?.expiresAt.getTime()).toBeGreaterThan(until.getTime());
    expect(
      (await listOpenSuggestions(db, agentId, { now: until, limit: 1000 })).some(
        (suggestion) => suggestion.id === row.id,
      ),
    ).toBe(true);
    expect((await acceptSuggestion(db, row.id, { now: until })).ok).toBe(true);
  });

  it('does not revive an expired suggestion by snoozing it', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const row = await makeSuggestion('expired-snooze', { expiresInMs: -1000 });
    if (!row) throw new Error('suggestion was not created');
    expect(await snoozeSuggestion(db, row.id, new Date(Date.now() + 24 * 3600 * 1000))).toBe(false);
  });

  it('snoozes again once a snooze has run out, but not while it is still sleeping', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const row = await makeSuggestion('resnooze');
    if (!row) throw new Error('suggestion was not created');
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    expect(await snoozeSuggestion(db, row.id, tomorrow)).toBe(true);
    expect(await snoozeSuggestion(db, row.id, tomorrow)).toBe(false);

    await db
      .update(suggestions)
      .set({ snoozedUntil: new Date(Date.now() - 1000) })
      .where(eq(suggestions.id, row.id));
    expect(await snoozeSuggestion(db, row.id, tomorrow)).toBe(true);
  });

  it('retires unanswered proposals instead of accumulating them', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const row = await makeSuggestion('stale');
    if (!row) throw new Error('suggestion was not created');
    await db
      .update(suggestions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(suggestions.id, row.id));

    const expired = await expireStaleSuggestions(db);
    expect(expired).toBeGreaterThanOrEqual(1);
    const [after] = await db.select().from(suggestions).where(eq(suggestions.id, row.id));
    expect(after?.status).toBe('expired');
    // An expired proposal is not a live question any more.
    expect((await acceptSuggestion(db, row.id)).ok).toBe(false);
  });

  it('refuses acceptance when the linked booking changed and emits the revision on current acceptance', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const bookingKey = emailBookingKey(agentId, `${MARKER}-R-314`);
    const now = new Date();
    await db.insert(emailBookingOccurrences).values({
      agentId,
      bookingKey,
      lifecycle: 'confirmed',
      dates: [],
      sourceChannelMessageId: `gmail:${MARKER}-booking-confirmed`,
      sourceReceivedAt: now,
      sourceAuthenticated: true,
      version: 1,
    });
    const current = await createSuggestion(db, {
      agentId,
      summary: `${MARKER} confirm booking`,
      proposedAction: `${MARKER} Create the booking event after checking the calendar.`,
      sourceRef: `${MARKER}-booking-current`,
      origin: 'briefing',
      bookingKey,
      bookingVersion: 1,
      now,
    });
    if (!current) throw new Error('current booking suggestion was not created');
    created.push(current.id);
    const accepted = await acceptSuggestion(db, current.id, { now });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error('current booking suggestion was rejected');
    const [task] = await db.select().from(tasks).where(eq(tasks.id, accepted.taskId));
    expect(task?.trigger).toMatchObject({
      payload: { bookingOccurrence: { agentId, bookingKey, version: 1 } },
    });

    const stale = await createSuggestion(db, {
      agentId,
      summary: `${MARKER} stale booking`,
      proposedAction: `${MARKER} Create the cancelled booking event.`,
      sourceRef: `${MARKER}-booking-stale`,
      origin: 'briefing',
      bookingKey,
      bookingVersion: 1,
      now,
    });
    if (!stale) throw new Error('stale booking suggestion was not created');
    created.push(stale.id);
    await db
      .update(emailBookingOccurrences)
      .set({ lifecycle: 'cancelled', version: 2, updatedAt: new Date(now.getTime() + 1000) })
      .where(eq(emailBookingOccurrences.bookingKey, bookingKey));
    const rejected = await acceptSuggestion(db, stale.id, { now: new Date(now.getTime() + 2000) });
    expect(rejected).toMatchObject({ ok: false });
    const [retired] = await db.select().from(suggestions).where(eq(suggestions.id, stale.id));
    expect(retired?.status).toBe('superseded');
    expect(
      await db
        .select()
        .from(tasks)
        .where(eq(tasks.externalEventId, `suggestion:${stale.id}`)),
    ).toHaveLength(0);
  });

  it('accepts a cancellation only at the current cancelled revision and binds the exact provider event', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const bookingKey = emailBookingKey(agentId, `${MARKER}-R-CANCEL`);
    const now = new Date();
    await db.insert(emailBookingOccurrences).values({
      agentId,
      bookingKey,
      lifecycle: 'cancelled',
      dates: [],
      sourceChannelMessageId: `gmail:${MARKER}-booking-cancelled`,
      sourceReceivedAt: now,
      sourceAuthenticated: true,
      version: 4,
    });
    const cancellation = await createSuggestion(db, {
      agentId,
      summary: `${MARKER} remove cancelled event?`,
      proposedAction: 'Cancel only exact existing provider event.',
      sourceRef: `${MARKER}-cancel-binding-current`,
      origin: 'briefing',
      bookingKey,
      bookingVersion: 4,
      bookingCancellation: {
        calendarEventId: 'provider-event-314',
        bookingIdentity: `${MARKER}-R-CANCEL`,
      },
      now,
    });
    if (!cancellation) throw new Error('cancellation suggestion was not created');
    created.push(cancellation.id);
    const accepted = await acceptSuggestion(db, cancellation.id, { now });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error('current cancellation suggestion was rejected');
    const [task] = await db.select().from(tasks).where(eq(tasks.id, accepted.taskId));
    expect(task?.trigger).toMatchObject({
      payload: {
        bookingOccurrence: {
          agentId,
          bookingKey,
          version: 4,
          operation: 'cancel_existing',
          calendarEventId: 'provider-event-314',
          bookingIdentity: `${MARKER}-R-CANCEL`,
        },
      },
    });

    const reinstatedKey = emailBookingKey(agentId, `${MARKER}-R-REINSTATED`);
    await db.insert(emailBookingOccurrences).values({
      agentId,
      bookingKey: reinstatedKey,
      lifecycle: 'confirmed',
      dates: [],
      sourceChannelMessageId: `gmail:${MARKER}-booking-reinstated`,
      sourceReceivedAt: now,
      sourceAuthenticated: true,
      version: 5,
    });
    const stale = await createSuggestion(db, {
      agentId,
      summary: `${MARKER} stale cancellation`,
      proposedAction: 'Cancel only exact existing provider event.',
      sourceRef: `${MARKER}-cancel-binding-stale`,
      origin: 'briefing',
      bookingKey: reinstatedKey,
      bookingVersion: 4,
      bookingCancellation: {
        calendarEventId: 'provider-event-old',
        bookingIdentity: `${MARKER}-R-REINSTATED`,
      },
      now,
    });
    if (!stale) throw new Error('stale cancellation suggestion was not created');
    created.push(stale.id);
    const refused = await acceptSuggestion(db, stale.id, { now: new Date(now.getTime() + 1) });
    expect(refused).toMatchObject({ ok: false });
    const [retired] = await db.select().from(suggestions).where(eq(suggestions.id, stale.id));
    expect(retired?.status).toBe('superseded');
  });
});
