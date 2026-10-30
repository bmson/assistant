import { z } from 'zod';
import type { OwnerEditorCorrectionEligibility } from './owner-editor.js';
import {
  eligibleOwnerFamilyCorrection,
  type OwnerFamilyScopeRows,
  ownerFamilyEditorProjection,
} from './owner-family-scope.js';
import type { Records } from './records.js';

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const hash = z.string().regex(/^[a-f0-9]{64}$/);

/** Exact user intent needed to plan rejection of one reviewed family claim. */
export const ownerFamilyRemovalRequestSchema = z.strictObject({
  ownerId: uuid,
  relationId: uuid,
  expectedNativeScopeHash: hash,
});
export type OwnerFamilyRemovalRequest = z.infer<typeof ownerFamilyRemovalRequestSchema>;

/** These are obligations for a future writer, not capabilities implemented here. */
export const OWNER_FAMILY_REMOVAL_WRITER_REQUIREMENTS = Object.freeze([
  'Revalidate configured owner, epoch, privacy fence, and exact native revisions in the mutation transaction.',
  'Persist a durable exact-evidence fence so the rejected claim cannot be re-extracted from the same evidence.',
  'Exclude the source-bound rejected projection from recall and cached projections while retaining the source note.',
  'Commit the rejection and its same-operation replay receipt atomically.',
] as const);

export interface OwnerFamilyRemovalPlan {
  readonly action: 'reject_recorded_claim';
  readonly ownerId: string;
  readonly expectedNativeScopeHash: string;
  readonly target: {
    readonly relation: {
      readonly id: string;
      readonly assertionId: string;
      readonly sourceMemoryId: string;
    };
    readonly assertion: {
      readonly id: string;
      readonly semanticRevision: number;
      readonly evidenceRevision: number;
    };
    readonly evidence: {
      readonly id: string;
      readonly assertionId: string;
      readonly sourceMemoryId: string;
      readonly sourceContentHash: string;
      readonly evidenceRevision: number;
    };
  };
  readonly retained: {
    readonly subjectContactId: string;
    readonly objectContactId: string;
    readonly sourceMemoryId: string;
    readonly sourceContentHash: string;
    /** The source note stays saved and may contain the original relationship wording. */
    readonly sourceText: string;
    readonly sourceDisposition: 'retain_saved_source_note';
  };
  readonly writerRequirements: typeof OWNER_FAMILY_REMOVAL_WRITER_REQUIREMENTS;
}

type ContactWithRevision = Records['contacts'] & { revision: string };

function exactEndpointRows(
  scope: OwnerFamilyScopeRows,
  projection: OwnerEditorCorrectionEligibility,
  entities: readonly Records['knowledgeGraphEntities'][],
  contacts: readonly ContactWithRevision[],
): boolean {
  const endpointIds = [projection.original.subjectContactId, projection.original.objectContactId];
  if (endpointIds[0] === endpointIds[1] || endpointIds.some((id) => !uuid.safeParse(id).success))
    return false;

  const relationEndpointIds = [scope.relation.subjectEntityId, scope.relation.objectEntityId];
  for (let index = 0; index < relationEndpointIds.length; index += 1) {
    const entityId = relationEndpointIds[index];
    const entityMatches = entities.filter((entity) => entity.id === entityId);
    if (entityMatches.length !== 1 || entityMatches[0]?.agentId !== scope.ownerId) return false;
    const entity = entityMatches[0];
    const contactMatches = contacts.filter((contact) => contact.id === entity?.contactId);
    if (
      contactMatches.length !== 1 ||
      contactMatches[0]?.trust === 'owner' ||
      !hash.safeParse(contactMatches[0]?.revision).success ||
      contactMatches[0]?.id !== endpointIds[index]
    )
      return false;
  }
  return true;
}

/**
 * Plan only a standalone, losslessly controlled owner family claim for rejection.
 * This pure function authorizes no write and promises no blanket source-note erasure.
 */
export function planOwnerFamilyRemoval(input: {
  request: unknown;
  scope: OwnerFamilyScopeRows & { revision: string };
  entities: readonly Records['knowledgeGraphEntities'][];
  contacts: readonly ContactWithRevision[];
}): OwnerFamilyRemovalPlan | null {
  try {
    const parsedRequest = ownerFamilyRemovalRequestSchema.safeParse(input.request);
    if (!parsedRequest.success) return null;
    const request = parsedRequest.data;
    const { scope } = input;
    if (
      scope.ownerId !== request.ownerId ||
      scope.relation.id !== request.relationId ||
      scope.revision !== request.expectedNativeScopeHash ||
      !hash.safeParse(scope.revision).success ||
      !uuid.safeParse(scope.ownerId).success ||
      !uuid.safeParse(scope.relation.id).success ||
      !uuid.safeParse(scope.source.id).success ||
      !hash.safeParse(scope.source.contentHash).success ||
      scope.native === null ||
      scope.native === undefined ||
      !uuid.safeParse(scope.assertion.id).success ||
      !uuid.safeParse(scope.evidence[0]?.id).success ||
      !Number.isSafeInteger(scope.assertion.semanticRevision) ||
      scope.assertion.semanticRevision < 1 ||
      !Number.isSafeInteger(scope.assertion.evidenceRevision) ||
      scope.assertion.evidenceRevision < 1 ||
      !Number.isSafeInteger(scope.evidence[0]?.evidenceRevision) ||
      (scope.evidence[0]?.evidenceRevision ?? 0) < 1 ||
      scope.evidence[0]?.evidenceRevision !== scope.assertion.evidenceRevision ||
      !eligibleOwnerFamilyCorrection(scope)
    )
      return null;

    const projection = ownerFamilyEditorProjection(scope, input.entities, input.contacts);
    if (!projection || !exactEndpointRows(scope, projection, input.entities, input.contacts))
      return null;

    const evidence = scope.evidence[0];
    if (!evidence) return null;
    return {
      action: 'reject_recorded_claim',
      ownerId: request.ownerId,
      expectedNativeScopeHash: request.expectedNativeScopeHash,
      target: {
        relation: {
          id: scope.relation.id,
          assertionId: scope.assertion.id,
          sourceMemoryId: scope.source.id,
        },
        assertion: {
          id: scope.assertion.id,
          semanticRevision: scope.assertion.semanticRevision,
          evidenceRevision: scope.assertion.evidenceRevision,
        },
        evidence: {
          id: evidence.id,
          assertionId: evidence.assertionId,
          sourceMemoryId: evidence.sourceMemoryId,
          sourceContentHash: evidence.sourceContentHash,
          evidenceRevision: evidence.evidenceRevision,
        },
      },
      retained: {
        subjectContactId: projection.original.subjectContactId,
        objectContactId: projection.original.objectContactId,
        sourceMemoryId: scope.source.id,
        sourceContentHash: scope.source.contentHash,
        sourceText: scope.source.content,
        sourceDisposition: 'retain_saved_source_note',
      },
      writerRequirements: OWNER_FAMILY_REMOVAL_WRITER_REQUIREMENTS,
    };
  } catch {
    // Malformed snapshots and throwing accessors are unknown, never authority.
    return null;
  }
}
