import { describe, expect, it } from 'vitest';
import {
  bindReminderEventDependency,
  EVENT_COMPLETION_REMINDER_BLOCK,
  isCompletionDependentReminderRequest,
  isOrdinaryReminderRequest,
  shouldUseTaskScheduleDirective,
} from './reminder-grounding.js';

describe('reminder request semantics', () => {
  it('routes an ordinary reminder through its own durable tool without task.schedule', () => {
    const request = 'Remind me tomorrow at 9 to call the dentist.';
    expect(isOrdinaryReminderRequest(request)).toBe(true);
    expect(shouldUseTaskScheduleDirective('schedule', request)).toBe(false);
    expect(shouldUseTaskScheduleDirective('schedule', 'Check in with me next month')).toBe(true);
    expect(shouldUseTaskScheduleDirective('workflow', request)).toBe(false);
  });

  it('flags event-completion reminders whose dependency cannot be persisted', () => {
    expect(isCompletionDependentReminderRequest('Remind me after the game tomorrow.')).toBe(true);
    expect(isCompletionDependentReminderRequest('Set a reminder when my meeting ends.')).toBe(true);
    expect(isCompletionDependentReminderRequest('Remind me tomorrow at 9.')).toBe(false);
    expect(isCompletionDependentReminderRequest('After the game, explain the score.')).toBe(false);
    expect(EVENT_COMPLETION_REMINDER_BLOCK).toMatch(/provider-confirmed completion/);
  });

  it('binds a reminder to one current-task fixture and verifies team and owner-local date', () => {
    const requestText = 'Remind me after the Giants game tomorrow to check the final score.';
    const window = [
      { role: 'user', content: requestText },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolName: 'sports.scores',
            output: {
              type: 'json',
              value: {
                fetchedAt: '2026-10-07T06:35:00.000Z',
                games: [
                  {
                    id: 'fixture-1',
                    league: 'mlb',
                    startsAt: '2026-10-08T02:00:00.000Z',
                    state: 'pre',
                    home: { id: 'sf', name: 'San Francisco Giants', shortName: 'Giants' },
                    away: { id: 'la', name: 'Los Angeles Dodgers', shortName: 'Dodgers' },
                  },
                ],
              },
            },
          },
        ],
      },
    ];
    const bound = bindReminderEventDependency({
      eventId: 'fixture-1',
      window,
      requestText,
      requestAt: new Date('2026-10-07T06:30:00.000Z'),
      timeZone: 'America/Los_Angeles',
    });
    expect(bound).toEqual({
      dependency: {
        provider: 'sports',
        eventId: 'fixture-1',
        league: 'mlb',
        startsAt: '2026-10-08T02:00:00.000Z',
        eventDate: '2026-10-07',
        timezone: 'America/Los_Angeles',
        homeTeamId: 'sf',
        awayTeamId: 'la',
        homeTeam: 'San Francisco Giants',
        awayTeam: 'Los Angeles Dodgers',
        verifiedAt: '2026-10-07T06:35:00.000Z',
      },
    });
  });

  it('rejects stale, ambiguous, wrong-team and wrong-date fixture evidence', () => {
    const requestText = 'Remind me after the Giants game tomorrow.';
    const game = {
      id: 'fixture-1',
      league: 'mlb',
      startsAt: '2026-10-08T02:00:00.000Z',
      state: 'pre',
      home: { id: 'sf', name: 'San Francisco Giants' },
      away: { id: 'la', name: 'Los Angeles Dodgers' },
    };
    const result = {
      fetchedAt: '2026-10-07T06:35:00.000Z',
      games: [game],
    };
    const lookupMessage = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolName: 'sports.scores',
          output: { type: 'json', value: result },
        },
      ],
    };
    const requestAt = new Date('2026-10-07T06:30:00.000Z');
    const base = {
      eventId: 'fixture-1',
      requestText,
      requestAt,
      timeZone: 'America/Los_Angeles',
    };
    expect(
      bindReminderEventDependency({
        ...base,
        window: [lookupMessage, { role: 'user', content: requestText }],
      }),
    ).toMatchObject({ reason: expect.stringContaining('No unique event') });
    expect(
      bindReminderEventDependency({
        ...base,
        window: [
          { role: 'user', content: requestText },
          lookupMessage,
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolName: 'sports.scores',
                output: { type: 'json', value: result },
              },
            ],
          },
        ],
      }),
    ).toMatchObject({ reason: expect.stringContaining('No unique event') });
    expect(
      bindReminderEventDependency({
        ...base,
        requestText: 'Remind me after the Lakers game tomorrow.',
        window: [{ role: 'user', content: requestText }, lookupMessage],
      }),
    ).toMatchObject({ reason: expect.stringContaining('does not match') });
    expect(
      bindReminderEventDependency({
        ...base,
        window: [
          { role: 'user', content: requestText },
          {
            ...lookupMessage,
            content: [
              {
                type: 'tool-result',
                toolName: 'sports.scores',
                output: {
                  type: 'json',
                  value: {
                    ...result,
                    games: [{ ...game, startsAt: '2026-10-09T02:00:00.000Z' }],
                  },
                },
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      reason: expect.stringContaining('does not identify one unique game occurrence'),
    });
  });
});
