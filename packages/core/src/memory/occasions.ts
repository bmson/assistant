import {
  assertPostgresPrivacyObservationFence,
  contacts,
  type Db,
  lockPostgresPrivacyObservationFence,
  type OccasionRow,
  occasions,
} from '@assistant/db';
import { occasionTrustRank } from '@assistant/persistence/occasion-trust';
import { and, asc, eq, sql } from 'drizzle-orm';

/**
 * Occasions (Phase 17): recurring dates tied to a contact (birthdays,
 * anniversaries, custom). Stored as month/day so annual dates recur without a
 * year; the "next occurrence" and lead-time surfacing are computed here.
 */

export type OccasionKind = 'birthday' | 'anniversary' | 'custom';
export type OccasionRecurrence = 'annual' | 'once';

const OCCASION_KINDS: ReadonlySet<string> = new Set(['birthday', 'anniversary', 'custom']);
export function isOccasionKind(value: unknown): value is OccasionKind {
  return typeof value === 'string' && OCCASION_KINDS.has(value);
}

/** Clamp a day to a plausible value; the DB check also enforces 1–31. */
export function validMonthDay(month: number, day: number): boolean {
  return (
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= 31
  );
}

/**
 * Month vocabulary, shared with the knowledge graph's date canonicalizer so the
 * two agree on what counts as a month name rather than keeping two drifting
 * copies of the same list.
 */
export const MONTH_NAMES: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
export const MONTH_ALT = Object.keys(MONTH_NAMES).join('|');
// "14 March" / "14th of March"
const DAY_MONTH_RE = new RegExp(
  `\\b(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALT})\\b`,
);
// "March 14" / "March 14th" — the (?!\d) day guard rejects a bare year ("May 1990").
const MONTH_DAY_RE = new RegExp(`\\b(${MONTH_ALT})\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?\\b`);

export interface DetectedOccasion {
  kind: 'birthday' | 'anniversary';
  month: number;
  day: number;
}

/**
 * Best-effort detection of a birthday/anniversary date stated in a fact's text,
 * powering the Profile "Save as occasion" chip. Deliberately conservative: it
 * only fires when the sentence also names the *kind* (born/birthday, or
 * anniversary) so it never guesses a bare date, and it never infers the year —
 * "turned 70 on 9 January 2026" would misread 2026 as a birth year, so the owner
 * fills the year in themselves. Returns null when nothing confident is found.
 */
export function detectOccasionInText(text: string): DetectedOccasion | null {
  const lower = text.toLowerCase();
  const kind: DetectedOccasion['kind'] | null = /anniversar/.test(lower)
    ? 'anniversary'
    : /\b(born|birthday|birth\s?day|turns?|turned)\b/.test(lower)
      ? 'birthday'
      : null;
  if (!kind) return null;

  const dayMonth = lower.match(DAY_MONTH_RE);
  if (dayMonth) {
    const day = Number(dayMonth[1]);
    const month = MONTH_NAMES[dayMonth[2] as string];
    if (month && validMonthDay(month, day)) return { kind, month, day };
  }
  const monthDay = lower.match(MONTH_DAY_RE);
  if (monthDay) {
    const month = MONTH_NAMES[monthDay[1] as string];
    const day = Number(monthDay[2]);
    if (month && validMonthDay(month, day)) return { kind, month, day };
  }
  return null;
}

/** Date-only "today" in UTC — occasions are day-granular, so time-of-day is irrelevant. */
function utcToday(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The next annual occurrence of month/day on or after today. */
export function nextAnnualOccurrence(month: number, day: number, now: Date): Date {
  const today = utcToday(now);
  let occurrence = new Date(Date.UTC(now.getUTCFullYear(), month - 1, day));
  if (occurrence.getTime() < today.getTime()) {
    occurrence = new Date(Date.UTC(now.getUTCFullYear() + 1, month - 1, day));
  }
  return occurrence;
}

/** Whole days from today until the occasion's next occurrence (negative = past, for 'once'). */
export function daysUntilOccurrence(
  occasion: Pick<OccasionRow, 'month' | 'day' | 'year' | 'recurrence'>,
  now: Date,
): number {
  const today = utcToday(now);
  const next =
    occasion.recurrence === 'once' && occasion.year !== null
      ? new Date(Date.UTC(occasion.year, occasion.month - 1, occasion.day))
      : nextAnnualOccurrence(occasion.month, occasion.day, now);
  return Math.round((next.getTime() - today.getTime()) / 86_400_000);
}

export interface UpcomingOccasion {
  id: string;
  contactId: string;
  contactName: string;
  kind: string;
  label: string;
  month: number;
  day: number;
  year: number | null;
  leadDays: number;
  notes: string;
  daysUntil: number;
  /** ISO date (YYYY-MM-DD) of the next occurrence. */
  nextDate: string;
}

/**
 * Occasions coming up within their lead window (or an explicit `withinDays`),
 * soonest first. Quarantined occasions never surface. Joined to the contact so
 * callers get a name to show without a second query.
 */
export async function upcomingOccasions(
  db: Db,
  agentId: string,
  opts: { withinDays?: number; now?: Date } = {},
): Promise<UpcomingOccasion[]> {
  const now = opts.now ?? new Date();
  const rows = await db
    .select({
      id: occasions.id,
      contactId: occasions.contactId,
      contactName: contacts.name,
      kind: occasions.kind,
      label: occasions.label,
      month: occasions.month,
      day: occasions.day,
      year: occasions.year,
      recurrence: occasions.recurrence,
      leadDays: occasions.leadDays,
      notes: occasions.notes,
    })
    .from(occasions)
    .innerJoin(contacts, eq(contacts.id, occasions.contactId))
    .where(and(eq(occasions.agentId, agentId), eq(occasions.quarantined, false)));
  return selectUpcomingOccasions(rows, { ...opts, now });
}

/** The storage-free half of `upcomingOccasions`, for rows any driver has already read. */
export function selectUpcomingOccasions(
  rows: Array<Omit<UpcomingOccasion, 'daysUntil' | 'nextDate'> & { recurrence: string }>,
  opts: { withinDays?: number; now?: Date } = {},
): UpcomingOccasion[] {
  const now = opts.now ?? new Date();
  const upcoming: UpcomingOccasion[] = [];
  for (const row of rows) {
    const daysUntil = daysUntilOccurrence(row, now);
    const window = opts.withinDays ?? row.leadDays;
    if (daysUntil < 0 || daysUntil > window) continue;
    const next =
      row.recurrence === 'once' && row.year !== null
        ? new Date(Date.UTC(row.year, row.month - 1, row.day))
        : nextAnnualOccurrence(row.month, row.day, now);
    upcoming.push({
      id: row.id,
      contactId: row.contactId,
      contactName: row.contactName,
      kind: row.kind,
      label: row.label,
      month: row.month,
      day: row.day,
      year: row.year,
      leadDays: row.leadDays,
      notes: row.notes,
      daysUntil,
      nextDate: next.toISOString().slice(0, 10),
    });
  }
  return upcoming.sort((a, b) => a.daysUntil - b.daysUntil);
}

/** Every occasion for one contact, soonest annual date first (for the Profile page). */
export async function listOccasionsForContact(db: Db, contactId: string): Promise<OccasionRow[]> {
  return db
    .select()
    .from(occasions)
    .where(eq(occasions.contactId, contactId))
    .orderBy(asc(occasions.month), asc(occasions.day));
}

export interface SaveOccasionInput {
  agentId: string;
  contactId: string;
  kind: OccasionKind;
  label?: string;
  month: number;
  day: number;
  year?: number | null;
  recurrence?: OccasionRecurrence;
  leadDays?: number;
  notes?: string;
  originTrust?: string;
  quarantined?: boolean;
  ownerConfirmed?: boolean;
  source?: string;
}

/**
 * Insert an occasion, idempotent on (agent, contact, kind, month, day). A repeat
 * for the same date is a no-op EXCEPT that new notes are merged and a
 * previously-unknown year is filled in — so re-mentioning a birthday to add a
 * gift idea updates the existing row rather than being dropped.
 */
export async function saveOccasion(
  db: Db,
  input: SaveOccasionInput,
  privacyObservation?: { generation: string | null },
): Promise<{ saved: boolean; occasion: OccasionRow }> {
  return db.transaction(async (tx) => {
    await lockPostgresPrivacyObservationFence(tx as unknown as Db, input.agentId);
    if (privacyObservation)
      await assertPostgresPrivacyObservationFence(
        tx as unknown as Db,
        input.agentId,
        privacyObservation.generation,
      );
    return saveOccasionInTransaction(tx as unknown as Db, input);
  });
}

async function saveOccasionInTransaction(
  db: Db,
  input: SaveOccasionInput,
): Promise<{ saved: boolean; occasion: OccasionRow }> {
  if (!isOccasionKind(input.kind)) throw new Error(`invalid occasion kind: ${input.kind}`);
  if (!validMonthDay(input.month, input.day)) {
    throw new Error(`invalid occasion date: month ${input.month}, day ${input.day}`);
  }
  const notes = (input.notes ?? '').trim().slice(0, 2000);
  const [row] = await db
    .insert(occasions)
    .values({
      agentId: input.agentId,
      contactId: input.contactId,
      kind: input.kind,
      label: (input.label ?? '').slice(0, 120),
      month: input.month,
      day: input.day,
      year: input.year ?? null,
      recurrence: input.recurrence ?? 'annual',
      leadDays: input.leadDays ?? 7,
      notes,
      originTrust: input.originTrust ?? 'owner',
      quarantined: input.quarantined ?? false,
      ownerConfirmed: input.ownerConfirmed ?? false,
      source: input.source,
    })
    .onConflictDoUpdate({
      target: [
        occasions.agentId,
        occasions.contactId,
        occasions.kind,
        occasions.month,
        occasions.day,
      ],
      set: {
        // Only same-or-higher trust observations may add accepted fields.
        year: sql`coalesce(${occasions.year}, excluded.year)`,
        notes: sql`case
          when ${occasions.notes} = '' then excluded.notes
          when excluded.notes = '' or position(excluded.notes in ${occasions.notes}) > 0 then ${occasions.notes}
          else ${occasions.notes} || '; ' || excluded.notes end`,
        updatedAt: sql`now()`,
      },
      setWhere: sql`(case ${occasions.originTrust} when 'owner' then 3 when 'assistant' then 2 when 'known' then 1 else 0 end) <= ${occasionTrustRank(input.originTrust ?? 'owner')}
        and not (${input.quarantined ?? false} and not ${occasions.quarantined})
        and not (${occasions.ownerConfirmed} and ${input.originTrust ?? 'owner'} <> 'owner')`,
    })
    .returning();
  if (!row) {
    const [unchanged] = await db
      .select()
      .from(occasions)
      .where(
        and(
          eq(occasions.agentId, input.agentId),
          eq(occasions.contactId, input.contactId),
          eq(occasions.kind, input.kind),
          eq(occasions.month, input.month),
          eq(occasions.day, input.day),
        ),
      )
      .limit(1);
    if (!unchanged) throw new Error('occasion upsert failed');
    return { saved: false, occasion: unchanged };
  }
  // `saved` is true when this created a new row (createdAt == updatedAt on insert).
  return { saved: row.createdAt.getTime() === row.updatedAt.getTime(), occasion: row };
}
