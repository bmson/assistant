import { createHash } from 'node:crypto';

export type EmailBookingLifecycle = 'confirmed' | 'cancelled' | 'rescheduled' | 'tentative';

/** Keep identity exact enough to avoid merging bookings that only look alike. */
export function normalizeBookingIdentity(identity: string): string {
  return identity.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** A private, owner-scoped key suitable for indexes and proposal bindings. */
export function emailBookingKey(agentId: string, identity: string): string {
  const normalized = normalizeBookingIdentity(identity);
  if (!agentId || normalized.length < 2 || normalized.length > 160)
    throw new Error('Invalid email booking identity');
  return createHash('sha256')
    .update(JSON.stringify([agentId, normalized]))
    .digest('hex');
}

/** Stable Firestore identity shared by duplicate/cross-page source arrivals. */
export function emailBookingOccurrenceId(agentId: string, bookingKey: string): string {
  const hex = createHash('sha256')
    .update(JSON.stringify(['email-booking-occurrence', agentId, bookingKey]))
    .digest('hex');
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Provider time orders lifecycle observations; source id makes equal times deterministic. */
export function emailBookingObservationIsNewer(
  receivedAt: Date,
  messageId: string,
  current: { sourceReceivedAt: Date; sourceChannelMessageId: string } | null,
): boolean {
  if (!Number.isFinite(receivedAt.getTime()) || !messageId) return false;
  if (!current) return true;
  const delta = receivedAt.getTime() - current.sourceReceivedAt.getTime();
  return delta > 0 || (delta === 0 && messageId.localeCompare(current.sourceChannelMessageId) > 0);
}

/** Resolve a source-local wall time only when the named zone maps it to one instant. */
export function resolveBookingLocalDateTime(iso: string, timeZone: string): string | null {
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(iso)) {
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(iso);
  if (!match) return null;
  const parts = match.slice(1).map((part) => Number(part ?? 0));
  const [year, month, day, hour, minute, second] = parts;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  )
    return null;
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const target = [year, month, day, hour, minute, second].join(':');
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const wallAt = (instant: number) => {
      const values = formatter.formatToParts(new Date(instant));
      const value = (kind: string) => Number(values.find((part) => part.type === kind)?.value);
      return [
        value('year'),
        value('month'),
        value('day'),
        value('hour'),
        value('minute'),
        value('second'),
      ];
    };
    const offsets = new Set<number>();
    for (let hourOffset = -48; hourOffset <= 48; hourOffset += 6) {
      const instant = naive + hourOffset * 3_600_000;
      const wall = wallAt(instant);
      offsets.add(
        Date.UTC(
          wall[0] ?? 0,
          (wall[1] ?? 1) - 1,
          wall[2] ?? 1,
          wall[3] ?? 0,
          wall[4] ?? 0,
          wall[5] ?? 0,
        ) - instant,
      );
    }
    const candidates = [...offsets]
      .map((offset) => naive - offset)
      .filter((instant) => wallAt(instant).join(':') === target);
    return candidates.length === 1 ? new Date(candidates[0]!).toISOString() : null;
  } catch {
    return null;
  }
}
