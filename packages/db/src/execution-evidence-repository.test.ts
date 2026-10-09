import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresExecutionEvidenceRepository } from './execution-evidence-repository.js';
import { agents, conversations, messages, responseChecks, tasks, toolCalls } from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL;
const testUrl = () => {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
};

describe('PostgreSQL execution evidence repository', () => {
  let db: Db | undefined;
  const ids = {
    task: randomUUID(),
    conversation: randomUUID(),
    call: randomUUID(),
    agent: randomUUID(),
    foreignAgent: randomUUID(),
    foreignConversation: randomUUID(),
  };

  afterEach(async () => {
    if (!db) return;
    await db.delete(responseChecks).where(eq(responseChecks.taskId, ids.task));
    await db.delete(messages).where(eq(messages.taskId, ids.task));
    await db.delete(toolCalls).where(eq(toolCalls.taskId, ids.task));
    await db.delete(tasks).where(inArray(tasks.id, [ids.task]));
    await db
      .delete(conversations)
      .where(inArray(conversations.id, [ids.conversation, ids.foreignConversation]));
    await db.delete(agents).where(inArray(agents.id, [ids.agent, ids.foreignAgent]));
    await db.$client.end();
    db = undefined;
  });

  it('scopes evidence and rejects a silently truncated result', async () => {
    db = createDb(testUrl());
    const repository = createPostgresExecutionEvidenceRepository(db);
    await db.insert(agents).values({
      id: ids.agent,
      name: 'evidence owner',
      email: `${ids.agent}@invalid.test`,
      workspacePrefix: `evidence/${ids.agent}`,
    });
    await db.insert(agents).values({
      id: ids.foreignAgent,
      name: 'foreign evidence owner',
      email: `${ids.foreignAgent}@invalid.test`,
      workspacePrefix: `evidence/${ids.foreignAgent}`,
    });
    await db.insert(conversations).values([
      {
        id: ids.conversation,
        agentId: ids.agent,
        title: 'Evidence',
        channel: 'chat',
        trust: 'owner',
      },
      {
        id: ids.foreignConversation,
        agentId: ids.foreignAgent,
        title: 'Foreign evidence',
        channel: 'chat',
        trust: 'owner',
      },
    ]);
    await db.insert(tasks).values({
      id: ids.task,
      agentId: ids.agent,
      conversationId: ids.conversation,
      type: 'chat_turn',
      trust: 'owner',
      status: 'done',
    });
    await db.insert(toolCalls).values({
      id: ids.call,
      taskId: ids.task,
      step: 1,
      toolName: 'test.evidence',
      risk: 'autonomous',
      status: 'succeeded',
      args: {},
      result: { ok: true },
    });
    expect(
      await repository.hasConversationToolCall({
        agentId: ids.agent,
        conversationId: ids.conversation,
        toolName: 'docs.get',
        documentId: 'doc-1',
      }),
    ).toBe(false);
    await db
      .update(toolCalls)
      .set({ toolName: 'docs.get', args: { documentId: 'doc-1' }, status: 'failed' })
      .where(eq(toolCalls.id, ids.call));
    expect(
      await repository.hasConversationToolCall({
        agentId: ids.agent,
        conversationId: ids.conversation,
        toolName: 'docs.get',
        documentId: 'doc-1',
      }),
    ).toBe(false);
    await db
      .update(toolCalls)
      .set({ status: 'succeeded', result: { content: 'Current document' } })
      .where(eq(toolCalls.id, ids.call));
    expect(
      await repository.hasConversationToolCall({
        agentId: ids.agent,
        conversationId: ids.conversation,
        toolName: 'docs.get',
        documentId: 'doc-1',
      }),
    ).toBe(true);
    expect(
      await repository.hasConversationToolCall({
        agentId: ids.agent,
        conversationId: ids.conversation,
        toolName: 'docs.get',
        documentId: 'another-doc',
      }),
    ).toBe(false);
    await expect(
      repository.taskEvidence({ agentId: randomUUID(), taskId: ids.task }),
    ).resolves.toEqual([]);
    await expect(
      repository.taskEvidence({ agentId: ids.agent, taskId: ids.task, maxRows: 1 }),
    ).resolves.toEqual([expect.objectContaining({ id: ids.call, step: 1 })]);
    await expect(
      repository.taskEvidence({ agentId: ids.agent, taskId: ids.task, maxRows: 0 }),
    ).rejects.toThrow('limit');
    await db.insert(toolCalls).values({
      taskId: ids.task,
      step: 2,
      toolName: 'gmail.send',
      risk: 'approval',
      status: 'succeeded',
      args: {},
      result: { ok: true },
    });
    await expect(
      repository.taskEvidence({ agentId: ids.agent, taskId: ids.task, maxRows: 1 }),
    ).rejects.toThrow('row bound');
    expect(await repository.taskEvidence({ agentId: ids.agent, taskId: ids.task })).toHaveLength(2);
    expect(await repository.hasOutboundReply({ agentId: ids.agent, taskId: ids.task })).toBe(true);
    await db
      .update(tasks)
      .set({ conversationId: ids.foreignConversation })
      .where(eq(tasks.id, ids.task));
    await expect(
      repository.finalMessageExists({
        agentId: ids.agent,
        taskId: ids.task,
        conversationId: ids.foreignConversation,
        text: 'must not cross scope',
      }),
    ).rejects.toThrow('conversation is outside the owner scope');
    await db.update(tasks).set({ conversationId: null }).where(eq(tasks.id, ids.task));
    await db.insert(messages).values({
      conversationId: ids.conversation,
      taskId: ids.task,
      role: 'assistant',
      origin: 'assistant',
      text: 'notification final',
      parts: [],
    });
    expect(
      await repository.finalMessageExists({
        agentId: ids.agent,
        taskId: ids.task,
        conversationId: ids.conversation,
        text: 'notification final',
      }),
    ).toBe(true);
    const input = {
      agentId: ids.agent,
      check: {
        taskId: ids.task,
        promptVersion: 1,
        plannerVersion: 1,
        blocked: false,
        unsupportedCount: 0,
        mustActRetries: 0,
        degradedSteps: 0,
        outputVerificationAttempted: false,
        outputVerificationRevised: false,
        outputVerificationUnavailable: false,
      },
    };
    expect(
      (
        await Promise.all([
          repository.recordResponseCheck(input),
          repository.recordResponseCheck(input),
        ])
      ).sort(),
    ).toEqual([false, true]);
  });
});

describe('PostgreSQL conversation evidence window', () => {
  it('keeps the newest prior tool calls when a thread outgrows the bound', async () => {
    const db = createDb(testUrl());
    const repository = createPostgresExecutionEvidenceRepository(db);
    const agent = randomUUID();
    const conversation = randomUUID();
    const current = randomUUID();
    const prior = randomUUID();
    try {
      await db.insert(agents).values({
        id: agent,
        name: 'window owner',
        email: `${agent}@invalid.test`,
        workspacePrefix: `evidence/${agent}`,
      });
      await db.insert(conversations).values({
        id: conversation,
        agentId: agent,
        title: 'Window',
        channel: 'chat',
        trust: 'owner',
      });
      await db.insert(tasks).values(
        [current, prior].map((id) => ({
          id,
          agentId: agent,
          conversationId: conversation,
          type: 'chat_turn',
          trust: 'owner',
          status: 'done',
        })),
      );
      await db.insert(toolCalls).values(
        [1, 2, 3].map((step) => ({
          taskId: prior,
          step,
          toolName: `test.step${step}`,
          risk: 'autonomous',
          status: 'succeeded',
          args: {},
          result: null,
          createdAt: new Date(Date.UTC(2026, 8, 12, 12, step)),
        })),
      );
      const window = await repository.conversationEvidence({
        agentId: agent,
        conversationId: conversation,
        excludeTaskId: current,
        maxRows: 2,
      });
      expect(window.map((row) => row.toolName)).toEqual(['test.step2', 'test.step3']);
    } finally {
      await db.delete(toolCalls).where(eq(toolCalls.taskId, prior));
      await db.delete(tasks).where(inArray(tasks.id, [current, prior]));
      await db.delete(conversations).where(eq(conversations.id, conversation));
      await db.delete(agents).where(eq(agents.id, agent));
      await db.$client.end();
    }
  });
});
