/**
 * When a stated validity stops covering the present.
 *
 * The store records temporal validity in two shapes, for good reasons in both
 * cases: `memories.validUntil` is a timestamp, because consolidation writes it
 * from a resolved date; `knowledge_graph_relations.valid_until` is text,
 * because the wording it is quoted from is usually partial ("2019", "March").
 * Both answer the same question, so the rule for answering it lives here
 * rather than being re-derived at each call site.
 *
 * The distinction this exists to protect is between a fact the assistant
 * *knows* and a fact that is *still true*. Retrieval had been treating those
 * as the same thing: a job that ended in 2023 was as eligible to answer "where
 * do I work" as the one that started after it, and a birthplace counted as
 * knowing where someone lives. Both are the same mistake — the past standing
 * in for the present — and both are corrected by asking this one question of
 * the row before it is allowed to speak for now.
 *
 * Nothing here erases history. A lapsed fact stays readable, keeps its
 * provenance, and is still returned by an explicit recall; it just stops being
 * offered as current state.
 */

/**
 * The instant a stated period stops covering the present.
 *
 * Partial precision is the common case in the graph, and a year means the
 * whole of it — so this returns the END of the stated period. Reading "2019"
 * as 2019-01-01 would call a fact lapsed for the twelve months it actually
 * covers, which is the more damaging direction to be wrong in: it would hide
 * something true rather than merely keep something stale a little longer.
 */
export function statedPeriodEnd(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const trimmed = value.trim();
  if (trimmed === '') return null;

  const year = /^(\d{4})$/.exec(trimmed);
  if (year) return new Date(Date.UTC(Number(year[1]) + 1, 0, 1));

  const month = /^(\d{4})-(\d{2})$/.exec(trimmed);
  // `Date.UTC` normalises a 13th month into the next January on its own.
  if (month) return new Date(Date.UTC(Number(month[1]), Number(month[2]), 1));

  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  // Through the end of that day, so a fact does not lapse at the stroke of
  // the morning it was said to be true until.
  if (day) return new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]) + 1));

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Start boundary for a canonical year/month/day. Unreadable non-empty text is unknown. */
export function statedPeriodStart(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const trimmed = value.trim();
  const year = /^(\d{4})$/.exec(trimmed);
  if (year) return new Date(Date.UTC(Number(year[1]), 0, 1));
  const month = /^(\d{4})-(\d{2})$/.exec(trimmed);
  if (month) {
    const valueDate = new Date(Date.UTC(Number(month[1]), Number(month[2]) - 1, 1));
    return valueDate.getUTCMonth() === Number(month[2]) - 1 ? valueDate : null;
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (day) {
    const valueDate = new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])));
    return valueDate.getUTCFullYear() === Number(day[1]) &&
      valueDate.getUTCMonth() === Number(day[2]) - 1 &&
      valueDate.getUTCDate() === Number(day[3])
      ? valueDate
      : null;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Strict current-time eligibility for graph context; ambiguous stated bounds abstain. */
export function isCurrentInterval(
  validFrom: string | Date | null | undefined,
  validUntil: string | Date | null | undefined,
  now: Date,
): boolean {
  const from = statedPeriodStart(validFrom);
  if (validFrom != null && validFrom !== '' && (!from || from > now)) return false;
  const until = statedPeriodEnd(validUntil);
  if (validUntil != null && validUntil !== '' && (!until || until <= now)) return false;
  return true;
}

/**
 * Whether a row still speaks for the present.
 *
 * Unparseable wording counts as current. A date this cannot read is a gap in
 * what the assistant understands, not evidence that something has ended, and
 * the safe direction for an unreadable value is to keep showing the fact
 * rather than to quietly retire it on a guess.
 */
export function isCurrentAt(
  validUntil: string | Date | null | undefined,
  now: Date,
  validFrom?: Date | null,
): boolean {
  if (validFrom && validFrom.getTime() > now.getTime()) return false;
  const end = statedPeriodEnd(validUntil);
  return end === null || end.getTime() > now.getTime();
}

/**
 * How a fact's validity reads on the owner card.
 *
 * The card previously rendered a span only when `validFrom` was set, so a fact
 * that recorded only an END — the exact rows this is about — appeared with no
 * marking at all and read as current. Every shape now says plainly which side
 * of now it sits on.
 */
export function validitySuffix(
  fact: { validFrom: Date | null; validUntil: Date | null },
  now: Date,
): string {
  const from = fact.validFrom ? fact.validFrom.toISOString().slice(0, 10) : null;
  const until = fact.validUntil ? fact.validUntil.toISOString().slice(0, 10) : null;

  if (fact.validFrom && fact.validFrom > now)
    return from ? ` (future: from ${from}${until ? `, until ${until}` : ''})` : '';
  if (!isCurrentAt(fact.validUntil, now)) {
    return from ? ` (past: ${from}–${until})` : ` (past: until ${until})`;
  }
  if (from && until) return ` (since ${from}, until ${until})`;
  if (from) return ` (since ${from})`;
  if (until) return ` (until ${until})`;
  return '';
}
