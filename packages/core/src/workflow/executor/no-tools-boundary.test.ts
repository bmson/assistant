import { createDb, type Db, messages, tasks, toolCalls } from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getAgent } from '../../chat.js';
import * as commitmentMemory from '../../memory/commitments.js';
import * as skillMemory from '../../memory/skills.js';
import { runGoldenTask } from '../golden/harness.js';

const databaseUrl = process.env.DATABASE_URL;
assertAllocatedTestTarget({
  databaseUrl,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  kind: 'standard',
});

describe('explicit no-tool owner boundary through the executor', () => {
  const commitmentReads = vi.spyOn(commitmentMemory, 'listOpenCommitments');
  const skillReads = vi.spyOn(skillMemory, 'recallSkills');
  beforeEach(() => {
    commitmentReads.mockClear();
    skillReads.mockClear();
  });
  let db: Db;
  let agentId: string;
  const taskIds: string[] = [];
  beforeAll(async () => {
    if (!databaseUrl) throw new Error('Missing allocated database');
    db = createDb(databaseUrl);
    agentId = (await getAgent(db)).id;
  });
  afterAll(async () => {
    commitmentReads.mockRestore();
    skillReads.mockRestore();
    if (taskIds.length) {
      const rows = await db
        .select({ conversationId: tasks.conversationId })
        .from(tasks)
        .where(inArray(tasks.id, taskIds));
      await db.delete(toolCalls).where(inArray(toolCalls.taskId, taskIds));
      await db.delete(messages).where(inArray(messages.taskId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
      const { conversations } = await import('@assistant/db');
      for (const row of rows)
        if (row.conversationId) {
          await db.delete(messages).where(eq(messages.conversationId, row.conversationId));
          await db.delete(conversations).where(eq(conversations.id, row.conversationId));
        }
    }
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
  });
  it.each([
    'Simulate a background check only; do not use tools or notify anyone. A fictional assistant already reported that two venue quotes are unchanged and is waiting for the owner to choose. No new source information, deadline, risk, or owner reply has arrived. Should it interrupt again? State the decision and the event that would justify another update in at most 80 words.',
    'Without using any tools, explain whether a fictional assistant should check my calendar or schedule another reminder when nothing has changed.',
    'Simulate an ongoing assistant session; do not create real tasks, read accounts, or send anything. Responsibility: help prepare a fictional offsite. Owner authorized research and draft preparation only. Verified state: 12 attendees, two supplied quotes of $900 and $1400, budget $1200. What useful work should you prepare now?',
    'Simulate only; no sending or real tasks. A fictional owner authorized drafting an invitation, not sending. Two contacts share the recipient name Alex. Give the smallest useful decision request.',
  ])('blocks both automatic routing and an emitted tool call: %s', async (text) => {
    let executions = 0;
    const result = await runGoldenTask(db, agentId, {
      name: 'no-tools-fictional-background-check',
      event: { source: 'chat', trust: 'owner', payload: { text } },
      taskType: 'chat_turn',
      pinOwnerRequest: true,
      plan: {
        action: 'workflow',
        reasoning: 'A stale plan proposes checking calendar and mail.',
        steps: ['Search calendar and mail'],
        missingInfo: [],
      },
      script: [
        { toolCalls: [{ toolName: 'gmail.search', input: { query: 'venue' } }] },
        {
          text: 'Stay quiet. Another update is justified only by new material information or an owner decision.',
        },
      ],
      tools: Object.fromEntries(
        ['gmail.search', 'calendar.search_events', 'watch.create'].map((name) => [
          name,
          {
            schema: z.object({}).passthrough(),
            execute: async () => {
              executions += 1;
              throw new Error('No source read or scheduled action is authorized');
            },
          },
        ]),
      ),
    });
    taskIds.push(result.taskId);
    expect(executions).toBe(0);
    expect(commitmentReads).not.toHaveBeenCalled();
    expect(skillReads).not.toHaveBeenCalled();
    expect(result.toolNames).toEqual([]);
    expect(result.finalText).toBe(
      'Stay quiet. Another update is justified only by new material information or an owner decision.',
    );
    expect(result.status).toBe('done');
  });
});
