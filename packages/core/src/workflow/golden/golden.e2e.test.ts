import { randomUUID } from 'node:crypto';
import {
  approvals,
  conversations,
  createDb,
  createPostgresGeneratedCardRepository,
  type Db,
  generatedCardRevisions,
  generatedCards,
  messages,
  responseChecks,
  tasks,
  toolCalls,
} from '@assistant/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getAgent } from '../../chat.js';
import { TaskStateSchema } from '../../events.js';
import * as generatedCardModule from '../../generative-card.js';
import { GenerativeCardSpecV1Schema } from '../../generative-card.js';
import { refreshRequestChecklist } from '../executor/checklist.js';
import { buildRequestChecklist } from '../request-checklist.js';
import { type GoldenFixture, runGoldenTask } from './harness.js';

/**
 * Golden tasks: fixtures that pin what the platform DOES with a scripted model
 * — which tools run, in what order, and what text survives the response
 * contract. This is the regression net for prompt, contract, and executor
 * changes: extend it with a fixture whenever a behavior matters enough that a
 * quiet change to it should fail CI.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

let db: Db;
let dbUp = false;
let agentId: string;
const createdTaskIds: string[] = [];
const createdConversationIds: string[] = [];
const createdCardIds: string[] = [];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('golden: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp && createdCardIds.length) {
    await db
      .delete(generatedCardRevisions)
      .where(inArray(generatedCardRevisions.cardId, createdCardIds));
    await db.delete(generatedCards).where(inArray(generatedCards.id, createdCardIds));
  }
  if (dbUp && createdConversationIds.length) {
    await db.delete(messages).where(inArray(messages.conversationId, createdConversationIds));
  }
  if (dbUp && createdTaskIds.length) {
    await db.delete(approvals).where(inArray(approvals.taskId, createdTaskIds));
    await db.delete(messages).where(inArray(messages.taskId, createdTaskIds));
    await db.delete(toolCalls).where(inArray(toolCalls.taskId, createdTaskIds));
    await db.delete(tasks).where(inArray(tasks.id, createdTaskIds));
  }
  if (dbUp && createdConversationIds.length)
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

/** The fixture's events must land inside the window the runtime resolves for "today". */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const workflowPlan = {
  action: 'workflow' as const,
  reasoning: 'look the fact up, then answer',
  steps: ['look up the fact', 'answer'],
  missingInfo: [],
};

describe('golden tasks', () => {
  it('prefers the grounded shipment answer to the raw email lookup card', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const card = GenerativeCardSpecV1Schema.parse({
      version: 1,
      title: 'Shipment A123',
      accessibilityLabel: 'Shipment A123 status',
      sourceLabel: 'Shipping email',
      facts: [{ id: 'status', value: 'Delivered', source: 'gmail.read_thread' }],
      blocks: [{ type: 'facts', factIds: ['status'] }],
    });
    const result = await runGoldenTask(db, agentId, {
      name: 'implicit-shipment-answer-card',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'What is the status of my shipment A123?' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      card,
      script: [
        { toolCalls: [{ toolName: 'gmail.read_thread', input: { threadId: 'shipment-a123' } }] },
        { text: 'Shipment A123: Delivered.' },
      ],
      tools: {
        'gmail.read_thread': {
          schema: z.object({ threadId: z.string() }),
          execute: async () => ({ messages: [{ subject: 'Shipment A123', text: 'Delivered' }] }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    const cards = TaskStateSchema.parse(task?.state).pendingFinal?.responseCards ?? [];
    for (const saved of cards)
      if (saved.kind === 'generated-card') createdCardIds.push(String(saved.id));
    expect(cards.map((saved) => saved.kind)).toEqual(['generated-card']);
    expect(cards[0]).toMatchObject({ spec: { facts: [{ value: 'Delivered' }] } });
  });

  it('refreshes the same saved card from a new read without posting a duplicate card', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('conversation missing');
    createdConversationIds.push(conversation.id);
    const card = (value: string) =>
      GenerativeCardSpecV1Schema.parse({
        version: 1,
        title: 'Shipment A456',
        accessibilityLabel: 'Shipment A456 status',
        sourceLabel: 'Shipping email',
        facts: [{ id: 'status', value, source: 'gmail.read_thread' }],
        blocks: [{ type: 'facts', factIds: ['status'] }],
      });
    const saved = await generatedCardModule.persistGeneratedCard(
      createPostgresGeneratedCardRepository(db),
      {
        agentId,
        conversationId: conversation.id,
        sourceText: 'What is the status of my shipment A456?',
        payload: {
          kind: 'generated-card',
          id: randomUUID(),
          revisionId: randomUUID(),
          sourceFingerprint: randomUUID(),
          grounding: 'evidence',
          spec: card('In transit'),
        },
        evidence: [
          {
            toolName: 'gmail.read_thread',
            status: 'succeeded',
            args: { threadId: 'shipment-a456' },
            result: { messages: [{ subject: 'Shipment A456', text: 'In transit' }] },
          },
        ],
      },
    );
    createdCardIds.push(saved.id);
    await db.insert(messages).values({
      conversationId: conversation.id,
      role: 'assistant',
      origin: 'assistant',
      text: 'In transit',
      parts: [{ type: 'data-card', data: saved }],
    });
    const result = await runGoldenTask(db, agentId, {
      name: 'saved-shipment-source-refresh',
      event: {
        source: 'internal',
        trust: 'owner',
        conversationId: conversation.id,
        payload: {
          refreshCardId: saved.id,
          instruction: `Refresh saved card ${saved.id} using gmail.read_thread with threadId shipment-a456.`,
          taintedOrigin: true,
        },
      },
      taskType: 'adhoc',
      plan: workflowPlan,
      card: card('Delivered'),
      script: [
        { toolCalls: [{ toolName: 'gmail.read_thread', input: { threadId: 'shipment-a456' } }] },
        {
          text: `The shipping email now says Delivered.\n\n${'The source says Delivered. '.repeat(80)}`,
        },
      ],
      tools: {
        'gmail.read_thread': {
          schema: z.object({ threadId: z.string() }),
          execute: async () => ({ messages: [{ subject: 'Shipment A456', text: 'Delivered' }] }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.status).toBe('done');
    expect(result.finalText).toContain('Refreshed');
    expect(result.finalText.length).toBeLessThan(650);
    const [current] = await db.select().from(generatedCards).where(eq(generatedCards.id, saved.id));
    expect(current?.currentRevisionId).not.toBe(saved.revisionId);
    const [revision] = await db
      .select()
      .from(generatedCardRevisions)
      .where(eq(generatedCardRevisions.id, current?.currentRevisionId ?? ''));
    expect(revision?.spec).toMatchObject({ facts: [{ value: 'Delivered' }] });
    const [task] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    expect(TaskStateSchema.parse(task?.state).pendingFinal?.responseCards ?? []).toEqual([]);
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id));
    expect(
      rows.flatMap((row) =>
        (row.parts as Array<{ type: string }>).filter((part) => part.type === 'data-card'),
      ),
    ).toHaveLength(1);
  });

  it('does not revive the original checklist when a newer owner message changes the request', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('missing conversation');
    createdConversationIds.push(conversation.id);
    const request = 'Find my hotel reservation and remind me';
    await db.insert(messages).values([
      {
        conversationId: conversation.id,
        role: 'user',
        text: request,
        origin: 'owner',
        createdAt: new Date(Date.now() - 2_000),
      },
      {
        conversationId: conversation.id,
        role: 'user',
        text: 'Cancel the reminder portion; keep the hotel lookup.',
        origin: 'owner',
        createdAt: new Date(Date.now() - 1_000),
      },
    ]);
    const result = await runGoldenTask(db, agentId, {
      name: 'compound-owner-correction',
      event: {
        source: 'chat',
        trust: 'owner',
        conversationId: conversation.id,
        payload: { text: request },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [
        { toolCalls: [{ toolName: 'gmail.search', input: { query: 'hotel' } }] },
        { text: 'I found the hotel reservation.' },
        { toolCalls: [{ toolName: 'reminder.create', input: { text: 'Hotel' } }] },
      ],
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => ({ results: [{ subject: 'Hotel reservation' }] }),
        },
        'reminder.create': {
          schema: z.object({ text: z.string() }),
          execute: async () => ({ reminderId: 'must-not-run' }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual(['gmail.search']);
    const [row] = await db
      .select({ state: tasks.state })
      .from(tasks)
      .where(eq(tasks.id, result.taskId));
    expect(TaskStateSchema.parse(row?.state).checklistRecoveryAttempts).toBe(0);
  });

  it('does not display a saved card or claim completion when card persistence fails', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const persist = vi
      .spyOn(generatedCardModule, 'persistGeneratedCard')
      .mockRejectedValueOnce(new Error('fixture persistence unavailable'));
    try {
      const result = await runGoldenTask(db, agentId, {
        name: 'compound-card-persistence-failure',
        event: {
          source: 'chat',
          trust: 'owner',
          payload: { text: 'Find my hotel reservation and save it as a card' },
        },
        taskType: 'chat_turn',
        plan: workflowPlan,
        script: [
          { toolCalls: [{ toolName: 'gmail.search', input: { query: 'hotel' } }] },
          { text: 'Harbor Hotel is the reservation I found.' },
        ],
        card: GenerativeCardSpecV1Schema.parse({
          version: 1,
          title: 'Harbor Hotel',
          accessibilityLabel: 'Hotel reservation',
          sourceLabel: 'gmail.search',
          facts: [{ id: 'hotel', value: 'Harbor Hotel', source: 'gmail.search' }],
          blocks: [{ type: 'hero', titleFact: 'hotel' }],
        }),
        tools: {
          'gmail.search': {
            schema: z.object({ query: z.string() }),
            execute: async () => ({ results: [{ subject: 'Harbor Hotel' }] }),
          },
        },
      });
      createdTaskIds.push(result.taskId);
      expect(persist).toHaveBeenCalledOnce();
      expect(result.status).toBe('needs_attention');
      expect(result.finalText).toContain('Not completed: save it as a card');
      const [row] = await db
        .select({ state: tasks.state })
        .from(tasks)
        .where(eq(tasks.id, result.taskId));
      const state = TaskStateSchema.parse(row?.state);
      expect(state.requestChecklist?.savedCards).toEqual([]);
      expect(
        state.pendingFinal?.responseCards?.some((card) => card.kind === 'generated-card'),
      ).not.toBe(true);
    } finally {
      persist.mockRestore();
    }
  });

  it('records card completion only after its revision is actually persisted', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runGoldenTask(db, agentId, {
      name: 'compound-card-persistence',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'Find my hotel reservation and save it as a card' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [
        { toolCalls: [{ toolName: 'gmail.search', input: { query: 'hotel' } }] },
        { text: 'Harbor Hotel is the reservation I found.' },
      ],
      card: GenerativeCardSpecV1Schema.parse({
        version: 1,
        title: 'Harbor Hotel',
        accessibilityLabel: 'Hotel reservation',
        sourceLabel: 'gmail.search',
        facts: [{ id: 'hotel', value: 'Harbor Hotel', source: 'gmail.search' }],
        blocks: [{ type: 'hero', titleFact: 'hotel' }],
      }),
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => ({ results: [{ subject: 'Harbor Hotel' }] }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    const [row] = await db
      .select({ state: tasks.state })
      .from(tasks)
      .where(eq(tasks.id, result.taskId));
    const state = TaskStateSchema.parse(row?.state);
    const receipt = state.requestChecklist?.savedCards[0];
    if (receipt) createdCardIds.push(receipt.id);
    expect(result.status).toBe('done');
    expect(receipt).toBeDefined();
    if (!receipt) throw new Error('card persistence receipt missing');
    const [revision] = await db
      .select({ id: generatedCardRevisions.id })
      .from(generatedCardRevisions)
      .where(eq(generatedCardRevisions.id, receipt.revisionId));
    expect(revision?.id).toBe(receipt.revisionId);
    expect(state.requestChecklist?.items.map((item) => item.status)).toEqual([
      'completed',
      'completed',
    ]);
  });

  it('reconciles only the current task and requires execution after approval', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const inserted = await db
      .insert(tasks)
      .values([
        { agentId, type: 'chat_turn', trust: 'owner' },
        { agentId, type: 'chat_turn', trust: 'owner' },
      ])
      .returning();
    createdTaskIds.push(...inserted.map((task) => task.id));
    const [current, other] = inserted;
    if (!current || !other) throw new Error('missing task fixtures');
    await db.insert(toolCalls).values({
      taskId: other.id,
      toolName: 'gmail.search',
      step: 0,
      risk: 'autonomous',
      status: 'succeeded',
      args: { query: 'hotel' },
      result: { results: [{ subject: 'Hotel' }] },
    });
    const [call] = await db
      .insert(toolCalls)
      .values({
        taskId: current.id,
        toolName: 'reminder.create',
        step: 1,
        risk: 'approval',
        status: 'awaiting_approval',
        args: { text: 'Hotel check-in' },
      })
      .returning();
    if (!call) throw new Error('missing approval call');
    const [approval] = await db
      .insert(approvals)
      .values({
        taskId: current.id,
        toolCallId: call.id,
        shortCode: `checklist-${current.id}`,
        summary: 'Remind about hotel',
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    if (!approval) throw new Error('missing approval');
    const state = TaskStateSchema.parse({
      requestChecklist: buildRequestChecklist('Find my hotel and remind me'),
    });
    await refreshRequestChecklist(db, current, state);
    expect(state.requestChecklist?.items.map((item) => item.status)).toEqual([
      'pending',
      'awaiting_approval',
    ]);
    await db.update(approvals).set({ status: 'approved' }).where(eq(approvals.id, approval.id));
    await refreshRequestChecklist(db, current, state);
    expect(state.requestChecklist?.items[1]?.status).toBe('blocked');
    await db
      .update(toolCalls)
      .set({ status: 'succeeded', result: { reminderId: 'r1' } })
      .where(eq(toolCalls.id, call.id));
    await refreshRequestChecklist(db, current, state);
    expect(state.requestChecklist?.items[1]?.status).toBe('completed');
    await db.update(approvals).set({ status: 'denied' }).where(eq(approvals.id, approval.id));
    await refreshRequestChecklist(db, current, state);
    expect(state.requestChecklist?.items[1]?.status).toBe('blocked');
  });

  it('finishes an omitted reminder after the lookup without repeating the lookup', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runGoldenTask(db, agentId, {
      name: 'compound-outcome-recovery',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'Find my hotel reservation and remind me tomorrow' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [
        { toolCalls: [{ toolName: 'gmail.search', input: { query: 'hotel' } }] },
        { text: 'I found your hotel reservation.' },
        {
          toolCalls: [
            {
              toolName: 'reminder.create',
              input: { text: 'Hotel check-in', when: '2026-10-01T15:00:00Z' },
            },
          ],
        },
        { text: 'The requested steps are complete.' },
      ],
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => ({ results: [{ subject: 'Harbor Hotel reservation' }] }),
        },
        'reminder.create': {
          schema: z.object({ text: z.string(), when: z.string() }),
          execute: async () => ({ reminderId: 'reminder1', kind: 'once' }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual(['gmail.search', 'reminder.create']);
    expect(result.status).toBe('done');
    const [row] = await db
      .select({ state: tasks.state })
      .from(tasks)
      .where(eq(tasks.id, result.taskId));
    const state = TaskStateSchema.parse(row?.state);
    expect(state.checklistRecoveryAttempts).toBe(1);
    expect(state.requestChecklist?.items.map((item) => item.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(state.requestChecklist?.items.every((item) => item.evidence.length === 1)).toBe(true);
  });

  it('reports the missing outcome when the bounded recovery also produces only prose', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runGoldenTask(db, agentId, {
      name: 'compound-incomplete-is-not-done',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'Find my hotel reservation and remind me' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [
        { toolCalls: [{ toolName: 'gmail.search', input: { query: 'hotel' } }] },
        { text: 'All done.' },
        { text: 'All done.' },
      ],
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => ({ results: [{ subject: 'Hotel reservation' }] }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual(['gmail.search']);
    expect(result.status).toBe('needs_attention');
    expect(result.finalText).toContain('Completed: Find my hotel reservation');
    expect(result.finalText).toContain('Not completed: remind me');
    expect(result.finalText).not.toContain('All done');
    const [row] = await db
      .select({ state: tasks.state })
      .from(tasks)
      .where(eq(tasks.id, result.taskId));
    expect(TaskStateSchema.parse(row?.state).checklistRecoveryAttempts).toBe(1);
  });

  it('does not run automatic missing-step recovery after a definitive failure', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runGoldenTask(db, agentId, {
      name: 'compound-failure-needs-attention',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'Find my hotel reservation and remind me' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [
        { toolCalls: [{ toolName: 'gmail.search', input: { query: 'hotel' } }] },
        { text: 'No hotel reservation was found.' },
      ],
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => ({ results: [], complete: true }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.status, result.finalText).toBe('needs_attention');
    expect(result.finalText).toContain('Not completed: remind me');
    const [row] = await db
      .select({ state: tasks.state })
      .from(tasks)
      .where(eq(tasks.id, result.taskId));
    expect(TaskStateSchema.parse(row?.state).checklistRecoveryAttempts).toBe(0);
  });

  it('resolves a short hotel follow-up from owner history and reads the confirmation', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('missing test conversation');
    createdConversationIds.push(conversation.id);
    await db.insert(messages).values([
      {
        conversationId: conversation.id,
        role: 'user',
        text: 'Save my hotel reservation',
        origin: 'owner',
        createdAt: new Date(Date.now() - 3_000),
      },
      {
        conversationId: conversation.id,
        role: 'assistant',
        text: 'You are probably staying in Morgan Hill.',
        origin: 'assistant',
        createdAt: new Date(Date.now() - 2_000),
      },
      {
        conversationId: conversation.id,
        role: 'user',
        text: 'What time is check-in?',
        origin: 'owner',
        createdAt: new Date(Date.now() - 1_000),
      },
    ]);
    const answer = 'Your stay is at Harbor Hotel. Check-in is at 3:00 PM.';
    const result = await runGoldenTask(db, agentId, {
      name: 'lodging-context-confirmation',
      event: {
        source: 'chat',
        trust: 'owner',
        conversationId: conversation.id,
        payload: { text: 'What time is check-in?' },
      },
      taskType: 'chat_turn',
      // Even a mistaken reply plan cannot bypass runtime-owned private reads.
      plan: { action: 'reply', reasoning: 'a short follow-up', steps: [], missingInfo: [] },
      script: [{ text: answer }],
      tools: {
        'calendar.search_events': {
          schema: z.object({}).passthrough(),
          execute: async () => ({ complete: true, calendarsSearched: ['Assistant'], events: [] }),
        },
        'gmail.search': {
          schema: z.object({}).passthrough(),
          execute: async () => ({
            complete: true,
            mailboxSearched: 'assistant@example.com',
            results: [{ threadId: 'hotel-1', subject: 'Hotel booking', from: 'hotel@example.com' }],
          }),
        },
        'gmail.read_thread': {
          schema: z.object({ threadId: z.literal('hotel-1') }),
          execute: async () => ({
            messages: [{ subject: 'Hotel booking', from: 'hotel@example.com', text: answer }],
          }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual([
      'calendar.search_events',
      'gmail.search',
      'gmail.read_thread',
    ]);
    expect(result.finalText).toBe(answer);
    expect(result.finalText).not.toContain('Morgan Hill');
  });

  it('does not turn an empty lodging lookup into a plausible stay', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const guess = 'you are staying near the soccer fields.';
    const result = await runGoldenTask(db, agentId, {
      name: 'lodging-empty-is-not-a-guess',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Where are we staying?' } },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [{ text: guess }],
      tools: {
        'calendar.search_events': {
          schema: z.object({}).passthrough(),
          execute: async () => ({ complete: true, calendarsSearched: ['Assistant'], events: [] }),
        },
        'gmail.search': {
          schema: z.object({}).passthrough(),
          execute: async () => ({
            complete: true,
            mailboxSearched: 'assistant@example.com',
            results: [],
          }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual(['calendar.search_events', 'gmail.search']);
    expect(result.finalText).not.toContain('soccer fields');
    expect(result.finalText).toMatch(/no|nothing/i);
  });

  it('reads application confirmations instead of substituting interview events', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runGoldenTask(db, agentId, {
      name: 'application-history-evidence',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'What companies have I applied for?' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [{ text: 'Acme received your application.' }],
      tools: {
        'gmail.search': {
          schema: z.object({}).passthrough(),
          execute: async () => ({
            complete: true,
            mailboxSearched: 'assistant@example.com',
            results: [
              {
                threadId: 'application-1',
                subject: 'Acme application received',
                from: 'jobs@acme.example',
              },
            ],
          }),
        },
        'gmail.read_thread': {
          schema: z.object({ threadId: z.literal('application-1') }),
          execute: async () => ({
            messages: [
              { subject: 'Acme application received', text: 'Acme received your application.' },
            ],
          }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual(['gmail.search', 'gmail.read_thread']);
    expect(result.finalText).toBe('Acme received your application.');
  });

  it('leaves interactive planned work needing attention when the tool retry still does nothing', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runGoldenTask(db, agentId, {
      name: 'chat-workflow-no-silent-success',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Look up the wifi password.' } },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [{ text: 'I will look it up now.' }, { text: 'I will check that for you.' }],
      tools: {
        'facts.lookup': {
          schema: z.object({ key: z.string() }),
          execute: async () => ({ value: 'not reached' }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual([]);
    expect(result.status).toBe('needs_attention');
    expect(result.finalText).toContain("couldn't produce a concrete action");
    expect(result.finalText).not.toContain('I will check');
  });

  it('runs the scripted tool sequence in order and delivers the final text', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'lookup-then-answer',
      event: { source: 'chat', trust: 'owner', payload: { text: 'What is our wifi password?' } },
      taskType: 'adhoc',
      plan: workflowPlan,
      script: [
        { toolCalls: [{ toolName: 'facts.lookup', input: { key: 'wifi' } }] },
        { text: 'It is in your workspace notes: hunter2.' },
      ],
      tools: {
        'facts.lookup': {
          schema: z.object({ key: z.string() }),
          execute: async () => ({ value: 'hunter2' }),
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual(['facts.lookup']);
    expect(result.finalText).toContain('hunter2');
  });

  /**
   * The owner's most common question. What is pinned here is that the ANSWER is
   * the model's — the executor used to render calendar replies from the ledger
   * without ever asking for one, which is why no amount of prompt work ever
   * changed how a schedule answer read.
   */
  it('lets the model write a day agenda once the calendar read is grounded', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const agenda = [
      'Two things today, and the afternoon is the tight one:',
      '- **09:30–10:15** — Linear interview prep — Zoom',
      '- **13:00–14:00** — Dentist — Laugavegur 12',
    ].join('\n');
    const fixture: GoldenFixture = {
      name: 'calendar-day-answer-grounded',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'what is happening today?' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      // The required calendar read is dispatched by the runtime, not scripted;
      // this entry is consumed by the answer turn that follows it.
      script: [{ text: agenda }],
      tools: {
        'calendar.list_events': {
          schema: z.object({}).passthrough(),
          execute: async () => ({
            complete: true,
            calendarsSearched: ['Assistant'],
            events: [
              {
                eventId: 'evt-prep',
                calendarId: 'primary',
                calendar: 'Assistant',
                summary: 'Linear interview prep',
                location: 'Zoom',
                start: `${today()}T09:30:00Z`,
                end: `${today()}T10:15:00Z`,
              },
              {
                eventId: 'evt-dentist',
                calendarId: 'primary',
                calendar: 'Assistant',
                summary: 'Dentist',
                location: 'Laugavegur 12',
                start: `${today()}T13:00:00Z`,
                end: `${today()}T14:00:00Z`,
              },
            ],
          }),
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual(['calendar.list_events']);
    // The agenda goes out as written, not restated as a field dump.
    expect(result.finalText).toBe(agenda);
    expect(result.finalText).not.toContain("Here's what the calendar has");
    expect(result.finalText).not.toContain('organizer:');

    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check?.blocked).toBe(false);
  });

  it('blocks an invented flight return time before the calendar tool executes', async (ctx) => {
    if (!dbUp) return ctx.skip();
    let executed = false;
    const result = await runGoldenTask(db, agentId, {
      name: 'calendar-flight-write-rejects-invented-return-time',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: {
          text: 'Add my United flight from SFO to BER to my calendar. It leaves Oct 9 at 9:15 AM PDT and arrives Oct 11 at 5:15 AM CEST.',
        },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [
        {
          toolCalls: [
            {
              toolName: 'calendar.create_event',
              input: {
                summary: 'United flight SFO to BER',
                start: '2026-10-09T09:15:00-07:00',
                end: '2026-10-11T13:15:00+02:00',
                description: '',
                location: 'SFO to BER',
                attendees: [],
              },
            },
          ],
        },
        { text: 'I need to confirm the arrival time before I add this.' },
      ],
      tools: {
        'calendar.create_event': {
          schema: z.object({}).passthrough(),
          execute: async () => {
            executed = true;
            return { eventId: 'should-not-exist' };
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);

    expect(executed).toBe(false);
    expect(result.toolNames).toEqual([]);
    expect(result.finalText).toContain('confirm');
  });

  it('stages a quality-failure response as needs attention before a malformed finish can retry', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const safeText = "I couldn't produce a reliable answer just now. Please try again.";
    const result = await runGoldenTask(db, agentId, {
      name: 'quality-failure-is-terminal',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'Tell me a short greeting.' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [{ text: safeText, qualityFailure: true, finishReason: 'error' }],
      tools: {},
    });
    createdTaskIds.push(result.taskId);

    expect(result.status, result.finalText).toBe('needs_attention');
    expect(result.finalText).toBe(safeText);
    expect(result.toolNames).toEqual([]);
  });

  it('falls back to the verified list when the agenda invents an event', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'calendar-day-answer-fabricated',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'what is happening today?' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [
        {
          text: [
            'Two things today:',
            '- **09:30–10:15** — Linear interview prep — Zoom',
            '- **19:00–21:00** — Dinner at Zuni Cafe — 1658 Market St',
          ].join('\n'),
        },
      ],
      tools: {
        'calendar.list_events': {
          schema: z.object({}).passthrough(),
          execute: async () => ({
            complete: true,
            calendarsSearched: ['Assistant'],
            events: [
              {
                eventId: 'evt-prep',
                calendarId: 'primary',
                calendar: 'Assistant',
                summary: 'Linear interview prep',
                location: 'Zoom',
                start: `${today()}T09:30:00Z`,
                end: `${today()}T10:15:00Z`,
              },
            ],
          }),
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.finalText).not.toContain('Zuni Cafe');
    expect(result.finalText).toContain('Linear interview prep');
    // A fallback is not an honesty failure: the owner still gets every fact.
    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check?.blocked).toBe(false);
  });

  it('retries a failed private read once, then delivers an explicit coverage gap', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'calendar-read-outage-is-honest',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'what is happening today?' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [],
      tools: {
        'calendar.list_events': {
          schema: z.object({}).passthrough(),
          execute: async () => {
            throw new Error('calendar provider is temporarily unavailable');
          },
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    // The runtime owns private reads, so it retries exactly once without ever
    // letting the scripted model fill the gap with remembered or guessed events.
    expect(result.toolNames).toEqual(['calendar.list_events', 'calendar.list_events']);
    expect(result.finalText).toContain("That's everything I could actually see.");
    expect(result.finalText).toContain('calendar provider is temporarily unavailable');
    expect(result.finalText).not.toContain('Done.');

    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check).toMatchObject({ blocked: true, unsupportedCount: 1 });

    const calls = await db
      .select({ status: toolCalls.status, error: toolCalls.error })
      .from(toolCalls)
      .where(eq(toolCalls.taskId, result.taskId));
    expect(calls).toEqual([
      { status: 'failed', error: 'Error: calendar provider is temporarily unavailable' },
      { status: 'failed', error: 'Error: calendar provider is temporarily unavailable' },
    ]);
  });

  it('lets the response contract block an action claim with no tool evidence', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'fabricated-send-claim',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Email Anna the agenda.' } },
      taskType: 'adhoc',
      // A reply-shaped plan: mustAct would otherwise retry the toolless step
      // and never let this fabricated claim reach the contract at all.
      plan: { ...workflowPlan, action: 'reply' as const },
      // The scripted model claims a send happened; no tool ever ran.
      script: [{ text: "Done — I've sent the email to Anna with the agenda." }],
      tools: {},
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual([]);
    // The delivered text must not carry the unsupported claim verbatim.
    expect(result.finalText).not.toContain("I've sent the email");
    expect(result.status).toBe('needs_attention');

    // The verdict is persisted for aggregation, not only rewritten.
    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check?.blocked).toBe(true);
  });

  it('replaces a completion claim when a proactive action definitively failed', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'failed-send-cannot-look-complete',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Text me the door code.' } },
      taskType: 'adhoc',
      plan: workflowPlan,
      script: [
        { toolCalls: [{ toolName: 'sms.send', input: { to: 'owner', body: 'Door code: 4821' } }] },
        { text: "Done — I've sent the text with the door code." },
      ],
      tools: {
        'sms.send': {
          schema: z.object({ to: z.string(), body: z.string() }),
          execute: async () => {
            throw new Error('SMS provider rejected the request');
          },
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual(['sms.send']);
    expect(result.finalText).not.toContain("I've sent the text");
    expect(result.finalText).toContain("I couldn't complete this because");
    expect(result.finalText).toContain('SMS provider rejected the request');
    expect(result.status).toBe('needs_attention');

    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check).toMatchObject({ blocked: true, unsupportedCount: 1 });
  });

  it('records a clean response check for an honest answer', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'honest-answer',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Say hi.' } },
      taskType: 'adhoc',
      plan: { ...workflowPlan, action: 'reply' as const },
      script: [{ text: 'Hi! What can I do for you?' }],
      tools: {},
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check).toBeDefined();
    expect(check?.blocked).toBe(false);
    expect(check?.mustActRetries).toBe(0);
    expect(result.status).toBe('done');
  });

  it('self-reviews a clean draft once, records the revision, and still delivers through the contract', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'self-reflective-revision',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Say hi.' } },
      taskType: 'adhoc',
      plan: { ...workflowPlan, action: 'reply' as const },
      script: [{ text: 'Hi.' }],
      verification: {
        decision: 'revise',
        revisedText: 'Hi! What can I help with?',
        reasons: ['clarity_or_format'],
      },
      tools: {},
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.finalText).toBe('Hi! What can I help with?');
    expect(result.status).toBe('done');
    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check).toMatchObject({
      blocked: false,
      outputVerificationAttempted: true,
      outputVerificationRevised: true,
      outputVerificationUnavailable: false,
    });
  });

  it('delivers the checked draft and records a verifier outage without failing the owner response', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'self-reflective-verifier-unavailable',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Say hi.' } },
      taskType: 'adhoc',
      plan: { ...workflowPlan, action: 'reply' as const },
      script: [{ text: 'Hi! What can I do for you?' }],
      verification: { unavailable: true },
      tools: {},
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.finalText).toBe('Hi! What can I do for you?');
    expect(result.status).toBe('done');
    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check).toMatchObject({
      blocked: false,
      outputVerificationAttempted: false,
      outputVerificationRevised: false,
      outputVerificationUnavailable: true,
    });
  });

  it('holds a self-review revision to the same evidence contract before delivery', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'self-reflective-revision-is-contract-checked',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Say hi.' } },
      taskType: 'adhoc',
      plan: { ...workflowPlan, action: 'reply' as const },
      script: [{ text: 'Hi.' }],
      verification: {
        decision: 'revise',
        revisedText: 'Hi — I sent the email to Anna.',
        reasons: ['unsupported_claim'],
      },
      tools: {},
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.finalText).not.toContain('I sent the email');
    expect(result.finalText).toBe('Hi.');
    expect(result.status).toBe('done');
    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check).toMatchObject({
      blocked: true,
      unsupportedCount: 1,
      outputVerificationAttempted: true,
      outputVerificationRevised: true,
    });
  });

  it.for([
    { name: 'invented-link', revision: 'Hi. Read https://invented.example/receipt.' },
    { name: 'malformed-wording', revision: 'The reported temperature is 12°Chare.' },
  ])(
    'preserves the checked draft after a rejected $name review',
    async ({ name, revision }, ctx) => {
      if (!dbUp) return ctx.skip();
      const fixture: GoldenFixture = {
        name: `self-review-rejected-${name}`,
        event: { source: 'chat', trust: 'owner', payload: { text: 'Say hi.' } },
        taskType: 'adhoc',
        plan: { ...workflowPlan, action: 'reply' as const },
        script: [{ text: 'Hi.' }],
        verification: { decision: 'revise', revisedText: revision, reasons: ['clarity_or_format'] },
        tools: {},
      };
      const result = await runGoldenTask(db, agentId, fixture);
      createdTaskIds.push(result.taskId);
      expect(result.finalText).toBe('Hi.');
      expect(result.status).toBe('done');
      expect(result.toolNames).toEqual([]);
      const [check] = await db
        .select()
        .from(responseChecks)
        .where(eq(responseChecks.taskId, result.taskId));
      expect(check).toMatchObject({
        outputVerificationAttempted: true,
        outputVerificationRevised: true,
        outputVerificationUnavailable: false,
      });
    },
  );

  it('lets an action claim WITH tool evidence through untouched', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // The inverse of the fabricated-claim fixture: the send actually ran, so
    // the contract must not rewrite the honest confirmation. This pins the
    // false-positive side — a claim-detection tightening that starts blocking
    // real confirmations fails here, not on a user.
    const fixture: GoldenFixture = {
      name: 'evidence-supported-send',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Text me the door code.' } },
      taskType: 'adhoc',
      plan: workflowPlan,
      script: [
        { toolCalls: [{ toolName: 'sms.send', input: { to: 'owner', body: 'Door code: 4821' } }] },
        { text: "Done — I've sent the text with the door code." },
      ],
      tools: {
        'sms.send': {
          schema: z.object({ to: z.string(), body: z.string() }),
          execute: async () => ({ deliveryStatus: 'accepted', sid: 'SM-golden-1' }),
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual(['sms.send']);
    expect(result.finalText).toContain("I've sent the text");
    expect(result.status).toBe('done');

    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check?.blocked).toBe(false);
    expect(check?.unsupportedCount).toBe(0);
  });

  it('strips a fabricated link but does not block the answer around it', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // The REWRITE verdict path: an unevidenced URL loses its href while the
    // answer survives — distinct from blocking, and the only place the
    // urlCorpus assembly in finalize.ts is exercised end to end.
    const fixture: GoldenFixture = {
      name: 'fabricated-link',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Where do I manage this?' } },
      taskType: 'adhoc',
      plan: { ...workflowPlan, action: 'reply' as const },
      script: [
        {
          text: 'You can manage it at https://acme.example/settings/9f3a2b under Preferences.',
        },
      ],
      tools: {},
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.finalText).not.toContain('https://acme.example/settings/9f3a2b');
    expect(result.finalText).toMatch(/removed a link/i);
    expect(result.status).toBe('done');

    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check?.blocked).toBe(false);
  });

  it('forces a workflow plan to act, and counts the retry it took', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // A workflow plan whose first step proposes no tool is retried with the
    // forced-action nudge; the retry consumes the next script entry. Closes
    // the carve-out the fabricated-send fixture's comment notes.
    const fixture: GoldenFixture = {
      name: 'must-act-retry',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Look up the wifi password.' } },
      taskType: 'adhoc',
      plan: workflowPlan,
      script: [
        { text: 'I will look that up now.' }, // toolless first step → forced retry
        { toolCalls: [{ toolName: 'facts.lookup', input: { key: 'wifi' } }] },
        { text: 'It is hunter2.' },
      ],
      tools: {
        'facts.lookup': {
          schema: z.object({ key: z.string() }),
          execute: async () => ({ value: 'hunter2' }),
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual(['facts.lookup']);
    const [check] = await db
      .select()
      .from(responseChecks)
      .where(eq(responseChecks.taskId, result.taskId));
    expect(check?.mustActRetries).toBe(1);
    expect(check?.blocked).toBe(false);
  });

  it('answers save-status checks without letting a planner or prose model invent a receipt', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('missing test conversation');
    createdConversationIds.push(conversation.id);
    const [previous] = await db
      .insert(tasks)
      .values({
        agentId,
        conversationId: conversation.id,
        type: 'chat_turn',
        status: 'failed',
        trust: 'owner',
        trigger: { source: 'chat', payload: { text: 'Remember our family birthdays' } },
        createdAt: new Date(Date.now() - 60_000),
      })
      .returning();
    if (!previous) throw new Error('missing previous task');
    createdTaskIds.push(previous.id);
    await db.insert(toolCalls).values({
      taskId: previous.id,
      toolName: 'occasions.save',
      step: 1,
      risk: 'autonomous',
      status: 'succeeded',
      args: { kind: 'birthday' },
      result: { saved: true, person: 'Ada', quarantined: false },
    });
    const result = await runGoldenTask(db, agentId, {
      name: 'save-status-without-model',
      event: {
        source: 'chat',
        trust: 'owner',
        conversationId: conversation.id,
        payload: { text: 'Was it save to long term memory' },
      },
      taskType: 'chat_turn',
      tools: {},
      script: [{ text: 'Everything has been saved!' }],
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual([]);
    expect(result.finalText).toContain('Partly.');
    expect(result.finalText).toContain('1 birthday entry in People: Ada');
    expect(result.finalText).not.toContain('Everything has been saved');
  });

  it('looks up and reads a current score before accepting a model answer', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runGoldenTask(db, agentId, {
      name: 'home-live-score',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'What is the current Giants score?' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [{ text: 'The game is tied 1–1 in the fifth inning.' }],
      tools: {
        'web.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => ({ results: [{ url: 'https://example.com/game' }] }),
        },
        'web.fetch': {
          schema: z.object({ url: z.string() }),
          execute: async () => ({ status: 200, text: 'Giants 1 Dodgers 1. Fifth inning.' }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual(['web.search', 'web.fetch']);
    expect(result.finalText).toContain('1–1');
  });

  it('blocks invented temperatures after the weather provider fails', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runGoldenTask(db, agentId, {
      name: 'home-failed-weather',
      event: { source: 'chat', trust: 'owner', payload: { text: 'How is the weather currently?' } },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [
        { toolCalls: [{ toolName: 'weather.lookup', input: { place: 'San Francisco' } }] },
        { text: 'It is sunny and 14°C right now.' },
      ],
      tools: {
        'weather.lookup': {
          schema: z.object({ place: z.string() }),
          execute: async () => {
            throw new Error('HTTP 400');
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toEqual(['weather.lookup']);
    expect(result.status).toBe('needs_attention');
    expect(result.finalText).toContain("can't confirm temperatures");
    expect(result.finalText).not.toContain('14°C');
  });

  it('saves a multi-person birthday list in bounded batches with an exact receipt', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const names = Array.from({ length: 17 }, (_, i) => `Person ${i + 1}`);
    const result = await runGoldenTask(db, agentId, {
      name: 'home-birthday-batch',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: {
          text: `Remember these birthdays:\n${names.map((name) => `${name} April 20, 1980`).join('\n')}`,
        },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      maxSteps: 5,
      script: [{ text: 'Everything is saved and linked in your graph.' }],
      tools: {
        'memory.save': {
          schema: z.object({ subject: z.string(), content: z.string() }),
          execute: async () => ({ saved: true, quarantined: false }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.toolNames).toHaveLength(17);
    expect(result.toolNames.every((name) => name === 'memory.save')).toBe(true);
    expect(result.status).toBe('done');
    expect(result.finalText).toContain('Saved 17 of 17');
    expect(result.finalText).not.toContain('Everything is saved and linked');
  });

  it('does not mark graph attachment complete after memory saves alone', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await runGoldenTask(db, agentId, {
      name: 'home-birthday-graph-coverage',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: {
          text: 'Attach these birthdays to my graph and memory:\nAda April 20, 1980\nGrace May 2, 1985',
        },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      script: [{ text: 'Everything is linked.' }],
      tools: {
        'memory.save': {
          schema: z.object({ subject: z.string(), content: z.string() }),
          execute: async () => ({ saved: true }),
        },
      },
    });
    createdTaskIds.push(result.taskId);
    expect(result.finalText).toContain('Saved 2 of 2');
    expect(result.finalText).toContain('Graph attachments are not yet verified');
    expect(result.status).toBe('needs_attention');
  });

  it('reports saved birthdays when a batch reaches the step cap', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'birthday-step-cap-receipt',
      event: {
        source: 'chat',
        trust: 'owner',
        payload: { text: 'Remember our family birthdays, update their information.' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      maxSteps: 1,
      script: [
        {
          toolCalls: [
            { toolName: 'occasions.save', input: { subject: 'Ada', kind: 'birthday' } },
            { toolName: 'occasions.save', input: { subject: 'Grace', kind: 'birthday' } },
          ],
        },
      ],
      tools: {
        'occasions.save': {
          schema: z.object({ subject: z.string(), kind: z.string() }),
          execute: async (args) => ({
            saved: true,
            person: z.object({ subject: z.string() }).parse(args).subject,
            quarantined: false,
          }),
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);
    expect(result.status).toBe('failed');
    expect(result.finalText).toContain('2 birthday entries in People: Ada, Grace');
    expect(result.finalText).toContain('remaining work has not been completed');
  });

  it('reports verified progress instead of an opaque failure when proactive work reaches its step cap', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const fixture: GoldenFixture = {
      name: 'step-cap-progress-summary',
      event: {
        source: 'internal',
        trust: 'assistant',
        payload: { instruction: 'Find the wifi password and then send it to me.' },
      },
      taskType: 'adhoc',
      plan: workflowPlan,
      maxSteps: 1,
      script: [
        {
          text: 'I found the wifi password in the workspace notes, but have not sent it yet.',
          toolCalls: [{ toolName: 'facts.lookup', input: { key: 'wifi' } }],
        },
      ],
      tools: {
        'facts.lookup': {
          schema: z.object({ key: z.string() }),
          execute: async () => ({ value: 'hunter2' }),
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual(['facts.lookup']);
    expect(result.status).toBe('failed');
    expect(result.finalText).toContain('stopped after 1 steps without finishing');
    expect(result.finalText).toContain('1 tool call completed (facts.lookup)');
    expect(result.finalText).toContain('remaining work has not been completed');
    // The model's pre-tool narration is not a verified completion summary.
    expect(result.finalText).not.toContain('found the wifi password');
    expect(result.finalText).not.toContain('See task log');
  });
});
