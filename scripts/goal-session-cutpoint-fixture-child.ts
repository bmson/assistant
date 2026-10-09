import { randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { goalScheduleName } from '@assistant/core';
import {
  conversations,
  costEvents,
  createDb,
  goals,
  schedules,
  tasks,
  toolCalls,
} from '@assistant/db';
import {
  assertGoalSessionDatabaseOwnership,
  tryAcquireGoalSessionLock,
} from './goal-session-reconciliation.js';
import { GoalSessionEvidence } from './goal-session-safety.js';

const [
  agentId,
  runId,
  goalId,
  conversationId,
  scheduleId,
  taskId,
  markerPath,
  evidenceDirectory,
  stopAfter,
] = process.argv.slice(2);
if (
  ![
    agentId,
    runId,
    goalId,
    conversationId,
    scheduleId,
    taskId,
    markerPath,
    evidenceDirectory,
    stopAfter,
  ].every(Boolean)
)
  throw new Error('Missing cutpoint fixture identity');
const databaseUrl = process.env.DATABASE_URL;
const token = process.env.ASSISTANT_TEST_TARGET_TOKEN;
if (!databaseUrl || !token) throw new Error('Allocated test database identity is required');
const databaseName = new URL(databaseUrl).pathname.slice(1);
const db = createDb(databaseUrl, { max: 2 });
const evidence = await GoalSessionEvidence.open(evidenceDirectory as string, runId as string);
const pauseAt = async (stage: string) => {
  if (stage !== stopAfter) return;
  const marker = `${markerPath}.step`;
  const pendingMarker = `${marker}.${process.pid}.pending`;
  await writeFile(pendingMarker, `${stage}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(pendingMarker, marker);
  await new Promise<never>(() => {});
};
await assertGoalSessionDatabaseOwnership(db, { databaseName, token });
await pauseAt('after_started_record');
await evidence.record({ event: 'rehearsal_target', runId, databaseName, targetToken: token });
await pauseAt('after_target_record');
const lock = await tryAcquireGoalSessionLock(db, runId as string);
if (!lock) throw new Error('Could not acquire fixture rehearsal lock');
await pauseAt('after_lock_acquired');

await evidence.record({ event: 'goal_fixture_planned', runId, goalId, conversationId, agentId });
await pauseAt('after_goal_intent');
await db.insert(goals).values({
  id: goalId as string,
  agentId: agentId as string,
  title: `Verify goal session ${runId}`,
  description: 'synthetic stage fixture',
  progress: '',
  nextAction: '',
});
await pauseAt('after_goal_row');
await evidence.record({ event: 'goal_fixture_created', runId, goalId });
await pauseAt('after_goal_created_event');

await evidence.record({ event: 'conversation_fixture_planned', runId, conversationId });
await pauseAt('after_conversation_intent');
await db.insert(conversations).values({
  id: conversationId as string,
  agentId: agentId as string,
  channel: 'chat',
  trust: 'owner',
  title: `Work: Verify goal session ${(runId as string).slice(0, 8)}`,
  metadata: { goalId, rehearsalId: runId },
});
await pauseAt('after_conversation_row');
await evidence.record({ event: 'conversation_fixture_created', runId, conversationId });
await pauseAt('after_conversation_created_event');

await db.insert(schedules).values({
  id: scheduleId as string,
  agentId: agentId as string,
  name: goalScheduleName(goalId as string),
  cron: '0 9 * * *',
  taskTemplate: { type: 'scheduled', goalId, conversationId },
  enabled: true,
  nextRunAt: new Date('2020-01-01T00:00:00Z'),
});
await pauseAt('after_schedule_row');
await evidence.record({ event: 'schedule_fixture_created', runId, scheduleId, goalId });
await pauseAt('after_schedule_created_event');

await db.insert(tasks).values({
  id: taskId as string,
  agentId: agentId as string,
  type: 'scheduled',
  status: 'done',
  conversationId: conversationId as string,
  goalId: goalId as string,
  spentUsd: '0.012000',
  progress: 'Synthetic completed fixture',
});
await pauseAt('after_task_row');
await evidence.record({ event: 'task_fixture_created', runId, taskId, scheduleId, goalId });
await pauseAt('after_task_created_event');

await db.insert(costEvents).values({
  source: 'model',
  evidence: {
    basis: 'token_rate',
    provider: 'synthetic-test-provider',
    model: 'synthetic-test-model',
    modelUsage: { inputTokens: 12, outputTokens: 7, accounting: 'usage-rate-estimate' },
  },
  taskId: taskId as string,
  quantity: '19',
  unit: 'tokens',
  unitPriceUsd: '0.00063158',
  usd: '0.012000',
  description: 'synthetic fixture cost evidence',
});
await db.insert(toolCalls).values({
  id: randomUUID(),
  taskId: taskId as string,
  step: 1,
  toolName: 'search.read_only',
  risk: 'autonomous',
  status: 'succeeded',
  args: { privateFixturePayload: 'must-not-be-copied-to-retained-evidence' },
  result: { privateFixtureResult: 'must-not-be-copied-to-retained-evidence' },
});
await pauseAt('after_usage_rows');
await evidence.record({ event: 'rehearsal_result', runId, taskId, outcomeKind: 'completed' });
await pauseAt('after_result_record');
// Every matrix invocation should stop at a requested marker. Keep an unexpected
// stage mismatch visible to the parent instead of exiting as a false success.
throw new Error(`Requested cutpoint ${stopAfter} was not reached`);
