import {
  type EmbeddingSpace,
  embeddingModelId,
  MODEL_ROLE_NAMES as REQUIRED_ROLES,
  snapshotEmbeddingSpace,
} from '@assistant/persistence';
import type { InstallationStore } from './store.js';

export interface RuntimeDataIssue {
  code:
    | 'agent_missing'
    | 'agent_invalid'
    | 'budget_policy_missing'
    | 'budget_policy_invalid'
    | 'role_missing'
    | 'role_invalid'
    | 'model_missing'
    | 'model_invalid'
    | 'embedding_space_invalid'
    | 'embedding_mismatch';
  /** Identifies a role or model, never owner content or a credential. */
  subject: string;
}

export interface RuntimeDataPreflight {
  ready: boolean;
  issues: RuntimeDataIssue[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validMicros(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validPrice(value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  if (typeof value === 'string' && !value.trim()) return false;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0;
}

function matchesProvider(modelId: string, provider: 'vertex' | 'openrouter'): boolean {
  const isVertex = /^vertex[/:][A-Za-z0-9][A-Za-z0-9._@-]*$/i.test(modelId);
  if (provider === 'vertex') return isVertex;
  return (
    !/^(?:vertex(?:[/:]|$)|google:|projects\/[^/]+\/locations\/[^/]+\/publishers\/[^/]+\/models\/)/i.test(
      modelId,
    ) && modelId.length > 0
  );
}

/**
 * Read only the fixed, small set of records needed before a minimal runtime
 * starts. This checks configuration presence and internal consistency; a live
 * Vertex request, IAM, indexes, and a complete application smoke remain
 * separate installation gates.
 */
export async function checkFirestoreRuntimeData(
  store: InstallationStore,
  input: {
    agentId: string;
    provider: 'vertex' | 'openrouter';
    embeddingSpace: EmbeddingSpace;
  },
): Promise<RuntimeDataPreflight> {
  const issues: RuntimeDataIssue[] = [];
  const add = (code: RuntimeDataIssue['code'], subject: string) => issues.push({ code, subject });
  let embeddingSpace: EmbeddingSpace | undefined;
  try {
    embeddingSpace = snapshotEmbeddingSpace(input.embeddingSpace);
  } catch {
    // Return the ordinary typed preflight issue instead of throwing on config.
  }
  if (!embeddingSpace || (input.provider === 'vertex' && embeddingSpace.provider !== 'vertex')) {
    add('embedding_space_invalid', 'embedding-space');
  }
  const [agent, policy, ...roles] = await Promise.all([
    store.doc('agents', input.agentId).get(),
    store.doc('coordination', 'budget-policy').get(),
    ...REQUIRED_ROLES.map((role) => store.doc('modelRoles', role).get()),
  ]);

  if (!agent.exists) add('agent_missing', 'configured-agent');
  else {
    const value = record(agent.data());
    if (value?.id !== input.agentId || typeof value.name !== 'string' || !value.name.trim()) {
      add('agent_invalid', 'configured-agent');
    }
  }

  if (!policy.exists) add('budget_policy_missing', 'budget-policy');
  else {
    const value = record(policy.data());
    if (
      !validMicros(value?.dailyLimitMicros) ||
      !validMicros(value?.monthlyLimitMicros) ||
      typeof value?.softPct !== 'number' ||
      !Number.isInteger(value.softPct) ||
      value.softPct < 0 ||
      value.softPct > 100
    ) {
      add('budget_policy_invalid', 'budget-policy');
    }
  }

  const modelIds = new Set<string>();
  for (const [index, role] of REQUIRED_ROLES.entries()) {
    const snapshot = roles[index];
    if (!snapshot?.exists) {
      add('role_missing', role);
      continue;
    }
    const value = record(snapshot.data());
    const primary = value?.primaryModel;
    const fallback = value?.fallbackModel;
    if (
      value?.role !== role ||
      typeof primary !== 'string' ||
      typeof fallback !== 'string' ||
      !matchesProvider(primary, input.provider) ||
      !matchesProvider(fallback, input.provider)
    ) {
      add('role_invalid', role);
      continue;
    }
    modelIds.add(primary);
    modelIds.add(fallback);
    if (role === 'embed' && embeddingSpace && primary !== embeddingModelId(embeddingSpace)) {
      add('embedding_mismatch', 'embed');
    }
  }

  for (const modelId of [...modelIds].sort()) {
    const snapshot = await store.doc('models', modelId).get();
    if (!snapshot.exists) {
      add('model_missing', modelId);
      continue;
    }
    const value = record(snapshot.data());
    if (
      value?.id !== modelId ||
      value.enabled !== true ||
      !validPrice(value.promptCostPerMTok) ||
      !validPrice(value.completionCostPerMTok)
    ) {
      add('model_invalid', modelId);
    }
  }

  return { ready: issues.length === 0, issues };
}
