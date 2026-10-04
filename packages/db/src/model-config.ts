import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { conversations, modelRoles, models } from './schema.js';

// OpenRouter catalog checked 2026-09-08. Prices are USD/million tokens and
// reservation estimates; provider-reported usage.cost remains authoritative.
const chat = (vision: boolean) => ({
  tools: true,
  vision,
  json: true,
  streaming: true,
  thinking: true,
});

export const modelDefaults = [
  // Explicit conversation choices; role defaults below stay unchanged until
  // this installation's task-level comparison establishes a better choice.
  {
    id: 'openai/gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    capabilities: chat(true),
    promptCostPerMTok: '2.00',
    completionCostPerMTok: '10.00',
    latencyClass: 'medium',
  },
  {
    id: 'openai/gpt-6-luna',
    label: 'GPT-6 Luna',
    capabilities: chat(true),
    promptCostPerMTok: '0.10',
    completionCostPerMTok: '0.50',
    latencyClass: 'fast',
  },
  {
    id: 'minimax/minimax-m2.7',
    label: 'MiniMax M2.7',
    capabilities: chat(false),
    promptCostPerMTok: '0.30',
    completionCostPerMTok: '1.20',
    latencyClass: 'medium',
  },
  {
    id: 'google/gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    capabilities: chat(true),
    promptCostPerMTok: '0.75',
    completionCostPerMTok: '3.75',
    latencyClass: 'fast',
  },
  {
    id: 'deepseek/deepseek-v4-pro-0813',
    label: 'DeepSeek V4 Pro 0813',
    capabilities: chat(false),
    promptCostPerMTok: '1.32',
    completionCostPerMTok: '3.96',
    latencyClass: 'slow',
  },
  {
    id: 'deepseek/deepseek-v4-flash-0731',
    label: 'DeepSeek V4 Flash 0731',
    capabilities: chat(false),
    promptCostPerMTok: '0.14',
    completionCostPerMTok: '0.28',
    latencyClass: 'fast',
  },
  {
    id: 'openai/gpt-oss-120b',
    label: 'GPT-OSS 120B',
    capabilities: chat(false),
    promptCostPerMTok: '0.15',
    completionCostPerMTok: '0.60',
    latencyClass: 'fast',
  },
  {
    id: 'moonshotai/kimi-k2.5',
    label: 'Kimi K2.5',
    capabilities: chat(true),
    promptCostPerMTok: '0.60',
    completionCostPerMTok: '3.00',
    latencyClass: 'medium',
  },
  {
    id: 'moonshotai/kimi-k2.6',
    label: 'Kimi K2.6',
    capabilities: chat(true),
    promptCostPerMTok: '0.95',
    completionCostPerMTok: '4.00',
    latencyClass: 'medium',
  },
  {
    id: 'moonshotai/kimi-k3',
    label: 'Kimi K3 — hard problems',
    capabilities: chat(true),
    promptCostPerMTok: '3.00',
    completionCostPerMTok: '15.00',
    latencyClass: 'slow',
  },
  {
    id: 'openai/text-embedding-3-small',
    label: 'OpenAI Text Embedding 3 Small',
    capabilities: { embedding: true },
    promptCostPerMTok: '0.02',
    completionCostPerMTok: '0',
    latencyClass: 'fast',
  },
] as const;

const flash = 'deepseek/deepseek-v4-flash-0731';
const fallback = 'openai/gpt-oss-120b';
const deterministic = { temperature: 0 };

// K3 is deliberately opt-in through the conversation model picker. Budget
// fallback must never silently escalate a routine request onto K3's rates.
export const modelRoleDefaults = [
  {
    role: 'plan',
    primaryModel: 'deepseek/deepseek-v4-pro-0813',
    fallbackModel: fallback,
    params: deterministic,
  },
  { role: 'classify', primaryModel: flash, fallbackModel: fallback, params: deterministic },
  { role: 'extract', primaryModel: flash, fallbackModel: fallback, params: deterministic },
  { role: 'draft', primaryModel: 'google/gemini-3.8-flash', fallbackModel: fallback, params: {} },
  { role: 'reason', primaryModel: 'minimax/minimax-m2.7', fallbackModel: fallback, params: {} },
  { role: 'batch', primaryModel: flash, fallbackModel: fallback, params: {} },
  { role: 'rewrite', primaryModel: flash, fallbackModel: fallback, params: {} },
  {
    role: 'embed',
    primaryModel: 'openai/text-embedding-3-small',
    fallbackModel: 'openai/text-embedding-3-small',
    params: {},
  },
] as const;

const retired = ['qwen/qwen3-30b-a3b-instruct-2507', 'deepseek/deepseek-chat'];

/** Upgrade old installations without undoing subsequent owner routing choices. */
export async function reconcileModelConfig(db: Db, resetRoles = false): Promise<void> {
  await db.transaction(async (tx) => {
    for (const model of modelDefaults) {
      const values = { ...model, capabilities: { ...model.capabilities } };
      await tx
        .insert(models)
        .values(values)
        .onConflictDoUpdate({
          target: models.id,
          set: { ...values, ...(resetRoles ? { enabled: true } : {}), updatedAt: sql`now()` },
        });
    }
    for (const role of modelRoleDefaults) {
      await tx.insert(modelRoles).values(role).onConflictDoNothing();
      await tx
        .update(modelRoles)
        .set({ ...role, updatedAt: sql`now()` })
        .where(
          and(
            eq(modelRoles.role, role.role),
            resetRoles
              ? undefined
              : or(
                  inArray(modelRoles.primaryModel, retired),
                  inArray(modelRoles.fallbackModel, retired),
                  like(modelRoles.primaryModel, 'anthropic/%'),
                  like(modelRoles.fallbackModel, 'anthropic/%'),
                ),
          ),
        );
    }
    // Preserve historical model/cost records, but remove retired choices from
    // both clients and clear saved overrides that could select them again.
    await tx
      .update(models)
      .set({ enabled: false, updatedAt: sql`now()` })
      .where(or(like(models.id, 'anthropic/%'), inArray(models.id, retired)));
    await tx
      .update(conversations)
      .set({ modelOverride: null, updatedAt: sql`now()` })
      .where(
        or(
          like(conversations.modelOverride, 'anthropic/%'),
          inArray(conversations.modelOverride, retired),
        ),
      );
  });
}
