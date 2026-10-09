import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { type ExecutorDeps, goalScheduleName } from '@assistant/core';
import {
  conversations,
  costEvents,
  createDb,
  goals,
  schedules,
  tasks,
  toolCalls,
} from '@assistant/db';
import { eq } from 'drizzle-orm';
import {
  assertGoalSessionDatabaseOwnership,
  tryAcquireGoalSessionLock,
} from './goal-session-reconciliation.js';
import { allowlistedGoalSessionDispatcher } from './goal-session-safety.js';

const [agentId, runId, goalId, conversationId, scheduleId, taskId, markerPath] =
  process.argv.slice(2);
if (![agentId, runId, goalId, conversationId, scheduleId, taskId, markerPath].every(Boolean))
  throw new Error('Missing fixture identity');
const databaseUrl = process.env.DATABASE_URL;
const targetToken = process.env.ASSISTANT_TEST_TARGET_TOKEN;
if (!databaseUrl || !targetToken) throw new Error('Allocated test database identity is required');
// One connection is reserved for the session advisory lock while the pool
// performs fixture writes.
const db = createDb(databaseUrl, { max: 2 });
const mark = async (step: string) =>
  writeFile(`${markerPath}.step`, `${step}\n`, { encoding: 'utf8', mode: 0o600 });
await assertGoalSessionDatabaseOwnership(db, {
  databaseName: new URL(databaseUrl).pathname.slice(1),
  token: targetToken,
});
await mark('owned');
const runLock = await tryAcquireGoalSessionLock(db, runId as string);
if (!runLock) throw new Error('Could not acquire the rehearsal run lock');
await mark('locked');

await db.insert(goals).values({
  id: goalId as string,
  agentId: agentId as string,
  title: `Verify goal session ${runId}`,
  description: 'synthetic fixture used only to test crash recovery',
  progress: '',
  nextAction: '',
});
await mark('goal');
await db.insert(conversations).values({
  id: conversationId as string,
  agentId: agentId as string,
  channel: 'chat',
  trust: 'owner',
  title: `Work: Verify goal session ${(runId as string).slice(0, 8)}`,
  metadata: { goalId, rehearsalId: runId },
});
await db.insert(schedules).values({
  id: scheduleId as string,
  agentId: agentId as string,
  name: goalScheduleName(goalId as string),
  cron: '0 9 * * *',
  taskTemplate: { type: 'scheduled', goalId, conversationId },
  enabled: true,
  nextRunAt: new Date('2020-01-01T00:00:00Z'),
});
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
const [task] = await db
  .select()
  .from(tasks)
  .where(eq(tasks.id, taskId as string));
if (!task) throw new Error('Synthetic rehearsal task was not created');
const fakeModel = async () => ({ toolName: 'search.read_only' });
const fakeDispatcher: ExecutorDeps['dispatcher'] = {
  toolDefs: () => [],
  resultIsUntrusted: () => false,
  dispatch: async () => ({
    kind: 'executed',
    toolCallId: randomUUID(),
    result: { privateFixtureResult: 'must-not-be-copied-to-retained-evidence' },
    cached: false,
  }),
  executeApproved: async () => ({ kind: 'failed', error: 'approval disabled in fixture' }),
};
const rehearsalDispatcher = allowlistedGoalSessionDispatcher(
  fakeDispatcher,
  new Set(['search.read_only']),
);
const plannedCall = await fakeModel();
const dispatchResult = await rehearsalDispatcher.dispatch({
  task,
  step: 1,
  modelToolCallId: randomUUID(),
  toolName: plannedCall.toolName,
  args: { privateFixturePayload: 'must-not-be-copied-to-retained-evidence' },
  ctx: {
    taskId: task.id,
    agentId: task.agentId,
    conversationId: task.conversationId ?? undefined,
    trust: 'owner',
    tainted: false,
    db,
    now: () => new Date(),
    signal: new AbortController().signal,
    log: async () => {},
  },
  provenance: { plannerVersion: 1, promptVersion: 1, model: 'synthetic-test-model' },
});
if (dispatchResult.kind !== 'executed') throw new Error('Safe synthetic tool was not dispatched');
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
  id: dispatchResult.toolCallId,
  taskId: taskId as string,
  step: 1,
  toolName: 'search.read_only',
  risk: 'autonomous',
  status: 'succeeded',
  args: { privateFixturePayload: 'must-not-be-copied-to-retained-evidence' },
  result: dispatchResult.result,
});
await writeFile(markerPath as string, 'committed\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
// Hold the process with committed fixture rows until the parent test sends SIGKILL.
await new Promise<never>(() => {});
