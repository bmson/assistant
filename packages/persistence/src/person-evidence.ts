import { normalizeContactAliases } from './contact-names.js';
import type { Records } from './records.js';

export interface PersonEvidenceProposal {
  canonicalName: string;
  quote: string;
}

/** A verified owner statement, retaining only the identity evidence needed at commit. */
export interface GroundedPersonEvidence {
  canonicalName: string;
  identifiers: string[];
  relationship: string;
  /** Required for nightly writes, which recheck the latest user message before applying. */
  sourceMessageId?: string;
}

/** Bind a nightly identity statement to the actual initiating owner chat message. */
export function isDirectOwnerPersonMessage(
  task: Pick<Records['tasks'], 'type' | 'trust' | 'trigger' | 'conversationId'> | undefined,
  message: Pick<Records['messages'], 'id' | 'role' | 'origin' | 'text' | 'conversationId'>,
): boolean {
  if (
    task?.type !== 'chat_turn' ||
    task.trust !== 'owner' ||
    task.conversationId !== message.conversationId ||
    message.role !== 'user' ||
    message.origin !== 'owner'
  )
    return false;
  const trigger = task.trigger as {
    source?: unknown;
    payload?: {
      triggerMessageId?: unknown;
      text?: unknown;
      taintedOrigin?: unknown;
      quotesExternalContent?: unknown;
    };
  } | null;
  return (
    trigger?.source === 'chat' &&
    trigger.payload?.triggerMessageId === message.id &&
    trigger.payload?.text === message.text &&
    trigger.payload?.taintedOrigin !== true &&
    trigger.payload?.quotesExternalContent !== true
  );
}

const NON_PERSON_SUBJECTS = new Set([
  'ai',
  'ai bot',
  'assistant',
  'bot',
  'the assistant',
  'b bot',
  'someone',
  'somebody',
  'anyone',
  'everyone',
  'nobody',
  'person',
  'people',
  'he',
  'she',
  'they',
  'them',
  'him',
  'her',
  'it',
  'this',
  'that',
  'these',
  'those',
  'unknown',
  'n/a',
  'inventory',
  'warehouse',
  'inventory code',
  'warehouse inventory code',
  'the warehouse',
  'my daughter',
  'my son',
  'my spouse',
  'my wife',
  'my husband',
  'my child',
  'my coworker',
]);
const PERSON_NAME = /^\p{L}[\p{L}\p{M}]*(?:(?:\.? |[.'’\p{Pd}])\p{L}[\p{L}\p{M}]*)*\.?$/u;
const NON_PERSON_NOUN =
  /\b(?:inventory|warehouse|tracking|reference|serial|product|order|account|ticket|room|model) (?:code|number|id|identifier|label)\b/i;
const RELATIONSHIP_NAMES =
  'daughter|son|child|wife|husband|spouse|partner|mother|father|parent|sister|brother|sibling|friend|coworker|colleague';
const EMAIL = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const PHONE = /(?<![\p{L}\p{N}])\+?\d(?:[(). -]*\d){7,14}(?![\p{L}\p{N}])/gu;
const key = (value: string) => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
const escapeRegExp = (value: string) => value.replace(/[.*+?^$${}()|[\]\\]/g, '\\$&');

export function personNameInferredFromSubject(subject: string, content = ''): string | null {
  const name = subject.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 120 || NON_PERSON_SUBJECTS.has(key(name))) return null;
  if (
    !PERSON_NAME.test(name) ||
    NON_PERSON_NOUN.test(name) ||
    /^(?:the|this|that|an?) /i.test(name) ||
    /(?<![\p{L}\p{M}])(?:is|are|was|were)(?![\p{L}\p{M}])/iu.test(name)
  )
    return null;
  const describesSubjectAsNonPerson = new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escapeRegExp(name)}\\s+(?:is|are)\\s+(?:an? |the )?[^.!?;]{0,35}${NON_PERSON_NOUN.source}`,
    'iu',
  );
  return describesSubjectAsNonPerson.test(content) ? null : name;
}

/** The only quoted literal permitted in direct identity evidence is an inline record label. */
export function unquotePersonRecordLabels(text: string): string {
  return text.replace(/\b(The record )["“]([^"“”\r\n]{1,120})["”](?= belongs to )/gi, '$1$2');
}

function identifiers(value: string): string[] {
  const emails = [...value.matchAll(EMAIL)].map(([email]) => `email:${email.toLowerCase()}`);
  const phones = [...value.replace(EMAIL, '').matchAll(PHONE)].map(
    ([phone]) => `phone:${phone.replace(/\D/g, '')}`,
  );
  return [...new Set([...emails, ...phones])];
}

export function groundPersonEvidence(
  proposal: PersonEvidenceProposal | undefined,
  subject: string,
  ownerMessages: readonly string[],
): GroundedPersonEvidence | null | undefined {
  if (!proposal) return undefined;
  const canonicalName = personNameInferredFromSubject(proposal.canonicalName);
  if (!canonicalName || !subject.trim() || subject.length > 120) return null;
  const statement = (text: string) =>
    text.trim().replace(/^(?:please +)?remember(?: that |: +)/i, '');
  const quote = unquotePersonRecordLabels(statement(proposal.quote));
  if (!quote || quote.length > 500 || /[\r\n]/.test(quote)) return null;
  // Require a full affirmative statement from the admitted source. Accepting a
  // fragment would let the model cut off a qualifier, negation or attribution.
  if (
    !/\.$/.test(quote) ||
    !ownerMessages.some(
      (text) => text.trim() === proposal.quote.trim() || statement(text) === proposal.quote.trim(),
    )
  )
    return null;

  const name = escapeRegExp(subject.trim());
  const canonical = escapeRegExp(canonicalName);
  const relation = `(?:my (${RELATIONSHIP_NAMES}) )?`;
  const addresses = '\\(([^()]+(?:\\([^()]+\\)[^()]*)*)\\)';
  const aliasStatement = new RegExp(
    `^(?:The record ${name} belongs to|${name} is (?:another name|an alias) for) ${relation}${canonical} ${addresses}\\.$`,
    'iu',
  ).exec(quote);
  const relationshipStatement =
    key(subject) === key(canonicalName)
      ? new RegExp(`^${canonical} ${addresses} is my (${RELATIONSHIP_NAMES})\\.$`, 'iu').exec(quote)
      : null;
  const addressList = aliasStatement?.[2] ?? relationshipStatement?.[1];
  if (!addressList) return null;
  const contactIdentifiers = identifiers(addressList);
  const unexpectedText = addressList
    .replace(EMAIL, '')
    .replace(PHONE, '')
    .replace(/[ ,;&]/g, '');
  if (!contactIdentifiers.length || unexpectedText) return null;
  return {
    canonicalName,
    identifiers: contactIdentifiers,
    relationship: normalizeMemoryRelationship(aliasStatement?.[1] ?? relationshipStatement?.[2]),
  };
}

export function normalizeMemoryRelationship(value?: string): string {
  const relationship = key(value ?? '');
  if (relationship === 'co-worker' || relationship === 'colleague') return 'coworker';
  return new RegExp(`^(?:${RELATIONSHIP_NAMES}|self)$`).test(relationship) ? relationship : '';
}

function compatibleRelationship(left: string, right: string): boolean {
  if (!left || !right || left === right) return true;
  return [
    ['child', 'daughter', 'son'],
    ['parent', 'mother', 'father'],
    ['sibling', 'sister', 'brother'],
    ['spouse', 'wife', 'husband'],
  ].some(
    ([generic, ...specific]) =>
      (left === generic && specific.includes(right)) ||
      (right === generic && specific.includes(left)),
  );
}

type Contact = Pick<
  Records['contacts'],
  | 'id'
  | 'name'
  | 'aliases'
  | 'emails'
  | 'phones'
  | 'trust'
  | 'identityAuthority'
  | 'notes'
  | 'relationship'
>;

const storedRelationship = (row: Contact) =>
  normalizeMemoryRelationship(row.relationship) || key(row.relationship ?? '');
const names = (row: Contact) => [row.name, ...(row.aliases ?? [])];
const contactIdentifiers = (row: Contact) => [
  ...(row.emails ?? []).flatMap((email) =>
    identifiers(email).filter((id) => id.startsWith('email:')),
  ),
  ...(row.phones ?? []).flatMap((phone) =>
    identifiers(phone).filter((id) => id.startsWith('phone:')),
  ),
];

// Only a detail expressly attached to this subject can contradict ordinary attribution.
function statedSubjectIdentifier(subject: string, content: string): string | undefined {
  const match = new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escapeRegExp(subject.trim())}(?:['’]s (?:email(?: address)?|phone(?: number)?) is | (?:uses|can be reached at) )(${EMAIL.source}|${PHONE.source})`,
    'iu',
  ).exec(content);
  return match?.[1] ? identifiers(match[1])[0] : undefined;
}

export const MAX_RECONCILED_PERSON_MEMORIES = 25;

export type PersonAttribution =
  | { kind: 'create'; name: string }
  | { kind: 'unattributed' }
  | {
      kind: 'identified';
      contactId: string;
      update?: {
        aliases: string[];
        duplicateId?: string;
        emails: string[];
        phones: string[];
        notes: string;
      };
    };

/** Shared contact policy. Adapters must apply any update under their write transaction. */
export function attributeMemoryPerson(
  rows: readonly Contact[],
  input: {
    subject: string;
    content: string;
    evidence?: GroundedPersonEvidence | null;
    knownContactId?: string | null;
  },
): PersonAttribution {
  const subjectKey = key(input.subject);
  const unattributed = { kind: 'unattributed' } as const;
  if (!subjectKey || input.evidence === null) return unattributed;
  const exact = rows.filter((row) => names(row).some((name) => key(name) === subjectKey));
  if (!input.evidence) {
    const name = personNameInferredFromSubject(input.subject, input.content);
    if (!name) return unattributed;
    if (input.knownContactId && (exact.length !== 1 || exact[0]?.id !== input.knownContactId))
      return unattributed;
    if (subjectKey === 'owner') {
      const [owner, second] = rows.filter((row) => row.trust === 'owner');
      return owner && !second ? { kind: 'identified', contactId: owner.id } : unattributed;
    }
    const [matched, second] = exact;
    if (second) return unattributed;
    const prefixMatches = matched
      ? []
      : rows.filter((row) =>
          names(row).some((variant) => {
            const candidate = key(variant);
            return (
              Math.min(subjectKey.length, candidate.length) >= 3 &&
              (candidate.startsWith(`${subjectKey} `) || subjectKey.startsWith(`${candidate} `))
            );
          }),
        );
    if (prefixMatches.length > 1) return unattributed;
    const person = matched ?? prefixMatches[0];
    if (!person) return { kind: 'create', name };
    const statedId = statedSubjectIdentifier(input.subject, input.content);
    if (statedId) {
      const saved = contactIdentifiers(person);
      const channel = statedId.split(':')[0];
      if (
        (saved.some((id) => id.startsWith(`${channel}:`)) && !saved.includes(statedId)) ||
        rows.some((row) => row.id !== person.id && contactIdentifiers(row).includes(statedId))
      )
        return unattributed;
    }
    return { kind: 'identified', contactId: person.id };
  }

  const evidence = input.evidence;
  const explicitIds = identifiers(input.content);
  const canonicalKey = key(evidence.canonicalName);
  const requiredIds = evidence.identifiers;
  if (!requiredIds.length || explicitIds.some((id) => !requiredIds.includes(id)))
    return unattributed;
  const [target, secondTarget] = rows.filter(
    (row) =>
      key(row.name) === canonicalKey &&
      row.identityAuthority === 'owner' &&
      requiredIds.every((id) => contactIdentifiers(row).includes(id)) &&
      compatibleRelationship(evidence.relationship, storedRelationship(row)),
  );
  if (!target || secondTarget) return unattributed;
  const duplicateMatches =
    subjectKey === canonicalKey ? [] : exact.filter((row) => row.id !== target.id);
  if (duplicateMatches.length > 1) return unattributed;
  const duplicate = duplicateMatches[0];
  if (duplicate) {
    const stored = contactIdentifiers(duplicate);
    if (
      duplicate.identityAuthority !== 'inferred' ||
      duplicate.trust !== 'unknown' ||
      !requiredIds.some((id) => stored.includes(id)) ||
      stored.some((id) => {
        const type = id.split(':')[0];
        const existing = contactIdentifiers(target);
        return (
          existing.some((targetId) => targetId.startsWith(`${type}:`)) && !existing.includes(id)
        );
      }) ||
      !compatibleRelationship(storedRelationship(target), storedRelationship(duplicate))
    )
      return unattributed;
  }
  const corroboratingIds = duplicate
    ? [...requiredIds, ...contactIdentifiers(duplicate)]
    : requiredIds;
  if (
    rows.some(
      (row) =>
        row.id !== target.id &&
        row.id !== duplicate?.id &&
        corroboratingIds.some((id) => contactIdentifiers(row).includes(id)),
    )
  )
    return unattributed;

  const attribution = { kind: 'identified', contactId: target.id } as const;
  if (subjectKey === canonicalKey) return attribution;
  if (!duplicate && !personNameInferredFromSubject(input.subject, input.content))
    return unattributed;
  if (!duplicate && names(target).some((name) => key(name) === subjectKey)) return attribution;
  let additions: string[];
  try {
    additions = normalizeContactAliases(
      [...(duplicate?.aliases ?? []), duplicate?.name ?? input.subject],
      target.name,
    );
  } catch {
    return attribution;
  }
  const newAliases = additions.filter(
    (name) => !names(target).some((known) => key(known) === key(name)),
  );
  const aliases = [...(target.aliases ?? []), ...newAliases];
  if (
    aliases.length > 20 ||
    newAliases.some((name) =>
      rows.some(
        (row) =>
          row.id !== target.id &&
          row.id !== duplicate?.id &&
          names(row).some((known) => key(known) === key(name)),
      ),
    )
  )
    return attribution;
  return {
    ...attribution,
    update: {
      aliases,
      duplicateId: duplicate?.id,
      emails: [...new Set([...(target.emails ?? []), ...(duplicate?.emails ?? [])])],
      phones: [...new Set([...(target.phones ?? []), ...(duplicate?.phones ?? [])])],
      notes: [target.notes, duplicate?.notes].filter(Boolean).join('\n'),
    },
  };
}
