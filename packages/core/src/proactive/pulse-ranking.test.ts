import { describe, expect, it, vi } from 'vitest';
import { type EventSalience, scoreCalendarEvent } from './calendar-salience.js';
import type { PulseMoment } from './pulse.js';
import {
  calendarChangeMoments,
  commitmentMoment,
  eventLeadMoments,
  persistNextPulseMoment,
  selectPulseMoment,
} from './pulse.js';

const now = new Date('2026-03-04T09:00:00.000Z');

function moment(overrides: Partial<PulseMoment>): PulseMoment {
  return {
    kind: 'event-lead',
    key: 'event-lead:test',
    text: 'A grounded update.',
    priority: 100,
    card: {
      kind: 'proactive-alert',
      id: 'event-lead:test',
      category: 'event',
      title: 'Test event',
      urgencyLabel: 'Starts soon',
    },
    ...overrides,
  };
}

function salient(
  event: Partial<Parameters<typeof eventLeadMoments>[0][number]['event']>,
  score = 5,
): EventSalience {
  return {
    event: {
      summary: 'Same title',
      start: '2026-03-04T09:10:00Z',
      end: '2026-03-04T10:00:00Z',
      calendar: 'Work',
      allDay: false,
      eventId: 'event-a',
      ...event,
    },
    score,
    reasons: [],
  };
}

describe('pulse ranking and duplicate suppression', () => {
  it('names the place once and drops a reason that only repeats it', () => {
    const travelling = salient({ start: '2026-03-04T09:35:00Z', location: 'Laugavegur 12' });
    travelling.reasons = [
      'it is at Laugavegur 12',
      'it ends at or after 7 PM',
      'it ends at or after 7 PM',
    ];
    const [lead] = eventLeadMoments([travelling], now);
    expect(lead?.text).toBe(
      'Same title starts in 35 minutes at Laugavegur 12. It ends at or after 7 PM.',
    );
    expect(lead?.card).toMatchObject({ summary: 'It ends at or after 7 PM.' });
    expect(lead?.card).not.toHaveProperty('score');
  });

  it('leaves no dangling full stop when the place was the only reason', () => {
    const travelling = salient({ start: '2026-03-04T09:35:00Z', location: 'Laugavegur 12' });
    travelling.reasons = ['it is at Laugavegur 12'];
    const [lead] = eventLeadMoments([travelling], now);
    expect(lead?.text).toBe('Same title starts in 35 minutes at Laugavegur 12.');
    expect(lead?.card).not.toHaveProperty('summary');
  });

  it('reuses the source-grounded unanswered-invitation reason in the notice and card summary', () => {
    const scored = scoreCalendarEvent(
      {
        summary: 'Quarterly review',
        start: '2026-03-04T09:10:00Z',
        end: '2026-03-04T10:00:00Z',
        calendar: 'Work',
        allDay: false,
        attendees: ['owner@example.com (needsAction)'],
      },
      { timeZone: 'Atlantic/Reykjavik', selfEmails: ['owner@example.com'] },
    );
    const [lead] = eventLeadMoments([scored], now);
    const reason = 'You have not replied to the invitation.';
    expect(lead?.text).toBe(`Quarterly review starts in 10 minutes. ${reason}`);
    expect(lead?.card).toMatchObject({ kind: 'proactive-alert', summary: reason });
  });

  it('omits a summary when a punctuated event title already states the same reason', () => {
    const title = 'You have not replied to the invitation!';
    const scored = scoreCalendarEvent(
      {
        summary: title,
        start: '2026-03-04T09:10:00Z',
        end: '2026-03-04T10:00:00Z',
        calendar: 'Work',
        allDay: false,
        attendees: ['owner@example.com (needsAction)'],
      },
      { timeZone: 'Atlantic/Reykjavik', selfEmails: ['owner@example.com'] },
    );
    const [lead] = eventLeadMoments([scored], now);
    expect(lead?.text).toBe(`${title} starts in 10 minutes.`);
    expect(lead?.card).not.toHaveProperty('summary');
  });

  it('states combined hour and long-block reasons once in the same notice and card sentence', () => {
    const scored = scoreCalendarEvent(
      {
        summary: 'Quarterly review',
        start: '2026-03-04T07:00:00Z',
        end: '2026-03-04T19:00:00Z',
        calendar: 'Work',
        allDay: false,
        attendees: ['owner@example.com (needsAction)'],
      },
      { timeZone: 'Atlantic/Reykjavik', selfEmails: ['owner@example.com'] },
    );
    const [lead] = eventLeadMoments([scored], new Date('2026-03-04T06:50:00Z'));
    const reason =
      'You have not replied to the invitation; it starts before 8 AM; it ends at or after 7 PM; it runs for most of a working block.';
    expect(lead?.text).toBe(`Quarterly review starts in 10 minutes. ${reason}`);
    expect(lead?.card).toMatchObject({ kind: 'proactive-alert', summary: reason });
  });

  it('keeps priority tiers first, then ranks known urgency and relevance with a stable key tie', () => {
    const notAsUrgent = moment({ key: 'a', urgency: 0.2, relevance: 100 });
    const moreUrgent = moment({ key: 'z', urgency: 0.8, relevance: 1 });
    const sameUrgencyMoreRelevant = moment({ key: 'm', urgency: 0.8, relevance: 5 });
    const higherTier = moment({ key: 'lower-signal', priority: 101, urgency: 0, relevance: 0 });

    expect(selectPulseMoment([notAsUrgent, moreUrgent, sameUrgencyMoreRelevant])?.key).toBe('m');
    expect(
      selectPulseMoment([notAsUrgent, moreUrgent, sameUrgencyMoreRelevant, higherTier])?.key,
    ).toBe('lower-signal');
    expect(selectPulseMoment([notAsUrgent, moreUrgent])?.key).toBe('z');
    expect(selectPulseMoment([moment({ key: 'z' }), moment({ key: 'a' })])?.key).toBe('a');
  });

  it('ranks event leads by time to start and existing salience score', () => {
    const soon = eventLeadMoments(
      [
        { ...salient({ eventId: 'later', start: '2026-03-04T09:14:00Z' }), score: 10 },
        { ...salient({ eventId: 'soon', start: '2026-03-04T09:05:00Z' }), score: 1 },
      ],
      now,
    );
    expect(selectPulseMoment(soon)?.key).toBe('event-lead:soon:2026-03-04T09:05:00Z');

    const equalTime = eventLeadMoments(
      [
        salient({ eventId: 'low', start: '2026-03-04T09:05:00Z' }, 3),
        salient({ eventId: 'high', start: '2026-03-04T09:05:00Z' }, 8),
      ],
      now,
    );
    expect(selectPulseMoment(equalTime)?.key).toBe('event-lead:high:2026-03-04T09:05:00Z');
    expect(eventLeadMoments([salient({ eventId: 'soon' })], now)[0]?.key).toBe(
      'event-lead:soon:2026-03-04T09:10:00Z',
    );
  });

  it('suppresses only provider-identity-confirmed calendar copies, independent of input order', () => {
    const work = salient(
      {
        calendarId: 'work-calendar',
        eventId: 'work-copy',
        iCalUID: 'shared-event@example.test',
        originalStartTime: '2026-03-04T09:10:00Z',
      },
      8,
    );
    const personal = salient(
      {
        calendarId: 'personal-calendar',
        eventId: 'personal-copy',
        iCalUID: 'shared-event@example.test',
        originalStartTime: '2026-03-04T09:10:00Z',
      },
      5,
    );
    const forward = eventLeadMoments([work, personal], now);
    const reversed = eventLeadMoments([personal, work], now);
    expect(forward).toHaveLength(1);
    expect(reversed).toEqual(forward);
    expect(forward[0]?.key).toMatch(/^event-lead:v2:/);
    expect(forward[0]?.relevance).toBe(8);
    expect(forward[0]?.card.id).toBe(forward[0]?.key);
    expect(forward[0]?.card).toMatchObject({ kind: 'proactive-alert' });
    if (forward[0]?.card.kind === 'proactive-alert') {
      const details = forward[0].card.details;
      expect(Array.isArray(details)).toBe(true);
      if (Array.isArray(details)) {
        expect(
          details.some((detail: unknown) => {
            if (detail === null || typeof detail !== 'object' || Array.isArray(detail))
              return false;
            return 'label' in detail && detail.label === 'Calendar';
          }),
        ).toBe(false);
      }
    }
    const reweighted = eventLeadMoments(
      [
        { ...work, score: 4 },
        { ...personal, score: 9 },
      ],
      now,
    )[0];
    expect(reweighted?.key).toBe(forward[0]?.key);
    expect(reweighted?.relevance).toBe(9);

    const workOnly = eventLeadMoments([work], now)[0];
    const personalOnly = eventLeadMoments([personal], now)[0];
    expect(workOnly?.key).toBe(personalOnly?.key);
    expect(workOnly?.key).toBe(forward[0]?.key);

    const distinct = salient({
      calendarId: 'family-calendar',
      eventId: 'family-member-event',
      iCalUID: 'different-event@example.test',
      originalStartTime: '2026-03-04T09:10:00Z',
    });
    expect(eventLeadMoments([work, distinct], now)).toHaveLength(2);

    const conflictingAttendance = salient(
      {
        calendarId: 'personal-calendar',
        eventId: 'personal-copy',
        iCalUID: 'shared-event@example.test',
        originalStartTime: '2026-03-04T09:10:00Z',
        ownerParticipation: {
          status: 'declined',
          identityVerified: true,
          basis: 'attendee-email',
        },
      },
      8,
    );
    const verifiedWork = {
      ...work,
      event: {
        ...work.event,
        ownerParticipation: {
          status: 'accepted' as const,
          identityVerified: true,
          basis: 'attendee-email' as const,
        },
      },
    };
    expect(eventLeadMoments([verifiedWork, conflictingAttendance], now)).toHaveLength(2);
  });

  it('keeps provider copies with conflicting current facts separate', () => {
    const original = salient({
      calendarId: 'work-calendar',
      eventId: 'work-copy',
      iCalUID: 'shared-event@example.test',
      originalStartTime: '2026-03-04T09:10:00Z',
      location: 'Room A',
    });
    const movedCopy = salient({
      calendarId: 'personal-calendar',
      eventId: 'personal-copy',
      iCalUID: 'shared-event@example.test',
      originalStartTime: '2026-03-04T09:10:00Z',
      start: '2026-03-04T09:15:00Z',
      location: 'Room B',
    });
    expect(eventLeadMoments([original, movedCopy], now)).toHaveLength(2);
    for (const changedFacts of [
      { summary: 'Renamed meeting' },
      { end: '2026-03-04T10:15:00Z' },
      { location: 'Room B' },
    ]) {
      const conflictingCopy = salient({
        calendarId: 'personal-calendar',
        eventId: 'personal-copy',
        iCalUID: 'shared-event@example.test',
        originalStartTime: '2026-03-04T09:10:00Z',
        ...changedFacts,
      });
      expect(eventLeadMoments([original, conflictingCopy], now)).toHaveLength(2);
    }
  });

  it('keeps provider copies with different-case URL locations separate', () => {
    const upperCasePath = salient({
      calendarId: 'work-calendar',
      eventId: 'work-copy',
      iCalUID: 'shared-event@example.test',
      originalStartTime: '2026-03-04T09:10:00Z',
      location: 'https://example.test/RoomA',
    });
    const lowerCasePath = salient({
      calendarId: 'personal-calendar',
      eventId: 'personal-copy',
      iCalUID: 'shared-event@example.test',
      originalStartTime: '2026-03-04T09:10:00Z',
      location: 'https://example.test/rooma',
    });
    expect(eventLeadMoments([upperCasePath, lowerCasePath], now)).toHaveLength(2);
  });

  it('keeps provider copies with distinct Unicode URL path characters separate', () => {
    const compatibilityCharacter = salient({
      calendarId: 'work-calendar',
      eventId: 'work-copy',
      iCalUID: 'shared-event@example.test',
      originalStartTime: '2026-03-04T09:10:00Z',
      location: 'https://example.test/RoomK',
    });
    const asciiCharacter = salient({
      calendarId: 'personal-calendar',
      eventId: 'personal-copy',
      iCalUID: 'shared-event@example.test',
      originalStartTime: '2026-03-04T09:10:00Z',
      location: 'https://example.test/RoomK',
    });
    expect(eventLeadMoments([compatibilityCharacter, asciiCharacter], now)).toHaveLength(2);
  });

  it('includes same-calendar recurrence instance identity and normalizes missing all-day to false', () => {
    const firstInstance = salient({
      calendarId: 'calendar-a',
      eventId: 'series-event',
      originalStartTime: '2026-03-04T09:00:00Z',
    });
    const secondInstance = salient({
      ...firstInstance.event,
      originalStartTime: '2026-03-05T09:00:00Z',
    });
    expect(eventLeadMoments([firstInstance, secondInstance], now)).toHaveLength(2);

    const omittedAllDay = salient({
      calendarId: 'calendar-b',
      eventId: 'ordinary-event',
      iCalUID: 'ordinary@example.test',
      originalStartTime: '2026-03-04T09:10:00Z',
      allDay: undefined,
    });
    const explicitTimed = salient({
      ...omittedAllDay.event,
      allDay: false,
    });
    expect(eventLeadMoments([omittedAllDay], now)[0]?.key).toBe(
      eventLeadMoments([explicitTimed], now)[0]?.key,
    );
    expect(eventLeadMoments([salient({ allDay: true })], now)).toEqual([]);
  });

  it('leaves canceled, invalid-time, and already-started events out of lead candidates', () => {
    expect(
      eventLeadMoments(
        [
          salient({ status: 'cancelled' }),
          salient({ eventId: 'invalid', start: 'not-a-time' }),
          salient({ eventId: 'past', start: '2026-03-04T08:59:00Z' }),
        ],
        now,
      ),
    ).toEqual([]);
  });

  it('uses only known start times to rank same-tier calendar changes and due commitments', () => {
    const calendarUpdates = calendarChangeMoments(
      [
        {
          kind: 'cancelled',
          calendarId: 'calendar-1',
          eventId: 'later',
          iCalUID: null,
          summary: 'Later meeting',
          start: '2026-03-04T14:00:00Z',
          end: '2026-03-04T15:00:00Z',
        },
        {
          kind: 'cancelled',
          calendarId: 'calendar-1',
          eventId: 'soon',
          iCalUID: null,
          summary: 'Soon meeting',
          start: '2026-03-04T09:05:00Z',
          end: '2026-03-04T10:00:00Z',
        },
      ],
      'UTC',
      now,
    );
    expect(selectPulseMoment(calendarUpdates)?.key).toContain('soon');

    const commitments = [
      commitmentMoment(
        {
          id: 'later',
          title: 'Later task',
          nextAction: 'Review it',
          dueAt: new Date(now.getTime() + 30 * 3_600_000),
        },
        'UTC',
        now,
      ),
      commitmentMoment(
        {
          id: 'soon',
          title: 'Soon task',
          nextAction: 'Pay invoice',
          dueAt: new Date(now.getTime() + 3_600_000),
        },
        'UTC',
        now,
      ),
    ];
    expect(selectPulseMoment(commitments)?.key).toContain('soon');
    expect(selectPulseMoment(commitments)?.card).toMatchObject({
      kind: 'proactive-alert',
      summary: 'Next: Pay invoice',
    });
  });

  it('skips an observed legacy alias before admitting the v2 key', async () => {
    const v2 = moment({ key: 'event-lead:v2:new', legacyMomentKeys: ['event-lead:old'] });
    const admitNotice = vi.fn();
    const result = await persistNextPulseMoment(
      { admitNotice, momentKeys: vi.fn(async () => ['event-lead:old']) },
      {
        agentId: 'owner',
        now,
        observationFence: null,
        dailyCap: 6,
        candidates: [v2],
      },
    );
    expect(result.heldBy).toBe('no-candidates');
    expect(admitNotice).not.toHaveBeenCalled();
  });

  it('tries a repeated key once after already-said and continues to a distinct candidate', async () => {
    const duplicate = moment({ key: 'event-lead:same' });
    const lowerRanked = moment({ key: 'event-lead:other', priority: 50 });
    const admitNotice = vi.fn(async ({ moment: candidate }: { moment: { key: string } }) =>
      candidate.key === duplicate.key
        ? { status: 'already-said' as const }
        : {
            status: 'persisted' as const,
            momentId: 'moment-1',
            messageId: 'message-1',
            conversationId: 'conversation-1',
            suggestionCreated: false,
          },
    );
    const result = await persistNextPulseMoment(
      { admitNotice },
      {
        agentId: 'owner',
        now,
        observationFence: null,
        dailyCap: 6,
        candidates: [duplicate, duplicate, lowerRanked],
      },
    );
    expect(result.moment?.key).toBe(lowerRanked.key);
    expect(
      admitNotice.mock.calls.filter(([call]) => call.moment.key === duplicate.key),
    ).toHaveLength(1);
    expect(admitNotice).toHaveBeenCalledTimes(2);
  });
});
