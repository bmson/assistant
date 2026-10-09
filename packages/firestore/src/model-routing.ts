import { randomUUID } from 'node:crypto';
import type {
  ModelAuditWrite,
  ModelCallWrite,
  ModelRoutingRepository,
  Records,
} from '@assistant/persistence';
import {
  microsToUsd,
  storedLedgerUsdToMicros,
  storedTaskBudgetToMicros,
} from '@assistant/persistence';
import type { Transaction } from '@google-cloud/firestore';
import { FirestoreCostRepository } from './costs.js';
import { decodeRecord, encodeRecord, type InstallationStore } from './store.js';

export class FirestoreModelRoutingRepository implements ModelRoutingRepository {
  readonly kind = 'model-routing-repository' as const;
  readonly costs: FirestoreCostRepository;

  constructor(
    private readonly store: InstallationStore,
    private readonly agentId: string,
  ) {
    if (!agentId) throw new Error('Model routing requires an agent identity');
    this.costs = new FirestoreCostRepository(store);
  }

  private async task(taskId: string, tx?: Transaction): Promise<Records['tasks']> {
    const ref = this.store.doc('tasks', taskId);
    const snapshot = tx ? await tx.get(ref) : await ref.get();
    const row = decodeRecord<Records['tasks']>(snapshot.data());
    if (!snapshot.exists || row.id !== taskId || row.agentId !== this.agentId)
      throw new Error('Model routing task is missing or outside the owner scope');
    return row;
  }

  async taskBudget(taskId: string) {
    const row = await this.task(taskId);
    const limitMicros = storedTaskBudgetToMicros(row.budgetUsdLimit);
    const spentMicros = storedLedgerUsdToMicros(row.spentUsd);
    return {
      limit: (limitMicros / 1_000_000).toFixed(4),
      spent: (spentMicros / 1_000_000).toFixed(6),
    };
  }

  async conversationOverride(taskId: string): Promise<string | null> {
    const task = await this.task(taskId);
    if (task.type !== 'chat_turn' || !task.conversationId) return null;
    const snapshot = await this.store.doc('conversations', task.conversationId).get();
    const row = decodeRecord<Records['conversations']>(snapshot.data());
    if (!snapshot.exists || row.id !== task.conversationId || row.agentId !== this.agentId)
      throw new Error('Model routing conversation is missing or outside the owner scope');
    return row.modelOverride;
  }

  async role(role: string): Promise<Records['modelRoles'] | null> {
    const snapshot = await this.store.doc('modelRoles', role).get();
    if (!snapshot.exists) return null;
    const row = decodeRecord<Records['modelRoles']>(snapshot.data());
    if (row.role !== role) throw new Error('Model role identity mismatch');
    return row;
  }

  async model(modelId: string): Promise<Records['models'] | null> {
    const snapshot = await this.store.doc('models', modelId).get();
    if (!snapshot.exists) return null;
    const row = decodeRecord<Records['models']>(snapshot.data());
    if (row.id !== modelId) throw new Error('Model identity mismatch');
    return row;
  }

  async recordCall(input: ModelCallWrite): Promise<string> {
    const costUsd = microsToUsd(storedLedgerUsdToMicros(input.costUsd)).toFixed(6);
    const id = randomUUID();
    await this.store.db.runTransaction(async (tx) => {
      if (input.taskId) await this.task(input.taskId, tx);
      tx.create(
        this.store.doc('modelCalls', id),
        encodeRecord({
          ...input,
          costUsd,
          agentId: this.agentId,
          taskId: input.taskId ?? null,
          latencyMs: input.latencyMs ?? null,
          finishReason: input.finishReason ?? null,
          openrouterGenerationId: input.openrouterGenerationId ?? null,
          runtimeRevision: input.runtimeRevision ?? null,
          runtimeReleaseSha: input.runtimeReleaseSha ?? null,
          id,
          createdAt: this.store.now(),
        }),
      );
    });
    return id;
  }

  async recordAudit(input: ModelAuditWrite): Promise<void> {
    const id = randomUUID();
    await this.store.db.runTransaction(async (tx) => {
      if (input.taskId) await this.task(input.taskId, tx);
      if (input.modelCallId) {
        const snapshot = await tx.get(this.store.doc('modelCalls', input.modelCallId));
        const call = decodeRecord<Records['modelCalls']>(snapshot.data());
        if (
          !snapshot.exists ||
          call.id !== input.modelCallId ||
          call.taskId !== (input.taskId ?? null) ||
          call.model !== input.model ||
          call.role !== input.role
        )
          throw new Error('Model audit does not match its call');
      }
      tx.create(
        this.store.doc('modelCallAudit', id),
        encodeRecord({
          ...input,
          taskId: input.taskId ?? null,
          modelCallId: input.modelCallId ?? null,
          finishReason: input.finishReason ?? null,
          latencyMs: input.latencyMs ?? null,
          id,
          createdAt: this.store.now(),
        }),
      );
    });
  }
}
