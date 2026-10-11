import { randomUUID } from 'node:crypto';
import {
  enqueueTask,
  executeTask,
  getAgent,
  type InboundEvent,
  ModelRouter,
} from '@assistant/core';
import { conversations, createDb, type Db, messages, tasks } from '@assistant/db';
import { notificationLeg } from '@assistant/persistence';
import { ToolDispatcher, ToolRegistry } from '@assistant/tools';
import { type LanguageModel, ToolChoiceViolationError } from 'ai';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const sdk = vi.hoisted(() => ({ generateText: vi.fn() }));

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: sdk.generateText,
}));

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbReady = false;
let agentId = '';
const ownedTaskIds: string[] = [];
const ownedConversationIds: string[] = [];

function capabilityFailure() {
  // A network-free shape for the primary provider's documented no-endpoints response.
  return Object.assign(new Error('No endpoints found matching request'), {
    name: 'AI_APICallError',
    statusCode: 404,
    isRetryable: false,
  });
}

function requiredToolViolation() {
  // Use the SDK's real error type for the configured fallback's tool-choice refusal.
  return new ToolChoiceViolationError({
    toolChoice: { type: 'required' },
    finishReason: 'stop',
    provider: 'openrouter',
    modelId: 'openai/gpt-oss-120b',
    content: [{ type: 'text', text: 'Synthetic response without a tool call.' }],
  });
}

function routerWithSyntheticProviderFailures() {
  const primaryModel = {} as LanguageModel;
  const fallbackModel = {} as LanguageModel;
  const costs = {
    kind: 'cost-repository',
    markAttemptUnknown: async () => {},
    release: async () => {},
  };
  const repository = {
    kind: 'model-routing-repository',
    costs,
    taskBudget: async () => null,
    conversationOverride: async () => null,
    role: async () => null,
    model: async () => null,
    recordCall: async () => randomUUID(),
    recordAudit: async () => {},
  };
  const router = new ModelRouter(repository as never, 'synthetic-key', 'off');
  const primary = {
    ok: true as const,
    model: primaryModel,
    modelId: 'minimax/minimax-m2.7',
    degraded: false,
    thinking: false,
    decision: { mode: 'primary' as const },
    params: {},
    promptCostPerMTok: 0,
    completionCostPerMTok: 0,
  };
  const fallback = {
    ...primary,
    model: fallbackModel,
    modelId: 'openai/gpt-oss-120b',
    degraded: true,
    decision: { mode: 'fallback' as const, reason: 'synthetic test fallback' },
  };
  const route = vi
    .spyOn(router, 'route')
    .mockImplementation(async (_role, options) => (options?.forceFallback ? fallback : primary));
  let reservation = 0;
  Object.defineProperty(router, 'reserveModelCall', {
    value: async () => ({
      reservation: { ok: true as const, reservationId: `synthetic-${++reservation}` },
      maxOutputTokens: 256,
      estimatedUsd: 0,
    }),
  });
  Object.defineProperty(router, 'beginProviderAttempt', { value: async () => {} });

  sdk.generateText.mockImplementation(
    async (options: { model: LanguageModel; toolChoice?: unknown }) => {
      if (options.model === primaryModel) throw capabilityFailure();
      if (options.model === fallbackModel) throw requiredToolViolation();
      throw new Error('Unexpected synthetic model');
    },
  );

  return { router, route, primaryModel, fallbackModel };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbReady = true;
  } catch {
    console.warn('tool-choice-fallback-lifecycle: isolated database unavailable — skipping');
  }
});

afterAll(async () => {
  if (dbReady) {
    if (ownedTaskIds.length) {
      await db.delete(messages).where(inArray(messages.taskId, ownedTaskIds));
      await db.delete(tasks).where(inArray(tasks.id, ownedTaskIds));
    }
    if (ownedConversationIds.length) {
      await db.delete(messages).where(inArray(messages.conversationId, ownedConversationIds));
      await db.delete(conversations).where(inArray(conversations.id, ownedConversationIds));
    }
  }
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe('required-tool fallback failure lifecycle', () => {
  it('retries durably to the cap, then posts a provider-failure notice without raw errors', async (ctx) => {
    if (!dbReady) return ctx.skip();

    sdk.generateText.mockReset();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner', title: 'tool-choice-fallback-test' })
      .returning();
    if (!conversation) throw new Error('conversation fixture was not created');
    ownedConversationIds.push(conversation.id);

    const event: InboundEvent = {
      source: 'internal',
      agentId,
      conversationId: conversation.id,
      trust: 'owner',
      payload: {},
    };
    const { task } = await enqueueTask(db, {
      event,
      type: 'adhoc',
      plan: {
        action: 'workflow',
        reasoning: '',
        steps: ['Use the available tool to complete this request.'],
        missingInfo: [],
      },
      deferNotification: true,
    });
    ownedTaskIds.push(task.id);

    let toolExecutions = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: 'exec.synthetic',
      description: 'synthetic no-effect tool used only to require a tool response',
      inputSchema: z.object({}),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      idempotencyKey: () => `synthetic:${task.id}`,
      execute: async () => {
        toolExecutions += 1;
        return { ok: true };
      },
    });

    const { router, route, primaryModel, fallbackModel } = routerWithSyntheticProviderFailures();
    const notices: string[] = [];
    for (let expectedAttempt = 1; expectedAttempt <= 8; expectedAttempt += 1) {
      if (expectedAttempt > 1) {
        await db
          .update(tasks)
          .set({ runAfter: new Date(Date.now() - 1_000) })
          .where(eq(tasks.id, task.id));
      }
      const result = await executeTask(
        {
          db,
          router,
          dispatcher: new ToolDispatcher(db, registry),
          notifyOwner: async ({ text }) => {
            notices.push(text);
            return notificationLeg('owner', 'delivered');
          },
        },
        task.id,
      );
      expect(result.outcome).toBe(expectedAttempt === 8 ? 'dead_letter' : 'failed');
      const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
      expect(row).toMatchObject({
        attempt: expectedAttempt,
        status: expectedAttempt === 8 ? 'needs_attention' : 'sleeping',
      });
    }

    expect(sdk.generateText).toHaveBeenCalledTimes(16);
    expect(sdk.generateText.mock.calls.map(([options]) => options.model)).toEqual(
      Array.from({ length: 8 }, () => [primaryModel, fallbackModel]).flat(),
    );
    expect(sdk.generateText.mock.calls.map(([options]) => options.toolChoice)).toEqual(
      Array.from({ length: 16 }, () => 'required'),
    );
    expect(route.mock.calls.some(([, options]) => options?.forceFallback === true)).toBe(true);
    expect(toolExecutions).toBe(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('one of my AI providers is having trouble');
    expect(notices[0]).not.toMatch(/Minimax|GPT-oss|No endpoints|ToolChoiceViolation|openrouter/i);

    const [terminal] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(terminal?.progress).toContain('ModelCallFallbackAttemptError');
    expect(terminal?.progress).not.toMatch(/No endpoints|ToolChoiceViolation|GPT-oss|openrouter/i);
    const noticeMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id));
    expect(noticeMessages).toHaveLength(1);
    expect(noticeMessages[0]?.text).toContain('one of my AI providers is having trouble');
    expect(noticeMessages[0]?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'notice', notice: 'provider-failed' }),
      ]),
    );
    expect(terminal?.attentionNotifiedAt).not.toBeNull();
  });
});
