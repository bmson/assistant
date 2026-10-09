import {
  type ModelRoutingRepository,
  microsToUsd,
  storedLedgerUsdToMicros,
} from '@assistant/persistence';
import { and, eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { createPostgresCostRepository } from './cost-repository.js';
import { conversations, modelCallAudit, modelCalls, modelRoles, models, tasks } from './schema.js';

/** Preserves the current PostgreSQL router's installation-wide configuration. */
export function createPostgresModelRoutingRepository(db: Db): ModelRoutingRepository {
  return {
    kind: 'model-routing-repository',
    costs: createPostgresCostRepository(db),
    async taskBudget(taskId) {
      const [task] = await db
        .select({ limit: tasks.budgetUsdLimit, spent: tasks.spentUsd })
        .from(tasks)
        .where(eq(tasks.id, taskId));
      return task ?? null;
    },
    async conversationOverride(taskId) {
      const [conversation] = await db
        .select({ modelOverride: conversations.modelOverride })
        .from(tasks)
        .innerJoin(conversations, eq(tasks.conversationId, conversations.id))
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.type, 'chat_turn'),
            eq(tasks.agentId, conversations.agentId),
          ),
        );
      return conversation?.modelOverride ?? null;
    },
    async role(role) {
      const [row] = await db.select().from(modelRoles).where(eq(modelRoles.role, role));
      return row ?? null;
    },
    async model(modelId) {
      const [row] = await db.select().from(models).where(eq(models.id, modelId));
      return row ?? null;
    },
    async recordCall(input) {
      const costUsd = microsToUsd(storedLedgerUsdToMicros(input.costUsd)).toFixed(6);
      const [row] = await db
        .insert(modelCalls)
        .values({ runtimeRevision: null, runtimeReleaseSha: null, ...input, costUsd })
        .returning({ id: modelCalls.id });
      if (!row) throw new Error('Model call telemetry was not persisted');
      return row.id;
    },
    async recordAudit(input) {
      await db.insert(modelCallAudit).values(input);
    },
  };
}
