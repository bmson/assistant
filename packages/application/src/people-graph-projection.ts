import type { OwnerEditorTiming } from '@assistant/persistence/owner-editor';
import { predicateSpec } from '@assistant/persistence/predicate-vocabulary';
import type { PersonConnection, PersonRelation } from './people.js';
import {
  presentKnowledgeGraphRelation,
  presentOwnerFamilyFact,
  validOwnerFamilyMeaning,
} from './relationship-presentation.js';

export interface PersonGraphEdgeInput {
  id: string;
  sourceMemoryId?: string;
  predicate: string;
  outbound: boolean;
  reviewStatus: 'confirmed' | 'unreviewed';
  validFrom: string | null;
  validUntil: string | null;
  /** Present only when the stored edge is an explicit positive, asserted family claim. */
  assertionTiming?: OwnerEditorTiming | null;
  other: {
    id: string;
    label: string;
    kind: string;
    canonicalKey: string;
  };
}

export interface PersonGraphProjection {
  location: string | null;
  origins: PersonConnection[];
  relations: PersonRelation[];
  connections: PersonConnection[];
}

const ORIGIN_PREDICATES = new Set(['met', 'met_at', 'met_during']);

export function presentPersonGraphRelation(input: {
  subjectLabel: string;
  predicate: string;
  objectLabel: string;
  otherIsPerson: boolean;
  validFrom: string | null;
  validUntil: string | null;
  assertionTiming?: OwnerEditorTiming | null;
}) {
  const fallback = presentKnowledgeGraphRelation(input);
  const validity = { validFrom: input.validFrom, validUntil: input.validUntil };
  if (
    !input.otherIsPerson ||
    predicateSpec(input.predicate)?.group !== 'family' ||
    input.assertionTiming == null ||
    (input.predicate.startsWith('former_') && input.assertionTiming !== 'past') ||
    !validOwnerFamilyMeaning({ timing: input.assertionTiming, validity })
  )
    return fallback;
  const sentence = presentOwnerFamilyFact({
    subjectLabel: input.subjectLabel,
    predicate: input.predicate,
    objectLabel: input.objectLabel,
    timing: input.assertionTiming,
    validity,
  });
  return { ...fallback, sentence, accessibleLabel: sentence };
}

/** Use the SQL dossier's stored edge direction and person/connection buckets. */
export function projectPersonGraph(
  personName: string,
  edges: PersonGraphEdgeInput[],
): PersonGraphProjection {
  const result: PersonGraphProjection = {
    location: null,
    origins: [],
    relations: [],
    connections: [],
  };
  for (const edge of edges) {
    const otherLabel = edge.other.label;
    const presentation = presentPersonGraphRelation({
      subjectLabel: edge.outbound ? personName : otherLabel,
      predicate: edge.predicate,
      objectLabel: edge.outbound ? otherLabel : personName,
      otherIsPerson: edge.other.kind === 'person',
      validFrom: edge.validFrom,
      validUntil: edge.validUntil,
      assertionTiming: edge.assertionTiming,
    });
    const shared = {
      id: edge.id,
      ...(edge.sourceMemoryId ? { sourceMemoryId: edge.sourceMemoryId } : {}),
      sentence: presentation.sentence,
      label: presentation.label,
      otherLabel,
      validFrom: edge.validFrom,
      validUntil: edge.validUntil,
    };
    if (edge.other.kind === 'person') {
      const match = /^contact:([0-9a-f-]{36})$/i.exec(edge.other.canonicalKey);
      result.relations.push({
        ...shared,
        otherContactId: match?.[1] ?? null,
        otherEntityId: edge.other.id,
        reviewStatus: edge.reviewStatus,
      });
      if (ORIGIN_PREDICATES.has(edge.predicate))
        result.origins.push({ ...shared, otherKind: edge.other.kind });
      continue;
    }
    const connection = { ...shared, otherKind: edge.other.kind };
    if (
      edge.predicate === 'lives_in' &&
      edge.outbound &&
      edge.validUntil === null &&
      result.location === null
    ) {
      result.location = otherLabel;
      continue;
    }
    if (ORIGIN_PREDICATES.has(edge.predicate)) result.origins.push(connection);
    else result.connections.push(connection);
  }
  return result;
}
