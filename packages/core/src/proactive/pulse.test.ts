import {
  calendarEventSnapshots,
  conversations,
  createDb,
  type Db,
  emailIngest,
  messages,
  notificationPrefs,
  proactiveMoments,
  suggestions,
} from '@assistant/db';
import { type EmailThreadHeadReader, notificationLeg } from '@assistant/persistence';
import { desc, eq, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import type { BriefingCalendarEvent } from '../workflow/briefing.js';
import { attendeeResponseDigest, type CalendarChange } from './calendar-diff.js';
import type { EventSalience } from './calendar-salience.js';
import {
  calendarChangeMoments,
  eventLeadMoments,
  mailMoment,
  type PulseMoment,
  runPulse,
  selectPulseMoment,
} from './pulse.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-pulse-${Date.now()}`;

const NOW = new Date('2026-03-04T09:00:00Z');

function salient(
  over: Partial<EventSalience['event']> = {},
  reasons: string[] = [],
): EventSalience {
  return {
    event: {
      summary: 'Dentist',
      start: '2026-03-04T09:20:00Z',
      end: '2026-03-04T10:00:00Z',
      calendar: 'Personal',
      allDay: false,
      eventId: 'evt-1',
      ...over,
    },
    score: 5,
    reasons,
  };
}

describe('selectPulseMoment', () => {
  const moment = (over: Partial<PulseMoment>): PulseMoment => ({
    kind: 'commitment-due',
    key: 'k',
    text: 't',
    priority: 1,
    card: {
      kind: 'proactive-alert',
      id: 'k',
      category: 'commitment',
      urgencyLabel: 'Due soon',
      title: 'Test commitment',
    },
    ...over,
  });

  it('says nothing when there is nothing to say', () => {
    expect(selectPulseMoment([])).toBeNull();
  });

  it('delivers exactly one thing, the most urgent', () => {
    const picked = selectPulseMoment([
      moment({ key: 'a', priority: 10 }),
      moment({ key: 'b', priority: 100 }),
      moment({ key: 'c', priority: 50 }),
    ]);
    expect(picked?.key).toBe('b');
  });

  it('breaks ties deterministically, so concurrent sweeps agree', () => {
    const tied = [moment({ key: 'z', priority: 5 }), moment({ key: 'a', priority: 5 })];
    expect(selectPulseMoment(tied)?.key).toBe('a');
    expect(selectPulseMoment([...tied].reverse())?.key).toBe('a');
  });
});

describe('eventLeadMoments', () => {
  it('nudges inside the desk lead time but not before it', () => {
    expect(eventLeadMoments([salient({ start: '2026-03-04T09:10:00Z' })], NOW)).toHaveLength(1);
    expect(eventLeadMoments([salient({ start: '2026-03-04T09:40:00Z' })], NOW)).toHaveLength(0);
  });

  it('names the place once and drops a reason that only repeats it', () => {
    // The headline already carries the address. Salience still needs the
    // `it is at …` marker to pick the travel lead time, but the owner should
    // not read the same street twice in one sentence.
    const travelling = salient({ start: '2026-03-04T09:35:00Z', location: 'Laugavegur 12' }, [
      'it is at Laugavegur 12',
      'it falls outside your usual hours',
    ]);
    const text = eventLeadMoments([travelling], NOW)[0]?.text ?? '';
    expect(text.match(/Laugavegur 12/g)).toHaveLength(1);
    expect(text).not.toContain('it is at');
    expect(text).toContain('It falls outside your usual hours.');
  });

  it('leaves no dangling full stop when the place was the only reason', () => {
    const travelling = salient({ start: '2026-03-04T09:35:00Z', location: 'Laugavegur 12' }, [
      'it is at Laugavegur 12',
    ]);
    expect(eventLeadMoments([travelling], NOW)[0]?.text).toBe(
      'Dentist starts in 35 minutes at Laugavegur 12.',
    );
  });

  it('allows a longer lead when the event means travelling', () => {
    const travelling = salient({ start: '2026-03-04T09:35:00Z', location: 'Laugavegur 12' }, [
      'it is at Laugavegur 12',
    ]);
    const found = eventLeadMoments([travelling], NOW);
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toContain('Laugavegur 12');
    expect(found[0]?.card).toMatchObject({
      kind: 'proactive-alert',
      category: 'event',
      urgencyLabel: 'Starts in 35 min',
      title: 'Dentist',
      details: [
        { label: 'Location', value: 'Laugavegur 12' },
        { label: 'Calendar', value: 'Personal' },
      ],
    });
  });

  it('does not turn an unverified calendar flight time into a travel lead', () => {
    const wrongCalendarFlight = salient(
      {
        summary: 'SFO → BER flight (United)',
        start: '2026-03-04T09:10:00Z',
        end: '2026-03-04T10:00:00Z',
        location: 'Keflavik Airport',
      },
      ['it is at Keflavik Airport', 'it falls outside your usual hours'],
    );
    expect(eventLeadMoments([wrongCalendarFlight], NOW)).toEqual([]);

    const ordinaryMeeting = salient(
      {
        summary: 'Consultant appointment',
        start: '2026-03-04T09:10:00Z',
        end: '2026-03-04T10:00:00Z',
        location: 'Skolavorduholt 1',
      },
      ['it is at Skolavorduholt 1'],
    );
    expect(eventLeadMoments([ordinaryMeeting], NOW)).toHaveLength(1);
  });

  it('ignores all-day entries and anything already started', () => {
    expect(eventLeadMoments([salient({ allDay: true })], NOW)).toHaveLength(0);
    expect(eventLeadMoments([salient({ start: '2026-03-04T08:50:00Z' })], NOW)).toHaveLength(0);
  });

  it('keys on the start time so a moved event earns a fresh nudge', () => {
    const [first] = eventLeadMoments([salient({ start: '2026-03-04T09:10:00Z' })], NOW);
    const [moved] = eventLeadMoments([salient({ start: '2026-03-04T09:12:00Z' })], NOW);
    expect(first?.key).not.toBe(moved?.key);
  });
});

describe('mailMoment', () => {
  const mail = {
    channelMessageId: 'gmail:security-1',
    fromEmail: 'no-reply@example.com',
    fromName: 'Account security',
    subject: 'We noticed a new login',
    importance: 5,
  };

  it('qualifies a classifier result as review, not a verified open obligation', () => {
    const moment = mailMoment(mail);
    expect(moment.card).toMatchObject({
      urgencyLabel: 'Review email',
      title: mail.subject,
      details: [{ label: 'From', value: mail.fromName }],
    });
    expect(moment.card.summary).toBe(
      'The current source has not been reviewed as an outstanding obligation. Check the latest message before acting.',
    );
    expect(moment.text).toBe('Worth checking: “We noticed a new login” from Account security');
    expect(moment.suggestion?.summary).toBe(
      'Check whether “We noticed a new login” still needs attention?',
    );
    expect(moment.suggestion?.proposedAction).toContain('gmail:security-1');
    expect(moment.suggestion?.proposedAction).toContain(
      'Do not treat the original actionable score as proof',
    );
    expect(moment.suggestion?.proposedAction).toContain(
      'Do not send messages, create reminders or calendar events',
    );
    expect(moment.suggestion?.proposedAction).toContain('If nothing is needed, say so.');
  });

  it('offers a reply draft when a person is waiting on the owner', () => {
    const moment = mailMoment({
      ...mail,
      fromName: 'Sam Recruiter',
      subject: 'Re: Interview availability',
      category: 'personal',
    });
    expect(moment.suggestion?.summary).toBe(
      'Check whether a reply is still needed to Sam Recruiter?',
    );
    expect(moment.suggestion?.proposedAction).toContain(
      'Check the current thread for a later owner reply',
    );
    expect(moment.suggestion?.proposedAction).toContain('prepare a draft');
    expect(moment.suggestion?.proposedAction).toContain('Do not send messages');
    expect(moment.suggestion?.proposedAction).toMatch(/If a reply is no longer needed, say so\.$/);
  });

  it('keeps unbounded or multiline source fields out of card layout without losing the source identity', () => {
    const subject = 'Long subject '.repeat(30);
    const moment = mailMoment({ ...mail, fromName: 'Account\n security', subject });
    expect(String(moment.card.title).length).toBeLessThanOrEqual(200);
    expect(moment.card.title).toMatch(/…$/);
    expect(moment.card.details).toEqual([{ label: 'From', value: 'Account security' }]);
    expect(moment.suggestion?.summary).not.toContain('\n');
    expect(moment.suggestion?.proposedAction).toContain(subject.trim());
    const oversized = mailMoment({ ...mail, subject: 'long '.repeat(2_000) });
    expect(oversized.suggestion?.proposedAction.length).toBeLessThan(2_000);
    expect(oversized.suggestion?.proposedAction).toContain('Do not send messages');
    expect(mailMoment({ ...mail, subject: '  ', fromName: ' ' }).card).toMatchObject({
      title: '(no subject)',
      details: [{ label: 'From', value: mail.fromEmail }],
    });
  });
});

describe('runPulse', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;
  let conversationId: string;

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
    } catch {
      console.warn('pulse.test: database unreachable — skipping');
      return;
    }
    const [conv] = await db
      .insert(conversations)
      .values({ agentId, channel: 'email', trust: 'unknown', title: `${MARKER} thread` })
      .returning();
    conversationId = (conv as NonNullable<typeof conv>).id;
  });

  afterEach(async () => {
    if (!dbUp) return;
    await db.delete(proactiveMoments).where(like(proactiveMoments.momentKey, `%${MARKER}%`));
    await db.delete(suggestions).where(like(suggestions.sourceRef, `%${MARKER}%`));
    await db.delete(emailIngest).where(like(emailIngest.channelMessageId, `%${MARKER}%`));
    await db.delete(messages).where(like(messages.text, `%${MARKER}%`));
    await db
      .delete(calendarEventSnapshots)
      .where(like(calendarEventSnapshots.eventId, `%${MARKER}%`));
  });

  afterAll(async () => {
    if (!dbUp) return;
    await db.delete(conversations).where(eq(conversations.id, conversationId));
  });

  const emailThreadReader: EmailThreadHeadReader = async ({ threadId }) => {
    const [latest] = await db
      .select()
      .from(emailIngest)
      .where(eq(emailIngest.providerThreadId, threadId))
      .orderBy(desc(emailIngest.providerReceivedAt))
      .limit(1);
    return latest?.providerMessageId && latest.providerReceivedAt
      ? {
          threadId,
          latestMessageId: latest.providerMessageId,
          latestReceivedAt: latest.providerReceivedAt,
        }
      : null;
  };

  async function addActionableMail(id: string) {
    await db.insert(emailIngest).values({
      agentId,
      conversationId,
      channelMessageId: `gmail:${MARKER}-${id}`,
      providerMessageId: `${MARKER}-${id}`,
      providerThreadId: `${MARKER}-thread-${id}`,
      providerReceivedAt: new Date(NOW.getTime() - 4 * 3600_000),
      fromEmail: 'clinic@hospital.example',
      subject: `${MARKER} your appointment needs confirming`,
      contentTrust: 'unknown',
      authenticated: true,
      category: 'appointment',
      importance: 5,
      actionable: true,
      reason: 'asks you to confirm by Friday',
      // Old enough that the arrival alert is no longer the latest word on it.
      createdAt: new Date(NOW.getTime() - 4 * 3600_000),
    });
  }

  it('stays quiet when nothing is live', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runPulse({ db, emailThreadReader }, { now: NOW });
    expect(result.delivered).toBeNull();
    expect(result.heldBy).toBe('no-candidates');
  });

  it('holds old mail when the provider has a later reply or no current reader', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addActionableMail('mail-stale-provider');
    expect((await runPulse({ db }, { now: NOW })).delivered).toBeNull();
    const result = await runPulse(
      {
        db,
        emailThreadReader: async ({ threadId }) => ({
          threadId,
          latestMessageId: 'a-new-owner-reply',
          latestReceivedAt: NOW,
        }),
      },
      { now: NOW },
    );
    expect(result.delivered).toBeNull();
    expect(
      await db.select().from(proactiveMoments).where(eq(proactiveMoments.agentId, agentId)),
    ).toHaveLength(0);
  });

  it('rechecks an owner resolution committed while refreshing the thread', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addActionableMail('mail-resolved-during-read');
    const result = await runPulse(
      {
        db,
        emailThreadReader: async (input) => {
          const head = await emailThreadReader(input);
          await db
            .update(emailIngest)
            .set({ obligationStatus: 'resolved', obligationVersion: 1 })
            .where(eq(emailIngest.providerThreadId, input.threadId));
          return head;
        },
      },
      { now: NOW },
    );
    expect(result.delivered).toBeNull();
    expect(result.heldBy).toBe('stale-source');
    expect(
      await db.select().from(proactiveMoments).where(eq(proactiveMoments.agentId, agentId)),
    ).toHaveLength(0);
  });

  it('rechecks a newly ingested source after the successful provider read', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addActionableMail('mail-new-source-during-read');
    const result = await runPulse(
      {
        db,
        emailThreadReader: async (input) => {
          const head = await emailThreadReader(input);
          await db.insert(emailIngest).values({
            agentId,
            channelMessageId: `gmail:${MARKER}-newer`,
            providerThreadId: input.threadId,
            providerMessageId: 'newer',
            providerReceivedAt: NOW,
            fromEmail: 'owner@example.test',
            subject: 'Replied',
            contentTrust: 'owner',
            authenticated: true,
            category: 'other',
            importance: 1,
            actionable: false,
          });
          return head;
        },
      },
      { now: NOW },
    );
    expect(result.delivered).toBeNull();
    expect(result.heldBy).toBe('stale-source');
  });

  it('surfaces actionable mail with a suggestion and pings once', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addActionableMail('mail-1');
    const pings: string[] = [];
    const result = await runPulse(
      {
        db,
        emailThreadReader,
        notifyOwner: async ({ text, urgency }) => {
          expect(urgency).toBe('ambient');
          pings.push(text);
          return notificationLeg('push', 'delivered');
        },
      },
      { now: NOW },
    );
    expect(result.delivered).toBe('mail-action');
    expect(result.suggested).toBe(true);
    expect(result.pinged).toBe(true);
    expect(pings).toHaveLength(1);

    const posted = await db
      .select({ text: messages.text, parts: messages.parts })
      .from(messages)
      .where(like(messages.text, `%${MARKER}%your appointment%`));
    expect(posted.length).toBeGreaterThan(0);
    expect(posted[0]?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'data-card',
          data: expect.objectContaining({
            kind: 'proactive-alert',
            category: 'email',
            urgencyLabel: 'Review email',
          }),
        }),
      ]),
    );
  });

  it('never says the same moment twice, and respects the minimum gap', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addActionableMail('mail-2');
    const first = await runPulse({ db, emailThreadReader }, { now: NOW });
    expect(first.delivered).toBe('mail-action');

    // Immediately after: the hourly gap holds it, whatever it found.
    const second = await runPulse(
      { db, emailThreadReader },
      { now: new Date(NOW.getTime() + 60_000) },
    );
    expect(second.delivered).toBeNull();
    expect(second.heldBy).toBe('min-gap');

    // Past the gap, the same moment is already spent — the fence, not the pacing.
    const third = await runPulse(
      { db, emailThreadReader },
      { now: new Date(NOW.getTime() + 2 * 3600_000) },
    );
    expect(third.delivered).toBeNull();
    // Storage filters admitted occurrences before the candidate limit.
    expect(third.heldBy).toBe('no-candidates');
    expect(third.candidates).toBe(0);
    const ledger = await db
      .select()
      .from(proactiveMoments)
      .where(eq(proactiveMoments.agentId, agentId));
    expect(ledger).toHaveLength(1);
  });

  it('holds everything once the daily ceiling is reached', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addActionableMail('mail-3');
    const result = await runPulse({ db, emailThreadReader }, { now: NOW, dailyCap: 0 });
    expect(result.delivered).toBeNull();
    expect(result.heldBy).toBe('daily-cap');
  });

  it('lets the owner tighten the ceiling with the limit they already set', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // The daily ping limit in Settings governs how often the assistant may
    // volunteer something, so a cap of 1 means one nudge and then silence.
    await db
      .insert(notificationPrefs)
      .values({ agentId, ambientDailyCap: 1 })
      .onConflictDoUpdate({
        target: notificationPrefs.agentId,
        set: { ambientDailyCap: 1 },
      });
    try {
      await addActionableMail('cap-1');
      const first = await runPulse({ db, emailThreadReader }, { now: NOW });
      expect(first.delivered).toBe('mail-action');

      await addActionableMail('cap-2');
      // Past the hourly gap, so only the owner's ceiling can be holding it.
      const second = await runPulse(
        { db, emailThreadReader },
        { now: new Date(NOW.getTime() + 2 * 3600_000) },
      );
      expect(second.heldBy).toBe('daily-cap');
    } finally {
      await db.delete(notificationPrefs).where(eq(notificationPrefs.agentId, agentId));
    }
  });

  it('delivers the notice even when the phone leg fails', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addActionableMail('mail-4');
    const result = await runPulse(
      {
        db,
        emailThreadReader,
        notifyOwner: async () => {
          throw new Error('APNs down');
        },
      },
      { now: NOW },
    );
    expect(result.delivered).toBe('mail-action');
    expect(result.pinged).toBe(false);
  });

  it('degrades to the mail half when the calendar read fails', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addActionableMail('mail-5');
    const result = await runPulse(
      {
        db,
        emailThreadReader,
        calendarReader: async () => {
          throw new Error('grant expired');
        },
      },
      { now: NOW },
    );
    expect(result.delivered).toBe('mail-action');
  });

  describe('calendar change detection', () => {
    function calEvent(over: Partial<BriefingCalendarEvent> = {}): BriefingCalendarEvent {
      return {
        summary: `${MARKER} standup`,
        start: '2026-03-04T09:30:00Z',
        end: '2026-03-04T10:00:00Z',
        calendar: 'Work',
        calendarId: `${MARKER}-cal`,
        eventId: `${MARKER}-evt-1`,
        allDay: false,
        ...over,
      };
    }

    async function seedSnapshot(over: Partial<typeof calendarEventSnapshots.$inferInsert> = {}) {
      await db.insert(calendarEventSnapshots).values({
        agentId,
        calendarId: `${MARKER}-cal`,
        eventId: `${MARKER}-evt-1`,
        summary: `${MARKER} standup`,
        start: '2026-03-04T09:30:00Z',
        end: '2026-03-04T10:00:00Z',
        ...over,
      });
    }

    it('notices a cancelled event and outranks ordinary mail for it', async (ctx) => {
      if (!dbUp) return ctx.skip();
      await seedSnapshot();
      await addActionableMail('cal-1');
      // The provider explicitly confirms cancellation in the point read.
      const result = await runPulse(
        {
          db,
          emailThreadReader,
          calendarReader: async () => ({ events: [], complete: true }),
          calendarEventReader: async () => calEvent({ status: 'cancelled' }),
        },
        { now: NOW },
      );
      expect(result.delivered).toBe('calendar-cancelled');

      const remaining = await db
        .select({ eventId: calendarEventSnapshots.eventId })
        .from(calendarEventSnapshots)
        .where(eq(calendarEventSnapshots.eventId, `${MARKER}-evt-1`));
      // The cancellation is told once; the row is gone so nothing re-reports it.
      expect(remaining).toHaveLength(0);
    });

    it('notices a moved event', async (ctx) => {
      if (!dbUp) return ctx.skip();
      await seedSnapshot();
      const moved = calEvent({ start: '2026-03-04T14:00:00Z', end: '2026-03-04T14:30:00Z' });
      const result = await runPulse(
        {
          db,
          emailThreadReader,
          calendarReader: async () => ({ events: [moved], complete: true }),
        },
        { now: NOW },
      );
      expect(result.delivered).toBe('calendar-moved');

      const [row] = await db
        .select({ start: calendarEventSnapshots.start })
        .from(calendarEventSnapshots)
        .where(eq(calendarEventSnapshots.eventId, `${MARKER}-evt-1`));
      // The snapshot now reflects the new time, so a second read stays quiet.
      expect(row?.start).toBe('2026-03-04T14:00:00Z');
    });

    it('notices an attendee backing out after accepting', async (ctx) => {
      if (!dbUp) return ctx.skip();
      await seedSnapshot({
        attendeeResponseHash: attendeeResponseDigest(['guest@example.com (accepted)']),
      });
      const declined = calEvent({ attendees: ['guest@example.com (declined)'] });
      const result = await runPulse(
        {
          db,
          emailThreadReader,
          calendarReader: async () => ({ events: [declined], complete: true }),
        },
        { now: NOW },
      );
      expect(result.delivered).toBe('calendar-declined');
    });

    it('says nothing on a brand-new snapshot — nothing to compare against yet', async (ctx) => {
      if (!dbUp) return ctx.skip();
      // No seeded row: this agent has never had a calendar read before.
      const result = await runPulse(
        {
          db,
          emailThreadReader,
          calendarReader: async () => ({ events: [calEvent()], complete: true }),
        },
        { now: NOW },
      );
      expect(result.delivered).toBeNull();
      expect(result.heldBy).toBe('no-candidates');
    });

    it('CRITICAL: a failed calendar read must never be treated as everything being cancelled', async (ctx) => {
      if (!dbUp) return ctx.skip();
      await seedSnapshot();
      await addActionableMail('cal-fail');
      const result = await runPulse(
        {
          db,
          emailThreadReader,
          calendarReader: async () => {
            throw new Error('grant expired');
          },
        },
        { now: NOW },
      );
      // Degrades to the mail half, exactly like the plain calendar-failure
      // case above — never announces the seeded event as cancelled.
      expect(result.delivered).toBe('mail-action');

      const [row] = await db
        .select({ eventId: calendarEventSnapshots.eventId })
        .from(calendarEventSnapshots)
        .where(eq(calendarEventSnapshots.eventId, `${MARKER}-evt-1`));
      // The snapshot is untouched — a failed read must not corrupt the baseline
      // the next SUCCESSFUL read will compare against.
      expect(row).toBeDefined();
    });
  });
});

describe('calendarChangeMoments', () => {
  const change = (over: Partial<CalendarChange> = {}): CalendarChange => ({
    kind: 'cancelled',
    calendarId: 'cal-1',
    eventId: 'evt-1',
    iCalUID: null,
    summary: 'Fall Practice',
    start: '2026-03-04T23:30:00Z',
    end: '2026-03-05T00:00:00Z',
    ...over,
  });

  it('renders a Z-stamped start in the owner zone, not the provider offset', () => {
    const [moment] = calendarChangeMoments([change()], 'America/Los_Angeles');
    // 23:30 UTC on Mar 4 is 3:30 PM in Los Angeles, still Mar 4. The old
    // formatter sliced the ISO string and showed "2026-03-04 23:30" to an
    // owner who was nowhere near UTC.
    expect(moment?.text).toContain('3:30 PM');
    expect(moment?.text).not.toContain('23:30');
    expect(moment?.text).not.toContain('2026-03-04T23:30:00Z');
  });

  it('renders the same instant differently for a different owner zone', () => {
    const [la] = calendarChangeMoments([change()], 'America/Los_Angeles');
    const [reykjavik] = calendarChangeMoments([change()], 'Atlantic/Reykjavik');
    expect(la?.text).not.toBe(reykjavik?.text);
    expect(reykjavik?.text).toContain('11:30 PM');
  });

  it('keeps a summary carrying a newline on one line', () => {
    // Provider text is spliced into markdown downstream, where a stray newline
    // ends the list item and strands the rest as its own paragraph.
    const [moment] = calendarChangeMoments(
      [change({ summary: 'Fall Practice\nCrocker Amazon' })],
      'America/Los_Angeles',
    );
    expect(moment?.text).not.toContain('\n');
    expect(moment?.text).toContain('Fall Practice Crocker Amazon');
  });

  it('renders both ends of a moved event in the owner zone', () => {
    const [moment] = calendarChangeMoments(
      [
        change({
          kind: 'moved',
          previousStart: '2026-03-04T20:00:00Z',
          start: '2026-03-04T23:30:00Z',
        }),
      ],
      'America/Los_Angeles',
    );
    expect(moment?.text).toContain('12:00 PM');
    expect(moment?.text).toContain('3:30 PM');
  });
});
