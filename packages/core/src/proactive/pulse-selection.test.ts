import type { Db } from '@assistant/db';
import type { PulseCalendarSnapshot, PulseRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import type { BriefingCalendarEvent } from '../workflow/briefing.js';
import { diffCalendarEvents, toSnapshotRow } from './calendar-diff.js';
import {
  calendarChangeMoments,
  calendarSnapshotForDelivery,
  type PulseDeps,
  type PulseMoment,
  persistNextPulseMoment,
  runPulse,
} from './pulse.js';

const now = new Date('2026-10-02T12:00:00Z');
function moment(key: string, priority: number): PulseMoment {
  return {
    kind: 'commitment-due',
    key,
    priority,
    text: `Notice ${key}`,
    card: {
      kind: 'proactive-alert',
      id: key,
      category: 'commitment',
      title: key,
      urgencyLabel: 'Due soon',
    },
  };
}

describe('persistNextPulseMoment', () => {
  const options = { agentId: 'owner', now, observationFence: null, dailyCap: 6 };
  const persisted = (key: string) => ({
    status: 'persisted' as const,
    momentId: `moment-${key}`,
    messageId: `message-${key}`,
    conversationId: 'primary-chat',
    suggestionCreated: false,
  });
  it('an already mentioned urgent item cannot starve the next useful item', async () => {
    const admitNotice = vi.fn(async (input: Parameters<PulseRepository['admitNotice']>[0]) =>
      input.moment.key === 'old'
        ? { status: 'already-said' as const }
        : persisted(input.moment.key),
    );
    const result = await persistNextPulseMoment(
      { admitNotice },
      {
        ...options,
        candidates: [moment('fresh', 40), moment('old', 100)],
      },
    );
    expect(result).toMatchObject({
      moment: { key: 'fresh' },
      notice: { momentId: 'moment-fresh' },
      heldBy: null,
    });
    expect(admitNotice.mock.calls.map(([input]) => input.moment.key)).toEqual(['old', 'fresh']);
    expect(result.alreadySaidKeys).toEqual(['old']);
  });
  it.each(['min-gap', 'daily-cap'] as const)(
    'a concurrent %s admission cannot create a second notice',
    async (status) => {
      const admitNotice = vi.fn(async () => ({ status }));
      const result = await persistNextPulseMoment(
        { admitNotice },
        {
          ...options,
          candidates: [moment('top', 100), moment('next', 40)],
        },
      );
      expect(result).toEqual({ moment: null, notice: null, alreadySaidKeys: [], heldBy: status });
      expect(admitNotice).toHaveBeenCalledTimes(1);
    },
  );
  it('remains quiet when all candidates were already mentioned', async () => {
    const result = await persistNextPulseMoment(
      { admitNotice: vi.fn(async () => ({ status: 'already-said' as const })) },
      {
        ...options,
        candidates: [moment('a', 100), moment('b', 40)],
      },
    );
    expect(result).toEqual({
      moment: null,
      notice: null,
      alreadySaidKeys: ['a', 'b'],
      heldBy: 'already-said',
    });
  });
  it('uses one stable ranking and preserves the injected observation clock and fence', async () => {
    const admitNotice = vi.fn(async () => persisted('a'));
    const result = await persistNextPulseMoment(
      { admitNotice },
      {
        ...options,
        observationFence: 'generation-1',
        candidates: [moment('z', 100), moment('a', 100)],
      },
    );
    expect(result.moment?.key).toBe('a');
    expect(admitNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        now,
        observationFence: 'generation-1',
        pacing: {
          gapSince: new Date('2026-10-02T11:00:00Z'),
          windowSince: new Date('2026-10-01T12:00:00Z'),
          dailyCap: 6,
        },
      }),
    );
  });
});

function calendarEvent(eventId: string, overrides: Partial<BriefingCalendarEvent> = {}) {
  return {
    eventId,
    calendarId: 'primary',
    summary: `Meeting ${eventId}`,
    calendar: 'Work',
    allDay: false,
    start: '2026-10-02T16:00:00Z',
    end: '2026-10-02T17:00:00Z',
    status: 'confirmed',
    ...overrides,
  };
}

describe('calendar changes survive pulse pacing', () => {
  it('retains unannounced cancellations and moves while advancing ordinary observations', () => {
    const previous = [calendarEvent('cancelled'), calendarEvent('moved')].map(
      (event) => toSnapshotRow(event) as PulseCalendarSnapshot,
    );
    const events = [
      calendarEvent('moved', { start: '2026-10-02T15:00:00Z' }),
      calendarEvent('new'),
    ];
    const changes = diffCalendarEvents(
      events,
      previous.map((row) => ({ ...row, attendeeResponseHash: {} })),
      now,
      true,
    );
    const update = calendarSnapshotForDelivery({
      events,
      previous,
      changes,
      acknowledgedKeys: new Set(),
      timeZone: 'UTC',
    });

    expect(update.cancelled).toEqual([]);
    expect(update.seen.find((row) => row.eventId === 'cancelled')).toEqual(previous[0]);
    expect(update.seen.find((row) => row.eventId === 'moved')?.start).toBe('2026-10-02T16:00:00Z');
    expect(update.seen.find((row) => row.eventId === 'new')).toBeDefined();
  });

  it('advances only acknowledged changes, including explicit cancellations in the response', () => {
    const previous = [calendarEvent('a'), calendarEvent('b')].map(
      (event) => toSnapshotRow(event) as PulseCalendarSnapshot,
    );
    const events = [calendarEvent('a', { status: 'cancelled' })];
    const changes = diffCalendarEvents(
      events,
      previous.map((row) => ({ ...row, attendeeResponseHash: {} })),
      now,
      true,
    );
    const update = calendarSnapshotForDelivery({
      events,
      previous,
      changes,
      acknowledgedKeys: new Set([calendarChangeMoments(changes, 'UTC')[0]?.key as string]),
      timeZone: 'UTC',
    });

    expect(update.cancelled).toEqual([{ calendarId: 'primary', eventId: 'a' }]);
    expect(update.seen.map((row) => row.eventId)).toEqual(['b']);
  });

  function pulseFixture() {
    let snapshot = [calendarEvent('a'), calendarEvent('b')].map(
      (event) => toSnapshotRow(event) as PulseCalendarSnapshot,
    );
    const claims: Array<{ key: string; kind: string; at: Date }> = [];
    const store: PulseRepository = {
      kind: 'pulse-repository',
      observationFence: async () => null,
      deliveredSince: async (_agentId, since) => claims.filter((row) => row.at >= since).length,
      ambientDailyCap: async () => null,
      momentKeys: async (_agentId, kind) =>
        claims.filter((row) => row.kind === kind).map((row) => row.key),
      calendarSnapshot: async () => snapshot,
      syncCalendarSnapshot: vi.fn(async (_agentId, input) => {
        snapshot = input.seen;
      }),
      actionableMail: async () => [],
      dueCommitments: async () => [],
      admitNotice: async (input) => {
        if (claims.some((row) => row.key === input.moment.key)) return { status: 'already-said' };
        const result = await post(input.notice);
        claims.push({ key: input.moment.key, kind: input.moment.kind, at: input.now });
        return {
          status: 'persisted',
          momentId: input.moment.key,
          messageId: input.moment.key,
          conversationId: result.conversationId,
          suggestionCreated: false,
        };
      },
      markPinged: vi.fn(async () => {}),
      situationPacks: async () => [],
    };
    const post = vi.fn(async (_input: unknown) => ({ conversationId: 'primary-chat' }));
    const deps: PulseDeps = {
      db: {} as Db,
      calendarReader: async () => ({ events: [], complete: true }),
      persistence: {
        executionContext: {
          getAgent: async () => ({
            id: 'owner',
            name: 'Ada',
            email: 'ada@example.test',
            timezone: 'UTC',
          }),
        },
        pulse: store,
      } as unknown as NonNullable<PulseDeps['persistence']>,
    };
    return { deps, store, post, snapshot: () => snapshot };
  }

  it('delivers two cancellations in separate paced runs without losing the second', async () => {
    const fixture = pulseFixture();
    const first = await runPulse(fixture.deps, { agentId: 'owner', now });
    expect(first.delivered).toBe('calendar-cancelled');
    expect(fixture.snapshot().map((row) => row.eventId)).toEqual(['b']);
    expect(fixture.post).toHaveBeenCalledTimes(1);

    const held = await runPulse(fixture.deps, { agentId: 'owner', now });
    expect(held.heldBy).toBe('min-gap');
    const next = await runPulse(fixture.deps, {
      agentId: 'owner',
      now: new Date(now.getTime() + 61 * 60_000),
    });
    expect(next.delivered).toBe('calendar-cancelled');
    expect(fixture.snapshot()).toEqual([]);
    expect(fixture.post).toHaveBeenCalledTimes(2);
  });

  it('does not advance the calendar baseline when the selected notice fails to persist', async () => {
    const fixture = pulseFixture();
    fixture.post.mockRejectedValueOnce(new Error('message storage unavailable'));
    await expect(runPulse(fixture.deps, { agentId: 'owner', now })).rejects.toThrow(
      'message storage unavailable',
    );
    expect(fixture.store.syncCalendarSnapshot).not.toHaveBeenCalled();
    expect(fixture.snapshot().map((row) => row.eventId)).toEqual(['a', 'b']);
    expect((await runPulse(fixture.deps, { agentId: 'owner', now })).delivered).toBe(
      'calendar-cancelled',
    );
  });
});
