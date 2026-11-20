import { randomUUID } from 'node:crypto';
import { handleChatTurn } from '@assistant/application';
import { getChatUpdates } from '@assistant/application/chat';
import { loadConfig } from '@assistant/config';
import { executeTask, type ModelRouter } from '@assistant/core';
import { runScheduleBatch } from '@assistant/core/workflow/schedules';
import {
  createDb,
  createPostgresApplicationChatPersistence,
  createPostgresExecutionPersistence,
  createPostgresScheduleRepository,
  type Db,
} from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import {
  createFirestoreExecutionPersistence,
  FirestoreApplicationChatPersistence,
  FirestoreScheduleRepository,
} from '@assistant/firestore';
import { ToolDispatcher, ToolRegistry } from '@assistant/tools';
import { registerPortableGoalTools, registerRecurringDigestTools } from '@assistant/tools/builtin';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  disposeStore,
  emulatorStore,
  seedBudget,
} from '../../../packages/firestore/src/test-store.js';

const fixedClock = () => new Date('2026-11-19T17:00:00.000Z');
const timezone = 'America/Los_Angeles';
const SPACE = { provider: 'synthetic', model: 'f2', dimensions: 1536, revision: '1' };
const MODEL = { ok: true, modelId: 'synthetic/f2', degraded: false };
const postgresUrl = process.env.DATABASE_URL;
assertAllocatedTestTarget({
  databaseUrl: postgresUrl,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  kind: 'standard',
});
if (!postgresUrl) throw new Error('F2 needs the allocator-owned database');

const library = {
  topic: 'new library events',
  localTime: '09:00',
  cadence: { kind: 'weekly', days: [5] },
};
const museum = { topic: 'museum exhibits', localTime: '18:30', cadence: { kind: 'daily' } };
type ToolCall = { name: string; input: Record<string, unknown> };
type Digest = { scheduleId: string; topic: string; nextRunAt: string; timezone: string };

function scriptedRouter(call?: ToolCall) {
  let stepCount = 0;
  return {
    route: async () => ({
      ...MODEL,
      model: {},
      thinking: false,
      decision: { mode: 'primary' },
      params: {},
      promptCostPerMTok: 0,
      completionCostPerMTok: 0,
    }),
    object: async (role: string, input: { system?: string }) => {
      if (role === 'plan') expect(input.system).toContain('digest.schedule');
      return {
        ...MODEL,
        object:
          role === 'plan'
            ? {
                action: 'workflow',
                reasoning: '',
                steps: ['Resolve the request.'],
                missingInfo: [],
              }
            : { needsAction: true, trivial: false, decision: 'publish', reasons: [] },
      };
    },
    embeddingSpace: async () => SPACE,
    embed: async (values: string[]) => values.map(() => new Array(SPACE.dimensions).fill(1)),
    async step(
      _role: string,
      input: {
        tools: Record<string, unknown>;
        messages: {
          content:
            | string
            | {
                type: string;
                toolName?: string;
                output?: { value?: Digest & { digests?: Digest[]; event?: string } };
              }[];
        }[];
      },
    ) {
      if (!call) throw new Error('Cadence clarification must happen before model tool execution');
      if (++stepCount === 1) {
        expect(input.tools).toHaveProperty([call.name]);
        return {
          ...MODEL,
          text: '',
          toolCalls: [{ toolCallId: 'f2-digest', toolName: call.name, input: call.input }],
        };
      }
      const receipt = input.messages
        .flatMap(({ content }) => (typeof content === 'string' ? [] : content))
        .find((part) => part.type === 'tool-result' && part.toolName === call.name)?.output?.value;
      const text = receipt?.event
        ? `Library events digest: ${receipt.event}.`
        : receipt?.digests
          ? receipt.digests
              .map((row) => `${row.topic}: ${row.scheduleId}, next ${row.nextRunAt}`)
              .join('\n')
          : receipt?.scheduleId
            ? `Scheduled the ${receipt.topic} digest. Next run ${receipt.nextRunAt} (${receipt.timezone}).`
            : 'I could not save that schedule.';
      return { ...MODEL, text, toolCalls: [], finishReason: 'stop' };
    },
  } as unknown as ModelRouter;
}

it('routes recurring digests through owner chat, persists them once and runs two slots', async () => {
  const firestore = process.env.FIRESTORE_EMULATOR_HOST ? emulatorStore() : undefined;
  const pg = firestore ? undefined : createDb(postgresUrl);
  const db =
    pg ??
    (new Proxy(
      {},
      {
        get: (_target, property) => {
          throw new Error(`Unexpected PostgreSQL access: ${String(property)}`);
        },
      },
    ) as Db);
  try {
    const agentId = firestore
      ? randomUUID()
      : (await createPostgresApplicationChatPersistence(db).resolveAgent()).id;
    if (firestore) {
      await firestore.doc('agents', agentId).set({
        id: agentId,
        name: 'Synthetic F2 owner',
        email: 'owner@example.test',
        timezone,
        createdAt: fixedClock(),
        updatedAt: fixedClock(),
      });
      await seedBudget(firestore);
    }
    const chat = firestore
      ? new FirestoreApplicationChatPersistence(firestore, agentId)
      : createPostgresApplicationChatPersistence(db);
    const persistence = firestore
      ? createFirestoreExecutionPersistence(firestore, agentId, SPACE)
      : createPostgresExecutionPersistence(db);
    const schedules = firestore
      ? new FirestoreScheduleRepository(firestore)
      : createPostgresScheduleRepository(db);
    const config = loadConfig({
      NODE_ENV: 'test',
      PERSISTENCE_DRIVER: persistence.driver,
      ...(firestore
        ? {
            FIRESTORE_AGENT_ID: agentId,
            ASSISTANT_WORKSPACE_ID: firestore.installationId,
            FIRESTORE_EMBEDDING_SPACE: JSON.stringify(SPACE),
          }
        : {}),
      OPENROUTER_API_KEY: 'synthetic-not-a-real-key',
      QUEUE_DRIVER: 'local',
      CHAT_RECALL_ENABLED: 'false',
      GRAPH_RAG_ENABLED: 'false',
    });

    const registry = new ToolRegistry();
    registerRecurringDigestTools(registry, { schedules, getTimezone: async () => timezone });
    let goalWrites = 0;
    registerPortableGoalTools(registry, {
      missions: {
        recordSessionProgress: async () => {
          throw new Error('Unexpected mission write');
        },
      },
      goals: {
        listStanding: async () => [],
        create: async () => {
          goalWrites += 1;
          return { goalId: randomUUID() };
        },
      },
    });
    const dispatcher = new ToolDispatcher(
      db,
      registry,
      persistence.toolExecution,
      persistence.costs,
      persistence.approvals,
      persistence.approvalPolicies,
    );

    const turn = async (requestText: string, call?: ToolCall, replay = false, replyTo?: string) => {
      const router = scriptedRouter(call);
      const conversationId = replyTo ?? (await chat.createConversation(agentId)).id;
      const clientOperationId = randomUUID();
      const body = JSON.stringify({
        conversationId,
        clientOperationId,
        messages: [
          { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: requestText }] },
        ],
      });
      const admit = () =>
        handleChatTurn(
          new Request('http://assistant.local/api/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          }),
          { config, chat, persistence, router },
        );
      const response = await admit();
      const taskId = response.headers.get('x-async-task');
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('data-task-accepted');
      if (!taskId) throw new Error('Owner chat did not admit a task');
      let retryTaskId: string | null = null;
      if (replay) {
        const retry = await admit();
        retryTaskId = retry.headers.get('x-async-task');
        expect(retryTaskId).toBe(taskId);
        await retry.text();
      }
      const outcome = await executeTask({ db, persistence, router, dispatcher }, taskId);
      const ledger = await persistence.executionEvidence.taskEvidence({ agentId, taskId });
      const update = await getChatUpdates(chat, { conversationId, taskId });
      const replies = update?.messages.filter((message) => message.role === 'assistant') ?? [];
      const published = replies
        .flatMap((message) =>
          message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
        )
        .join('\n');
      return { taskId, retryTaskId, conversationId, outcome, ledger, published };
    };

    const read = async () =>
      (await schedules.listPage(agentId, { limit: 200 })).items.filter((row) =>
        row.name.startsWith('digest:'),
      );
    const duplicateRequest = { name: 'digest.schedule', input: library };
    const ambiguous = await turn('Please give me a weekly digest of new library events at 9.');
    expect(ambiguous.ledger).toEqual([]);
    expect(ambiguous.published).toMatch(/which days|what time/i);
    expect(await read()).toEqual([]);

    const first = await turn(
      'Every Friday at 9 a.m., summarize new library events for me.',
      duplicateRequest,
      true,
    );
    const [libraryRow] = await read();
    expect(libraryRow).toMatchObject({ agentId, cron: '0 9 * * 5', enabled: true });
    if (!libraryRow?.nextRunAt) throw new Error('Expected the saved next run');
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
      hour: 'numeric',
      minute: '2-digit',
    });
    expect(local.format(libraryRow.nextRunAt)).toBe('Friday 9:00 AM');
    expect(first.ledger).toHaveLength(1);
    expect(first.ledger[0]).toMatchObject({
      toolName: 'digest.schedule',
      status: 'succeeded',
      result: {
        scheduleId: libraryRow.id,
        nextRunAt: libraryRow.nextRunAt.toISOString(),
        timezone,
      },
    });
    expect(first.published).toContain(libraryRow.id);

    const paraphrase = await turn(
      'Could you give me a weekly roundup of new library events on Fridays at 09:00?',
      duplicateRequest,
    );
    expect(paraphrase.ledger[0]?.result).toMatchObject({ scheduleId: libraryRow.id });
    expect(await read()).toEqual([libraryRow]);
    const clarified = await turn(
      'Fridays at 9 a.m.',
      duplicateRequest,
      false,
      ambiguous.conversationId,
    );
    expect(clarified).toMatchObject({
      outcome: { outcome: 'done' },
      ledger: [{ result: { scheduleId: libraryRow.id } }],
    });
    expect(clarified.published).toContain(libraryRow.id);
    expect(await read()).toEqual([libraryRow]);

    const daily = await turn('Prepare a daily recap of museum exhibits at 6:30 pm.', {
      name: 'digest.schedule',
      input: museum,
    });
    expect(daily.ledger[0]?.result).toMatchObject({ topic: museum.topic });
    const stored = await read();
    expect(stored).toHaveLength(2);

    const fresh = await turn('Which recurring digests are scheduled?', {
      name: 'digest.list',
      input: {},
    });
    expect(fresh.conversationId).not.toBe(first.conversationId);
    expect(fresh.ledger[0]?.result).toMatchObject({
      digests: expect.arrayContaining(
        stored.map((row) => expect.objectContaining({ scheduleId: row.id })),
      ),
    });
    for (const row of stored) expect(fresh.published).toContain(row.id);

    const denied = await turn(
      'Please check the library website for events today.',
      duplicateRequest,
    );
    expect(denied.ledger.every((row) => row.status !== 'succeeded')).toBe(true);
    expect(await read()).toEqual(stored);
    expect(registry.toolsForTask('assistant').map((tool) => tool.name)).not.toContain(
      'digest.schedule',
    );
    expect(registry.toolsForTask('unknown').map((tool) => tool.name)).not.toContain('digest.list');

    expect(await schedules.getByName(randomUUID(), libraryRow.name)).toBeNull();

    const goal = await turn('Create a long-term goal called Library Events.', {
      name: 'goals.create',
      input: { title: 'Library Events' },
    });
    expect(goalWrites).toBe(0);
    expect(goal.outcome.outcome).toBe('parked');
    expect(await read()).toEqual(stored);

    // Restrict the sweeps to this fixture while using the real adapter for commits.
    const libraryOnly = {
      ...schedules,
      listUninitialized: async () => [],
      listDue: async (now: Date) =>
        (await schedules.listDue(now, 200)).filter((row) => row.id === libraryRow.id),
      commitOccurrence: schedules.commitOccurrence.bind(schedules),
    };
    const occurrences = [];
    const events = ['Book swap on Saturday', 'Story hour on Sunday'];
    let fixtureEvent = '';
    registry.register({
      name: 'web.fetch',
      description: 'Read the fixture library events for this run.',
      inputSchema: z.object({}),
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async () => ({ event: fixtureEvent }),
    });
    for (const event of events) {
      fixtureEvent = event;
      const scheduledReply = `Library events digest: ${event}.`;
      const row = await schedules.getByName(agentId, libraryRow.name);
      if (!row?.nextRunAt) throw new Error('Expected the next digest slot');
      const fired = await runScheduleBatch(libraryOnly, timezone, { now: row.nextRunAt });
      expect(fired).toHaveLength(1);
      expect(await runScheduleBatch(libraryOnly, timezone, { now: row.nextRunAt })).toEqual([]);
      const taskId = fired[0]?.taskId;
      if (!taskId) throw new Error('Digest slot did not create a task');
      const task = await persistence.tasks.getTask(taskId);
      expect(task).toMatchObject({
        agentId,
        conversationId: first.conversationId,
        trust: 'assistant',
        externalEventId: `schedule:${libraryRow.id}:${row.nextRunAt.toISOString()}`,
      });
      const outcome = await executeTask(
        { db, persistence, router: scriptedRouter({ name: 'web.fetch', input: {} }), dispatcher },
        taskId,
      );
      expect(outcome).toMatchObject({ outcome: 'done' });
      const saved = await chat.listMessages(agentId, first.conversationId, { limit: 50 });
      expect(
        saved?.messages.filter(
          (message) => message.taskId === taskId && message.text === scheduledReply,
        ),
      ).toHaveLength(1);
      const ledger = await persistence.executionEvidence.taskEvidence({ agentId, taskId });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        toolName: 'web.fetch',
        status: 'succeeded',
        result: { event },
      });
      occurrences.push({
        taskId,
        slot: row.nextRunAt,
        eventId: task?.externalEventId,
        outcome,
        ledger,
      });
    }
    console.log(
      'F2_DIGEST_EVIDENCE',
      JSON.stringify({
        revision: process.env.F2_REVISION,
        store: persistence.driver,
        ambiguous,
        first,
        paraphrase,
        clarified,
        daily,
        fresh,
        denied,
        goal,
        stored,
        occurrences,
      }),
    );
  } finally {
    if (firestore) await disposeStore(firestore);
    if (pg) await pg.$client.end();
  }
}, 45_000);
