import type { WorkspaceImprovementRepository } from '@assistant/persistence';

/** The improvement item already returned by GET /api/mobile/v1/workspace. */
export interface MobileWorkspaceImprovement {
  id: string;
  kind: string;
  title: string;
  rationale: string;
  suggestion: string;
  evidenceCount: number;
  applyable: boolean;
  createdAt: string;
}

/** Preview routing changes without validating or applying the proposal. */
export function improvementProposalSuggestion(kind: string, change: unknown): string {
  const fields =
    change !== null && typeof change === 'object' ? (change as Record<string, unknown>) : {};
  const advisory = typeof fields.suggestion === 'string' ? fields.suggestion : '';
  if (kind !== 'model_role') return advisory;

  const display = (value: unknown): string => {
    if (value === undefined) return '<omitted>';
    if (value === null) return '<null>';
    if (typeof value !== 'string') return '<invalid>';
    return value.trim() ? value : '<empty>';
  };
  const routing = `Change role '${display(fields.role)}': primary => ${display(fields.primaryModel)}, fallback => ${display(fields.fallbackModel)}`;
  return advisory ? `${routing}\n\nAdvisory: ${advisory}` : routing;
}

export async function listMobileWorkspaceImprovements(
  repository: WorkspaceImprovementRepository,
  agentId: string,
): Promise<MobileWorkspaceImprovement[]> {
  const proposals = await repository.listOpen(agentId);
  return proposals.map((proposal) => ({
    id: proposal.id,
    kind: proposal.kind,
    title: proposal.title,
    rationale: proposal.rationale,
    suggestion: improvementProposalSuggestion(proposal.kind, proposal.change),
    evidenceCount: proposal.evidenceIds.length,
    applyable: proposal.kind === 'model_role',
    createdAt: proposal.createdAt.toISOString(),
  }));
}
