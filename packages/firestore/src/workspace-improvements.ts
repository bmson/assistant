import {
  type ImprovementActionResult,
  improvementModelChange,
  type Records,
  validateImprovementModels,
  type WorkspaceImprovementRecord,
  type WorkspaceImprovementRepository,
} from '@assistant/persistence';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const MAX_OWNER_PROPOSALS = 2_000;
const MOBILE_RESULT_LIMIT = 100;
const FIELDS = [
  'id',
  'agentId',
  'status',
  'kind',
  'title',
  'rationale',
  'change',
  'evidenceIds',
  'createdAt',
] as const;

function fromDocument(
  value: unknown,
  documentId: string,
  agentId: string,
): WorkspaceImprovementRecord | null {
  const row = decodeRecord<Record<string, unknown>>(value);
  if (
    row.agentId !== agentId ||
    typeof row.id !== 'string' ||
    documentKey(row.id) !== documentId ||
    !['open', 'applied', 'dismissed'].includes(String(row.status))
  )
    throw new Error('Invalid owner improvement document');
  if (row.status !== 'open') return null;
  if (
    !['model_role', 'policy', 'prompt', 'note'].includes(String(row.kind)) ||
    typeof row.title !== 'string' ||
    typeof row.rationale !== 'string' ||
    !row.change ||
    typeof row.change !== 'object' ||
    Array.isArray(row.change) ||
    !Array.isArray(row.evidenceIds) ||
    !row.evidenceIds.every((id) => typeof id === 'string') ||
    !(row.createdAt instanceof Date) ||
    !Number.isFinite(row.createdAt.getTime())
  )
    throw new Error('Invalid open improvement document');
  return {
    id: row.id,
    kind: row.kind as WorkspaceImprovementRecord['kind'],
    title: row.title,
    rationale: row.rationale,
    change: row.change as Record<string, unknown>,
    evidenceIds: row.evidenceIds,
    createdAt: row.createdAt,
  };
}

/** One owner-indexed scan avoids a composite index and never silently cuts off older rows. */
export class FirestoreWorkspaceImprovementRepository implements WorkspaceImprovementRepository {
  readonly kind = 'workspace-improvement-repository' as const;

  constructor(readonly store: InstallationStore) {}

  /**
   * Apply or dismiss one owner proposal with the same effects as the
   * PostgreSQL workflow: advisory proposals are acknowledged, and an
   * evidence-backed `model_role` proposal swaps the role to enabled models in
   * the same transaction that marks it applied.
   */
  async applyAction(
    configuredAgentId: string,
    proposalId: string,
    action: 'apply' | 'dismiss',
  ): Promise<ImprovementActionResult> {
    if (!configuredAgentId) throw new Error('agent is required');
    const proposalRef = this.store.doc('improvementProposals', proposalId);
    const ownerRef = this.store.doc('agents', configuredAgentId);
    const erasureRef = this.store.doc('privacyErasureJobs', configuredAgentId);

    return this.store.db.runTransaction(async (tx) => {
      const owners = await tx.get(this.store.collection('agents').limit(2));
      if (
        owners.size !== 1 ||
        owners.docs[0]?.get('id') !== configuredAgentId ||
        owners.docs[0]?.id !== ownerRef.id
      )
        throw new Error('Improvement action requires exactly one configured owner');

      const [proposal, erasure] = await tx.getAll(proposalRef, erasureRef);
      if (erasure?.exists) {
        if (erasure.get('agentId') !== configuredAgentId || erasure.get('status') !== 'complete')
          throw new Error('Privacy erasure is in progress');
      }
      if (!proposal?.exists) throw new Error('Improvement proposal not found');
      const row = decodeRecord<Record<string, unknown>>(proposal.data());
      if (
        row.agentId !== configuredAgentId ||
        row.id !== proposalId ||
        proposal.id !== documentKey(proposalId)
      )
        throw new Error('Improvement proposal belongs to another agent');
      if (!['open', 'applied', 'dismissed'].includes(String(row.status)))
        throw new Error('Invalid improvement proposal status');

      if (row.status !== 'open')
        return {
          outcome: 'already_decided',
          enacted: false,
          detail: 'This proposal already has a recorded decision. No change was made.',
        };
      if (action === 'dismiss') {
        tx.update(proposalRef, { status: 'dismissed', updatedAt: this.store.now() });
        return { outcome: 'dismissed', enacted: false, detail: 'Proposal dismissed.' };
      }
      if (!['model_role', 'policy', 'prompt', 'note'].includes(String(row.kind)))
        throw new Error('Invalid improvement proposal kind');
      if (
        typeof row.title !== 'string' ||
        typeof row.rationale !== 'string' ||
        !row.change ||
        typeof row.change !== 'object' ||
        Array.isArray(row.change) ||
        !Array.isArray(row.evidenceIds) ||
        !row.evidenceIds.every((value) => typeof value === 'string')
      )
        throw new Error('Invalid improvement proposal');
      let result: ImprovementActionResult = {
        outcome: 'acknowledged',
        enacted: false,
        detail: 'Suggestion noted. No settings or code were changed.',
      };
      if (row.kind === 'model_role') {
        const change = improvementModelChange(
          row.change as Record<string, unknown>,
          row.evidenceIds as string[],
        );
        const swap = await this.modelRoleSwap(tx, change);
        if (swap.changed) {
          tx.update(swap.ref, { ...swap.patch, updatedAt: this.store.now() });
          result = {
            outcome: 'applied',
            enacted: true,
            detail: `Updated ${change.role} model routing. Future calls will use this configuration.`,
          };
        } else {
          result = {
            outcome: 'already_current',
            enacted: false,
            detail: `The ${change.role} role already uses the proposed models. No routing change was needed.`,
          };
        }
      }
      // Policy, prompt, and note proposals are advisory in the SQL workflow;
      // approval only acknowledges the proposal and changes its status.
      tx.update(proposalRef, { status: 'applied', updatedAt: this.store.now() });
      return result;
    });
  }

  /**
   * Resolve the entire proposal; failed validation leaves both records intact.
   */
  private async modelRoleSwap(
    tx: FirebaseFirestore.Transaction,
    change: ReturnType<typeof improvementModelChange>,
  ): Promise<{
    ref: FirebaseFirestore.DocumentReference;
    patch: { primaryModel?: string; fallbackModel?: string };
    changed: boolean;
  }> {
    const { role, primaryModel, fallbackModel } = change;
    const wanted = [
      ...new Set([primaryModel, fallbackModel].filter((id): id is string => Boolean(id))),
    ];
    const roleRef = this.store.doc('modelRoles', role);
    const [roleSnapshot, ...models] = await tx.getAll(
      roleRef,
      ...wanted.map((id) => this.store.doc('models', id)),
    );
    const validModels = models
      .filter(
        (model) =>
          model?.exists &&
          typeof model.get('id') === 'string' &&
          documentKey(model.get('id')) === model.id,
      )
      .map((model) => decodeRecord<Records['models']>(model?.data()));
    validateImprovementModels(change, validModels);
    const patch: { primaryModel?: string; fallbackModel?: string } = {};
    if (primaryModel) patch.primaryModel = primaryModel;
    if (fallbackModel) patch.fallbackModel = fallbackModel;
    if (!roleSnapshot?.exists)
      throw new Error('Proposed model role is not configured. Review or dismiss this proposal.');
    if (roleSnapshot.get('role') !== role) throw new Error('Model role identity mismatch');
    const changed = Boolean(
      (primaryModel && primaryModel !== roleSnapshot.get('primaryModel')) ||
        (fallbackModel && fallbackModel !== roleSnapshot.get('fallbackModel')),
    );
    return { ref: roleRef, patch, changed };
  }

  async listOpen(agentId: string): Promise<WorkspaceImprovementRecord[]> {
    if (!agentId) throw new Error('agent is required');
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const snapshot = await this.store
      .collection('improvementProposals')
      .where('agentId', '==', agentId)
      .select(...FIELDS)
      .limit(MAX_OWNER_PROPOSALS + 1)
      .get();
    if (snapshot.size > MAX_OWNER_PROPOSALS)
      throw new Error('Owner improvements exceed the mobile workspace scan limit');
    const result = snapshot.docs
      .map((doc) => fromDocument(doc.data(), doc.id, agentId))
      .filter((row): row is WorkspaceImprovementRecord => row !== null)
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || left.id.localeCompare(right.id),
      )
      .slice(0, MOBILE_RESULT_LIMIT);
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return result;
  }
}
