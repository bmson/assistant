import { isRoutableModel, MODEL_ROLE_NAMES } from './model-routing.js';
import type { Records } from './records.js';

/** Data needed to render the mobile workspace's open improvement proposals. */
export interface WorkspaceImprovementRecord {
  id: string;
  kind: 'model_role' | 'policy' | 'prompt' | 'note';
  title: string;
  rationale: string;
  change: Record<string, unknown>;
  evidenceIds: string[];
  createdAt: Date;
}

export interface WorkspaceImprovementRepository {
  readonly kind: 'workspace-improvement-repository';
  /** Matches the PostgreSQL dashboard's newest 100 open proposals. */
  listOpen(agentId: string): Promise<WorkspaceImprovementRecord[]>;
}
/** Legacy proposal status `applied` also stores advisory acknowledgments. */
export interface ImprovementActionResult {
  outcome: 'applied' | 'acknowledged' | 'dismissed' | 'already_decided' | 'already_current';
  enacted: boolean;
  detail: string;
}

export interface ImprovementModelChange {
  role: string;
  primaryModel?: string;
  fallbackModel?: string;
}

/** Refuse an incomplete proposal instead of silently applying its valid subset. */
export function improvementModelChange(
  change: Record<string, unknown>,
  evidenceIds: readonly string[],
): ImprovementModelChange {
  if (!evidenceIds.some((id) => id.trim().length > 0))
    throw new Error('Model change needs cited evidence. Review or dismiss this proposal.');
  const role = typeof change.role === 'string' ? change.role : '';
  if (!(MODEL_ROLE_NAMES as readonly string[]).includes(role))
    throw new Error('Proposed model role is not configured. Review or dismiss this proposal.');
  for (const field of ['primaryModel', 'fallbackModel'] as const) {
    const value = change[field];
    if (value !== undefined && (typeof value !== 'string' || (value.length > 0 && !value.trim())))
      throw new Error(`Proposed ${field} must be a model ID. Review or dismiss this proposal.`);
  }
  const primaryModel = typeof change.primaryModel === 'string' ? change.primaryModel : '';
  const fallbackModel = typeof change.fallbackModel === 'string' ? change.fallbackModel : '';
  if (!primaryModel && !fallbackModel)
    throw new Error('Proposal does not name a model to change. Review or dismiss it.');
  return {
    role,
    ...(primaryModel ? { primaryModel } : {}),
    ...(fallbackModel ? { fallbackModel } : {}),
  };
}

export function validateImprovementModels(
  change: ImprovementModelChange,
  models: readonly Records['models'][],
): void {
  for (const id of new Set([change.primaryModel, change.fallbackModel].filter(Boolean))) {
    const model = models.find((row) => row.id === id);
    if (!isRoutableModel(model))
      throw new Error(
        `Proposed model ${id} is not enabled with prices. Update AI providers or dismiss this proposal.`,
      );
    const embedding = (model?.capabilities as { embedding?: boolean } | null)?.embedding === true;
    if (change.role === 'embed' ? !embedding : embedding)
      throw new Error(`Proposed model ${id} cannot serve the ${change.role} role.`);
  }
}
