import { describe, expect, it, vi } from 'vitest';
import { diffCalendarEvents, toSnapshotRow } from './calendar-diff.js';
import { resolveCalendarWindow } from './calendar-resolution.js';

const now = new Date('2026-10-07T12:00:00Z');
const event = {
  calendarId: 'work',
  eventId: 'meeting',
  calendar: 'Work',
  summary: 'Review',
  start: '2026-10-07T14:00:00Z',
  end: '2026-10-07T15:00:00Z',
  allDay: false,
  status: 'confirmed',
};
const row = toSnapshotRow(event);
if (!row) throw new Error('Missing source snapshot');
const previous = [row];

describe('calendar event resolution outside a bounded window', () => {
  it.each(['2026-10-08T14:00:00Z', '2026-10-07T11:00:00Z'])(
    'verifies a move to %s rather than cancellation',
    async (start) => {
      const reader = vi.fn(async () => ({ ...event, start }));
      const observations = await resolveCalendarWindow([], previous, now, reader);
      expect(diffCalendarEvents(observations, previous, now, true)).toMatchObject([
        { kind: 'moved', start },
      ]);
      expect(reader).toHaveBeenCalledWith(
        expect.objectContaining({ calendarId: 'work', eventId: 'meeting' }),
      );
    },
  );
  it.each(['unavailable', 'permission lost', 'not found'])(
    'keeps %s reads unverified',
    async (reason) => {
      const observations = await resolveCalendarWindow([], previous, now, async () => {
        throw new Error(reason);
      });
      expect(diffCalendarEvents(observations, previous, now, true)).toMatchObject([
        { kind: 'unverified' },
      ]);
    },
  );
  it('recognizes only an explicit provider cancellation, including a minimal tombstone', async () => {
    const observations = await resolveCalendarWindow([], previous, now, async () => ({
      ...event,
      start: '',
      end: '',
      status: 'cancelled',
    }));
    expect(diffCalendarEvents(observations, previous, now, false)).toMatchObject([
      { kind: 'cancelled', start: event.start },
    ]);
  });
  it('rejects an identity mismatch and does not spend a point read on present events', async () => {
    const reader = vi.fn(async () => ({ ...event, eventId: 'wrong', status: 'cancelled' }));
    expect(
      diffCalendarEvents(
        await resolveCalendarWindow([], previous, now, reader),
        previous,
        now,
        true,
      ),
    ).toMatchObject([{ kind: 'unverified' }]);
    reader.mockClear();
    expect(await resolveCalendarWindow([event], previous, now, reader)).toEqual([event]);
    expect(reader).not.toHaveBeenCalled();
  });
});
