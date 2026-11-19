import { type BriefingInputs, commitmentIsActive } from '@assistant/persistence';
import { selectUpcomingOccasions } from '../memory/occasions.js';
import { collapseWhitespace, ownerDate, truncateAtBoundary } from '../owner-text.js';
import type { BriefingListItem } from '../workflow/briefing-card.js';

const DAY = 86_400_000;
const tidy = (value: string) => truncateAtBoundary(collapseWhitespace(value), 180);

/** Shared deterministic selection for both storage drivers. Civil dates never shift zones. */
export function briefingLifeContext(
  input: Pick<BriefingInputs, 'occasions' | 'commitments'>,
  now: Date,
  timeZone: string,
): { occasions: BriefingListItem[]; commitments: BriefingListItem[] } {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const civilNow = new Date(`${today}T12:00:00Z`);
  const occasions = selectUpcomingOccasions(
    (input.occasions ?? [])
      .filter((row) => {
        // An assistant's inference alone is not an established family date.
        if (row.quarantined || !(row.ownerConfirmed || row.originTrust === 'owner')) return false;
        if (row.recurrence !== 'annual' && row.recurrence !== 'once') return false;
        if (row.recurrence === 'once' && row.year === null) return false;
        const date = new Date(Date.UTC(row.year ?? 2000, row.month - 1, row.day));
        return date.getUTCMonth() === row.month - 1 && date.getUTCDate() === row.day;
      })
      .map((row) => ({ ...row, leadDays: Math.max(0, Math.min(30, row.leadDays)) })),
    { now: civilNow },
  )
    .slice(0, 6)
    .map((row) => ({
      title: `${tidy(row.contactName)} — ${tidy(row.label || row.kind)}`,
      detail:
        row.daysUntil === 0 ? 'Today' : `In ${row.daysUntil} day${row.daysUntil === 1 ? '' : 's'}`,
      meta: ownerDate(`${row.nextDate}T12:00:00Z`, 'UTC', civilNow),
    }));

  const seenCommitments = new Set<string>();
  const staleDays = (kind: string) => (kind === 'promise' || kind === 'waiting_on' ? 2 : 7);
  const commitments = (input.commitments ?? [])
    .filter((row) => commitmentIsActive(row, now))
    .filter((row) =>
      row.dueAt
        ? row.dueAt.getTime() <= now.getTime() + 7 * DAY
        : row.updatedAt.getTime() <= now.getTime() - staleDays(row.kind) * DAY,
    )
    .sort(
      (a, b) =>
        (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity) ||
        a.updatedAt.getTime() - b.updatedAt.getTime() ||
        a.id.localeCompare(b.id),
    )
    .filter((row) => {
      const key = `${row.kind}|${collapseWhitespace(row.title).toLowerCase()}|${row.dueAt?.toISOString() ?? ''}`;
      if (seenCommitments.has(key)) return false;
      seenCommitments.add(key);
      return true;
    })
    .slice(0, 5)
    .map((row) => ({
      title: tidy(row.title),
      detail: row.dueAt
        ? `Still open in your records; due ${ownerDate(row.dueAt.toISOString(), timeZone, now)}.`
        : `Still open in your records; no update for at least ${staleDays(row.kind)} days. Check whether this still needs follow-through.`,
      meta: row.dueAt && row.dueAt < now ? 'Past recorded due date' : 'Open commitment',
    }));
  return { occasions, commitments };
}
