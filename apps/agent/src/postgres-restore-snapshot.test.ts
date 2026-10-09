import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agents,
  approvals,
  assertPostgresRestoreRehearsalReadOnly,
  createDb,
  memoryTombstones,
  notificationOutbox,
  schedules,
  tasks,
  toolCalls,
} from '@assistant/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertAllocatedTestDatabaseOwnership,
  assertAllocatedTestTargetMarker,
} from '../../../scripts/test-target.js';

const sourceUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const sourceToken = process.env.ASSISTANT_TEST_TARGET_TOKEN;
const targetUrl = process.env.ASSISTANT_RESTORE_TARGET_DATABASE_URL;
const targetToken = process.env.ASSISTANT_RESTORE_TARGET_TOKEN;
const sourceRunId = sourceUrl
  ? new URL(sourceUrl).pathname.match(/^\/assistant_restore_([a-f0-9]{12})_test$/)?.[1]
  : undefined;
const targetRunId = targetUrl
  ? new URL(targetUrl).pathname.match(/^\/assistant_restore_([a-f0-9]{12})_test$/)?.[1]
  : undefined;
const sourceWorkspace = sourceRunId
  ? join(tmpdir(), `assistant_restore_${sourceRunId}_source_files`)
  : undefined;
const targetWorkspace = targetRunId
  ? join(tmpdir(), `assistant_restore_${targetRunId}_files`)
  : undefined;
const enabled = Boolean(
  sourceUrl && sourceToken && targetUrl && targetToken && sourceRunId && targetRunId,
);
type Fixture = {
  agentId: string;
  taskId: string;
  approvalTaskId: string;
  toolCallId: string;
  approvalId: string;
  outboxId: string;
  scheduleId: string;
  tombstoneHash: string;
};

type ProcessResult = { stdout: string; stderr: string };

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function pgEnv(databaseUrl: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!(host === 'localhost' || host === '::1' || /^127\./.test(host)))
    throw new Error('Restore snapshot tools require the allocator-validated loopback database.');
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    throw new Error('Restore snapshot tools require PostgreSQL URLs.');
  const queryNames = [...url.searchParams.keys()];
  if (queryNames.some((key) => key !== 'sslmode'))
    throw new Error('Restore snapshot target URL has unsupported connection options.');
  return {
    PATH: process.env.PATH,
    PGHOST: host,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: url.searchParams.get('sslmode') ?? 'disable',
    PGCONNECT_TIMEOUT: '5',
    LC_ALL: 'C',
  };
}

function processGroupExists(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  if (process.platform === 'win32') return true;
  const deadline = Date.now() + timeoutMs;
  do {
    if (!processGroupExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return !processGroupExists(pid);
}

async function terminateOwnedProcessGroup(
  child: ChildProcess,
  hasClosed: () => boolean,
): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    if (!hasClosed()) child.kill('SIGTERM');
    if (hasClosed()) return;
    await waitForChildClose(child, hasClosed, 1_000);
    if (!hasClosed()) child.kill('SIGKILL');
    if (!(await waitForChildClose(child, hasClosed, 1_500)))
      throw new Error('Owned restore process did not close after bounded termination.');
    return;
  }

  const signalGroup = (signal: NodeJS.Signals) => {
    if (!processGroupExists(pid)) return;
    try {
      process.kill(-pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') throw error;
    }
  };
  signalGroup('SIGTERM');
  if (await waitForProcessGroupExit(pid, 1_000)) return;
  signalGroup('SIGKILL');
  if (!(await waitForProcessGroupExit(pid, 1_500)))
    throw new Error('Owned restore process group remained live after bounded termination.');
}

async function waitForChildClose(
  child: ChildProcess,
  hasClosed: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (hasClosed()) return true;
  return new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout;
    const finish = (closed: boolean) => {
      clearTimeout(timer);
      child.off('close', onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    child.once('close', onClose);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

function redacted(value: string, secrets: Array<string | undefined>): string {
  let result = value;
  for (const secret of secrets) {
    if (secret) result = result.replaceAll(secret, '[redacted]');
  }
  return result.slice(-64_000);
}

function urlPasswordSecrets(value: string | undefined): Array<string | undefined> {
  if (!value) return [];
  const password = new URL(value).password;
  let decoded: string | undefined;
  try {
    decoded = decodeURIComponent(password);
  } catch {
    decoded = undefined;
  }
  return [password, decoded];
}

async function assertRestoreTargetEmpty(database: ReturnType<typeof createDb>): Promise<void> {
  const objects = await database.execute(sql`
    SELECT count(*)::int AS object_count FROM (
      SELECT relation.oid
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname NOT LIKE 'pg_toast%'
      UNION ALL
      SELECT routine.oid
      FROM pg_proc AS routine
      JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname NOT LIKE 'pg_toast%'
      UNION ALL
      SELECT type.oid
      FROM pg_type AS type
      JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname NOT LIKE 'pg_toast%'
      UNION ALL
      SELECT namespace.oid
      FROM pg_namespace AS namespace
      WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema', 'public')
        AND namespace.nspname NOT LIKE 'pg_toast%'
      UNION ALL
      SELECT large_object.oid
      FROM pg_largeobject_metadata AS large_object
    ) AS user_objects
  `);
  if (Number(objects[0]?.object_count) !== 0)
    throw new Error('Restore target is not empty; refusing to overwrite it.');
}

function runOwned(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 60_000,
  secrets: Array<string | undefined> = [],
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const outputSecrets = [...secrets, env.PGPASSWORD];
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let closed = false;
    let settled = false;
    let finishing = false;
    let timedOut = false;
    let timer: NodeJS.Timeout;
    const append = (current: string, chunk: Buffer) =>
      `${current}${chunk.toString('utf8')}`.slice(-64_000);
    child.stdout?.on('data', (chunk: Buffer) => (stdout = append(stdout, chunk)));
    child.stderr?.on('data', (chunk: Buffer) => (stderr = append(stderr, chunk)));

    const settle = async (primaryError?: Error, terminate = false) => {
      if (finishing || settled) return;
      finishing = true;
      clearTimeout(timer);
      const failures: unknown[] = primaryError ? [primaryError] : [];
      const pid = child.pid;
      if (terminate) {
        try {
          await terminateOwnedProcessGroup(child, () => closed);
        } catch (error) {
          failures.push(error);
        }
      } else if (pid && process.platform !== 'win32') {
        try {
          if (!(await waitForProcessGroupExit(pid, 500))) {
            await terminateOwnedProcessGroup(child, () => closed);
            failures.push(
              new Error(`${command} exited while an owned descendant process remained.`),
            );
          }
        } catch (error) {
          failures.push(error);
        }
      }
      if (!closed && !(await waitForChildClose(child, () => closed, 1_000))) {
        failures.push(new Error(`${command} did not close within the bounded cleanup window.`));
      }
      settled = true;
      if (failures.length === 1) reject(failures[0]);
      else if (failures.length > 1)
        reject(
          new AggregateError(
            failures,
            `${command} failed and owned-process cleanup was incomplete.`,
          ),
        );
      else
        resolve({
          stdout: redacted(stdout, outputSecrets),
          stderr: redacted(stderr, outputSecrets),
        });
    };

    timer = setTimeout(() => {
      timedOut = true;
      void settle(new Error(`${command} exceeded its bounded ${timeoutMs}ms deadline.`), true);
    }, timeoutMs);
    child.once('error', (error) => void settle(error, true));
    child.once('close', (code, signal) => {
      closed = true;
      if (timedOut) return;
      if (code !== 0)
        void settle(
          new Error(
            `${command} failed (${code ?? signal ?? 'unknown'}): ${redacted(stderr, outputSecrets)}`,
          ),
          true,
        );
      else void settle();
    });
  });
}

async function treeHash(root: string): Promise<string> {
  const rows: Array<{ path: string; sha256: string; bytes: number }> = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === '.assistant-test-owner') continue;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Workspace fixture may not contain symlinks.');
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        rows.push({
          path: relative(root, absolute).split(sep).join('/'),
          sha256: digest(bytes),
          bytes: bytes.length,
        });
      } else throw new Error('Workspace fixture contains an unsupported filesystem entry.');
    }
  }
  await visit(root);
  rows.sort((left, right) => left.path.localeCompare(right.path));
  return digest(canonical(rows));
}

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

async function stop(child: ChildProcess | undefined, hasClosed: () => boolean): Promise<void> {
  if (!child) return;
  await terminateOwnedProcessGroup(child, hasClosed);
  if (!(await waitForChildClose(child, hasClosed, 1_500)))
    throw new Error('Restore agent did not close after its owned process group stopped.');
}

async function removeOwnedDirectory(path: string, expectedMarker: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error(
      'Refusing to remove a restore fixture directory without a private directory boundary.',
    );
  let markerStat: Awaited<ReturnType<typeof lstat>>;
  let marker: string;
  try {
    markerStat = await lstat(join(path, '.assistant-test-owner'));
    marker = await readFile(join(path, '.assistant-test-owner'), 'utf8');
  } catch {
    throw new Error('Refusing to remove a restore fixture directory without its ownership marker.');
  }
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || marker !== expectedMarker)
    throw new Error(
      'Refusing to remove a restore fixture directory with a mismatched ownership marker.',
    );
  await rm(path, { recursive: true, force: false });
}

describe.skipIf(!enabled)('allocator-owned PostgreSQL snapshot restore', () => {
  let source: ReturnType<typeof createDb> | undefined;
  let targetAdmin: ReturnType<typeof createDb> | undefined;
  let readerUrl = '';
  let readerPassword = '';
  let agent: ChildProcess | undefined;
  let agentOutput = '';
  let agentSpawnError: Error | undefined;
  let agentClosed = false;
  let tempRoot: string | undefined;
  let ownsTempRoot = false;
  let ownsSourceWorkspace = false;
  let ownsTargetWorkspace = false;
  let fixture: Fixture | undefined;
  let expectedDataHash = '';
  let expectedWorkspaceHash = '';
  let expectedMigrationHash = '';
  let expectedEffectCounts: Record<string, unknown> | undefined;
  let appManifest = '';
  const safeOutput = () =>
    redacted(agentOutput, [
      readerPassword,
      ...urlPasswordSecrets(sourceUrl),
      ...urlPasswordSecrets(targetUrl),
    ]);

  beforeAll(async () => {
    if (
      !sourceUrl ||
      !sourceToken ||
      !targetUrl ||
      !targetToken ||
      !sourceRunId ||
      !targetRunId ||
      !sourceWorkspace ||
      !targetWorkspace
    )
      throw new Error('Use pnpm test --restore-snapshot-target to allocate a source/target pair.');
    const sourceOwned = assertAllocatedTestTargetMarker({
      databaseUrl: sourceUrl,
      testDatabaseUrl: sourceUrl,
      token: sourceToken,
      kind: 'restore',
    });
    const targetOwned = assertAllocatedTestTargetMarker({
      databaseUrl: targetUrl,
      testDatabaseUrl: targetUrl,
      token: targetToken,
      kind: 'restore',
    });
    // Both allocator markers must bind to their own allocated identity. A
    // cross-pair token is rejected before any fixture reads or restore work.
    expect(() =>
      assertAllocatedTestTargetMarker({
        databaseUrl: sourceUrl,
        testDatabaseUrl: sourceUrl,
        token: targetToken,
        kind: 'restore',
      }),
    ).toThrow('Database name does not match the allocated test target token.');
    if (
      sourceOwned.databaseName === targetOwned.databaseName ||
      sourceToken === targetToken ||
      sourceRunId === targetRunId
    )
      throw new Error('Restore source and target allocator identities must be distinct.');
    const sourceAddress = new URL(sourceUrl);
    const targetAddress = new URL(targetUrl);
    if (
      sourceAddress.hostname !== targetAddress.hostname ||
      sourceAddress.port !== targetAddress.port
    )
      throw new Error(
        'Restore source and target must share the same loopback PostgreSQL test server.',
      );

    source = createDb(sourceUrl, { max: 1 });
    await assertAllocatedTestDatabaseOwnership(source, sourceOwned);
    const owners = await source.select({ id: agents.id }).from(agents).limit(2);
    if (owners.length !== 1 || !owners[0])
      throw new Error('Snapshot fixture requires exactly one seeded owner.');
    const agentId = owners[0].id;
    const now = new Date();
    const past = new Date(now.getTime() - 10 * 60_000);
    const taskId = randomUUID();
    const approvalTaskId = randomUUID();
    const toolCallId = randomUUID();
    const approvalId = randomUUID();
    const outboxId = randomUUID();
    const scheduleId = randomUUID();
    const tombstoneHash = digest('DM-06 synthetic text permanently forgotten');
    fixture = {
      agentId,
      taskId,
      approvalTaskId,
      toolCallId,
      approvalId,
      outboxId,
      scheduleId,
      tombstoneHash,
    };

    await source.insert(tasks).values({
      id: taskId,
      agentId,
      type: 'scheduled',
      status: 'pending',
      title: 'DM-06 synthetic due task',
      trigger: { kind: 'dm06-snapshot-fixture' },
      runAfter: past,
      trust: 'owner',
    });
    await source.insert(tasks).values({
      id: approvalTaskId,
      agentId,
      type: 'adhoc',
      status: 'waiting_approval',
      title: 'DM-06 pending approval',
      trigger: { kind: 'dm06-snapshot-fixture' },
      trust: 'owner',
    });
    await source.insert(toolCalls).values({
      id: toolCallId,
      taskId: approvalTaskId,
      step: 1,
      toolName: 'gmail.send',
      args: { to: 'dm06-fixture@example.test' },
      risk: 'approval',
      status: 'awaiting_approval',
    });
    await source.insert(approvals).values({
      id: approvalId,
      taskId: approvalTaskId,
      toolCallId,
      shortCode: `D${randomBytes(4).toString('hex').slice(0, 6)}`,
      summary: 'DM-06 synthetic pending approval',
      status: 'pending',
      requestedAt: past,
      expiresAt: past,
    });
    await source.insert(schedules).values({
      id: scheduleId,
      agentId,
      name: `dm06-reminder-${sourceRunId}`,
      cron: '* * * * *',
      enabled: true,
      nextRunAt: past,
      taskTemplate: {
        type: 'scheduled',
        trigger: { kind: 'reminder' },
        reminderKind: 'once',
        reminderText: 'DM-06 synthetic reminder',
      },
    });
    await source
      .insert(memoryTombstones)
      .values({ contentHash: tombstoneHash, reason: 'owner_forget' });
    await source.insert(notificationOutbox).values({
      id: outboxId,
      agentId,
      deliveryKey: `dm06:${randomUUID()}`,
      legKey: 'snapshot-unknown',
      adapter: 'push',
      status: 'unknown',
      attempts: 1,
      retryable: false,
      destination: null,
      payload: null,
      providerMessageId: null,
      result: null,
      leaseToken: null,
      leaseUntil: null,
    });

    await mkdir(sourceWorkspace, { recursive: false, mode: 0o700 });
    ownsSourceWorkspace = true;
    await writeFile(
      join(sourceWorkspace, '.assistant-test-owner'),
      `assistant-test-target-workspace:${sourceToken}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    await writeFile(
      join(sourceWorkspace, `object-${sourceRunId}.txt`),
      'synthetic workspace object\n',
      { mode: 0o600, flag: 'wx' },
    );
    expectedWorkspaceHash = await treeHash(sourceWorkspace);

    const journalPath = fileURLToPath(
      new URL('../../../packages/db/drizzle/meta/_journal.json', import.meta.url),
    );
    const currentJournal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries?: unknown[];
    };
    if (!Array.isArray(currentJournal.entries))
      throw new Error('Current migration journal is malformed.');
    const migrations = await source.execute(
      sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
    );
    if (migrations.length !== currentJournal.entries.length)
      throw new Error(
        'Source migration prefix does not match the current application migration journal.',
      );
    expectedMigrationHash = digest(canonical(migrations));

    const sourceData = await fixtureProjection(source, fixture);
    expectedDataHash = digest(canonical(sourceData));
    const effectCounts = await source.execute(sql`
      SELECT (SELECT count(*)::int FROM notification_outbox) AS notification_rows,
             (SELECT count(*)::int FROM model_calls) AS model_call_rows,
             (SELECT count(*)::int FROM model_call_audit) AS model_audit_rows
    `);
    expectedEffectCounts = effectCounts[0] as Record<string, unknown>;

    tempRoot = join(tmpdir(), `assistant_restore_${sourceRunId}_snapshot`);
    await mkdir(tempRoot, { recursive: false, mode: 0o700 });
    ownsTempRoot = true;
    await writeFile(
      join(tempRoot, '.assistant-test-owner'),
      `assistant-test-snapshot:${sourceToken}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    const dbArchive = join(tempRoot, 'source.custom.dump');
    const workspaceArchive = join(tempRoot, 'workspace.tar');
    await runOwned(
      'pg_dump',
      [
        '--format=custom',
        '--no-owner',
        '--no-acl',
        '--file',
        dbArchive,
        '--dbname',
        `assistant_restore_${sourceRunId}_test`,
      ],
      pgEnv(sourceUrl),
    );
    const archiveHash = digest(await readFile(dbArchive));
    await runOwned('pg_restore', ['--list', dbArchive], { PATH: process.env.PATH, LC_ALL: 'C' });
    await runOwned('tar', ['-cf', workspaceArchive, '-C', sourceWorkspace, '.'], {
      PATH: process.env.PATH,
      LC_ALL: 'C',
    });
    const workspaceArchiveHash = digest(await readFile(workspaceArchive));
    const workspaceEntries = await runOwned('tar', ['-tf', workspaceArchive], {
      PATH: process.env.PATH,
      LC_ALL: 'C',
    });
    const workspaceEntryNames = workspaceEntries.stdout.split(/\r?\n/).filter(Boolean);
    if (
      !workspaceEntryNames.includes('./.assistant-test-owner') ||
      !workspaceEntryNames.includes(`./object-${sourceRunId}.txt`) ||
      workspaceEntryNames.some((path) => path.includes('..') || path.startsWith('/'))
    )
      throw new Error('Workspace archive contents do not match the bounded synthetic snapshot.');
    const appPackage = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version?: string };
    const entryHash = digest(await readFile(fileURLToPath(new URL('./index.ts', import.meta.url))));
    const manifest = {
      format: 'assistant-dm06-synthetic-snapshot-v1',
      sourceRunId,
      targetRunId,
      appVersion: appPackage.version,
      appEntrySha256: entryHash,
      migrationCount: currentJournal.entries.length,
      migrationJournalSha256: expectedMigrationHash,
      fixtureRowsSha256: expectedDataHash,
      workspaceTreeSha256: expectedWorkspaceHash,
      postgresArchiveSha256: archiveHash,
      workspaceArchiveSha256: workspaceArchiveHash,
    };
    appManifest = canonical(manifest);
    const manifestPath = join(tempRoot, 'manifest.json');
    await writeFile(manifestPath, appManifest, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const manifestHash = digest(await readFile(manifestPath));

    const targetAdminUrl = new URL(targetUrl);
    targetAdminUrl.pathname = '/postgres';
    const admin = createDb(targetAdminUrl.toString(), { max: 1 });
    try {
      await admin.execute(sql`SELECT 1`);
      const emptyTarget = createDb(targetUrl, { max: 1 });
      try {
        await assertAllocatedTestDatabaseOwnership(emptyTarget, targetOwned);
        await assertRestoreTargetEmpty(emptyTarget);
        await emptyTarget.$client.unsafe(
          'CREATE TABLE public.dm06_restore_nonempty_guard (id integer NOT NULL)',
        );
        try {
          await expect(assertRestoreTargetEmpty(emptyTarget)).rejects.toThrow(
            'Restore target is not empty; refusing to overwrite it.',
          );
        } finally {
          await emptyTarget.$client.unsafe(
            'DROP TABLE IF EXISTS public.dm06_restore_nonempty_guard',
          );
        }
        await expect(assertRestoreTargetEmpty(emptyTarget)).resolves.toBeUndefined();
      } finally {
        await emptyTarget.$client.end({ timeout: 5 });
      }
      const roleName = `assistant_restore_reader_${targetRunId}`;
      readerPassword = randomBytes(24).toString('hex');
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
      });
      // This role is created before restore but is not granted access until after
      // the schema/data are installed; pg_restore uses the test admin identity.
      if (digest(await readFile(dbArchive)) !== archiveHash)
        throw new Error('PostgreSQL snapshot archive hash changed before restore.');
      await runOwned(
        'pg_restore',
        [
          '--exit-on-error',
          '--no-owner',
          '--no-acl',
          '--dbname',
          `assistant_restore_${targetRunId}_test`,
          dbArchive,
        ],
        pgEnv(targetUrl),
      );
      await admin.$client.unsafe(
        `GRANT CONNECT ON DATABASE "${targetOwned.databaseName}" TO "${roleName}"`,
      );
    } finally {
      await admin.$client.end({ timeout: 5 });
    }

    const targetPrivileges = createDb(targetUrl, { max: 1 });
    try {
      await targetPrivileges.$client.unsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await targetPrivileges.$client.unsafe(
        `GRANT USAGE ON SCHEMA public TO "assistant_restore_reader_${targetRunId}"`,
      );
      await targetPrivileges.$client.unsafe(
        `GRANT SELECT ON ALL TABLES IN SCHEMA public TO "assistant_restore_reader_${targetRunId}"`,
      );
    } finally {
      await targetPrivileges.$client.end({ timeout: 5 });
    }

    await mkdir(targetWorkspace, { recursive: false, mode: 0o700 });
    ownsTargetWorkspace = true;
    await runOwned('tar', ['-xf', workspaceArchive, '-C', targetWorkspace], {
      PATH: process.env.PATH,
      LC_ALL: 'C',
    });
    const copiedWorkspaceMarker = await readFile(
      join(targetWorkspace, '.assistant-test-owner'),
      'utf8',
    );
    if (copiedWorkspaceMarker !== `assistant-test-target-workspace:${sourceToken}\n`)
      throw new Error('Workspace snapshot marker does not match the allocator-owned source.');
    await writeFile(
      join(targetWorkspace, '.assistant-test-owner'),
      `assistant-test-target-workspace:${targetToken}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    if (
      digest(await readFile(workspaceArchive)) !== workspaceArchiveHash ||
      digest(await readFile(manifestPath)) !== manifestHash
    )
      throw new Error('Restore archive bytes changed during the restore.');
    if (digest(appManifest) !== manifestHash)
      throw new Error('Application/schema manifest is not internally consistent.');
    const restoredManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      appVersion?: unknown;
      appEntrySha256?: unknown;
      migrationCount?: unknown;
      migrationJournalSha256?: unknown;
    };
    const currentPackage = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version?: unknown };
    const currentEntryHash = digest(
      await readFile(fileURLToPath(new URL('./index.ts', import.meta.url))),
    );
    if (
      restoredManifest.appVersion !== currentPackage.version ||
      restoredManifest.appEntrySha256 !== currentEntryHash ||
      restoredManifest.migrationJournalSha256 !== expectedMigrationHash
    )
      throw new Error('Restore snapshot manifest does not match this application/schema version.');
    if ((await treeHash(targetWorkspace)) !== expectedWorkspaceHash)
      throw new Error('Restored workspace object hash does not match the source snapshot.');

    const targetAdminDatabaseUrl = targetUrl;
    targetAdmin = createDb(targetAdminDatabaseUrl, { max: 1 });
    const targetMigrations = await targetAdmin.execute(
      sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
    );
    if (digest(canonical(targetMigrations)) !== expectedMigrationHash)
      throw new Error('Restored migration prefix does not match the source/current application.');
    const restoredProjection = await fixtureProjection(targetAdmin, fixture);
    if (digest(canonical(restoredProjection)) !== expectedDataHash)
      throw new Error('Restored synthetic row hash does not match the source snapshot.');

    const reader = new URL(targetUrl);
    reader.username = `assistant_restore_reader_${targetRunId}`;
    reader.password = readerPassword;
    readerUrl = reader.toString();
  }, 120_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    const cleanupSteps: Array<() => Promise<void>> = [
      () => stop(agent, () => agentClosed),
      async () => {
        await targetAdmin?.$client.end({ timeout: 5 });
      },
      async () => {
        await source?.$client.end({ timeout: 5 });
      },
      async () => {
        if (ownsSourceWorkspace && sourceWorkspace && sourceToken)
          await removeOwnedDirectory(
            sourceWorkspace,
            `assistant-test-target-workspace:${sourceToken}\n`,
          );
      },
      async () => {
        if (ownsTargetWorkspace && targetWorkspace && targetToken)
          await removeOwnedDirectory(
            targetWorkspace,
            `assistant-test-target-workspace:${targetToken}\n`,
          );
      },
      async () => {
        if (ownsTempRoot && tempRoot && sourceToken)
          await removeOwnedDirectory(tempRoot, `assistant-test-snapshot:${sourceToken}\n`);
      },
    ];
    for (const cleanup of cleanupSteps) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Restore rehearsal cleanup was incomplete.');
  });

  it('restores synthetic due work and boots the shipped application read-only and inert', async () => {
    if (!source || !targetAdmin || !fixture || !targetRunId || !targetWorkspace)
      throw new Error('Snapshot restore fixture was not initialized.');
    const port = await unusedLoopbackPort();
    const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: readerUrl,
      TEST_DATABASE_URL: '',
      PERSISTENCE_DRIVER: 'postgres',
      QUEUE_DRIVER: 'inert',
      RESTORE_REHEARSAL: 'true',
      RESTORE_REHEARSAL_ROOT: targetWorkspace,
      ASSISTANT_WORKSPACE_ID: `restore-${targetRunId}`,
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
    delete childEnv.ASSISTANT_RESTORE_TARGET_DATABASE_URL;
    delete childEnv.ASSISTANT_RESTORE_TARGET_TOKEN;
    for (const key of [
      'OPENROUTER_API_KEY',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
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
    ])
      childEnv[key] = '';
    agent = spawn(process.execPath, ['--import', 'tsx', entry], {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    agent.once('error', (error) => {
      agentSpawnError = error;
    });
    agent.once('close', () => {
      agentClosed = true;
    });
    agent.stdout?.on(
      'data',
      (chunk) => (agentOutput = `${agentOutput}${String(chunk)}`.slice(-64_000)),
    );
    agent.stderr?.on(
      'data',
      (chunk) => (agentOutput = `${agentOutput}${String(chunk)}`.slice(-64_000)),
    );
    let ready: Response | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (agentSpawnError)
        throw new Error(`Could not start the restore agent: ${agentSpawnError.message}`);
      if (agent.exitCode !== null)
        throw new Error(`Restore agent exited before readiness: ${safeOutput()}`);
      ready = await fetch(`http://127.0.0.1:${port}/ready`, {
        signal: AbortSignal.timeout(2_000),
      }).catch(() => null);
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(ready?.status, safeOutput()).toBe(200);
    expect(await ready?.json()).toMatchObject({ ready: true, database: 'postgres' });
    const health = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    expect(health.status).toBe(200);
    expect(agentOutput).toContain('restore rehearsal background dispatch is disabled');
    expect(agentOutput).not.toContain('local queue poller started');
    expect(agentOutput).not.toContain('External network access is disabled');
    expect(agentOutput).not.toContain(readerPassword);

    const denied = await fetch(`http://127.0.0.1:${port}/internal/tasks/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: fixture.taskId }),
      signal: AbortSignal.timeout(2_000),
    });
    expect(denied.status).toBe(503);
    const deniedCallback = await fetch(`http://127.0.0.1:${port}/webhooks/gmail`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'synthetic' }),
      signal: AbortSignal.timeout(2_000),
    });
    expect(deniedCallback.status).toBe(503);

    const reader = createDb(readerUrl, { max: 1, readOnly: true });
    try {
      await assertPostgresRestoreRehearsalReadOnly(reader);
      await expect(
        reader.execute(sql`UPDATE tasks SET status = 'done' WHERE id = ${fixture.taskId}`),
      ).rejects.toThrow();
    } finally {
      await reader.$client.end({ timeout: 5 });
    }
    const targetProjection = await fixtureProjection(targetAdmin, fixture);
    expect(targetProjection.due_task).toMatchObject({ status: 'pending' });
    expect(targetProjection.approval_task).toMatchObject({ status: 'waiting_approval' });
    expect(targetProjection.approval).toMatchObject({ status: 'pending' });
    expect(targetProjection.unknown_effect).toMatchObject({ status: 'unknown', attempts: 1 });
    expect(targetProjection.tombstone_count).toBe(1);
    expect(digest(canonical(targetProjection))).toBe(expectedDataHash);
    expect(digest(canonical(await fixtureProjection(source, fixture)))).toBe(expectedDataHash);
    if (!expectedEffectCounts) throw new Error('Effect baseline is missing.');
    const afterEffects = await targetAdmin.execute(sql`
      SELECT (SELECT count(*)::int FROM notification_outbox) AS notification_rows,
             (SELECT count(*)::int FROM model_calls) AS model_call_rows,
             (SELECT count(*)::int FROM model_call_audit) AS model_audit_rows
    `);
    expect(afterEffects[0]).toMatchObject(expectedEffectCounts);
    const sourceEffectsAfter = await source.execute(sql`
      SELECT (SELECT count(*)::int FROM notification_outbox) AS notification_rows,
             (SELECT count(*)::int FROM model_calls) AS model_call_rows,
             (SELECT count(*)::int FROM model_call_audit) AS model_audit_rows
    `);
    expect(sourceEffectsAfter[0]).toMatchObject(expectedEffectCounts);
    expect(await treeHash(targetWorkspace)).toBe(expectedWorkspaceHash);
  }, 40_000);
});

async function fixtureProjection(db: ReturnType<typeof createDb>, fixture: Fixture) {
  const rows = await db.execute(sql`
    SELECT
      (SELECT to_jsonb(task) FROM tasks AS task WHERE task.id = ${fixture.taskId}) AS due_task,
      (SELECT to_jsonb(task) FROM tasks AS task WHERE task.id = ${fixture.approvalTaskId}) AS approval_task,
      (SELECT to_jsonb(call) FROM tool_calls AS call WHERE call.id = ${fixture.toolCallId}) AS approval_tool_call,
      (SELECT to_jsonb(approval) FROM approvals AS approval WHERE approval.id = ${fixture.approvalId}) AS approval,
      (SELECT to_jsonb(schedule) FROM schedules AS schedule WHERE schedule.id = ${fixture.scheduleId}) AS reminder_schedule,
      (SELECT to_jsonb(outbox) FROM notification_outbox AS outbox WHERE outbox.id = ${fixture.outboxId}) AS unknown_effect,
      (SELECT count(*)::int FROM memory_tombstones WHERE content_hash = ${fixture.tombstoneHash}) AS tombstone_count
  `);
  if (!rows[0]) throw new Error('Snapshot fixture projection returned no row.');
  return rows[0];
}
