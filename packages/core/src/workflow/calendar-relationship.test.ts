import { describe, expect, it } from 'vitest';
import {
  type BriefingCalendarEvent,
  calendarOverlapBriefingItems,
  findConflicts,
} from './briefing.js';
import { agendaSection } from './briefing-card.js';
import {
  calendarArrivalLead,
  calendarRelationship,
  calendarRelationshipNote,
  canonicalOccurrenceGroups,
  classifyCalendarOverlap,
  possibleCalendarIdentityDisagreement,
  presentationOccurrenceGroups,
  probableCalendarMatchEvidence,
  verifiedOwnerParticipation,
  verifiedPersonalCommitment,
} from './calendar-relationship.js';

const arrival: BriefingCalendarEvent = {
  calendarId: 'family',
  eventId: 'one',
  calendar: 'Family',
  summary: 'United Albion arrival',
  location: 'East Entrance',
  description: 'Venue aliases: East Entrance | West Entrance',
  start: '2026-10-07T18:15:00Z',
  end: '2026-10-07T20:30:00Z',
  allDay: false,
};
const kickoff: BriefingCalendarEvent = {
  ...arrival,
  calendarId: 'team',
  eventId: 'two',
  calendar: 'Team',
  summary: 'United Albion kickoff',
  location: 'West Entrance',
  description: '',
  start: '2026-10-07T19:00:00Z',
};
const familyMatch: BriefingCalendarEvent = {
  calendarId: 'home',
  eventId: 'home-game',
  calendar: 'Home',
  summary: '⚽ Harbor v Bay City (5:10PM)',
  location: 'Cedar Estuary Soccer Fields, 100 North Gate, Bay City',
  start: '2026-11-07T16:25:00-08:00',
  end: '2026-11-07T18:30:00-08:00',
  allDay: false,
};
const teamMatch: BriefingCalendarEvent = {
  calendarId: 'team',
  eventId: 'team-game',
  calendar: 'Harbor Soccer',
  summary: '27/28 U13B Azure vs Bay City SC 13/14B Gold',
  location: 'Cedar Estuary, 200 South Gate, Bay City',
  start: '2026-11-07T17:10:00-08:00',
  end: familyMatch.end,
  allDay: false,
};
const gala: BriefingCalendarEvent = {
  ...teamMatch,
  eventId: 'gala',
  summary: 'Harbor Club Fundraiser Night',
  start: '2026-11-07T17:00:00-08:00',
  end: '2026-11-07T22:30:00-08:00',
  location: 'Founders Pavilion Hall, 5051 Harbor Ave',
};

describe('source-preserving probable match presentation', () => {
  it('groups the screenshot match while retaining both source times and a distinct Gala', () => {
    const events = [familyMatch, teamMatch, gala];
    const before = structuredClone(events);
    expect(probableCalendarMatchEvidence(familyMatch, teamMatch)).toEqual({
      kind: 'probable-match',
      basis: 'matchup-venue-and-time',
      earlierStartMinutes: 45,
    });
    const groups = presentationOccurrenceGroups(events);
    expect(groups).toEqual([[familyMatch, teamMatch], [gala]]);
    expect(groups[0]?.[0]).toBe(familyMatch);
    expect(groups[0]?.[1]).toBe(teamMatch);
    expect(canonicalOccurrenceGroups(events)).toHaveLength(3);
    expect(calendarRelationship(familyMatch, teamMatch)).toBe('probable_duplicate');
    expect(verifiedOwnerParticipation({ sourceVariants: groups[0] })).toBe('unknown');
    expect(events).toEqual(before);
  });

  it('requires matchup, venue and occurrence timing independently', () => {
    for (const changed of [
      { ...teamMatch, summary: '27/28 U13B Harbor United vs North Shore SC 13/14B Gold' },
      { ...teamMatch, summary: gala.summary },
      { ...teamMatch, summary: 'Other unrelated activity' },
      { ...teamMatch, location: 'Other Estuary, 200 South Gate, Bay City' },
      { ...teamMatch, location: 'Cedar Fields, 200 South Gate, Bay City' },
      { ...teamMatch, start: '2026-11-08T17:10:00-08:00', end: '2026-11-08T18:30:00-08:00' },
      { ...teamMatch, start: '2026-11-07T17:15:00-08:00' },
      { ...teamMatch, end: '2026-11-07T19:00:00-08:00' },
      { ...teamMatch, calendarId: familyMatch.calendarId },
      { ...teamMatch, calendar: 'Unrelated Soccer' },
      { ...teamMatch, allDay: true },
      { ...teamMatch, status: 'cancelled' },
      { ...teamMatch, originalStartTime: '2026-11-07T17:10:00-08:00' },
    ]) {
      expect(probableCalendarMatchEvidence(familyMatch, changed)).toBeUndefined();
      expect(presentationOccurrenceGroups([familyMatch, changed])).toHaveLength(2);
    }
    expect(
      probableCalendarMatchEvidence({ ...familyMatch, summary: 'Harbor v Bay City' }, teamMatch),
    ).toBeUndefined();
  });

  it('uses only explicit source or supplied timezone for a title clock', () => {
    const utcTeam = { ...teamMatch, start: new Date(teamMatch.start).toISOString() };
    expect(probableCalendarMatchEvidence(familyMatch, utcTeam)).toBeUndefined();
    expect(
      probableCalendarMatchEvidence(familyMatch, utcTeam, 'America/Los_Angeles'),
    ).toBeDefined();
    expect(
      probableCalendarMatchEvidence(
        { ...familyMatch, calendarTimeZone: 'America/Los_Angeles' },
        utcTeam,
      ),
    ).toBeDefined();
    expect(
      probableCalendarMatchEvidence(
        { ...familyMatch, calendarTimeZone: 'America/Los_Angeles' },
        { ...utcTeam, calendarTimeZone: 'UTC' },
        'America/Los_Angeles',
      ),
    ).toBeDefined();
    expect(
      probableCalendarMatchEvidence(
        familyMatch,
        { ...utcTeam, calendarTimeZone: 'UTC' },
        'America/Los_Angeles',
      ),
    ).toBeDefined();
    expect(
      probableCalendarMatchEvidence(
        { ...familyMatch, calendarTimeZone: 'America/New_York' },
        utcTeam,
        'America/Los_Angeles',
      ),
    ).toBeUndefined();
    expect(
      probableCalendarMatchEvidence(
        { ...familyMatch, start: '2026-11-07T19:25:00-05:00' },
        teamMatch,
      ),
    ).toBeUndefined();
    expect(
      probableCalendarMatchEvidence(
        { ...familyMatch, start: new Date(familyMatch.start).toISOString() },
        teamMatch,
      ),
    ).toBeUndefined();
    expect(probableCalendarMatchEvidence(familyMatch, utcTeam, 'UTC')).toBeUndefined();
    expect(
      probableCalendarMatchEvidence(
        familyMatch,
        { ...utcTeam, start: '2026-11-08T00:10:00Z' },
        'America/Los_Angeles',
      ),
    ).toBeUndefined();
    expect(probableCalendarMatchEvidence(familyMatch, utcTeam, 'America/New_York')).toBeUndefined();
  });

  it('preserves a trusted canonical block when only one source supports a probable bridge', () => {
    const variant = { ...familyMatch, summary: 'Family match reminder' };
    for (const events of [
      [familyMatch, variant, teamMatch],
      [variant, familyMatch, teamMatch],
      [familyMatch, teamMatch, variant],
      [variant, teamMatch, familyMatch],
      [teamMatch, familyMatch, variant],
      [teamMatch, variant, familyMatch],
    ]) {
      const groups = presentationOccurrenceGroups(events);
      expect(groups).toHaveLength(2);
      expect(groups.find((group) => group.includes(familyMatch))).toEqual(
        events.filter((event) => event !== teamMatch),
      );
      expect(groups.find((group) => group.includes(teamMatch))).toEqual([teamMatch]);
    }
  });

  it('keeps an ambiguous family listing and two plausible team matches separate in every order', () => {
    const otherMatch = { ...teamMatch, eventId: 'other-match' };
    for (const events of [
      [familyMatch, teamMatch, otherMatch],
      [familyMatch, otherMatch, teamMatch],
      [teamMatch, familyMatch, otherMatch],
      [teamMatch, otherMatch, familyMatch],
      [otherMatch, teamMatch, familyMatch],
      [otherMatch, familyMatch, teamMatch],
    ])
      expect(presentationOccurrenceGroups(events)).toHaveLength(3);
  });
});

describe('advisory calendar relationships', () => {
  it('keeps the accepted invitation and unconfirmed attendance qualifier attached to the named pair', () => {
    const conflicts = findConflicts(
      [
        {
          calendarId: 'home',
          eventId: 'dentist',
          calendar: 'Home',
          summary: 'Dentist',
          start: '2026-09-22T09:00:00Z',
          end: '2026-09-22T10:00:00Z',
          allDay: false,
          blocksTime: true,
          ownerParticipation: {
            status: 'accepted',
            identityVerified: true,
            basis: 'attendee-email',
          },
        },
        {
          calendarId: 'work',
          eventId: 'interview',
          calendar: 'Work',
          summary: 'Interview',
          start: '2026-09-22T09:30:00Z',
          end: '2026-09-22T10:30:00Z',
          allDay: false,
          blocksTime: true,
        },
      ],
      'UTC',
    );
    const realConflicts = conflicts.filter(
      (conflict) => conflict.relationship !== 'probable_duplicate',
    );
    const [item] = calendarOverlapBriefingItems(realConflicts, conflicts.conflictCount, 'UTC');

    expect(item?.title).toBe('Dentist (Home) overlaps Interview (Work)');
    expect(item?.detail).toContain(
      'You accepted one invitation; attendance at the other is unconfirmed.',
    );
  });

  it('keeps UID bridges with same-calendar ID collisions separate in every input order', () => {
    const a = {
      calendarId: 'work',
      eventId: 'work-a',
      iCalUID: 'uid-collision',
      originalStartTime: '2026-10-07T09:00:00Z',
      start: '2026-10-07T09:00:00Z',
      end: '2026-10-07T10:00:00Z',
    };
    const b = {
      calendarId: 'work',
      eventId: 'work-b',
      iCalUID: 'uid-collision',
      originalStartTime: '2026-10-07T09:00:00Z',
      start: '2026-10-07T09:15:00Z',
      end: '2026-10-07T10:15:00Z',
    };
    const c = {
      calendarId: 'family',
      eventId: 'family-copy',
      iCalUID: 'uid-collision',
      originalStartTime: '2026-10-07T09:00:00Z',
      start: '2026-10-07T09:15:00Z',
      end: '2026-10-07T10:15:00Z',
    };
    const orders = [
      [a, b, c],
      [a, c, b],
      [b, a, c],
      [b, c, a],
      [c, a, b],
      [c, b, a],
    ];
    const signatures = orders.map((order) =>
      canonicalOccurrenceGroups(order)
        .map((group) => group.map((row) => row.eventId).sort())
        .sort(),
    );
    expect(new Set(signatures.map((signature) => JSON.stringify(signature))).size).toBe(1);
    expect(signatures[0]).toHaveLength(3);
  });

  it('advises on same trusted UID with incomplete occurrence metadata and differing timed bounds', () => {
    const left = {
      calendarId: 'work',
      eventId: 'a',
      iCalUID: 'shared-uid',
      start: '2026-10-07T10:00:00Z',
      end: '2026-10-07T11:00:00Z',
    };
    expect(
      possibleCalendarIdentityDisagreement(left, {
        calendarId: 'family',
        eventId: 'b',
        iCalUID: 'shared-uid',
        start: '2026-10-07T10:05:00Z',
        end: '2026-10-07T11:05:00Z',
      }),
    ).toBe(true);
    expect(
      possibleCalendarIdentityDisagreement(left, {
        calendarId: 'family',
        eventId: 'b',
        iCalUID: 'other-uid',
        start: '2026-10-07T10:05:00Z',
        end: '2026-10-07T11:05:00Z',
      }),
    ).toBe(false);
  });

  it('reconciles an explicit arrival offset only with a matching street, end and title clock', () => {
    const early = {
      ...arrival,
      summary: 'Albion v Riverside (5:10PM)',
      location: 'Arena, 100 Example Road, Example City',
      start: '2026-10-18T23:25:00Z',
      end: '2026-10-19T01:30:00Z',
    };
    const game = {
      ...kickoff,
      summary: 'Riverside United Boys',
      location: 'Arena\n100 Example Road, Example City',
      description: 'Arrival: 45 minutes in advance',
      start: '2026-10-18T17:10:00-07:00',
      end: '2026-10-18T18:30:00-07:00',
    };
    expect(calendarArrivalLead(early, game)).toBe(45);
    for (const changed of [
      { ...game, description: '' },
      { ...game, location: '100 Different Road' },
      { ...game, end: '2026-10-18T19:00:00-07:00' },
      { ...game, summary: 'Other Teams' },
      { ...game, calendarId: early.calendarId },
    ])
      expect(calendarArrivalLead(early, changed)).toBeUndefined();
    expect(
      calendarArrivalLead({ ...early, summary: 'Albion v Riverside (6:10PM)' }, game),
    ).toBeUndefined();
    expect(calendarRelationship(early, game)).toBe('unresolved');
  });
  it('retains arrival and kickoff sources/times with an explicit venue alias statement', () => {
    expect(calendarRelationship(arrival, kickoff)).toBe('compatible_time_roles');
    const conflicts = findConflicts([arrival, kickoff]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.a[0]?.start).toBe(arrival.start);
    expect(conflicts[0]?.b[0]?.start).toBe(kickoff.start);
    const agenda = agendaSection({
      events: [arrival, kickoff],
      complete: true,
      conflicts,
      salient: [],
      timeZone: 'UTC',
      now: new Date(arrival.start),
    });
    expect(agenda?.type === 'agenda' && agenda.items[0]?.note).toContain('earlier arrival');
    expect(agenda?.type === 'agenda' ? agenda.items[1]?.note : undefined).toBeUndefined();
  });
  it('does not invent alias, attendance, participant or recurrence identity', () => {
    expect(calendarRelationship({ ...arrival, description: '' }, kickoff)).toBe('unresolved');
    expect(calendarRelationship(arrival, { ...kickoff, summary: 'Other Albion kickoff' })).toBe(
      'unresolved',
    );
    expect(calendarRelationship(arrival, { ...kickoff, calendarId: arrival.calendarId })).toBe(
      'unresolved',
    );
    expect(
      calendarRelationship(
        { ...arrival, recurringEventId: 'series', originalStartTime: arrival.start },
        { ...kickoff, recurringEventId: 'series', originalStartTime: kickoff.start },
      ),
    ).toBe('unresolved');
    expect(calendarRelationship(kickoff, { ...arrival, start: '2026-10-07T19:15:00Z' })).toBe(
      'unresolved',
    );
    expect(calendarRelationshipNote('unresolved', 'unresolved')).toContain('not established');
  });
  it('labels matching descriptive listings as probable while keeping both sources', () => {
    const copy = { ...arrival, calendarId: 'personal', eventId: 'copy', description: '' };
    expect(calendarRelationship(arrival, copy)).toBe('probable_duplicate');
    expect(findConflicts([arrival, copy])).toHaveLength(1);
    expect(calendarRelationshipNote('probable_duplicate', 'confirmed')).toContain(
      'Both sources are retained',
    );
  });
});

it('recognizes an exact iPhone mirror without a venue while retaining distinct overlaps', () => {
  const event = {
    summary: 'Dentist',
    start: '2026-10-19T09:00:00Z',
    end: '2026-10-19T10:00:00Z',
    calendar: 'Google',
    allDay: false,
    calendarId: 'google',
  };
  expect(calendarRelationship(event, { ...event, calendarId: 'iphone:work' })).toBe(
    'probable_duplicate',
  );
  expect(
    calendarRelationship(event, {
      ...event,
      calendarId: 'iphone:work',
      summary: 'Project meeting',
    }),
  ).toBe('unresolved');
  expect(
    calendarRelationship(event, {
      ...event,
      calendarId: 'iphone:work',
      start: '2026-10-19T09:15:00Z',
    }),
  ).toBe('unresolved');
});

it('requires verified human attendee evidence or explicit busy-commitments policy', () => {
  expect(verifiedOwnerParticipation({ ownerResponse: 'accepted' })).toBe('unknown');
  expect(
    verifiedOwnerParticipation({
      ownerParticipation: {
        status: 'accepted',
        identityVerified: true,
        basis: 'organizer-email',
      },
    }),
  ).toBe('unknown');
  expect(
    verifiedOwnerParticipation({
      ownerParticipation: {
        status: 'accepted',
        identityVerified: true,
        basis: 'attendee-email',
      },
    }),
  ).toBe('accepted');
  expect(
    verifiedOwnerParticipation({
      ownerParticipation: {
        status: 'accepted',
        identityVerified: false,
        basis: 'attendee-email',
      },
    }),
  ).toBe('unknown');
  expect(
    verifiedPersonalCommitment({
      blocksTime: true,
      ownerParticipation: {
        status: 'accepted',
        identityVerified: true,
        basis: 'attendee-email',
      },
    }),
  ).toBe(true);
  expect(
    verifiedPersonalCommitment({
      blocksTime: false,
      ownerParticipation: {
        status: 'accepted',
        identityVerified: true,
        basis: 'attendee-email',
      },
    }),
  ).toBe(false);
  expect(verifiedPersonalCommitment({ blocksTime: true, calendarPurpose: 'commitments' })).toBe(
    true,
  );
  expect(verifiedPersonalCommitment({ blocksTime: true, calendarPurpose: 'reference' })).toBe(
    false,
  );
  const declined = {
    status: 'declined',
    identityVerified: true,
    basis: 'attendee-email',
  } as const;
  expect(verifiedPersonalCommitment({ blocksTime: true, calendarPurpose: 'commitments' })).toBe(
    true,
  );
  expect(
    verifiedPersonalCommitment({
      blocksTime: true,
      calendarPurpose: 'commitments',
      ownerParticipation: declined,
    }),
  ).toBe(false);
  expect(
    verifiedPersonalCommitment({
      blocksTime: true,
      calendarPurpose: 'commitments',
      status: 'cancelled',
    }),
  ).toBe(false);
  expect(verifiedPersonalCommitment({ blocksTime: false, calendarPurpose: 'commitments' })).toBe(
    false,
  );
  expect(
    verifiedPersonalCommitment({
      blocksTime: true,
      calendarPurpose: 'commitments',
      sourceVariants: [
        { blocksTime: true, status: 'confirmed', calendarPurpose: 'commitments' },
        {
          blocksTime: true,
          status: 'confirmed',
          calendarPurpose: 'commitments',
          ownerParticipation: declined,
        },
      ],
    }),
  ).toBe(false);
  expect(
    verifiedPersonalCommitment({
      blocksTime: true,
      calendarPurpose: 'commitments',
      sourceVariants: [{ blocksTime: true, status: 'cancelled', calendarPurpose: 'commitments' }],
    }),
  ).toBe(false);
  expect(
    verifiedPersonalCommitment({
      blocksTime: true,
      calendarPurpose: 'commitments',
      sourceVariants: [{ blocksTime: false, status: 'confirmed', calendarPurpose: 'commitments' }],
    }),
  ).toBe(false);
});

it('uses attendance proof and commitment policy as separate overlap classifications', () => {
  const verifiedAccepted = {
    blocksTime: true,
    ownerParticipation: {
      status: 'accepted',
      identityVerified: true,
      basis: 'attendee-email',
    },
  };
  expect(classifyCalendarOverlap(verifiedAccepted, verifiedAccepted)).toBe(
    'personal_commitment_conflict',
  );
  expect(
    classifyCalendarOverlap(
      { blocksTime: true, calendarPurpose: 'commitments' },
      { blocksTime: true, calendarPurpose: 'commitments' },
    ),
  ).toBe('commitments_policy_overlap');
  expect(classifyCalendarOverlap({ blocksTime: true }, { blocksTime: true })).toBe(
    'attendance_unconfirmed',
  );
});
