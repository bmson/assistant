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
import {
  conversationMessageSourceRevision,
  conversationMessageSpeakerRevision,
} from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { projectChecklistCorrectionResume } from '../checklist-correction-resume.js';
import { searchResult, threadResult } from '../explicit-source-read.test-fixtures.js';
import { taskState } from '../machine.js';
import { latestOwnerIntent } from '../owner-intent.js';
import { buildRequestChecklist, revisePendingRequestChecklistItem } from '../request-checklist.js';
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

describe('revision-bound multi-source Activity answer through allocated PostgreSQL', () => {
  let db: Db;
  beforeAll(() => {
    if (!databaseUrl) throw new Error('Allocated database missing');
    db = createDb(databaseUrl);
  });
  afterAll(async () => {
    await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
  });
  it.each(['validated', 'unavailable', 'unfinished'] as const)(
    'keeps the exact correction truthful when synthesis is %s',
    async (mode) => {
      const agent = await db.query.agents.findFirst();
      if (!agent) throw new Error('Allocator agent missing');
      const agentId = agent.id;
      const conversationId = randomUUID();
      const taskId = randomUUID();
      const priorTaskId = randomUUID();
      const historyId = randomUUID();
      const originalId = randomUUID();
      const correctionId = randomUUID();
      const priorReceiptId = randomUUID();
      const original = 'Check my emails for Cedar and check Assistant history for Cedar';
      const correction = 'Check Assistant history and my emails for Cedar.';
      const historyText = 'Cedar review requires budget notes.';
      const at = new Date('2026-10-15T19:00:00Z');
      await db.insert(conversations).values({
        id: conversationId,
        agentId,
        channel: 'chat',
        trust: 'owner',
        title: 'Synthetic corrected read',
      });
      await db.insert(tasks).values({
        id: priorTaskId,
        agentId,
        conversationId,
        type: 'chat_turn',
        status: 'done',
        trust: 'owner',
        createdAt: new Date('2024-10-20T12:00:00Z'),
        trigger: {},
        state: {},
      });
      await db.insert(messages).values({
        id: historyId,
        conversationId,
        taskId: priorTaskId,
        role: 'user',
        origin: 'owner',
        text: historyText,
        parts: [],
        createdAt: new Date('2024-10-20T12:00:00Z'),
      });
      await db.insert(tasks).values({
        id: taskId,
        agentId,
        conversationId,
        type: 'chat_turn',
        status: 'pending',
        trust: 'owner',
        createdAt: new Date('2026-10-15T18:00:00Z'),
        maxSteps: 5,
        budgetUsdLimit: '0.0500',
        trigger: {
          source: 'chat',
          agentId,
          conversationId,
          trust: 'owner',
          payload: { text: original, triggerMessageId: originalId },
        },
        state: {},
      });
      await db.insert(messages).values([
        {
          id: originalId,
          conversationId,
          taskId,
          role: 'user',
          origin: 'owner',
          text: original,
          parts: [{ type: 'text', text: original }],
          createdAt: new Date('2026-10-15T18:00:00Z'),
        },
        {
          id: correctionId,
          conversationId,
          taskId,
          role: 'user',
          origin: 'owner',
          text: correction,
          parts: [{ type: 'text', text: correction }],
          createdAt: at,
        },
      ]);
      const source = {
        messageId: historyId,
        conversationId,
        text: historyText,
        role: 'user',
        origin: 'owner',
        createdAt: '2024-10-20T12:00:00.000Z',
        sourceRevision: conversationMessageSourceRevision(historyId, historyText),
        speakerRevision: conversationMessageSpeakerRevision(
          historyId,
          historyText,
          'user',
          'owner',
        ),
      };
      await db.insert(toolCalls).values({
        id: priorReceiptId,
        taskId,
        step: 0,
        toolName: 'conversations.search',
        args: { query: 'cedar', limit: 20 },
        risk: 'autonomous',
        status: 'succeeded',
        result: { mode: 'semantic', matches: [source] },
        decision: { model: 'earlier-completed-sibling' },
      });
      const initial = buildRequestChecklist(original);
      if (!initial || initial.items.length < 2)
        throw new Error('Compound checklist fixture missing');
      const selectedId = initial.items[0]?.id;
      if (!selectedId) throw new Error('Selected item missing');
      const base = {
        ...initial,
        items: initial.items.map((item, index) =>
          index === 0
            ? item
            : {
                ...item,
                status: 'completed' as const,
                evidence: [{ id: priorReceiptId, toolName: 'conversations.search' }],
              },
        ),
      };
      const ownerMessage = {
        id: correctionId,
        taskId,
        agentId,
        conversationId,
        role: 'user' as const,
        origin: 'owner' as const,
        text: correction,
        createdAt: at,
      };
      const corrected = revisePendingRequestChecklistItem(base, {
        task: { id: taskId, agentId, conversationId },
        ownerMessage,
        binding: {
          taskId,
          itemId: selectedId,
          expectedRevision: 0,
          ownerTaskId: taskId,
          ownerMessageId: correctionId,
        },
        evidence: { complete: true, rows: [] },
        replacement: { kind: 'lookup', label: correction },
      });
      const originalIntent = latestOwnerIntent([{ role: 'user', content: original }], {
        trust: 'owner',
        trigger: { source: 'chat', payload: { text: original } },
      });
      const repository = createPostgresTaskRepository(db);
      const lease = await repository.claim(taskId);
      if (!lease) throw new Error('Task lease missing');
      const projection = projectChecklistCorrectionResume({
        task: { id: taskId, agentId, conversationId },
        checklist: corrected,
        ownerMessage,
        latestConversationOwnerMessageId: correctionId,
        originalIntent,
      });
      if (!projection) throw new Error('Valid correction projection missing');
      const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
      const dispatcher = {
        toolDefs: () =>
          ['conversations.search', 'gmail.search', 'gmail.read_thread'].map((name) => ({
            name,
            description: 'Synthetic read only',
            inputSchema: {},
          })),
        resultIsUntrusted: () => true,
        executeApproved: vi.fn(),
        dispatch: vi.fn(
          async ({
            toolName,
            args,
            provenance,
            modelToolCallId,
          }: {
            toolName: string;
            args: Record<string, unknown>;
            provenance: Record<string, unknown>;
            modelToolCallId: string;
          }) => {
            calls.push({ toolName, args });
            const result =
              toolName === 'conversations.search'
                ? { mode: 'semantic', matches: [source] }
                : toolName === 'gmail.search'
                  ? searchResult(String(args.query), Number(args.maxResults))
                  : threadResult('Cedar review date is 2026-10-20.');
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
                decision: { ...provenance, modelToolCallId },
              })
              .returning({ id: toolCalls.id });
            if (!stored) throw new Error('Durable read missing');
            return { kind: 'executed' as const, toolCallId: stored.id, result, cached: false };
          },
        ),
      };
      const router = {
        step: vi.fn(async () => {
          throw new Error('Restricted synthesis must not enter the general model/tool loop');
        }),
        embed: vi.fn(async () => {
          throw new Error('No ambient retrieval');
        }),
        object: vi.fn(
          async (_role: string, _input: { prompt: string; requestProfile: unknown }) => {
            if (mode === 'unavailable') return { ok: false };
            return {
              ok: true,
              object: {
                selections: [
                  {
                    sourceKey: `message:${historyId}`,
                    quote: historyText,
                    country: null,
                    classification: 'record',
                  },
                  {
                    sourceKey: 'mail:thread-1:mail-1',
                    quote: 'Cedar review date is 2026-10-20.',
                    country: null,
                    classification: 'record',
                  },
                ],
                claims: [
                  { text: historyText, evidence: [0] },
                  { text: 'Cedar review date is 2026-10-20.', evidence: [1] },
                ],
                addressed: ['summary'],
                remaining: mode === 'unfinished' ? ['my emails'] : [],
              },
            };
          },
        ),
      };
      const deps = {
        db,
        router,
        dispatcher,
        persistence: createPostgresExecutionPersistence(db),
        notifyOwner: vi.fn(async () => ({ legs: [] })),
      } as unknown as ExecutorDeps;
      const state = taskState(lease);
      state.untrustedContext = true;
      state.requestChecklist = corrected;
      const window = [
        { role: 'user' as const, content: original },
        { role: 'user' as const, content: correction },
      ];
      const rc = {
        deps,
        db,
        router,
        dispatcher,
        task: lease,
        state,
        window,
        agent: { id: agentId, timezone: 'America/Los_Angeles' },
        checklistCorrection: projection,
        ctx: {
          taskId,
          agentId,
          trust: 'owner',
          tainted: false,
          db,
          now: () => at,
          signal: new AbortController().signal,
          log: vi.fn(async () => {}),
        },
      } as unknown as RunContext;
      const result = await runStepLoop(rc, {
        action: 'reply',
        reasoning: 'Resume exact selected correction only',
        steps: [],
        missingInfo: [],
      });
      const success = mode === 'validated';
      const call = router.object.mock.calls[0]?.[1];
      expect(call?.requestProfile).toEqual({
        tools: 'none',
        output: 'json_schema',
        streaming: false,
      });
      const payload = JSON.parse(call?.prompt ?? '{}');
      expect(payload.request).toBe(correction.replace(/[.!?]+$/, ''));
      expect(payload.sources.map((row: { key: string }) => row.key).sort()).toEqual(
        [`message:${historyId}`, 'mail:thread-1:mail-1'].sort(),
      );
      expect(result).toMatchObject({ outcome: success ? 'done' : 'needs_attention' });
      expect(calls.map((row) => row.toolName)).toEqual([
        'conversations.search',
        'gmail.search',
        'gmail.read_thread',
      ]);
      expect(state.requestChecklist?.items.find((item) => item.id === selectedId)?.status).toBe(
        success ? 'completed' : 'blocked',
      );
      expect(calls.map((row) => row.toolName)).toEqual([
        'conversations.search',
        'gmail.search',
        'gmail.read_thread',
      ]);
      expect(router.object).toHaveBeenCalledTimes(1);
      expect(router.step).not.toHaveBeenCalled();
      expect(dispatcher.executeApproved).not.toHaveBeenCalled();
      expect(state.step).toBe(4);
      expect(state.step).toBeLessThanOrEqual(lease.maxSteps);
      const persisted = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
      expect(persisted?.status).toBe(success ? 'done' : 'needs_attention');
      expect(persisted?.budgetUsdLimit).toBe('0.0500');
      const assistant = (
        await db.query.messages.findMany({ where: eq(messages.taskId, taskId) })
      ).find((row) => row.role === 'assistant');
      if (success) {
        expect(assistant?.text).toContain('Cedar review requires budget notes.');
        expect(assistant?.text).toContain(`/chat/${conversationId}`);
      } else expect(assistant?.text).not.toMatch(/requested.*(?:fully )?completed/i);
      expect((state.plannerState.restrictedSourceRead as { completed?: boolean }).completed).toBe(
        true,
      );
    },
  );
});
