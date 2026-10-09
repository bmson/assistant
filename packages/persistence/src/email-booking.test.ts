import { describe, expect, it } from 'vitest';
import { resolveBookingLocalDateTime } from './email-booking.js';

describe('source booking timezone resolution', () => {
  it('resolves source-local time to one exact instant across a travel timezone', () => {
    expect(resolveBookingLocalDateTime('2026-10-12T16:40:00', 'Europe/Berlin')).toBe(
      '2026-10-12T14:40:00.000Z',
    );
  });

  it('preserves explicitly offset instants and rejects DST gaps and ambiguous repeated times', () => {
    expect(resolveBookingLocalDateTime('2026-10-12T16:40:00+02:00', 'Europe/Berlin')).toBe(
      '2026-10-12T14:40:00.000Z',
    );
    expect(resolveBookingLocalDateTime('2026-03-29T02:30:00', 'Europe/Berlin')).toBeNull();
    expect(resolveBookingLocalDateTime('2026-10-25T02:30:00', 'Europe/Berlin')).toBeNull();
  });
});
