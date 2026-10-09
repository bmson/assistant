/** Metered rehearsal of one disposable goal session. Every tool must be explicitly allowlisted. */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import {
  ensureGoalAutomation,
  executeTask,
  getAgent,
  prepareGoalSession,
  runScheduleBatch,
} from '@assistant/core';
import {
  conversations,
  costEvents,
  costReservations,
  createDb,
  createPostgresGoalRuntimeRepository,
  createPostgresScheduleRepository,
  createPostgresTaskRepository,
  goals,
  modelCalls,
  schedules,
  tasks,
  toolCalls,
} from '@assistant/db';
import { and, asc, eq, lte } from 'drizzle-orm';
import { buildDeps } from '../apps/agent/src/deps.js';
import { executorDeps } from '../apps/agent/src/executor-deps.js';
import {
  assertGoalSessionDatabaseOwnership,
  reconcileGoalSessionOrphans,
  reconcileGoalSessionRun,
  tryAcquireGoalSessionLock,
} from './goal-session-reconciliation.js';
import {
  allowlistedGoalSessionDispatcher,
  GoalSessionEvidence,
  goalSessionMode,
  goalSessionToolAllowlist,
  scopedGoalScheduleRepository,
} from './goal-session-safety.js';
import { assertAllocatedTestTarget } from './test-target.js';

const mode = goalSessionMode(
  process.argv.slice(2),
  process.env.ASSISTANT_ALLOW_METERED_GOAL_SESSION,
);
if (process.env.NODE_ENV === 'production')
  throw new Error('Refusing a goal rehearsal in production');
const evidenceParent = process.env.ASSISTANT_GOAL_SESSION_EVIDENCE_DIR;
if (!evidenceParent)
  throw new Error('Set ASSISTANT_GOAL_SESSION_EVIDENCE_DIR to retain rehearsal evidence');

const config = loadConfig();
const targetKind = process.env.ASSISTANT_TEST_TARGET_KIND === 'restore' ? 'restore' : 'standard';
const databaseName = assertAllocatedTestTarget({
  databaseUrl: config.DATABASE_URL,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  kind: targetKind,
});
const targetToken = process.env.ASSISTANT_TEST_TARGET_TOKEN;
if (!targetToken) throw new Error('Goal rehearsal requires an allocated target token');
const targetDb = createDb(config.DATABASE_URL, { max: 2 });
try {
  await assertGoalSessionDatabaseOwnership(targetDb, { databaseName, token: targetToken });
} catch (error) {
  await targetDb.$client.end({ timeout: 5 });
  throw error;
}

if (mode === 'reconcile-orphans') {
  try {
    const result = await reconcileGoalSessionOrphans({
      db: targetDb,
      evidenceParent,
      target: { databaseName, token: targetToken },
    });
    console.log(
      `goal rehearsal recovery scanned ${result.scanned}; cleaned ${result.cleaned}; skipped ${result.skipped}`,
    );
  } finally {
    await targetDb.$client.end({ timeout: 5 });
  }
} else {
  if (mode === 'metered-live') {
    try {
      await reconcileGoalSessionOrphans({
        db: targetDb,
        evidenceParent,
        target: { databaseName, token: targetToken },
      });
    } finally {
      await targetDb.$client.end({ timeout: 5 });
    }
  } else {
    await targetDb.$client.end({ timeout: 5 });
  }

  const runId = randomUUID();
  const evidence = await GoalSessionEvidence.create(evidenceParent, runId);
  await evidence.record({
    event: mode === 'plan' ? 'rehearsal_plan' : 'rehearsal_started',
    runId,
    createdAt: new Date().toISOString(),
    databaseName,
    targetToken,
    cleanupStatus: mode === 'plan' ? 'not_started' : 'required',
  });

  if (mode === 'plan') {
    const rawAllowlist = process.env.ASSISTANT_GOAL_SESSION_TOOL_ALLOWLIST;
    if (!rawAllowlist?.trim())
      throw new Error('Set ASSISTANT_GOAL_SESSION_TOOL_ALLOWLIST explicitly');
    const names = rawAllowlist.split(',').map((name) => name.trim());
    if (names.some((name) => !name) || new Set(names).size !== names.length)
      throw new Error('Goal-session tool allowlist contains an empty or duplicate name');
    await evidence.record({
      event: 'rehearsal_plan_validated',
      runId,
      databaseTargetValidated: true,
      namedToolAllowlist: names,
      fixturesWouldBeScoped: true,
      meteredCallsWillRun: false,
    });
    await evidence.record({
      event: 'rehearsal_plan_complete',
      runId,
      effectsStarted: false,
      validated: true,
    });
    console.log(`safe goal rehearsal plan ${runId}\nevidence ${evidence.directory}`);
  } else {
    await evidence.record({ event: 'rehearsal_target', runId, databaseName, targetToken });
    const description =
      process.argv.slice(2).find((arg) => !arg.startsWith('--')) ??
      'Help me find a new job. I am a senior staff frontend engineer. I want applied-AI or frontend/UI/product roles at AI companies, remote or San Francisco, minimum $250K total comp.';
    const goalId = randomUUID();
    const conversationId = randomUUID();
    let scheduleId: string | null = null;
    let taskId: string | null = null;
    let deps: ReturnType<typeof buildDeps> | null = null;
    let runLockDb: ReturnType<typeof createDb> | null = null;
    let runLock: Awaited<ReturnType<typeof tryAcquireGoalSessionLock>> = null;
    let originalError: unknown;

    try {
      runLockDb = createDb(config.DATABASE_URL, { max: 1, idleTimeoutSeconds: 0 });
      runLock = await tryAcquireGoalSessionLock(runLockDb, runId);
      if (!runLock) throw new Error('Could not acquire the goal rehearsal ownership lock');
      deps = buildDeps();
      const db = deps.db;
      const toolAllowlist = goalSessionToolAllowlist(
        process.env.ASSISTANT_GOAL_SESSION_TOOL_ALLOWLIST,
        deps.registry.all(),
      );
      const agent = await getAgent(db);

      await evidence.record({
        event: 'goal_fixture_planned',
        runId,
        goalId,
        conversationId,
        agentId: agent.id,
      });
      const [goal] = await db
        .insert(goals)
        .values({
          id: goalId,
          agentId: agent.id,
          title: `Verify goal session ${runId}`,
          description,
          progress: '',
          nextAction: '',
        })
        .returning({ id: goals.id });
      if (!goal) throw new Error('failed to create verification goal');
      await evidence.record({ event: 'goal_fixture_created', runId, goalId });

      await evidence.record({ event: 'conversation_fixture_planned', runId, conversationId });
      const [conversation] = await db
        .insert(conversations)
        .values({
          id: conversationId,
          agentId: agent.id,
          channel: 'chat',
          trust: 'owner',
          title: `Work: Verify goal session ${runId.slice(0, 8)}`,
          metadata: { goalId, rehearsalId: runId },
        })
        .returning({ id: conversations.id });
      if (!conversation) throw new Error('failed to create verification work chat');
      await evidence.record({ event: 'conversation_fixture_created', runId, conversationId });

      const [goalRow] = await db.select().from(goals).where(eq(goals.id, goalId));
      if (!goalRow) throw new Error('verification goal disappeared');
      const schedule = await ensureGoalAutomation(db, agent, goalRow);
      if (!schedule) throw new Error('goal automation was not created');
      scheduleId = schedule.id;
      await evidence.record({ event: 'schedule_fixture_created', runId, scheduleId, goalId });
      const scheduledFor = new Date(Date.now() - 1000);
      await db
        .update(schedules)
        .set({ nextRunAt: scheduledFor })
        .where(and(eq(schedules.id, scheduleId), eq(schedules.agentId, agent.id)));

      const baseRepository = createPostgresScheduleRepository(db);
      const scopedRepository = scopedGoalScheduleRepository(
        baseRepository,
        { agentId: agent.id, scheduleId },
        async (now) => {
          const [row] = await db
            .select()
            .from(schedules)
            .where(
              and(
                eq(schedules.id, scheduleId as string),
                eq(schedules.agentId, agent.id),
                eq(schedules.enabled, true),
                lte(schedules.nextRunAt, now),
              ),
            )
            .limit(1);
          return row ?? null;
        },
      );
      // This rehearsal cannot initialize or fire any other schedule and does not
      // enqueue a background wake; it executes only the exact created goal task.
      const fired = await runScheduleBatch(scopedRepository, agent.timezone, {
        now: new Date(),
        batch: 1,
        prepareGoal: (row, template) =>
          prepareGoalSession(
            {
              goals: createPostgresGoalRuntimeRepository(db),
              tasks: createPostgresTaskRepository(db),
            },
            row.agentId,
            template,
          ),
      });
      const target = fired.find((entry) => entry.schedule === schedule.name);
      if (!target) throw new Error('the selected goal schedule did not create a work session');
      taskId = target.taskId;
      await evidence.record({ event: 'task_fixture_created', runId, taskId, scheduleId, goalId });

      const execution = executorDeps(deps);
      execution.dispatcher = allowlistedGoalSessionDispatcher(execution.dispatcher, toolAllowlist);
      const outcome = await executeTask(execution, taskId);

      const calls = await db
        .select({ toolName: toolCalls.toolName, status: toolCalls.status })
        .from(toolCalls)
        .where(eq(toolCalls.taskId, taskId))
        .orderBy(asc(toolCalls.step));
      const models = await db
        .select({
          role: modelCalls.role,
          model: modelCalls.model,
          inputTokens: modelCalls.inputTokens,
          outputTokens: modelCalls.outputTokens,
          costUsd: modelCalls.costUsd,
          finishReason: modelCalls.finishReason,
        })
        .from(modelCalls)
        .where(eq(modelCalls.taskId, taskId))
        .orderBy(asc(modelCalls.createdAt));
      const events = await db
        .select({
          source: costEvents.source,
          evidence: costEvents.evidence,
          usd: costEvents.usd,
          quantity: costEvents.quantity,
          unit: costEvents.unit,
          unitPriceUsd: costEvents.unitPriceUsd,
          reservationId: costEvents.reservationId,
        })
        .from(costEvents)
        .where(eq(costEvents.taskId, taskId));
      const reservations = await db
        .select({
          source: costReservations.source,
          estimatedUsd: costReservations.estimatedUsd,
          actualUsd: costReservations.actualUsd,
          status: costReservations.status,
          attemptMetadata: costReservations.attemptMetadata,
          unknownReason: costReservations.unknownReason,
        })
        .from(costReservations)
        .where(eq(costReservations.taskId, taskId));
      const [finished] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      const [finalGoal] = await db.select().from(goals).where(eq(goals.id, goalId));
      const usageLedger = {
        rehearsal: true,
        taskId,
        finalTaskStatus: finished?.status ?? 'missing',
        taskSpentUsd: finished?.spentUsd ?? null,
        calls,
        modelAttempts: models,
        costEvents: events.map((event) => ({
          ...event,
          evidence: {
            basis: event.evidence.basis,
            provider: event.evidence.provider,
            model: event.evidence.model,
            modelUsage: event.evidence.modelUsage,
          },
        })),
        reservations,
      };
      await evidence.record({
        event: 'rehearsal_result',
        runId,
        taskId,
        outcomeKind: typeof outcome === 'string' ? outcome : 'completed',
        goalProgressPresent: Boolean(finalGoal?.progress?.trim()),
        usageLedger,
      });
      console.log(
        `rehearsal ${runId}\ngoal ${goalId}\ntask ${taskId}\nstatus ${finished?.status ?? 'missing'}`,
      );
      console.log(
        `tool calls ${calls.length}; model calls ${models.length}; accounted cost ${finished?.spentUsd ?? 'unknown'}`,
      );
      console.log(`evidence ${evidence.directory}`);
    } catch (error) {
      originalError = error;
      await evidence.record({
        event: 'rehearsal_failed',
        runId,
        taskId,
        errorCategory: error instanceof Error ? error.name : 'unknown',
      });
      throw error;
    } finally {
      if (deps) {
        const db = deps.db;
        try {
          const result = await reconcileGoalSessionRun({
            db,
            directory: evidence.directory,
            runId,
            target: { databaseName, token: targetToken },
            lockAlreadyHeld: true,
          });
          if (result === 'not-owned-target') {
            await evidence.record({
              event: 'fixture_cleanup_failed',
              runId,
              goalId,
              conversationId,
              scheduleId,
              taskId,
              errorCategory: 'target_mismatch',
            });
            if (!originalError) {
              process.exitCode = 1;
              console.error(
                'goal rehearsal cleanup target mismatch; see private evidence manifest',
              );
            }
          }
        } catch (cleanupError) {
          await evidence.record({
            event: 'fixture_cleanup_failed',
            runId,
            goalId,
            conversationId,
            scheduleId,
            taskId,
            errorCategory: cleanupError instanceof Error ? cleanupError.name : 'unknown',
          });
          if (!originalError) {
            process.exitCode = 1;
            console.error('goal rehearsal fixture cleanup failed; see private evidence manifest');
          }
        } finally {
          await db.$client.end();
        }
      }
      try {
        await runLock?.release();
      } finally {
        if (runLockDb) await runLockDb.$client.end({ timeout: 5 });
      }
    }
  }
}
