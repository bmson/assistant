import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  agents,
  approvals,
  assertPostgresRestoreRehearsalReadOnly,
  createDb,
  memoryTombstones,
  schedules,
  tasks,
  toolCalls,
} from '@assistant/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertAllocatedTestTarget } from '../../../packages/db/src/test-target.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const isRestoreTarget = process.env.ASSISTANT_TEST_TARGET_KIND === 'restore';
const runId = databaseUrl
  ? new URL(databaseUrl).pathname.match(/^\/assistant_restore_([a-f0-9]{12})_test$/)?.[1]
  : undefined;
const targetToken = process.env.ASSISTANT_TEST_TARGET_TOKEN;
const roleName = runId ? `assistant_restore_reader_${runId}` : '';
const workspacePath = runId ? `/tmp/assistant_restore_${runId}_files` : '';

async function unusedLoopbackPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a test port');
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    setTimeout(resolve, 4_000).unref();
  });
}

describe.skipIf(!databaseUrl || !isRestoreTarget || !runId || !targetToken)(
  'PostgreSQL restore rehearsal process',
  () => {
    let db: ReturnType<typeof createDb> | undefined;
    let readerUrl = '';
    let readerPassword = '';
    let child: ChildProcess | undefined;
    let output = '';
    let ownsWorkspacePath = false;
    let effectCountsBefore: Record<string, unknown> | undefined;
    const dueTaskId = randomUUID();
    const approvalTaskId = randomUUID();
    const toolCallId = randomUUID();
    const approvalId = randomUUID();
    const reminderScheduleId = randomUUID();
    const tombstoneHash = createHash('sha256')
      .update('fixture text permanently removed before restore')
      .digest('hex');

    beforeAll(async () => {
      if (!databaseUrl || !runId || !targetToken)
        throw new Error('Use pnpm test --restore-target to allocate this restore fixture');
      const databaseName = assertAllocatedTestTarget({
        databaseUrl,
        testDatabaseUrl: process.env.TEST_DATABASE_URL,
        token: targetToken,
        kind: 'restore',
      });
      if (databaseName !== `assistant_restore_${runId}_test`)
        throw new Error('Restore target run identity did not match its allocator token');

      db = createDb(databaseUrl, { max: 1 });
      const owners = await db.select({ id: agents.id }).from(agents).limit(2);
      if (owners.length !== 1 || !owners[0])
        throw new Error('Restore rehearsal fixture requires one seeded owner');
      const agentId = owners[0].id;
      const now = new Date();
      const past = new Date(now.getTime() - 10 * 60_000);

      await db.insert(tasks).values({
        id: dueTaskId,
        agentId,
        type: 'scheduled',
        status: 'pending',
        title: 'restore due-task fixture',
        trigger: { kind: 'restore-rehearsal-fixture' },
        runAfter: past,
        trust: 'owner',
      });
      await db.insert(tasks).values({
        id: approvalTaskId,
        agentId,
        type: 'adhoc',
        status: 'waiting_approval',
        title: 'restore approval fixture',
        trigger: { kind: 'restore-rehearsal-fixture' },
        trust: 'owner',
      });
      await db.insert(toolCalls).values({
        id: toolCallId,
        taskId: approvalTaskId,
        step: 1,
        toolName: 'gmail.send',
        args: { to: 'restore-fixture@example.test' },
        risk: 'approval',
        status: 'awaiting_approval',
      });
      await db.insert(approvals).values({
        id: approvalId,
        taskId: approvalTaskId,
        toolCallId,
        shortCode: `R${randomBytes(4).toString('hex').slice(0, 6)}`,
        summary: 'restore rehearsal pending approval fixture',
        status: 'pending',
        requestedAt: past,
        expiresAt: past,
      });
      await db.insert(schedules).values({
        id: reminderScheduleId,
        agentId,
        name: `restore-reminder-${runId}`,
        cron: '* * * * *',
        enabled: true,
        nextRunAt: past,
        taskTemplate: {
          type: 'scheduled',
          trigger: { kind: 'reminder' },
          reminderKind: 'once',
          reminderText: 'restore-only due reminder fixture',
        },
      });
      await db.insert(memoryTombstones).values({
        contentHash: tombstoneHash,
        reason: 'owner_forget',
      });

      readerPassword = randomBytes(24).toString('hex');
      const adminUrl = new URL(databaseUrl);
      adminUrl.pathname = '/postgres';
      const admin = createDb(adminUrl.toString(), { max: 1 });
      try {
        await admin.$client.begin(async (transaction) => {
          await transaction.unsafe(
            `CREATE ROLE "${roleName}" LOGIN PASSWORD '${readerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
          );
          await transaction.unsafe(
            `COMMENT ON ROLE "${roleName}" IS 'assistant-test-target:${targetToken}'`,
          );
          await transaction.unsafe(
            `ALTER ROLE "${roleName}" SET default_transaction_read_only = 'on'`,
          );
          await transaction.unsafe(`GRANT CONNECT ON DATABASE "${databaseName}" TO "${roleName}"`);
        });
      } finally {
        await admin.$client.end({ timeout: 5 });
      }

      await db.$client.unsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await db.$client.unsafe(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
      await db.$client.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${roleName}"`);
      const target = new URL(databaseUrl);
      target.username = roleName;
      target.password = readerPassword;
      readerUrl = target.toString();
      await mkdir(workspacePath, { recursive: false, mode: 0o700 });
      ownsWorkspacePath = true;
      const effects = await db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM notification_outbox) AS notification_rows,
          (SELECT count(*)::int FROM model_calls) AS model_call_rows,
          (SELECT count(*)::int FROM model_call_audit) AS model_audit_rows
      `);
      effectCountsBefore = effects[0] as Record<string, unknown>;
    }, 30_000);

    afterAll(async () => {
      await stop(child);
      await db?.$client.end({ timeout: 5 });
      db = undefined;
      if (ownsWorkspacePath) await rm(workspacePath, { recursive: true, force: true });
      output = '';
    });

    it('keeps restored due tasks, reminders, approvals, tombstones and effect ledgers unchanged', async () => {
      if (!db || !runId) throw new Error('Restore rehearsal fixture was not initialized');
      const port = await unusedLoopbackPort();
      const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
      const credentials = [
        'OPENROUTER_API_KEY',
        'AUTH_GOOGLE_SECRET',
        'GOOGLE_OAUTH_CLIENT_SECRET',
        'BOT_GOOGLE_REFRESH_TOKEN',
        'TWILIO_ACCOUNT_SID',
        'TWILIO_AUTH_TOKEN',
        'TWILIO_FROM_NUMBER',
        'MOBILE_API_TOKEN',
        'INTERNAL_API_SECRET',
        'LOCATION_PING_SECRET',
        'GOOGLE_APPLICATION_CREDENTIALS',
        'VERTEX_PROJECT',
        'GCP_PROJECT',
        'GCLOUD_PROJECT',
        'AGENT_URL',
        'WEB_URL',
        'PUBLIC_URL',
        'GMAIL_PUBSUB_TOPIC',
      ];
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: readerUrl,
        TEST_DATABASE_URL: '',
        PERSISTENCE_DRIVER: 'postgres',
        QUEUE_DRIVER: 'inert',
        RESTORE_REHEARSAL: 'true',
        RESTORE_REHEARSAL_ROOT: workspacePath,
        ASSISTANT_WORKSPACE_ID: `restore-${runId}`,
        POSTGRES_SOURCE_WRITES_FENCED: 'true',
        FILES_DRIVER: 'local',
        BROWSER_DRIVER: 'local',
        CODE_DRIVER: 'local',
        PROCESSOR_DRIVER: 'local',
        ASSISTANT_MODULES: 'minimal',
        OTEL_EXPORTER: 'none',
        AUTH_DEV_BYPASS: 'false',
        AUTH_LOCALHOST_BYPASS: 'false',
        METADATA_SERVER_DETECTION: 'none',
        AGENT_PORT: String(port),
        PORT: String(port),
      };
      for (const key of credentials) childEnv[key] = '';

      child = spawn(process.execPath, ['--import', 'tsx', entry], {
        cwd: process.cwd(),
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (data) => {
        output += String(data);
      });
      child.stderr?.on('data', (data) => {
        output += String(data);
      });

      let ready: Response | null = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (child.exitCode !== null)
          throw new Error(`restore agent exited before ready: ${output}`);
        ready = await fetch(`http://127.0.0.1:${port}/ready`).catch(() => null);
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(ready?.status, output).toBe(200);
      expect(await ready?.json()).toMatchObject({ ready: true, database: 'postgres' });
      expect(output).toContain('restore rehearsal background dispatch is disabled');
      expect(output).toContain('agent service listening');
      expect(output).not.toContain('local queue poller started');
      expect(output).not.toContain(readerPassword);
      expect(output).not.toContain('External network access is disabled');

      const deniedRequest = await fetch(`http://127.0.0.1:${port}/internal/tasks/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: dueTaskId }),
      });
      expect(deniedRequest.status).toBe(503);
      expect(await deniedRequest.json()).toEqual({
        error: 'runtime endpoint disabled during restore rehearsal',
      });
      const deniedCallback = await fetch(`http://127.0.0.1:${port}/webhooks/gmail`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'restore callback fixture' }),
      });
      expect(deniedCallback.status).toBe(503);

      const readonlyDb = createDb(readerUrl, { max: 1, readOnly: true });
      try {
        await assertPostgresRestoreRehearsalReadOnly(readonlyDb);
        const readOnlySetting = await readonlyDb.execute(
          sql`SELECT current_setting('default_transaction_read_only') AS value`,
        );
        expect(readOnlySetting[0]?.value).toBe('on');
        await expect(
          readonlyDb.execute(sql`UPDATE tasks SET status = 'done' WHERE id = ${dueTaskId}`),
        ).rejects.toThrow();
      } finally {
        await readonlyDb.$client.end({ timeout: 5 });
      }

      const after = await db.execute(sql`
        SELECT
          (SELECT status FROM tasks WHERE id = ${dueTaskId}) AS due_task_status,
          (SELECT status FROM tasks WHERE id = ${approvalTaskId}) AS approval_task_status,
          (SELECT status FROM approvals WHERE id = ${approvalId}) AS approval_status,
          (SELECT enabled AND next_run_at <= now() FROM schedules WHERE id = ${reminderScheduleId}) AS reminder_still_due,
          (SELECT count(*)::int FROM memory_tombstones WHERE content_hash = ${tombstoneHash}) AS tombstone_count,
          (SELECT count(*)::int FROM notification_outbox) AS notification_rows,
          (SELECT count(*)::int FROM model_calls) AS model_call_rows,
          (SELECT count(*)::int FROM model_call_audit) AS model_audit_rows
      `);
      if (!effectCountsBefore) throw new Error('Restore side-effect baseline was not captured');
      expect(after[0]).toMatchObject({
        due_task_status: 'pending',
        approval_task_status: 'waiting_approval',
        approval_status: 'pending',
        reminder_still_due: true,
        tombstone_count: 1,
      });
      expect(after[0]).toMatchObject(effectCountsBefore);
      expect(output).not.toContain('agent exited');
    }, 35_000);
  },
);
