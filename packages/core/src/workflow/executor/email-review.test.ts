import { createDb, type Db, messages, tasks, toolCalls } from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getAgent } from '../../chat.js';
import { TaskStateSchema } from '../../events.js';
import { type GoldenFixture, runGoldenTask } from '../golden/harness.js';

const DATABASE_URL = process.env.DATABASE_URL;
assertAllocatedTestTarget({
  databaseUrl: DATABASE_URL,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  kind: 'standard',
});

const request =
  'Review my emails from the last seven days. Find the five most important requests that still need my response. Explain why each matters, identify any deadlines, and draft replies using the relevant thread context. Don’t send anything yet.';
const rankedIds = Array.from({ length: 10 }, (_, index) => `executor-email-${index + 1}`);

function answerItem(threadId: string, kind: 'draft' | 'no_reply') {
  const text =
    kind === 'no_reply'
      ? `The update for ${threadId} is for your records.`
      : `Could you confirm request ${threadId}?`;
  return {
    threadId,
    latestMessageId: `latest-${threadId}`,
    disposition: kind,
    recipient: kind === 'draft' ? 'sender@example.net' : null,
    why:
      kind === 'no_reply'
        ? 'This message is informational and asks no question.'
        : 'The sender is waiting for your confirmation.',
    whyMessageId: `latest-${threadId}`,
    whyQuote: text,
    deadline: null,
    draftBody:
      kind === 'draft' ? 'Thanks for reaching out. I appreciate you checking with me.' : null,
    draftSourceMessageIds: kind === 'draft' ? [`latest-${threadId}`] : [],
  };
}

function page(threadId: string, text: string) {
  return {
    threadId,
    messages: [
      {
        messageId: `latest-${threadId}`,
        from: 'sender@example.net',
        to: 'owner@example.com',
        date: '2026-10-12T10:00:00Z',
        subject: `Request ${threadId}`,
        text,
        sourceLength: text.length,
        truncated: false,
      },
    ],
    complete: true,
    hasMore: false,
    coverage: { requested: 20, discovered: 1, returned: 1, unavailable: 0, complete: true },
    receipt: {
      version: 1,
      source: { kind: 'gmail-thread', id: threadId },
      requested: { start: 0, offset: 0, limit: 20, scope: 'thread-messages' },
      covered: { start: 0, offset: 0, end: 1, count: 1, total: 1, unavailable: 0 },
      complete: true,
      losses: [],
      continuation: null,
    },
  };
}

describe('executor email review composition', () => {
  let db: Db;
  let dbUp = false;
  let agentId = '';
  const taskIds: string[] = [];
  const conversationIds: string[] = [];

  beforeAll(async () => {
    if (!DATABASE_URL) throw new Error('Missing allocated test database URL');
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
    } catch {
      console.warn('executor/email-review.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp && taskIds.length) {
      const existing = await db
        .select({ conversationId: tasks.conversationId })
        .from(tasks)
        .where(inArray(tasks.id, taskIds));
      await db.delete(toolCalls).where(inArray(toolCalls.taskId, taskIds));
      await db.delete(messages).where(inArray(messages.taskId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
      conversationIds.push(
        ...existing.flatMap((row) => (row.conversationId ? [row.conversationId] : [])),
      );
    }
    if (dbUp && conversationIds.length) {
      await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
      const { conversations } = await import('@assistant/db');
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
    if (dbUp) await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('backfills verified no-reply threads, preserves valid drafts, and stops repeating a rejected pending thread', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const initialIds = rankedIds.slice(0, 5);
    const reserveIds = rankedIds.slice(5);
    const initialAssessment = {
      items: [
        ...initialIds.slice(0, 3).map((id) => answerItem(id, 'no_reply')),
        ...initialIds.slice(3).map((id) => answerItem(id, 'draft')),
      ],
    };
    const reserveAssessment = {
      items: [
        answerItem(reserveIds[0] as string, 'draft'),
        answerItem(reserveIds[1] as string, 'draft'),
        {
          ...answerItem(reserveIds[2] as string, 'draft'),
          draftBody: 'I can confirm that this works for me.',
        },
      ],
    };
    const failedAssessmentRepair = {
      items: [
        {
          ...answerItem(reserveIds[2] as string, 'draft'),
          draftBody: 'I can confirm that this works for me.',
        },
      ],
    };
    const replacementAssessment = {
      items: [answerItem(reserveIds[3] as string, 'draft')],
    };
    const readIds: string[] = [];
    const fixture: GoldenFixture = {
      name: 'email-review-backfill-and-rejected-assessment',
      event: { source: 'chat', trust: 'owner', payload: { text: request } },
      taskType: 'chat_turn',
      pinOwnerRequest: true,
      maxSteps: 14,
      plan: {
        action: 'workflow',
        reasoning: 'review recent email requests and prepare source-grounded drafts',
        steps: ['read email threads', 'assess reply requests', 'prepare the review'],
        missingInfo: [],
      },
      script: [{ text: 'The review is ready.' }],
      objects: [
        { role: 'reason', value: { threadIds: rankedIds } },
        { role: 'reason', value: initialAssessment },
        { role: 'reason', value: reserveAssessment },
        { role: 'reason', value: failedAssessmentRepair },
        { role: 'reason', value: replacementAssessment },
      ],
      tools: {
        'gmail.search': {
          schema: z.object({
            query: z.string(),
            maxResults: z.number().optional(),
            pageToken: z.string().optional(),
          }),
          execute: async () => ({
            query: 'newer_than:7d -from:me',
            mailboxSearched: 'owner@example.com',
            configuredOwnerMailbox: 'owner@example.com',
            complete: true,
            hasMore: false,
            unavailable: [],
            results: rankedIds.map((threadId, index) => ({
              threadId,
              messageId: `search-${threadId}`,
              from: 'sender@example.net',
              to: 'owner@example.com',
              date: `2026-10-12T${String(15 - index).padStart(2, '0')}:00:00Z`,
              subject: `Request ${threadId}`,
              snippet: `Could you confirm request ${threadId}?`,
            })),
          }),
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
            readIds.push(threadId);
            const text = initialIds.slice(0, 3).includes(threadId)
              ? `The update for ${threadId} is for your records.`
              : `Could you confirm request ${threadId}?`;
            const result = page(threadId, text);
            result.receipt.requested.start = startMessageIndex;
            result.receipt.covered.start = startMessageIndex;
            result.receipt.covered.end = startMessageIndex + 1;
            return result;
          },
        },
      },
    };
    const result = await runGoldenTask(db, agentId, fixture);
    taskIds.push(result.taskId);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, result.taskId));
    if (task?.conversationId) conversationIds.push(task.conversationId);

    expect(readIds).toEqual(rankedIds.slice(0, 9));
    expect(result.toolNames).toContain('gmail.read_thread');
    expect(result.toolNames).not.toContain('gmail.send');
    expect(result.finalText.match(/Draft for review — not saved or sent/g)).toHaveLength(5);
    expect(result.finalText).toContain(
      '3 fully assessed threads did not clearly require a response',
    );
    expect(result.finalText).toContain('1 complete thread could not be assessed reliably');
    expect(result.finalText).not.toContain('I can confirm that this works for me.');
    expect(result.finalText).not.toMatch(/\[(?:Choose|Add|Select)/i);
    expect(result.finalText).not.toContain('ranked all 80');
    expect(result.finalText).not.toContain('all 80 email threads were reviewed');
    expect(result.status).toBe('needs_attention');
    expect(TaskStateSchema.parse(task?.state).plannerState.emailReviewGeneration).toMatchObject({
      status: 'partial',
      assessmentGaps: 1,
      unassessedThreadIds: [reserveIds[2]],
    });
  });
});
