import { createHash } from 'node:crypto';
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
  /** A direct statement about the subject, with no alias or duplicate mutation authority. */
  personhood?: true;
  /** Ordinary named reference, usable with an existing confirmed identity. */
  reference?: true;
  /** Source message to recheck before applying the decision. */
  sourceMessageId?: string;
  sourceTextHash?: string;
}

export function personSourceTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function isCurrentMemoryPersonEvidence(
  evidence: GroundedPersonEvidence,
  message: Pick<Records['messages'], 'id' | 'role' | 'origin' | 'text'>,
): boolean {
  return (
    message.role === 'user' &&
    message.origin === 'owner' &&
    message.id === evidence.sourceMessageId &&
    personSourceTextHash(message.text) === evidence.sourceTextHash
  );
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
  'daughter|son|child|wife|husband|spouse|partner|mother|father|parent|sister|brother|sibling|friend|coworker|co-worker|colleague|neighbou?r|roommate|classmate|teammate|grandmother|grandfather|grandparent|granddaughter|grandson|grandchild|aunt|uncle|cousin|niece|nephew|dentist|nurse|physician|doctor|teacher|lawyer|therapist|coach';
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

const rememberedStatement = (text: string) =>
  text.trim().replace(/^(?:please +)?remember(?: that |: +)/i, '');

function contactList(value: string): string[] {
  const ids = identifiers(value);
  return value
    .replace(EMAIL, '')
    .replace(PHONE, '')
    .replace(/\band\b|[ ,;&]/gi, '')
    ? []
    : ids;
}

function possessive(name: string): string {
  return `${name}(?:['’]s|['’])`;
}

const RELATIONSHIP_QUALIFIER = '(?:(?:only|former|current|older|younger|eldest|youngest) )?';
const RELATIONSHIP = `(?:my ${RELATIONSHIP_QUALIFIER}(${RELATIONSHIP_NAMES}) )?`;
const ALIAS_VERB =
  '(?:goes by|is (?:also )?known as|is (?:also )?called|uses the (?:name|nickname))';
const ALIAS_EXPANSION = '(?:short for|a nickname for|an alias for)';
const CONTACT_CHANNEL = 'email(?: address)?|phone(?: number)?|mobile(?: number)?';
const CONTACT_ID = `(?:${EMAIL.source}|${PHONE.source})`;

type IdentityStatement = { relationship: string; identifiers: string[] };

function identityStatement(
  quote: string,
  name: string,
  canonical: string,
  sameName: boolean,
  complete = true,
): IdentityStatement | null {
  const addresses = '\\(([^()]+(?:\\([^()]+\\)[^()]*)*)\\)';
  const legacyAlias = new RegExp(
    `^(?:The record ${name} belongs to|${name} is (?:another name|an alias|a nickname|short) for) ${RELATIONSHIP}${canonical} ${addresses}\\.$`,
    'iu',
  ).exec(quote);
  const legacyRelationship = sameName
    ? new RegExp(
        `^${canonical} ${addresses} is my ${RELATIONSHIP_QUALIFIER}(${RELATIONSHIP_NAMES})\\.$`,
        'iu',
      ).exec(quote)
    : null;
  const legacyIds = legacyAlias?.[2] ?? legacyRelationship?.[1];
  if (legacyIds) {
    const ids = contactList(legacyIds);
    return ids.length
      ? {
          identifiers: ids,
          relationship: normalizeMemoryRelationship(legacyAlias?.[1] ?? legacyRelationship?.[2]),
        }
      : null;
  }

  // The name assertion introduces one referent. Every remaining component
  // must give that same referent an address, so a stray address elsewhere in
  // the message cannot corroborate the alias.
  const assertionPatterns = sameName
    ? [
        `my ${RELATIONSHIP_QUALIFIER}(${RELATIONSHIP_NAMES}) ${canonical}`,
        `${canonical} is my ${RELATIONSHIP_QUALIFIER}(${RELATIONSHIP_NAMES})`,
        `${canonical}`,
      ]
    : [
        `${RELATIONSHIP}${canonical} ${ALIAS_VERB} ${name}`,
        `my ${RELATIONSHIP_QUALIFIER}(${RELATIONSHIP_NAMES}) ${ALIAS_VERB} ${name}\\s*(?:,|—|–)\\s*${ALIAS_EXPANSION} ${canonical}`,
        `${name} is (?:another name|an alias|a nickname|short) for ${RELATIONSHIP}${canonical}`,
        `${RELATIONSHIP}${canonical},? (?:also known as|nicknamed) ${name}`,
      ];
  for (const pattern of assertionPatterns) {
    const assertion = new RegExp(`^(?:${pattern})(?=[.,;:( ]|$)`, 'iu').exec(quote);
    if (!assertion) continue;
    const relationship = normalizeMemoryRelationship(assertion[1]);
    const ids = contactComponents(
      quote.slice(assertion[0].length),
      name,
      canonical,
      relationship,
      complete,
    );
    if (ids.length) return { identifiers: ids, relationship };
  }
  return null;
}

function contactComponents(
  tail: string,
  name: string,
  canonical: string,
  relationship: string,
  complete: boolean,
): string[] {
  const genderedPronoun =
    /^(?:daughter|mother|wife|sister|grandmother|granddaughter|aunt|niece)$/.test(relationship)
      ? /^(?:his|him|he)$/i
      : /^(?:son|father|husband|brother|grandfather|grandson|uncle|nephew)$/.test(relationship)
        ? /^(?:her|she)$/i
        : null;
  const namedOwner = `(?:${possessive(name)}|${possessive(canonical)}|her|his|their|whose)`;
  const object = `(?:${name}|${canonical}|her|him|them)`;
  const actor = `(?:${name}|${canonical}|she|he|they)`;
  const coordinator = '(?:and|but)';
  const address = new RegExp(
    `^(?:[.,;] +(?:${coordinator} +)?| +${coordinator} +| +(?=whose ))(?:(${namedOwner}) (${CONTACT_CHANNEL}) is|(?:you can )?(?:reach|contact|(?:e-?mail|call|text)) (${object}) at|(${actor}) (?:can be reached at|(?:use|uses) (?:(?:the )?(${CONTACT_CHANNEL}) *)?)) +(${CONTACT_ID})(?=[.,;]| +${coordinator} +|$)`,
    'iu',
  );
  const found: string[] = [];
  const pronouns = new Set<string>();
  let remaining = tail;
  for (let count = 0; count < 3; count += 1) {
    const component = address.exec(remaining);
    if (!component) break;
    const [, owner, ownerChannel, objectPronoun, subjectPronoun, subjectChannel, rawId] = component;
    for (const part of [owner, objectPronoun, subjectPronoun]) {
      if (!part) continue;
      if (genderedPronoun?.test(part)) return [];
      if (/^(?:she|her)$/i.test(part)) pronouns.add('female');
      if (/^(?:he|his|him)$/i.test(part)) pronouns.add('male');
    }
    if (pronouns.size > 1) return [];
    const [id] = identifiers(rawId ?? '');
    const channel = ownerChannel ?? subjectChannel;
    if (!id || (channel && id.startsWith('email:') !== /^email/i.test(channel))) return [];
    found.push(id);
    remaining = remaining.slice(component[0].length);
  }
  return !complete || remaining === '.' || remaining === '' ? [...new Set(found)] : [];
}

export function groundPersonEvidence(
  proposal: PersonEvidenceProposal | undefined,
  subject: string,
  ownerMessages: readonly string[],
): GroundedPersonEvidence | null | undefined {
  if (!proposal) return undefined;
  const canonicalName = personNameInferredFromSubject(proposal.canonicalName);
  if (!canonicalName || !subject.trim() || subject.length > 120) return null;
  const quote = unquotePersonRecordLabels(rememberedStatement(proposal.quote));
  const latest = ownerMessages.at(-1);
  const proposed = proposal.quote.trim();
  // The full statement carries negations, qualifiers and source attribution.
  if (
    !quote ||
    quote.length > 500 ||
    /[\r\n]/.test(quote) ||
    !latest ||
    (latest.trim() !== proposed && rememberedStatement(latest) !== proposed)
  )
    return null;

  const evidence = identityStatement(
    quote,
    escapeRegExp(subject.trim()),
    escapeRegExp(canonicalName),
    key(subject) === key(canonicalName),
  );
  return evidence ? { canonicalName, ...evidence } : null;
}

/** A source-backed reference, with positive personhood when the source supplies it. */
export function groundMemoryPersonReference(
  subject: string,
  ownerStatement: string,
): GroundedPersonEvidence | undefined {
  const canonicalName = subject.trim().replace(/\s+/g, ' ');
  if (!canonicalName || canonicalName.length > 120 || ownerStatement.length > 2000)
    return undefined;
  const name = escapeRegExp(canonicalName);
  const statement = rememberedStatement(ownerStatement);
  const negativeOrIndirect =
    /\b(?:if|suppose|imagine|pretend|fictional|hypothetical|maybe|allegedly|apparently|was incorrect|different person|another person|same name|not true|no longer|(?:in|from) (?:the|a) (?:play|novel|story|game|film)|is a (?:fictional )?character)\b|[?"“”]/iu;
  const reportedAssertion =
    /\b(?:according to|for illustration|here is an example|as an example|(?:told|informed|reported to) (?:me|us)|(?:wrote|said|stated|reported|quoted) (?:that|the following))\b/iu;
  const attributedSpeech =
    /[,;]\s*(?:(?:says?|said|wrote|reports?|reported|claims?|claimed)\s+[^.!?;]{1,80}|[^.!?;]{1,80}\s+(?:says?|said|wrote|reports?|reported|claims?|claimed))\s*(?=[.!?;]|$)/iu;
  const illustrativeFrame =
    /\b(?:(?:this|that|it)\s+(?:is|was)\s+(?:(?:just|only|merely|simply)\s+)?(?:a|an|the)\s+(?:example|illustration|sample|joke|parody|satire)|as\s+(?:a|an)\s+(?:joke|parody|satire))\b/iu;
  const peopleOptOut =
    /(?:^|[.!?;,\r\n]\s*)(?:please\s+)?(?:do not|don['’]t|dont|never)\s+(?:save|store|remember|retain|keep)\s+(?:this|that|it|these|those|any of this)(?:\s*,?\s*please)?\s*(?=[.!?;\r\n]|$)/iu;
  if (
    negativeOrIndirect.test(statement) ||
    reportedAssertion.test(statement) ||
    attributedSpeech.test(statement) ||
    illustrativeFrame.test(statement) ||
    peopleOptOut.test(statement)
  )
    return undefined;
  const nameEnd = '(?=$|[^\\p{L}\\p{M}\\p{N}])';
  const exactName = new RegExp(`(?:^|[^\\p{L}\\p{M}\\p{N}])${name}${nameEnd}`, 'iu');
  if (!exactName.test(statement)) return undefined;

  const directIdentity = identityStatement(statement, name, name, true, false);
  const start = '(?:^|[.:;!][ ]+|, +(?:and +)?|[ ]+and +)';
  const roleEnd = '(?=$|[.!;,]| +(?:and|but|who|at|for|in|from|with|named|called) +)';
  const contradicts = new RegExp(
    `${start}${name} (?:is|was) (?:not|never|neither) (?:a |an |my |the )?(?:person|human|${RELATIONSHIP_NAMES}|${name})${roleEnd}`,
    'iu',
  );
  const deniesSameIdentity = new RegExp(
    `${start}${name} (?:is not|isn['’]t|was not|wasn['’]t) the ${name}${nameEnd}`,
    'iu',
  );
  if (contradicts.test(statement) || deniesSameIdentity.test(statement)) return undefined;
  const namedRoleEnd =
    "(?=$|[.!;,:]|['’]s | +(?:at|on|in|is|was|has|had|will|would|can|celebrates|recently) +)";
  const relationship = new RegExp(
    `${start}(?:${name} (?:is|is also) my ${RELATIONSHIP_QUALIFIER}(${RELATIONSHIP_NAMES})${roleEnd}|my ${RELATIONSHIP_QUALIFIER}(${RELATIONSHIP_NAMES}) (?:is (?:named |called )?|named |called )?${name}${namedRoleEnd})`,
    'iu',
  ).exec(statement);
  const humanRole =
    'person|human|woman|man|girl|boy|adult|teenager|dentist|nurse|physician|doctor|teacher|lawyer|therapist|student|colleague|coworker|coach|neighbor|neighbour';
  const humanDetail = new RegExp(
    `${start}(?:${possessive(name)} (?:birthday|maiden name|birth name) (?:is|was)|${name} (?:was born|is (?:pregnant|married to|raising (?:a|their|her|his) child)|celebrates (?:a|their|her|his) birthday|graduated (?:from|in)|has (?:a|an|two|three) (?:children?|daughters?|sons?)${roleEnd}|got married))${nameEnd}`,
    'iu',
  ).test(statement);
  const occupation = new RegExp(
    `${start}${name} (?:is|works as) (?:a|an|the) (?:${humanRole})${roleEnd}`,
    'iu',
  ).test(statement);
  const classification = new RegExp(`${start}${name} (?:is|was) (?:a|an|the) `, 'iu').test(
    statement,
  );
  const roleCompound = new RegExp(
    `${start}${name} (?:(?:is|is also) my ${RELATIONSHIP_QUALIFIER}(?:${RELATIONSHIP_NAMES})|has (?:a|an|two|three) (?:children?|daughters?|sons?))${nameEnd}(?!${roleEnd}) +\\p{L}`,
    'iu',
  ).test(statement);
  const unverifiedAlias = new RegExp(
    `(?:${ALIAS_VERB}|also known as|nicknamed) ${name}${nameEnd}|${name} is (?:another name|an alias|a nickname|short) for `,
    'iu',
  ).test(statement);
  const subjectAtStart = new RegExp(`${start}${name}(?=$|[.:;!,'’ ])`, 'giu');
  const activeName = [...statement.matchAll(subjectAtStart)].some((match) => {
    const remainder = statement.slice(match.index + match[0].length);
    // A following name component could refer to another person or an entity.
    return !/^ +\p{Lu}/u.test(remainder);
  });
  const namedParticipant = new RegExp(
    `${start}I (?:met|spoke with|talked to|called|visited) ${name}${namedRoleEnd}`,
    'iu',
  ).test(statement);
  if (
    unverifiedAlias ||
    (classification && !occupation) ||
    roleCompound ||
    !(activeName || namedParticipant || directIdentity || relationship || humanDetail || occupation)
  )
    return undefined;
  const statedRelationship = normalizeMemoryRelationship(
    directIdentity?.relationship || relationship?.[1] || relationship?.[2],
  );
  return {
    canonicalName,
    identifiers: directIdentity?.identifiers ?? statedSubjectIdentifiers(canonicalName, statement),
    relationship: statedRelationship,
    reference: true,
    ...((statedRelationship || humanDetail || occupation) &&
    personNameInferredFromSubject(canonicalName, ownerStatement)
      ? { personhood: true }
      : {}),
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
function statedSubjectIdentifiers(subject: string, content: string): string[] {
  const pattern = new RegExp(
    `(?:^|[^\\p{L}\\p{M}\\p{N}])${escapeRegExp(subject.trim())}(?:['’]s (?:${CONTACT_CHANNEL}) is | (?:uses|can be reached at) )(${CONTACT_ID})`,
    'giu',
  );
  return [...content.matchAll(pattern)].flatMap((match) => identifiers(match[1] ?? ''));
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
  const evidence = input.evidence ?? groundMemoryPersonReference(input.subject, input.content);
  if (subjectKey === 'owner' && !input.evidence) {
    const [owner, second] = rows.filter((row) => row.trust === 'owner');
    return owner && !second ? { kind: 'identified', contactId: owner.id } : unattributed;
  }
  if (!evidence) return unattributed;
  if (evidence.reference) {
    if (key(evidence.canonicalName) !== subjectKey) return unattributed;
    const [matched, second] = exact;
    if (second || (input.knownContactId && matched?.id !== input.knownContactId))
      return unattributed;
    const statedIds = [
      ...evidence.identifiers,
      ...statedSubjectIdentifiers(input.subject, input.content),
    ];
    if (!matched) {
      const relativeName = rows.some((row) =>
        names(row).some((variant) => {
          const candidate = key(variant);
          return candidate.startsWith(`${subjectKey} `) || subjectKey.startsWith(`${candidate} `);
        }),
      );
      if (
        !evidence.personhood ||
        relativeName ||
        rows.some((row) => statedIds.some((id) => contactIdentifiers(row).includes(id)))
      )
        return unattributed;
      return { kind: 'create', name: evidence.canonicalName };
    }
    if (!evidence.personhood && matched.identityAuthority !== 'owner') return unattributed;
    if (!compatibleRelationship(evidence.relationship, storedRelationship(matched)))
      return unattributed;
    const saved = contactIdentifiers(matched);
    if (
      statedIds.some(
        (id) =>
          (saved.some((savedId) => savedId.startsWith(`${id.split(':')[0]}:`)) &&
            !saved.includes(id)) ||
          rows.some((row) => row.id !== matched.id && contactIdentifiers(row).includes(id)),
      )
    )
      return unattributed;
    return { kind: 'identified', contactId: matched.id };
  }

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
  if (
    input.knownContactId &&
    input.knownContactId !== target.id &&
    input.knownContactId !== duplicate?.id
  )
    return unattributed;
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
