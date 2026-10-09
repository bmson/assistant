import {
  conversations,
  costReservations,
  createDb,
  type Db,
  modelRoles,
  models,
  reconcileModelConfig,
  tasks,
} from '@assistant/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createChatTask, ensureChatConversation, getAgent } from '../chat.js';
import { BudgetReservationError, releaseReservation } from '../cost.js';
import {
  type CallOptions,
  isProviderCapabilityError,
  isUnparseableObjectError,
  ModelRouter,
  objectFailureAuditOutput,
} from './router.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    await getAgent(db);
    dbUp = true;
  } catch {
    console.warn('router.test: database unreachable or unseeded — skipping integration tests');
  }
});

afterAll(async () => {
  // postgres.js keeps the process alive otherwise
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('isUnparseableObjectError', () => {
  it('detects the AI SDK no-object error by name (either spelling)', () => {
    const sdk = new Error('No object generated: could not parse the response.');
    sdk.name = 'AI_NoObjectGeneratedError';
    expect(isUnparseableObjectError(sdk)).toBe(true);
    const alt = new Error('no object');
    alt.name = 'NoObjectGeneratedError';
    expect(isUnparseableObjectError(alt)).toBe(true);
  });

  it('is false for transient/provider errors and non-errors (they stay retryable)', () => {
    expect(isUnparseableObjectError(new Error('fetch failed'))).toBe(false);
    expect(isUnparseableObjectError(new BudgetReservationError('daily budget', new Date()))).toBe(
      false,
    );
    expect(isUnparseableObjectError('AI_NoObjectGeneratedError')).toBe(false);
    expect(isUnparseableObjectError(null)).toBe(false);
  });
});

describe('objectFailureAuditOutput', () => {
  it('retains raw provider text with an explicit parse-failure marker', () => {
    const error = new Error('No object generated');
    error.name = 'AI_NoObjectGeneratedError';
    Object.assign(error, { text: '{"date":"unfinished' });
    expect(objectFailureAuditOutput(error)).toBe(
      '[audit:object-schema-parse-failure] (AI_NoObjectGeneratedError)\n{"date":"unfinished',
    );
  });

  it('does not label unrelated provider errors as schema failures', () => {
    expect(objectFailureAuditOutput(new Error('fetch failed'))).toBeUndefined();
  });
});

describe('single-attempt model calls', () => {
  it('suppresses timeout retries only when requested', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const router = new ModelRouter(db, 'unused');
    const internal = router as unknown as {
      withTimeoutRetry: (opts: CallOptions, run: () => Promise<string>) => Promise<string>;
    };
    const timeout = Object.assign(new Error('deadline'), { name: 'TimeoutError' });
    const oneShot = vi.fn().mockRejectedValue(timeout);
    await expect(internal.withTimeoutRetry({ singleAttempt: true }, oneShot)).rejects.toBe(timeout);
    expect(oneShot).toHaveBeenCalledTimes(1);

    const normal = vi.fn().mockRejectedValueOnce(timeout).mockResolvedValueOnce('retried');
    await expect(internal.withTimeoutRetry({}, normal)).resolves.toBe('retried');
    expect(normal).toHaveBeenCalledTimes(2);
  });

  it('does not run configured capability fallback for one-shot generation', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const router = new ModelRouter(db, 'unused');
    const capabilityError = Object.assign(new Error('No endpoints match request'), {
      name: 'AI_APICallError',
      statusCode: 410,
    });
    expect(isProviderCapabilityError(capabilityError)).toBe(true);
    const generateOnce = vi.fn().mockRejectedValue(capabilityError);
    const route = vi.fn(async (_role: unknown, options: { forceFallback?: boolean }) => ({
      ok: true as const,
      modelId: options.forceFallback ? 'fallback' : 'primary',
    }));
    Object.defineProperty(router, 'generateOnce', { value: generateOnce });
    Object.defineProperty(router, 'route', { value: route });

    await expect(router.generate('draft', { prompt: 'test', singleAttempt: true })).rejects.toBe(
      capabilityError,
    );
    expect(generateOnce).toHaveBeenCalledTimes(1);
    expect(route).not.toHaveBeenCalled();

    await expect(router.generate('draft', { prompt: 'test' })).rejects.toBe(capabilityError);
    expect(generateOnce).toHaveBeenCalledTimes(3);
    expect(route).toHaveBeenCalledTimes(2);
  });

  it('does not run the step output-quality retry for one-shot calls', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const router = new ModelRouter(db, 'unused');
    const malformed = {
      ok: true as const,
      modelId: 'primary',
      degraded: false,
      text: '23°Cwarming',
      toolCalls: [],
    };
    const stepOnce = vi.fn().mockResolvedValue(malformed);
    const route = vi.fn(async () => ({ ok: true as const, modelId: 'fallback' }));
    Object.defineProperty(router, 'stepOnce', { value: stepOnce });
    Object.defineProperty(router, 'route', { value: route });

    const oneShot = await router.step('draft', {
      prompt: 'test',
      tools: {},
      singleAttempt: true,
    });
    expect(oneShot).toMatchObject({ ok: true, qualityFailure: true });
    expect(stepOnce).toHaveBeenCalledTimes(1);
    expect(route).not.toHaveBeenCalled();

    stepOnce.mockResolvedValueOnce(malformed).mockResolvedValueOnce({
      ...malformed,
      modelId: 'fallback',
      text: 'The temperature is 23°C.',
    });
    const normal = await router.step('draft', { prompt: 'test', tools: {} });
    expect(normal).toMatchObject({ ok: true, modelId: 'fallback' });
    expect(stepOnce).toHaveBeenCalledTimes(3);
    expect(route).toHaveBeenCalledTimes(1);
  });
});

describe('ModelRouter.route (integration)', () => {
  it('uses the conversation choice for agent work without changing background routes or budget fallback', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const rollback = new Error('rollback model selection fixture');
    await expect(
      db.transaction(async (tx) => {
        const scoped = tx as unknown as Db;
        const agent = await getAgent(scoped);
        const conversation = await ensureChatConversation(scoped, agent.id);
        await tx
          .update(conversations)
          .set({ modelOverride: 'moonshotai/kimi-k3' })
          .where(eq(conversations.id, conversation.id));
        const task = await createChatTask(scoped, {
          agentId: agent.id,
          conversationId: conversation.id,
        });
        const router = new ModelRouter(scoped, 'unused');
        const selected = await router.route('reason', { taskId: task.id });
        expect(selected.ok && selected.modelId).toBe('moonshotai/kimi-k3');
        const planned = await router.route('plan', { taskId: task.id });
        expect(planned.ok && planned.modelId).toBe('deepseek/deepseek-v4-pro-0813');
        const fallback = await router.route('reason', { taskId: task.id, forceFallback: true });
        expect(fallback.ok && fallback.modelId).toBe('openai/gpt-oss-120b');
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it('upgrades retired routes, clears Anthropic overrides, and preserves subsequent owner choices', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const rollback = new Error('rollback retired model fixture');
    await expect(
      db.transaction(async (tx) => {
        const scoped = tx as unknown as Db;
        const retired = 'anthropic/claude-sonnet-4.5';
        await tx
          .insert(models)
          .values({ id: retired, label: 'Retired Claude', enabled: true })
          .onConflictDoUpdate({ target: models.id, set: { enabled: true } });
        await tx
          .update(modelRoles)
          .set({ primaryModel: retired, fallbackModel: retired })
          .where(eq(modelRoles.role, 'reason'));
        const agent = await getAgent(scoped);
        const conversation = await ensureChatConversation(scoped, agent.id);
        await tx
          .update(conversations)
          .set({ modelOverride: retired })
          .where(eq(conversations.id, conversation.id));
        await reconcileModelConfig(scoped);
        const router = new ModelRouter(scoped, 'unused');
        const route = await router.route('reason', { modelOverride: retired });
        expect(route.ok && route.modelId).toBe('minimax/minimax-m2.7');
        const [cleared] = await tx
          .select()
          .from(conversations)
          .where(eq(conversations.id, conversation.id));
        expect(cleared?.modelOverride).toBeNull();
        const [disabled] = await tx.select().from(models).where(eq(models.id, retired));
        expect(disabled?.enabled).toBe(false);
        await tx
          .update(modelRoles)
          .set({ primaryModel: 'moonshotai/kimi-k2.6' })
          .where(eq(modelRoles.role, 'reason'));
        await reconcileModelConfig(scoped);
        const preserved = await router.route('reason');
        expect(preserved.ok && preserved.modelId).toBe('moonshotai/kimi-k2.6');
        // A stale role reference must fail closed instead of billing a disabled provider.
        await tx
          .update(modelRoles)
          .set({ primaryModel: retired })
          .where(eq(modelRoles.role, 'reason'));
        await expect(router.route('reason')).rejects.toThrow('routed model is disabled');
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it('does not accept an embedding model as a chat override', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const route = await new ModelRouter(db, 'unused').route('reason', {
      modelOverride: 'openai/text-embedding-3-small',
    });
    expect(route.ok && route.modelId).toBe('minimax/minimax-m2.7');
  });

  it('resolves a role to its seeded primary model', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const router = new ModelRouter(db, 'test-key-unused');
    const route = await router.route('classify');
    expect(route.ok).toBe(true);
    if (route.ok) {
      expect(route.modelId).toBe('deepseek/deepseek-v4-flash-0731');
      expect(route.degraded).toBe(false);
      // OpenRouter must not route feature-dependent requests (json_schema,
      // tools) to providers that cannot honor them.
      const settings = (
        route.model as { settings?: { provider?: { require_parameters?: boolean } } }
      ).settings;
      expect(settings?.provider?.require_parameters).toBe(true);
    }
  });

  it('honors an enabled model override', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const router = new ModelRouter(db, 'test-key-unused');
    const route = await router.route('draft', { modelOverride: 'openai/gpt-oss-120b' });
    expect(route.ok && route.modelId).toBe('openai/gpt-oss-120b');
  });

  it('uses the configured role fallback when a caller requires it', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const router = new ModelRouter(db, 'test-key-unused');
    const route = await router.route('draft', { forceFallback: true });
    expect(route.ok && route.modelId).toBe('openai/gpt-oss-120b');
    expect(route.ok && route.degraded).toBe(true);
  });

  it('ignores an unknown model override and keeps the role primary', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const router = new ModelRouter(db, 'test-key-unused');
    const route = await router.route('draft', { modelOverride: 'nope/not-a-model' });
    expect(route.ok && route.modelId).toBe('google/gemini-3.8-flash');
  });

  it('parks a task whose budget is exhausted', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const agent = await getAgent(db);
    const conversation = await ensureChatConversation(db, agent.id);
    const task = await createChatTask(db, { agentId: agent.id, conversationId: conversation.id });
    await db
      .update(tasks)
      .set({ budgetUsdLimit: '0.0010', spentUsd: '0.0010' })
      .where(eq(tasks.id, task.id));

    const router = new ModelRouter(db, 'test-key-unused');
    const route = await router.route('draft', { taskId: task.id });
    expect(route.ok).toBe(false);
    if (!route.ok) expect(route.decision.mode).toBe('park');

    await db.delete(tasks).where(eq(tasks.id, task.id));
  });

  it('degrades to the fallback model above the soft threshold', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const agent = await getAgent(db);
    const conversation = await ensureChatConversation(db, agent.id);
    const task = await createChatTask(db, { agentId: agent.id, conversationId: conversation.id });
    await db
      .update(tasks)
      .set({ budgetUsdLimit: '0.25', spentUsd: '0.21' }) // 84% > 80% soft
      .where(eq(tasks.id, task.id));

    const router = new ModelRouter(db, 'test-key-unused');
    const route = await router.route('draft', { taskId: task.id });
    expect(route.ok).toBe(true);
    if (route.ok) {
      expect(route.degraded).toBe(true);
      expect(route.modelId).toBe('openai/gpt-oss-120b'); // draft fallback
    }

    await db.delete(tasks).where(eq(tasks.id, task.id));
  });

  it('keeps the cheaper primary when an explicitly configured budget fallback costs more', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const rollback = new Error('rollback expensive fallback fixture');
    await expect(
      db.transaction(async (tx) => {
        const scoped = tx as unknown as Db;
        const agent = await getAgent(scoped);
        const conversation = await ensureChatConversation(scoped, agent.id);
        const task = await createChatTask(scoped, {
          agentId: agent.id,
          conversationId: conversation.id,
        });
        await tx
          .update(tasks)
          .set({ budgetUsdLimit: '0.25', spentUsd: '0.21' })
          .where(eq(tasks.id, task.id));
        await tx
          .update(modelRoles)
          .set({ fallbackModel: 'moonshotai/kimi-k3' })
          .where(eq(modelRoles.role, 'draft'));

        const route = await new ModelRouter(scoped, 'unused').route('draft', {
          taskId: task.id,
          prompt: 'A bounded test prompt',
        });
        expect(route.ok).toBe(true);
        if (route.ok) {
          expect(route.modelId).toBe('google/gemini-3.8-flash');
          expect(route.degraded).toBe(false);
        }
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it('validates the exact request shape for both configured routes', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const rollback = new Error('rollback unsupported profile fixture');
    await expect(
      db.transaction(async (tx) => {
        const scoped = tx as unknown as Db;
        const agent = await getAgent(scoped);
        const conversation = await ensureChatConversation(scoped, agent.id);
        const task = await createChatTask(scoped, {
          agentId: agent.id,
          conversationId: conversation.id,
        });
        await tx
          .update(tasks)
          .set({ budgetUsdLimit: '0.25', spentUsd: '0.21' })
          .where(eq(tasks.id, task.id));
        const [role] = await tx.select().from(modelRoles).where(eq(modelRoles.role, 'draft'));
        if (!role) throw new Error('missing draft model role');
        const [primary, fallback] = await Promise.all([
          tx
            .select()
            .from(models)
            .where(eq(models.id, role.primaryModel))
            .then((rows) => rows[0]),
          tx
            .select()
            .from(models)
            .where(eq(models.id, role.fallbackModel))
            .then((rows) => rows[0]),
        ]);
        if (!primary || !fallback) throw new Error('missing configured draft model');
        const checkedAt = new Date().toISOString();
        await tx
          .update(models)
          .set({
            capabilities: {
              ...(primary.capabilities as Record<string, unknown>),
              supportedParameters: [
                'tools',
                'tool_choice',
                'structured_outputs',
                'json_object',
                'reasoning',
              ],
              checkedAt,
            },
          })
          .where(eq(models.id, role.primaryModel));
        await tx
          .update(models)
          .set({
            capabilities: {
              ...(fallback.capabilities as Record<string, unknown>),
              supportedParameters: ['tools', 'tool_choice', 'reasoning'],
              checkedAt,
            },
          })
          .where(eq(models.id, role.fallbackModel));
        const router = new ModelRouter(scoped, 'unused');
        const requestProfile = {
          tools: 'required' as const,
          toolChoice: 'required' as const,
          output: 'json_schema' as const,
          streaming: false,
        };
        expect(
          (
            await router.route('draft', {
              requestProfile: { tools: 'none', output: 'json', streaming: false },
            })
          ).ok,
        ).toBe(true);
        await expect(
          router.route('draft', {
            forceFallback: true,
            requestProfile: { tools: 'none', output: 'json', streaming: false },
          }),
        ).rejects.toThrow('json_object');
        const budgetRoute = await router.route('draft', { taskId: task.id, requestProfile });
        expect(budgetRoute.ok).toBe(true);
        if (budgetRoute.ok) {
          expect(budgetRoute.modelId).toBe(role.primaryModel);
          expect(budgetRoute.degraded).toBe(false);
        }
        await expect(
          router.route('draft', { forceFallback: true, requestProfile }),
        ).rejects.toThrow('structured_outputs');
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it('tries the cheaper fallback when the primary reservation does not fit', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const agent = await getAgent(db);
    const conversation = await ensureChatConversation(db, agent.id);
    const task = await createChatTask(db, { agentId: agent.id, conversationId: conversation.id });
    await db
      .update(tasks)
      .set({ budgetUsdLimit: '0.0080', spentUsd: '0' })
      .where(eq(tasks.id, task.id));

    const router = new ModelRouter(db, 'test-key-unused');
    const prepared = await (
      router as unknown as {
        prepareModelCall: (
          role: 'reason',
          opts: { taskId: string; prompt: string },
        ) => Promise<
          | { ok: false }
          | {
              ok: true;
              route: { modelId: string; degraded: boolean };
              reservationId: string;
            }
        >;
      }
    ).prepareModelCall('reason', { taskId: task.id, prompt: 'Finish the task.' });

    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.route.modelId).toBe('openai/gpt-oss-120b');
      expect(prepared.route.degraded).toBe(true);
      await releaseReservation(db, prepared.reservationId);
    }
    await db.delete(costReservations).where(eq(costReservations.taskId, task.id));
    await db.delete(tasks).where(eq(tasks.id, task.id));
  });

  it('blocks embeddings before calling the provider when the task cap is exhausted', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const agent = await getAgent(db);
    const conversation = await ensureChatConversation(db, agent.id);
    const task = await createChatTask(db, { agentId: agent.id, conversationId: conversation.id });
    await db
      .update(tasks)
      .set({ budgetUsdLimit: '0.0010', spentUsd: '0.0010' })
      .where(eq(tasks.id, task.id));

    const router = new ModelRouter(db, 'provider-must-not-be-called');
    await expect(router.embed(['budget guard'], { taskId: task.id })).rejects.toBeInstanceOf(
      BudgetReservationError,
    );
    await db.delete(tasks).where(eq(tasks.id, task.id));
  });
});
