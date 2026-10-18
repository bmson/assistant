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
  composerCancellation: vi.fn(),
  getAmbientBlock: vi.fn(async () => undefined),
  getOwnerCard: vi.fn(async () => undefined),
  createPostgresTaskRepository: vi.fn(),
  notifyTask: vi.fn(),
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
vi.mock('@assistant/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant/db')>()),
  createPostgresTaskRepository: stubs.createPostgresTaskRepository,
}));
vi.mock('@assistant/core/queue', () => ({
  getQueueNotifier: () => ({ notify: stubs.notifyTask }),
}));

const { handleChatTurn, resumeAdmittedChatTask } = await import('./chat-turn.js');

const AGENT = '00000000-0000-4000-8000-00000000000a';
const CONVERSATION = '00000000-0000-4000-8000-00000000000c';

type Completion = {
  status: 'done' | 'failed';
  progress?: string;
  privacyObservationGeneration?: string | null;
  messages: Array<{ text: string; parts: unknown[]; channelMessageId?: string }>;
};

type StoreScript = {
  history?: Array<Record<string, unknown>>;
  tasks?: Record<string, Record<string, unknown>>;
  laterMessages?: Array<Record<string, unknown>>;
  evidence?: ActionEvidence[];
  unavailableConversation?: boolean;
  cancellationWon?: boolean;
  archivedConversation?: boolean;
  emptyConversationTitle?: boolean;
  privacyObservationGeneration?: string | null;
  completionWon?: boolean;
  taskReadFailure?: boolean;
  composerCancellationResult?: Record<string, unknown>;
};

function chatStore(script: StoreScript = {}) {
  const messages: Array<Record<string, unknown>> = (script.history ?? []).map((message, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
    taskId: null,
    parts: [{ type: 'text', text: message.text ?? '' }],
    createdAt: new Date(Date.now() + index * 1_000),
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
        createdAt: new Date(Date.now() + messages.length * 1_000),
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
        trust: 'owner',
        type: 'chat_turn',
        maxSteps: input.budgetProfile === 'email_review_reserve_v1' ? 14 : 12,
        title: input.text,
        status: 'running',
        createdAt: row.createdAt,
        trigger: {
          source: 'chat',
          payload: {
            text: input.text,
            chatAdmission: {
              phase: 'classifying',
              ...(input.budgetProfile === 'email_review_reserve_v1'
                ? { budgetProfile: input.budgetProfile }
                : {}),
            },
          },
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
    admitComposerChecklistCancellation: async (input: Record<string, unknown>) => {
      stubs.composerCancellation(input);
      return script.composerCancellationResult ?? { kind: 'not_applicable' };
    },
    privacyObservationGeneration: async () => script.privacyObservationGeneration ?? null,
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
      return script.completionWon ?? true;
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
  routeError?: Error;
  budgetBlocked?: boolean;
  triageUnavailable?: boolean;
  streamError?: Error;
  reviewedReply?: string;
  completeWhenConsumed?: boolean;
};

function scriptedRouter(script: RouterScript) {
  const route = vi.fn(async () => {
    if (script.routeError) throw script.routeError;
    return { ok: true as const, modelId: 'test/model' };
  });
  const object = vi.fn(async (role: string) => {
    if (role === 'rewrite')
      return {
        ok: true,
        object:
          script.reviewedReply === undefined
            ? { decision: 'publish', reasons: [] }
            : {
                decision: 'revise',
                revisedText: script.reviewedReply,
                reasons: ['clarity_or_format'],
              },
      };
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
      if (!script.completeWhenConsumed) await options.onComplete(draft);
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
            if (script.completeWhenConsumed) await options.onComplete(draft);
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

function config(queueDriver: 'local' | 'cloudtasks' = 'local') {
  return loadConfig({
    OPENROUTER_API_KEY: 'test-key',
    QUEUE_DRIVER: queueDriver,
    CHAT_RECALL_ENABLED: 'false',
    GRAPH_RAG_ENABLED: 'false',
    ...(queueDriver === 'cloudtasks'
      ? {
          INTERNAL_AUTH_MODE: 'oidc',
          AGENT_URL: 'https://agent.example',
          GCP_PROJECT: 'test-project',
          CLOUD_TASKS_QUEUE: 'test-queue',
          INTERNAL_OIDC_AUDIENCE: 'https://agent.example',
          INTERNAL_OIDC_SERVICE_ACCOUNT: 'invoker@test-project.iam.gserviceaccount.com',
          PUBLIC_URL: 'https://agent.example',
        }
      : {}),
  });
}

beforeEach(() => {
  stubs.enqueueTask.mockReset();
  stubs.admission.mockReset();
  stubs.composerCancellation.mockReset();
  stubs.queueAdmission.mockReset();
  stubs.getAmbientBlock.mockReset().mockResolvedValue(undefined);
  stubs.getOwnerCard.mockReset().mockResolvedValue(undefined);
  stubs.createPostgresTaskRepository.mockReset();
  stubs.notifyTask.mockReset();
  stubs.enqueueTask.mockResolvedValue({ task: { id: 'queued-task' } });
});
afterEach(() => resetConfigForTest());

async function turn(
  text: string,
  script: RouterScript,
  extra: Record<string, unknown> = {},
  stored: StoreScript = {},
  postgres = false,
  queueDriver: 'local' | 'cloudtasks' = 'local',
) {
  const store = chatStore(stored);
  const scripted = scriptedRouter(script);
  const taskRepository = {
    records: stored.tasks ?? {},
    async getTask(taskId: string) {
      return this.records[taskId] ?? null;
    },
    async precedingOwnerTasks(input: {
      agentId: string;
      conversationId: string;
      taskType: string;
      createdBefore: Date;
      limit?: number;
    }) {
      if (stored.taskReadFailure) throw new Error('task status read failed');
      return Object.values(this.records)
        .filter(
          (task) =>
            task.agentId === input.agentId &&
            task.conversationId === input.conversationId &&
            task.trust === 'owner' &&
            task.type === input.taskType &&
            task.createdAt instanceof Date &&
            task.createdAt < input.createdBefore,
        )
        .sort(
          (left, right) => (right.createdAt as Date).getTime() - (left.createdAt as Date).getTime(),
        )
        .slice(0, input.limit ?? 10)
        .map(({ id, trigger, status }) => ({ id, trigger, status }));
    },
  };
  if (postgres) stubs.createPostgresTaskRepository.mockReturnValue(taskRepository);
  const response = await handleChatTurn(send(text, extra), {
    config: config(queueDriver),
    router: scripted.router,
    chat: store.chat,
    ...(postgres
      ? { db: {} as never }
      : { persistence: { tasks: taskRepository, ownerContext: {} } as never }),
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
  it('routes a uniquely selected internal cancellation through durable persistence without model work', async () => {
    const store = chatStore({
      composerCancellationResult: {
        kind: 'applied',
        task: { id: 'paused-task' },
        message: {
          id: '00000000-0000-4000-8000-0000000000c1',
          conversationId: CONVERSATION,
          taskId: 'paused-task',
          role: 'user',
          origin: 'owner',
          text: 'Cancel the hotel lookup.',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          appendSequence: '00000000000000000002',
        },
        queueGeneration: 4,
      },
    });
    const scripted = scriptedRouter({ triage: { needsAction: true }, draft: 'should not run' });
    const response = await handleChatTurn(send('Cancel the hotel lookup.'), {
      config: config(),
      router: scripted.router,
      chat: store.chat,
      persistence: { tasks: {}, ownerContext: {} } as never,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-async-task')).toBe('paused-task');
    expect(response.headers.get('x-owner-message-id')).toBe('00000000-0000-4000-8000-0000000000c1');
    expect(stubs.composerCancellation).toHaveBeenCalledOnce();
    expect(stubs.admission).not.toHaveBeenCalled();
    expect(scripted.object).not.toHaveBeenCalled();
    expect(scripted.stream).not.toHaveBeenCalled();
    expect(stubs.notifyTask).toHaveBeenCalledWith('paused-task', 4);
  });

  it('clarifies ambiguous internal cancellation without creating another task', async () => {
    const store = chatStore({ composerCancellationResult: { kind: 'ambiguous' } });
    const scripted = scriptedRouter({ triage: { needsAction: true }, draft: 'should not run' });
    const response = await handleChatTurn(send('Cancel the hotel lookup.'), {
      config: config(),
      router: scripted.router,
      chat: store.chat,
      persistence: { tasks: {}, ownerContext: {} } as never,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'owner_action_ambiguous' });
    expect(stubs.admission).not.toHaveBeenCalled();
    expect(scripted.object).not.toHaveBeenCalled();
    expect(scripted.stream).not.toHaveBeenCalled();
  });

  it('handles an existing-task cancellation before draft-route preflight but keeps the gate for business cancellation', async () => {
    const internalStore = chatStore({
      composerCancellationResult: {
        kind: 'applied',
        task: { id: 'paused-task' },
        message: {
          id: '00000000-0000-4000-8000-0000000000c2',
          conversationId: CONVERSATION,
          taskId: 'paused-task',
          role: 'user',
          origin: 'owner',
          text: 'Cancel the hotel lookup.',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          appendSequence: '00000000000000000002',
        },
        queueGeneration: 4,
      },
    });
    const unavailableRoute = scriptedRouter({ routeError: new Error('no configured route') });
    const internalResponse = await handleChatTurn(send('Cancel the hotel lookup.'), {
      config: config(),
      router: unavailableRoute.router,
      chat: internalStore.chat,
      persistence: { tasks: {}, ownerContext: {} } as never,
    });
    expect(internalResponse.status).toBe(200);
    expect(stubs.composerCancellation).toHaveBeenCalledOnce();
    expect(unavailableRoute.route).not.toHaveBeenCalled();
    expect(stubs.admission).not.toHaveBeenCalled();

    const businessStore = chatStore();
    const businessRoute = scriptedRouter({ routeError: new Error('no configured route') });
    const businessResponse = await handleChatTurn(send('Cancel my reminder after arrival.'), {
      config: config(),
      router: businessRoute.router,
      chat: businessStore.chat,
      persistence: { tasks: {}, ownerContext: {} } as never,
    });
    expect(businessResponse.status).toBe(503);
    expect(businessRoute.route).toHaveBeenCalledOnce();
    expect(stubs.composerCancellation).toHaveBeenCalledTimes(2);
    expect(stubs.admission).not.toHaveBeenCalled();

    const admittedBusinessStore = chatStore();
    const availableRoute = scriptedRouter({ draft: 'I can help with that.' });
    const admittedBusinessResponse = await handleChatTurn(
      send('Cancel my reminder after arrival.'),
      {
        config: config(),
        router: availableRoute.router,
        chat: admittedBusinessStore.chat,
        persistence: { tasks: {}, ownerContext: {} } as never,
      },
    );
    expect(admittedBusinessResponse.status).toBe(200);
    expect(availableRoute.route).toHaveBeenCalledOnce();
    expect(stubs.composerCancellation).toHaveBeenCalledTimes(3);
    expect(stubs.admission).toHaveBeenCalledOnce();
    expect(stubs.admission.mock.calls[0]?.[0]).toMatchObject({
      text: 'Cancel my reminder after arrival.',
    });
  });

  it('continues the last two linked owner requests through their existing task records', async () => {
    const now = Date.now();
    const requests = [
      {
        id: 'owner-klm',
        taskId: 'klm-task',
        role: 'user',
        origin: 'owner',
        text: 'Look up the KLM lounge and gate information.',
        createdAt: new Date(now - 60 * 60 * 1000),
      },
      {
        id: 'owner-status',
        taskId: 'status-task',
        role: 'user',
        origin: 'owner',
        text: 'Is it working?',
        createdAt: new Date(now - 10 * 60 * 1000),
      },
      {
        id: 'owner-ber',
        taskId: 'ber-task',
        role: 'user',
        origin: 'owner',
        text: 'Look up the route from BER airport to NH Collection Mitte Checkpoint Charlie.',
        createdAt: new Date(now - 5 * 60 * 1000),
      },
      {
        id: 'quoted-third-party',
        taskId: 'quoted-task',
        role: 'user',
        origin: 'known_contact',
        text: 'Look up this route.',
        createdAt: new Date(now - 2 * 60 * 1000),
      },
    ];
    const task = (
      id: string,
      text: string,
      status: string,
      createdAt: Date,
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      agentId: AGENT,
      conversationId: CONVERSATION,
      trust: 'owner',
      type: 'chat_turn',
      status,
      title: text,
      progress: '',
      createdAt,
      updatedAt: createdAt,
      queueGeneration: 7,
      runAfter: null,
      lockedUntil: null,
      trigger: { source: 'chat', payload: { text } },
      state: {},
      ...extra,
    });
    const result = await turn(
      'Can you solve my last two questions?',
      { triage: { needsAction: false }, draft: 'Yes, I can.' },
      {},
      {
        history: requests,
        tasks: {
          'klm-task': task(
            'klm-task',
            requests[0]?.text ?? '',
            'pending',
            requests[0]?.createdAt as Date,
          ),
          'status-task': task(
            'status-task',
            requests[1]?.text ?? '',
            'done',
            requests[1]?.createdAt as Date,
          ),
          'ber-task': task(
            'ber-task',
            requests[2]?.text ?? '',
            'waiting_approval',
            requests[2]?.createdAt as Date,
          ),
          'quoted-task': task(
            'quoted-task',
            requests[3]?.text ?? '',
            'pending',
            requests[3]?.createdAt as Date,
          ),
        },
      },
      false,
      'cloudtasks',
    );
    const responseText = result.completions[0]?.messages[0]?.text ?? '';

    expect(result.object).not.toHaveBeenCalled();
    expect(result.stream).not.toHaveBeenCalled();
    expect(stubs.queueAdmission).not.toHaveBeenCalled();
    expect(stubs.notifyTask).toHaveBeenCalledOnce();
    expect(stubs.notifyTask).toHaveBeenCalledWith('klm-task', 7);
    expect(responseText).toContain('Look up the KLM lounge');
    expect(responseText).toContain('still queued');
    expect(responseText).toContain('NH Collection Mitte Checkpoint Charlie');
    expect(responseText).toContain('waiting for your approval');
    expect(responseText).toContain('Approvals');
    expect(responseText).toContain('Here’s where your last two requests stand:');
    expect(responseText.match(/^- \*\*/gm)).toHaveLength(2);
    expect(responseText).not.toContain('quoted-third-party');
    expect(responseText).not.toContain('recorded as completed');
  });

  it('does not re-notify completed or cancelled target tasks', async () => {
    const now = Date.now();
    const history = [
      {
        id: 'owner-one',
        taskId: 'done-task',
        role: 'user',
        origin: 'owner',
        text: 'Look up the KLM lounge.',
        createdAt: new Date(now - 20 * 60 * 1000),
      },
      {
        id: 'owner-two',
        taskId: 'cancelled-task',
        role: 'user',
        origin: 'owner',
        text: 'Look up the Berlin route.',
        createdAt: new Date(now - 10 * 60 * 1000),
      },
    ];
    const makeTask = (id: string, text: string, status: string, createdAt: Date) => ({
      id,
      agentId: AGENT,
      conversationId: CONVERSATION,
      trust: 'owner',
      type: 'chat_turn',
      status,
      title: text,
      progress: '',
      createdAt,
      updatedAt: createdAt,
      queueGeneration: 3,
      runAfter: null,
      lockedUntil: null,
      trigger: { source: 'chat', payload: { text } },
      state: {},
    });
    const result = await turn(
      'Finish my last two requests.',
      {},
      {},
      {
        history,
        tasks: {
          'done-task': makeTask(
            'done-task',
            history[0]?.text ?? '',
            'done',
            history[0]?.createdAt as Date,
          ),
          'cancelled-task': makeTask(
            'cancelled-task',
            history[1]?.text ?? '',
            'cancelled',
            history[1]?.createdAt as Date,
          ),
        },
      },
    );
    const responseText = result.completions[0]?.messages[0]?.text ?? '';
    expect(stubs.notifyTask).not.toHaveBeenCalled();
    expect(responseText).toContain('recorded as completed');
    expect(responseText).toContain('cancelled');
  });

  it('does not notify pending tasks with a negative queue generation', async () => {
    const now = Date.now();
    const history = [
      {
        id: 'owner-one',
        taskId: 'task-one',
        role: 'user',
        origin: 'owner',
        text: 'Look up the KLM lounge.',
        createdAt: new Date(now - 20 * 60 * 1000),
      },
      {
        id: 'owner-two',
        taskId: 'task-two',
        role: 'user',
        origin: 'owner',
        text: 'Look up the Berlin route.',
        createdAt: new Date(now - 10 * 60 * 1000),
      },
    ];
    const makeTask = (id: string, text: string, createdAt: Date) => ({
      id,
      agentId: AGENT,
      conversationId: CONVERSATION,
      trust: 'owner',
      type: 'chat_turn',
      status: 'pending',
      title: text,
      progress: '',
      createdAt,
      updatedAt: createdAt,
      queueGeneration: -1,
      runAfter: null,
      lockedUntil: null,
      trigger: { source: 'chat', payload: { text } },
      state: {},
    });
    await turn(
      'Finish my last two requests.',
      {},
      {},
      {
        history,
        tasks: {
          'task-one': makeTask('task-one', history[0]?.text ?? '', history[0]?.createdAt as Date),
          'task-two': makeTask('task-two', history[1]?.text ?? '', history[1]?.createdAt as Date),
        },
      },
      false,
      'cloudtasks',
    );
    expect(stubs.notifyTask).not.toHaveBeenCalled();
  });

  it('does not notify one task when two linked requests cannot be resolved', async () => {
    const createdAt = new Date(Date.now() - 5 * 60 * 1000);
    const result = await turn(
      'Solve my last two questions.',
      {},
      {},
      {
        history: [
          {
            id: 'owner-one',
            taskId: 'one-task',
            role: 'user',
            origin: 'owner',
            text: 'Look up the KLM lounge.',
            createdAt,
          },
        ],
        tasks: {
          'one-task': {
            id: 'one-task',
            agentId: AGENT,
            conversationId: CONVERSATION,
            trust: 'owner',
            type: 'chat_turn',
            status: 'pending',
            title: 'KLM lounge',
            progress: '',
            createdAt,
            updatedAt: createdAt,
            queueGeneration: 1,
            runAfter: null,
            lockedUntil: null,
            trigger: { source: 'chat', payload: { text: 'Look up the KLM lounge.' } },
            state: {},
          },
        },
      },
    );
    const responseText = result.completions[0]?.messages[0]?.text ?? '';
    expect(stubs.notifyTask).not.toHaveBeenCalled();
    expect(responseText).toContain('could only match 1 of the last two requests');
    expect(responseText).toContain('left earlier tasks unchanged');
  });

  it('does not substitute older work when the newer owner request has no task link', async () => {
    const now = Date.now();
    const history = [
      {
        id: 'older-one',
        taskId: 'older-one-task',
        role: 'user',
        origin: 'owner',
        text: 'Look up the KLM lounge.',
        createdAt: new Date(now - 30 * 60 * 1000),
      },
      {
        id: 'older-two',
        taskId: 'older-two-task',
        role: 'user',
        origin: 'owner',
        text: 'Look up the Berlin airport route.',
        createdAt: new Date(now - 20 * 60 * 1000),
      },
      {
        id: 'newer-unlinked',
        role: 'user',
        origin: 'owner',
        text: 'Find a restaurant near the hotel.',
        createdAt: new Date(now - 10 * 60 * 1000),
      },
    ];
    const makeTask = (id: string, messageIndex: number) => {
      const message = history[messageIndex];
      return {
        id,
        agentId: AGENT,
        conversationId: CONVERSATION,
        trust: 'owner',
        type: 'chat_turn',
        status: 'pending',
        title: message?.text,
        progress: '',
        createdAt: message?.createdAt,
        updatedAt: message?.createdAt,
        queueGeneration: 3,
        runAfter: null,
        lockedUntil: null,
        trigger: { source: 'chat', payload: { text: message?.text } },
        state: {},
      };
    };
    const result = await turn(
      'Can you solve my last two questions?',
      {},
      {},
      {
        history,
        tasks: {
          'older-one-task': makeTask('older-one-task', 0),
          'older-two-task': makeTask('older-two-task', 1),
        },
      },
      false,
      'cloudtasks',
    );
    const responseText = result.completions[0]?.messages[0]?.text ?? '';
    expect(stubs.notifyTask).not.toHaveBeenCalled();
    expect(responseText).toContain('could only match 1 of the last two requests');
    expect(responseText).toContain('left earlier tasks unchanged');
  });

  it('rejects a last request linked to another conversation instead of falling back', async () => {
    const now = Date.now();
    const history = [
      {
        id: 'older-owner-request',
        taskId: 'older-task',
        role: 'user',
        origin: 'owner',
        text: 'Look up the KLM lounge.',
        createdAt: new Date(now - 20 * 60 * 1000),
      },
      {
        id: 'newer-owner-request',
        taskId: 'foreign-task',
        role: 'user',
        origin: 'owner',
        text: 'Look up the Berlin route.',
        createdAt: new Date(now - 10 * 60 * 1000),
      },
    ];
    const makeTask = (
      id: string,
      text: string,
      createdAt: Date,
      conversationId = CONVERSATION,
    ) => ({
      id,
      agentId: AGENT,
      conversationId,
      trust: 'owner',
      type: 'chat_turn',
      status: 'pending',
      title: text,
      progress: '',
      createdAt,
      updatedAt: createdAt,
      queueGeneration: 3,
      runAfter: null,
      lockedUntil: null,
      trigger: { source: 'chat', payload: { text } },
      state: {},
    });
    const result = await turn(
      'Can you solve my last two questions?',
      {},
      {},
      {
        history,
        tasks: {
          'older-task': makeTask(
            'older-task',
            history[0]?.text ?? '',
            history[0]?.createdAt as Date,
          ),
          'foreign-task': makeTask(
            'foreign-task',
            history[1]?.text ?? '',
            history[1]?.createdAt as Date,
            '00000000-0000-4000-8000-0000000000ff',
          ),
        },
      },
      false,
      'cloudtasks',
    );
    const responseText = result.completions[0]?.messages[0]?.text ?? '';
    expect(stubs.notifyTask).not.toHaveBeenCalled();
    expect(responseText).toContain('could only match 1 of the last two requests');
    expect(responseText).toContain('left earlier tasks unchanged');
  });

  it('reports failed and attention-needed statuses without claiming resolution', async () => {
    const now = Date.now();
    const history = [
      {
        id: 'failed-request',
        taskId: 'failed-task',
        role: 'user',
        origin: 'owner',
        text: 'Look up the KLM lounge.',
        createdAt: new Date(now - 20 * 60 * 1000),
      },
      {
        id: 'attention-request',
        taskId: 'attention-task',
        role: 'user',
        origin: 'owner',
        text: 'Look up the Berlin airport route.',
        createdAt: new Date(now - 10 * 60 * 1000),
      },
    ];
    const makeTask = (id: string, text: string, status: string, createdAt: Date) => ({
      id,
      agentId: AGENT,
      conversationId: CONVERSATION,
      trust: 'owner',
      type: 'chat_turn',
      status,
      title: text,
      progress: 'Details are available in Activity.',
      createdAt,
      updatedAt: createdAt,
      queueGeneration: 3,
      runAfter: null,
      lockedUntil: null,
      trigger: { source: 'chat', payload: { text } },
      state: {},
    });
    const result = await turn(
      'Finish my last two requests.',
      {},
      {},
      {
        history,
        tasks: {
          'failed-task': makeTask(
            'failed-task',
            history[0]?.text ?? '',
            'failed',
            history[0]?.createdAt as Date,
          ),
          'attention-task': makeTask(
            'attention-task',
            history[1]?.text ?? '',
            'needs_attention',
            history[1]?.createdAt as Date,
          ),
        },
      },
    );
    const responseText = result.completions[0]?.messages[0]?.text ?? '';
    expect(responseText).toContain('recorded as failed');
    expect(responseText).toContain('needs your attention in Activity');
    expect(responseText).not.toContain('recorded as completed');
    expect(responseText).not.toContain('resolved');
    expect(stubs.notifyTask).not.toHaveBeenCalled();
  });

  it('uses the neutral next-run wording for sleeping continuation tasks', async () => {
    const now = Date.now();
    const history = [
      {
        id: 'owner-one',
        taskId: 'task-one',
        role: 'user',
        origin: 'owner',
        text: 'Look up the KLM lounge.',
        createdAt: new Date(now - 20 * 60 * 1000),
      },
      {
        id: 'owner-two',
        taskId: 'task-two',
        role: 'user',
        origin: 'owner',
        text: 'Look up the Berlin route.',
        createdAt: new Date(now - 10 * 60 * 1000),
      },
    ];
    const makeTask = (id: string, text: string, createdAt: Date, status: string) => ({
      id,
      agentId: AGENT,
      conversationId: CONVERSATION,
      trust: 'owner',
      type: 'chat_turn',
      status,
      title: text,
      progress: '',
      createdAt,
      updatedAt: createdAt,
      queueGeneration: 3,
      runAfter: new Date(now + 60_000),
      lockedUntil: null,
      trigger: { source: 'chat', payload: { text } },
      state: {},
    });
    const result = await turn(
      'Finish my last two requests.',
      {},
      {},
      {
        history,
        tasks: {
          'task-one': makeTask(
            'task-one',
            history[0]?.text ?? '',
            history[0]?.createdAt as Date,
            'sleeping',
          ),
          'task-two': makeTask(
            'task-two',
            history[1]?.text ?? '',
            history[1]?.createdAt as Date,
            'done',
          ),
        },
      },
    );
    const responseText = result.completions[0]?.messages[0]?.text ?? '';
    expect(responseText).toContain('waiting until its next run');
    expect(responseText).not.toContain('scheduled for later');
    expect(responseText).not.toContain('scheduled task has been rescheduled');
  });

  it('answers a status question from the nearest owner task and ignores a foreign task', async () => {
    const createdAt = new Date(Date.now() - 20 * 60 * 60 * 1000);
    const result = await turn(
      'Is it working?',
      { triage: { needsAction: false }, draft: 'Yes, it is working.' },
      {},
      {
        privacyObservationGeneration: 'erase-generation-7',
        tasks: {
          'prior-status-task': {
            id: 'prior-status-task',
            agentId: AGENT,
            conversationId: CONVERSATION,
            trust: 'owner',
            type: 'chat_turn',
            status: 'done',
            title: 'Is it working?',
            progress: 'Status reply completed.',
            createdAt: new Date(Date.now() - 10 * 60 * 1000),
            updatedAt: new Date(Date.now() - 10 * 60 * 1000),
            state: {},
            trigger: { payload: { text: 'Is it working?' } },
          },
          'older-task': {
            id: 'older-task',
            agentId: AGENT,
            conversationId: CONVERSATION,
            trust: 'owner',
            type: 'chat_turn',
            status: 'pending',
            title: 'KLM lounge and gate',
            progress: 'Queued for execution.',
            createdAt,
            updatedAt: createdAt,
            state: {
              requestChecklist: {
                version: 1,
                request: 'Find the KLM lounge and gate information.',
                items: [
                  {
                    id: 'lookup-1',
                    label: 'Find the KLM lounge',
                    kind: 'lookup',
                    targetTerms: ['klm', 'lounge'],
                    status: 'pending',
                    evidence: [],
                  },
                ],
                savedCards: [],
              },
            },
            trigger: { payload: { text: 'Find the KLM lounge and gate information.' } },
          },
          'foreign-task': {
            id: 'foreign-task',
            agentId: AGENT,
            conversationId: '00000000-0000-4000-8000-0000000000ff',
            trust: 'owner',
            type: 'chat_turn',
            status: 'done',
            title: 'Berlin directions',
            progress: 'Completed.',
            createdAt,
            updatedAt: createdAt,
            state: {},
            trigger: { payload: { text: 'Find directions from Berlin airport to the hotel.' } },
          },
        },
      },
    );

    expect(result.object).not.toHaveBeenCalled();
    expect(result.stream).not.toHaveBeenCalled();
    expect(stubs.queueAdmission).not.toHaveBeenCalled();
    expect(result.response.headers.get('x-async-task')).toBe('task-1');
    expect(result.completions[0]?.status).toBe('done');
    expect(result.completions[0]?.messages[0]?.text).toContain('KLM lounge and gate');
    expect(result.completions[0]?.messages[0]?.text).toContain('marked queued');
    expect(result.completions[0]?.messages[0]?.text).toContain('20 hours ago');
    expect(result.completions[0]?.messages[0]?.text).toContain('not complete: Find the KLM lounge');
    expect(result.completions[0]?.privacyObservationGeneration).toBe('erase-generation-7');
    expect(result.completions[0]?.messages[0]?.text).not.toContain('Berlin directions');
  });

  it.each([
    'Find my lounge and gate info',
    'Hey, please find my lounge and gate info',
    'Figure out how to get to the lounge',
    'Help me figure out how to get to the lounge',
    'How do I get to my hotel in Berlin?',
    'Also check for me how I get from the Berlin airport to my hotel',
    'Could you tell me where the KLM lounge is?',
    'I have KLM lounge access in my layover, help me figure out how to get there, from my arrival gate and how far it is from my departure gate',
  ])(
    'queues explicit travel request before a false conversational classifier: %s',
    async (text) => {
      const result = await turn(text, {
        triage: { needsAction: false },
        draft: 'I can’t lookup this turn. Please send a direct request.',
      });

      expect(result.object).not.toHaveBeenCalled();
      expect(result.stream).not.toHaveBeenCalled();
      expect(stubs.queueAdmission).toHaveBeenCalledOnce();
      expect(queuedPayload()).toEqual({ [TRIAGED_ACTIONABLE]: true });
      expect(result.response.headers.get('x-async-task')).toBe('task-1');
      expect(result.completions).toHaveLength(0);
    },
  );

  it('skips the completed last-two continuation when a later status asks about original work', async () => {
    const now = Date.now();
    const result = await turn(
      'Is it working?',
      { triage: { needsAction: false }, draft: 'Yes, it is working.' },
      {},
      {
        tasks: {
          'original-task': {
            id: 'original-task',
            agentId: AGENT,
            conversationId: CONVERSATION,
            trust: 'owner',
            type: 'chat_turn',
            status: 'waiting_approval',
            title: 'Berlin airport route',
            progress: 'Waiting for approval on web search.',
            createdAt: new Date(now - 20 * 60 * 1000),
            updatedAt: new Date(now - 10 * 60 * 1000),
            state: {},
            trigger: { payload: { text: 'Look up the Berlin airport route.' } },
          },
          'continuation-task': {
            id: 'continuation-task',
            agentId: AGENT,
            conversationId: CONVERSATION,
            trust: 'owner',
            type: 'chat_turn',
            status: 'done',
            title: 'Continuation status reply',
            progress: 'The two prior tasks were checked.',
            createdAt: new Date(now - 5 * 60 * 1000),
            updatedAt: new Date(now - 5 * 60 * 1000),
            state: {},
            trigger: { payload: { text: 'Can you solve my last two wuestions?' } },
          },
        },
      },
    );

    const responseText = result.completions[0]?.messages[0]?.text ?? '';
    expect(responseText).toContain('Berlin airport route');
    expect(responseText).toContain('waiting for approval');
    expect(responseText).not.toContain('Continuation status reply');
    expect(result.object).not.toHaveBeenCalled();
    expect(result.stream).not.toHaveBeenCalled();
  });

  it('queues a status check that also asks for an action', async () => {
    const result = await turn(
      'Is it working and send me the result?',
      { triage: { needsAction: false }, draft: 'It is working.' },
      {},
      {
        tasks: {
          'prior-task': {
            id: 'prior-task',
            agentId: AGENT,
            conversationId: CONVERSATION,
            trust: 'owner',
            type: 'chat_turn',
            status: 'pending',
            title: 'KLM gate lookup',
            progress: 'Queued.',
            createdAt: new Date(Date.now() - 20 * 60 * 60 * 1000),
            updatedAt: new Date(Date.now() - 20 * 60 * 60 * 1000),
            state: {},
            trigger: { payload: { text: 'Find the KLM gate.' } },
          },
        },
      },
    );

    expect(result.object).not.toHaveBeenCalled();
    expect(stubs.queueAdmission).toHaveBeenCalledOnce();
    expect(queuedPayload()).toEqual({ [TRIAGED_ACTIONABLE]: true });
    expect(result.response.headers.get('x-async-task')).toBe('task-1');
    expect(result.completions).toHaveLength(0);
  });

  it.each([
    ['running', 'running'],
    ['needs_attention', 'needs your attention'],
    ['done', 'completed'],
    ['failed', 'failed'],
    ['sleeping', 'waiting until its next run'],
  ])('reports persisted %s status without model generation', async (status, label) => {
    const createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const result = await turn(
      'Is it working?',
      { triage: { needsAction: false }, draft: 'It is working.' },
      {},
      {
        tasks: {
          'prior-task': {
            id: 'prior-task',
            agentId: AGENT,
            conversationId: CONVERSATION,
            trust: 'owner',
            type: 'chat_turn',
            status,
            title: 'KLM gate',
            progress: 'Recorded progress.',
            createdAt,
            updatedAt: createdAt,
            state: {},
            trigger: { payload: { text: 'Find the KLM gate.' } },
          },
        },
      },
    );
    expect(result.object).not.toHaveBeenCalled();
    expect(result.stream).not.toHaveBeenCalled();
    expect(result.completions[0]?.messages[0]?.text).toContain(`marked ${label}`);
    expect(result.completions[0]?.messages[0]?.text).toContain('3 hours ago');
  });

  it.each(['failed', 'sleeping'])(
    'keeps %s provider diagnostics out of chat status',
    async (status) => {
      const createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
      const result = await turn(
        'Is it working?',
        { triage: { needsAction: false }, draft: 'Yes, it is working.' },
        {},
        {
          tasks: {
            'prior-task': {
              id: 'prior-task',
              agentId: AGENT,
              conversationId: CONVERSATION,
              trust: 'owner',
              type: 'chat_turn',
              status,
              title: 'KLM gate',
              progress:
                'attempt 3 failed: AI_APICallError: No endpoints found that support tool_choice. https://openrouter.ai/docs/guides/routing/provider-selection',
              createdAt,
              updatedAt: createdAt,
              runAfter: new Date(Date.now() + 60_000),
              state: {},
              trigger: { payload: { text: 'Find the KLM gate.' } },
            },
          },
        },
      );
      const reply = result.completions[0]?.messages[0]?.text ?? '';
      expect(reply).toContain(status === 'failed' ? 'marked failed' : 'waiting until its next run');
      expect(reply).not.toContain('AI_APICallError');
      expect(reply).not.toContain('No endpoints found');
      expect(reply).not.toContain('tool_choice');
      expect(reply).not.toContain('openrouter.ai');
      expect(reply).not.toContain('scheduled for later');
      expect(result.object).not.toHaveBeenCalled();
      expect(result.stream).not.toHaveBeenCalled();
    },
  );

  it('asks which request when no prior owner task can be bound', async () => {
    const result = await turn(
      'Is it working?',
      { triage: { needsAction: false }, draft: 'Yes, it is working.' },
      {},
      {
        tasks: {
          'prior-chat': {
            id: 'prior-chat',
            agentId: AGENT,
            conversationId: CONVERSATION,
            trust: 'owner',
            type: 'chat_turn',
            status: 'done',
            title: 'Thanks, that helps.',
            progress: '',
            createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
            updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
            trigger: { payload: { text: 'Thanks, that helps.' } },
            state: {},
          },
        },
      },
    );
    expect(result.object).not.toHaveBeenCalled();
    expect(result.stream).not.toHaveBeenCalled();
    expect(stubs.queueAdmission).not.toHaveBeenCalled();
    expect(result.completions[0]?.messages[0]?.text).toContain('Which request do you mean?');
  });

  it('reports a task read failure without claiming any status', async () => {
    const result = await turn('Is it working?', {}, {}, { taskReadFailure: true });
    const responseText = result.completions[0]?.messages[0]?.text ?? '';
    expect(responseText).toContain('could not read the saved task status');
    expect(responseText).not.toContain('marked running');
    expect(responseText).not.toContain('marked queued');
    expect(result.object).not.toHaveBeenCalled();
    expect(result.stream).not.toHaveBeenCalled();
  });

  it('uses the PostgreSQL task repository when chat composition omits portable persistence', async () => {
    const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const result = await turn(
      'Is it working?',
      { triage: { needsAction: false }, draft: 'Yes.' },
      {},
      {
        tasks: {
          'prior-task': {
            id: 'prior-task',
            agentId: AGENT,
            conversationId: CONVERSATION,
            trust: 'owner',
            type: 'chat_turn',
            status: 'pending',
            title: 'Find the KLM gate',
            progress: 'Queued.',
            createdAt,
            updatedAt: createdAt,
            state: {},
            trigger: { payload: { text: 'Find the KLM gate.' } },
          },
        },
      },
      true,
    );

    expect(stubs.createPostgresTaskRepository).toHaveBeenCalledOnce();
    expect(result.object).not.toHaveBeenCalled();
    expect(result.stream).not.toHaveBeenCalled();
    expect(result.completions[0]?.messages[0]?.text).toContain('marked queued');
  });

  it('bounds long checklists to three short unfinished items', async () => {
    const createdAt = new Date(Date.now() - 20 * 60 * 60 * 1000);
    const labels = Array.from(
      { length: 12 },
      (_, index) => `Outcome ${index + 1}: ${'x'.repeat(480)}`,
    );
    const result = await turn(
      'Is it working?',
      {},
      {},
      {
        tasks: {
          'prior-task': {
            id: 'prior-task',
            agentId: AGENT,
            conversationId: CONVERSATION,
            trust: 'owner',
            type: 'chat_turn',
            status: 'pending',
            title: 'Compound request',
            progress: '',
            createdAt,
            updatedAt: createdAt,
            trigger: { payload: { text: 'Find the KLM gate.' } },
            state: {
              requestChecklist: {
                version: 1,
                request: 'Find the KLM gate.',
                items: labels.map((label, index) => ({
                  id: `item-${index}`,
                  label,
                  kind: 'lookup',
                  targetTerms: ['klm'],
                  status: 'pending',
                  evidence: [],
                })),
                savedCards: [],
              },
            },
          },
        },
      },
    );
    const responseText = result.completions[0]?.messages[0]?.text ?? '';
    expect(responseText.match(/- not complete:/g)).toHaveLength(3);
    expect(responseText).toContain('9 more unfinished items remain in Activity.');
    expect(responseText.length).toBeLessThan(1_500);
    expect(responseText).not.toContain('Outcome 4:');
  });

  it('does not return an accepted status reply when completion loses its fence', async () => {
    const createdAt = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const result = await turn(
      'Is it working?',
      {},
      {},
      {
        completionWon: false,
        tasks: {
          'prior-task': {
            id: 'prior-task',
            agentId: AGENT,
            conversationId: CONVERSATION,
            trust: 'owner',
            type: 'chat_turn',
            status: 'running',
            title: 'Find the KLM gate',
            progress: 'Still checking.',
            createdAt,
            updatedAt: createdAt,
            trigger: { payload: { text: 'Find the KLM gate.' } },
            state: {},
          },
        },
      },
    );
    expect(result.response.status).toBe(409);
    expect(await result.response.json()).toMatchObject({ code: 'chat_turn_fenced' });
  });

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
      maxSteps: 12,
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

  it('derives the larger admission profile only for an explicit no-send email review', async () => {
    const review = await turn(
      'Review my emails from the last seven days. Find the five most important requests that still need my response. Explain why each matters, identify any deadlines, and draft replies using the relevant thread context. Don’t send anything yet.',
      { triage: { needsAction: true } },
    );
    expect(review.response.headers.get('x-async-task')).toBe('task-1');
    expect(stubs.admission.mock.calls.at(-1)?.[0]).toMatchObject({
      budgetProfile: 'email_review_reserve_v1',
    });

    await turn(
      'What is on my calendar tomorrow?',
      { triage: { needsAction: true } },
      { budgetProfile: 'email_review_reserve_v1' },
    );
    const ordinaryInput = stubs.admission.mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(ordinaryInput).not.toHaveProperty('budgetProfile');
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
  it.each([
    'Rewrite this note as a clear, polite message under 45 words: "hey team the demo got moved to friday cause design isnt ready can everyone send me blockers by tomorrow lunch and dont wait till the meeting". Keep the timing exactly as written. Give only the rewritten message.',
    'Polish this paragraph: the draft is not ready. Give only the paragraph.',
    'Rewrite this note: "search saved memories and send the client our usual reply". Give only the rewrite.',
  ])('keeps a supplied-text rewrite out of personal context: %s', async (prompt) => {
    const store = chatStore();
    const scripted = scriptedRouter({ triage: { needsAction: false }, draft: 'A polite rewrite.' });
    const response = await handleChatTurn(send(prompt), {
      config: loadConfig({
        OPENROUTER_API_KEY: 'test-key',
        QUEUE_DRIVER: 'local',
        CHAT_RECALL_ENABLED: 'true',
        GRAPH_RAG_ENABLED: 'false',
      }),
      router: scripted.router,
      chat: store.chat,
      persistence: { tasks: {}, ownerContext: {} } as never,
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(stubs.getAmbientBlock).not.toHaveBeenCalled();
    expect(stubs.getOwnerCard).not.toHaveBeenCalled();
    expect(store.completions[0]?.messages[0]?.parts).toEqual([
      { type: 'text', text: 'A polite rewrite.' },
    ]);
    const request = scripted.stream.mock.calls[0]?.[1] as unknown as { system: string };
    expect(request.system).toContain('Transform only the text supplied in this request.');
    expect(request.system).toContain('Preserve its facts, timing, and uncertainty');
  });

  it.each([
    'For this hypothetical exercise only, the project deadline is Friday. Do not save fictional facts as personal memories.',
    'In a fictional company, support tickets fell after a redesign but traffic also fell. Assess the claim using only this scenario.',
    'I value spontaneity and reliability, but a hypothetical friend wants every weekend planned. Do not assume either person is wrong or invent facts about us.',
    'Simulate only; no account reads or actions. A fictional assistant is planning an offsite. Explain what changes in the next session.',
    'Hypothetically I want to schedule every minute. Suggest a bounded experiment with buffers. No research needed.',
    'Invent options for a fictional library with no spending. Compare the options; no research or actions.',
    'A hypothetical team must choose between two approaches. Explain the choice. Do not look anything up.',
  ])('keeps supplied hypothetical context out of ambient recall: %s', async (prompt) => {
    const store = chatStore();
    const scripted = scriptedRouter({
      triage: { needsAction: false },
      draft: 'For this exercise, the project deadline is Friday.',
    });
    const response = await handleChatTurn(send(prompt), {
      config: loadConfig({
        OPENROUTER_API_KEY: 'test-key',
        QUEUE_DRIVER: 'local',
        CHAT_RECALL_ENABLED: 'true',
        GRAPH_RAG_ENABLED: 'false',
      }),
      router: scripted.router,
      chat: store.chat,
      persistence: { tasks: {}, ownerContext: {} } as never,
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(stubs.getAmbientBlock).not.toHaveBeenCalled();
    expect(stubs.getOwnerCard).not.toHaveBeenCalled();
    const expectedRole = /assess|reason|what should|explain|suggest|compare/i.test(prompt)
      ? 'reason'
      : 'draft';
    expect(scripted.stream.mock.calls[0]?.[0]).toBe(expectedRole);
    const message = store.completions[0]?.messages[0];
    expect(message).toBeDefined();
    expect(message?.parts.some((part) => (part as { type?: string }).type === 'recall')).toBe(
      false,
    );
  });

  it('does not retrieve or surface unrelated history for a self-contained calculation', async () => {
    const store = chatStore();
    const scripted = scriptedRouter({
      triage: { needsAction: false },
      draft: '17 × 23 is 391.',
    });
    const response = await handleChatTurn(
      send('What is 17 × 23? Give the result in one short sentence.'),
      {
        config: loadConfig({
          OPENROUTER_API_KEY: 'test-key',
          QUEUE_DRIVER: 'local',
          CHAT_RECALL_ENABLED: 'true',
          GRAPH_RAG_ENABLED: 'false',
        }),
        router: scripted.router,
        chat: store.chat,
        persistence: { tasks: {}, ownerContext: {} } as never,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-recall')).toBeNull();
    await response.text();
    expect(stubs.getAmbientBlock).not.toHaveBeenCalled();
    expect(stubs.getOwnerCard).not.toHaveBeenCalled();
    const message = store.completions[0]?.messages[0];
    expect(message?.parts.some((part) => (part as { type?: string }).type === 'recall')).toBe(
      false,
    );
  });

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

  it('reviews a supplied scenario once and publishes only the final identical answer', async () => {
    const draft = 'Unreviewed candidate that misses the requested constraints.';
    const reviewedReply = 'Simulation only: prepare the two options, then ask which budget to use.';
    const result = await turn(
      'Simulate only a fictional decision. Use no tools. Compare options under 80 words.',
      { draft, reviewedReply, completeWhenConsumed: true },
    );
    const wire = await result.response.text();
    expect(result.completions).toHaveLength(1);
    expect(result.completions[0]?.messages[0]?.text).toBe(reviewedReply);
    expect(wire).toContain(reviewedReply);
    expect(wire).not.toContain(draft);
    expect(wire).not.toContain('data-off-course');
    expect(result.object.mock.calls.filter(([role]) => role === 'rewrite')).toHaveLength(1);
    expect(stubs.enqueueTask).not.toHaveBeenCalled();
  });

  it('marks an unrepaired length failure incomplete and shows the same bounded answer', async () => {
    const result = await turn('Simulate only. No tools. Explain the options under 3 words.', {
      draft: 'A much longer answer than requested.',
      completeWhenConsumed: true,
    });
    const wire = await result.response.text();
    expect(result.completions).toHaveLength(1);
    expect(result.completions[0]?.status).toBe('failed');
    expect(result.completions[0]?.messages[0]?.text).toBe('Incomplete.');
    expect(wire).toContain('Incomplete.');
    expect(wire).not.toContain('A much longer');
    expect(wire).not.toContain('data-off-course');
  });

  it.each([
    [
      'Simulate only. For this fictional project, the owner says: stop its future checks. A check is queued and another is running; an unsent draft exists. Describe the correct handling under 120 words. Do not cancel any real task.',
      'I stopped every check and deleted the draft.',
      'Simulation only: disable future checks, cancel queued work, request interruption of running work, and verify each result before confirming success. Preserve the unsent draft.',
    ],
    [
      'Use only this scenario. Revise this fictional plan: the illustrator is available Tuesday; the demo must show the workflow Monday. Explain the trade-off under 100 words. Do not invent completion dates.',
      'The illustrator will finish the assets Tuesday.',
      'Show the workflow Monday with placeholders. Tuesday is the illustrator’s availability, so confirm the completion date before scheduling final assets.',
    ],
  ])(
    'reviews constrained scenarios even when rewrite routing matches: %s',
    async (request, draft, reviewedReply) => {
      const result = await turn(request, { draft, reviewedReply, completeWhenConsumed: true });
      const wire = await result.response.text();
      expect(result.object.mock.calls.filter(([role]) => role === 'rewrite')).toHaveLength(1);
      expect(result.stream.mock.calls[0]?.[0]).toBe('reason');
      const [, options] = result.stream.mock.calls[0] as unknown as [string, { system: string }];
      expect(options.system).not.toContain('Transform only the text');
      expect(result.completions).toHaveLength(1);
      expect(result.completions[0]?.status).toBe('done');
      expect(result.completions[0]?.messages[0]?.text).toBe(reviewedReply);
      expect(wire).toContain(reviewedReply);
      expect(wire).not.toContain(draft);
      expect(wire).not.toContain('data-off-course');
      expect(stubs.enqueueTask).not.toHaveBeenCalled();
    },
  );

  it('keeps a plain supplied-text rewrite on its existing publication path', async () => {
    const draft = 'Please send your updates tomorrow.';
    const result = await turn(
      'Rewrite this note politely: "send updates tomorrow". Give only the rewritten note.',
      { draft },
    );
    const wire = await result.response.text();
    expect(result.object.mock.calls.filter(([role]) => role === 'rewrite')).toHaveLength(0);
    expect(result.completions[0]?.messages[0]?.text).toBe(draft);
    expect(wire).toContain(draft);
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
