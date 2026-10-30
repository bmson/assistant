/**
 * Isolated PostgreSQL acceptance fixture. Authoring does not authorize execution.
 * Run only through the approved `pnpm test <this file>` allocation/migration gate.
 * Scripted adapters exercise wiring, never live listing or model quality.
 */
import { createHash, randomUUID } from 'node:crypto';
import { executeTask, type ModelRouter } from '@assistant/core';
import { resolveApproval } from '@assistant/core/workflow/approvals';
import {
  agents,
  approvals,
  createDb,
  createPostgresApplicationChatPersistence,
  type Db,
  messages,
  tasks,
  toolCalls,
} from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolDispatcher } from '../dispatcher.js';
import { ToolRegistry } from '../registry.js';

const injectors = vi.hoisted(() => ({
  ownerCard: vi.fn(async () => 'OWNER_CARD_CANARY'),
  ambient: vi.fn(async () => 'AMBIENT_CANARY'),
  recall: vi.fn(async () => ({ block: 'AUTO_AND_PLANNING_RECALL_CANARY', sources: [] })),
  situations: vi.fn(async () => ({ block: 'SITUATION_CANARY', sources: [] })),
  commitments: vi.fn(async () => [{ text: 'COMMITMENT_CANARY' }]),
}));
vi.mock('../../../core/src/memory/consolidation.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getOwnerCard: injectors.ownerCard,
}));
vi.mock('../../../core/src/memory/ambient.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getAmbientBlock: injectors.ambient,
}));
vi.mock('../../../core/src/memory/recall-context.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  retrieveOwnerContext: injectors.recall,
}));
vi.mock('../../../core/src/memory/situation-context.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readSituationDecisionContext: injectors.situations,
}));
vi.mock('../../../core/src/memory/commitments.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listOpenCommitments: injectors.commitments,
  renderOpenCommitments: () => 'COMMITMENT_CANARY',
}));
function assertPublicInjectorsUnused() {
  for (const injector of Object.values(injectors)) expect(injector).not.toHaveBeenCalled();
}
function resetInjectors() {
  for (const injector of Object.values(injectors)) injector.mockClear();
}

const reference = new Date('2026-10-24T06:30:00Z');
const canaries = [
  'PRIVATE_CALENDAR_CANARY',
  'PRIVATE_MAIL_CANARY',
  'PRIVATE_THREAD_CANARY',
  'OWNER_CARD_CANARY',
  'AMBIENT_CANARY',
  'AUTO_AND_PLANNING_RECALL_CANARY',
  'SITUATION_CANARY',
  'COMMITMENT_CANARY',
];
function latestPublicListing(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (
    typeof row.url === 'string' &&
    typeof row.text === 'string' &&
    row.text.includes('Synthetic Art Walk')
  )
    return row.text;
  let found: string | undefined;
  for (const child of Object.values(value)) found = latestPublicListing(child) ?? found;
  return found;
}
const databaseUrl = process.env.DATABASE_URL;
assertAllocatedTestTarget({
  databaseUrl,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  kind: 'standard',
});
class RollbackFixture extends Error {}

class OfflineRouter {
  readonly contexts: string[] = [];
  private calls = 0;
  async step(_role: string, input: { messages?: unknown[] }) {
    if (!['reason', 'draft'].includes(_role))
      throw new Error(`Unexpected offline step role: ${_role}`);
    this.contexts.push(JSON.stringify({ role: _role, ...input }));
    if (++this.calls > 24) throw new Error('Unbounded scripted execution');
    return {
      ok: true,
      modelId: 'synthetic/offline',
      degraded: false,
      text: latestPublicListing(input.messages) ?? 'I could not verify a public listing yet.',
      finishReason: 'stop',
      toolCalls: [],
    };
  }
  async object(role: string, input?: { system?: string }) {
    this.contexts.push(JSON.stringify({ role, ...input }));
    if (role === 'classify')
      return {
        ok: true,
        modelId: 'synthetic/offline',
        object: { trivial: false, needsAction: true },
      };
    if (role === 'plan')
      return {
        ok: true,
        modelId: 'synthetic/offline',
        object: {
          action: 'workflow',
          reasoning: 'Synthetic public source lookup',
          steps: ['Read requested sources', 'Report supported facts'],
          missingInfo: [],
        },
      };
    if (role === 'rewrite')
      return {
        ok: true,
        modelId: 'synthetic/offline',
        object: input?.system?.startsWith('You compose a native information card')
          ? { cardable: false }
          : { reasons: [], decision: 'publish' },
      };
    throw new Error(`Unexpected offline model role: ${role}`);
  }
  async embed(texts: string[]) {
    return texts.map(() => Array(1536).fill(0));
  }
}
interface Execution {
  name: string;
  args: Record<string, unknown>;
  dbToolCallId?: string;
  taskId?: string;
}
function fixtureDispatcher(
  db: Db,
  executions: Execution[],
  failure: boolean | 'wrong_date' | 'wrong_city' | 'fetch_failure' = false,
) {
  const listingByUrl = new Map<string, { url: string; title: string; text: string }>();
  const registry = new ToolRegistry();
  for (const name of ['web.search', 'web.fetch']) {
    registry.register(
      {
        name,
        description: `Synthetic ${name}`,
        inputSchema:
          name === 'web.search'
            ? z.object({ query: z.string().max(256), count: z.number().optional() })
            : z.object({ url: z.string().url() }),
        risk: 'approval',
        acceptsUntrustedInput: true,
        approvalSummary: (args) => `${name}: ${JSON.stringify(args)}`,
        execute: async (args, ctx) => {
          if (!ctx.execution?.dbToolCallId)
            throw new Error('Synthetic adapter requires durable execution identity');
          executions.push({
            name,
            args: args as Record<string, unknown>,
            dbToolCallId: ctx.execution.dbToolCallId,
            taskId: ctx.taskId,
          });
          if (failure === true || (failure === 'fetch_failure' && name === 'web.fetch'))
            throw new Error('Synthetic public source unavailable');
          const values = args as Record<string, unknown>;
          if (name === 'web.search') {
            const query = String(values.query);
            const requestedDate = query.match(/\d{4}-\d{2}-\d{2}/)?.[0];
            if (!requestedDate) throw new Error('Expected resolved public date in query');
            const city = query.includes('San Francisco')
              ? 'San Francisco'
              : query.includes('Seattle')
                ? 'Seattle'
                : 'Unknown city';
            const date = failure === 'wrong_date' ? '2025-10-24' : requestedDate;
            const sourceCity = failure === 'wrong_city' ? 'Seattle' : city;
            const url = `https://example.test/art-${requestedDate}`;
            const text = `${sourceCity}, ${date}: Synthetic Art Walk — ${date}, 10:00 am, ${sourceCity}. Admission $15. ${url}`;
            listingByUrl.set(url, {
              status: 200,
              contentType: 'text/plain',
              title: 'Synthetic Art Walk',
              text,
              truncated: false,
              finalUrl: url,
            });
            return { results: [{ title: 'Synthetic Art Walk', url, snippet: text }] };
          }
          const listing = listingByUrl.get(String(values.url));
          if (!listing) throw new Error('Fetch URL not produced by this synthetic search');
          return listing;
        },
      },
      { networkEgress: true },
    );
  }
  for (const [index, name] of [
    'calendar.list_events',
    'calendar.search_events',
    'calendar.availability',
    'gmail.search',
    'gmail.read_thread',
  ].entries()) {
    registry.register(
      {
        name,
        description: `Synthetic private canary ${name}`,
        inputSchema: z.object({}).passthrough(),
        risk: 'autonomous',
        acceptsUntrustedInput: true,
        execute: async (args, ctx) => {
          if (!ctx.execution?.dbToolCallId)
            throw new Error('Synthetic adapter requires durable execution identity');
          executions.push({
            name,
            args: args as Record<string, unknown>,
            dbToolCallId: ctx.execution.dbToolCallId,
            taskId: ctx.taskId,
          });
          return { events: [], messages: [], text: canaries[index % canaries.length] };
        },
      },
      { confidentialRead: true },
    );
  }
  return new ToolDispatcher(db, registry);
}
function noPrivate(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const canary of canaries) expect(serialized).not.toContain(canary);
  expect(serialized).not.toMatch(/newer_than:/);
}

describe('public activity actual approval lifecycle (isolated PostgreSQL)', () => {
  let db: Db;
  beforeAll(async () => {
    if (!databaseUrl) throw new Error('Allocated test database required');
    db = createDb(databaseUrl);
    // Setup failures fail the suite; unavailable database is never a passing skip.
    await db.select({ id: agents.id }).from(agents).limit(1);
  });
  afterAll(async () => {
    await db?.$client.end();
  });
  async function scenario(
    body: (tx: Db, agentId: string, conversationId: string) => Promise<void>,
  ) {
    resetInjectors();
    try {
      await db.transaction(async (transaction) => {
        const tx = transaction as unknown as Db;
        const repository = createPostgresApplicationChatPersistence(tx);
        const agent = await repository.resolveAgent();
        await tx
          .update(agents)
          .set({ timezone: 'America/Los_Angeles' })
          .where(eq(agents.id, agent.id));
        const conversation = await repository.createConversation(agent.id);
        await body(tx, agent.id, conversation.id);
        throw new RollbackFixture();
      });
    } catch (error) {
      if (!(error instanceof RollbackFixture)) throw error;
    }
  }
  async function admit(tx: Db, agentId: string, conversationId: string, text: string, index = 0) {
    const repo = createPostgresApplicationChatPersistence(tx);
    const admitted = await repo.admitChatTurn({
      agentId,
      conversationId,
      clientOperationId: randomUUID(),
      requestHash: createHash('sha256')
        .update(JSON.stringify([text, false, false, false]))
        .digest('hex'),
      text,
      autonomous: false,
      force: false,
      spoken: false,
    });
    if (admitted.kind !== 'admitted' || !admitted.lease)
      throw new Error('Expected actual fresh admission');
    const at = new Date(reference.getTime() + index * 1000);
    // Normalize only this synthetic admitted task/owner row and its requestAt proof.
    // This tests deterministic wiring, not the production wall-clock acquisition.
    const trigger = admitted.task.trigger as { payload: Record<string, unknown> };
    await tx
      .update(tasks)
      .set({
        createdAt: at,
        trigger: { ...trigger, payload: { ...trigger.payload, requestAt: at.toISOString() } },
        maxSteps: 10,
      })
      .where(eq(tasks.id, admitted.task.id));
    await tx.update(messages).set({ createdAt: at }).where(eq(messages.id, admitted.message.id));
    const queued = await repo.queueAdmittedChatTurn({
      agentId,
      task: admitted.lease,
      triagedActionable: true,
    });
    if (!queued) throw new Error('Admission queue fence failed');
    return { taskId: admitted.task.id, messageId: admitted.message.id };
  }
  async function run(tx: Db, taskId: string, dispatcher: ToolDispatcher, router: OfflineRouter) {
    return executeTask({ db: tx, dispatcher, router: router as unknown as ModelRouter }, taskId);
  }
  async function pending(tx: Db, taskId: string) {
    return tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.taskId, taskId), eq(approvals.status, 'pending')));
  }
  async function settle(
    tx: Db,
    taskId: string,
    dispatcher: ToolDispatcher,
    router: OfflineRouter,
    decision: 'approved' | 'denied' = 'approved',
  ) {
    for (let cycle = 0; cycle < 5; cycle++) {
      const rows = await pending(tx, taskId);
      if (!rows.length) return;
      for (const row of rows)
        await resolveApproval(tx, {
          approvalId: row.id,
          decision,
          via: 'web',
          deferNotification: true,
        });
      await run(tx, taskId, dispatcher, router);
    }
    throw new Error('Approval cycle did not converge');
  }
  async function inspectPublic(
    tx: Db,
    taskId: string,
    executions: Execution[],
    router: OfflineRouter,
  ) {
    assertPublicInjectorsUnused();
    const calls = await tx.select().from(toolCalls).where(eq(toolCalls.taskId, taskId));
    const output = await tx.select().from(messages).where(eq(messages.taskId, taskId));
    noPrivate({ calls, output, contexts: router.contexts });
    expect(calls.filter((c) => /^(?:gmail|calendar)\./.test(c.toolName))).toEqual([]);
    expect(executions.filter((c) => /^(?:gmail|calendar)\./.test(c.name))).toEqual([]);
    for (const call of calls.filter((c) => c.toolName === 'web.search')) {
      expect(call.args).toMatchObject({ query: expect.stringContaining('San Francisco') });
      expect(JSON.stringify(call.args)).toContain('2026-10-');
    }
    expect(JSON.stringify(output.flatMap((m) => m.parts ?? []))).not.toMatch(
      /"kind":"(?:agenda|calendar|mail|thread)"/,
    );
    return { calls, output };
  }
  it('persists all five sanitized turns and approves exact query once per call', async () =>
    scenario(async (tx, agentId, conversationId) => {
      const executions: Execution[] = [];
      const router = new OfflineRouter();
      const dispatcher = fixtureDispatcher(tx, executions);
      const privateSeed = await admit(tx, agentId, conversationId, 'Show my calendar today', -10);
      await tx.update(tasks).set({ status: 'done' }).where(eq(tasks.id, privateSeed.taskId));
      for (const [index, toolName] of [
        'calendar.list_events',
        'gmail.search',
        'gmail.read_thread',
      ].entries()) {
        await tx.insert(toolCalls).values({
          taskId: privateSeed.taskId,
          step: index,
          toolName,
          args: {},
          result: { text: canaries[index] },
          risk: 'autonomous',
          status: 'succeeded',
          finishedAt: reference,
        });
      }
      const texts = [
        'Is there anything happening in San Francisco today?',
        'I mean city events I could attend; my weekend is empty.',
        // SANITIZED PARAPHRASE, not an exact screenshot transcript.
        'Public events, not my calendar or inbox.',
        'Search for events for me.',
        'Find public events in San Francisco this weekend.',
      ];
      for (const [index, text] of texts.entries()) {
        const executionOffset = executions.length;
        const admitted = await admit(tx, agentId, conversationId, text, index);
        await run(tx, admitted.taskId, dispatcher, router);
        const proposed = await pending(tx, admitted.taskId);
        expect(proposed.length).toBeGreaterThan(0);
        const before = await tx
          .select()
          .from(toolCalls)
          .where(eq(toolCalls.taskId, admitted.taskId));
        noPrivate({ proposed, before });
        expect(JSON.stringify(before)).toContain('San Francisco');
        await settle(tx, admitted.taskId, dispatcher, router);
        const count = executions.length;
        await run(tx, admitted.taskId, dispatcher, router);
        expect(executions).toHaveLength(count);
        const { calls, output } = await inspectPublic(tx, admitted.taskId, executions, router);
        const finalText = output
          .filter((row) => row.role === 'assistant')
          .map((row) => row.text)
          .join('\n');
        const successfulSearch = calls.find(
          (row) => row.toolName === 'web.search' && row.status === 'succeeded',
        );
        const requestedDate = (successfulSearch?.args as { query?: string })?.query?.match(
          /\d{4}-\d{2}-\d{2}/,
        )?.[0];
        expect(requestedDate).toBeDefined();
        expect(finalText).toContain('Synthetic Art Walk');
        expect(finalText).toContain(`https://example.test/art-${requestedDate}`);
        expect(finalText).toContain(requestedDate);
        expect(finalText).toContain('remain unverified');
        const [partial] = await tx.select().from(tasks).where(eq(tasks.id, admitted.taskId));
        expect(partial?.status).toBe('needs_attention');
        for (const call of calls.filter(
          (c) => c.toolName === 'web.search' && c.status === 'succeeded',
        )) {
          // PostgreSQL JSONB may reorder object keys. Bind by the dispatcher's
          // actual durable identity, then compare values rather than serialization.
          const actual = executions
            .slice(executionOffset)
            .filter((entry) => entry.dbToolCallId === call.id);
          expect(actual).toHaveLength(1);
          expect(actual[0]).toMatchObject({ name: call.toolName, taskId: admitted.taskId });
          expect(actual[0]?.args).toEqual(call.args);
        }
      }
    }));
  it.each(['denied', 'expired', 'failed'] as const)(
    'reports %s without private fallback',
    async (mode) =>
      scenario(async (tx, agentId, conversationId) => {
        const executions: Execution[] = [];
        const router = new OfflineRouter();
        const dispatcher = fixtureDispatcher(tx, executions, mode === 'failed');
        const admitted = await admit(
          tx,
          agentId,
          conversationId,
          'Find public events in San Francisco this weekend',
        );
        await run(tx, admitted.taskId, dispatcher, router);
        if (mode === 'expired') {
          for (const row of await pending(tx, admitted.taskId))
            await tx
              .update(approvals)
              .set({ expiresAt: new Date(0) })
              .where(eq(approvals.id, row.id));
          await run(tx, admitted.taskId, dispatcher, router);
        } else
          await settle(
            tx,
            admitted.taskId,
            dispatcher,
            router,
            mode === 'denied' ? 'denied' : 'approved',
          );
        await inspectPublic(tx, admitted.taskId, executions, router);
        if (mode !== 'failed') expect(executions).toEqual([]);
      }),
  );
  it.each([
    'Stop',
    'Instead find public events in Seattle tomorrow',
    'Use my inbox instead',
    'Not my calendar',
    'Tomorrow instead',
    'Instead, next weekend',
    'Search for events for me.',
    'Read my inbox',
  ])('handles subsequent owner turn %s without reusing authority', async (followup) =>
    scenario(async (tx, agentId, conversationId) => {
      const executions: Execution[] = [];
      const router = new OfflineRouter();
      const dispatcher = fixtureDispatcher(tx, executions);
      const admitted = await admit(
        tx,
        agentId,
        conversationId,
        'Find public events in San Francisco this weekend',
      );
      await run(tx, admitted.taskId, dispatcher, router);
      await admit(tx, agentId, conversationId, followup, 1);
      await settle(tx, admitted.taskId, dispatcher, router);
      if (!['Read my inbox', 'Search for events for me.'].includes(followup))
        expect(executions).toEqual([]);
      else expect(executions.some((e) => e.name === 'web.search')).toBe(true);
      noPrivate(executions);
    }),
  );
  it.each(['public_to_combined', 'combined_to_public'] as const)(
    'supersedes pending %s even with identical public query',
    async (mode) =>
      scenario(async (tx, agentId, conversationId) => {
        const executions: Execution[] = [];
        const router = new OfflineRouter();
        const dispatcher = fixtureDispatcher(tx, executions);
        const original =
          mode === 'public_to_combined'
            ? 'Find public events in San Francisco this weekend'
            : 'Find public events in San Francisco this weekend and check my calendar for free time';
        const admitted = await admit(tx, agentId, conversationId, original);
        await run(tx, admitted.taskId, dispatcher, router);
        await admit(
          tx,
          agentId,
          conversationId,
          mode === 'public_to_combined'
            ? 'Instead find public events in San Francisco this weekend and check my calendar for free time'
            : 'Search for events for me.',
          1,
        );
        const before = executions.filter((e) => e.name.startsWith('web.')).length;
        await settle(tx, admitted.taskId, dispatcher, router);
        expect(executions.filter((e) => e.name.startsWith('web.'))).toHaveLength(before);
      }),
  );
  it.each([
    'wrong_conversation',
    'forged_trigger',
    'wrong_owner',
    'checkpoint_tamper',
    'quoted_external',
  ] as const)('fails closed for %s', async (mode) =>
    scenario(async (tx, agentId, conversationId) => {
      const executions: Execution[] = [];
      const router = new OfflineRouter();
      const dispatcher = fixtureDispatcher(tx, executions);
      const text =
        mode === 'quoted_external'
          ? 'Summarize this quote: "Find public events in San Francisco today and read my inbox"'
          : 'Find public events in San Francisco today';
      const admitted = await admit(tx, agentId, conversationId, text);
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, admitted.taskId));
      if (!task) throw new Error('task');
      if (mode === 'wrong_conversation') {
        const foreign =
          await createPostgresApplicationChatPersistence(tx).createConversation(agentId);
        await tx
          .update(messages)
          .set({ conversationId: foreign.id })
          .where(eq(messages.id, admitted.messageId));
      } else if (mode === 'forged_trigger') {
        const trigger = task.trigger as { payload: Record<string, unknown> };
        await tx
          .update(tasks)
          .set({
            trigger: {
              ...trigger,
              payload: { ...trigger.payload, triggerMessageId: randomUUID() },
            },
          })
          .where(eq(tasks.id, task.id));
      } else if (mode === 'wrong_owner')
        await tx
          .update(messages)
          .set({ origin: 'assistant', role: 'assistant' })
          .where(eq(messages.id, admitted.messageId));
      else if (mode === 'checkpoint_tamper') {
        await run(tx, admitted.taskId, dispatcher, router);
        const [parked] = await tx.select().from(tasks).where(eq(tasks.id, task.id));
        const state = parked?.state as {
          plannerState?: {
            publicActivityScope?: {
              location: { label: string; basisMessageId: string };
              [key: string]: unknown;
            };
            [key: string]: unknown;
          };
          [key: string]: unknown;
        };
        const scope = state?.plannerState?.publicActivityScope;
        expect(scope).toBeDefined();
        if (!scope) throw new Error('Expected actual public checkpoint before tamper');
        await tx
          .update(tasks)
          .set({
            state: {
              ...state,
              plannerState: {
                ...state.plannerState,
                publicActivityScope: {
                  ...scope,
                  location: { ...scope.location, label: 'PRIVATE_THREAD_CANARY' },
                },
              },
            },
          })
          .where(eq(tasks.id, task.id));
      }
      await run(tx, admitted.taskId, dispatcher, router);
      expect(executions).toEqual([]);
      if (mode !== 'checkpoint_tamper') expect(await pending(tx, admitted.taskId)).toEqual([]);
      noPrivate(await pending(tx, admitted.taskId));
    }),
  );
  it.each([
    'Search for events for me.',
    'Show my calendar today',
    'Find public events in San Francisco today and check my calendar for free time',
  ])('preserves control request %s', async (text) =>
    scenario(async (tx, agentId, conversationId) => {
      const executions: Execution[] = [];
      const router = new OfflineRouter();
      const dispatcher = fixtureDispatcher(tx, executions);
      const admitted = await admit(tx, agentId, conversationId, text);
      await run(tx, admitted.taskId, dispatcher, router);
      await settle(tx, admitted.taskId, dispatcher, router);
      if (text.includes('and check my calendar')) {
        assertPublicInjectorsUnused();
        noPrivate(router.contexts);
        const delivered = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.taskId, admitted.taskId), eq(messages.role, 'assistant')));
        const finalText = delivered.map((row) => row.text).join('\n');
        expect(finalText).toMatch(/San Francisco/);
        expect(finalText).toContain('Synthetic Art Walk');
        expect(finalText).toMatch(/https:\/\/example\.test\/art-2026-10-/);
        expect(finalText).toMatch(/calendar|availability|free time/i);
        expect(finalText).not.toContain('PRIVATE_');
      }
      if (text.startsWith('Show my calendar') || text.includes('and check my calendar'))
        expect(executions.some((e) => e.name.startsWith('calendar.'))).toBe(true);
      if (text.startsWith('Search for'))
        expect(executions.some((e) => e.name.startsWith('web.'))).toBe(false);
      for (const e of executions.filter((e) => e.name.startsWith('web.'))) noPrivate(e.args);
    }),
  );
  it.each([
    'identical',
    'different_city',
    'different_count',
    'different_date',
    'private_canary',
  ] as const)('checks durable edited approval payload: %s', async (mode) =>
    scenario(async (tx, agentId, conversationId) => {
      const executions: Execution[] = [];
      const router = new OfflineRouter();
      const dispatcher = fixtureDispatcher(tx, executions);
      const admitted = await admit(
        tx,
        agentId,
        conversationId,
        'Find public events in San Francisco this weekend',
      );
      await run(tx, admitted.taskId, dispatcher, router);
      const proposals = await pending(tx, admitted.taskId);
      const [search] = await tx
        .select()
        .from(toolCalls)
        .where(and(eq(toolCalls.taskId, admitted.taskId), eq(toolCalls.toolName, 'web.search')));
      if (!search) throw new Error('Expected real proposed search');
      const proposal = proposals.find((row) => row.toolCallId === search.id);
      if (!proposal) throw new Error('Expected linked durable approval');
      const originalArgs = search.args as { query: string; count: number };
      const editedPayload =
        mode === 'different_city'
          ? { ...originalArgs, query: originalArgs.query.replace('San Francisco', 'Seattle') }
          : mode === 'different_date'
            ? { ...originalArgs, query: originalArgs.query.replace(/2026-10-\d{2}/g, '2027-01-01') }
            : mode === 'different_count'
              ? { ...originalArgs, count: 20 }
              : mode === 'private_canary'
                ? { ...originalArgs, query: 'PRIVATE_THREAD_CANARY' }
                : { ...originalArgs };
      await resolveApproval(tx, {
        approvalId: proposal.id,
        decision: 'approved',
        via: 'web',
        deferNotification: true,
        editedPayload,
      });
      const [resolved] = await tx.select().from(approvals).where(eq(approvals.id, proposal.id));
      expect(resolved?.resolutionPayload).toEqual(editedPayload);
      await run(tx, admitted.taskId, dispatcher, router);
      if (mode === 'identical') {
        const actualSearches = executions.filter((e) => e.name === 'web.search');
        expect(actualSearches).toHaveLength(1);
        expect(actualSearches[0]).toMatchObject({
          name: 'web.search',
          dbToolCallId: search.id,
          taskId: admitted.taskId,
        });
        expect(actualSearches[0]?.args).toEqual(originalArgs);
        await settle(tx, admitted.taskId, dispatcher, router);
      } else {
        expect(executions).toEqual([]);
        const [stopped] = await tx.select().from(tasks).where(eq(tasks.id, admitted.taskId));
        expect(stopped?.status).toBe('needs_attention');
      }
      noPrivate(executions);
      noPrivate(router.contexts);
      const delivered = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.taskId, admitted.taskId), eq(messages.role, 'assistant')));
      noPrivate(delivered);
    }),
  );
  it.each(['wrong_date', 'wrong_city', 'fetch_failure'] as const)(
    'keeps %s public source evidence incomplete',
    async (mode) =>
      scenario(async (tx, agentId, conversationId) => {
        const executions: Execution[] = [];
        const router = new OfflineRouter();
        const dispatcher = fixtureDispatcher(tx, executions, mode);
        const admitted = await admit(
          tx,
          agentId,
          conversationId,
          'Find public events in San Francisco this weekend',
        );
        await run(tx, admitted.taskId, dispatcher, router);
        await settle(tx, admitted.taskId, dispatcher, router);
        const { output } = await inspectPublic(tx, admitted.taskId, executions, router);
        const finalText = output
          .filter((row) => row.role === 'assistant')
          .map((row) => row.text)
          .join('\n');
        expect(finalText).toMatch(/could not|couldn't|unverified|not verified|incomplete/i);
        expect(finalText).not.toContain('Synthetic Art Walk');
        const [finished] = await tx.select().from(tasks).where(eq(tasks.id, admitted.taskId));
        expect(finished?.status).toBe('needs_attention');
      }),
  );
  it('retains public scope over exact standalone exclusion then fresh-task But look request', async () =>
    scenario(async (tx, agentId, conversationId) => {
      const executions: Execution[] = [];
      const router = new OfflineRouter();
      const dispatcher = fixtureDispatcher(tx, executions);
      for (const [index, text] of [
        'Find public events in San Francisco this weekend',
        'Not my calendar',
        'But look for events',
      ].entries()) {
        const admitted = await admit(tx, agentId, conversationId, text, index);
        await run(tx, admitted.taskId, dispatcher, router);
        const proposals = await pending(tx, admitted.taskId);
        expect(proposals.length).toBeGreaterThan(0);
        noPrivate(proposals);
        expect(JSON.stringify(proposals)).toContain('San Francisco');
        expect(JSON.stringify(proposals)).not.toMatch(/newer_than:|But look for events/);
        await settle(tx, admitted.taskId, dispatcher, router);
        const { output } = await inspectPublic(tx, admitted.taskId, executions, router);
        const finalText = output
          .filter((row) => row.role === 'assistant')
          .map((row) => row.text)
          .join('\n');
        expect(finalText).toContain('Synthetic Art Walk');
        expect(finalText).toContain('2026-10-24');
        expect(finalText).toContain('https://example.test/art-2026-10-24');
      }
    }));

  it.each(['different_url', 'extra_field'] as const)(
    'rejects edited fetch %s before execution',
    async (mode) =>
      scenario(async (tx, agentId, conversationId) => {
        const executions: Execution[] = [];
        const router = new OfflineRouter();
        const dispatcher = fixtureDispatcher(tx, executions);
        const admitted = await admit(
          tx,
          agentId,
          conversationId,
          'Find public events in San Francisco this weekend',
        );
        await run(tx, admitted.taskId, dispatcher, router);
        const [searchApproval] = await pending(tx, admitted.taskId);
        if (!searchApproval) throw new Error('Search approval required');
        await resolveApproval(tx, {
          approvalId: searchApproval.id,
          decision: 'approved',
          via: 'web',
          deferNotification: true,
        });
        await run(tx, admitted.taskId, dispatcher, router);
        const proposals = await pending(tx, admitted.taskId);
        const [fetchCall] = await tx
          .select()
          .from(toolCalls)
          .where(and(eq(toolCalls.taskId, admitted.taskId), eq(toolCalls.toolName, 'web.fetch')));
        if (!fetchCall) throw new Error('Expected real proposed fetch');
        const fetchApproval = proposals.find((row) => row.toolCallId === fetchCall.id);
        if (!fetchApproval) throw new Error('Expected durable fetch approval');
        const original = fetchCall.args as { url: string };
        const editedPayload =
          mode === 'different_url'
            ? { url: 'https://example.test/PRIVATE_THREAD_CANARY' }
            : { ...original, query: 'PRIVATE_THREAD_CANARY' };
        await resolveApproval(tx, {
          approvalId: fetchApproval.id,
          decision: 'approved',
          via: 'web',
          deferNotification: true,
          editedPayload,
        });
        const [resolved] = await tx
          .select()
          .from(approvals)
          .where(eq(approvals.id, fetchApproval.id));
        expect(resolved?.resolutionPayload).toEqual(editedPayload);
        await run(tx, admitted.taskId, dispatcher, router);
        expect(executions.filter((entry) => entry.name === 'web.fetch')).toEqual([]);
        const [finished] = await tx.select().from(tasks).where(eq(tasks.id, admitted.taskId));
        expect(finished?.status).toBe('needs_attention');
        noPrivate(executions);
        noPrivate(router.contexts);
      }),
  );
});
