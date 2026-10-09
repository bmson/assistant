import { createHash } from 'node:crypto';
import type { KnowledgeGraphAssertion } from './knowledge-graph-sync.js';

export interface KnowledgeAssertionMeaning {
  subjectEntityId: string;
  predicate: string;
  objectEntityId: string;
  assertion: KnowledgeGraphAssertion;
  validFrom: string | null;
  validUntil: string | null;
  qualifiers?: Record<string, string | number | boolean | null>;
}

export interface CanonicalKnowledgeAssertion extends KnowledgeAssertionMeaning {
  id: string;
  agentId: string;
  semanticKey: string;
  semanticRevision: number;
  evidenceRevision: number;
  lifecycle: 'current' | 'superseded' | 'retracted';
  reviewStatus: 'unreviewed' | 'confirmed' | 'rejected';
  reviewedRevision: number | null;
  reviewedPayloadHash: string | null;
  ownerAuthored: boolean;
  supersededById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeAssertionEvidence {
  id: string;
  agentId: string;
  assertionId: string;
  sourceMemoryId: string;
  sourceFingerprint: string;
  sourceContentHash: string;
  evidenceQuote: string;
  sourceAuthor: 'owner' | 'other' | 'unknown';
  sourceTrust: string;
  independent: boolean;
  spanStart: number | null;
  spanEnd: number | null;
  extractionVersion: number;
  evidenceRevision: number;
  observedAt: Date;
  createdAt: Date;
}

export interface KnowledgeAssertionEndpointView {
  assertionId: string;
  semanticRevision: number;
  focusEntityId: string;
  relatedEntityId: string;
  direction: 'forward' | 'inverse';
  subjectEntityId: string;
  predicate: string;
  objectEntityId: string;
  text: string;
  accessibilityText: string;
  evidenceCount: number;
  reviewStatus: 'unreviewed' | 'confirmed' | 'rejected';
}

export interface DerivedKnowledgeView {
  id: string;
  kind: 'derived';
  subjectEntityId: string;
  predicate: string;
  objectEntityId: string;
  explanation: string;
  premiseAssertionIds: string[];
  premiseRevisions: number[];
  ruleId: string;
  ruleVersion: string;
}

export type DerivableKnowledgeAssertion = Pick<
  CanonicalKnowledgeAssertion,
  | 'id'
  | 'semanticRevision'
  | 'subjectEntityId'
  | 'predicate'
  | 'objectEntityId'
  | 'assertion'
  | 'lifecycle'
  | 'reviewStatus'
> & {
  lifecycle: 'current' | 'superseded' | 'retracted';
  reviewStatus: 'unreviewed' | 'confirmed' | 'rejected';
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/**
 * Meaning identity includes every field that can change what the owner
 * asserted. Evidence is intentionally excluded so another source can support
 * the same assertion without creating a second review item.
 */
export function knowledgeAssertionSemanticKey(
  agentId: string,
  meaning: KnowledgeAssertionMeaning,
): string {
  return createHash('sha256')
    .update(
      stableJson({
        agentId,
        subjectEntityId: meaning.subjectEntityId,
        predicate: meaning.predicate,
        objectEntityId: meaning.objectEntityId,
        assertion: meaning.assertion,
        validFrom: meaning.validFrom,
        validUntil: meaning.validUntil,
        qualifiers: meaning.qualifiers ?? {},
      }),
    )
    .digest('hex');
}

/** Same owner/key produces the same UUID in PostgreSQL, Firestore and tests. */
export function knowledgeAssertionId(agentId: string, semanticKey: string): string {
  const bytes = createHash('sha256')
    .update(`knowledge-assertion\0${agentId}\0${semanticKey}`)
    .digest()
    .subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x80, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Normalize only registry-defined inverse forms; preserve source wording in evidence. */
export function canonicalizeKnowledgeAssertionDirection<T extends KnowledgeAssertionMeaning>(
  meaning: T,
  predicate: { id: string; inverse?: string; symmetric?: boolean } = {
    id: meaning.predicate,
    inverse: INVERSE_PREDICATES[meaning.predicate],
    symmetric: SYMMETRIC_PREDICATES.has(meaning.predicate),
  },
): T {
  let subjectEntityId = meaning.subjectEntityId;
  let objectEntityId = meaning.objectEntityId;
  let canonicalPredicate = predicate.id;
  const qualifiers = { ...(meaning.qualifiers ?? {}) };
  if (CANONICAL_INVERSE[predicate.id]) {
    canonicalPredicate = CANONICAL_INVERSE[predicate.id]?.canonical ?? predicate.id;
    [subjectEntityId, objectEntityId] = [objectEntityId, subjectEntityId];
    const subtype = CANONICAL_INVERSE[predicate.id]?.subtype;
    if (subtype) qualifiers.relationshipSubtype = subtype;
  } else if (
    predicate.id === 'child_of' ||
    predicate.id === 'son_of' ||
    predicate.id === 'daughter_of'
  ) {
    [subjectEntityId, objectEntityId] = [objectEntityId, subjectEntityId];
    canonicalPredicate = 'parent_of';
    if (predicate.id !== 'child_of')
      qualifiers.relationshipSubtype = predicate.id.replace('_of', '');
  } else if (predicate.symmetric && objectEntityId.localeCompare(subjectEntityId) < 0) {
    [subjectEntityId, objectEntityId] = [objectEntityId, subjectEntityId];
  }
  return {
    ...meaning,
    subjectEntityId,
    predicate: canonicalPredicate,
    objectEntityId,
    qualifiers,
  };
}

const CANONICAL_INVERSE: Readonly<Record<string, { canonical: string; subtype?: string }>> = {
  child_of: { canonical: 'parent_of' },
  son_of: { canonical: 'parent_of', subtype: 'son' },
  daughter_of: { canonical: 'parent_of', subtype: 'daughter' },
  grandchild_of: { canonical: 'grandparent_of' },
  grandson_of: { canonical: 'grandparent_of', subtype: 'grandson' },
  granddaughter_of: { canonical: 'grandparent_of', subtype: 'granddaughter' },
  nephew_of: { canonical: 'uncle_of', subtype: 'nephew' },
  niece_of: { canonical: 'aunt_of', subtype: 'niece' },
  employs: { canonical: 'works_at' },
  attended_by: { canonical: 'attended' },
};
const INVERSE_PREDICATES: Readonly<Record<string, string>> = {
  child_of: 'parent_of',
  son_of: 'parent_of',
  daughter_of: 'parent_of',
  grandchild_of: 'grandparent_of',
  grandson_of: 'grandparent_of',
  granddaughter_of: 'grandparent_of',
  nephew_of: 'uncle_of',
  niece_of: 'aunt_of',
  employs: 'works_at',
  attended_by: 'attended',
};
const SYMMETRIC_PREDICATES = new Set([
  'sibling_of',
  'spouse_of',
  'former_spouse_of',
  'partner_of',
  'cousin_of',
  'met_at',
  'met',
]);
const SAFE_INVERSE_VIEWS: Readonly<Record<string, string>> = {
  parent_of: 'child_of',
  father_of: 'child_of',
  mother_of: 'child_of',
  grandparent_of: 'grandchild_of',
};

export function knowledgeAssertionEvidenceId(
  agentId: string,
  assertionId: string,
  sourceMemoryId: string,
  sourceFingerprint: string,
): string {
  const bytes = createHash('sha256')
    .update(
      `knowledge-assertion-evidence\0${agentId}\0${assertionId}\0${sourceMemoryId}\0${sourceFingerprint}`,
    )
    .digest()
    .subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x80, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const PREDICATE_LABELS: Readonly<Record<string, string>> = {
  father_of: 'is the father of',
  mother_of: 'is the mother of',
  parent_of: 'is the parent of',
  child_of: 'is the child of',
  sibling_of: 'is a sibling of',
  brother_of: 'is the brother of',
  sister_of: 'is the sister of',
  grandparent_of: 'is the grandparent of',
  grandchild_of: 'is the grandchild of',
  partner_of: 'is the partner of',
  spouse_of: 'is the spouse of',
  former_spouse_of: 'was formerly married to',
  works_at: 'works at',
  worked_at: 'worked at',
  employs: 'employs',
  lives_in: 'lives in',
  grew_up_in: 'grew up in',
};

function fallbackAssertion(
  subjectLabel: string,
  predicate: string,
  objectLabel: string,
  evidenceQuote?: string | null,
): string {
  const quote = evidenceQuote?.replace(/\s+/gu, ' ').trim();
  return quote || `${subjectLabel} —${predicate.replace(/_/gu, ' ')}→ ${objectLabel}`;
}

/**
 * Derive a safe endpoint-relative wording for one stored assertion. The source
 * sentence is the fallback whenever the registry has no safe inverse; this
 * avoids inventing a gendered or otherwise unsupported role.
 */
export function knowledgeAssertionEndpointView(input: {
  assertionId: string;
  semanticRevision: number;
  subjectEntityId: string;
  subjectLabel: string;
  predicate: string;
  objectEntityId: string;
  objectLabel: string;
  inversePredicate?: string;
  symmetric?: boolean;
  evidenceQuote?: string | null;
  evidenceCount: number;
  reviewStatus: 'unreviewed' | 'confirmed' | 'rejected';
  focusEntityId: string;
}): KnowledgeAssertionEndpointView | null {
  const forward = input.focusEntityId === input.subjectEntityId;
  const inverse = input.focusEntityId === input.objectEntityId;
  if (!forward && !inverse) return null;
  const direction = forward ? 'forward' : 'inverse';
  const relatedEntityId = forward ? input.objectEntityId : input.subjectEntityId;
  const focusLabel = forward ? input.subjectLabel : input.objectLabel;
  const relatedLabel = forward ? input.objectLabel : input.subjectLabel;
  const inversePredicate =
    input.symmetric || SYMMETRIC_PREDICATES.has(input.predicate)
      ? input.predicate
      : (input.inversePredicate ?? SAFE_INVERSE_VIEWS[input.predicate]);
  const viewPredicate = forward ? input.predicate : inversePredicate;
  const text =
    viewPredicate && PREDICATE_LABELS[viewPredicate]
      ? `${focusLabel} ${PREDICATE_LABELS[viewPredicate]} ${relatedLabel}`
      : fallbackAssertion(
          input.subjectLabel,
          input.predicate,
          input.objectLabel,
          input.evidenceQuote,
        );
  return {
    assertionId: input.assertionId,
    semanticRevision: input.semanticRevision,
    focusEntityId: input.focusEntityId,
    relatedEntityId,
    direction,
    subjectEntityId: input.subjectEntityId,
    predicate: input.predicate,
    objectEntityId: input.objectEntityId,
    text,
    accessibilityText: text,
    evidenceCount: input.evidenceCount,
    reviewStatus: input.reviewStatus,
  };
}

/** Derive an explanation from current premises; no cache can outlive a premise. */
export function deriveSharedParentViews(
  assertions: readonly DerivableKnowledgeAssertion[],
  entities: ReadonlyMap<string, string>,
): DerivedKnowledgeView[] {
  const eligible = assertions.filter(
    (row) =>
      row.lifecycle === 'current' &&
      row.reviewStatus !== 'rejected' &&
      row.assertion.polarity === 'positive' &&
      row.assertion.modality === 'asserted' &&
      ['parent_of', 'father_of', 'mother_of'].includes(row.predicate),
  );
  const byParent = new Map<string, DerivableKnowledgeAssertion[]>();
  for (const row of eligible) {
    const rows = byParent.get(row.subjectEntityId) ?? [];
    rows.push(row);
    byParent.set(row.subjectEntityId, rows);
  }
  const derived = new Map<string, DerivedKnowledgeView>();
  for (const [parentId, children] of byParent) {
    for (let left = 0; left < children.length; left += 1) {
      for (let right = left + 1; right < children.length; right += 1) {
        const a = children[left];
        const b = children[right];
        if (!a || !b || a.objectEntityId === b.objectEntityId) continue;
        const endpoints = [a.objectEntityId, b.objectEntityId].sort();
        const subjectEntityId = endpoints[0];
        const objectEntityId = endpoints[1];
        if (!subjectEntityId || !objectEntityId) continue;
        const premiseAssertionIds = [a.id, b.id].sort();
        const premiseRows = premiseAssertionIds.map((id) =>
          assertions.find((row) => row.id === id),
        );
        if (premiseRows.some((row) => !row)) continue;
        const id = createHash('sha256')
          .update(`derived:shared-parent:v1\0${premiseAssertionIds.join('\0')}`)
          .digest('hex');
        derived.set(id, {
          id,
          kind: 'derived',
          subjectEntityId,
          predicate: 'shares_recorded_parent_with',
          objectEntityId,
          explanation: `${entities.get(subjectEntityId) ?? 'This person'} and ${entities.get(objectEntityId) ?? 'the other person'} share a recorded parent, ${entities.get(parentId) ?? 'unknown'}. This is a derived relationship, not a directly stated sibling claim.`,
          premiseAssertionIds,
          premiseRevisions: premiseRows.map((row) => row?.semanticRevision ?? 0),
          ruleId: 'shared-parent',
          ruleVersion: '1',
        });
      }
    }
  }
  return [...derived.values()];
}
