import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { resolveApproval } from './approval-repository.js';
import { createDb } from './client.js';
import {
  allocateTestTarget,
  assertAllocatedTestTarget,
  isolatedTestEnvironment,
} from './test-target.js';

const migrationFolder = fileURLToPath(new URL('../drizzle/', import.meta.url));
const packageFolder = fileURLToPath(new URL('../', import.meta.url));
const journal = JSON.parse(await readFile(join(migrationFolder, 'meta/_journal.json'), 'utf8'));
const correctionIndex = journal.entries.findIndex(
  (entry: { tag: string }) => entry.tag === '0084_approval_identity_reconciliation',
);
if (correctionIndex !== 84)
  throw new Error('Expected the reviewed forward-correction journal slot');

function appendBounded(output: { value: string }, chunk: Buffer) {
  const remaining = Math.max(0, 32_768 - output.value.length);
  output.value += chunk.toString('utf8').slice(0, remaining);
}

function cancellableDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (elapsed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(elapsed);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = cancellableDelay(timeoutMs, controller.signal).then((elapsed) => ({
    kind: elapsed ? ('timeout' as const) : ('cancelled' as const),
  }));
  const winner = await Promise.race([
    promise.then((value) => ({ kind: 'value' as const, value })),
    timeout,
  ]);
  controller.abort();
  return winner;
}

type WaitingBackend = { pid: number; backendStart: string; query: string };

async function waitForActivity(
  admin: ReturnType<typeof postgres>,
  databaseName: string,
  lockKey: bigint,
  timeoutMs = 20_000,
  signal?: AbortSignal,
): Promise<WaitingBackend | undefined> {
  const stopAt = Date.now() + timeoutMs;
  const lockHigh = Number(lockKey >> 32n);
  const lockLow = Number(lockKey & 0xffff_ffffn);
  while (Date.now() < stopAt) {
    if (signal?.aborted) return undefined;
    const rows = await admin<WaitingBackend[]>`
      SELECT a.pid, a.backend_start::text AS "backendStart", a.query
      FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE a.datid = (SELECT oid FROM pg_database WHERE datname = ${databaseName})
        AND l.database = (SELECT oid FROM pg_database WHERE datname = ${databaseName})
        AND l.locktype = 'advisory' AND l.granted = false
        AND l.classid = ${lockHigh}::oid AND l.objid = ${lockLow}::oid AND l.objsubid = 1
        AND a.state = 'active' AND a.wait_event_type = 'Lock' AND a.wait_event = 'advisory'
    `;
    if (signal?.aborted) return undefined;
    const waitingBackend = rows[0];
    if (waitingBackend) return waitingBackend;
    if (!(await cancellableDelay(50, signal))) return undefined;
  }
  throw new Error('Timed out waiting for the migration to reach the controlled delete boundary');
}

async function waitForCorrectionActivityToEnd(
  admin: ReturnType<typeof postgres>,
  databaseName: string,
  backend: Pick<WaitingBackend, 'pid' | 'backendStart'>,
  timeoutMs = 5_000,
) {
  const stopAt = Date.now() + timeoutMs;
  while (Date.now() < stopAt) {
    const rows = await admin<{ pid: number }[]>`
      SELECT pid FROM pg_stat_activity
      WHERE datid = (SELECT oid FROM pg_database WHERE datname = ${databaseName})
        AND pid = ${backend.pid} AND backend_start::text = ${backend.backendStart}
    `;
    if (rows.length === 0) return;
    await cancellableDelay(50);
  }
  throw new Error('Interrupted corrective migration still has its captured backend session');
}

type OwnedProcess = {
  child: ChildProcess;
  spawned: Promise<void>;
  completion: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>;
  output: { value: string };
  groupId?: number;
  quiesced: boolean;
};

function startOwnedProcess(command: string, args: string[], options: SpawnOptions): OwnedProcess {
  const child = spawn(command, args, { ...options, detached: true });
  const output = { value: '' };
  child.stdout?.on('data', (chunk: Buffer) => appendBounded(output, chunk));
  child.stderr?.on('data', (chunk: Buffer) => appendBounded(output, chunk));
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', () => {
      if (child.pid && child.pid > 1) owned.groupId = child.pid;
      resolve();
    });
    child.once('error', reject);
  });
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const owned: OwnedProcess = { child, spawned, completion, output, quiesced: false };
  return owned;
}

function processGroupExists(pid: number): boolean {
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

async function waitForProcessGroupExit(owned: OwnedProcess, timeoutMs: number): Promise<boolean> {
  if (owned.quiesced) return true;
  const pid = owned.groupId;
  if (!pid || pid <= 1) {
    owned.quiesced = true;
    return true;
  }
  const stopAt = Date.now() + timeoutMs;
  while (Date.now() < stopAt) {
    if (!processGroupExists(pid)) {
      owned.quiesced = true;
      return true;
    }
    await cancellableDelay(50);
  }
  if (!processGroupExists(pid)) {
    owned.quiesced = true;
    return true;
  }
  return false;
}

function signalOwnedProcessGroup(pid: number, signal: NodeJS.Signals) {
  if (!Number.isSafeInteger(pid) || pid <= 1)
    throw new Error('Owned command has no safe process-group leader');
  try {
    // Every command is detached, so this targets only its own process group.
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function stopOwnedProcess(process: OwnedProcess) {
  if (process.quiesced) return;
  try {
    await process.spawned;
  } catch {
    process.quiesced = true;
    return;
  }
  const pid = process.groupId;
  if (!pid || pid <= 1) {
    process.quiesced = true;
    return;
  }
  if (!processGroupExists(pid)) {
    process.quiesced = true;
    return;
  }
  signalOwnedProcessGroup(pid, 'SIGTERM');
  if (!(await waitForProcessGroupExit(process, 5_000))) {
    if (process.quiesced) return;
    signalOwnedProcessGroup(pid, 'SIGKILL');
    if (!(await waitForProcessGroupExit(process, 5_000)))
      throw new Error('Owned process group did not quiesce after bounded SIGKILL');
  }
  const closed = await raceWithTimeout(process.completion, 5_000);
  if (closed.kind !== 'value')
    throw new Error('Owned process leader did not close after its group exited');
}

async function runOwnedCommand(
  command: string,
  args: string[],
  options: SpawnOptions,
  timeoutMs: number,
  onOwnedProcess?: (process: OwnedProcess | undefined) => void,
): Promise<void> {
  const owned = startOwnedProcess(command, args, options);
  onOwnedProcess?.(owned);
  try {
    await owned.spawned;
    const pid = owned.groupId;
    if (!pid || pid <= 1) throw new Error('Owned command did not receive a safe process-group id');
    const result = await raceWithTimeout(owned.completion, timeoutMs);
    if (result.kind !== 'value') {
      await stopOwnedProcess(owned);
      throw new Error(`Owned command timed out after ${timeoutMs}ms: ${owned.output.value}`);
    }
    const completed = result.value;
    if (completed.error) throw completed.error;
    if (!(await waitForProcessGroupExit(owned, 1_000))) {
      await stopOwnedProcess(owned);
      throw new Error(`Owned command left descendants after leader exit: ${owned.output.value}`);
    }
    if (completed.code !== 0)
      throw new Error(
        `Owned command exited ${completed.code ?? completed.signal}: ${owned.output.value}`,
      );
  } finally {
    if (!owned.quiesced) await stopOwnedProcess(owned);
    if (owned.quiesced) onOwnedProcess?.(undefined);
  }
}

async function stopOwnedMigration(process: OwnedProcess) {
  await stopOwnedProcess(process);
}

async function attemptCleanup(label: string, action: () => Promise<unknown>, failures: string[]) {
  try {
    await action();
  } catch (error) {
    failures.push(
      `${label}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}

async function closeAll(actions: Array<{ label: string; action: () => Promise<unknown> }>) {
  const failures: string[] = [];
  for (const { label, action } of actions) await attemptCleanup(label, action, failures);
  if (failures.length)
    throw new AggregateError(
      failures.map((failure) => new Error(failure)),
      failures.join('\n'),
    );
}

async function dropOwnedDatabaseIfPresent(
  admin: ReturnType<typeof postgres>,
  target: ReturnType<typeof allocateTestTarget>,
) {
  const [owned] = await admin<{ marker: string | null }[]>`
    SELECT shobj_description(oid,'pg_database') AS marker
    FROM pg_database WHERE datname=${target.databaseName}
  `;
  if (!owned) return;
  if (owned?.marker !== `assistant-test-target:${target.token}`)
    throw new Error('Interrupted-migration fixture cleanup ownership mismatch');
  await admin.unsafe(`DROP DATABASE "${target.databaseName}"`);
}

it.skipIf(process.platform === 'win32')(
  'rolls back an interrupted 0084 correction and retries through the shipped migration entrypoint',
  async () => {
    assertAllocatedTestTarget({
      databaseUrl: process.env.DATABASE_URL,
      testDatabaseUrl: process.env.TEST_DATABASE_URL,
      token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
    });
    if (correctionIndex < 1) throw new Error('Correction migration is missing from the journal');
    const target = allocateTestTarget(process.env.DATABASE_URL);
    const adminUrl = new URL(target.databaseUrl);
    adminUrl.pathname = '/postgres';
    const prefixFolder = await mkdtemp(join(tmpdir(), 'assistant-dm01-interruption-'));
    const diagnosticPath = join(tmpdir(), `assistant-dm01-cleanup-${target.token}.json`);
    let admin: ReturnType<typeof postgres> | undefined;
    let created = false;
    let interruptedChild: OwnedProcess | undefined;
    let retryChild: OwnedProcess | undefined;
    const retryHistory: OwnedProcess[] = [];
    let client: ReturnType<typeof postgres> | undefined;
    let blockerClient: ReturnType<typeof postgres> | undefined;
    let primaryError: unknown;
    try {
      const adminClient = postgres(adminUrl.toString(), {
        max: 1,
        connection: { statement_timeout: 5_000 },
        onnotice: () => {},
      });
      admin = adminClient;
      await adminClient.unsafe(`CREATE DATABASE "${target.databaseName}"`);
      created = true;
      await adminClient.unsafe(
        `COMMENT ON DATABASE "${target.databaseName}" IS 'assistant-test-target:${target.token}'`,
      );
      const migrationDb = postgres(target.databaseUrl, { max: 1, onnotice: () => {} });
      client = migrationDb;
      try {
        await mkdir(join(prefixFolder, 'meta'));
        const entries = journal.entries.slice(0, correctionIndex);
        await writeFile(
          join(prefixFolder, 'meta/_journal.json'),
          JSON.stringify({ ...journal, entries }),
        );
        for (const entry of entries)
          await writeFile(
            join(prefixFolder, `${entry.tag}.sql`),
            await readFile(join(migrationFolder, `${entry.tag}.sql`)),
          );
        await migrate(drizzle(migrationDb), { migrationsFolder: prefixFolder });

        const owner = randomUUID();
        const keptPolicy = randomUUID();
        const duplicatePolicy = randomUUID();
        const taskId = randomUUID();
        const toolCallId = randomUUID();
        const approvalId = randomUUID();
        await migrationDb`INSERT INTO agents (id,name,email,workspace_prefix,timezone,locale,signature) VALUES (${owner},'DM01 interruption owner',${`${owner}@example.test`},${`workspace/${owner}`},'America/Los_Angeles','en','Synthetic')`;
        await migrationDb`DROP INDEX IF EXISTS approval_policies_identity_idx`;
        await migrationDb`CREATE INDEX approval_policies_identity_idx ON approval_policies(tool_name)`;
        await migrationDb`INSERT INTO approval_policies (id,agent_id,tool_name,template_key,match,effect,enabled,created_via,created_at,updated_at) VALUES (${keptPolicy},${owner},'gmail.send','gmail.send.to_recipient','{"recipient":"dm01@example.test"}','allow',true,'approval_dialog','2025-01-01','2025-01-01')`;
        await migrationDb`INSERT INTO approval_policies (id,agent_id,tool_name,template_key,match,effect,enabled,created_via,created_at,updated_at) VALUES (${duplicatePolicy},${owner},'gmail.send','gmail.send.to_recipient','{"recipient":"dm01@example.test"}','allow',false,'settings','2025-02-01','2025-02-01')`;
        await migrationDb`INSERT INTO tasks (id,agent_id,type,trust,status) VALUES (${taskId},${owner},'chat_turn','owner','waiting_approval')`;
        await migrationDb`INSERT INTO tool_calls (id,task_id,step,tool_name,risk,status,args) VALUES (${toolCallId},${taskId},0,'gmail.send','approval','awaiting_approval','{"to":["dm01@example.test"]}')`;
        await migrationDb`INSERT INTO approvals (id,task_id,tool_call_id,short_code,summary,payload,status,expires_at,created_policy_id) VALUES (${approvalId},${taskId},${toolCallId},${`A${approvalId}`},'Synthetic policy memory','{"to":["dm01@example.test"]}','pending',clock_timestamp()+interval '1 hour',${duplicatePolicy})`;
        await migrationDb`UPDATE tool_calls SET approval_id=${approvalId} WHERE id=${toolCallId}`;

        const suffix = target.token;
        const functionName = `assistant_dm01_wait_${suffix}`;
        const triggerName = `assistant_dm01_wait_${suffix}`;
        const lockKey = BigInt(`0x${suffix.slice(0, 15)}`);
        await migrationDb.unsafe(
          `CREATE FUNCTION public."${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${lockKey.toString()}); RETURN OLD; END $$`,
        );
        await migrationDb.unsafe(
          `CREATE TRIGGER "${triggerName}" BEFORE DELETE ON public.approval_policies FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()`,
        );
        const [before] =
          await migrationDb`SELECT created_policy_id FROM approvals WHERE id=${approvalId}`;
        expect(before?.created_policy_id).toBe(duplicatePolicy);

        const blocker = postgres(target.databaseUrl, { max: 1, onnotice: () => {} });
        blockerClient = blocker;
        let correctionBackend: WaitingBackend | undefined;
        try {
          await blocker.begin(async (tx) => {
            await tx.unsafe(`SELECT pg_advisory_xact_lock(${lockKey.toString()})`);
            const env = {
              ...isolatedTestEnvironment(process.env),
              DATABASE_URL: target.databaseUrl,
              TEST_DATABASE_URL: target.databaseUrl,
              ASSISTANT_TEST_TARGET_TOKEN: target.token,
            };
            interruptedChild = startOwnedProcess('pnpm', ['migrate'], {
              cwd: packageFolder,
              env,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            await interruptedChild.spawned;
            if (!interruptedChild.child.pid)
              throw new Error('Migration CLI did not start a process group');
            const boundaryController = new AbortController();
            try {
              const boundary = await Promise.race([
                waitForActivity(
                  adminClient,
                  target.databaseName,
                  lockKey,
                  20_000,
                  boundaryController.signal,
                ).then((activity) => ({ kind: 'activity' as const, activity })),
                interruptedChild.completion.then((state) => ({ kind: 'closed' as const, state })),
              ]);
              if (boundary.kind === 'closed') {
                boundaryController.abort();
                throw new Error(
                  `Migration exited before reaching delete boundary: ${JSON.stringify(boundary.state)} ${interruptedChild.output.value}`,
                );
              }
              if (!boundary.activity)
                throw new Error(
                  'Migration did not reach the controlled boundary before its deadline',
                );
              correctionBackend = boundary.activity;
            } catch (error) {
              throw new Error(
                `Correction never reached its post-repoint delete boundary. Output: ${interruptedChild.output.value}`,
                { cause: error },
              );
            } finally {
              boundaryController.abort();
              await stopOwnedMigration(interruptedChild);
            }
          });
        } finally {
          await blocker.end({ timeout: 5 });
          blockerClient = undefined;
        }
        if (!correctionBackend)
          throw new Error('The migration backend identity was not captured before interruption');
        await waitForCorrectionActivityToEnd(adminClient, target.databaseName, correctionBackend);
        const [watermark] = await migrationDb<{ max_when: string | null }[]>`
          SELECT max(created_at)::text AS max_when FROM drizzle.__drizzle_migrations
        `;
        expect(watermark?.max_when).toBe(String(journal.entries[correctionIndex - 1].when));
        expect(
          await migrationDb`SELECT id FROM approval_policies WHERE agent_id=${owner}`,
        ).toHaveLength(2);
        const [afterAbort] =
          await migrationDb`SELECT created_policy_id FROM approvals WHERE id=${approvalId}`;
        expect(afterAbort?.created_policy_id).toBe(duplicatePolicy);
        await migrationDb.unsafe(`DROP TRIGGER "${triggerName}" ON public.approval_policies`);
        await migrationDb.unsafe(`DROP FUNCTION public."${functionName}"()`);
        await migrationDb.end({ timeout: 5 });
        client = undefined;

        const env = {
          ...isolatedTestEnvironment(process.env),
          DATABASE_URL: target.databaseUrl,
          TEST_DATABASE_URL: target.databaseUrl,
          ASSISTANT_TEST_TARGET_TOKEN: target.token,
        };
        await runOwnedCommand(
          'pnpm',
          ['migrate'],
          { cwd: packageFolder, env, stdio: ['ignore', 'pipe', 'pipe'] },
          60_000,
          (process) => {
            if (process) retryHistory.push(process);
            retryChild = process;
          },
        );
        await runOwnedCommand(
          'pnpm',
          ['migrate'],
          { cwd: packageFolder, env, stdio: ['ignore', 'pipe', 'pipe'] },
          30_000,
          (process) => {
            if (process) retryHistory.push(process);
            retryChild = process;
          },
        );

        const upgraded = postgres(target.databaseUrl, { max: 1, onnotice: () => {} });
        const db = createDb(target.databaseUrl);
        try {
          const [policyCount] =
            await upgraded`SELECT count(*)::int AS count FROM approval_policies WHERE agent_id=${owner}`;
          expect(policyCount?.count).toBe(1);
          const [approval] =
            await upgraded`SELECT status,created_policy_id FROM approvals WHERE id=${approvalId}`;
          expect(approval?.created_policy_id).toBe(keptPolicy);
          const [index] =
            await upgraded`SELECT i.indisunique,i.indisvalid,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='approval_policies_identity_idx'`;
          expect(index).toMatchObject({ indisunique: true, indisvalid: true });
          expect(index?.definition).toContain('(agent_id, tool_name, template_key, match, effect)');

          const decision = await resolveApproval(db, {
            approvalId,
            decision: 'approved',
            via: 'web',
            policy: {
              agentId: owner,
              toolName: 'gmail.send',
              templateKey: 'gmail.send.to_recipient',
              match: { recipient: 'dm01@example.test' },
              effect: 'allow',
            },
          });
          expect(decision.ok).toBe(true);
          const policies =
            await upgraded`SELECT id,enabled FROM approval_policies WHERE agent_id=${owner} AND tool_name='gmail.send' AND template_key='gmail.send.to_recipient'`;
          expect(policies).toEqual([{ id: keptPolicy, enabled: true }]);
          const [remembered] =
            await upgraded`SELECT status,created_policy_id FROM approvals WHERE id=${approvalId}`;
          expect(remembered).toEqual({ status: 'approved', created_policy_id: keptPolicy });
        } finally {
          await closeAll([
            { label: 'close upgraded SQL client', action: () => upgraded.end({ timeout: 5 }) },
            { label: 'close Drizzle SQL client', action: () => db.$client.end({ timeout: 5 }) },
          ]);
        }
      } finally {
        if (interruptedChild) await stopOwnedMigration(interruptedChild);
      }
    } catch (error) {
      primaryError = error;
    }

    const cleanupFailures: string[] = [];
    if (interruptedChild && !interruptedChild.quiesced) {
      await attemptCleanup(
        'stop owned migration process group',
        () => stopOwnedMigration(interruptedChild!),
        cleanupFailures,
      );
    }
    if (retryChild && !retryChild.quiesced) {
      await attemptCleanup(
        'stop owned retry migration process group',
        () => stopOwnedProcess(retryChild!),
        cleanupFailures,
      );
    }
    if (blockerClient) {
      await attemptCleanup(
        'close advisory-lock blocker client',
        () => blockerClient!.end({ timeout: 5 }),
        cleanupFailures,
      );
      blockerClient = undefined;
    }
    if (client) {
      await attemptCleanup(
        'close prefix migration client',
        () => client!.end({ timeout: 5 }),
        cleanupFailures,
      );
      client = undefined;
    }
    const cleanupAdmin = admin;
    if (created && cleanupAdmin) {
      await attemptCleanup(
        'drop owned test database',
        async () => {
          if (
            (interruptedChild && !interruptedChild.quiesced) ||
            (retryChild && !retryChild.quiesced)
          )
            throw new Error(
              'Refusing to drop the owned database while its migration process group is not quiescent',
            );
          await dropOwnedDatabaseIfPresent(cleanupAdmin, target);
        },
        cleanupFailures,
      );
    } else if (created) {
      cleanupFailures.push('drop owned test database: admin connection unavailable');
    }
    if (admin) {
      await attemptCleanup('close admin client', () => admin!.end({ timeout: 5 }), cleanupFailures);
      admin = undefined;
    }
    let tempFolderRemoved = false;
    const persistCleanupEvidence = async () => {
      await writeFile(
        diagnosticPath,
        JSON.stringify(
          {
            target: target.databaseName,
            token: target.token,
            tempFolder: prefixFolder,
            tempFolderRemoved,
            primaryError:
              primaryError instanceof Error
                ? (primaryError.stack ?? primaryError.message)
                : String(primaryError ?? ''),
            cleanupFailures,
            processOutput: {
              interrupted: interruptedChild?.output.value ?? null,
              retries: retryHistory.map((process) => process.output.value),
            },
            processQuiesced: (interruptedChild?.quiesced ?? true) && (retryChild?.quiesced ?? true),
            recordedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    };
    if (primaryError || cleanupFailures.length) {
      await attemptCleanup('preserve cleanup diagnostics', persistCleanupEvidence, cleanupFailures);
    }
    await attemptCleanup(
      'remove temporary migration folder',
      async () => {
        await rm(prefixFolder, { recursive: true, force: true });
        tempFolderRemoved = true;
      },
      cleanupFailures,
    );
    if (primaryError || cleanupFailures.length) {
      await attemptCleanup('update cleanup diagnostics', persistCleanupEvidence, cleanupFailures);
    }
    if (!primaryError && cleanupFailures.length)
      await attemptCleanup('finalize cleanup diagnostics', persistCleanupEvidence, cleanupFailures);
    if (primaryError || cleanupFailures.length) {
      const details = ` ${cleanupFailures.length ? `Cleanup failures: ${cleanupFailures.join(' | ')}. ` : ''}Diagnostic: ${diagnosticPath}`;
      throw new Error(`DM01 interruption test failed.${details}`, { cause: primaryError });
    }
  },
  180_000,
);
