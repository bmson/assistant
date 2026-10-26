import {
  canonicalizeKnowledgeAssertionDirection,
  knowledgeAssertionSemanticKey,
} from './knowledge-assertions.js';
import { statedPeriodEnd, statedPeriodStart } from './knowledge-validity.js';
import {
  type OwnerFamilyMeaning,
  presentOwnerFamilyFact,
  validOwnerFamilyMeaning,
} from './owner-family-presentation.js';
import { predicateSpec } from './predicate-vocabulary.js';

export * from './owner-family-presentation.js';

export interface OwnerFamilyScopeRows {
  ownerId: string;
  relation: import('./records.js').Records['knowledgeGraphRelations'];
  source: import('./records.js').Records['memories'];
  assertion: import('./records.js').Records['knowledgeGraphAssertions'];
  evidence: import('./records.js').Records['knowledgeGraphAssertionEvidence'][];
  sourceRelations: import('./records.js').Records['knowledgeGraphRelations'][];
  canonicalRelations: import('./records.js').Records['knowledgeGraphRelations'][];
  sourcePrecisionLossless: boolean;
  /** Exact native timestamps/update tokens included by the driver before decoding. */
  native: unknown;
}

/** A selected row cannot hide canonical siblings or retire another source's evidence. */
export function eligibleOwnerFamilyCorrection(rows: OwnerFamilyScopeRows): boolean {
  const { ownerId, relation, source, assertion, evidence, sourceRelations, canonicalRelations } =
    rows;
  const claim = relation.assertion;
  if (!claim) return false;
  const meaning = {
    timing: claim.tense,
    validity: { validFrom: relation.validFrom, validUntil: relation.validUntil },
  };
  if (!validOwnerFamilyMeaning(meaning as OwnerFamilyMeaning) || !rows.sourcePrecisionLossless)
    return false;
  if (
    relation.agentId !== ownerId ||
    source.agentId !== ownerId ||
    assertion.agentId !== ownerId ||
    relation.sourceMemoryId !== source.id ||
    relation.assertionId !== assertion.id ||
    source.source !== 'knowledge-graph-owner' ||
    source.originTrust !== 'owner' ||
    !source.ownerConfirmed ||
    source.quarantined ||
    source.expiresAt !== null ||
    source.supersededById !== null ||
    relation.correctedByRelationId ||
    claim.polarity !== 'positive' ||
    claim.modality !== 'asserted' ||
    !['confirmed', 'unreviewed'].includes(relation.reviewStatus) ||
    assertion.lifecycle !== 'current' ||
    assertion.reviewStatus !== 'confirmed' ||
    !assertion.ownerAuthored ||
    assertion.reviewedRevision !== assertion.semanticRevision ||
    assertion.reviewedPayloadHash !== assertion.semanticKey ||
    (relation.predicate.startsWith('former_') && claim.tense !== 'past')
  )
    return false;
  if (
    evidence.length !== 1 ||
    sourceRelations.length !== 1 ||
    canonicalRelations.length !== 1 ||
    sourceRelations[0]?.id !== relation.id ||
    canonicalRelations[0]?.id !== relation.id
  )
    return false;
  const spec = predicateSpec(relation.predicate);
  if (!spec || spec.group !== 'family') return false;
  const canonical = canonicalizeKnowledgeAssertionDirection({
    subjectEntityId: relation.subjectEntityId,
    objectEntityId: relation.objectEntityId,
    predicate: relation.predicate,
    assertion: claim,
    validFrom: relation.validFrom,
    validUntil: relation.validUntil,
  });
  if (knowledgeAssertionSemanticKey(ownerId, canonical) !== assertion.semanticKey) return false;
  if (
    typeof source.content !== 'string' ||
    source.content.length > 4096 ||
    typeof source.contentHash !== 'string' ||
    !source.contentHash ||
    [source.validFrom, source.validUntil].some(
      (bound) => bound !== null && (!(bound instanceof Date) || !Number.isFinite(bound.getTime())),
    )
  )
    return false;
  const from = statedPeriodStart(relation.validFrom),
    until = statedPeriodEnd(relation.validUntil);
  if (
    (source.validFrom?.getTime() ?? null) !== (from?.getTime() ?? null) ||
    (source.validUntil?.getTime() ?? null) !== (until?.getTime() ?? null)
  )
    return false;
  const proof = evidence[0];
  if (
    !proof ||
    proof.agentId !== ownerId ||
    proof.assertionId !== assertion.id ||
    proof.sourceMemoryId !== source.id ||
    proof.sourceContentHash !== source.contentHash ||
    proof.sourceTrust !== 'owner' ||
    proof.sourceAuthor !== 'owner' ||
    proof.evidenceQuote !== source.content ||
    relation.evidenceQuote !== source.content
  )
    return false;
  return true;
}

export function ownerFamilyCorrectionTarget(
  rows: OwnerFamilyScopeRows,
): import('./owner-knowledge-graph-fact.js').OwnerGraphCorrectionTarget | null {
  if (!eligibleOwnerFamilyCorrection(rows)) return null;
  const { relation, source } = rows;
  return {
    relationId: relation.id,
    sourceMemoryId: source.id,
    sourceContentHash: source.contentHash,
    reviewStatus: relation.reviewStatus,
    source: source.source,
    sourceOriginTrust: source.originTrust,
    sourceOwnerConfirmed: source.ownerConfirmed,
    sourceSupersededById: source.supersededById,
    sourceExpiresAt: source.expiresAt,
    correctedByRelationId: relation.correctedByRelationId ?? null,
    correctionSourceContentHash: relation.correctionSourceContentHash ?? null,
    correctionDisposition:
      relation.correctionDisposition === 'whole_fact'
        ? 'whole_fact'
        : relation.correctionDisposition === 'graph_only'
          ? 'graph_only'
          : null,
  };
}

/** Recognize only controlled owner-source wording; ambiguous legacy text stays read-only. */
export function ownerFamilyRecordedNote(input: {
  sourceText: string;
  subject: { name: string; aliases: string[] };
  object: { name: string; aliases: string[] };
  predicate: string;
  timing: import('./owner-editor.js').OwnerEditorTiming;
  validity: import('./owner-editor.js').OwnerEditorValidity;
}): string | null {
  if (
    input.sourceText.length > 4096 ||
    input.subject.aliases.length > 20 ||
    input.object.aliases.length > 20
  )
    return null;
  const notes = new Set<string>();
  for (const left of new Set([input.subject.name, ...input.subject.aliases])) {
    for (const right of new Set([input.object.name, ...input.object.aliases])) {
      const prefixes = [
        presentOwnerFamilyFact({
          subjectLabel: left,
          objectLabel: right,
          predicate: input.predicate,
          timing: input.timing,
          validity: input.validity,
        }),
        `${left} ${input.predicate.replaceAll('_', ' ')} ${right}.`,
      ];
      for (const prefix of prefixes) {
        if (input.sourceText === prefix) notes.add('');
        else if (input.sourceText.startsWith(`${prefix} Owner note: `)) {
          const note = input.sourceText.slice(`${prefix} Owner note: `.length);
          if (note.length <= 1000) notes.add(note);
        }
      }
    }
  }
  return notes.size === 1 ? ([...notes][0] ?? null) : null;
}

/** Lossless editable projection from the same native snapshot as the sole-evidence proof. */
export function ownerFamilyEditorProjection(
  scope: OwnerFamilyScopeRows & { revision: string },
  entities: readonly import('./records.js').Records['knowledgeGraphEntities'][],
  contacts: readonly (import('./records.js').Records['contacts'] & { revision: string })[],
): import('./owner-editor.js').OwnerEditorCorrectionEligibility | null {
  if (!eligibleOwnerFamilyCorrection(scope)) return null;
  const endpoint = (id: string) => {
    const entity = entities.find((item) => item.id === id && item.agentId === scope.ownerId);
    if (!entity || entity.kind !== 'person' || !entity.canonicalKey.startsWith('contact:'))
      return null;
    return (
      contacts.find(
        (item) =>
          `contact:${item.id}` === entity.canonicalKey &&
          entity.contactId === item.id &&
          item.trust !== 'owner',
      ) ?? null
    );
  };
  const subject = endpoint(scope.relation.subjectEntityId),
    object = endpoint(scope.relation.objectEntityId);
  if (!subject || !object || subject.id === object.id) return null;
  const timing = scope.relation.assertion?.tense;
  if (timing !== 'unspecified' && timing !== 'present' && timing !== 'past') return null;
  const validity = { validFrom: scope.relation.validFrom, validUntil: scope.relation.validUntil };
  const note = ownerFamilyRecordedNote({
    sourceText: scope.source.content,
    subject,
    object,
    predicate: scope.relation.predicate,
    timing,
    validity,
  });
  if (note === null) return null;
  return {
    relationId: scope.relation.id,
    revision: scope.revision,
    sourceText: scope.source.content,
    original: {
      subjectContactId: subject.id,
      objectContactId: object.id,
      expectedSubjectRevision: subject.revision,
      expectedObjectRevision: object.revision,
      expectedCanonicalState: { kind: 'absent' },
      predicate: scope.relation.predicate,
      timing,
      validity,
      note,
    },
  };
}
