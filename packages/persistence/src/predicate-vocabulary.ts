/**
 * The typed predicate vocabulary for the knowledge graph.
 *
 * One registry is the source of truth for three consumers that used to drift:
 * the extraction prompt (which predicates the model should name), the manual
 * add-relationship form (which suggestions it offers for a kind pair), and
 * review/traversal code that needs to know a predicate's direction, inverse,
 * and whether a time span is natural on it.
 *
 * This module is deliberately data-only: no database, no config, no imports —
 * knowledge-graph.ts builds on it, so it must never import back.
 */

export const GRAPH_ENTITY_KINDS = [
  'person',
  'organization',
  'project',
  'place',
  'event',
  'date',
  'topic',
] as const;
export type GraphEntityKind = (typeof GRAPH_ENTITY_KINDS)[number];

export type PredicateGroup = 'family' | 'biography' | 'work and education' | 'events';

export interface PredicateSpec {
  id: string;
  group: PredicateGroup;
  /** Kind pairs the predicate is meaningful for. */
  subjectKinds: readonly GraphEntityKind[];
  objectKinds: readonly GraphEntityKind[];
  /** Inverse wording for display and traversal; symmetric predicates need none. */
  inverse?: string;
  symmetric?: boolean;
  /** A start/end span (valid_from/valid_until) is natural on this predicate. */
  temporal?: boolean;
}

const PERSON = ['person'] as const;
const PERSON_TO_PERSON = { subjectKinds: PERSON, objectKinds: PERSON } as const;

export const PREDICATE_VOCABULARY: readonly PredicateSpec[] = [
  // ── Family ────────────────────────────────────────────────────────────────
  { id: 'father_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'child_of' },
  { id: 'mother_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'child_of' },
  { id: 'parent_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'child_of' },
  { id: 'child_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'parent_of' },
  { id: 'son_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'parent_of' },
  { id: 'daughter_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'parent_of' },
  { id: 'brother_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'sibling_of' },
  { id: 'sister_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'sibling_of' },
  { id: 'sibling_of', group: 'family', ...PERSON_TO_PERSON, symmetric: true },
  { id: 'grandfather_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'grandchild_of' },
  { id: 'grandmother_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'grandchild_of' },
  { id: 'grandparent_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'grandchild_of' },
  { id: 'grandchild_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'grandparent_of' },
  { id: 'grandson_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'grandparent_of' },
  { id: 'granddaughter_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'grandparent_of' },
  { id: 'spouse_of', group: 'family', ...PERSON_TO_PERSON, symmetric: true, temporal: true },
  {
    id: 'former_spouse_of',
    group: 'family',
    ...PERSON_TO_PERSON,
    symmetric: true,
    temporal: true,
  },
  { id: 'partner_of', group: 'family', ...PERSON_TO_PERSON, symmetric: true, temporal: true },
  { id: 'uncle_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'nephew_of' },
  { id: 'aunt_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'niece_of' },
  { id: 'nephew_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'uncle_of' },
  { id: 'niece_of', group: 'family', ...PERSON_TO_PERSON, inverse: 'aunt_of' },
  { id: 'cousin_of', group: 'family', ...PERSON_TO_PERSON, symmetric: true },

  // ── Biography ─────────────────────────────────────────────────────────────
  { id: 'born_on', group: 'biography', subjectKinds: PERSON, objectKinds: ['date'] },
  { id: 'born_in', group: 'biography', subjectKinds: PERSON, objectKinds: ['place'] },
  { id: 'grew_up_in', group: 'biography', subjectKinds: PERSON, objectKinds: ['place'] },
  {
    id: 'lives_in',
    group: 'biography',
    subjectKinds: PERSON,
    objectKinds: ['place'],
    temporal: true,
  },
  {
    id: 'met_at',
    group: 'biography',
    subjectKinds: PERSON,
    objectKinds: ['place', 'event'],
    symmetric: true,
  },
  { id: 'met_during', group: 'biography', subjectKinds: PERSON, objectKinds: ['event'] },
  // "Anna met Bjorn" itself — the where/when is met_at / met_during above.
  { id: 'met', group: 'biography', ...PERSON_TO_PERSON, symmetric: true },
  { id: 'engaged_on', group: 'biography', subjectKinds: PERSON, objectKinds: ['date'] },
  {
    id: 'married_on',
    group: 'biography',
    subjectKinds: PERSON,
    objectKinds: ['date'],
  },
  { id: 'divorced_on', group: 'biography', subjectKinds: PERSON, objectKinds: ['date'] },
  { id: 'died_on', group: 'biography', subjectKinds: PERSON, objectKinds: ['date'] },
  // Where a thing rather than a person sits. The gap detector has expected
  // this predicate all along ("where {name} is based") while the registry did
  // not define it, so extraction was never told to produce it and the form
  // never suggested it — the assistant could ask the question and then had no
  // vocabulary to record the answer in. `registryCoversExpectations` in the
  // gap-detector tests now holds that pairing together.
  {
    id: 'based_in',
    group: 'biography',
    subjectKinds: ['organization', 'project', 'event'],
    objectKinds: ['place'],
    temporal: true,
  },

  // ── Work and education ────────────────────────────────────────────────────
  {
    id: 'works_at',
    group: 'work and education',
    subjectKinds: PERSON,
    objectKinds: ['organization'],
    inverse: 'employs',
    temporal: true,
  },
  {
    id: 'worked_at',
    group: 'work and education',
    subjectKinds: PERSON,
    objectKinds: ['organization'],
    inverse: 'employed',
    temporal: true,
  },
  {
    id: 'studies_at',
    group: 'work and education',
    subjectKinds: PERSON,
    objectKinds: ['organization'],
    temporal: true,
  },
  {
    id: 'studied_at',
    group: 'work and education',
    subjectKinds: PERSON,
    objectKinds: ['organization'],
    temporal: true,
  },
  {
    id: 'graduated_from',
    group: 'work and education',
    subjectKinds: PERSON,
    objectKinds: ['organization'],
  },
  {
    id: 'interned_at',
    group: 'work and education',
    subjectKinds: PERSON,
    objectKinds: ['organization'],
    temporal: true,
  },
  {
    id: 'employs',
    group: 'work and education',
    subjectKinds: ['organization'],
    objectKinds: PERSON,
    inverse: 'works_at',
    temporal: true,
  },

  // ── Events ────────────────────────────────────────────────────────────────
  { id: 'attends', group: 'events', subjectKinds: PERSON, objectKinds: ['event'] },
  {
    id: 'attended',
    group: 'events',
    subjectKinds: PERSON,
    objectKinds: ['event'],
    inverse: 'attended_by',
  },
  { id: 'attended_by', group: 'events', subjectKinds: ['event'], objectKinds: PERSON },
  {
    id: 'happens_on',
    group: 'events',
    subjectKinds: ['event', 'project'],
    objectKinds: ['date'],
  },
  { id: 'happens_at', group: 'events', subjectKinds: ['event'], objectKinds: ['place'] },
  {
    id: 'starts_on',
    group: 'events',
    subjectKinds: ['event', 'project'],
    objectKinds: ['date'],
  },
  {
    id: 'ends_on',
    group: 'events',
    subjectKinds: ['event', 'project'],
    objectKinds: ['date'],
  },
];

const BY_ID = new Map(PREDICATE_VOCABULARY.map((spec) => [spec.id, spec]));

export function predicateSpec(id: string): PredicateSpec | undefined {
  return BY_ID.get(id);
}

/**
 * Wordings that mean a predicate the registry already has.
 *
 * The extraction prompt lists the vocabulary, but the schema accepts any
 * string, so what actually lands is whatever phrasing the source used. That is
 * the right trade for the evidence contract — a stored predicate has to be the
 * words in the quote, or grounding could not check it — but it means the same
 * relationship arrives as `works_at` from one email and `employed_by` from the
 * next, and a traversal looking for one silently misses the other.
 *
 * Deliberately conservative, and deliberately not clever about tense. The
 * registry treats `works_at` and `worked_at` as different predicates because
 * they are, so nothing here collapses one into the other; a mapping is only
 * listed when the two wordings mean the same thing at the same time.
 */
const PREDICATE_SYNONYMS: Readonly<Record<string, string>> = {
  // Work
  was_employed_by: 'worked_at',
  were_employed_by: 'worked_at',
  formerly_employed_by: 'worked_at',
  previously_employed_by: 'worked_at',
  was_employed_at: 'worked_at',
  were_employed_at: 'worked_at',
  was_married: 'former_spouse_of',
  were_married: 'former_spouse_of',
  employed_by: 'works_at',
  employed_at: 'works_at',
  employee_of: 'works_at',
  works_for: 'works_at',
  working_at: 'works_at',
  employer_of: 'employs',
  // Education
  studies_in: 'studies_at',
  student_at: 'studies_at',
  studied_in: 'studied_at',
  // Residence
  resides_in: 'lives_in',
  lives_at: 'lives_in',
  living_in: 'lives_in',
  // Where an organization sits
  headquartered_in: 'based_in',
  based_at: 'based_in',
  located_in: 'based_in',
  // Family
  was_married_to: 'former_spouse_of',
  were_married_to: 'former_spouse_of',
  formerly_married_to: 'former_spouse_of',
  previously_married_to: 'former_spouse_of',
  married_to: 'spouse_of',
  wife_of: 'spouse_of',
  husband_of: 'spouse_of',
  // Short literal relation spans when a date is the object.
  starts: 'starts_on',
  ends: 'ends_on',
  happens: 'happens_on',
};

/**
 * Prefixes a model tends to keep from the source wording ("is married to",
 * "was born in") that carry no meaning the predicate does not already.
 */
const DROPPED_PREFIXES = ['is_', 'are_', 'has_', 'have_', 'a_', 'an_', 'the_'];

function lookup(candidate: string): string | undefined {
  if (BY_ID.has(candidate)) return candidate;
  const mapped = PREDICATE_SYNONYMS[candidate];
  return mapped && BY_ID.has(mapped) ? mapped : undefined;
}

/**
 * The registry id a stored predicate belongs to, and whether one was found.
 *
 * An unknown wording is returned unchanged rather than dropped: losing a
 * relationship the owner's own words support would be worse than holding one
 * the registry cannot type, and `known: false` lets a caller decide. Nothing
 * here ever invents a predicate the registry does not define.
 */
export function canonicalPredicate(value: string): { id: string; known: boolean } {
  const cleaned = value.trim().toLocaleLowerCase().replace(/\s+/g, '_');
  if (!cleaned) return { id: value, known: false };

  const attempts = [cleaned];
  let stripped = cleaned;
  for (let count = 0; count < 4; count += 1) {
    const prefix = DROPPED_PREFIXES.find((candidate) => stripped.startsWith(candidate));
    if (!prefix) break;
    stripped = stripped.slice(prefix.length);
    attempts.push(stripped);
  }
  // Verb agreement is the other common drift: a source that says "work at"
  // rather than "works at" should not open a second predicate.
  for (const attempt of [...attempts]) {
    const [head, ...rest] = attempt.split('_');
    if (!head) continue;
    attempts.push([`${head}s`, ...rest].join('_'));
    if (head.endsWith('s')) attempts.push([head.slice(0, -1), ...rest].join('_'));
  }

  for (const attempt of attempts) {
    const hit = lookup(attempt);
    if (hit) return { id: hit, known: true };
  }
  return { id: cleaned, known: false };
}

/**
 * Every wording that canonicalizes to `id`, including `id` itself.
 *
 * Read paths need this: rows written before canonicalization, or by a path
 * that never ran it, still carry the original wording, so a query that only
 * matches the registry id would miss them.
 */
export function predicateAliases(id: string): string[] {
  const aliases = new Set<string>([id]);
  for (const [wording, target] of Object.entries(PREDICATE_SYNONYMS)) {
    if (target === id) aliases.add(wording);
  }
  return [...aliases];
}

/** Suggestions for one kind pair, in registry order. Empty means: type freely. */
export function predicateSuggestionsFor(subjectKind: string, objectKind: string): string[] {
  return PREDICATE_VOCABULARY.filter(
    (spec) =>
      (spec.subjectKinds as readonly string[]).includes(subjectKind) &&
      (spec.objectKinds as readonly string[]).includes(objectKind),
  ).map((spec) => spec.id);
}

/** The vocabulary as prompt lines, one per group: "- family: father_of, mother_of, …" */
export function extractionVocabularyLines(): string[] {
  const groups = new Map<PredicateGroup, string[]>();
  for (const spec of PREDICATE_VOCABULARY) {
    const list = groups.get(spec.group) ?? [];
    list.push(spec.id);
    groups.set(spec.group, list);
  }
  return [...groups.entries()].map(([group, ids]) => `- ${group}: ${ids.join(', ')}`);
}
