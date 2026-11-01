import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigForTest } from '../config.js';
import type { BriefingCalendarEvent } from '../workflow/briefing.js';
import { eventLeadMoments, persistNextPulseMoment, runPulse } from './pulse.js';

type Admission = Parameters<Parameters<typeof persistNextPulseMoment>[0]['admitNotice']>[0];

const now = new Date('2026-03-04T09:00:00Z');
const work: BriefingCalendarEvent = {
  allDay: false,
  summary: 'Review',
  eventId: 'z-work',
  calendarId: 'work',
  calendar: 'Work',
  iCalUID: 'same-occurrence',
  start: '2026-03-04T09:10:00Z',
  end: '2026-03-04T10:00:00Z',
  attendees: ['owner@example.com (needsAction)'],
};
const personal = { ...work, eventId: 'a-personal', calendarId: 'personal', calendar: 'Personal' };

afterEach(() => resetConfigForTest());

describe('pulse v2 activation gate', () => {
  it('defaults off and requires an explicit true value', () => {
    expect(loadConfig({}).PROACTIVE_PULSE_RANKING_DEDUPE_V2_ENABLED).toBe(false);
    resetConfigForTest();
    expect(
      loadConfig({ PROACTIVE_PULSE_RANKING_DEDUPE_V2_ENABLED: 'false' })
        .PROACTIVE_PULSE_RANKING_DEDUPE_V2_ENABLED,
    ).toBe(false);
    resetConfigForTest();
    expect(
      loadConfig({ PROACTIVE_PULSE_RANKING_DEDUPE_V2_ENABLED: 'true' })
        .PROACTIVE_PULSE_RANKING_DEDUPE_V2_ENABLED,
    ).toBe(true);
  });

  it('keeps each provider row and legacy presentation by default', () => {
    const moments = eventLeadMoments(
      [work, personal].map((event) => ({
        event,
        score: 5,
        reasons: ['it falls outside your usual hours'],
      })),
      now,
    );
    expect(moments.map((moment) => moment.key)).toEqual([
      'event-lead:z-work:2026-03-04T09:10:00Z',
      'event-lead:a-personal:2026-03-04T09:10:00Z',
    ]);
    expect(moments[0]?.text).toBe(
      'Review starts in 10 minutes. It falls outside your usual hours.',
    );
    expect(moments[0]?.card).not.toHaveProperty('summary');
    for (const moment of moments) {
      expect(moment).not.toHaveProperty('legacyMomentKeys');
      expect(moment).not.toHaveProperty('urgency');
      expect(moment).not.toHaveProperty('relevance');
    }
  });

  it.each([undefined, 'false', 'true'] as const)(
    'routes the scheduled runtime through the gate (%s)',
    async (flag) => {
      loadConfig({
        OWNER_EMAIL: 'owner@example.com',
        ...(flag ? { PROACTIVE_PULSE_RANKING_DEDUPE_V2_ENABLED: flag } : {}),
      });
      const admitNotice = vi.fn(async (_input: Admission) => ({ status: 'already-said' as const }));
      const momentKeys = vi.fn(async () => []);
      // Fake persistence ports only: no database, providers, delivery, or configuration writes.
      const pulse = {
        observationFence: async () => null,
        ambientDailyCap: async () => null,
        deliveredSince: async () => 0,
        calendarSnapshot: async () => [],
        syncCalendarSnapshot: vi.fn(),
        actionableMail: async () => [],
        dueCommitments: async () => [],
        situationPacks: async () => [],
        momentKeys,
        admitNotice,
      };
      const deps = {
        persistence: {
          pulse,
          executionContext: {
            getAgent: async () => ({
              id: 'owner',
              name: 'Owner',
              email: 'owner@example.com',
              timezone: 'UTC',
            }),
          },
        },
        calendarReader: async () => ({ events: [work, personal], complete: true }),
      } as unknown as Parameters<typeof runPulse>[0];
      const result = await runPulse(deps, { now, agentId: 'owner' });
      expect(result.candidates).toBe(flag === 'true' ? 1 : 2);
      expect(admitNotice).toHaveBeenCalledTimes(flag === 'true' ? 1 : 2);
      const admitted = admitNotice.mock.calls.map(([input]) => input.moment);
      if (flag === 'true') {
        expect(admitted[0]?.key).toMatch(/^event-lead:v2:/);
        expect(momentKeys).toHaveBeenCalledWith('owner', 'event-lead');
      } else {
        expect(admitted.map((moment) => moment.key)).toEqual([
          'event-lead:a-personal:2026-03-04T09:10:00Z',
          'event-lead:z-work:2026-03-04T09:10:00Z',
        ]);
        expect(momentKeys.mock.calls).toEqual([['owner', 'situation-change']]);
        for (const [input] of admitNotice.mock.calls) {
          expect(input.notice.text).toBe(
            'Review starts in 10 minutes. You have not replied to the invitation.',
          );
          expect(input.notice.extraParts[0]).not.toHaveProperty('data.summary');
        }
      }
    },
  );
  it('preserves repeated legacy admission attempts when v2 is off', async () => {
    const [candidate] = eventLeadMoments([{ event: work, score: 5, reasons: [] }], now);
    if (!candidate) throw new Error('Missing legacy fixture');
    const admitNotice = vi.fn(async (_input: Admission) => ({ status: 'already-said' as const }));
    const momentKeys = vi.fn(async () => ['old-alias']);
    await persistNextPulseMoment(
      { admitNotice, momentKeys },
      {
        agentId: 'owner',
        now,
        observationFence: null,
        dailyCap: 6,
        candidates: [candidate, candidate],
      },
    );
    expect(admitNotice).toHaveBeenCalledTimes(2);
    expect(momentKeys).not.toHaveBeenCalled();
  });
});
