import { createHash } from 'node:crypto';

/**
 * The nudge policy's storage-free half: the decision types and the owner-local
 * clock arithmetic both adapters share, so quiet hours and the ambient daily
 * cap mean exactly the same thing on PostgreSQL and Firestore. See
 * `evaluateOutOfBandPing` in core for the policy itself.
 */

export function answerReadyPingId(agentId: string, channel: string): string {
  const hex = createHash('sha256')
    .update(JSON.stringify([agentId, channel]))
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type PingUrgency = 'ambient' | 'interrupt';
export type PingSuppression = 'quiet-hours' | 'daily-cap';

export interface PingDecision {
  deliver: boolean;
  reason?: PingSuppression;
}

export interface OutOfBandPingInput {
  urgency: PingUrgency;
  channel?: string;
  now?: Date;
}

/**
 * Decide whether an out-of-band (SMS/push) ping may interrupt the owner, and
 * record the evaluation in the ping ledger, delivered or not. Ambient
 * evaluations for one owner-local day are serialized, so concurrent producers
 * cannot all spend the last slot of the daily cap.
 */
export interface NudgePolicyRepository {
  readonly kind: 'nudge-policy-repository';
  evaluate(
    agent: { id: string; timezone: string },
    input: OutOfBandPingInput,
  ): Promise<PingDecision>;
}

/** Wall-clock minutes after midnight in the zone, for the quiet-hours window. */
export function ownerLocalMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

/** The zone's offset from UTC at a given instant, in milliseconds. */
function tzOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant of the owner's local midnight at `now` (DST-refined once). */
export function ownerLocalMidnightUtc(timeZone: string, now: Date): Date {
  const [year = 1970, month = 1, day = 1] = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .split('-')
    .map(Number);
  const midnightAsIfUtc = Date.UTC(year, month - 1, day);
  const guess = midnightAsIfUtc - tzOffsetMs(timeZone, new Date(midnightAsIfUtc));
  return new Date(midnightAsIfUtc - tzOffsetMs(timeZone, new Date(guess)));
}

export function insideQuietHours(
  prefs: { quietStartMin: number | null; quietEndMin: number | null },
  minutes: number,
): boolean {
  const { quietStartMin: start, quietEndMin: end } = prefs;
  // An unset or zero-width window is off, not "quiet forever".
  if (start == null || end == null || start === end) return false;
  // A start after the end is an overnight window (22:00 → 07:00).
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}
