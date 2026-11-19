/** Synthetic source-only data shared by rendered and mounted browser controls. */
export function householdDayFixture(): Record<string, unknown> {
  const item = (id: string, title: string, calendar: string, rsvp: string) => ({
    id,
    day: 'Timed',
    time: id === 'lesson' ? '4:30–5:15 PM' : '4:00–5:00 PM',
    title,
    note: `Your RSVP: ${rsvp}.`,
    calendars: [calendar],
    householdDetails: {
      version: 1,
      eventFor: 'not_stated',
      driving: 'not_stated',
      sources: [
        {
          calendar,
          title,
          start: id === 'lesson' ? '2026-11-04T16:30:00-08:00' : '2026-11-04T16:00:00-08:00',
          end: id === 'lesson' ? '2026-11-04T17:15:00-08:00' : '2026-11-04T17:00:00-08:00',
          timeZone: 'America/Los_Angeles',
          allDay: false,
          rsvp,
        },
      ],
    },
  });
  return {
    kind: 'briefing',
    id: 'synthetic-household-day',
    presentation: 'calendar-agenda',
    date: 'Wednesday, Nov 4 · America/Los_Angeles',
    timeZone: 'America/Los_Angeles',
    lead: 'Two entries in the checked calendars. Some sources were not checked.',
    complete: false,
    householdDay: {
      version: 1,
      coverage: {
        complete: false,
        summary: 'Coverage incomplete: iPhone Family was not checked.',
        freshnessSummary: 'Source freshness unavailable.',
        details: [
          { title: 'Requested window', detail: '4 Nov to 5 Nov, America/Los_Angeles.' },
          { title: 'iPhone Family', detail: 'Permission denied; no snapshot was checked.' },
        ],
      },
      nextQuestion: {
        basis: 'verified_owner_accepted_overlap',
        id: 'synthetic-overlap',
        question: 'Do both accepted invitations still need your time?',
        detail: 'Your two verified accepted invitations overlap in the checked entries.',
        eventIds: ['workshop', 'lesson'],
        remainingIssueCount: 2,
      },
    },
    sections: [
      {
        type: 'agenda',
        title: 'Wednesday, Nov 4',
        complete: false,
        items: [
          item('workshop', 'Synthetic workshop', 'Work calendar', 'accepted'),
          item('lesson', 'Maya’s lesson (synthetic source title)', 'Family calendar', 'accepted'),
        ],
      },
      {
        type: 'attention',
        title: 'Calendar source differences',
        items: [
          {
            title: 'Source times differ',
            detail: 'Both source listings remain visible; this does not establish one appointment.',
            comparison: { version: 1, leftEventId: 'workshop', rightEventId: 'lesson' },
          },
        ],
        itemCount: 1,
      },
      {
        type: 'attention',
        title: 'Calendar read coverage',
        items: [{ title: 'Coverage incomplete', detail: 'iPhone Family was not checked.' }],
      },
    ],
  };
}
