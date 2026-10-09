import type { TaskLease } from '@assistant/persistence';
import type { ModelMessage } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigForTest } from '../../config.js';
import { TaskStateSchema } from '../../events.js';
import type { RunContext } from './phases.js';
import {
  canAttemptPlanningContactLookup,
  contactClarificationFallback,
  expiredToolCallReceiptDisposition,
  ownerDeclinedContactLookup,
  parseExplicitEmailRecipientName,
  preparePlanningRecall,
  resumePendingApprovals,
  runDirectDocumentRead,
  runPlanPhase,
} from './phases.js';

afterEach(() => {
  resetConfigForTest();
});

describe('explicit email recipient extraction', () => {
  it.each([
    ['SEND AN EMAIL TO anna about the launch notes.', 'anna'],
    ['Email Anna about the launch notes.', 'Anna'],
    ['Email Anna. Please include the agenda.', 'Anna'],
    ['Write an e-mail to maría before tomorrow.', 'maría'],
    ['Email the team about the launch notes.', undefined],
    ['Send an email to Anna Smith about the launch notes.', 'Anna'],
    ['Send a note about Anna to the team.', undefined],
  ])('extracts only a directly named recipient from %s', (text, expected) => {
    expect(parseExplicitEmailRecipientName(text)).toBe(expected);
  });
});

describe('contact lookup opt-out', () => {
  it.each([
    ["Email Anna, but don't search my contacts.", true],
    ['Send an email to Anna without looking up contacts.', true],
    ['Email Anna without using contacts.', true],
    ['Email Anna without accessing contacts.', true],
    ['Email Anna without consulting contacts.', true],
    ['Email Anna about the launch notes.', false],
  ])('recognizes the owner contact-search boundary in %s', (text, declined) => {
    expect(ownerDeclinedContactLookup(text)).toBe(declined);
  });
});

describe('clarification after a verified contact', () => {
  it('stops for owner review instead of inventing missing email content', () => {
    const fallback = contactClarificationFallback({
      action: 'clarify',
      reasoning: 'The recipient is not resolved.',
      steps: [],
      missingInfo: ['recipient email address for Anna'],
    });

    expect(fallback).toEqual({ kind: 'unavailable' });
  });

  it('does not accept an unrelated plan action as a contact-retry fallback', () => {
    const fallback = contactClarificationFallback({
      action: 'workflow',
      reasoning: 'The retry could not safely choose this action.',
      steps: ['Send an email without a verified plan.'],
      missingInfo: [],
    });

    expect(fallback).toEqual({ kind: 'unavailable' });
  });

  it('keeps a real subject question while removing only recipient questions', () => {
    const fallback = contactClarificationFallback({
      action: 'clarify',
      reasoning: 'One message detail remains unclear.',
      steps: [],
      missingInfo: ['recipient email address for Anna', 'Which subject should the email use?'],
    });

    expect(fallback).toEqual({
      kind: 'clarify',
      plan: {
        action: 'clarify',
        reasoning: 'One message detail remains unclear.',
        steps: [],
        missingInfo: ['Which subject should the email use?'],
      },
    });
  });
});

describe('planning contact preflight resume bounds', () => {
  it('does not spend a second lookup or planner retry after a persisted resume checkpoint', () => {
    const resumedState = TaskStateSchema.parse({
      step: 1,
      plannerState: {
        contactBeforeClarification: { version: 1, plannerRetryAttempted: true },
      },
    });
    const task = { maxSteps: 8 } as TaskLease;

    expect(canAttemptPlanningContactLookup(resumedState, task)).toBe(false);
  });

  it('reserves one execution step after the audited lookup', () => {
    const state = TaskStateSchema.parse({ step: 3, plannerState: {} });
    expect(canAttemptPlanningContactLookup(state, { maxSteps: 5 } as TaskLease)).toBe(true);
    expect(canAttemptPlanningContactLookup(state, { maxSteps: 4 } as TaskLease)).toBe(false);
  });
});

describe('expired tool-call receipt disposition', () => {
  it.each([
    ['completed', 'done', 'done', /recorded as completed/],
    ['failed', 'failed', 'failed', /recorded as failed/],
    ['not_executed', 'failed', 'failed', /recorded as not executed/],
    ['unknown', 'needs_attention', 'needs_attention', /outcome .* unknown/],
  ] as const)(
    '%s remains truthful and non-retryable',
    (effectOutcome, terminalStatus, outcome, text) => {
      const disposition = expiredToolCallReceiptDisposition(effectOutcome);
      expect(disposition).toMatchObject({ terminalStatus, outcome });
      expect(disposition.text).toMatch(text);
      expect(disposition.text).toMatch(/will not repeat the action/);
      expect(disposition.text).toMatch(/cannot verify this request matches it/);
    },
  );
});

describe('pre-planning context retrieval', () => {
  it('injects relevant history before planning and records the retrieved source', async () => {
    loadConfig({ CHAT_RECALL_ENABLED: 'true', GRAPH_RAG_ENABLED: 'false' });
    const recentWindowStart = vi.fn(async () => new Date('2026-10-01T00:00:00Z'));
    let segmentRows = [
      {
        conversationId: 'conversation-1',
        summary: 'The planning group uses planning@example.com.',
        startMessageId: 'old-message',
        startedAt: new Date('2026-09-01T00:00:00Z'),
        endedAt: new Date('2026-09-01T00:00:00Z'),
        similarity: 0.94,
        keyMessage: { id: 'old-message', role: 'user', text: 'Use planning@example.com.' },
      },
    ];
    let hideAllSurfacedSources = false;
    const segments = vi.fn(async () => segmentRows);
    const messages = vi.fn(async () => []);
    const checkpoint = vi.fn(async () => true);
    const record = vi.fn(async () => undefined);
    const situationDecision = {
      decisionId: 'async-updates',
      option: 'Daily meetings',
      outcome: 'rejected' as const,
      reason: 'They break focus time during the launch.',
      scope: 'situation' as const,
      packId: 'pack-launch',
      packTitle: 'Launch plan',
      packVersion: 5,
      packUpdatedAt: '2026-10-01T00:00:00.000Z',
      relevance: 7,
    };
    let currentDecision: Omit<typeof situationDecision, 'outcome'> & {
      outcome: 'accepted' | 'rejected';
    } = situationDecision;
    const retrieveSituationDecisions = vi.fn(async () => [currentDecision]);
    const window: ModelMessage[] = [
      { role: 'user', content: 'We are preparing the Paris rail itinerary.' },
      { role: 'assistant', content: 'The planning group can review those train options.' },
      { role: 'user', content: 'Please email the agenda to the planning group.' },
    ];
    const context = {
      deps: {
        persistence: {
          history: {
            kind: 'history-recall-repository',
            recentWindowStart,
            segments,
            messages,
            neighborhood: vi.fn(async () => []),
          },
          ownerContext: {
            kind: 'owner-context-repository',
            listOpenCommitments: vi.fn(async () => []),
          },
          recallMetrics: { kind: 'recall-metrics-repository', record },
          recallSurfacing: {
            kind: 'recall-surfacing-repository',
            suppressed: vi.fn(async (_agentId: string, sourceKeys: string[]) =>
              hideAllSurfacedSources ? new Set(sourceKeys) : new Set<string>(),
            ),
          },
          situationDecisionContext: {
            kind: 'situation-decision-context-repository',
            retrieve: retrieveSituationDecisions,
          },
          tasks: { kind: 'task-lease-repository', checkpoint },
        },
      },
      db: {},
      router: {
        embeddingSpace: async () => ({
          provider: 'synthetic',
          model: 'planner-context-fixture',
          dimensions: 2,
          revision: '1',
        }),
        embed: vi.fn(async () => [[1, 0]]),
      },
      task: {
        id: 'task-1',
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        trust: 'owner',
        type: 'chat_turn',
        trigger: {
          source: 'chat',
          payload: { text: 'Please email the agenda to the planning group.' },
        },
      },
      agent: { id: 'agent-1' },
      state: { plannerState: {}, untrustedContext: false, contextWindow: [] },
      ctx: {},
      window,
    } as unknown as RunContext;

    await expect(preparePlanningRecall(context)).resolves.toBe(true);

    expect(recentWindowStart).toHaveBeenCalled();
    expect(segments).toHaveBeenCalled();
    expect(context.router.embed).toHaveBeenCalledWith(
      [expect.stringContaining('Paris rail itinerary')],
      expect.objectContaining({ taskId: 'task-1' }),
    );
    expect(window.at(-1)).toMatchObject({ role: 'system' });
    expect(window.at(-1)?.content).toContain('planning@example.com');
    expect(window.at(-1)?.content).toContain('pack-launch');
    expect(window.at(-1)?.content).toContain('version 5');
    expect(window.at(-1)?.content).toContain('break focus time');
    expect(retrieveSituationDecisions).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        discussionFrame: expect.stringContaining('Paris rail itinerary'),
      }),
    );
    expect(context.state.recall).toContainEqual(
      expect.objectContaining({ label: 'The planning group uses planning@example.com.' }),
    );
    expect(context.state.plannerState.planningRecall).toMatchObject({ status: 'complete' });
    expect(context.state.plannerState.planningRecall).toMatchObject({
      discussionFrame: { currentTurnComplete: true, omittedTurns: 0 },
    });
    expect(checkpoint).toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'executor', sourceCount: 2 }),
    );

    // Simulate a lease resume with the persisted recall checkpoint and system
    // message still present, while both the source content and active owner
    // decision have changed during the pause.
    segmentRows = [
      {
        conversationId: 'conversation-1',
        summary: 'The planning group now uses travel@example.com.',
        startMessageId: 'old-message',
        startedAt: new Date('2026-09-01T00:00:00Z'),
        endedAt: new Date('2026-09-01T00:00:00Z'),
        similarity: 0.94,
        keyMessage: { id: 'old-message', role: 'user', text: 'Use travel@example.com.' },
      },
    ];
    currentDecision = {
      ...situationDecision,
      option: 'Weekly notes',
      outcome: 'accepted',
      reason: 'The owner changed the cadence after the launch.',
      packVersion: 6,
    };
    await expect(preparePlanningRecall(context)).resolves.toBe(true);

    const refreshedBlocks = window.filter(
      (message) =>
        message.role === 'system' &&
        typeof message.content === 'string' &&
        message.content.startsWith('[[assistant:owner-context-recall:v1]]'),
    );
    expect(refreshedBlocks).toHaveLength(1);
    expect(refreshedBlocks[0]?.content).toContain('travel@example.com');
    expect(refreshedBlocks[0]?.content).toContain('Weekly notes');
    expect(refreshedBlocks[0]?.content).not.toContain('planning@example.com');
    expect(refreshedBlocks[0]?.content).not.toContain('Daily meetings');

    // A suppression made while the task was paused is re-read as well; the
    // old block and provenance are removed rather than trusted from checkpoint.
    // This legacy no-match prefix could still have appended private situation
    // decisions in the old combined-block representation.
    window.push({
      role: 'system',
      content:
        'Prior conversation and memory retrieval completed with no relevant matches. This does not establish anything else.\n\nSTALE_LEGACY_DECISION_TEXT',
    });
    hideAllSurfacedSources = true;
    await expect(preparePlanningRecall(context)).resolves.toBe(true);
    const latestBlock = window.findLast(
      (message) =>
        message.role === 'system' &&
        typeof message.content === 'string' &&
        message.content.startsWith('[[assistant:owner-context-recall:v1]]'),
    );
    expect(latestBlock?.content).toContain('no relevant matches');
    expect(latestBlock?.content).not.toContain('travel@example.com');
    expect(latestBlock?.content).not.toContain('Weekly notes');
    expect(JSON.stringify(window)).not.toContain('STALE_LEGACY_DECISION_TEXT');
    expect(context.state.recall).toBeUndefined();
    expect(
      window.filter(
        (message) =>
          message.role === 'system' &&
          typeof message.content === 'string' &&
          message.content.startsWith('[[assistant:owner-context-recall:v1]]'),
      ),
    ).toHaveLength(1);

    // Exercise the actual resume entry: a previously saved plan and planning
    // checkpoint must not short-circuit source/suppression revalidation.
    context.task.plan = {
      action: 'workflow',
      reasoning: 'Continue the saved request.',
      steps: ['Use current evidence only.'],
      missingInfo: [],
    };
    await expect(runPlanPhase(context)).resolves.toMatchObject({
      plan: { action: 'workflow', steps: ['Use current evidence only.'] },
    });
    expect(
      window.filter(
        (message) =>
          message.role === 'system' &&
          typeof message.content === 'string' &&
          message.content.startsWith('[[assistant:owner-context-recall:v1]]'),
      ),
    ).toHaveLength(1);
    expect(window.at(-1)?.content).toContain('no relevant matches');
    expect(window.at(-1)?.content).not.toContain('travel@example.com');
    expect(context.state.recall).toBeUndefined();
  });

  it('honors an explicit no-recall request without calling the history provider', async () => {
    loadConfig({ CHAT_RECALL_ENABLED: 'true', GRAPH_RAG_ENABLED: 'false' });
    const recentWindowStart = vi.fn(async () => null);
    const retrieveSituationDecisions = vi.fn();
    const window: ModelMessage[] = [
      { role: 'user', content: "Don't search my old messages; just answer from this note." },
    ];
    const context = {
      deps: {
        persistence: {
          history: { kind: 'history-recall-repository', recentWindowStart },
          situationDecisionContext: { retrieve: retrieveSituationDecisions },
        },
      },
      db: {},
      router: { embed: vi.fn() },
      task: {
        id: 'task-2',
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        trust: 'owner',
        type: 'chat_turn',
        trigger: { source: 'chat', payload: { text: window[0]?.content } },
      },
      agent: { id: 'agent-1' },
      state: { plannerState: {}, untrustedContext: false, contextWindow: [] },
      ctx: {},
      window,
    } as unknown as RunContext;

    await expect(preparePlanningRecall(context)).resolves.toBe(true);

    expect(recentWindowStart).not.toHaveBeenCalled();
    expect(retrieveSituationDecisions).not.toHaveBeenCalled();
    expect(context.state.plannerState.planningRecall).toMatchObject({ status: 'skipped_by_owner' });
    expect(window.some((message) => message.role === 'system')).toBe(false);
  });
});

describe('runPlanPhase mission-session admission', () => {
  it('revalidates a persisted nested-mission plan as one bounded existing-mission workflow', async () => {
    const missionId = 'mission-existing';
    const task = {
      id: 'session-child',
      type: 'adhoc',
      parentTaskId: missionId,
      trust: 'owner',
      trigger: {
        source: 'mission_wake',
        payload: { missionId, instruction: 'Continue the existing search.' },
      },
      plan: {
        action: 'mission',
        reasoning: 'Start a recursive mission',
        steps: Array.from({ length: 10 }, (_, index) => `Step ${index} ${'x'.repeat(500)}`),
        missingInfo: [],
      },
    } as unknown as TaskLease;
    const context = {
      deps: {},
      db: {},
      router: {},
      dispatcher: {},
      task,
      agent: {},
      state: {},
      ctx: {},
      window: [],
    } as unknown as RunContext;

    const result = await runPlanPhase(context);

    expect(result).toEqual({
      plan: {
        action: 'workflow',
        reasoning: 'Continue the existing mission in one bounded work session.',
        steps: Array.from({ length: 6 }, (_, index) => `Step ${index} ${'x'.repeat(393)}`),
        missingInfo: [],
      },
    });
  });
});

describe('runDirectDocumentRead transcript pairing', () => {
  it('checkpoints the stable assistant call before dispatch and pairs its result', async () => {
    let checkpointed: unknown;
    const modelToolCallId = 'direct-document-read-task-1';
    const window: ModelMessage[] = [
      { role: 'user', content: 'Read https://docs.google.com/document/d/document123456' },
    ];
    const context = {
      deps: {
        persistence: {
          tasks: {
            kind: 'task-lease-repository',
            renew: async () => true,
            checkpoint: async (_task: unknown, state: unknown) => {
              checkpointed = structuredClone(state);
              return true;
            },
          },
        },
      },
      db: {},
      task: { id: 'task-1', agentId: 'agent-1' },
      state: { contextWindow: [], completedToolCallIds: [], step: 0 },
      window,
      dispatcher: {
        dispatch: async () => ({
          kind: 'executed',
          toolCallId: 'db-call-1',
          result: { title: 'Source document' },
          cached: false,
        }),
        resultIsUntrusted: () => false,
      },
      ctx: { tainted: false },
      documentReadIntent: { toolName: 'docs.get', documentId: 'document123456' },
    } as unknown as RunContext;

    const result = await runDirectDocumentRead(context);

    expect(result).toBeNull();
    expect(checkpointed).toMatchObject({
      contextWindow: expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: [
            expect.objectContaining({
              type: 'tool-call',
              toolCallId: modelToolCallId,
              toolName: 'docs.get',
            }),
          ],
        }),
      ]),
    });
    const assistant = window.find((message) => message.role === 'assistant');
    const tool = window.find((message) => message.role === 'tool');
    expect(assistant?.content).toMatchObject([
      { type: 'tool-call', toolCallId: modelToolCallId, toolName: 'docs.get' },
    ]);
    expect(tool?.content).toMatchObject([
      {
        type: 'tool-result',
        toolCallId: modelToolCallId,
        output: { value: { title: 'Source document' } },
      },
    ]);
  });
});

describe('approval batch continuation', () => {
  it('settles the matching journal entry and replaces its provisional result', async () => {
    const pendingApproval = {
      approvalId: 'approval-1',
      toolCallId: 'model-call-1',
      dbToolCallId: 'db-call-1',
      toolName: 'fixture.send',
    };
    const state = {
      pendingApprovals: [pendingApproval],
      pendingJob: null,
      pendingToolBatch: {
        step: 1,
        modelId: 'test/model',
        calls: [
          {
            toolCallId: pendingApproval.toolCallId,
            toolName: pendingApproval.toolName,
            input: { text: 'hello' },
            status: 'awaiting_approval',
            approvalId: pendingApproval.approvalId,
            dbToolCallId: pendingApproval.dbToolCallId,
          },
        ],
      },
      completedToolCallIds: [],
      contextWindow: [],
    };
    const window: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: pendingApproval.toolCallId,
            toolName: pendingApproval.toolName,
            input: { text: 'hello' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: pendingApproval.toolCallId,
            toolName: pendingApproval.toolName,
            output: { type: 'json', value: { awaiting_owner_approval: true } },
          },
        ],
      },
    ];
    const context = {
      deps: {
        persistence: {
          tasks: { kind: 'task-lease-repository', renew: async () => true },
          executionJobs: {
            listPendingApprovals: async () => [
              {
                id: pendingApproval.approvalId,
                taskId: 'task-1',
                toolCallId: pendingApproval.dbToolCallId,
                status: 'approved',
              },
            ],
          },
        },
      },
      db: {},
      task: { id: 'task-1', agentId: 'agent-1', conversationId: null },
      state,
      window,
      dispatcher: {
        executeApproved: async () => ({ kind: 'executed', result: { sent: true } }),
        resultIsUntrusted: () => false,
      },
      ctx: { tainted: false },
    } as unknown as RunContext;

    const result = await resumePendingApprovals(context);

    expect(result).toBeNull();
    expect(state.pendingApprovals).toEqual([]);
    expect(state.pendingToolBatch.calls[0]).toMatchObject({ status: 'settled' });
    expect(state.completedToolCallIds).toEqual(['db-call-1']);
    const toolResult = window.flatMap((message) =>
      message.role === 'tool' && Array.isArray(message.content) ? message.content : [],
    );
    expect(toolResult).toHaveLength(1);
    expect(toolResult[0]).toMatchObject({
      toolCallId: 'model-call-1',
      output: { value: { sent: true } },
    });
  });
});
