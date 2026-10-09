import { createHash } from 'node:crypto';
import { loadConfig, resetConfigForTest } from '@assistant/config';
import { TRIAGED_ACTIONABLE } from '@assistant/core/events';
import type { ModelRouter } from '@assistant/core/model-router';
import type { ActionEvidence } from '@assistant/core/workflow/response-contract';
import type { ApplicationChatPersistence } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The two busiest model calls in the product — the needs-action triage and the
// tool-less conversational reply — run inside handleChatTurn, before any task
// or plan exists, so the executor harnesses never reach them. These tests drive
// the real handler with a scripted router and an in-memory chat store; only
// the context reads and the queue are stubbed.

const stubs = vi.hoisted(() => ({
  enqueueTask: vi.fn(),
  admission: vi.fn(),
  queueAdmission: vi.fn(),
  getAmbientBlock: vi.fn(async () => undefined),
  getOwnerCard: vi.fn(async () => undefined),
}));

vi.mock('@assistant/core/workflow/machine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant/core/workflow/machine')>()),
  enqueueTask: stubs.enqueueTask,
}));
vi.mock('@assistant/core/memory/commitments', () => ({
  listOpenCommitments: async () => [],
  renderOpenCommitments: () => '',
}));
vi.mock('@assistant/core/memory/ambient', () => ({ getAmbientBlock: stubs.getAmbientBlock }));
vi.mock('@assistant/core/memory/consolidation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant/core/memory/consolidation')>()),
  getOwnerCard: stubs.getOwnerCard,
}));

const { handleChatTurn, resumeAdmittedChatTask } = await import('./chat-turn.js');

const AGENT = '00000000-0000-4000-8000-00000000000a';
const CONVERSATION = '00000000-0000-4000-8000-00000000000c';

type Completion = {
  status: 'done' | 'failed';
  progress?: string;
  messages: Array<{ text: string; parts: unknown[]; channelMessageId?: string }>;
};

type StoreScript = {
  history?: Array<Record<string, unknown>>;
  laterMessages?: Array<Record<string, unknown>>;
  evidence?: ActionEvidence[];
  unavailableConversation?: boolean;
  cancellationWon?: boolean;
  archivedConversation?: boolean;
  emptyConversationTitle?: boolean;
};

function chatStore(script: StoreScript = {}) {
  const messages: Array<Record<string, unknown>> = (script.history ?? []).map((message, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
    taskId: null,
    parts: [{ type: 'text', text: message.text ?? '' }],
    createdAt: new Date(Date.UTC(2026, 8, 23, 11, 0, index)),
    ...message,
  }));
  const completions: Completion[] = [];
  let taskCount = 0;
  const admittedByOperation = new Map<
    string,
    {
      task: Record<string, unknown>;
      message: Record<string, unknown>;
      lease: Record<string, unknown>;
    }
  >();
  const chat = {
    kind: 'application-chat-persistence',
    resolveAgent: async () => ({
      id: AGENT,
      name: 'Assistant',
      email: 'assistant@example.com',
      timezone: 'UTC',
    }),
    getConversation: async () =>
      script.unavailableConversation
        ? null
        : {
            id: CONVERSATION,
            agentId: AGENT,
            title: script.emptyConversationTitle ? '' : 'Existing chat',
            archivedAt: script.archivedConversation ? new Date('2026-09-01T00:00:00Z') : null,
            metadata: {},
            modelOverride: null,
          },
    admitChatTurn: async (input: Record<string, unknown>) => {
      stubs.admission(input);
      if (script.cancellationWon)
        return {
          kind: 'cancelled_before_admission',
          created: false,
          task: { id: '00000000-0000-4000-8000-000000000099', status: 'cancelled' },
          status: 'cancelled',
          effectStatus: 'not_started',
        };
      const operationId = String(input.clientOperationId);
      const existing = admittedByOperation.get(operationId);
      if (existing)
        return { kind: 'admitted', created: false, task: existing.task, message: existing.message };
      const row = {
        id: `00000000-0000-4000-8000-${String(messages.length + 1).padStart(12, '0')}`,
        taskId: `task-${++taskCount}`,
        createdAt: new Date(Date.UTC(2026, 8, 23, 12, 0, messages.length)),
        conversationId: CONVERSATION,
        role: 'user',
        origin: 'owner',
        parts: [{ type: 'text', text: input.text }],
        text: input.text,
      };
      messages.push(row);
      const taskId = row.taskId;
      const task = {
        id: taskId,
        conversationId: CONVERSATION,
        agentId: AGENT,
        status: 'running',
        trigger: {
          source: 'chat',
          payload: { text: input.text, chatAdmission: { phase: 'classifying' } },
        },
      };
      const lease = {
        ...task,
        leaseToken: `lease-${taskId}`,
        lockedUntil: new Date(Date.now() + 60_000),
      };
      const admitted = { task, message: row, lease };
      admittedByOperation.set(operationId, admitted);
      return { kind: 'admitted', created: true, ...admitted };
    },
    privacyObservationGeneration: async () => null,
    listMessages: async () => ({
      messages: [...messages, ...(script.laterMessages ?? [])],
      hasMore: false,
    }),
    listMessagesByIds: async (_agentId: string, _conversationId: string, ids: string[]) =>
      messages.filter((message) => ids.includes(String(message.id))),
    getTaskKinds: async () => new Map(),
    queueAdmittedChatTurn: async (input: { task: { id: string }; triagedActionable: boolean }) => {
      stubs.queueAdmission(input);
      return { id: input.task.id, queueGeneration: 1 };
    },
    markChatTurnStreaming: async () => true,
    completeDirectChatTask: async (input: Completion) => {
      completions.push(input);
      return true;
    },
    listConversationEvidence: async () => script.evidence ?? [],
    createConversation: vi.fn(),
    restoreConversation: vi.fn(async () => true),
    setConversationTitleIfEmpty: vi.fn(async () => true),
    raiseTaskBudget: vi.fn(async () => {}),
  };
  return {
    chat: chat as unknown as ApplicationChatPersistence,
    completions,
    messages,
    raiseTaskBudget: chat.raiseTaskBudget,
    createConversation: chat.createConversation,
    restoreConversation: chat.restoreConversation,
    setConversationTitleIfEmpty: chat.setConversationTitleIfEmpty,
  };
}

type RouterScript = {
  triage?: { needsAction: boolean } | Error;
  draft?: string;
  budgetBlocked?: boolean;
  triageUnavailable?: boolean;
  streamError?: Error;
};

function scriptedRouter(script: RouterScript) {
  const route = vi.fn(async () => ({ ok: true as const, modelId: 'test/model' }));
  const object = vi.fn(async () => {
    if (script.triage instanceof Error) throw script.triage;
    if (script.triageUnavailable) return { ok: false, decision: { mode: 'park', reason: 'cap' } };
    return { ok: true, object: script.triage ?? { needsAction: false } };
  });
  const stream = vi.fn(
    async (
      _role: string,
      options: {
        onComplete: (text: string) => Promise<void>;
        onError: (error: unknown) => Promise<void>;
      },
    ) => {
      if (script.streamError) throw script.streamError;
      if (script.budgetBlocked)
        return { ok: false, decision: { mode: 'block', reason: 'daily cap reached' } };
      const draft = script.draft ?? '';
      await options.onComplete(draft);
      const chunks = [
        { type: 'start' },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: draft },
        { type: 'text-end', id: 't' },
      ];
      return {
        ok: true,
        modelId: 'test/model',
        degraded: false,
        text: Promise.resolve(draft),
        toUIMessageStream: () =>
          (async function* () {
            yield* chunks;
          })(),
      };
    },
  );
  return { router: { route, object, stream } as unknown as ModelRouter, route, object, stream };
}

function send(text: string, extra: Record<string, unknown> = {}) {
  return new Request('https://assistant.example/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      conversationId: CONVERSATION,
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }],
      ...extra,
    }),
  });
}

function config() {
  return loadConfig({
    OPENROUTER_API_KEY: 'test-key',
    QUEUE_DRIVER: 'local',
    CHAT_RECALL_ENABLED: 'false',
    GRAPH_RAG_ENABLED: 'false',
  });
}

beforeEach(() => {
  stubs.enqueueTask.mockReset();
  stubs.admission.mockReset();
  stubs.queueAdmission.mockReset();
  stubs.getAmbientBlock.mockReset().mockResolvedValue(undefined);
  stubs.getOwnerCard.mockReset().mockResolvedValue(undefined);
  stubs.enqueueTask.mockResolvedValue({ task: { id: 'queued-task' } });
});
afterEach(() => resetConfigForTest());

async function turn(
  text: string,
  script: RouterScript,
  extra: Record<string, unknown> = {},
  stored: StoreScript = {},
) {
  const store = chatStore(stored);
  const scripted = scriptedRouter(script);
  const response = await handleChatTurn(send(text, extra), {
    config: config(),
    router: scripted.router,
    chat: store.chat,
    persistence: { tasks: {}, ownerContext: {} } as never,
  });
  return { response, ...store, ...scripted };
}

function queuedPayload() {
  const [[input]] = stubs.queueAdmission.mock.calls as unknown as [
    [{ triagedActionable: boolean }],
  ];
  return input.triagedActionable ? { [TRIAGED_ACTIONABLE]: true } : {};
}

describe('chat needs-action triage', () => {
  it('recovers a stale direct reply using the persisted conversational triage outcome', async () => {
    const operationId = '00000000-0000-4000-8000-0000000000d3';
    const messageId = '00000000-0000-4000-8000-0000000000d4';
    const taskId = '00000000-0000-4000-8000-0000000000d5';
    const text = 'Say hello.';
    const requestHash = createHash('sha256')
      .update(JSON.stringify([text, false, false, false]))
      .digest('hex');
    const store = chatStore({
      history: [{ id: messageId, taskId, role: 'user', text }],
    });
    const router = scriptedRouter({ draft: 'Hello again.' });
    const task = {
      id: taskId,
      agentId: AGENT,
      conversationId: CONVERSATION,
      type: 'chat_turn',
      trust: 'owner',
      status: 'running',
      lockedUntil: new Date(Date.now() + 60_000),
      leaseToken: 'reclaimed-lease',
      trigger: {
        source: 'chat',
        agentId: AGENT,
        conversationId: CONVERSATION,
        trust: 'owner',
        payload: {
          text,
          triggerMessageId: messageId,
          clientOperationId: operationId,
          autonomous: false,
          force: false,
          spoken: false,
          chatAdmission: {
            protocol: 'owner-chat-v1',
            clientOperationId: operationId,
            requestHash,
            triggerMessageId: messageId,
            phase: 'streaming',
            triageOutcome: 'conversational',
          },
        },
      },
    } as never;

    await expect(
      resumeAdmittedChatTask(task, {
        config: config(),
        router: router.router,
        chat: store.chat,
        persistence: { tasks: {}, ownerContext: {} } as never,
      }),
    ).resolves.toBe(200);
    expect(router.object).not.toHaveBeenCalled();
    expect(router.stream).toHaveBeenCalledOnce();
    expect(store.messages.filter((message) => message.role === 'user')).toHaveLength(1);
  });

  it('replays the same client operation receipt without classifying or streaming again', async () => {
    const operationId = '00000000-0000-4000-8000-0000000000d2';
    const store = chatStore();
    const firstRouter = scriptedRouter({ triage: { needsAction: false }, draft: 'Hello.' });
    await handleChatTurn(send('Say hello.', { clientOperationId: operationId }), {
      config: config(),
      router: firstRouter.router,
      chat: store.chat,
      persistence: { tasks: {}, ownerContext: {} } as never,
    });
    const secondRouter = scriptedRouter({
      triage: { needsAction: false },
      draft: 'Different reply.',
    });
    const replay = await handleChatTurn(send('Say hello.', { clientOperationId: operationId }), {
      config: config(),
      router: secondRouter.router,
      chat: store.chat,
      persistence: { tasks: {}, ownerContext: {} } as never,
    });

    expect(replay.headers.get('x-async-task')).toBe('task-1');
    expect(firstRouter.stream).toHaveBeenCalledOnce();
    expect(secondRouter.object).not.toHaveBeenCalled();
    expect(secondRouter.stream).not.toHaveBeenCalled();
    expect(store.messages.filter((message) => message.role === 'user')).toHaveLength(1);
  });

  it.each([
    'Remind me in ten minutes to take the laundry out.',
    'Cancel the sunglasses reminder.',
    'I want you to remember that I prefer an aisle seat.',
    'Show me the email about the hotel.',
    'What is on my calendar tomorrow?',
    'Has the invoice arrived?',
    'Send Anna the draft.',
    'Move my dentist appointment to Friday.',
    'Check the weather in Tokyo tomorrow.',
  ])('never sends an explicit action to the tool-less reply: %s', async (text) => {
    const result = await turn(text, { triage: { needsAction: false }, draft: 'Done.' });
    expect(result.response.headers.get('x-async-task')).toBe('task-1');
    expect(result.stream).not.toHaveBeenCalled();
    expect(queuedPayload()[TRIAGED_ACTIONABLE]).toBe(true);
  });

  it.each(['Yes, go ahead', 'Please do', 'Keep going'])(
    'routes acceptance of an earlier offer, without granting autonomy: %s',
    async (text) => {
      const result = await turn(
        text,
        {},
        {},
        {
          history: [{ role: 'assistant', text: 'Would you like me to send that email?' }],
        },
      );
      expect(result.response.headers.get('x-async-task')).toBe('task-1');
      expect(result.object).not.toHaveBeenCalled();
      expect(
        (stubs.admission.mock.calls[0]?.[0] as { autonomyGrant?: unknown } | undefined)
          ?.autonomyGrant,
      ).toBeUndefined();
    },
  );

  it('does not interpret an earlier background notice as an action offer', async () => {
    const result = await turn(
      'Yes',
      { draft: 'What would you like to do next?' },
      {},
      {
        history: [
          { role: 'assistant', text: 'Do you like green?' },
          {
            role: 'assistant',
            text: 'Would you like me to send that email?',
            parts: [{ type: 'notice', notice: 'proactive-alert' }],
          },
        ],
      },
    );
    expect(result.object).toHaveBeenCalledOnce();
    expect(result.stream).toHaveBeenCalledOnce();
    expect(stubs.enqueueTask).not.toHaveBeenCalled();
  });

  it('defaults to the executor when triage is budget-blocked', async () => {
    const result = await turn('Help with the thing from earlier.', { triageUnavailable: true });
    expect(result.response.headers.get('x-async-task')).toBe('task-1');
    expect(queuedPayload()[TRIAGED_ACTIONABLE]).toBeUndefined();
    expect(result.stream).not.toHaveBeenCalled();
  });

  it('forces a retry into the executor while keeping approval policy', async () => {
    await turn('Please try again.', {}, { force: true });
    expect(
      (stubs.admission.mock.calls[0]?.[0] as { autonomyGrant?: unknown } | undefined)
        ?.autonomyGrant,
    ).toBeUndefined();
    expect(queuedPayload()[TRIAGED_ACTIONABLE]).toBe(true);
  });

  it('uses the explicit composer autonomy grant for an autonomous turn', async () => {
    await turn('Please try again.', {}, { autonomous: true });
    expect(
      (stubs.admission.mock.calls[0]?.[0] as { autonomyGrant?: unknown } | undefined)
        ?.autonomyGrant,
    ).toMatchObject({ grantedVia: 'composer' });
  });

  it('reports an unavailable queue while preserving the owner message', async () => {
    stubs.queueAdmission.mockImplementation(() => {
      throw new Error('queue unavailable');
    });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await turn('Remind me tomorrow to call Anna.', {});
      expect(result.response.status).toBe(503);
      expect(await result.response.json()).toMatchObject({ code: 'queue_unavailable' });
      expect(result.messages.at(-1)?.text).toBe('Remind me tomorrow to call Anna.');
      expect(result.stream).not.toHaveBeenCalled();
      expect(result.completions).toEqual([]);
    } finally {
      quiet.mockRestore();
    }
  });

  it('sends a clear live lookup to the executor without asking the classifier', async () => {
    const { response, object, stream } = await turn(
      "What's the Giants score and the drive time to Oracle Park?",
      {},
    );
    expect(response.headers.get('x-async-task')).toBe('task-1');
    expect(object).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(queuedPayload()[TRIAGED_ACTIONABLE]).toBe(true);
  });

  it('routes to the executor when the classifier rules the turn actionable', async () => {
    const { response, object, stream } = await turn('Could you sort out the thing from earlier', {
      triage: { needsAction: true },
    });
    expect(object).toHaveBeenCalledOnce();
    expect(response.headers.get('x-async-task')).toBe('task-1');
    expect(stream).not.toHaveBeenCalled();
    expect(queuedPayload()[TRIAGED_ACTIONABLE]).toBe(true);
  });

  it('defaults to the executor when the classifier fails, without claiming a ruling', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { response, stream } = await turn('Could you sort out the thing from earlier', {
      triage: new Error('classifier timed out'),
    });
    quiet.mockRestore();
    expect(response.headers.get('x-async-task')).toBe('task-1');
    expect(stream).not.toHaveBeenCalled();
    expect(queuedPayload()[TRIAGED_ACTIONABLE]).toBeUndefined();
  });

  it('asks the classifier about the latest message, labelled as the one to classify', async () => {
    const { object } = await turn('tell me a joke about otters', {
      triage: { needsAction: false },
      draft: 'Why did the otter cross the river? To get to the other slide.',
    });
    const [, request] = object.mock.calls[0] as unknown as [string, { prompt: string }];
    expect(request.prompt).toMatch(/LATEST USER MESSAGE \(classify this\):\ntell me a joke/);
  });

  it('does not include a later concurrently admitted turn in this turn context', async () => {
    const { object } = await turn(
      'tell me a joke',
      {
        triage: { needsAction: false },
        draft: 'A joke.',
      },
      {},
      {
        laterMessages: [
          {
            id: '00000000-0000-4000-8000-999999999999',
            taskId: 'later-task',
            conversationId: CONVERSATION,
            role: 'user',
            origin: 'owner',
            createdAt: new Date(Date.UTC(2026, 8, 23, 12, 1)),
            parts: [{ type: 'text', text: 'later turn secret context' }],
            text: 'later turn secret context',
          },
        ],
      },
    );
    const [, request] = object.mock.calls[0] as unknown as [string, { prompt: string }];
    expect(request.prompt).not.toContain('later turn secret context');
  });
});

describe('tool-less conversational reply', () => {
  it('uses the shared owner-scoped decision projection without tools', async () => {
    const store = chatStore();
    const scripted = scriptedRouter({
      triage: { needsAction: false },
      draft: 'You previously rejected the daily check-in because it interrupted focus.',
    });
    Object.assign(scripted.router, {
      embeddingSpace: async () => ({
        provider: 'synthetic',
        model: 'chat-turn-test',
        dimensions: 2,
        revision: '1',
      }),
      embed: vi.fn(async () => [[1, 0]]),
    });
    const retrieve = vi.fn(async () => [
      {
        decisionId: 'daily-check-in',
        option: 'Daily check-in',
        outcome: 'rejected' as const,
        reason: 'It interrupted focus during launch.',
        scope: 'situation' as const,
        packId: '00000000-0000-4000-8000-0000000000a1',
        packTitle: 'Launch plan',
        packVersion: 3,
        packUpdatedAt: '2026-10-01T00:00:00.000Z',
        relevance: 5,
      },
    ]);
    const response = await handleChatTurn(
      send('Do you think a daily check-in makes sense for launch?'),
      {
        config: loadConfig({
          OPENROUTER_API_KEY: 'test-key',
          QUEUE_DRIVER: 'local',
          CHAT_RECALL_ENABLED: 'true',
          GRAPH_RAG_ENABLED: 'false',
        }),
        router: scripted.router,
        chat: store.chat,
        persistence: {
          tasks: {},
          ownerContext: {},
          history: {
            kind: 'history-recall-repository',
            segments: async () => [],
            messages: async () => [],
            neighborhood: async () => [],
          },
          recallMetrics: { kind: 'recall-metrics-repository', record: vi.fn(async () => {}) },
          situationDecisionContext: {
            kind: 'situation-decision-context-repository',
            retrieve,
          },
        } as never,
      },
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT,
        discussionFrame: expect.stringContaining(
          'Do you think a daily check-in makes sense for launch?',
        ),
      }),
    );
    const request = scripted.stream.mock.calls[0]?.[1] as unknown as { system: string };
    expect(request?.system).toContain('Launch plan');
    expect(request?.system).toContain('version 3');
    expect(request?.system).toContain('never action permission');
  });

  it('honors a current no-history instruction before memory and ambient reads', async () => {
    const store = chatStore();
    const scripted = scriptedRouter({
      triage: { needsAction: false },
      draft: 'Using only this note.',
    });
    const embed = vi.fn();
    Object.assign(scripted.router, { embed });
    const retrieve = vi.fn();
    const response = await handleChatTurn(
      send("Don't use old messages or memory; answer from this note."),
      {
        config: loadConfig({
          OPENROUTER_API_KEY: 'test-key',
          QUEUE_DRIVER: 'local',
          CHAT_RECALL_ENABLED: 'true',
          GRAPH_RAG_ENABLED: 'false',
        }),
        router: scripted.router,
        chat: store.chat,
        persistence: {
          tasks: {},
          ownerContext: {},
          situationDecisionContext: { retrieve },
        } as never,
      },
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(embed).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    expect(stubs.getAmbientBlock).not.toHaveBeenCalled();
    expect(stubs.getOwnerCard).not.toHaveBeenCalled();
  });
  it.each(['getAmbientBlock', 'getOwnerCard'] as const)(
    'answers without stalling when optional %s context is unavailable',
    async (context) => {
      stubs[context].mockRejectedValue(new Error('context read unavailable'));
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await turn('Hi', { draft: 'Hello. How can I help?' });
        expect(result.response.status).toBe(200);
        expect(result.completions[0]?.status).toBe('done');
        expect(result.completions[0]?.messages[0]?.text).toBe('Hello. How can I help?');
        expect(result.stream).toHaveBeenCalledOnce();
      } finally {
        quiet.mockRestore();
      }
    },
  );
  it.each([
    ['Hi', 'Hello. How can I help?'],
    ['I feel overwhelmed today.', 'We can take it one step at a time. What feels most urgent?'],
    [
      'Explain how embeddings work.',
      'Embeddings represent meaning as numbers so related ideas can be compared.',
    ],
    ['Thanks, that helps.', 'You are welcome.'],
    [
      'Do not send anything; help me rewrite this sentence.',
      'Here is a shorter version you can review.',
    ],
  ])('keeps ordinary conversation intact: %s', async (request, draft) => {
    const result = await turn(request, { draft });
    expect(result.completions[0]?.messages[0]?.text).toBe(draft);
    expect(result.completions[0]?.status).toBe('done');
    const wire = await result.response.text();
    expect(wire).not.toContain('data-off-course');
    expect(result.response.headers.get('x-owner-message-id')).toBeTruthy();
    const replyIdentity = result.completions[0]?.messages[0]?.channelMessageId;
    expect(replyIdentity).toMatch(/^chat-reply:/);
    expect(wire).toContain(replyIdentity);
    expect(stubs.enqueueTask).not.toHaveBeenCalled();
  });

  it('preserves spoken mode while using the same durable reply', async () => {
    const result = await turn(
      'Hello.',
      { draft: 'Hello. What is on your mind?' },
      { spoken: true },
    );
    const [, options] = result.stream.mock.calls[0] as unknown as [string, { system: string }];
    expect(options.system).toMatch(/spoken|out loud|ear/i);
    expect(result.completions[0]?.messages[0]?.text).toBe('Hello. What is on your mind?');
  });

  it('strips expressive cues consistently from saved and streamed prose', async () => {
    const result = await turn('Hi', { draft: '[face: happy_squint] Hello.' });
    const saved = result.completions[0]?.messages[0];
    expect(saved?.text).toBe('Hello.');
    expect(saved?.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'data-face' })]),
    );
    const body = await result.response.text();
    expect(body).toContain('data-face');
    expect(body).not.toContain('[face:');
  });

  it('cannot use a previous reminder creation to claim a fresh save', async () => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await turn(
        'How about that?',
        { draft: 'I scheduled the reminder.' },
        {},
        {
          evidence: [
            { toolName: 'reminder.create', status: 'succeeded', result: { reminderId: 'earlier' } },
          ],
        },
      );
      expect(result.completions[0]?.messages[0]?.text).toContain('not confirmed');
      expect(await result.response.text()).toContain('data-off-course');
    } finally {
      quiet.mockRestore();
    }
  });

  it('returns a model failure with one saved failure notice and no success', async () => {
    const result = await turn('Hello.', { streamError: new Error('provider unavailable') });
    expect(result.response.status).toBe(502);
    expect(await result.response.json()).toMatchObject({ code: 'model_unavailable' });
    expect(result.completions).toHaveLength(1);
    expect(result.completions[0]?.status).toBe('failed');
    expect(result.completions[0]?.messages[0]?.text).toContain('model service');
  });

  it('streams the draft and persists exactly the text it streamed', async () => {
    const draft = 'Otters hold hands while they sleep so they do not drift apart.';
    const { response, completions, stream, object } = await turn('tell me an otter fact', {
      triage: { needsAction: false },
      draft,
    });
    expect(object).toHaveBeenCalledOnce();
    expect(stream).toHaveBeenCalledOnce();
    expect(stubs.enqueueTask).not.toHaveBeenCalled();
    expect(completions).toHaveLength(1);
    expect(completions[0]?.status).toBe('done');
    expect(completions[0]?.messages[0]?.text).toBe(draft);
    const body = await response.text();
    expect(body).toContain(JSON.stringify(draft).slice(1, -1));
    expect(body).not.toContain('data-off-course');
  });

  it('records an empty completion as a failed turn, not a blank bubble', async () => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { completions } = await turn('tell me an otter fact', {
      triage: { needsAction: false },
      draft: '   ',
    });
    quiet.mockRestore();
    expect(completions).toHaveLength(1);
    expect(completions[0]?.status).toBe('failed');
    expect(completions[0]?.messages.map((message) => message.text)).toEqual([
      'The model returned an empty reply. Trying again usually works.',
    ]);
  });

  it('replaces a draft that claims work it never did, in the log and the stream alike', async () => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const draft =
      'I checked your primary calendar and the shared "Family" calendar — no flights in the next 3 weeks.';
    const { response, completions } = await turn('any flights coming up, do you think', {
      triage: { needsAction: false },
      draft,
    });
    quiet.mockRestore();
    const persisted = completions[0]?.messages[0]?.text;
    expect(persisted).toBeDefined();
    expect(persisted).not.toBe(draft);
    const body = await response.text();
    expect(body).toContain('data-off-course');
    // retireProvisionalReplies matches on exact text, so the marker must carry
    // the persisted replacement byte for byte.
    expect(body).toContain(JSON.stringify(persisted).slice(1, -1));
  });

  it('reports a spending-cap block with a 402 and a durable failure notice', async () => {
    const { response, completions } = await turn('tell me an otter fact', {
      triage: { needsAction: false },
      budgetBlocked: true,
    });
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ code: 'budget_exhausted' });
    expect(completions[0]?.status).toBe('failed');
    expect(completions[0]?.messages[0]?.text).toMatch(/spending cap/);
  });
});

describe('chat needs-action triage', () => {
  it('keeps cancellation-first sends out of archived history and title changes', async () => {
    const store = chatStore({
      cancellationWon: true,
      archivedConversation: true,
      emptyConversationTitle: true,
    });
    const scripted = scriptedRouter({ draft: 'This must never be requested.' });
    const response = await handleChatTurn(send('private prompt'), {
      config: config(),
      router: scripted.router,
      chat: store.chat,
      persistence: { tasks: {}, ownerContext: {} } as never,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      outcome: 'cancelled_before_admission',
      code: 'chat_turn_cancelled_before_admission',
      effectStatus: 'not_started',
      conversationId: CONVERSATION,
      clientOperationId: expect.any(String),
      taskId: null,
    });
    expect(store.messages).toEqual([]);
    expect(store.restoreConversation).not.toHaveBeenCalled();
    expect(store.setConversationTitleIfEmpty).not.toHaveBeenCalled();
    expect(scripted.object).not.toHaveBeenCalled();
    expect(scripted.stream).not.toHaveBeenCalled();
    expect(stubs.queueAdmission).not.toHaveBeenCalled();
  });
});

describe('chat request and decision boundaries', () => {
  it.each([
    ['malformed JSON', '{', 400],
    ['array body', '[]', 400],
    ['missing owner message', JSON.stringify({ messages: [] }), 400],
    ['non-array messages', JSON.stringify({ messages: {} }), 400],
    [
      'invalid conversation ID',
      JSON.stringify({ conversationId: 'other-chat', messages: [] }),
      400,
    ],
    [
      'empty text',
      JSON.stringify({ messages: [{ role: 'user', parts: [{ type: 'text', text: '   ' }] }] }),
      400,
    ],
    [
      'large UTF-8 message',
      JSON.stringify({
        messages: [{ role: 'user', parts: [{ type: 'text', text: '🌿'.repeat(4100) }] }],
      }),
      413,
    ],
  ])('rejects %s before writing or calling a model', async (_label, body, status) => {
    const store = chatStore();
    const scripted = scriptedRouter({});
    const response = await handleChatTurn(
      new Request('https://assistant.example/api/chat', { method: 'POST', body }),
      {
        config: config(),
        router: scripted.router,
        chat: store.chat,
        persistence: { tasks: {}, ownerContext: {} } as never,
      },
    );
    expect(response.status).toBe(status);
    expect(store.messages).toEqual([]);
    expect(scripted.object).not.toHaveBeenCalled();
    expect(scripted.stream).not.toHaveBeenCalled();
  });

  it('does not silently create another chat when the requested chat is unavailable', async () => {
    const result = await turn('Hello.', { draft: 'Hi' }, {}, { unavailableConversation: true });
    expect(result.response.status).toBe(404);
    expect(await result.response.json()).toMatchObject({ code: 'conversation_unavailable' });
    expect(result.createConversation).not.toHaveBeenCalled();
    expect(result.messages).toEqual([]);
    expect(result.stream).not.toHaveBeenCalled();
  });

  it('never applies an unmatched bare approval', async () => {
    const result = await turn(
      'Approved',
      {},
      {},
      { history: [{ role: 'assistant', text: 'Anything else?' }] },
    );
    expect(result.raiseTaskBudget).not.toHaveBeenCalled();
    expect(stubs.enqueueTask).not.toHaveBeenCalled();
    expect(result.completions[0]?.messages[0]?.text).toContain('no change has been made');
  });

  it('applies only the immediately preceding structured budget request', async () => {
    const result = await turn(
      'Approved',
      {},
      {},
      {
        history: [
          {
            role: 'assistant',
            text: 'May I raise this spending limit?',
            parts: [
              {
                type: 'budget-request',
                taskId: 'budget-task',
                proposedBudgetUsd: 2,
                status: 'pending',
              },
            ],
          },
        ],
      },
    );
    expect(result.raiseTaskBudget).toHaveBeenCalledExactlyOnceWith(AGENT, 'budget-task', 2);
    expect(result.completions[0]?.messages[0]?.text).toContain('$2.00');
    expect(result.stream).not.toHaveBeenCalled();
  });
});
