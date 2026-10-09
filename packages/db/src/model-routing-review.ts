import { createHash } from 'node:crypto';
import type { Records } from '@assistant/persistence';

function stateSummary(value: unknown) {
  const state = value as Partial<Records['modelRoles']> | null;
  if (!state || typeof state !== 'object') return null;
  return {
    primaryModel: typeof state.primaryModel === 'string' ? state.primaryModel : null,
    fallbackModel: typeof state.fallbackModel === 'string' ? state.fallbackModel : null,
    paramsSha256:
      state.params === undefined
        ? null
        : createHash('sha256').update(JSON.stringify(state.params)).digest('hex'),
  };
}

export function modelRoutingReviewReport(revisions: readonly Records['modelRoleRevisions'][]) {
  return {
    automaticChanges: false,
    rows: revisions
      .filter((revision) => revision.requiresOwnerReview)
      .map((revision) => ({
        revisionId: revision.id,
        role: revision.role,
        source: revision.source,
        createdAt: revision.createdAt.toISOString(),
        baselineCaptured: revision.baselineKnown,
        rollbackEligibility: revision.baselineKnown
          ? 'conditional_on_current_models_being_enabled_and_priced'
          : 'unavailable',
        before: stateSummary(revision.beforeState),
        after: stateSummary(revision.afterState),
        historicalPre0019ExtractChoiceKnown: !(
          revision.role === 'extract' && revision.source === 'retired-route-repair'
        ),
        reviewReason:
          revision.role === 'extract' && revision.source === 'retired-route-repair'
            ? 'The immutable 0019 migration may have overwritten an earlier extract choice; it cannot be reconstructed from the current row.'
            : 'A retired model route was repaired while preserving the other route leg and parameters.',
      })),
  };
}
