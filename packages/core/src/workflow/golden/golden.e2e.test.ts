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
import {
  buildRequestChecklist,
  recordOwnerChecklistCancellation,
  revisePendingRequestChecklistItem,
} from '../request-checklist.js';
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

function gmailThreadPage(input: {
  threadId: string;
  messages: Array<Record<string, unknown>>;
  startMessageIndex: number;
  startMessageOffset?: number;
  totalMessages: number;
  complete: boolean;
  continuation?: Record<string, unknown>;
}) {
  const startMessageOffset = input.startMessageOffset ?? 0;
  const end = input.startMessageIndex + input.messages.length;
  return {
    threadId: input.threadId,
    messages: input.messages,
    complete: input.complete,
    hasMore: !input.complete,
    coverage: {
      requested: 20,
      discovered: input.totalMessages,
      returned: input.messages.length,
      unavailable: 0,
      complete: input.complete,
    },
    ...(input.continuation ? { continuation: input.continuation } : {}),
    receipt: {
      version: 1,
      source: { kind: 'gmail-thread', id: input.threadId },
      requested: {
        start: input.startMessageIndex,
        offset: startMessageOffset,
        limit: 20,
        scope: 'thread-messages',
      },
      covered: {
        start: input.startMessageIndex,
        offset: startMessageOffset,
        end,
        count: input.messages.length,
        total: input.totalMessages,
        unavailable: 0,
      },
      complete: input.complete,
      losses: input.complete ? [] : ['provider-page'],
      continuation: input.continuation ?? null,
    },
  };
}

describe('golden tasks', () => {
  it('ranks bounded mail metadata, reads only selected complete threads, and drafts in chat without mail writes', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const prompt =
      'Review my emails from the last seven days. Find the five most important requests that still need my response. Explain why each matters, identify any deadlines, and draft replies using the relevant thread context. Don’t send anything yet.';
    const result = await runGoldenTask(db, agentId, {
      name: 'bounded-email-review-no-send-executor',
      event: { source: 'chat', trust: 'owner', payload: { text: prompt } },
      taskType: 'chat_turn',
      pinOwnerRequest: true,
      plan: workflowPlan,
      maxSteps: 12,
      objects: [
        { role: 'reason', value: { threadIds: ['request-a'] } },
        {
          role: 'reason',
          value: {
            items: [
              {
                threadId: 'request-a',
                latestMessageId: 'request-a-latest',
                disposition: 'draft',
                recipient: 'vendor@example.net',
                why: 'The sender asks for confirmation.',
                whyMessageId: 'request-a-latest',
                whyQuote: 'Could you confirm by Friday?',
                deadline: { messageId: 'request-a-latest', quote: 'by Friday' },
                draftBody: 'Thanks for your note.',
                draftSourceMessageIds: ['request-a-old', 'request-a-latest'],
              },
            ],
          },
        },
      ],
      script: [],
      tools: {
        'gmail.search': {
          schema: z.object({
            query: z.string(),
            maxResults: z.number().optional(),
            pageToken: z.string().optional(),
          }),
          execute: async (args) => {
            expect(args).toMatchObject({ query: 'newer_than:7d -from:me', maxResults: 20 });
            return {
              query: 'newer_than:7d -from:me',
              mailboxSearched: 'owner@example.com',
              complete: true,
              hasMore: false,
              unavailable: [],
              results: [
                {
                  messageId: 'newsletter-message',
                  threadId: 'newsletter',
                  from: 'news@example.org',
                  to: 'owner@example.com',
                  date: '2026-10-12T08:00:00Z',
                  subject: 'Weekly product newsletter',
                  snippet: 'This week in product news.',
                },
                {
                  messageId: 'request-a-search',
                  threadId: 'request-a',
                  from: 'vendor@example.net',
                  to: 'owner@example.com',
                  date: '2026-10-11T16:00:00Z',
                  subject: 'Please confirm renewal',
                  snippet: 'Could you confirm by Friday?',
                },
              ],
            };
          },
        },
        'gmail.read_thread': {
          schema: z.object({
            threadId: z.string(),
            startMessageIndex: z.number().optional(),
            startMessageOffset: z.number().optional(),
            maxMessages: z.number().optional(),
            maxChars: z.number().optional(),
          }),
          execute: async (input) => {
            expect(input).toMatchObject({ threadId: 'request-a', startMessageIndex: 0 });
            return gmailThreadPage({
              threadId: 'request-a',
              startMessageIndex: 0,
              totalMessages: 2,
              complete: true,
              messages: [
                {
                  messageId: 'request-a-old',
                  from: 'owner@example.com',
                  to: 'vendor@example.net',
                  date: '2026-10-10T10:00:00Z',
                  subject: 'Renewal',
                  text: 'Could you send the current terms?',
                  sourceLength: 'Could you send the current terms?'.length,
                  truncated: false,
                },
                {
                  messageId: 'request-a-latest',
                  from: 'vendor@example.net',
                  to: 'owner@example.com',
                  date: '2026-10-11T16:00:00Z',
                  subject: 'Please confirm renewal',
                  text: 'Could you confirm by Friday? The renewal remains available.',
                  sourceLength: 'Could you confirm by Friday? The renewal remains available.'
                    .length,
                  truncated: false,
                },
              ],
            });
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);

    expect(result.toolNames).toEqual(['gmail.search', 'gmail.read_thread']);
    expect(result.objectRoles).toEqual(['reason', 'reason']);
    expect(result.status).toBe('done');
    expect(result.finalText).toContain('Draft for review — not saved or sent');
    expect(result.finalText).toContain('Thanks for your note.');
    expect(result.finalText).not.toContain('Weekly product newsletter');
    expect(result.finalText).not.toContain('sent the reply');
  });

  it('uses at most twelve executor steps for three metadata pages, five threads, two continuations, and the final review', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const prompt =
      'Review my emails from the last seven days. Find the five most important requests that still need my response. Explain why each matters, identify any deadlines, and draft replies using the relevant thread context. Don’t send anything yet.';
    const selectedIds = ['request-a', 'request-b', 'request-c', 'request-d', 'request-e'];
    const messagesFor = (threadId: string) => [
      {
        messageId: `${threadId}-latest`,
        from: 'sender@example.net',
        to: 'owner@example.com',
        date: '2026-10-12T10:00:00Z',
        subject: `Request ${threadId}`,
        text: `Could you confirm request ${threadId}?`,
      },
    ];
    const rankedAnswer = {
      items: selectedIds.map((threadId) =>
        threadId === 'request-a'
          ? {
              threadId,
              latestMessageId: 'request-a-latest',
              disposition: 'draft',
              recipient: 'sender@example.net',
              why: 'The latest message asks for the revised start date.',
              whyMessageId: 'request-a-latest',
              whyQuote: 'Please confirm November 15 by Friday.',
              deadline: { messageId: 'request-a-latest', quote: 'by Friday' },
              draftBody: 'Thanks. I can confirm the revised start date of November 15.',
              draftSourceMessageIds: ['request-a-owner', 'request-a-middle', 'request-a-latest'],
            }
          : {
              threadId,
              latestMessageId: `${threadId}-latest`,
              disposition: 'draft',
              recipient: 'sender@example.net',
              why: 'The latest message asks for confirmation.',
              whyMessageId: `${threadId}-latest`,
              whyQuote: `Could you confirm request ${threadId}?`,
              deadline: null,
              draftBody: 'Thanks for the details.',
              draftSourceMessageIds: [`${threadId}-latest`],
            },
      ),
    };
    const result = await runGoldenTask(db, agentId, {
      name: 'bounded-email-review-twelve-step-cap',
      event: { source: 'chat', trust: 'owner', payload: { text: prompt } },
      taskType: 'chat_turn',
      pinOwnerRequest: true,
      plan: workflowPlan,
      maxSteps: 12,
      objects: [
        { role: 'reason', value: { threadIds: selectedIds } },
        { role: 'reason', value: rankedAnswer },
      ],
      script: [],
      tools: {
        'gmail.search': {
          schema: z.object({
            query: z.string(),
            maxResults: z.number().optional(),
            pageToken: z.string().optional(),
          }),
          execute: async (args) => {
            const pageToken = (args as { pageToken?: string }).pageToken;
            const page = !pageToken ? 1 : pageToken === 'page-2' ? 2 : 3;
            const ids =
              page === 1
                ? ['request-a', 'newsletter']
                : page === 2
                  ? ['request-b', 'request-c']
                  : ['request-d', 'request-e'];
            return {
              query: 'newer_than:7d -from:me',
              mailboxSearched: 'owner@example.com',
              complete: page === 3,
              hasMore: page < 3,
              ...(page < 3 ? { nextPageToken: `page-${page + 1}` } : {}),
              unavailable: [],
              results: ids.map((threadId) => ({
                messageId: `${threadId}-search`,
                threadId,
                from: threadId === 'newsletter' ? 'news@example.org' : 'sender@example.net',
                to: 'owner@example.com',
                date: '2026-10-12T08:00:00Z',
                subject: threadId === 'newsletter' ? 'Weekly newsletter' : `Request ${threadId}`,
                snippet:
                  threadId === 'newsletter'
                    ? 'This week in product news.'
                    : `Could you confirm request ${threadId}?`,
              })),
            };
          },
        },
        'gmail.read_thread': {
          schema: z.object({
            threadId: z.string(),
            startMessageIndex: z.number().optional(),
            startMessageOffset: z.number().optional(),
            maxMessages: z.number().optional(),
            maxChars: z.number().optional(),
          }),
          execute: async (input) => {
            const { threadId, startMessageIndex = 0 } = input as {
              threadId: string;
              startMessageIndex?: number;
            };
            if (threadId === selectedIds[0] && startMessageIndex < 2) {
              const nextIndex = startMessageIndex + 1;
              const pageMessage =
                startMessageIndex === 0
                  ? {
                      messageId: 'request-a-owner',
                      from: 'owner@example.com',
                      to: 'sender@example.net',
                      date: '2026-10-10T09:00:00Z',
                      subject: 'Renewal date',
                      text: 'I can confirm once you provide the revised date.',
                    }
                  : {
                      messageId: 'request-a-middle',
                      from: 'sender@example.net',
                      to: 'owner@example.com',
                      date: '2026-10-11T09:00:00Z',
                      subject: 'Revised renewal date',
                      text: 'We can offer November 15 instead of November 1.',
                    };
              const continuation = {
                tool: 'gmail.read_thread',
                input: {
                  threadId,
                  startMessageIndex: nextIndex,
                  startMessageOffset: 0,
                },
              };
              return gmailThreadPage({
                threadId,
                messages: [
                  { ...pageMessage, sourceLength: pageMessage.text.length, truncated: false },
                ],
                startMessageIndex,
                totalMessages: 3,
                complete: false,
                continuation,
              });
            }
            if (threadId === selectedIds[0]) {
              const latest = {
                messageId: 'request-a-latest',
                from: 'sender@example.net',
                to: 'owner@example.com',
                date: '2026-10-12T10:00:00Z',
                subject: 'Confirm revised renewal date',
                text: 'Please confirm November 15 by Friday.',
              };
              return gmailThreadPage({
                threadId,
                messages: [{ ...latest, sourceLength: latest.text.length, truncated: false }],
                startMessageIndex,
                totalMessages: 3,
                complete: true,
              });
            }
            const otherMessages = messagesFor(threadId).map((message) => ({
              ...message,
              sourceLength: message.text.length,
              truncated: false,
            }));
            return gmailThreadPage({
              threadId,
              messages: otherMessages,
              startMessageIndex,
              totalMessages: otherMessages.length,
              complete: true,
            });
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);

    expect(result.stepCount).toBe(12);
    expect(result.toolNames).toEqual([
      'gmail.search',
      'gmail.search',
      'gmail.search',
      'gmail.read_thread',
      'gmail.read_thread',
      'gmail.read_thread',
      'gmail.read_thread',
      'gmail.read_thread',
      'gmail.read_thread',
      'gmail.read_thread',
    ]);
    expect(result.objectRoles).toEqual(['reason', 'reason']);
    expect(result.status).toBe('done');
    expect(result.finalText.match(/Draft for review — not saved or sent/g)).toHaveLength(5);
    expect(result.finalText).toContain('I can confirm the revised start date of November 15.');
    expect(result.finalText).not.toContain('Weekly newsletter');
  });

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

  it('cancels only the selected parked outcome before resuming the remaining lookup', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('missing conversation');
    createdConversationIds.push(conversation.id);

    const request =
      'Find the museum ticket confirmation email and remind me about check-in tomorrow';
    let firstLookupParked = false;
    let lookupExecutions = 0;
    let reminderExecutions = 0;
    const result = await runGoldenTask(db, agentId, {
      name: 'parked-item-cancellation-resumes-supported-email-sibling',
      event: {
        source: 'chat',
        trust: 'owner',
        conversationId: conversation.id,
        payload: { text: request },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      pinOwnerRequest: true,
      resumeAfterBudget: true,
      script: [
        {
          toolCalls: [
            { toolName: 'gmail.search', input: { query: 'museum ticket' } },
            { toolName: 'reminder.create', input: { text: 'Museum ticket check-in tomorrow' } },
          ],
        },
        // The model deliberately tries the cancelled write again after resume.
        {
          toolCalls: [
            { toolName: 'reminder.create', input: { text: 'Museum ticket check-in tomorrow' } },
          ],
        },
        { text: 'I found the museum ticket confirmation. I did not create the reminder.' },
      ],
      afterFirstExecution: async ({ taskId }) => {
        const [parked] = await db
          .select({ status: tasks.status })
          .from(tasks)
          .where(eq(tasks.id, taskId));
        expect(parked?.status).toBe('waiting_budget');
        await db.insert(messages).values({
          conversationId: conversation.id,
          taskId,
          role: 'user',
          text: 'Cancel the reminder portion; keep the email lookup.',
          origin: 'owner',
        });
      },
      beforeDispatch: (input) => {
        if (input.toolName === 'gmail.search' && !firstLookupParked) {
          firstLookupParked = true;
          return {
            kind: 'budget_blocked',
            reason: 'fixture budget reset',
            resumeAt: new Date(0),
          };
        }
      },
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => {
            lookupExecutions += 1;
            return {
              complete: true,
              mailboxSearched: 'all mail',
              results: [{ subject: 'Museum ticket confirmation' }],
            };
          },
        },
        'reminder.create': {
          schema: z.object({ text: z.string() }),
          execute: async () => {
            reminderExecutions += 1;
            return { reminderId: 'must-not-run' };
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);

    expect(result.status, result.finalText).toBe('done');
    expect(result.toolNames).toEqual(['gmail.search']);
    expect(lookupExecutions).toBe(1);
    expect(reminderExecutions).toBe(0);
    expect(result.finalText).toContain('Museum ticket confirmation');
    expect(result.finalText).toContain('Cancelled by the owner; not done.');
    expect(result.finalText).toContain(
      'Thread bodies were not opened because the requested sender/subject metadata was sufficient.',
    );
    expect(result.finalText).not.toContain('reminder was created');

    const [finished] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    const checklist = TaskStateSchema.parse(finished?.state).requestChecklist;
    expect(checklist?.items.map(({ status }) => status)).toEqual(['completed', 'cancelled']);
    expect(checklist?.items[1]?.ownerCancellation?.requestSpan).toBe('Cancel the reminder portion');
    expect(checklist?.cancellationAudit).toHaveLength(1);
    expect(checklist?.lastOwnerAction).toMatchObject({
      kind: 'cancel',
      itemIds: [checklist?.items[1]?.id],
    });
  });

  it('parks a combined calendar-and-email resume when its required calendar tool is unavailable', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('missing conversation');
    createdConversationIds.push(conversation.id);

    let firstLookupParked = false;
    let reminderExecutions = 0;
    const result = await runGoldenTask(db, agentId, {
      name: 'cancellation-does-not-substitute-email-for-required-calendar-read',
      event: {
        source: 'chat',
        trust: 'owner',
        conversationId: conversation.id,
        payload: {
          text: 'Find my hotel reservation and remind me about hotel check-in tomorrow',
        },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      pinOwnerRequest: true,
      resumeAfterBudget: true,
      script: [
        {
          toolCalls: [
            { toolName: 'gmail.search', input: { query: 'hotel reservation' } },
            { toolName: 'reminder.create', input: { text: 'Hotel reservation check-in tomorrow' } },
          ],
        },
        { text: 'I found the hotel reservation. I did not create the reminder.' },
      ],
      afterFirstExecution: async ({ taskId }) => {
        const [parked] = await db
          .select({ status: tasks.status })
          .from(tasks)
          .where(eq(tasks.id, taskId));
        expect(parked?.status).toBe('waiting_budget');
        await db.insert(messages).values({
          conversationId: conversation.id,
          taskId,
          role: 'user',
          text: 'Cancel the reminder portion; keep the hotel lookup.',
          origin: 'owner',
        });
      },
      beforeDispatch: (input) => {
        if (input.toolName === 'gmail.search' && !firstLookupParked) {
          firstLookupParked = true;
          return {
            kind: 'budget_blocked',
            reason: 'fixture budget reset',
            resumeAt: new Date(0),
          };
        }
      },
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => ({
            complete: true,
            mailboxSearched: 'all mail',
            results: [{ subject: 'Harbor Hotel reservation' }],
          }),
        },
        'reminder.create': {
          schema: z.object({ text: z.string() }),
          execute: async () => {
            reminderExecutions += 1;
            return { reminderId: 'must-not-run' };
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);

    expect(result.status, result.finalText).toBe('failed');
    expect(result.finalText).toContain('Not completed: Find my hotel reservation');
    expect(result.finalText).not.toContain('found the hotel reservation');
    expect(result.finalText).not.toContain('reminder was created');
    expect(reminderExecutions).toBe(0);
    expect(result.toolNames).not.toContain('calendar.search_events');
  });

  it('does not act on a cancellation after a newer owner message changes the head', async (ctx) => {
    if (!dbUp) return ctx.skip();
    let firstLookupParked = false;
    let lookupExecutions = 0;
    let reminderExecutions = 0;
    let checklistBeforeOwnerMessages: unknown;
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('missing conversation');
    createdConversationIds.push(conversation.id);
    const result = await runGoldenTask(db, agentId, {
      name: 'cancellation-owner-head-changed-before-resume',
      event: {
        source: 'chat',
        trust: 'owner',
        conversationId: conversation.id,
        payload: { text: 'Find the hotel reservation and remind me about hotel check-in.' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      pinOwnerRequest: true,
      resumeAfterBudget: true,
      script: [
        {
          toolCalls: [
            { toolName: 'gmail.search', input: { query: 'hotel reservation' } },
            { toolName: 'reminder.create', input: { text: 'Hotel check-in tomorrow' } },
          ],
        },
      ],
      afterFirstExecution: async ({ taskId }) => {
        const [beforeMessages] = await db
          .select({ state: tasks.state })
          .from(tasks)
          .where(eq(tasks.id, taskId));
        checklistBeforeOwnerMessages = TaskStateSchema.parse(
          beforeMessages?.state,
        ).requestChecklist;
        const firstCreatedAt = new Date();
        await db.insert(messages).values({
          conversationId: conversation.id,
          taskId,
          role: 'user',
          text: 'Cancel the reminder portion; keep the hotel lookup.',
          origin: 'owner',
          createdAt: firstCreatedAt,
        });
        await db.insert(messages).values({
          conversationId: conversation.id,
          taskId,
          role: 'user',
          text: 'Actually, wait until I review this.',
          origin: 'owner',
          createdAt: new Date(firstCreatedAt.getTime() + 1),
        });
      },
      beforeDispatch: (input) => {
        if (input.toolName === 'gmail.search' && !firstLookupParked) {
          firstLookupParked = true;
          return {
            kind: 'budget_blocked',
            reason: 'fixture budget reset',
            resumeAt: new Date(0),
          };
        }
      },
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => {
            lookupExecutions += 1;
            return { complete: true, results: [{ subject: 'Harbor Hotel reservation' }] };
          },
        },
        'reminder.create': {
          schema: z.object({ text: z.string() }),
          execute: async () => {
            reminderExecutions += 1;
            return { reminderId: 'must-not-run' };
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);

    expect(result.status).toBe('needs_attention');
    expect(lookupExecutions).toBe(0);
    expect(reminderExecutions).toBe(0);
    expect(result.toolNames).toEqual([]);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    expect(task?.status).toBe('needs_attention');
    const checklist = TaskStateSchema.parse(task?.state).requestChecklist;
    expect(checklist).toEqual(checklistBeforeOwnerMessages);
    expect(checklist?.cancellationAudit).toBeUndefined();
  });

  it('preserves a prior cancellation when the owner later replaces a different pending item', async (ctx) => {
    if (!dbUp) return ctx.skip();
    let lookupExecutions = 0;
    let reminderExecutions = 0;
    let firstLookupBlocked = false;
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('missing conversation');
    createdConversationIds.push(conversation.id);

    const result = await runGoldenTask(db, agentId, {
      name: 'replacement-after-cancellation-preserves-cancelled-sibling',
      event: {
        source: 'chat',
        trust: 'owner',
        conversationId: conversation.id,
        payload: { text: 'Find my hotel reservation and remind me about hotel check-in tomorrow' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      pinOwnerRequest: true,
      resumeAfterBudget: true,
      script: [
        {
          toolCalls: [
            { toolName: 'gmail.search', input: { query: 'hotel reservation' } },
            { toolName: 'reminder.create', input: { text: 'Hotel check-in tomorrow' } },
          ],
        },
        {
          toolCalls: [{ toolName: 'reminder.create', input: { text: 'Hotel check-in tomorrow' } }],
        },
        { text: 'I found the train ticket email. I did not create the reminder.' },
      ],
      afterFirstExecution: async ({ taskId }) => {
        const [parked] = await db.select().from(tasks).where(eq(tasks.id, taskId));
        if (!parked) throw new Error('missing parked task');
        const state = TaskStateSchema.parse(parked.state);
        const checklist = state.requestChecklist;
        if (!checklist || checklist.items.length < 2) throw new Error('missing request checklist');

        const cancelledOwnerMessageId = randomUUID();
        const cancelledAt = new Date(Date.now() + 10);
        const [cancelledOwnerMessage] = await db
          .insert(messages)
          .values({
            id: cancelledOwnerMessageId,
            conversationId: conversation.id,
            taskId,
            role: 'user',
            origin: 'owner',
            text: 'Cancel the reminder portion.',
            parts: [{ type: 'text', text: 'Cancel the reminder portion.' }],
            createdAt: cancelledAt,
          })
          .returning({ id: messages.id });
        if (!cancelledOwnerMessage) throw new Error('missing cancellation owner message');
        const cancelled = recordOwnerChecklistCancellation(checklist, {
          taskId,
          agentId,
          conversationId: conversation.id,
          ownerMessageId: cancelledOwnerMessage.id,
          text: 'Cancel the reminder portion.',
        });
        if (cancelled?.lastOwnerAction?.kind !== 'cancel')
          throw new Error('fixture cancellation was not recorded');

        const replacementOwnerMessageId = randomUUID();
        const replacementAt = new Date(cancelledAt.getTime() + 10);
        const [replacementOwnerMessage] = await db
          .insert(messages)
          .values({
            id: replacementOwnerMessageId,
            conversationId: conversation.id,
            taskId,
            role: 'user',
            origin: 'owner',
            text: 'Find the train ticket email instead.',
            parts: [{ type: 'text', text: 'Find the train ticket email instead.' }],
            createdAt: replacementAt,
          })
          .returning({ id: messages.id });
        if (!replacementOwnerMessage) throw new Error('missing replacement owner message');
        const replaced = revisePendingRequestChecklistItem(cancelled, {
          task: { id: taskId, agentId, conversationId: conversation.id },
          ownerMessage: {
            id: replacementOwnerMessage.id,
            taskId,
            agentId,
            conversationId: conversation.id,
            role: 'user',
            origin: 'owner',
            text: 'Find the train ticket email instead.',
          },
          binding: {
            taskId,
            itemId: checklist.items[0]?.id ?? '',
            expectedRevision: cancelled.revision ?? 0,
            ownerTaskId: taskId,
            ownerMessageId: replacementOwnerMessage.id,
          },
          evidence: { complete: true, rows: [] },
          replacement: { kind: 'lookup', label: 'Find the train ticket email instead.' },
        });
        if (replaced.lastOwnerAction?.kind !== 'replace')
          throw new Error('fixture replacement was not recorded');
        await db
          .update(tasks)
          .set({
            state: {
              ...state,
              requestChecklist: replaced,
              seenConversationAt: replacementAt.toISOString(),
              seenConversationId: replacementOwnerMessage.id,
            },
          })
          .where(eq(tasks.id, taskId));
      },
      beforeDispatch: (input) => {
        if (input.toolName === 'gmail.search' && !firstLookupBlocked) {
          firstLookupBlocked = true;
          return {
            kind: 'budget_blocked',
            reason: 'fixture budget reset',
            resumeAt: new Date(0),
          };
        }
      },
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => {
            lookupExecutions += 1;
            return {
              complete: true,
              mailboxSearched: 'owner@example.com',
              results: [
                {
                  threadId: 'train-ticket-1',
                  subject: 'Train ticket receipt',
                  from: 'rail@example.com',
                },
              ],
            };
          },
        },
        'gmail.read_thread': {
          schema: z.object({ threadId: z.literal('train-ticket-1') }),
          execute: async () => ({
            complete: true,
            messages: [
              {
                subject: 'Train ticket receipt',
                from: 'rail@example.com',
                text: 'Your train ticket is confirmed for October 20.',
              },
            ],
          }),
        },
        'reminder.create': {
          schema: z.object({ text: z.string() }),
          execute: async () => {
            reminderExecutions += 1;
            return { reminderId: 'must-not-run' };
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);

    expect(result.status, result.finalText).toBe('done');
    expect(lookupExecutions).toBe(1);
    expect(reminderExecutions).toBe(0);
    const [finished] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    const checklist = TaskStateSchema.parse(finished?.state).requestChecklist;
    expect(checklist?.items.map((item) => item.status)).toEqual(['completed', 'cancelled']);
    expect(checklist?.lastOwnerAction).toMatchObject({ kind: 'replace' });
    expect(checklist?.cancellationAudit).toHaveLength(1);
  });

  it('parks when the cancelled sibling already has an executing ledger row', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, channel: 'chat', trust: 'owner' })
      .returning();
    if (!conversation) throw new Error('missing conversation');
    createdConversationIds.push(conversation.id);
    let blockedFirstLookup = false;
    let lookupExecutions = 0;
    let reminderExecutions = 0;
    const result = await runGoldenTask(db, agentId, {
      name: 'cancelled-running-sibling-parks-before-replay',
      event: {
        source: 'chat',
        trust: 'owner',
        conversationId: conversation.id,
        payload: { text: 'Find my hotel reservation and remind me about hotel check-in' },
      },
      taskType: 'chat_turn',
      plan: workflowPlan,
      pinOwnerRequest: true,
      resumeAfterBudget: true,
      script: [
        {
          toolCalls: [
            { toolName: 'gmail.search', input: { query: 'hotel reservation' } },
            { toolName: 'reminder.create', input: { text: 'Hotel check-in' } },
          ],
        },
      ],
      afterFirstExecution: async ({ taskId }) => {
        const [current] = await db
          .select({ state: tasks.state })
          .from(tasks)
          .where(eq(tasks.id, taskId));
        const pending = TaskStateSchema.parse(current?.state).pendingToolBatch;
        const reminder = pending?.calls.find((call) => call.toolName === 'reminder.create');
        if (!pending || !reminder) throw new Error('missing parked reminder call');
        await db.insert(messages).values({
          conversationId: conversation.id,
          taskId,
          role: 'user',
          text: 'Cancel the reminder portion; keep the hotel lookup.',
          origin: 'owner',
        });
        await db.insert(toolCalls).values({
          taskId,
          step: pending.step,
          toolName: reminder.toolName,
          args: reminder.input,
          risk: 'autonomous',
          status: 'executing',
          decision: { modelToolCallId: reminder.toolCallId },
          startedAt: new Date(),
        });
      },
      beforeDispatch: (input) => {
        if (input.toolName === 'gmail.search' && !blockedFirstLookup) {
          blockedFirstLookup = true;
          return {
            kind: 'budget_blocked',
            reason: 'fixture budget reset',
            resumeAt: new Date(0),
          };
        }
      },
      tools: {
        'gmail.search': {
          schema: z.object({ query: z.string() }),
          execute: async () => {
            lookupExecutions += 1;
            return { complete: true, results: [{ subject: 'Harbor Hotel reservation' }] };
          },
        },
        'reminder.create': {
          schema: z.object({ text: z.string() }),
          execute: async () => {
            reminderExecutions += 1;
            return { reminderId: 'must-not-run' };
          },
        },
      },
    });
    createdTaskIds.push(result.taskId);

    expect(result.status).toBe('needs_attention');
    expect(lookupExecutions).toBe(0);
    expect(reminderExecutions).toBe(0);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    const pending = TaskStateSchema.parse(task?.state).pendingToolBatch;
    expect(
      pending?.calls.map(({ toolName, status, ownerCancellation }) => ({
        toolName,
        status,
        ownerCancellation,
      })),
    ).toEqual([
      { toolName: 'gmail.search', status: 'budget', ownerCancellation: undefined },
      { toolName: 'reminder.create', status: 'queued', ownerCancellation: undefined },
    ]);
    const [startedCall] = await db
      .select({ status: toolCalls.status, decision: toolCalls.decision })
      .from(toolCalls)
      .where(eq(toolCalls.taskId, result.taskId));
    expect(startedCall?.status).toBe('executing');
    expect(startedCall?.decision).toMatchObject({
      modelToolCallId: pending?.calls.find((call) => call.toolName === 'reminder.create')
        ?.toolCallId,
    });
  });

  it('resumes a three-call batch after a budget park without asking the model for new calls', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const executions = new Map<string, number>();
    let budgetBlocked = false;
    const result = await runGoldenTask(db, agentId, {
      name: 'three-call-budget-continuation',
      event: { source: 'chat', trust: 'owner', payload: { text: 'Run all three actions.' } },
      taskType: 'chat_turn',
      plan: workflowPlan,
      resumeAfterBudget: true,
      script: [
        {
          toolCalls: [
            { toolName: 'fixture.one', input: { ordinal: 1 } },
            { toolName: 'fixture.two', input: { ordinal: 2 } },
            { toolName: 'fixture.three', input: { ordinal: 3 } },
          ],
        },
        { text: 'All three actions completed.' },
      ],
      beforeDispatch: (input) => {
        if (input.toolName === 'fixture.one' && !budgetBlocked) {
          budgetBlocked = true;
          return {
            kind: 'budget_blocked',
            reason: 'fixture budget reset',
            resumeAt: new Date(0),
          };
        }
      },
      tools: Object.fromEntries(
        ['fixture.one', 'fixture.two', 'fixture.three'].map((name) => [
          name,
          {
            schema: z.object({ ordinal: z.number() }),
            execute: async (args: unknown) => {
              const ordinal = (args as { ordinal: number }).ordinal;
              executions.set(name, (executions.get(name) ?? 0) + 1);
              return { ordinal, completed: true };
            },
          },
        ]),
      ),
    });
    createdTaskIds.push(result.taskId);
    expect(result.status).toBe('done');
    expect(result.finalText).toContain('All three actions completed.');
    expect([...executions.entries()].sort()).toEqual([
      ['fixture.one', 1],
      ['fixture.three', 1],
      ['fixture.two', 1],
    ]);
    const rows = await db
      .select({ decision: toolCalls.decision })
      .from(toolCalls)
      .where(eq(toolCalls.taskId, result.taskId));
    expect(
      rows.map((row) => (row.decision as { modelToolCallId?: string }).modelToolCallId).sort(),
    ).toEqual(['golden-1-0', 'golden-1-1', 'golden-1-2']);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    expect(TaskStateSchema.parse(task?.state).pendingToolBatch).toBeNull();
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
          { toolCalls: [{ toolName: 'gmail.read_thread', input: { threadId: 'harbor-booking' } }] },
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
            execute: async () => ({
              complete: true,
              results: [{ threadId: 'harbor-booking', subject: 'Harbor Hotel' }],
            }),
          },
          'gmail.read_thread': {
            schema: z.object({ threadId: z.literal('harbor-booking') }),
            execute: async () => ({
              complete: true,
              messages: [{ text: 'Harbor Hotel reservation confirmation.' }],
            }),
          },
        },
      });
      createdTaskIds.push(result.taskId);
      expect(persist, result.finalText).toHaveBeenCalledOnce();
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
        { toolCalls: [{ toolName: 'gmail.read_thread', input: { threadId: 'harbor-booking' } }] },
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
          execute: async () => ({
            complete: true,
            results: [{ threadId: 'harbor-booking', subject: 'Harbor Hotel' }],
          }),
        },
        'gmail.read_thread': {
          schema: z.object({ threadId: z.literal('harbor-booking') }),
          execute: async () => ({
            complete: true,
            messages: [{ text: 'Harbor Hotel reservation confirmation.' }],
          }),
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
    expect(result.status, result.finalText).toBe('done');
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
            complete: true,
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
            complete: true,
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
        outputVerificationRevised: name !== 'malformed-wording',
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
