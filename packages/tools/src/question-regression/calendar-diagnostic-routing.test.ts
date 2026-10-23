import { describe, expect, it } from 'vitest';
import { CALENDAR_DIAGNOSTIC_CASES } from './calendar-diagnostic-corpus.js';
import {
  type CalendarDiagnosticToolName,
  calendarReadToolFixture,
} from './calendar-diagnostic-tools.js';
import type { QuestionCase } from './corpus.js';
import { questionPlan } from './harness.js';

function basicCase(overrides: Partial<QuestionCase> = {}): QuestionCase {
  return {
    id: 'routing-plan-synthetic',
    records: [],
    request: 'What is on my calendar?',
    script: [],
    expect: { matches: [] },
    ...overrides,
  };
}

describe('calendar diagnostic routing preparation', () => {
  it('preserves ordinary plan defaults and clarification while production routing supplies no preset', () => {
    expect(questionPlan(basicCase())).toMatchObject({ action: 'workflow' });
    expect(questionPlan(basicCase({ plan: 'reply' }))).toMatchObject({ action: 'reply' });
    expect(questionPlan(basicCase({ plan: 'clarify' }))).toBeUndefined();
    expect(
      questionPlan(basicCase({ executionPath: 'production-routing', plan: 'reply' })),
    ).toBeUndefined();
    expect(questionPlan(basicCase({ executionPath: 'production-routing' }))).toBeUndefined();
  });

  it('uses actual read-only calendar tool schemas and refuses invalid times and writer names', () => {
    const expectedNames: CalendarDiagnosticToolName[] = [
      'calendar.list_events',
      'calendar.search_events',
      'calendar.list_calendars',
      'calendar.availability',
    ];
    for (const name of expectedNames) {
      const fixture = calendarReadToolFixture(name, []);
      expect(fixture.name).toBe(name);
      expect(fixture.description?.length).toBeGreaterThan(20);
      expect(fixture.risk).toBe('autonomous');
      expect(fixture.flags?.confidentialRead).toBe(true);
      expect(fixture.schema).toBeDefined();
    }

    const listEvents = calendarReadToolFixture('calendar.list_events', []);
    expect(
      listEvents.schema.safeParse({
        timeMin: 'tomorrow',
        timeMax: '2026-10-24T07:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      listEvents.schema.safeParse({
        timeMin: '2026-10-23T07:00:00.000Z',
        timeMax: '2026-10-24T07:00:00.000-07:00',
      }).success,
    ).toBe(true);

    expect(() =>
      calendarReadToolFixture('calendar.create_event' as CalendarDiagnosticToolName, []),
    ).toThrow(/Unsupported diagnostic read tool/);
  });

  it('retains source and coverage metadata in the synthetic production-routed event fixture', () => {
    const fixture = CALENDAR_DIAGNOSTIC_CASES.find((candidate) => candidate.id === 'calendar-d1');
    if (!fixture) throw new Error('Missing synthetic calendar diagnostic fixture');
    const tool = fixture.localTools?.find((candidate) => candidate.name === 'calendar.list_events');
    if (!tool) throw new Error('Missing synthetic read tool fixture');
    const firstOutcome = tool.outcomes[0];
    if (!firstOutcome || !('result' in firstOutcome))
      throw new Error('Expected a successful fixture result');
    const result = firstOutcome.result as {
      events: Array<Record<string, unknown>>;
      calendarsResolved: Array<Record<string, unknown>>;
      calendarsSearchedIds: string[];
      phoneCalendarCoverage: { sources: Array<Record<string, unknown>> };
    };
    expect(result.events[0]).toMatchObject({
      eventId: 'google-team-review',
      calendarId: 'google-work',
      calendar: 'Work',
      summary: 'Team review',
      start: '2026-10-23T16:00:00.000Z',
      end: '2026-10-23T17:00:00.000Z',
      iCalUID: 'team-review@example.test',
    });
    expect(result.calendarsResolved).toContainEqual({
      id: 'iphone:family',
      name: 'Family (iPhone)',
    });
    expect(result.calendarsSearchedIds).toEqual(['google-work', 'iphone:family']);
    expect(result.phoneCalendarCoverage.sources).toEqual([
      { calendarId: 'family', status: 'available', complete: true },
    ]);
  });
});
