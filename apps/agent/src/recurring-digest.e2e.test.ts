import { randomUUID } from 'node:crypto';
import { handleChatTurn } from '@assistant/application';
import { getChatUpdates } from '@assistant/application/chat';
import { loadConfig } from '@assistant/config';
import { executeTask, type ModelRouter } from '@assistant/core';
import { runScheduleBatch } from '@assistant/core/workflow/schedules';
import {
  agents,
  createDb,
  createPostgresApplicationChatPersistence,
  createPostgresExecutionPersistence,
  createPostgresScheduleRepository,
  type Db,
  schedules as postgresSchedules,
} from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import {
  createFirestoreExecutionPersistence,
  FirestoreApplicationChatPersistence,
  FirestoreScheduleRepository,
} from '@assistant/firestore';
import { ToolDispatcher, ToolRegistry } from '@assistant/tools';
import { registerPortableGoalTools, registerRecurringDigestTools } from '@assistant/tools/builtin';
import { eq } from 'drizzle-orm';
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

function scriptedRouter(call?: ToolCall, beforeRecovery?: () => Promise<void>) {
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
      stepCount += 1;
      if (stepCount <= (beforeRecovery ? 2 : 1)) {
        if (stepCount === 2) {
          expect(JSON.stringify(input.messages)).toContain('topic_mismatch');
          expect(JSON.stringify(input.messages)).toContain(library.topic);
          await beforeRecovery?.();
        }
        expect(input.tools).toHaveProperty([call.name]);
        return {
          ...MODEL,
          text: '',
          toolCalls: [
            {
              toolCallId: `f2-digest-${stepCount}`,
              toolName: call.name,
              input:
                beforeRecovery && stepCount === 1
                  ? { ...call.input, topic: 'garden shows' }
                  : call.input,
            },
          ],
        };
      }
      const receipt = input.messages
        .flatMap(({ content }) => (typeof content === 'string' ? [] : content))
        .findLast((part) => part.type === 'tool-result' && part.toolName === call.name)
        ?.output?.value;
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

it('moves, cancels, and deletes recurring digests through owner chat and verifies delivery', async () => {
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
    registerRecurringDigestTools(registry, {
      schedules,
      getTimezone: async () => timezone,
      executionContext: persistence.executionContext,
      executionEvidence: persistence.executionEvidence,
    });
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

    const turn = async (
      requestText: string,
      call?: ToolCall,
      replay = false,
      replyTo?: string,
      beforeRecovery?: () => Promise<void>,
      afterAdmission?: () => Promise<() => Promise<void>>,
    ) => {
      const router = scriptedRouter(call, beforeRecovery);
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
      const verifyAndRestore = await afterAdmission?.();
      const outcome = await executeTask({ db, persistence, router, dispatcher }, taskId).finally(
        () => verifyAndRestore?.(),
      );
      const ledger = await persistence.executionEvidence.taskEvidence({ agentId, taskId });
      let completedRetryTaskId: string | null = null;
      if (replay) {
        const retry = await admit();
        completedRetryTaskId = retry.headers.get('x-async-task');
        expect(completedRetryTaskId).toBe(taskId);
        await retry.text();
        expect(await persistence.executionEvidence.taskEvidence({ agentId, taskId })).toEqual(
          ledger,
        );
      }
      const update = await getChatUpdates(chat, { conversationId, taskId });
      const history = await chat.listMessages(agentId, conversationId, { limit: 50 });
      const replyIds = new Set(
        history?.messages
          .filter((message) => message.role === 'assistant' && message.taskId === taskId)
          .map((message) => message.id),
      );
      const replies = update?.messages.filter((message) => replyIds.has(message.id)) ?? [];
      const published = replies
        .flatMap((message) =>
          message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
        )
        .join('\n');
      return {
        requestText,
        taskId,
        retryTaskId,
        completedRetryTaskId,
        conversationId,
        outcome,
        ledger,
        published,
        replyCount: replies.length,
      };
    };

    const read = async () =>
      (await schedules.listPage(agentId, { limit: 200 })).items.filter((row) =>
        row.name.startsWith('digest:'),
      );
    const manage = { name: 'digest.manage', input: {} };
    const digestList = { name: 'digest.list', input: {} };
    const duplicateRequest = { name: 'digest.schedule', input: library };
    const ambiguous = await turn('Please give me a weekly digest of new library events at 9.');
    expect(ambiguous.ledger).toEqual([]);
    expect(ambiguous.published).toMatch(/which days|what time/i);
    expect(await read()).toEqual([]);

    const first = await turn(
      'Every Friday at 9 a.m., summarize new library events for me here in this chat.',
      duplicateRequest,
      true,
      undefined,
      async () => {
        expect(await read()).toEqual([]);
      },
    );
    const [libraryRow] = await read();
    expect(libraryRow).toMatchObject({
      agentId,
      cron: '0 9 * * 5',
      enabled: true,
      taskTemplate: { digest: { topic: library.topic }, conversationId: first.conversationId },
    });
    if (!libraryRow?.nextRunAt) throw new Error('Expected the saved next run');
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
      hour: 'numeric',
      minute: '2-digit',
    });
    expect(local.format(libraryRow.nextRunAt)).toBe('Friday 9:00 AM');
    expect(first.ledger).toHaveLength(2);
    expect(first.ledger[0]).toMatchObject({
      args: { topic: 'garden shows' },
      result: { status: 'topic_mismatch', expectedTopic: library.topic },
    });
    expect(first.ledger[1]).toMatchObject({
      toolName: 'digest.schedule',
      status: 'succeeded',
      result: {
        scheduleId: libraryRow.id,
        nextRunAt: libraryRow.nextRunAt.toISOString(),
        timezone,
        conversationId: first.conversationId,
        inCurrentChat: true,
      },
    });
    expect(first.outcome.outcome).toBe('done');
    expect(first.published).toContain(libraryRow.id);

    const paraphrase = await turn(
      'Could you give me a weekly roundup of new library events on Fridays at 09:00?',
      duplicateRequest,
    );
    expect(paraphrase.ledger[0]?.result).toMatchObject({
      scheduleId: libraryRow.id,
      conversationId: first.conversationId,
      inCurrentChat: false,
    });
    expect(paraphrase.published).toContain(`/chat/${first.conversationId}`);
    expect(await read()).toEqual([libraryRow]);

    const conflict = await turn(
      'Every Friday at 9 a.m., summarize new library events for me here in this chat.',
      duplicateRequest,
      false,
      paraphrase.conversationId,
    );
    expect(conflict.ledger[0]?.result).toMatchObject({
      status: 'destination_conflict',
      scheduleId: libraryRow.id,
      conversationId: first.conversationId,
    });
    expect(conflict.published).toContain(`/chat/${first.conversationId}`);
    expect(conflict.published).toContain(
      'Do you want to keep that destination or move the digest here?',
    );
    expect(conflict.published).not.toContain('Scheduled the');
    expect(conflict.replyCount).toBe(1);
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

    const missingTopic = await turn('Prepare a daily recap of that at 6:30 pm.');
    expect(missingTopic.ledger).toEqual([]);
    expect(missingTopic.published).toContain('What topic should the recurring digest cover?');
    expect(await read()).toEqual([libraryRow]);
    const daily = await turn(
      'Museum exhibits.',
      { name: 'digest.schedule', input: museum },
      false,
      missingTopic.conversationId,
    );
    expect(daily.ledger[0]?.result).toMatchObject({ topic: 'Museum exhibits' });
    const stored = await read();
    expect(stored).toHaveLength(2);

    const fresh = await turn('Which recurring digests are scheduled?', {
      name: 'digest.list',
      input: {},
    });
    expect(fresh.conversationId).not.toBe(first.conversationId);
    expect(fresh.ledger[0]?.result).toMatchObject({
      digests: expect.arrayContaining([
        expect.objectContaining({
          scheduleId: libraryRow.id,
          conversationId: first.conversationId,
        }),
        expect.objectContaining({ conversationId: daily.conversationId, topic: 'Museum exhibits' }),
      ]),
    });
    for (const row of stored) expect(fresh.published).toContain(row.id);
    expect(fresh.published).toContain(`/chat/${first.conversationId}`);
    expect(fresh.published).toContain(`/chat/${daily.conversationId}`);

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

    const unavailable = await turn('Move it here.', manage);
    expect(unavailable.ledger[0]?.result).toMatchObject({ status: 'move_requires_offer' });
    expect(await read()).toEqual(stored);
    const moved = await turn('Move it here.', manage, true, conflict.conversationId);
    expect(moved.ledger).toHaveLength(1);
    expect(moved.ledger[0]?.result).toMatchObject({
      status: 'moved',
      scheduleId: libraryRow.id,
      conversationId: conflict.conversationId,
      nextRunAt: libraryRow.nextRunAt.toISOString(),
    });
    expect(moved.published).toContain('Moved the digest here');
    expect(moved.replyCount).toBe(1);
    const movedRow = await schedules.getByName(agentId, libraryRow.name);
    expect(movedRow).toMatchObject({
      id: libraryRow.id,
      cron: libraryRow.cron,
      nextRunAt: libraryRow.nextRunAt,
      taskTemplate: { conversationId: conflict.conversationId },
    });
    const moveReplay = await turn('Move it here.', manage, false, conflict.conversationId);
    expect(moveReplay.ledger[0]?.result).toMatchObject({
      status: 'moved',
      scheduleId: libraryRow.id,
      conversationId: conflict.conversationId,
    });
    expect(await schedules.getByName(agentId, libraryRow.name)).toEqual(movedRow);
    const afterMove = await turn('Which recurring digests are scheduled?', digestList);
    expect(afterMove.published).toContain(`/chat/${conflict.conversationId}`);
    expect(afterMove.published).not.toContain(`/chat/${first.conversationId}`);

    // Restrict the sweeps to this fixture while using the real adapter for commits.
    const libraryOnly = {
      ...schedules,
      listUninitialized: async () => [],
      listDue: async (now: Date) =>
        (await schedules.listDue(now, 200)).filter((row) => row.id === libraryRow.id),
      commitOccurrence: schedules.commitOccurrence.bind(schedules),
    };
    const staleTick = await runScheduleBatch(
      {
        ...libraryOnly,
        listDue: async () => [libraryRow],
      },
      timezone,
      { now: libraryRow.nextRunAt },
    );
    expect(staleTick).toEqual([]);
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
        conversationId: conflict.conversationId,
        trust: 'assistant',
        externalEventId: `schedule:${libraryRow.id}:${row.nextRunAt.toISOString()}`,
      });
      const outcome = await executeTask(
        { db, persistence, router: scriptedRouter({ name: 'web.fetch', input: {} }), dispatcher },
        taskId,
      );
      expect(outcome).toMatchObject({ outcome: 'done' });
      const saved = await chat.listMessages(agentId, conflict.conversationId, { limit: 50 });
      expect(
        saved?.messages.filter(
          (message) => message.taskId === taskId && message.text === scheduledReply,
        ),
      ).toHaveLength(1);
      const other = await chat.listMessages(agentId, first.conversationId, { limit: 50 });
      expect(other?.messages.some((message) => message.taskId === taskId)).toBe(false);
      const ledger = await persistence.executionEvidence.taskEvidence({ agentId, taskId });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        toolName: 'web.fetch',
        status: 'succeeded',
        result: { event },
      });
      occurrences.push({
        taskId,
        conversationId: task?.conversationId,
        posted: saved?.messages.find((message) => message.taskId === taskId)?.text,
        slot: row.nextRunAt,
        eventId: task?.externalEventId,
        outcome,
        ledger,
      });
    }
    const otherLibrary = await turn('Every Friday at 10 a.m., summarize library hours for me.', {
      name: 'digest.schedule',
      input: { ...library, topic: 'library hours', localTime: '10:00' },
    });
    expect(otherLibrary.outcome.outcome).toBe('done');
    const beforeCancel = await read();
    const ambiguousCancel = await turn('Cancel the library digest.', manage);
    const ambiguousDelete = await turn('Delete the library digest.', manage);
    for (const attempt of [ambiguousCancel, ambiguousDelete]) {
      expect(attempt.ledger[0]?.result).toMatchObject({ status: 'ambiguous' });
      expect(attempt.published).toContain('Which digest do you mean?');
    }
    expect(await read()).toEqual(beforeCancel);

    // Admit through the real single-owner entry point, then introduce an
    // inconsistent foreign record to exercise the worker's ownership checks.
    const foreignAttempts = [];
    for (const action of ['cancel', 'delete'] as const) {
      const differentOwner = randomUUID();
      const foreignName = `digest:foreign-${action}`;
      let foreignId: string | undefined;
      const seedForeign = async () => {
        if (firestore) {
          await firestore.doc('agents', differentOwner).set({
            id: differentOwner,
            name: 'Synthetic other owner',
            email: 'other@example.test',
            timezone,
            createdAt: fixedClock(),
            updatedAt: fixedClock(),
          });
        } else {
          await db.insert(agents).values({
            id: differentOwner,
            name: 'Synthetic other owner',
            email: 'other@example.test',
            workspacePrefix: 'synthetic-other',
            timezone,
          });
        }
        const foreign = await schedules.ensure({
          agentId: differentOwner,
          name: foreignName,
          cron: '0 9 * * 5',
          enabled: true,
          nextRunAt: libraryRow.nextRunAt,
          taskTemplate: {
            conversationId: randomUUID(),
            digest: { ...library, topic: 'botanical garden' },
          },
        });
        foreignId = foreign.id;
        return async () => {
          expect(
            await schedules.changeDigest({
              action,
              agentId,
              scheduleId: foreign.id,
              now: fixedClock(),
            }),
          ).toBeNull();
          expect(await schedules.getByName(differentOwner, foreignName)).toEqual(foreign);
          if (firestore) {
            await firestore.doc('schedules', foreign.id).delete();
            await firestore.doc('agents', differentOwner).delete();
          } else {
            await db.delete(postgresSchedules).where(eq(postgresSchedules.id, foreign.id));
            await db.delete(agents).where(eq(agents.id, differentOwner));
          }
        };
      };
      const verb = action === 'cancel' ? 'Cancel' : 'Delete';
      const attempt = await turn(
        `${verb} the botanical garden digest.`,
        manage,
        false,
        undefined,
        undefined,
        seedForeign,
      );
      if (!foreignId) throw new Error('Expected the foreign schedule fixture');
      expect(attempt.ledger[0]?.result).toEqual({ status: 'not_found' });
      expect(attempt.published).not.toContain(foreignId);
      foreignAttempts.push({ attempt, foreignId, differentOwner });
    }

    const preCancel = await schedules.getByName(agentId, libraryRow.name);
    if (!preCancel?.nextRunAt) throw new Error('Expected a future run before cancellation');
    const cancelled = await turn('Cancel the new library events digest.', manage, true);
    expect(cancelled.ledger[0]?.result).toMatchObject({
      status: 'cancelled',
      scheduleId: libraryRow.id,
      enabled: false,
      nextRunAt: null,
    });
    expect(cancelled.published).toContain('Cancelled the');
    expect(cancelled.replyCount).toBe(1);
    const cancelledRow = await schedules.getByName(agentId, libraryRow.name);
    expect(cancelledRow).toMatchObject({
      id: libraryRow.id,
      enabled: false,
      nextRunAt: null,
      taskTemplate: { digestLifecycle: 'cancelled' },
    });
    const afterCancel = await turn('Which recurring digests are scheduled?', digestList);
    expect(afterCancel.published).toContain('Cancelled the');
    expect(afterCancel.published).toContain(libraryRow.id);
    const cancelledTick = await runScheduleBatch(libraryOnly, timezone, {
      now: preCancel.nextRunAt,
    });
    expect(cancelledTick).toEqual([]);

    const deleted = await turn('Delete the new library events digest.', manage, true);
    expect(deleted.ledger[0]?.result).toMatchObject({
      status: 'deleted',
      scheduleId: libraryRow.id,
      enabled: false,
      nextRunAt: null,
    });
    expect(deleted.published).toContain('Deleted the');
    expect(deleted.replyCount).toBe(1);
    const deletedRow = await schedules.getByName(agentId, libraryRow.name);
    expect(deletedRow).toMatchObject({
      id: libraryRow.id,
      enabled: false,
      nextRunAt: null,
      taskTemplate: { digestLifecycle: 'deleted' },
    });
    const afterDelete = await turn('Which recurring digests are scheduled?', digestList);
    expect(afterDelete.published).not.toContain(libraryRow.id);
    expect(afterDelete.published).toContain('library hours');
    expect(afterDelete.published).toContain('Museum exhibits');
    const deletedTick = await runScheduleBatch(libraryOnly, timezone, { now: preCancel.nextRunAt });
    expect(deletedTick).toEqual([]);
    const deletedStaleTick = await runScheduleBatch(
      {
        ...libraryOnly,
        listDue: async () => [preCancel],
      },
      timezone,
      { now: preCancel.nextRunAt },
    );
    expect(deletedStaleTick).toEqual([]);
    expect(await schedules.setOwnerEnabled(agentId, libraryRow.id, true)).toBe(false);
    console.log(
      'F2_DIGEST_EVIDENCE',
      JSON.stringify({
        revision: process.env.F2_REVISION,
        store: persistence.driver,
        ambiguous,
        first,
        paraphrase,
        conflict,
        missingTopic,
        clarified,
        daily,
        fresh,
        denied,
        goal,
        stored,
        unavailable,
        moved,
        movedRow,
        moveReplay,
        afterMove,
        staleTick,
        occurrences,
        otherLibrary,
        ambiguousCancel,
        ambiguousDelete,
        foreignAttempts,
        cancelled,
        cancelledRow,
        afterCancel,
        cancelledTick,
        deleted,
        deletedRow,
        afterDelete,
        deletedTick,
        deletedStaleTick,
      }),
    );
  } finally {
    if (firestore) await disposeStore(firestore);
    if (pg) await pg.$client.end();
  }
}, 45_000);
