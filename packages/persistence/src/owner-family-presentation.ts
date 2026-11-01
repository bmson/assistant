import { predicateSpec } from './predicate-vocabulary.js';

/**
 * A human-facing relationship description. Graph predicates remain canonical
 * identifiers for extraction and recall; no UI should make an owner decode
 * their direction or snake_case spelling.
 */
export interface RelationshipPresentation {
  /** A complete fact, independent of which endpoint is currently open. */
  sentence: string;
  /** Compact label for cards, filters, and map legends. */
  label: string;
  /** Direction-free screen-reader description. */
  accessibleLabel: string;
}

export function readableKnowledgeLabel(value: string): string {
  return value.replaceAll('_', ' ').replace(/\s+/g, ' ').trim();
}

function possessive(label: string): string {
  return label.endsWith('s') ? `${label}'` : `${label}'s`;
}

function titleCase(value: string): string {
  return value ? value.charAt(0).toLocaleUpperCase() + value.slice(1) : value;
}

type OwnerFamilyGrammar =
  | { kind: 'directed'; role: string }
  | { kind: 'symmetric'; pluralRole: string };

/**
 * Role wording is explicit so owner labels are never run through the generic
 * graph label cleanup or used as input to tense rewriting.
 */
const OWNER_FAMILY_GRAMMAR: Readonly<Record<string, OwnerFamilyGrammar>> = {
  father_of: { kind: 'directed', role: 'father' },
  mother_of: { kind: 'directed', role: 'mother' },
  parent_of: { kind: 'directed', role: 'parent' },
  child_of: { kind: 'directed', role: 'child' },
  son_of: { kind: 'directed', role: 'son' },
  daughter_of: { kind: 'directed', role: 'daughter' },
  brother_of: { kind: 'directed', role: 'brother' },
  sister_of: { kind: 'directed', role: 'sister' },
  sibling_of: { kind: 'symmetric', pluralRole: 'siblings' },
  grandfather_of: { kind: 'directed', role: 'grandfather' },
  grandmother_of: { kind: 'directed', role: 'grandmother' },
  grandparent_of: { kind: 'directed', role: 'grandparent' },
  grandchild_of: { kind: 'directed', role: 'grandchild' },
  grandson_of: { kind: 'directed', role: 'grandson' },
  granddaughter_of: { kind: 'directed', role: 'granddaughter' },
  spouse_of: { kind: 'symmetric', pluralRole: 'spouses' },
  former_spouse_of: { kind: 'symmetric', pluralRole: 'spouses' },
  partner_of: { kind: 'symmetric', pluralRole: 'partners' },
  uncle_of: { kind: 'directed', role: 'uncle' },
  aunt_of: { kind: 'directed', role: 'aunt' },
  nephew_of: { kind: 'directed', role: 'nephew' },
  niece_of: { kind: 'directed', role: 'niece' },
  cousin_of: { kind: 'symmetric', pluralRole: 'cousins' },
};

function ownerFamilyClause(
  subject: string,
  object: string,
  grammar: OwnerFamilyGrammar,
  timing: OwnerFamilyMeaning['timing'],
): string {
  if (grammar.kind === 'symmetric') {
    const copula = timing === 'past' ? 'were' : 'are';
    return `${subject} and ${object} ${copula} ${grammar.pluralRole}`;
  }
  const copula = timing === 'past' ? 'was' : 'is';
  return `${subject} ${copula} ${possessive(object)} ${grammar.role}`;
}

/**
 * Translates a stored directed edge into a readable fact. The small explicit
 * grammar table handles relationships whose natural wording cannot be formed
 * by merely replacing underscores (for example, daughter_of and spouse_of).
 */
export function presentKnowledgeGraphRelation(input: {
  subjectLabel: string;
  predicate: string;
  objectLabel: string;
}): RelationshipPresentation {
  const subject = readableKnowledgeLabel(input.subjectLabel);
  const object = readableKnowledgeLabel(input.objectLabel);
  const predicate = readableKnowledgeLabel(input.predicate).toLocaleLowerCase();
  const spec = predicateSpec(input.predicate);
  const role = predicate.replace(/\s+of$/, '');

  let sentence: string;
  if (spec?.symmetric) {
    const plural = new Map<string, string>([
      ['spouse of', 'spouses'],
      ['partner of', 'partners'],
      ['sibling of', 'siblings'],
      ['cousin of', 'cousins'],
      ['met', 'connected'],
    ]).get(predicate);
    sentence = plural
      ? `${subject} and ${object} are ${plural}.`
      : `${subject} is related to ${object}.`;
  } else if (predicate.endsWith(' of')) {
    sentence = `${subject} is ${possessive(object)} ${role}.`;
  } else if (predicate === 'employs') {
    sentence = `${subject} employs ${object}.`;
  } else if (predicate === 'attended by') {
    sentence = `${object} attended ${subject}.`;
  } else {
    sentence = `${subject} ${predicate} ${object}.`;
  }

  return {
    sentence,
    label: titleCase(role || predicate),
    accessibleLabel: sentence,
  };
}

export interface OwnerFamilyMeaning {
  timing: 'unspecified' | 'present' | 'past';
  validity: { validFrom: string | null; validUntil: string | null };
}

/** Strict civil-day validation precedes the existing UTC period converters. */
export function validOwnerFamilyMeaning(value: OwnerFamilyMeaning): boolean {
  const day = (text: string | null) => {
    if (text === null) return true;
    const match = /^(1\d{3}|2\d{3})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) return false;
    const year = Number(match[1]),
      month = Number(match[2]),
      date = Number(match[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return month >= 1 && month <= 12 && date >= 1 && date <= (days[month - 1] ?? 0);
  };
  const { validFrom, validUntil } = value.validity;
  return (
    ['unspecified', 'present', 'past'].includes(value.timing) &&
    day(validFrom) &&
    day(validUntil) &&
    (validFrom === null || validUntil === null || validFrom <= validUntil)
  );
}

/** Shared exact source/preview wording: dates never infer relationship timing. */
export function presentOwnerFamilyFact(
  input: {
    subjectLabel: string;
    predicate: string;
    objectLabel: string;
    note?: string;
  } & OwnerFamilyMeaning,
): string {
  if (!validOwnerFamilyMeaning(input)) throw new Error('Unsupported family validity');
  const spec = predicateSpec(input.predicate);
  if (
    !spec ||
    spec.group !== 'family' ||
    !spec.subjectKinds.includes('person') ||
    !spec.objectKinds.includes('person')
  )
    throw new Error('Unsupported family predicate');
  if (input.predicate.startsWith('former_') && input.timing !== 'past')
    throw new Error('Former relationships must be recorded as past');
  const grammar = OWNER_FAMILY_GRAMMAR[input.predicate];
  if (!grammar) throw new Error('Unsupported family predicate');
  const clause = ownerFamilyClause(input.subjectLabel, input.objectLabel, grammar, input.timing);
  const statement =
    input.timing === 'unspecified'
      ? `The saved relationship identifies ${
          grammar.kind === 'symmetric'
            ? `${input.subjectLabel} and ${input.objectLabel} as ${grammar.pluralRole}`
            : `${input.subjectLabel} as ${possessive(input.objectLabel)} ${grammar.role}`
        }.`
      : `${clause}.`;
  const timing =
    input.timing === 'unspecified'
      ? 'Timing recorded: not recorded.'
      : `Timing recorded: ${input.timing}.`;
  const { validFrom, validUntil } = input.validity;
  const dates =
    validFrom && validUntil
      ? `From ${validFrom} through ${validUntil} (inclusive).`
      : validFrom
        ? `From ${validFrom}; end not recorded.`
        : validUntil
          ? `Start not recorded; through ${validUntil} (inclusive).`
          : 'Start and end not recorded.';
  const note = input.note?.replace(/\s+/g, ' ').trim();
  return `Recorded statement: ${statement} ${timing} Recorded dates: ${dates}${note ? ` Owner note: ${note}` : ''}`;
}
