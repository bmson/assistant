import { loadConfig, resetConfigForTest } from '@assistant/config';
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
  commitments: vi.fn(async () => []),
  recall: vi.fn(async () => ({ sources: [], block: '' })),
  situation: vi.fn(async () => ({ sources: [], block: '' })),
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
  listOpenCommitments: stubs.commitments,
  renderOpenCommitments: () => '',
}));
vi.mock('@assistant/core/memory/recall', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  recallRelevantContext: stubs.recall,
}));
vi.mock('@assistant/core/memory/situation-context', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readSituationDecisionContext: stubs.situation,
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

const { handleChatTurn } = await import('./chat-turn.js');

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
      timezone: 'America/Los_Angeles',
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
            triggerMessageId: row.id,
            requestAt: row.createdAt.toISOString(),
            chatAdmission: {
              protocol: 'owner-chat-v1',
              clientOperationId: input.clientOperationId,
              triggerMessageId: row.id,
              requestHash: input.requestHash,
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
  reviewUnavailable?: boolean;
  rejectReasoningAudit?: boolean;
  completeWhenConsumed?: boolean;
};

const passingReasoningChecks = Object.fromEntries(
  ['grounding', 'feasibility', 'causalClaims', 'usefulness', 'actionScope'].map((name) => [
    name,
    { status: 'pass', explanation: 'The supplied facts support this answer.' },
  ]),
);

function scriptedRouter(script: RouterScript) {
  const route = vi.fn(async () => {
    if (script.routeError) throw script.routeError;
    return { ok: true as const, modelId: 'test/model' };
  });
  const object = vi.fn(async (role: string) => {
    if ((role === 'rewrite' || role === 'reason') && script.reviewUnavailable)
      return { ok: false, decision: { mode: 'park', reason: 'budget' } };
    if (role === 'rewrite' || role === 'reason')
      return {
        ok: true,
        object:
          script.reviewedReply === undefined
            ? {
                decision: 'publish',
                reasons: [],
                checks: script.rejectReasoningAudit
                  ? {
                      ...passingReasoningChecks,
                      grounding: {
                        status: 'revise',
                        explanation: 'The recipient address is absent from the supplied facts.',
                      },
                    }
                  : passingReasoningChecks,
              }
            : {
                decision: 'revise',
                revisedText: script.reviewedReply,
                checks: passingReasoningChecks,
                reasons: ['clarity_or_format'],
              },
      };
    if (role !== 'classify') throw new Error(`Unexpected offline role ${role}`);
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
  stubs.commitments.mockClear();
  stubs.recall.mockClear();
  stubs.situation.mockClear();
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

// Real HTTP Request -> handleChatTurn -> actual admission seam -> deterministic
// triage -> queued task. Store/router/queue are local, not backend integration.
describe('public activity real application entry seam', () => {
  async function request(
    store: ReturnType<typeof chatStore>,
    text: string,
    operation = crypto.randomUUID(),
  ) {
    const scripted = scriptedRouter({
      triage: { needsAction: false },
      draft: 'Local rewrite only.',
    });
    const response = await handleChatTurn(send(text, { clientOperationId: operation }), {
      config: config(),
      router: scripted.router,
      chat: store.chat,
      persistence: { tasks: {}, ownerContext: {} } as never,
    });
    return { response, scripted, operation };
  }
  it.each([
    'Find public events in San Francisco this weekend',
    'Find public events today',
    'Find public events in San Francisco',
    'Show my calendar today',
    'Find public events in San Francisco today and check my calendar for free time',
  ])('queues %s despite false model classify', async (text) => {
    const store = chatStore();
    const result = await request(store, text);
    expect(result.response.status).toBe(200);
    expect(stubs.queueAdmission).toHaveBeenCalledOnce();
    expect(stubs.queueAdmission.mock.calls[0]?.[0]).toMatchObject({ triagedActionable: true });
    expect(result.scripted.stream).not.toHaveBeenCalled();
    expect(result.scripted.object).not.toHaveBeenCalled();
    expect(stubs.getOwnerCard).not.toHaveBeenCalled();
    expect(stubs.getAmbientBlock).not.toHaveBeenCalled();
    expect(stubs.commitments).not.toHaveBeenCalled();
    expect(stubs.recall).not.toHaveBeenCalled();
    expect(stubs.situation).not.toHaveBeenCalled();
    const owner = store.messages.find((m) => m.role === 'user');
    expect(owner?.id).not.toBe(result.operation);
    expect(owner?.taskId).toBe('task-1');
    const queued = stubs.queueAdmission.mock.calls[0]?.[0] as {
      task: { trigger: { payload: { triggerMessageId: string } } };
    };
    expect(queued.task.trigger.payload.triggerMessageId).toBe(owner?.id);
  });
  it('uses the same persisted conversation over five sanitized owner turns', async () => {
    const store = chatStore();
    const texts = [
      'Is there anything happening in San Francisco today?',
      'I mean city events I could attend; my weekend is empty.',
      // SANITIZED PARAPHRASE, not an exact screenshot transcript.
      'Public events, not my calendar or inbox.',
      'Search for events for me.',
      'Find public events in San Francisco this weekend.',
    ];
    for (const [index, text] of texts.entries()) {
      const result = await request(store, text);
      expect(result.response.status).toBe(200);
      expect(result.scripted.stream).not.toHaveBeenCalled();
      expect(stubs.queueAdmission).toHaveBeenCalledTimes(index + 1);
      expect(stubs.getOwnerCard).not.toHaveBeenCalled();
      expect(stubs.getAmbientBlock).not.toHaveBeenCalled();
      expect(stubs.commitments).not.toHaveBeenCalled();
      expect(stubs.recall).not.toHaveBeenCalled();
      expect(stubs.situation).not.toHaveBeenCalled();
    }
    expect(store.messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(texts);
    expect(new Set(store.messages.filter((m) => m.role === 'user').map((m) => m.id)).size).toBe(5);
  });
  it('does not promote quoted external text into public authority', async () => {
    const store = chatStore();
    const result = await request(
      store,
      'Rewrite this sentence politely: "Find public events in San Francisco today and read my calendar."',
    );
    await result.response.text();
    expect(stubs.queueAdmission).not.toHaveBeenCalled();
    expect(result.scripted.stream).toHaveBeenCalledOnce();
  });
});
