import type { ModelRouter } from '@assistant/core/model-router';
import { describe, expect, it, vi } from 'vitest';
import { assessCalendarDuplicates, calendarDuplicateRequest } from './calendar-duplicates.js';

const base = [
  {
    id: 'family',
    calendar: 'family',
    title: 'Harbor vs Cedar Valley (5:10PM)',
    start: '2026-11-07T16:25:00-08:00',
    end: '2026-11-07T18:30:00-08:00',
    location: 'North Meadow Soccer Fields, 123 East Road',
  },
  {
    id: 'club',
    calendar: 'club',
    title: 'Blue vs Cedar Valley SC Youth Gold',
    start: '2026-11-07T17:10:00-08:00',
    end: '2026-11-07T18:30:00-08:00',
    location: 'North Meadow, 789 West Avenue',
  },
  {
    id: 'gala',
    calendar: 'family',
    title: 'Community Gala',
    start: '2026-11-07T17:00:00-08:00',
    end: '2026-11-07T22:30:00-08:00',
    location: 'River Hall, 700 High Street',
  },
];
function mockRouter(groups: unknown) {
  const object = vi.fn().mockResolvedValue({ ok: true, object: { groups } });
  return { object, router: { object } as unknown as Pick<ModelRouter, 'object'> };
}

describe('calendar duplicate assessor', () => {
  it('accepts only high-confidence groups and caches identical owner-bound snapshots', async () => {
    const model = mockRouter([
      {
        eventIds: ['family', 'club'],
        confidence: 0.94,
        reason: 'Shared matchup and venue; arrival may be earlier.',
      },
    ]);
    const request = { ownerId: 'cache-owner', events: base, router: model.router };
    const [first, second] = await Promise.all([
      assessCalendarDuplicates(request),
      assessCalendarDuplicates(request),
    ]);
    expect(first.groups[0]?.eventIds).toEqual(['family', 'club']);
    expect(second).toEqual(first);
    await assessCalendarDuplicates(request);
    expect(model.object).toHaveBeenCalledTimes(1);
    await assessCalendarDuplicates({ ...request, ownerId: 'other-owner' });
    await assessCalendarDuplicates({
      ...request,
      events: [{ ...base[0]!, title: 'Changed' }, ...base.slice(1)],
    });
    expect(model.object).toHaveBeenCalledTimes(3);
    expect(model.object).toHaveBeenCalledWith(
      'classify',
      expect.objectContaining({
        singleAttempt: true,
        maxRetries: 0,
        requestProfile: { tools: 'none', output: 'json_schema', streaming: false },
      }),
    );
  });
  it('retains all entries when confidence is below the threshold', async () => {
    const model = mockRouter([
      { eventIds: ['family', 'club'], confidence: 0.89, reason: 'Possibly the same game.' },
    ]);
    expect(
      await assessCalendarDuplicates({
        ownerId: 'low-confidence',
        events: base,
        router: model.router,
      }),
    ).toEqual({ groups: [] });
  });
  it('accepts the explicit threshold and rejects malformed confidence', async () => {
    const atThreshold = mockRouter([
      { eventIds: ['family', 'club'], confidence: 0.9, reason: 'matching matchup' },
    ]);
    expect(
      (
        await assessCalendarDuplicates({
          ownerId: 'threshold',
          events: base,
          router: atThreshold.router,
        })
      ).groups,
    ).toHaveLength(1);
    const invalid = mockRouter([
      { eventIds: ['family', 'club'], confidence: 1.1, reason: 'invalid confidence' },
    ]);
    await expect(
      assessCalendarDuplicates({ ownerId: 'bad-confidence', events: base, router: invalid.router }),
    ).rejects.toThrow();
  });
  it('allows a matching street address or missing location when the model identifies a match', async () => {
    const model = mockRouter([
      { eventIds: ['family', 'club'], confidence: 0.96, reason: 'Same appointment.' },
    ]);
    const appointment = {
      ...base[0]!,
      title: 'Dental appointment',
      start: base[1]!.start,
      location: '123 Main St, San Mateo, CA 94401',
    };
    for (const [index, locations] of [
      ['123 Main Street, San Mateo, CA 94401', appointment.location],
      ['', appointment.location],
      ['', ''],
    ].entries()) {
      const events = [
        { ...appointment, location: locations[0]! },
        { ...base[1]!, title: appointment.title, location: locations[1]! },
      ];
      const result = await assessCalendarDuplicates({
        ownerId: `address-${index}`,
        events,
        router: model.router,
      });
      expect(result.groups).toHaveLength(1);
    }
  });
  it('accepts a shared named complex in the same city despite different entrances and ZIPs', async () => {
    const model = mockRouter([
      { eventIds: ['family', 'club'], confidence: 0.94, reason: 'Same matchup.' },
    ]);
    const events = [
      { ...base[0]!, location: 'North Meadow Soccer Fields, 123 East Road, San Mateo, CA 94401' },
      { ...base[1]!, location: 'North Meadow, 789 West Avenue, San Mateo, CA 94402' },
    ];
    expect(
      (await assessCalendarDuplicates({ ownerId: 'entrances', events, router: model.router }))
        .groups,
    ).toHaveLength(1);
  });
  it('rejects invented, repeated or overlapping IDs and incompatible groups', async () => {
    for (const [index, groups] of [
      [{ eventIds: ['family', 'missing'], confidence: 0.99, reason: 'x' }],
      [{ eventIds: ['family', 'family'], confidence: 0.99, reason: 'x' }],
      [
        { eventIds: ['family', 'club'], confidence: 0.99, reason: 'x' },
        { eventIds: ['club', 'gala'], confidence: 0.99, reason: 'x' },
      ],
      [{ eventIds: ['club', 'gala'], confidence: 0.99, reason: 'x' }],
    ].entries()) {
      const model = mockRouter(groups);
      await expect(
        assessCalendarDuplicates({
          ownerId: `invalid-${index}`,
          events: base,
          router: model.router,
        }),
      ).rejects.toThrow();
    }
  });
  it('does not accept contradictory opponents, dates, times or venues even when the model does', async () => {
    const model = mockRouter([{ eventIds: ['family', 'club'], confidence: 0.99, reason: 'x' }]);
    const variants = [
      { ...base[1]!, title: 'Blue vs Mountain Ridge' },
      { ...base[1]!, title: 'Blue vs Cedar Ridge' },
      { ...base[1]!, start: '2026-11-08T17:10:00-08:00', end: '2026-11-08T18:30:00-08:00' },
      { ...base[1]!, start: '2026-11-07T11:10:00-08:00', end: '2026-11-07T12:30:00-08:00' },
      { ...base[1]!, location: 'South Valley Park, 123 East Road' },
      { ...base[1]!, location: 'North Meadow, 789 West Avenue, Oakland, CA 94601' },
      { ...base[1]!, location: 'North Meadow, Oakland' },
      { ...base[1]!, location: 'North Meadow, 789 West Avenue, San Mateo, OR 97001' },
    ];
    for (const [index, changed] of variants.entries()) {
      await expect(
        assessCalendarDuplicates({
          ownerId: `negative-${index}`,
          events: [
            {
              ...base[0]!,
              location: 'North Meadow Soccer Fields, 123 East Road, San Mateo, CA 94401',
            },
            changed,
          ],
          router: model.router,
        }),
      ).rejects.toThrow();
    }
  });
  it('fails closed on provider failure and does not cache the failure', async () => {
    const object = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    const router = { object } as unknown as Pick<ModelRouter, 'object'>;
    for (let i = 0; i < 2; i++)
      await expect(
        assessCalendarDuplicates({ ownerId: 'failure', events: base, router }),
      ).rejects.toThrow();
    expect(object).toHaveBeenCalledTimes(2);
  });
  it('rejects duplicate IDs and invalid request sizes', () => {
    expect(calendarDuplicateRequest.safeParse({ events: [base[0], base[0]] }).success).toBe(false);
    expect(
      calendarDuplicateRequest.safeParse({
        events: Array.from({ length: 13 }, (_, i) => ({ ...base[0], id: String(i) })),
      }).success,
    ).toBe(false);
    expect(
      calendarDuplicateRequest.safeParse({
        events: [{ ...base[0], start: '2026-11-07T16:25:00' }, base[1]],
      }).success,
    ).toBe(false);
  });
});
