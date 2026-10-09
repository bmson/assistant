import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgent } from '@assistant/core';
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertGoalSessionDatabaseOwnership } from './goal-session-reconciliation.js';
import {
  GoalSessionEvidence,
  goalSessionTerminalState,
  readGoalSessionEvidence,
  verifyGoalSessionEvidence,
} from './goal-session-safety.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const targetToken = process.env.ASSISTANT_TEST_TARGET_TOKEN;
if (!databaseUrl || !targetToken) throw new Error('Run through the allocated pnpm test wrapper');
const databaseName = new URL(databaseUrl).pathname.slice(1);
const db = createDb(databaseUrl, { max: 4 });
let agentId: string;

const cutpoints = [
  'after_started_record',
  'after_target_record',
  'after_lock_acquired',
  'after_goal_intent',
  'after_goal_row',
  'after_goal_created_event',
  'after_conversation_intent',
  'after_conversation_row',
  'after_conversation_created_event',
  'after_schedule_row',
  'after_schedule_created_event',
  'after_task_row',
  'after_task_created_event',
  'after_usage_rows',
  'after_result_record',
] as const;

const cleanupCutpoints = [
  'before_cleanup_transaction',
  'after_cleanup_mutations_before_commit',
  'after_cleanup_commit_before_complete',
] as const;

type ChildOutcome = { code: number | null; signal: NodeJS.Signals | null; output: string };
type CapturedRun = ReturnType<typeof spawnCaptured>;
const CHILD_TIMEOUT_MS = 20_000;
const CHILD_CLOSE_TIMEOUT_MS = 5_000;
const CHILD_OUTPUT_LIMIT = 64 * 1024;
const PROCESS_GROUP_POLL_MS = 20;

function spawnCaptured(entry: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', entry, ...args], {
    cwd: process.cwd(),
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let outputTruncated = false;
  let spawnError: Error | undefined;
  let finalized = false;
  let finalizing: Promise<void> | undefined;
  const append = (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length > CHILD_OUTPUT_LIMIT) {
      output = output.slice(-CHILD_OUTPUT_LIMIT);
      outputTruncated = true;
    }
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
      resolve({ code: null, signal: null });
    });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const capturedOutput = () =>
    `${output}${outputTruncated ? '\n[output truncated to the last 65536 characters]' : ''}`;
  return {
    child,
    closed,
    output: capturedOutput,
    error: () => spawnError,
    finalized: () => finalized,
    finalizing: () => finalizing,
    setFinalizing: (value: Promise<void>) => (finalizing = value),
    markFinalized: () => (finalized = true),
  };
}

function processGroupExists(run: CapturedRun) {
  if (process.platform === 'win32' || !run.child.pid)
    return run.child.exitCode === null && run.child.signalCode === null;
  try {
    process.kill(-run.child.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      // On macOS, kill(0) may report EPERM for an exited zombie that still
      // appears in the process table. Treat the group as quiescent only after
      // ps confirms every remaining member is a zombie or already exited.
      const groupId = String(run.child.pid);
      const states = execFileSync('/bin/ps', ['-axo', 'pgid=,stat='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1_000,
      })
        .split('\n')
        .flatMap((line) => {
          const [candidateGroup, state] = line.trim().split(/\s+/, 2);
          return candidateGroup === groupId && state ? [state] : [];
        });
      if (states.length === 0) return false;
      if (states.every((state) => state.startsWith('Z') || state.startsWith('X'))) return false;
      return true;
    }
    throw error;
  }
}

async function waitForProcessGroupExit(run: CapturedRun) {
  const deadline = Date.now() + CHILD_CLOSE_TIMEOUT_MS;
  while (processGroupExists(run)) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for owned process group quiescence');
    await new Promise((resolve) => setTimeout(resolve, PROCESS_GROUP_POLL_MS));
  }
}

async function killChild(run: CapturedRun | null) {
  if (!run) return;
  if (run.finalized()) return;
  if (run.finalizing()) return run.finalizing();
  const finalizing = (async () => {
    let signalError: unknown;
    try {
      if (process.platform !== 'win32' && run.child.pid) process.kill(-run.child.pid, 'SIGKILL');
      else if (run.child.exitCode === null && run.child.signalCode === null)
        run.child.kill('SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') signalError = error;
    }
    let closeError: unknown;
    let groupQuiescent = false;
    let closeTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        run.closed,
        new Promise<never>((_, reject) => {
          closeTimeout = setTimeout(
            () => reject(new Error('Timed out waiting for child leader close')),
            CHILD_CLOSE_TIMEOUT_MS,
          );
        }),
      ]);
      await waitForProcessGroupExit(run);
      groupQuiescent = true;
    } catch (error) {
      closeError = error;
    } finally {
      if (closeTimeout) clearTimeout(closeTimeout);
    }
    // EPERM from signaling a group that now contains only exited/zombie
    // members is a macOS process-table artifact. It is safe to disregard only
    // after the explicit bounded quiescence check above succeeds.
    if (signalError && (signalError as NodeJS.ErrnoException).code === 'EPERM' && groupQuiescent)
      signalError = undefined;
    if (signalError && closeError)
      throw new AggregateError(
        [signalError, closeError],
        'Child termination and quiescence failed',
      );
    if (signalError) throw signalError;
    if (closeError) throw closeError;
    run.markFinalized();
  })();
  run.setFinalizing(finalizing);
  return finalizing;
}

async function awaitChild(run: CapturedRun, timeoutMs = CHILD_TIMEOUT_MS): Promise<ChildOutcome> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`Child exceeded ${timeoutMs}ms deadline`)),
        timeoutMs,
      );
    });
    const result = await Promise.race([run.closed, expired]);
    if (run.error()) throw run.error();
    const leakedGroup = processGroupExists(run);
    if (leakedGroup) {
      await killChild(run);
      throw new Error('Child leader closed while owned descendants remained');
    }
    run.markFinalized();
    return { ...result, output: run.output() };
  } catch (error) {
    let cleanupError: unknown;
    try {
      await killChild(run);
    } catch (failure) {
      cleanupError = failure;
    }
    const reason = error instanceof Error ? error.message : 'Child failed';
    if (cleanupError) throw new AggregateError([error, cleanupError], `${reason}\n${run.output()}`);
    throw new Error(`${reason}\n${run.output()}`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runFreshRecovery(evidenceParent: string, overrides: NodeJS.ProcessEnv = {}) {
  const entry = fileURLToPath(new URL('./reconcile-goal-session-orphans.ts', import.meta.url));
  const run = spawnCaptured(entry, [], {
    ...process.env,
    ...overrides,
    ASSISTANT_GOAL_SESSION_EVIDENCE_DIR: evidenceParent,
  });
  return await awaitChild(run, 30_000);
}

async function waitForStage(
  run: ReturnType<typeof spawnCaptured>,
  markerPath: string,
  expected: string,
) {
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (run.error()) {
      await killChild(run);
      throw new Error(`child failed before ${expected}: ${run.error()?.message}\n${run.output()}`);
    }
    let actual: string;
    try {
      actual = (await readFile(`${markerPath}.step`, 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await killChild(run);
        throw error;
      }
      if (run.child.exitCode !== null || run.child.signalCode !== null)
        throw new Error(`child exited before ${expected}; ${run.output()}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    if (actual === expected) return run.output();
    await killChild(run);
    throw new Error(`unexpected child stage ${actual}, wanted ${expected}; ${run.output()}`);
  }
  await killChild(run);
  throw new Error(`child did not reach ${expected} before deadline; ${run.output()}`);
}

function throwAfterCleanup(
  primaryFailure: unknown,
  primaryFailed: boolean,
  cleanupErrors: Error[],
  context: string,
) {
  if (primaryFailed && cleanupErrors.length)
    throw new AggregateError(
      [primaryFailure, ...cleanupErrors],
      `${context}: operation and cleanup failed`,
    );
  if (primaryFailed) throw primaryFailure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `${context} failed`);
}

async function removeFixtureRows(ids: {
  goalId: string;
  conversationId: string;
  scheduleId: string;
  taskId: string;
  unrelatedScheduleId: string;
}) {
  await db.delete(costEvents).where(eq(costEvents.taskId, ids.taskId));
  await db.delete(toolCalls).where(eq(toolCalls.taskId, ids.taskId));
  await db.delete(tasks).where(eq(tasks.id, ids.taskId));
  await db.delete(conversations).where(eq(conversations.id, ids.conversationId));
  await db.delete(schedules).where(eq(schedules.id, ids.scheduleId));
  await db.delete(goals).where(eq(goals.id, ids.goalId));
  await db.delete(schedules).where(eq(schedules.id, ids.unrelatedScheduleId));
}

describe('goal rehearsal crash-stage recovery matrix', () => {
  beforeAll(async () => {
    await assertGoalSessionDatabaseOwnership(db, { databaseName, token: targetToken });
    agentId = (await getAgent(db)).id;
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  it('refuses an ordinary database name in the shipped CLI before opening a connection', async () => {
    const evidenceParent = await mkdtemp(path.join(tmpdir(), 'goal-session-ordinary-refusal-'));
    const entry = fileURLToPath(new URL('./verify-goal-session.ts', import.meta.url));
    const ordinaryDatabaseUrl = 'postgres://assistant@127.0.0.1:1/assistant';
    const token = randomBytes(12).toString('hex');
    const run = spawnCaptured(entry, ['--metered-live'], {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: ordinaryDatabaseUrl,
      TEST_DATABASE_URL: ordinaryDatabaseUrl,
      ASSISTANT_TEST_TARGET_TOKEN: token,
      ASSISTANT_GOAL_SESSION_EVIDENCE_DIR: evidenceParent,
      ASSISTANT_ALLOW_METERED_GOAL_SESSION: '1',
    });
    let primaryFailure: unknown;
    let primaryFailed = false;
    const cleanupErrors: Error[] = [];
    try {
      const result = await awaitChild(run, 10_000);
      expect(result).toMatchObject({ code: 1, signal: null });
      expect(result.output).toContain(
        'Database name does not match the allocated test target token',
      );
      expect(result.output).not.toMatch(/ECONNREFUSED|connect ETIMEDOUT/);
      expect(result.output).not.toContain(ordinaryDatabaseUrl);
    } catch (error) {
      primaryFailed = true;
      primaryFailure = error;
    } finally {
      try {
        await killChild(run);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
      if (!primaryFailed && cleanupErrors.length === 0) {
        try {
          await rm(evidenceParent, { recursive: true, force: true });
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      if (primaryFailed || cleanupErrors.length > 0)
        console.error(`Preserved ordinary target refusal evidence at ${evidenceParent}`);
    }
    throwAfterCleanup(primaryFailure, primaryFailed, cleanupErrors, 'Ordinary target refusal');
  }, 15_000);

  it('skips an empty first-stage directory and a validated no-effects plan terminal', async () => {
    const emptyParent = await mkdtemp(path.join(tmpdir(), 'goal-session-empty-stage-'));
    const emptyRunId = randomUUID();
    const emptyDirectory = path.join(emptyParent, `goal-session-${emptyRunId}`);
    await mkdir(emptyDirectory, { mode: 0o700 });
    const planParent = await mkdtemp(path.join(tmpdir(), 'goal-session-plan-terminal-'));
    let planDirectory: string | undefined;
    let planChecksPassed = false;
    try {
      const planEntry = fileURLToPath(new URL('./verify-goal-session.ts', import.meta.url));
      const planRun = spawnCaptured(planEntry, ['--plan'], {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        TEST_DATABASE_URL: databaseUrl,
        ASSISTANT_TEST_TARGET_TOKEN: targetToken,
        ASSISTANT_GOAL_SESSION_EVIDENCE_DIR: planParent,
        ASSISTANT_GOAL_SESSION_TOOL_ALLOWLIST: 'weather.lookup',
      });
      const planned = await awaitChild(planRun, 15_000);
      expect(planned.code, planned.output).toBe(0);
      expect(planned.output).toContain('safe goal rehearsal plan');
      const evidenceMatch = /evidence (.+)/.exec(planned.output);
      expect(evidenceMatch?.[1]).toBeTruthy();
      planDirectory = evidenceMatch?.[1];
      if (!planDirectory) throw new Error('Plan command did not print its evidence directory');
      const planRunId = path.basename(planDirectory).replace('goal-session-', '');
      const planEvents = await readGoalSessionEvidence(planDirectory, planRunId);
      expect(planEvents?.map((entry) => entry.event)).toEqual([
        'rehearsal_plan',
        'rehearsal_plan_validated',
        'rehearsal_plan_complete',
      ]);
      const empty = await runFreshRecovery(emptyParent);
      const completedPlan = await runFreshRecovery(planParent);
      expect(empty.code, empty.output).toBe(0);
      expect(empty.output).toContain('scanned 0; cleaned 0; skipped 1; failed 0');
      expect(completedPlan.code, completedPlan.output).toBe(0);
      expect(completedPlan.output).toContain('scanned 0; cleaned 0; skipped 1; failed 0');
      expect(await verifyGoalSessionEvidence(planDirectory)).toBe(true);
      expect((await readdir(planDirectory)).filter((name) => name.endsWith('.json'))).toHaveLength(
        3,
      );
      planChecksPassed = true;
    } finally {
      if (planChecksPassed) {
        await rm(emptyParent, { recursive: true, force: true });
        await rm(planParent, { recursive: true, force: true });
      } else console.error(`Preserved failed plan evidence at ${emptyParent} and ${planParent}`);
    }
  }, 30_000);

  it('recovers a killed partial pending write but rejects a partial numbered record', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'goal-session-pending-write-'));
    const runId = randomUUID();
    const evidence = await GoalSessionEvidence.create(parent, runId);
    let pendingChecksPassed = false;
    try {
      await evidence.record({ event: 'rehearsal_started', runId, databaseName, targetToken });
      await evidence.record({ event: 'rehearsal_target', runId, databaseName, targetToken });
      await evidence.record({
        event: 'goal_fixture_planned',
        runId,
        goalId: randomUUID(),
        conversationId: randomUUID(),
        agentId,
      });
      const pendingMarker = path.join(parent, 'pending-write-stage');
      const pendingChild = fileURLToPath(
        new URL('./goal-session-pending-write-child.ts', import.meta.url),
      );
      const pendingRun = spawnCaptured(
        pendingChild,
        [runId, evidence.directory, pendingMarker],
        process.env,
      );
      await waitForStage(pendingRun, pendingMarker, 'pending_record_partially_written');
      await killChild(pendingRun);
      expect((await readdir(evidence.directory)).some((name) => name.startsWith('.pending-'))).toBe(
        true,
      );
      expect(await verifyGoalSessionEvidence(evidence.directory)).toBe(true);
      const recovery = await runFreshRecovery(parent);
      expect(recovery.code, recovery.output).toBe(0);
      expect(recovery.output).toContain('scanned 1; cleaned 1; skipped 0; failed 0');
      expect((await readdir(evidence.directory)).some((name) => name.startsWith('.pending-'))).toBe(
        false,
      );
      expect(await verifyGoalSessionEvidence(evidence.directory)).toBe(true);
      pendingChecksPassed = true;
    } finally {
      if (pendingChecksPassed) await rm(parent, { recursive: true, force: true });
      else console.error(`Preserved failed pending-write evidence at ${parent}`);
    }

    const firstPendingParent = await mkdtemp(path.join(tmpdir(), 'goal-session-first-pending-'));
    const firstPendingRunId = randomUUID();
    const firstPendingMarker = path.join(firstPendingParent, 'first-pending-stage');
    let firstPendingChecksPassed = false;
    try {
      const firstPendingChild = fileURLToPath(
        new URL('./goal-session-pending-write-child.ts', import.meta.url),
      );
      const firstPendingRun = spawnCaptured(
        firstPendingChild,
        [firstPendingRunId, firstPendingParent, firstPendingMarker, 'first'],
        process.env,
      );
      await waitForStage(firstPendingRun, firstPendingMarker, 'pending_record_partially_written');
      await killChild(firstPendingRun);
      const firstDirectory = path.join(firstPendingParent, `goal-session-${firstPendingRunId}`);
      expect(await readGoalSessionEvidence(firstDirectory, firstPendingRunId)).toEqual([]);
      const recovery = await runFreshRecovery(firstPendingParent, {
        DATABASE_URL: '',
        TEST_DATABASE_URL: '',
        ASSISTANT_TEST_TARGET_TOKEN: '',
      });
      expect(recovery.code, recovery.output).toBe(0);
      expect(recovery.output).toContain('scanned 0; cleaned 0; skipped 1; failed 0');
      expect((await readdir(firstDirectory)).filter((name) => name.endsWith('.json'))).toEqual([]);
      expect((await readdir(firstDirectory)).some((name) => name.startsWith('.pending-'))).toBe(
        true,
      );
      firstPendingChecksPassed = true;
    } finally {
      if (firstPendingChecksPassed) await rm(firstPendingParent, { recursive: true, force: true });
      else console.error(`Preserved first-record pending evidence at ${firstPendingParent}`);
    }

    const malformedParent = await mkdtemp(path.join(tmpdir(), 'goal-session-numbered-write-'));
    const malformedRunId = randomUUID();
    const malformed = await GoalSessionEvidence.create(malformedParent, malformedRunId);
    let malformedChecksPassed = false;
    try {
      await malformed.record({
        event: 'rehearsal_started',
        runId: malformedRunId,
        databaseName,
        targetToken,
      });
      await writeFile(path.join(malformed.directory, '000002.json'), '{"event":', { mode: 0o600 });
      expect(await verifyGoalSessionEvidence(malformed.directory)).toBe(false);
      const recovery = await runFreshRecovery(malformedParent);
      expect(recovery.code).toBe(1);
      expect(recovery.output).toContain('failed 1');
      expect((await readdir(malformed.directory)).some((name) => name === '000002.json')).toBe(
        true,
      );
      malformedChecksPassed = true;
    } finally {
      if (malformedChecksPassed) await rm(malformedParent, { recursive: true, force: true });
      else console.error(`Preserved failed numbered-write evidence at ${malformedParent}`);
    }
  }, 30_000);

  it('serializes concurrent append calls and fails closed on cross-instance sequence collisions', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'goal-session-concurrent-ledger-'));
    const runId = randomUUID();
    let checksPassed = false;
    try {
      const ledger = await GoalSessionEvidence.create(parent, runId);
      const written = await Promise.all(
        Array.from({ length: 24 }, (_, index) =>
          ledger.record({ event: 'concurrent_append', runId, index }),
        ),
      );
      expect(written.map((file) => path.basename(file))).toEqual(
        Array.from({ length: 24 }, (_, index) => `${String(index + 1).padStart(6, '0')}.json`),
      );
      const directory = path.join(parent, `goal-session-${runId}`);
      const events = await readGoalSessionEvidence(directory, runId);
      expect(events).toHaveLength(24);
      expect(events?.map((entry) => entry.sequence)).toEqual(
        Array.from({ length: 24 }, (_, index) => index + 1),
      );

      const left = await GoalSessionEvidence.open(directory, runId);
      const right = await GoalSessionEvidence.open(directory, runId);
      const raced = await Promise.allSettled([
        left.record({ event: 'cross_instance', runId, side: 'left' }),
        right.record({ event: 'cross_instance', runId, side: 'right' }),
      ]);
      expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(raced.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const afterRace = await readGoalSessionEvidence(directory, runId);
      expect(afterRace).toHaveLength(25);
      expect(await verifyGoalSessionEvidence(directory)).toBe(true);
      checksPassed = true;
    } finally {
      if (checksPassed) await rm(parent, { recursive: true, force: true });
      else console.error(`Preserved concurrent ledger evidence at ${parent}`);
    }
  });

  it('terminates an owned descendant when the child leader exits early', async () => {
    const marker = path.join(
      await mkdtemp(path.join(tmpdir(), 'goal-session-descendant-')),
      'ready',
    );
    const entry = fileURLToPath(new URL('./goal-session-descendant-child.ts', import.meta.url));
    const run = spawnCaptured(entry, [marker], process.env);
    let checksPassed = false;
    try {
      await expect(awaitChild(run, 10_000)).rejects.toThrow('owned descendants remained');
      expect((await readFile(marker, 'utf8')).trim()).toBe('spawned');
      expect(run.finalized()).toBe(true);
      checksPassed = true;
    } finally {
      await killChild(run);
      if (checksPassed) await rm(path.dirname(marker), { recursive: true, force: true });
      else console.error(`Preserved process-group evidence at ${path.dirname(marker)}`);
    }
  });

  it('rejects malformed no-effects terminals and never lets fixture intent hide behind one', async () => {
    for (const fixtureIntent of [false, true]) {
      const parent = await mkdtemp(path.join(tmpdir(), 'goal-session-invalid-terminal-'));
      const runId = randomUUID();
      const evidence = await GoalSessionEvidence.create(parent, runId);
      let checksPassed = false;
      try {
        await evidence.record({ event: 'rehearsal_started', runId, databaseName, targetToken });
        if (fixtureIntent)
          await evidence.record({
            event: 'goal_fixture_planned',
            runId,
            goalId: randomUUID(),
            agentId,
          });
        await evidence.record({
          event: 'rehearsal_no_effects_complete',
          runId,
          // The no-intent case is malformed because it claims effects started
          // without any fixture evidence; the intent case is malformed because
          // a no-effects terminal follows a durable fixture intent.
          effectsStarted: !fixtureIntent,
          cleanupReason: fixtureIntent
            ? 'terminal follows fixture intent'
            : 'effects-started claim has no effect evidence',
        });
        const events = await readGoalSessionEvidence(evidence.directory, runId);
        expect(events).not.toBeNull();
        expect(goalSessionTerminalState(events ?? [])).toBe('invalid');
        const recovery = await runFreshRecovery(parent);
        expect(recovery.code).toBe(1);
        expect(recovery.output).toContain('failed 1');
        expect(await verifyGoalSessionEvidence(evidence.directory)).toBe(true);
        checksPassed = true;
      } finally {
        if (checksPassed) await rm(parent, { recursive: true, force: true });
        else console.error(`Preserved invalid terminal evidence at ${parent}`);
      }
    }
    const planParent = await mkdtemp(path.join(tmpdir(), 'goal-session-invalid-plan-terminal-'));
    const planRunId = randomUUID();
    const planEvidence = await GoalSessionEvidence.create(planParent, planRunId);
    let planChecksPassed = false;
    try {
      await planEvidence.record({
        event: 'rehearsal_plan',
        runId: planRunId,
        databaseName,
        targetToken,
      });
      await planEvidence.record({
        event: 'rehearsal_plan_complete',
        runId: planRunId,
        effectsStarted: false,
        validated: true,
      });
      const recovery = await runFreshRecovery(planParent);
      expect(recovery.code).toBe(1);
      expect(recovery.output).toContain('failed 1');
      planChecksPassed = true;
    } finally {
      if (planChecksPassed) await rm(planParent, { recursive: true, force: true });
      else console.error(`Preserved invalid plan terminal evidence at ${planParent}`);
    }

    const laterIntentParent = await mkdtemp(
      path.join(tmpdir(), 'goal-session-later-intent-terminal-'),
    );
    const laterIntentRunId = randomUUID();
    const laterIntentEvidence = await GoalSessionEvidence.create(
      laterIntentParent,
      laterIntentRunId,
    );
    let laterIntentChecksPassed = false;
    try {
      await laterIntentEvidence.record({
        event: 'rehearsal_started',
        runId: laterIntentRunId,
        databaseName,
        targetToken,
      });
      await laterIntentEvidence.record({
        event: 'rehearsal_target',
        runId: laterIntentRunId,
        databaseName,
        targetToken,
      });
      await laterIntentEvidence.record({
        event: 'rehearsal_no_effects_complete',
        runId: laterIntentRunId,
        effectsStarted: false,
        cleanupReason: 'no fixtures existed at terminal time',
      });
      await laterIntentEvidence.record({
        event: 'goal_fixture_planned',
        runId: laterIntentRunId,
        goalId: randomUUID(),
        agentId,
      });
      const laterIntentEvents = await readGoalSessionEvidence(
        laterIntentEvidence.directory,
        laterIntentRunId,
      );
      expect(laterIntentEvents).not.toBeNull();
      expect(goalSessionTerminalState(laterIntentEvents ?? [])).toBe('invalid');
      const recovery = await runFreshRecovery(laterIntentParent);
      expect(recovery.code).toBe(1);
      expect(recovery.output).toContain('failed 1');
      expect(await verifyGoalSessionEvidence(laterIntentEvidence.directory)).toBe(true);
      laterIntentChecksPassed = true;
    } finally {
      if (laterIntentChecksPassed) await rm(laterIntentParent, { recursive: true, force: true });
      else console.error(`Preserved later-intent terminal evidence at ${laterIntentParent}`);
    }
  }, 60_000);

  it('recovers cleanup crashes before transaction, before commit, and after commit', async () => {
    for (const stage of cleanupCutpoints) {
      const parent = await mkdtemp(path.join(tmpdir(), 'goal-session-cleanup-cutpoint-'));
      const runId = randomUUID();
      const goalId = randomUUID();
      const conversationId = randomUUID();
      const scheduleId = randomUUID();
      const taskId = randomUUID();
      const unrelatedScheduleId = randomUUID();
      const markerPath = path.join(parent, 'fixture-stage');
      const evidence = await GoalSessionEvidence.create(parent, runId);
      const ids = { goalId, conversationId, scheduleId, taskId, unrelatedScheduleId };
      let keepEvidence = false;
      let primaryFailure: unknown;
      let primaryFailed = false;
      const cleanupErrors: Error[] = [];
      try {
        await db.insert(schedules).values({
          id: unrelatedScheduleId,
          agentId,
          name: `cleanup-unrelated-${randomUUID()}`,
          cron: '0 8 * * *',
          taskTemplate: { type: 'scheduled', label: 'untouched' },
          enabled: true,
          nextRunAt: new Date('2020-01-01T00:00:00Z'),
        });
        await evidence.record({ event: 'rehearsal_started', runId, databaseName, targetToken });
        const fixtureChild = fileURLToPath(
          new URL('./goal-session-cutpoint-fixture-child.ts', import.meta.url),
        );
        const fixtureRun = spawnCaptured(
          fixtureChild,
          [
            agentId,
            runId,
            goalId,
            conversationId,
            scheduleId,
            taskId,
            markerPath,
            evidence.directory,
            'after_result_record',
          ],
          process.env,
        );
        await waitForStage(fixtureRun, markerPath, 'after_result_record');
        await killChild(fixtureRun);

        const cleanupMarker = path.join(parent, 'cleanup-stage');
        const cleanupChild = fileURLToPath(
          new URL('./goal-session-cleanup-cutpoint-child.ts', import.meta.url),
        );
        const cleanupRun = spawnCaptured(
          cleanupChild,
          [runId, evidence.directory, cleanupMarker, stage],
          process.env,
        );
        await waitForStage(cleanupRun, cleanupMarker, stage);
        await killChild(cleanupRun);

        const [goalBeforeResume] = await db.select().from(goals).where(eq(goals.id, goalId));
        const [conversationBeforeResume] = await db
          .select()
          .from(conversations)
          .where(eq(conversations.id, conversationId));
        const [scheduleBeforeResume] = await db
          .select()
          .from(schedules)
          .where(eq(schedules.id, scheduleId));
        const [taskBeforeResume] = await db.select().from(tasks).where(eq(tasks.id, taskId));
        if (stage === 'after_cleanup_commit_before_complete') {
          expect(goalBeforeResume).toBeUndefined();
          expect(conversationBeforeResume).toBeUndefined();
          expect(scheduleBeforeResume).toBeUndefined();
          expect(taskBeforeResume).toBeUndefined();
        } else {
          expect(goalBeforeResume).toBeDefined();
          expect(conversationBeforeResume).toBeDefined();
          expect(scheduleBeforeResume).toBeDefined();
          expect(taskBeforeResume).toBeDefined();
        }
        const recovery = await runFreshRecovery(parent);
        expect(recovery.code, recovery.output).toBe(0);
        expect(recovery.output).toContain('scanned 1; cleaned 1; skipped 0; failed 0');
        const [goal] = await db.select().from(goals).where(eq(goals.id, goalId));
        const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
        const [unrelated] = await db
          .select()
          .from(schedules)
          .where(eq(schedules.id, unrelatedScheduleId));
        const [conversation] = await db
          .select()
          .from(conversations)
          .where(eq(conversations.id, conversationId));
        const [schedule] = await db.select().from(schedules).where(eq(schedules.id, scheduleId));
        expect(goal).toBeUndefined();
        expect(conversation).toBeUndefined();
        expect(schedule).toBeUndefined();
        expect(task).toBeUndefined();
        expect(unrelated).toBeDefined();
        const ledgerFiles = (await readdir(evidence.directory))
          .filter((name) => name.endsWith('.json'))
          .sort();
        const ledger = await Promise.all(
          ledgerFiles.map(async (name) =>
            JSON.parse(await readFile(path.join(evidence.directory, name), 'utf8')),
          ),
        );
        const retained = ledger.find((entry) => entry.event === 'usage_ledger_retained');
        expect(retained).toMatchObject({
          tasks: [{ id: taskId, status: 'done', spentUsd: '0.012000' }],
          costEvents: [
            { source: 'model', usd: '0.012000', evidence: { provider: 'synthetic-test-provider' } },
          ],
          effectReceipts: [{ step: 1, toolName: 'search.read_only', status: 'succeeded' }],
        });
        expect(JSON.stringify(retained)).not.toContain('must-not-be-copied-to-retained-evidence');
        expect(await verifyGoalSessionEvidence(evidence.directory)).toBe(true);
        keepEvidence = true;
      } catch (error) {
        primaryFailed = true;
        primaryFailure = error;
      } finally {
        try {
          await removeFixtureRows(ids);
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
        if (keepEvidence && cleanupErrors.length === 0) {
          try {
            await rm(parent, { recursive: true, force: true });
          } catch (error) {
            cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
          }
        }
        if (!keepEvidence || cleanupErrors.length > 0)
          console.error(`Preserved failed cleanup evidence at ${parent}`);
      }
      throwAfterCleanup(primaryFailure, primaryFailed, cleanupErrors, 'Cleanup cutpoint fixture');
    }
  }, 90_000);

  it('recovers or safely skips every fixture-stage interruption in a fresh process', async () => {
    for (const stage of cutpoints) {
      const parent = await mkdtemp(path.join(tmpdir(), 'goal-session-cutpoint-'));
      const runId = randomUUID();
      const goalId = randomUUID();
      const conversationId = randomUUID();
      const scheduleId = randomUUID();
      const taskId = randomUUID();
      const unrelatedScheduleId = randomUUID();
      const unrelatedName = `cutpoint-unrelated-${randomUUID()}`;
      const markerPath = path.join(parent, 'stage');
      const evidence = await GoalSessionEvidence.create(parent, runId);
      let child: CapturedRun | null = null;
      let recoveryFinished = false;
      let testPassed = false;
      let primaryFailure: unknown;
      let primaryFailed = false;
      const cleanupErrors: Error[] = [];
      const ids = { goalId, conversationId, scheduleId, taskId, unrelatedScheduleId };
      try {
        await db.insert(schedules).values({
          id: unrelatedScheduleId,
          agentId,
          name: unrelatedName,
          cron: '0 8 * * *',
          taskTemplate: { type: 'scheduled', label: 'must remain untouched' },
          enabled: true,
          nextRunAt: new Date('2020-01-01T00:00:00Z'),
        });
        await evidence.record({ event: 'rehearsal_started', runId, databaseName, targetToken });
        const childPath = fileURLToPath(
          new URL('./goal-session-cutpoint-fixture-child.ts', import.meta.url),
        );
        const run = spawnCaptured(
          childPath,
          [
            agentId,
            runId,
            goalId,
            conversationId,
            scheduleId,
            taskId,
            markerPath,
            evidence.directory,
            stage,
          ],
          process.env,
        );
        child = run;
        const output = await waitForStage(run, markerPath, stage);
        await killChild(child);

        const recovery = await runFreshRecovery(parent);
        expect(recovery.code, recovery.output).toBe(0);
        if (
          stage === 'after_started_record' ||
          stage === 'after_target_record' ||
          stage === 'after_lock_acquired'
        )
          expect(recovery.output).toContain('scanned 0; cleaned 0; skipped 1; failed 0');
        else expect(recovery.output).toContain('scanned 1; cleaned 1; skipped 0; failed 0');
        recoveryFinished = true;

        const [goal] = await db.select().from(goals).where(eq(goals.id, goalId));
        const [conversation] = await db
          .select()
          .from(conversations)
          .where(eq(conversations.id, conversationId));
        const [schedule] = await db.select().from(schedules).where(eq(schedules.id, scheduleId));
        const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
        const [unrelated] = await db
          .select()
          .from(schedules)
          .where(eq(schedules.id, unrelatedScheduleId));
        expect(goal).toBeUndefined();
        expect(conversation).toBeUndefined();
        expect(schedule).toBeUndefined();
        expect(task).toBeUndefined();
        expect(unrelated?.name).toBe(unrelatedName);

        const ledgerFiles = (await readdir(evidence.directory))
          .filter((name) => name.endsWith('.json'))
          .sort();
        const ledger = await Promise.all(
          ledgerFiles.map(async (name) =>
            JSON.parse(await readFile(path.join(evidence.directory, name), 'utf8')),
          ),
        );
        const terminalPublished = ledger.some((entry) =>
          ['fixture_cleanup_complete', 'rehearsal_no_effects_complete'].includes(entry.event),
        );
        if (
          stage === 'after_started_record' ||
          stage === 'after_target_record' ||
          stage === 'after_lock_acquired'
        ) {
          // No fixture intent exists yet, so recovery must skip without
          // inventing cleanup authority or publishing a terminal receipt.
          expect(terminalPublished).toBe(false);
          expect(ledger.map((entry) => entry.event)).toEqual(
            stage === 'after_started_record'
              ? ['rehearsal_started']
              : ['rehearsal_started', 'rehearsal_target'],
          );
        } else {
          expect(terminalPublished).toBe(true);
        }
        if (cutpoints.indexOf(stage) >= cutpoints.indexOf('after_goal_intent')) {
          const retained = ledger.find((entry) => entry.event === 'usage_ledger_retained');
          expect(retained).toBeDefined();
          expect(JSON.stringify(retained)).not.toContain('must-not-be-copied-to-retained-evidence');
        }
        if (stage === 'after_usage_rows' || stage === 'after_result_record') {
          const retained = ledger.find((entry) => entry.event === 'usage_ledger_retained');
          expect(retained).toMatchObject({
            tasks: [{ id: taskId, status: 'done', spentUsd: '0.012000' }],
            costEvents: [
              {
                source: 'model',
                usd: '0.012000',
                evidence: { provider: 'synthetic-test-provider' },
              },
            ],
            effectReceipts: [{ step: 1, toolName: 'search.read_only', status: 'succeeded' }],
          });
        }
        expect(output).not.toContain('privateFixturePayload');
        testPassed = true;
      } catch (error) {
        primaryFailed = true;
        primaryFailure = error;
      } finally {
        try {
          await killChild(child);
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
        if (!recoveryFinished) {
          try {
            const retry = await runFreshRecovery(parent);
            if (retry.code !== 0)
              cleanupErrors.push(new Error(`Recovery cleanup failed: ${retry.output}`));
          } catch (error) {
            cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
          }
        }
        try {
          await removeFixtureRows(ids);
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
        if (testPassed && recoveryFinished && cleanupErrors.length === 0) {
          try {
            await rm(parent, { recursive: true, force: true });
          } catch (error) {
            cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
          }
        }
        if (!testPassed || !recoveryFinished || cleanupErrors.length > 0)
          console.error(`Preserved failed OPS-09 evidence for review at ${parent}`);
      }
      throwAfterCleanup(primaryFailure, primaryFailed, cleanupErrors, 'OPS-09 child cleanup');
    }
  }, 180_000);
});
