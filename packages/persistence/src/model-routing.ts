import type { CostRepository } from './contracts.js';
import type { Records } from './records.js';

type OptionalCallFields =
  | 'taskId'
  | 'latencyMs'
  | 'finishReason'
  | 'openrouterGenerationId'
  | 'runtimeRevision'
  | 'runtimeReleaseSha';
export type ModelCallWrite = Omit<Records['modelCalls'], 'id' | 'createdAt' | OptionalCallFields> &
  Partial<Pick<Records['modelCalls'], OptionalCallFields>>;
type OptionalAuditFields = 'modelCallId' | 'taskId' | 'finishReason' | 'latencyMs';
export type ModelAuditWrite = Omit<
  Records['modelCallAudit'],
  'id' | 'createdAt' | OptionalAuditFields
> &
  Partial<Pick<Records['modelCallAudit'], OptionalAuditFields>>;

/** Every routed model role an installation must configure. */
export const MODEL_ROLE_NAMES = [
  'plan',
  'classify',
  'extract',
  'draft',
  'reason',
  'rewrite',
  'embed',
  'batch',
] as const;

/** Routing configuration and telemetry within one installation's accounting boundary. */
export interface ModelRoutingRepository {
  readonly kind: 'model-routing-repository';
  readonly costs: CostRepository;
  taskBudget(taskId: string): Promise<{ limit: string; spent: string } | null>;
  conversationOverride(taskId: string): Promise<string | null>;
  role(role: string): Promise<Records['modelRoles'] | null>;
  model(modelId: string): Promise<Records['models'] | null>;
  recordCall(input: ModelCallWrite): Promise<string>;
  recordAudit(input: ModelAuditWrite): Promise<void>;
}

/** What the settings layer writes. `apiKeyEncrypted: undefined` keeps the stored key. */
export interface ModelConnectionWrite {
  id: string;
  kind: string;
  label: string;
  baseUrl: string | null;
  apiKeyEncrypted?: string | null;
  vertexProject: string | null;
  vertexLocation: string | null;
  enabled: boolean;
}

/**
 * The owner's connected model providers, installation-wide like the model
 * catalog they serve. Rows carry the sealed API key, so this repository is
 * for the router and the settings layer only; owner-facing reads must project
 * the key away (`hasApiKey`).
 */
export interface ModelConnectionRepository {
  readonly kind: 'model-connection-repository';
  list(): Promise<Records['modelConnections'][]>;
  upsert(input: ModelConnectionWrite): Promise<Records['modelConnections']>;
  setEnabled(id: string, enabled: boolean): Promise<boolean>;
  recordTest(id: string, result: { ok: boolean; error?: string }): Promise<boolean>;
  remove(id: string): Promise<boolean>;
}

export type ModelCatalogWrite = Omit<Records['models'], 'createdAt' | 'updatedAt'>;

export interface ModelRoleAssignment {
  role: string;
  primaryModel: string;
  fallbackModel: string;
}

export interface ModelRoleState {
  primaryModel: string;
  fallbackModel: string;
  params: unknown;
}

export type ModelRoleRevision = Records['modelRoleRevisions'];

/**
 * The owner-editable model catalog: which models exist, what they cost, and
 * which one each role routes to. Role assignments are applied atomically and
 * only to enabled, priced models, so the router can never be pointed at a
 * model it would refuse to call.
 */
export interface ModelCatalogRepository {
  readonly kind: 'model-catalog-repository';
  listModels(): Promise<Records['models'][]>;
  listRoles(): Promise<Records['modelRoles'][]>;
  listRoleRevisions(role?: string): Promise<ModelRoleRevision[]>;
  rollbackRoleRevision(revisionId: string): Promise<boolean>;
  upsertModel(input: ModelCatalogWrite): Promise<void>;
  assignRoles(assignments: readonly ModelRoleAssignment[]): Promise<void>;
  /**
   * Point the optional `voice` role (live phone calls) at a model, creating the
   * role on first use. Refuses a model that is not enabled with prices.
   */
  setVoiceModel(modelId: string): Promise<void>;
}

/** A model the router can call: enabled and carrying both cost rates. */
export function isRoutableModel(model: Records['models'] | null | undefined): boolean {
  if (!model?.enabled) return false;
  const prompt = Number(model.promptCostPerMTok);
  const completion = Number(model.completionCostPerMTok);
  return (
    model.promptCostPerMTok !== null &&
    model.completionCostPerMTok !== null &&
    !(typeof model.promptCostPerMTok === 'string' && model.promptCostPerMTok.trim() === '') &&
    !(
      typeof model.completionCostPerMTok === 'string' && model.completionCostPerMTok.trim() === ''
    ) &&
    Number.isFinite(prompt) &&
    Number.isFinite(completion) &&
    prompt >= 0 &&
    completion >= 0
  );
}
