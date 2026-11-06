import type {
  OwnerEditorCorrectionEligibility,
  OwnerEditorScope,
} from '@assistant/persistence/owner-editor';
import type { OwnerEditorControlsProps } from '@/app/people/owner-editor-controls';
import { verifyOwnerEditorHandle } from './owner-editor-scope';

/** Bind only the selected removal to its exact operation and displayed native scope.
 * Other rows remain navigation links, avoiding a per-row closure scan on a dossier.
 */
export async function bindSelectedFamilyRemoval(input: {
  editor: OwnerEditorControlsProps | null;
  selectedRelationId: string | null;
  secret: string;
  now?: number;
  review(
    scope: OwnerEditorScope,
    eligibility: OwnerEditorCorrectionEligibility,
  ): Promise<{ revision: string } | null>;
}): Promise<OwnerEditorControlsProps | null> {
  const { editor } = input;
  if (!editor) return null;
  const candidate = editor.removals?.find(
    (entry) => entry.eligibility.relationId === input.selectedRelationId,
  );
  const withoutRemoval = { ...editor, removals: [] };
  if (!candidate) return withoutRemoval;
  const verified = verifyOwnerEditorHandle({
    token: candidate.grant.issuedOperationHandle,
    session: editor.session,
    secret: input.secret,
    now: input.now,
  });
  if (
    verified.kind !== 'verified' ||
    verified.formExpired ||
    verified.scope.command !== 'remove_owner_family_relationship' ||
    candidate.grant.command !== verified.scope.command ||
    verified.scope.targetId !== candidate.eligibility.relationId ||
    verified.scope.operationId !== candidate.grant.operationId
  )
    return withoutRemoval;
  try {
    const reviewed = await input.review(verified.scope, candidate.eligibility);
    if (!reviewed || !/^[a-f0-9]{64}$/.test(reviewed.revision)) return withoutRemoval;
    return {
      ...withoutRemoval,
      removals: [
        {
          grant: candidate.grant,
          eligibility: { ...candidate.eligibility, revision: reviewed.revision },
        },
      ],
    };
  } catch {
    return withoutRemoval;
  }
}
