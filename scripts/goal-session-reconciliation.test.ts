import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgent } from '@assistant/core';
import { conversations, costEvents, createDb, goals, schedules, tasks } from '@assistant/db';
import { allocateTestTarget, testTargetMarkerPath } from '@assistant/db/test-target';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertGoalSessionDatabaseOwnership,
  reconcileGoalSessionRun,
} from './goal-session-reconciliation.js';
import { GoalSessionEvidence } from './goal-session-safety.js';
import { recoverGoalSessionTargetFromMarker } from './goal-session-target.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const targetToken = process.env.ASSISTANT_TEST_TARGET_TOKEN;
if (!databaseUrl || !targetToken) throw new Error('Run through the allocated pnpm test wrapper');
const databaseName = new URL(databaseUrl).pathname.slice(1);
const db = createDb(databaseUrl, { max: 4 });
let agentId: string;

async function runFreshRecovery(evidenceParent: string) {
  const entry = fileURLToPath(new URL('./reconcile-goal-session-orphans.ts', import.meta.url));
  return await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', entry], {
      cwd: process.cwd(),
      env: { ...process.env, ASSISTANT_GOAL_SESSION_EVIDENCE_DIR: evidenceParent },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
}

describe('goal rehearsal orphan recovery', () => {
  beforeAll(async () => {
    await assertGoalSessionDatabaseOwnership(db, { databaseName, token: targetToken });
    agentId = (await getAgent(db)).id;
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  it('reconciles a SIGKILLed rehearsal from its journal and preserves unrelated due schedules', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'goal-session-reconcile-'));
    const runId = randomUUID();
    const goalId = randomUUID();
    const conversationId = randomUUID();
    const scheduleId = randomUUID();
    const taskId = randomUUID();
    const markerPath = path.join(parent, 'child-committed');
    const evidence = await GoalSessionEvidence.create(parent, runId);
    const target = { databaseName, token: targetToken };
    const unrelatedScheduleId = randomUUID();
    const unrelatedName = `rehearsal-unrelated-${randomUUID()}`;
    await db.insert(schedules).values({
      id: unrelatedScheduleId,
      agentId,
      name: unrelatedName,
      cron: '0 8 * * *',
      taskTemplate: { type: 'scheduled', label: 'must remain untouched' },
      enabled: true,
      nextRunAt: new Date('2020-01-01T00:00:00Z'),
    });
    await evidence.record({
      event: 'rehearsal_target',
      runId,
      databaseName,
      targetToken,
    });
    await evidence.record({ event: 'goal_fixture_planned', runId, agentId, goalId });
    await evidence.record({ event: 'conversation_fixture_planned', runId, conversationId });
    await evidence.record({ event: 'schedule_fixture_planned', runId, scheduleId, goalId });
    await evidence.record({ event: 'task_fixture_planned', runId, taskId, goalId });

    const childPath = fileURLToPath(
      new URL('./goal-session-orphan-fixture-child.ts', import.meta.url),
    );
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx/esm',
        childPath,
        agentId,
        runId,
        goalId,
        conversationId,
        scheduleId,
        taskId,
        markerPath,
      ],
      { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let childOutput = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      childOutput += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      childOutput += chunk.toString();
    });
    try {
      let committed = false;
      for (let attempt = 0; attempt < 1500; attempt += 1) {
        try {
          await access(markerPath);
          committed = true;
          break;
        } catch {
          if (child.exitCode !== null) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      let childStep = 'no marker';
      try {
        childStep = await readFile(`${markerPath}.step`, 'utf8');
      } catch {}
      expect(committed, `${childOutput}; last child step: ${childStep}`).toBe(true);
      await expect(
        reconcileGoalSessionRun({ db, directory: evidence.directory, runId, target }),
      ).resolves.toBe('active-run');
      const whileActive = await runFreshRecovery(parent);
      expect(whileActive.code, whileActive.output).toBe(0);
      expect(whileActive.output).toContain('scanned 1; cleaned 0; skipped 1; failed 0');
      const [stillActive] = await db
        .select({ id: schedules.id })
        .from(schedules)
        .where(eq(schedules.id, scheduleId));
      expect(stillActive?.id).toBe(scheduleId);
      child.kill('SIGKILL');
      await new Promise<void>((resolve, reject) => {
        child.once('close', (code, signal) => {
          if (signal === 'SIGKILL') resolve();
          else reject(new Error(`fixture child exited unexpectedly (${code}, ${signal})`));
        });
      });

      // A valid-looking journal bound to another allocated target cannot remove rows.
      await expect(
        reconcileGoalSessionRun({
          db,
          directory: evidence.directory,
          runId,
          target: { databaseName, token: 'f'.repeat(24) },
        }),
      ).resolves.toBe('not-owned-target');
      await expect(
        assertGoalSessionDatabaseOwnership(db, { databaseName, token: 'f'.repeat(24) }),
      ).rejects.toThrow('allocator ownership marker');
      const [before] = await db
        .select({ id: schedules.id })
        .from(schedules)
        .where(eq(schedules.id, scheduleId));
      expect(before?.id).toBe(scheduleId);

      const recovery = await runFreshRecovery(parent);
      expect(recovery.code, recovery.output).toBe(0);
      expect(recovery.output).toContain('scanned 1; cleaned 1; skipped 0; failed 0');
      const repeatedRecovery = await runFreshRecovery(parent);
      expect(repeatedRecovery.code, repeatedRecovery.output).toBe(0);
      expect(repeatedRecovery.output).toContain('scanned 0; cleaned 0; skipped 1; failed 0');
      const [goal] = await db.select().from(goals).where(eq(goals.id, goalId));
      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      const [schedule] = await db.select().from(schedules).where(eq(schedules.id, scheduleId));
      const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      const costRows = await db.select().from(costEvents).where(eq(costEvents.taskId, taskId));
      const [unrelatedSchedule] = await db
        .select()
        .from(schedules)
        .where(eq(schedules.id, unrelatedScheduleId));
      expect(goal).toBeUndefined();
      expect(conversation).toBeUndefined();
      expect(schedule).toBeUndefined();
      expect(task).toBeUndefined();
      expect(costRows).toEqual([]);
      expect(unrelatedSchedule?.name).toBe(unrelatedName);
      const events = (await readdir(evidence.directory))
        .filter((name) => name.endsWith('.json'))
        .sort();
      const usageRows = await Promise.all(
        events.map(async (name) =>
          JSON.parse(await readFile(path.join(evidence.directory, name), 'utf8')),
        ),
      );
      expect(usageRows.find((entry) => entry.event === 'usage_ledger_retained')).toMatchObject({
        tasks: [{ id: taskId, status: 'done', spentUsd: '0.012000' }],
        costEvents: [
          {
            source: 'model',
            usd: '0.012000',
            evidence: { basis: 'token_rate', provider: 'synthetic-test-provider' },
          },
        ],
        effectReceipts: [
          {
            step: 1,
            toolName: 'search.read_only',
            status: 'succeeded',
            approvalPending: false,
          },
        ],
      });
      expect(JSON.stringify(usageRows)).not.toContain('must-not-be-copied-to-retained-evidence');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await db.delete(schedules).where(eq(schedules.id, unrelatedScheduleId));
      await rm(parent, { recursive: true, force: true });
    }
  }, 30_000);

  it('recovers only the target recorded by a private allocator marker', async () => {
    const evidenceParent = await mkdtemp(path.join(tmpdir(), 'goal-session-marker-'));
    const runId = randomUUID();
    const token = randomUUID().replaceAll('-', '').slice(0, 24);
    const markerPath = testTargetMarkerPath(token);
    const target = allocateTestTarget('postgres://assistant@127.0.0.1:55432/postgres', token);
    const evidence = await GoalSessionEvidence.create(evidenceParent, runId);
    await evidence.record({
      event: 'rehearsal_target',
      runId,
      targetToken: token,
      databaseName: target.databaseName,
    });
    try {
      await writeFile(markerPath, JSON.stringify({ databaseUrl: target.databaseUrl, token }), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await expect(recoverGoalSessionTargetFromMarker({ evidenceParent, runId })).resolves.toEqual({
        databaseUrl: target.databaseUrl,
        databaseName: target.databaseName,
        token,
        kind: 'standard',
      });

      await writeFile(
        markerPath,
        JSON.stringify({
          databaseUrl: `postgres://assistant@127.0.0.1:55432/${'assistant_test_arbitrary'}`,
          token,
        }),
      );
      await expect(recoverGoalSessionTargetFromMarker({ evidenceParent, runId })).rejects.toThrow(
        'allocator marker',
      );

      await writeFile(
        markerPath,
        JSON.stringify({
          databaseUrl: 'postgres://assistant@remote.example/assistant_test',
          token,
        }),
      );
      await expect(recoverGoalSessionTargetFromMarker({ evidenceParent, runId })).rejects.toThrow(
        'allocator marker',
      );
    } finally {
      await rm(markerPath, { force: true });
      await rm(evidenceParent, { recursive: true, force: true });
    }
  });
});
