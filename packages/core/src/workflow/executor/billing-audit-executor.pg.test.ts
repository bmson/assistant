import { randomUUID } from 'node:crypto';
import {
  conversations,
  createDb,
  createPostgresExecutionPersistence,
  createPostgresTaskRepository,
  type Db,
  messages,
  tasks,
  toolCalls,
} from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import { gmailSearchReceiptSourceId } from '@assistant/persistence/gmail-search-identity';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { taskState } from '../machine.js';
import type { RunContext } from './phases.js';
import { runStepLoop } from './step-loop.js';
import type { ExecutorDeps } from './types.js';

const databaseUrl = process.env.DATABASE_URL;
assertAllocatedTestTarget({
  databaseUrl,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  kind: 'standard',
});

describe('billing audit through allocated PostgreSQL executor', () => {
  let db: Db;
  beforeAll(() => {
    if (!databaseUrl) throw new Error('Allocated test database missing');
    db = createDb(databaseUrl);
  });
  afterAll(async () => {
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
  });

  it('reads only bounded Gmail, retains provider timestamps, and renders source-grounded findings without writes', async () => {
    const agent = await db.query.agents.findFirst();
    if (!agent) throw new Error('Allocator fixture agent missing');
    const agentId = agent.id;
    const conversationId = randomUUID();
    const taskId = randomUUID();
    const request =
      'Audit recurring subscriptions evidenced in authorized billing messages over the last 3 complete local calendar months. Separate actual charges, trials, refunds, cancellation notices and uncertain recurring purchases; a receipt is not automatically a subscription, and cancellation mail does not prove no later charge. Give an evidence table with currency, period, supported recurring-cost estimate and confidence; identify two useful review decisions without cancelling. Use official terms only for identified services; show conversion assumptions instead of mixing currencies. Any cancellation-question template must stay in chat. Check my calendar this Friday for subscription conflicts. No login/account change/cancel/unsubscribe/purchase/hold/send/Gmail draft/document/calendar/memory writes.';
    await db.insert(conversations).values({
      id: conversationId,
      agentId,
      channel: 'chat',
      trust: 'owner',
      title: 'Synthetic billing audit',
    });
    await db.insert(tasks).values({
      id: taskId,
      agentId,
      conversationId,
      type: 'chat_turn',
      status: 'pending',
      trust: 'owner',
      createdAt: new Date('2026-10-15T19:00:00Z'),
      maxSteps: 8,
      budgetUsdLimit: '0.0500',
      trigger: {
        source: 'chat',
        agentId,
        conversationId,
        trust: 'owner',
        payload: { text: request },
      },
      state: {},
    });
    await db.insert(messages).values({
      conversationId,
      taskId,
      role: 'user',
      origin: 'owner',
      text: request,
      parts: [{ type: 'text', text: request }],
    });
    const lease = await createPostgresTaskRepository(db).claim(taskId);
    if (!lease) throw new Error('Allocated task lease missing');
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const query =
      'after:2026/06/29 before:2026/10/03 {receipt invoice charged payment subscription renewal trial refund cancelled cancellation}';
    const billingBody = 'Your card was charged USD 12.00 for the monthly Acme subscription.';
    const dispatcher = {
      toolDefs: () =>
        ['gmail.search', 'gmail.read_thread', 'calendar.list_events', 'memory.recall'].map(
          (name) => ({ name, description: 'Synthetic local fixture', inputSchema: {} }),
        ),
      resultIsUntrusted: () => true,
      executeApproved: vi.fn(),
      dispatch: vi.fn(
        async ({ toolName, args }: { toolName: string; args: Record<string, unknown> }) => {
          calls.push({ toolName, args });
          const result =
            toolName === 'gmail.search'
              ? {
                  query,
                  mailboxSearched: 'assistant-alias@example.test',
                  configuredOwnerMailbox: 'owner@example.test',
                  complete: true,
                  hasMore: false,
                  unavailable: [],
                  results: [
                    { threadId: 'billing-thread', subject: 'Acme subscription payment receipt' },
                  ],
                  receipt: {
                    version: 1,
                    source: { kind: 'gmail-search', id: gmailSearchReceiptSourceId(query) },
                    requested: { limit: 20, scope: 'query-page' },
                    covered: { count: 1, total: 1, unavailable: 0 },
                    complete: true,
                    losses: [],
                    continuation: null,
                  },
                }
              : {
                  threadId: 'billing-thread',
                  complete: true,
                  hasMore: false,
                  messages: [
                    {
                      messageId: 'billing-message',
                      subject: 'Acme subscription payment receipt',
                      from: 'Acme Billing <billing@acme.example>',
                      date: 'Mon, 01 Jan 2001 00:00:00 +0000',
                      receivedAt: '2026-08-12T12:00:00.000Z',
                      text: billingBody,
                      sourceLength: billingBody.length,
                      truncated: false,
                    },
                  ],
                  receipt: {
                    version: 1,
                    source: { kind: 'gmail-thread', id: 'billing-thread' },
                    requested: { start: 0, offset: 0, limit: 20, scope: 'thread-messages' },
                    covered: { start: 0, offset: 0, end: 1, count: 1, total: 1, unavailable: 0 },
                    complete: true,
                    losses: [],
                    continuation: null,
                  },
                };
          const [stored] = await db
            .insert(toolCalls)
            .values({
              taskId,
              step: calls.length,
              toolName,
              args,
              risk: 'autonomous',
              status: 'succeeded',
              result,
            })
            .returning({ id: toolCalls.id });
          if (!stored) throw new Error('No durable source receipt');
          return { kind: 'executed' as const, toolCallId: stored.id, result, cached: false };
        },
      ),
    };
    const router = {
      step: vi.fn(async () => ({
        ok: true as const,
        modelId: 'scripted/billing-audit',
        degraded: false as const,
        text: 'Unsupported draft from the model.',
        toolCalls: [],
        finishReason: 'stop' as const,
      })),
      object: vi.fn(async () => {
        throw new Error('Billing audit must not require a model extraction or web lookup.');
      }),
      embed: vi.fn(async () => {
        throw new Error('Billing audit must not read memory.');
      }),
    };
    const deps = {
      db,
      router,
      dispatcher,
      persistence: createPostgresExecutionPersistence(db),
      notifyOwner: vi.fn(async () => ({ legs: [] })),
    } as unknown as ExecutorDeps;
    const state = taskState(lease);
    const context = {
      deps,
      db,
      router,
      dispatcher,
      task: lease,
      state,
      window: [{ role: 'user' as const, content: request }],
      agent: { id: agentId, timezone: 'America/Los_Angeles' },
      ctx: {
        taskId,
        agentId,
        trust: 'owner',
        tainted: false,
        db,
        now: () => new Date('2026-10-15T19:00:00Z'),
        signal: new AbortController().signal,
        log: vi.fn(async () => {}),
      },
    } as unknown as RunContext;
    const result = await runStepLoop(context, {
      action: 'reply',
      reasoning: 'Review bounded authorized billing mail',
      steps: [],
      missingInfo: [],
    });
    expect(result.outcome).toBe('needs_attention');
    expect(calls.map((call) => call.toolName)).toEqual(['gmail.search', 'gmail.read_thread']);
    expect(calls[0]?.args).toMatchObject({ query, maxResults: 20 });
    expect(calls[1]?.args).toMatchObject({ threadId: 'billing-thread' });
    expect(router.object).not.toHaveBeenCalled();
    expect(router.embed).not.toHaveBeenCalled();
    const assistantMessage = (
      await db.query.messages.findMany({ where: eq(messages.taskId, taskId) })
    ).find((row) => row.role === 'assistant');
    expect(assistantMessage?.text).toContain('Acme');
    expect(assistantMessage?.text).toContain('Mailbox searched: assistant-alias@example.test');
    expect(assistantMessage?.text).toContain('configured owner mailbox: owner@example.test');
    expect(assistantMessage?.text).toContain('not every mailbox the owner may use');
    expect(assistantMessage?.text).toContain('12.00 USD per month');
    expect(assistantMessage?.text).toContain('calendar source check was not run');
    expect(assistantMessage?.text).toContain('only the bounded billing mailbox was reviewed');
    expect(assistantMessage?.text).toContain(
      'https://mail.google.com/mail/u/0/#all/billing-thread',
    );
    expect(assistantMessage?.text).toContain('not bank-confirmed transactions');
    expect(assistantMessage?.text).not.toContain('Unsupported draft');
    expect(await db.select().from(toolCalls).where(eq(toolCalls.taskId, taskId))).toHaveLength(2);
  });
});
