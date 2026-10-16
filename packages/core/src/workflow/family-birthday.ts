import { z } from 'zod';

const relations: Record<string, string[]> = {
  sibling: ['sibling', 'brother', 'sister'],
  brother: ['brother'],
  sister: ['sister'],
  parent: ['parent', 'mother', 'father', 'mom', 'mum', 'dad'],
  mother: ['mother', 'mom', 'mum'],
  mom: ['mother', 'mom', 'mum'],
  mum: ['mother', 'mom', 'mum'],
  father: ['father', 'dad'],
  dad: ['father', 'dad'],
  child: ['child', 'son', 'daughter'],
  son: ['son'],
  daughter: ['daughter'],
  spouse: ['spouse', 'wife', 'husband', 'partner'],
  wife: ['wife'],
  husband: ['husband'],
  partner: ['partner'],
  grandparent: ['grandparent', 'grandmother', 'grandfather', 'grandma', 'grandpa'],
  grandmother: ['grandmother', 'grandma'],
  grandma: ['grandmother', 'grandma'],
  grandfather: ['grandfather', 'grandpa'],
  grandpa: ['grandfather', 'grandpa'],
  aunt: ['aunt'],
  uncle: ['uncle'],
  cousin: ['cousin'],
};
const relationPattern = Object.keys(relations).join('|');
const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface FamilyBirthdayRequest {
  relation: string;
  allowedRelations: string[];
  plural: boolean;
  multipleRelations?: boolean;
  person?: string;
}

/** A fact lookup, not an upcoming calendar, reminder, fictional or rewrite task. */
export function requestedFamilyBirthdays(text: string): FamilyBirthdayRequest | undefined {
  const question = text.split(/[?!.\n]/u)[0] ?? text;
  if (
    text.length > 2000 ||
    /^\s*(?:>|["“‘])/u.test(text) ||
    /\b(?:fictional|hypothetical|pretend|imagine|scenario|translate|rewrite|rephrase|quote|upcoming|next|today|tomorrow|week|month|remind|notify)\b/iu.test(
      text,
    ) ||
    /\b(?:gift|present|party|celebration|menu|cake|wish|card|message|invite|plan|book|order)\b/iu.test(
      question,
    ) ||
    !/\b(?:when\s+(?:is|are|was|were)|what(?:['’]s|\s+is|\s+are)|(?:what|which)\s+dates?|show|list|tell\s+me|check|find|read)\b/iu.test(
      text,
    ) ||
    !/\b(?:birthdays?|born|dates? of birth)\b/iu.test(text)
  )
    return undefined;
  const match = new RegExp(`\\b(?:my|our)\\s+(${relationPattern})(s|ren)?\\b`, 'iu').exec(text);
  if (!match?.[1]) return undefined;
  const relation = match[1].toLowerCase();
  const requestedRelations = new Set([
    relation,
    ...[
      ...question.matchAll(
        new RegExp(`\\b(?:and|or)\\s+(?:(?:my|our)\\s+)?(${relationPattern})(?:s|ren)?\\b`, 'giu'),
      ),
    ].flatMap((item) => (item[1] ? [item[1].toLowerCase()] : [])),
  ]);
  const suffix = text.slice((match.index ?? 0) + match[0].length);
  const named =
    /^\s+(?:(?:named|called)\s+)?([\p{Lu}][\p{L}\p{M}'’–-]*(?:\s+[\p{Lu}][\p{L}\p{M}'’–-]*){0,4})(?=['’]s?\s+(?:birthday|date of birth)|\s+(?:born|birthday)|[?]|$)/u.exec(
      suffix,
    );
  return {
    relation,
    allowedRelations: [...new Set([...requestedRelations].flatMap((key) => relations[key] ?? []))],
    plural: Boolean(match[2]) || requestedRelations.size > 1,
    ...(requestedRelations.size > 1
      ? { multipleRelations: true }
      : named?.[1]
        ? { person: named[1] }
        : {}),
  };
}

export const FamilyBirthdayFactSchema = z.object({
  person: z.string().min(1).max(100),
  relationship: z.string().min(1).max(30),
  birthday: z.string().min(1).max(50).nullable(),
  relationshipSelection: z.number().int().min(0).max(7),
  birthdaySelection: z.number().int().min(0).max(7).nullable(),
});
export type FamilyBirthdayFact = z.infer<typeof FamilyBirthdayFactSchema>;
export interface FamilyBirthdaySource {
  key: string;
  body: string;
  trusted: boolean;
  subjectId?: string;
  url: string;
}
interface Quote {
  sourceKey: string;
  quote: string;
}
const monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
function birthdayDate(raw: string) {
  let month = 0;
  let day = 0;
  let year: number | undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(raw);
  const named = /^(\p{L}+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/u.exec(raw);
  const reversed = /^(\d{1,2})(?:st|nd|rd|th)?\s+(\p{L}+)(?:\s+(\d{4}))?$/u.exec(raw);
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (named || reversed) {
    const name = named?.[1] ?? reversed?.[2] ?? '';
    month = monthNames.findIndex((value) => value.toLowerCase() === name.toLowerCase()) + 1;
    day = Number(named?.[2] ?? reversed?.[1]);
    const value = named?.[3] ?? reversed?.[3];
    if (value) year = Number(value);
  }
  const date = new Date(Date.UTC(year ?? 2000, month - 1, day));
  if (
    !month ||
    !day ||
    (year !== undefined && (year < 1000 || year > 9999)) ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined;
  return { month, day, year, label: `${monthNames[month - 1]} ${day}${year ? `, ${year}` : ''}` };
}

/** A source quote must be a complete declarative source sentence, not embedded speech/instructions. */
function assertion(source: Pick<FamilyBirthdaySource, 'body' | 'trusted'>, quote: string) {
  if (
    !source.trusted ||
    !source.body.includes(quote) ||
    /[?"“”]|\b(?:not|never|isn't|isn’t|wasn't|wasn’t|maybe|perhaps|approximately|around|unsure|unknown|think|believe|guess|if|fictional|hypothetical|pretend|imagine|example|quote[ds]?|said|wrote|system|instructions?|ignore)\b/iu.test(
      source.body,
    )
  )
    return undefined;
  const clean = normalize(quote).replace(/[.!]$/u, '');
  return source.body
    .split(/(?<=[.!?])\s+|[\n;]+/u)
    .some((sentence) => normalize(sentence).replace(/[.!]$/u, '') === clean)
    ? clean
    : undefined;
}
const ownerPossessive = String.raw`(?:my|our|(?:the\s+)?owner['’]s)`;
function relationProof(sentence: string, person: string, relation: string) {
  const who = escapeRegex(person);
  const role = escapeRegex(relation);
  return new RegExp(
    `^${ownerPossessive}\\s+(?:(?:older|younger|half|step)[ -])?${role}\\s+(?:named\\s+)?${who}(?=$|['’,.!]|\\s+(?:was\\s+born|born|has\\s+(?:a\\s+)?birthday|is\\b))|^${who}\\s+is\\s+${ownerPossessive}\\s+(?:(?:older|younger|half|step)[ -])?${role}\\b`,
    'iu',
  ).test(sentence);
}

/**
 * Only identity-bound, whole-sentence relationship facts may scope an occasion
 * read. A contact's display name or address-book relationship label is not
 * identity proof.
 */
export function familyBirthdayContactIds(
  request: FamilyBirthdayRequest,
  sources: Array<{ body: string; trusted: boolean; subjectId?: string }>,
): string[] {
  const role = request.allowedRelations.map(escapeRegex).join('|');
  if (!role) return [];
  const name = String.raw`([\p{Lu}][\p{L}\p{M}'’–-]*(?:\s+[\p{Lu}][\p{L}\p{M}'’–-]*){0,4})`;
  const modifiers = '(?:(?:older|younger|half|step)[ -])?';
  const before = new RegExp(
    `^${ownerPossessive}\\s+${modifiers}(${role})\\s+(?:named\\s+)?${name}(?=$|['’]s?\\s+(?:was born|born|has\\s+(?:a\\s+)?birthday|is\\b)|[',.!])`,
    'iu',
  );
  const after = new RegExp(
    `^${name}\\s+is\\s+${ownerPossessive}\\s+${modifiers}(${role})\\b`,
    'iu',
  );
  const ids = new Set<string>();
  for (const source of sources) {
    if (!source.trusted || !source.subjectId || source.body.length > 4000) continue;
    for (const raw of source.body.split(/(?<=[.!?])\s+|[\n;]+/u)) {
      const sentence = assertion(source, raw);
      if (!sentence) continue;
      const match = before.exec(sentence);
      const reverse = match ? undefined : after.exec(sentence);
      const relation = (match?.[1] ?? reverse?.[2] ?? '').toLowerCase();
      const person = match?.[2] ?? reverse?.[1] ?? '';
      if (
        relation &&
        request.allowedRelations.includes(relation) &&
        (!request.person || normalize(request.person) === normalize(person)) &&
        relationProof(sentence, person, relation)
      )
        ids.add(source.subjectId);
    }
  }
  return [...ids].sort();
}
function dateProof(sentence: string, person: string, raw: string) {
  if (!birthdayDate(raw)) return false;
  return new RegExp(
    `^(?:${ownerPossessive}\\s+(?:(?:older|younger|half|step)[ -])?(?:${relationPattern})\\s+)?${escapeRegex(person)}(?:['’]s\\s+(?:birthday|date of birth)\\s+(?:is\\s+|falls\\s+on\\s+|:\\s*)?|\\s+(?:has\\s+(?:a\\s+)?birthday\\s+on\\s+|(?:was\\s+)?born\\s+(?:on\\s+)?))${escapeRegex(raw)}(?=$|[.!])`,
    'iu',
  ).test(sentence);
}
const safe = (value: string) => value.replace(/[[\]<>*_`|\\]/gu, '').replace(/[\r\n]+/gu, ' ');

/** All model fields are proposals; quotes, speaker, identity and dates are rechecked here. */
export function familyBirthdayProjection(input: {
  request: FamilyBirthdayRequest;
  sourceScope?: { conversationHistory: boolean; savedMemory: boolean };
  selections: Quote[];
  facts?: FamilyBirthdayFact[];
  sources: FamilyBirthdaySource[];
  incompleteCoverage: boolean;
}) {
  const sources = new Map(input.sources.map((source) => [source.key, source]));
  const gaps = new Set<string>();
  const rows: Array<{
    person: string;
    relation: string;
    date?: ReturnType<typeof birthdayDate>;
    identity: string;
    sourceKeys: string[];
    unresolvedCorrection?: boolean;
    unresolvedIdentity?: boolean;
  }> = [];
  const proof = (index: number | null) => {
    const quote = index === null ? undefined : input.selections[index];
    if (!quote?.quote || quote.quote.length > 800) return undefined;
    const source = quote ? sources.get(quote.sourceKey) : undefined;
    const sentence = source && quote ? assertion(source, quote.quote) : undefined;
    return source && sentence ? { source, sentence } : undefined;
  };
  for (const proposed of input.facts ?? []) {
    const parsed = FamilyBirthdayFactSchema.safeParse(proposed);
    if (!parsed.success) {
      gaps.add('Some proposed birthday details could not be verified.');
      continue;
    }
    const fact = parsed.data;
    const relation = proof(fact.relationshipSelection);
    if (
      !input.request.allowedRelations.includes(fact.relationship.toLowerCase()) ||
      (input.request.person && normalize(input.request.person) !== normalize(fact.person)) ||
      !relation ||
      !relationProof(relation.sentence, fact.person, fact.relationship)
    ) {
      gaps.add('Some proposed family relationships could not be verified.');
      continue;
    }
    const birthday = proof(fact.birthdaySelection);
    const sameIdentity =
      birthday &&
      (birthday.source.key === relation.source.key ||
        Boolean(
          relation.source.subjectId && relation.source.subjectId === birthday.source.subjectId,
        ));
    const date =
      fact.birthday &&
      birthday &&
      sameIdentity &&
      dateProof(birthday.sentence, fact.person, fact.birthday)
        ? birthdayDate(fact.birthday)
        : undefined;
    if (!date) gaps.add('Some family birthdays remain unverified or ambiguous.');
    rows.push({
      person: fact.person,
      relation: fact.relationship,
      date,
      identity: relation.source.subjectId ?? relation.source.key,
      sourceKeys: [relation.source.key, ...(date && birthday ? [birthday.source.key] : [])],
    });
  }
  // A selected or returned family record cannot be silently discarded by the model.
  const role = input.request.allowedRelations.map(escapeRegex).join('|');
  const relevant = new RegExp(
    `${ownerPossessive}\\s+(?:(?:older|younger|half|step)[ -])?(?:${role})\\b`,
    'iu',
  );
  const correctionLinks = new Set<string>();
  for (const source of input.sources) {
    if (
      source.trusted &&
      relevant.test(source.body) &&
      !rows.some((row) => row.sourceKeys.includes(source.key))
    )
      gaps.add('A returned family record still needs verification.');
    if (
      source.trusted &&
      source.body
        .split(/(?<=[.!?])\s+|[\n;]+/u)
        .some(
          (sentence) =>
            /\b(?:correct(?:ion|ed|ing)?|actually|instead|wrong|mistaken|no longer|not|never|isn't|isn’t|wasn't|wasn’t)\b/iu.test(
              sentence,
            ) &&
            new RegExp(
              `\\b(?:birthday|born|birth|${relationPattern})|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{1,2}\\b`,
              'iu',
            ).test(sentence),
        ) &&
      (relevant.test(source.body) ||
        rows.some(
          (row) =>
            source.subjectId === row.identity ||
            new RegExp(`(?:^|\\s)${escapeRegex(row.person)}(?=['’]|\\s|$)`, 'iu').test(source.body),
        ))
    ) {
      gaps.add(
        'An owner correction still needs reconciliation; no current birthday is selected from that conflict.',
      );
      correctionLinks.add(`[Correction source](${source.url})`);
      for (const row of rows) {
        if (
          source.subjectId === row.identity ||
          source.key === row.identity ||
          new RegExp(`(?:^|\\s)${escapeRegex(row.person)}(?=['’]|\\s|$)`, 'iu').test(source.body)
        ) {
          row.unresolvedCorrection = true;
          row.sourceKeys.push(source.key);
        }
      }
    }
  }
  // Independently retain a contradicting birthday even if the selector omitted it.
  for (const row of [...rows]) {
    for (const source of input.sources) {
      for (const quote of source.body.split(/(?<=[.!?])\s+|[\n;]+/u)) {
        const sentence = assertion(source, quote);
        const raw =
          sentence &&
          /(\d{4}-\d{2}-\d{2}|\p{L}+\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}(?:st|nd|rd|th)?\s+\p{L}+(?:\s+\d{4})?)$/u.exec(
            sentence,
          )?.[1];
        if (!sentence || !raw || !dateProof(sentence, row.person, raw)) continue;
        const date = birthdayDate(raw);
        if (!date) continue;
        if (source.key !== row.identity && source.subjectId !== row.identity) {
          gaps.add(
            'Another birthday record names the same person, but its identity could not be linked safely.',
          );
          continue;
        }
        if (
          rows.some(
            (prior) =>
              prior.identity === row.identity &&
              prior.person === row.person &&
              prior.date?.month === date.month &&
              prior.date?.day === date.day &&
              prior.date?.year === date.year,
          )
        )
          continue;
        rows.push({ ...row, date, sourceKeys: [...row.sourceKeys, source.key] });
      }
    }
  }
  const byPerson = new Map<string, typeof rows>();
  const identityNames = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.sourceKeys.some((key) => sources.get(key)?.subjectId === row.identity)) continue;
    const names = identityNames.get(row.identity) ?? new Set<string>();
    names.add(normalize(row.person).toLowerCase());
    identityNames.set(row.identity, names);
  }
  for (const row of rows) {
    if ((identityNames.get(row.identity)?.size ?? 0) > 1) row.unresolvedIdentity = true;
    const key = normalize(row.person).toLowerCase();
    byPerson.set(key, [...(byPerson.get(key) ?? []), row]);
  }
  const lines: string[] = [];
  let verified = 0;
  for (const grouped of byPerson.values()) {
    const first = grouped[0];
    if (!first) continue;
    const identityAmbiguous =
      new Set(grouped.map((row) => row.identity)).size > 1 ||
      grouped.some((row) => row.unresolvedIdentity);
    const dates = [
      ...new Map(
        grouped
          .filter((row) => row.date)
          .map((row) => [`${row.date?.month}/${row.date?.day}/${row.date?.year ?? ''}`, row.date]),
      ).values(),
    ];
    const conflict =
      new Set(dates.map((date) => `${date?.month}/${date?.day}`)).size > 1 ||
      new Set(dates.flatMap((date) => (date?.year ? [date.year] : []))).size > 1;
    if (conflict || identityAmbiguous)
      gaps.add('Conflicting dates or person identities remain unresolved.');
    const links = [...new Set(grouped.flatMap((row) => row.sourceKeys))]
      .map((key) => {
        const source = sources.get(key);
        return source ? `[Source](${source.url})` : '';
      })
      .filter(Boolean)
      .join(', ');
    const unresolvedCorrection = grouped.some((row) => row.unresolvedCorrection);
    if (!conflict && !identityAmbiguous && !unresolvedCorrection && dates.length > 0) verified++;
    lines.push(
      `- **${safe(first.person)}** (${unresolvedCorrection ? 'relationship/date unresolved' : safe(first.relation)}): ${identityAmbiguous ? 'person identity unresolved' : conflict ? `conflicting dates: ${dates.map((date) => date?.label).join(' / ')}` : unresolvedCorrection ? 'birthday unresolved — owner correction needs reconciliation' : (dates.find((date) => date?.year)?.label ?? dates[0]?.label ?? 'birthday not confirmed')}. ${links}`,
    );
  }
  if (input.incompleteCoverage)
    gaps.add('Some requested records could not be searched or assessed completely.');
  if (!rows.length)
    lines.push(
      'I couldn’t confirm the family relationships and birthdays from the records checked.',
    );
  // A plural question needs a supported denominator, not a guessed family roster.
  if (input.request.plural) {
    const counts = new Set<number>();
    const countWords = [
      'zero',
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'ten',
    ];
    for (const source of input.sources) {
      if (!source.trusted) continue;
      for (const quote of source.body.split(/(?<=[.!?])\s+|[\n;]+/u)) {
        const sentence = assertion(source, quote);
        const match =
          sentence &&
          new RegExp(
            `^I have (\\d{1,2}|${countWords.join('|')}) ${escapeRegex(input.request.relation)}(?:s|ren)$`,
            'iu',
          ).exec(sentence);
        if (match?.[1])
          counts.add(
            /^\d+$/u.test(match[1]) ? Number(match[1]) : countWords.indexOf(match[1].toLowerCase()),
          );
      }
    }
    if (input.request.multipleRelations || counts.size !== 1 || !counts.has(byPerson.size))
      gaps.add('I could not establish that these records cover everyone you mean.');
  }
  const blocked = gaps.size > 0 || !verified;
  const historyChecked = input.sourceScope?.conversationHistory !== false;
  const memoriesChecked = input.sourceScope?.savedMemory !== false;
  const coverageDescription =
    historyChecked && memoriesChecked
      ? 'checked bounded chat history and saved memories'
      : memoriesChecked
        ? 'checked saved memories only'
        : historyChecked
          ? 'checked chat history only'
          : 'checked no personal sources';
  const question = !rows.length
    ? 'Which family members should I look for?'
    : blocked
      ? 'Can you confirm the missing names or dates, and whether this covers everyone you mean?'
      : undefined;
  return {
    text: [
      ...(verified ? ['Confirmed in the returned records:'] : []),
      ...lines,
      ...correctionLinks,
      `Coverage: ${coverageDescription}; no mail, calendar or accounts were changed.`,
      ...[...gaps].map((gap) => `- ${gap}`),
      ...(question ? [question] : []),
    ].join('\n\n'),
    blocked,
  };
}
