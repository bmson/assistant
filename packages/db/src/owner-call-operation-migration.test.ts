import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  chatAdmissionExternalEventId,
  directOwnerCallRequestBinding,
  phoneCallOwnerActionGrantScopeFingerprint,
  phoneCallOwnerNumberReviewSourceFingerprint,
} from '@assistant/persistence';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertAllocatedTestDatabaseOwnership,
  assertAllocatedTestTargetMarker,
} from '../../../scripts/test-target.js';
import { createPostgresApprovalRepository } from './approval-repository.js';
import { createDb, type Db } from './client.js';
import {
  agents,
  approvalPolicies,
  approvals,
  conversations,
  messages,
  ownerCallGrantOperationSlots,
  ownerCallGrantOperations,
  tasks,
  toolCalls,
} from './schema.js';
import {
  allocateTestTarget,
  assertAllocatedTestTarget,
  isolatedTestEnvironment,
  testTargetMarkerPath,
} from './test-target.js';

const exec = promisify(execFile);
const folder = fileURLToPath(new URL('../drizzle/', import.meta.url));
const cwd = fileURLToPath(new URL('../', import.meta.url));
const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string }>;
};
let admin: ReturnType<typeof postgres> | undefined;
let target: ReturnType<typeof allocateTestTarget> | undefined;
let client: ReturnType<typeof postgres> | undefined;
let db: Db | undefined;

interface PrivateMarkerIdentity {
  dev: bigint;
  ino: bigint;
  uid: number;
}

function isDefiniteCreateRejection(
  error: unknown,
): error is InstanceType<typeof postgres.PostgresError> {
  return (
    error instanceof postgres.PostgresError && (error.code === '42P04' || error.code === '42501')
  );
}

async function createPrivateTargetMarker(
  markerPath: string,
  target: ReturnType<typeof allocateTestTarget>,
  parentToken: string,
): Promise<{ identity: PrivateMarkerIdentity; bytes: Buffer }> {
  const bytes = Buffer.from(
    JSON.stringify({
      databaseUrl: target.databaseUrl,
      token: target.token,
      parentToken,
    }),
  );
  if (bytes.length > 4096)
    throw new Error('Owner-call migration fixture marker exceeds its size bound');
  const marker = await open(
    markerPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await marker.writeFile(bytes);
    const stat = await marker.stat({ bigint: true });
    if (
      !stat.isFile() ||
      Number(stat.mode & 0o7777n) !== 0o600 ||
      stat.uid !== BigInt(process.getuid?.() ?? -1)
    )
      throw new Error(
        'Owner-call migration fixture marker was not created as a private regular file',
      );
    return {
      identity: { dev: stat.dev, ino: stat.ino, uid: Number(stat.uid) },
      bytes,
    };
  } finally {
    await marker.close();
  }
}

async function removeRejectedCreateMarker(
  markerPath: string,
  target: ReturnType<typeof allocateTestTarget>,
  parentToken: string,
  expected: { identity: PrivateMarkerIdentity; bytes: Buffer },
): Promise<void> {
  const canonicalName = assertAllocatedTestTarget({
    databaseUrl: target.databaseUrl,
    testDatabaseUrl: target.databaseUrl,
    token: target.token,
    kind: target.kind,
  });
  if (canonicalName !== target.databaseName)
    throw new Error('Owner-call migration fixture marker target identity changed');

  const marker = await open(
    markerPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await marker.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.dev !== expected.identity.dev ||
      stat.ino !== expected.identity.ino ||
      stat.size !== BigInt(expected.bytes.length) ||
      Number(stat.mode & 0o7777n) !== 0o600 ||
      Number(stat.uid) !== expected.identity.uid
    )
      throw new Error('Owner-call migration fixture marker identity changed; preserving marker');

    const buffer = Buffer.alloc(expected.bytes.length + 1);
    const { bytesRead } = await marker.read(buffer, 0, buffer.length, 0);
    const actualBytes = buffer.subarray(0, bytesRead);
    const afterRead = await marker.stat({ bigint: true });
    if (bytesRead !== expected.bytes.length || afterRead.size !== BigInt(expected.bytes.length))
      throw new Error('Owner-call migration fixture marker size changed; preserving marker');
    const markerData = JSON.parse(actualBytes.toString('utf8')) as {
      databaseUrl?: unknown;
      token?: unknown;
      parentToken?: unknown;
    };
    if (
      !actualBytes.equals(expected.bytes) ||
      markerData.databaseUrl !== target.databaseUrl ||
      markerData.token !== target.token ||
      markerData.parentToken !== parentToken
    )
      throw new Error('Owner-call migration fixture marker content changed; preserving marker');
  } finally {
    await marker.close();
  }

  const pathStat = await lstat(markerPath, { bigint: true });
  if (
    !pathStat.isFile() ||
    pathStat.isSymbolicLink() ||
    pathStat.dev !== expected.identity.dev ||
    pathStat.ino !== expected.identity.ino ||
    pathStat.size !== BigInt(expected.bytes.length) ||
    Number(pathStat.mode & 0o7777n) !== 0o600 ||
    Number(pathStat.uid) !== expected.identity.uid
  )
    throw new Error('Owner-call migration fixture marker path changed; preserving marker');
  await unlink(markerPath);
}

async function dropOwnedDatabase() {
  if (!admin || !target) return;
  // Validate private allocation intent even when the database is already absent;
  // never clear a replaced or mismatched marker as successful cleanup.
  assertAllocatedTestTargetMarker({
    databaseUrl: target.databaseUrl,
    testDatabaseUrl: target.databaseUrl,
    token: target.token,
    kind: target.kind,
  });
  const [owned] = await admin`
    SELECT shobj_description(oid,'pg_database') AS marker
    FROM pg_database WHERE datname=${target.databaseName}`;
  if (!owned) {
    await rm(testTargetMarkerPath(target.token), { force: true });
    return;
  }
  if (owned.marker !== `assistant-test-target:${target.token}`)
    throw new Error('Owner-call migration fixture cleanup ownership mismatch');
  await admin.unsafe(`DROP DATABASE "${target.databaseName}"`);
  await rm(testTargetMarkerPath(target.token), { force: true });
}

beforeAll(async () => {
  assertAllocatedTestTarget({
    databaseUrl: process.env.DATABASE_URL,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  });
  const parentTarget = assertAllocatedTestTargetMarker({
    databaseUrl: process.env.DATABASE_URL,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  });
  const parentDb = createDb(parentTarget.databaseUrl);
  try {
    await assertAllocatedTestDatabaseOwnership(parentDb, parentTarget);
  } finally {
    await parentDb.$client.end({ timeout: 5 });
  }
  target = allocateTestTarget(parentTarget.databaseUrl);
  const adminUrl = new URL(target.databaseUrl);
  adminUrl.pathname = '/postgres';
  admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  const prefixDir = await mkdtemp(join(tmpdir(), 'assistant-owner-call-0133-'));
  let created = false;
  let marker: { identity: PrivateMarkerIdentity; bytes: Buffer } | undefined;
  try {
    // Retain allocation intent before CREATE so a hard-killed test still has
    // an owned private marker for the separately bounded cleanup controller.
    const markerPath = testTargetMarkerPath(target.token);
    marker = await createPrivateTargetMarker(markerPath, target, parentTarget.token);
    try {
      await admin.unsafe(`CREATE DATABASE "${target.databaseName}"`);
      created = true;
    } catch (error) {
      if (isDefiniteCreateRejection(error) && marker) {
        try {
          await removeRejectedCreateMarker(markerPath, target, parentTarget.token, marker);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'CREATE DATABASE was rejected; private marker cleanup was not confirmed',
          );
        }
      }
      throw error;
    }
    await admin.unsafe(
      `COMMENT ON DATABASE "${target.databaseName}" IS 'assistant-test-target:${target.token}'`,
    );
    client = postgres(target.databaseUrl, { max: 1, onnotice: () => {} });
    await mkdir(join(prefixDir, 'meta'));
    const prefix = journal.entries.filter((entry) => entry.idx <= 132);
    if (prefix.length !== 133 || prefix.at(-1)?.idx !== 132)
      throw new Error('Expected the exact historical 0-132 migration prefix');
    await writeFile(
      join(prefixDir, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: prefix }),
    );
    for (const entry of prefix)
      await writeFile(
        join(prefixDir, `${entry.tag}.sql`),
        await readFile(join(folder, `${entry.tag}.sql`)),
      );
    await migrate(drizzle(client), { migrationsFolder: prefixDir });
    await client.end();
    client = undefined;
    const env = {
      ...isolatedTestEnvironment(process.env),
      DATABASE_URL: target.databaseUrl,
      TEST_DATABASE_URL: target.databaseUrl,
      ASSISTANT_TEST_TARGET_TOKEN: target.token,
    };
    await exec('pnpm', ['migrate'], { cwd, env, timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
    client = postgres(target.databaseUrl, { max: 1, onnotice: () => {} });
    const expectedFinalHash = createHash('sha256')
      .update(await readFile(join(folder, '0133_owner_call_grant_operation_receipts.sql')))
      .digest('hex');
    const [endpoint] = await client`
      SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1`;
    expect(endpoint?.hash).toBe(expectedFinalHash);
    const [ledgerCount] =
      await client`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    expect(ledgerCount?.count).toBe(134);
    const ledgerBeforeRerun = await client`
      SELECT hash,created_at::text AS "createdAt"
      FROM drizzle.__drizzle_migrations ORDER BY id`;
    await client.end();
    client = undefined;
    await exec('pnpm', ['migrate'], { cwd, env, timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
    client = postgres(target.databaseUrl, { max: 1, onnotice: () => {} });
    expect(
      await client`SELECT hash,created_at::text AS "createdAt" FROM drizzle.__drizzle_migrations ORDER BY id`,
    ).toEqual(ledgerBeforeRerun);
    db = createDb(target.databaseUrl);
  } catch (error) {
    if (client) {
      await client.end({ timeout: 5 });
      client = undefined;
    }
    if (created) await dropOwnedDatabase();
    target = undefined;
    throw error;
  } finally {
    await rm(prefixDir, { recursive: true, force: true });
  }
}, 180_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  if (db) {
    await db.$client.end({ timeout: 5 });
    db = undefined;
  }
  if (client) {
    await client.end({ timeout: 5 });
    client = undefined;
  }
  if (target) await dropOwnedDatabase();
  if (admin) {
    await admin.end({ timeout: 5 });
    admin = undefined;
  }
}, 30_000);

type Phase = 'registered' | 'admitted' | 'committed' | 'closed_no_effect' | 'rejected_no_effect';
interface OperationSeed {
  purpose: string;
  schemaVersion: number;
  operationVersion: number;
  ownerId: string;
  approvalId: string;
  grantId: string;
  taskId: string;
  toolCallId: string;
  slotGeneration: number;
  requestFingerprint: string;
  grantScopeFingerprint: string;
  phase: Phase;
  registeredAt: Date;
  reviewExpiresAt: Date;
  grantExpiresAt: Date;
  admittedAt: Date | null;
  committedAt: Date | null;
  closedAt: Date | null;
  rejectedAt: Date | null;
  createdPolicyId: string | null;
  wakeGeneration: number | null;
  updatedAt: Date;
}

function operationSeed(phase: Phase = 'registered'): OperationSeed {
  const registeredAt = new Date('2026-10-28T12:00:00.000Z');
  const admittedAt = phase === 'registered' ? null : new Date(registeredAt.getTime() + 1_000);
  const committedAt = phase === 'committed' ? new Date(registeredAt.getTime() + 2_000) : null;
  const closedAt = phase === 'closed_no_effect' ? new Date(registeredAt.getTime() + 2_000) : null;
  const rejectedAt =
    phase === 'rejected_no_effect' ? new Date(registeredAt.getTime() + 2_000) : null;
  const updatedAt = committedAt ?? closedAt ?? rejectedAt ?? admittedAt ?? registeredAt;
  return {
    purpose: 'owner-call-grant-operation.v1',
    schemaVersion: 1,
    operationVersion: 1,
    ownerId: randomUUID(),
    approvalId: randomUUID(),
    grantId: randomUUID(),
    taskId: randomUUID(),
    toolCallId: randomUUID(),
    slotGeneration: 1,
    requestFingerprint: 'a'.repeat(64),
    grantScopeFingerprint: 'b'.repeat(64),
    phase,
    registeredAt,
    reviewExpiresAt: new Date(registeredAt.getTime() + 10 * 60_000),
    grantExpiresAt: new Date(registeredAt.getTime() + 24 * 60 * 60_000),
    admittedAt,
    committedAt,
    closedAt,
    rejectedAt,
    createdPolicyId: phase === 'committed' ? randomUUID() : null,
    wakeGeneration: phase === 'committed' ? 1 : null,
    updatedAt,
  };
}

async function insertOperation(row: OperationSeed) {
  if (!client) throw new Error('Allocated PostgreSQL fixture is not available');
  await client`
    INSERT INTO owner_call_grant_operations (
      owner_id,approval_id,grant_id,purpose,schema_version,operation_version,task_id,tool_call_id,slot_generation,
      request_fingerprint,grant_scope_fingerprint,phase,registered_at,review_expires_at,
      grant_expires_at,admitted_at,committed_at,closed_at,rejected_at,created_policy_id,
      wake_generation,updated_at
    ) VALUES (
      ${row.ownerId},${row.approvalId},${row.grantId},${row.purpose},${row.schemaVersion},${row.operationVersion},${row.taskId},${row.toolCallId},
      ${row.slotGeneration},${row.requestFingerprint},${row.grantScopeFingerprint},${row.phase},
      ${row.registeredAt},${row.reviewExpiresAt},${row.grantExpiresAt},${row.admittedAt},
      ${row.committedAt},${row.closedAt},${row.rejectedAt},${row.createdPolicyId},
      ${row.wakeGeneration},${row.updatedAt}
    )`;
}

describe('owner-call operation migration 0133 on allocated PostgreSQL', () => {
  it('installs exact catalog objects and preserves the empty slot sentinel and bounded usage checks', async () => {
    if (!client) throw new Error('Allocated PostgreSQL fixture is not available');
    const tables = await client`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN (
        'owner_call_grant_operations','owner_call_grant_operation_slots','owner_call_grant_usage'
      ) ORDER BY table_name`;
    expect(tables.map((row) => row.table_name)).toEqual([
      'owner_call_grant_operation_slots',
      'owner_call_grant_operations',
      'owner_call_grant_usage',
    ]);
    const indexes = await client`
      SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public'
        AND indexname IN ('owner_call_grant_operations_pk','owner_call_grant_operations_slot_key',
          'owner_call_grant_operation_slots_pk','owner_call_grant_usage_pk') ORDER BY indexname`;
    expect(indexes).toHaveLength(4);
    expect(
      indexes.find((row) => row.indexname === 'owner_call_grant_operations_slot_key')?.indexdef,
    ).toContain('(owner_id, approval_id, grant_id, slot_generation)');
    const foreignKey = await client`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='owner_call_grant_operation_slots'::regclass
        AND conname='owner_call_grant_operation_slots_current_fk'`;
    expect(foreignKey[0]?.definition).toContain(
      'FOREIGN KEY (owner_id, approval_id, current_grant_id, generation)',
    );
    expect(foreignKey[0]?.definition).toContain(
      'REFERENCES owner_call_grant_operations(owner_id, approval_id, grant_id, slot_generation)',
    );
    const trigger = await client`
      SELECT t.tgenabled,p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid='owner_call_grant_operations'::regclass
        AND t.tgname='owner_call_grant_operation_transition_guard' AND NOT t.tgisinternal`;
    expect(trigger).toEqual([
      { tgenabled: 'O', proname: 'owner_call_grant_operation_transition_guard' },
    ]);
    const emptyOwner = randomUUID(),
      emptyApproval = randomUUID();
    await client`INSERT INTO owner_call_grant_operation_slots(owner_id,approval_id)
      VALUES (${emptyOwner},${emptyApproval})`;
    expect(
      await client`SELECT generation,current_grant_id FROM owner_call_grant_operation_slots
      WHERE owner_id=${emptyOwner} AND approval_id=${emptyApproval}`,
    ).toEqual([{ generation: 0, current_grant_id: null }]);
    await expect(client`INSERT INTO owner_call_grant_operation_slots(owner_id,approval_id,generation,current_grant_id)
      VALUES (${randomUUID()},${randomUUID()},1,null)`).rejects.toMatchObject({ code: '23514' });
    await expect(client`INSERT INTO owner_call_grant_operation_slots(owner_id,approval_id,generation,current_grant_id)
      VALUES (${randomUUID()},${randomUUID()},0,${randomUUID()})`).rejects.toMatchObject({
      code: '23514',
    });
    const usageOwner = randomUUID(),
      policyId = randomUUID();
    await expect(client`INSERT INTO owner_call_grant_usage(owner_id,policy_id,grant_scope_fingerprint,events)
      VALUES (${usageOwner},${policyId},${'c'.repeat(64)},'{}'::jsonb)`).rejects.toMatchObject({
      code: '23514',
    });
    await expect(client`INSERT INTO owner_call_grant_usage(owner_id,policy_id,grant_scope_fingerprint,events)
      VALUES (${usageOwner},${policyId},${'d'.repeat(64)},${JSON.stringify(Array.from({ length: 101 }, (_, i) => ({ toolCallId: `${i}`, at: new Date().toISOString(), costUsdMicros: 1 })))}::jsonb)`).rejects.toMatchObject(
      { code: '23514' },
    );
  });

  it('enforces slot pointers, operation phase shape, and distinct operation keys', async () => {
    if (!client) throw new Error('Allocated PostgreSQL fixture is not available');
    const row = operationSeed();
    await insertOperation(row);
    await expect(client`INSERT INTO owner_call_grant_operations (
      owner_id,approval_id,grant_id,task_id,tool_call_id,slot_generation,
      request_fingerprint,grant_scope_fingerprint,phase,registered_at,review_expires_at,
      grant_expires_at,admitted_at,committed_at,closed_at,rejected_at,created_policy_id,
      wake_generation,updated_at
    ) VALUES (${row.ownerId},${row.approvalId},${row.grantId},${row.taskId},${row.toolCallId},
      ${row.slotGeneration},${row.requestFingerprint},${row.grantScopeFingerprint},'registered',
      ${row.registeredAt},${row.reviewExpiresAt},${row.grantExpiresAt},null,null,null,null,null,null,${row.updatedAt})`).rejects.toMatchObject(
      { code: '23505' },
    );
    await expect(client`UPDATE owner_call_grant_operations SET phase='admitted'
      WHERE owner_id=${row.ownerId} AND approval_id=${row.approvalId} AND grant_id=${row.grantId}`).rejects.toMatchObject(
      { code: '23514' },
    );
    await expect(client`INSERT INTO owner_call_grant_operation_slots(owner_id,approval_id,generation,current_grant_id)
      VALUES (${randomUUID()},${randomUUID()},1,${randomUUID()})`).rejects.toMatchObject({
      code: '23503',
    });
  });

  it.each([
    'purpose',
    'schema version',
    'operation version',
    'zero generation',
    'request fingerprint',
    'scope fingerprint',
    'review deadline',
    'grant deadline',
    'updated before registration',
    'admission at review expiry',
    'commit at review expiry',
    'committed zero wake generation',
  ])('rejects invalid inserted operation %s', async (invalid) => {
    if (!client) throw new Error('Allocated PostgreSQL fixture is not available');
    const row = operationSeed();
    if (invalid === 'purpose') row.purpose = 'different-purpose';
    else if (invalid === 'schema version') row.schemaVersion = 2;
    else if (invalid === 'operation version') row.operationVersion = 2;
    else if (invalid === 'zero generation') row.slotGeneration = 0;
    else if (invalid === 'request fingerprint') row.requestFingerprint = 'not-a-hash';
    else if (invalid === 'scope fingerprint') row.grantScopeFingerprint = 'not-a-hash';
    else if (invalid === 'review deadline') row.reviewExpiresAt = row.registeredAt;
    else if (invalid === 'grant deadline') row.grantExpiresAt = row.registeredAt;
    else if (invalid === 'updated before registration')
      row.updatedAt = new Date(row.registeredAt.getTime() - 1);
    else if (invalid === 'admission at review expiry') {
      row.phase = 'admitted';
      row.admittedAt = row.reviewExpiresAt;
      row.updatedAt = row.reviewExpiresAt;
    } else {
      row.phase = 'committed';
      row.admittedAt = new Date(row.registeredAt.getTime() + 1_000);
      row.committedAt =
        invalid === 'commit at review expiry'
          ? row.reviewExpiresAt
          : new Date(row.registeredAt.getTime() + 2_000);
      row.createdPolicyId = randomUUID();
      row.wakeGeneration = invalid === 'committed zero wake generation' ? 0 : 1;
      row.updatedAt = row.committedAt;
    }
    await expect(insertOperation(row)).rejects.toMatchObject({ code: '23514' });
    expect(
      await client`SELECT grant_id FROM owner_call_grant_operations
      WHERE owner_id=${row.ownerId} AND approval_id=${row.approvalId} AND grant_id=${row.grantId}`,
    ).toEqual([]);
  });

  it.each(['registered_at', 'review_expires_at', 'grant_expires_at', 'updated_at'])(
    'rejects a PostgreSQL infinite %s timestamp without a JavaScript date shortcut',
    async (column) => {
      if (!client) throw new Error('Allocated PostgreSQL fixture is not available');
      const row = operationSeed();
      const timestamps: Record<string, string> = {
        registered_at: `'${row.registeredAt.toISOString()}'::timestamptz`,
        review_expires_at: `'${row.reviewExpiresAt.toISOString()}'::timestamptz`,
        grant_expires_at: `'${row.grantExpiresAt.toISOString()}'::timestamptz`,
        updated_at: `'${row.updatedAt.toISOString()}'::timestamptz`,
      };
      timestamps[column] = "'infinity'::timestamptz";
      await expect(
        client.unsafe(`INSERT INTO owner_call_grant_operations (
        owner_id,approval_id,grant_id,task_id,tool_call_id,slot_generation,
        request_fingerprint,grant_scope_fingerprint,phase,registered_at,review_expires_at,
        grant_expires_at,updated_at
      ) VALUES ('${row.ownerId}','${row.approvalId}','${row.grantId}','${row.taskId}',
        '${row.toolCallId}',1,'${row.requestFingerprint}','${row.grantScopeFingerprint}',
        'registered',${timestamps.registered_at},${timestamps.review_expires_at},
        ${timestamps.grant_expires_at},${timestamps.updated_at})`),
      ).rejects.toMatchObject({ code: '23514' });
      expect(
        await client`SELECT grant_id FROM owner_call_grant_operations
        WHERE owner_id=${row.ownerId} AND approval_id=${row.approvalId} AND grant_id=${row.grantId}`,
      ).toEqual([]);
    },
  );

  it.each([
    ['admitted_at', 'admitted'],
    ['committed_at', 'committed'],
    ['closed_at', 'closed_no_effect'],
    ['rejected_at', 'rejected_no_effect'],
  ] as const)(
    'rejects PostgreSQL infinite optional %s on an otherwise valid %s operation',
    async (column, phase) => {
      if (!client) throw new Error('Allocated PostgreSQL fixture is not available');
      await expect(insertOperation(operationSeed(phase))).resolves.toBeUndefined();
      const row = operationSeed(phase);
      const timestamp = (value: Date | null) =>
        value ? `'${value.toISOString()}'::timestamptz` : 'NULL';
      const timestamps: Record<string, string> = {
        registered_at: timestamp(row.registeredAt),
        review_expires_at: timestamp(row.reviewExpiresAt),
        grant_expires_at: timestamp(row.grantExpiresAt),
        admitted_at: timestamp(row.admittedAt),
        committed_at: timestamp(row.committedAt),
        closed_at: timestamp(row.closedAt),
        rejected_at: timestamp(row.rejectedAt),
        updated_at: timestamp(row.updatedAt),
      };
      timestamps[column] = "'infinity'::timestamptz";
      await expect(
        client.unsafe(`INSERT INTO owner_call_grant_operations (
        owner_id,approval_id,grant_id,purpose,schema_version,operation_version,task_id,tool_call_id,
        slot_generation,request_fingerprint,grant_scope_fingerprint,phase,registered_at,
        review_expires_at,grant_expires_at,admitted_at,committed_at,closed_at,rejected_at,
        created_policy_id,wake_generation,updated_at
      ) VALUES (
        '${row.ownerId}','${row.approvalId}','${row.grantId}','${row.purpose}',${row.schemaVersion},
        ${row.operationVersion},'${row.taskId}','${row.toolCallId}',${row.slotGeneration},
        '${row.requestFingerprint}','${row.grantScopeFingerprint}','${row.phase}',
        ${timestamps.registered_at},${timestamps.review_expires_at},${timestamps.grant_expires_at},
        ${timestamps.admitted_at},${timestamps.committed_at},${timestamps.closed_at},
        ${timestamps.rejected_at},${row.createdPolicyId ? `'${row.createdPolicyId}'::uuid` : 'NULL'},
        ${row.wakeGeneration ?? 'NULL'},${timestamps.updated_at})`),
      ).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'owner_call_grant_operations_phase_check',
      });
      expect(
        await client`SELECT grant_id FROM owner_call_grant_operations
        WHERE owner_id=${row.ownerId} AND approval_id=${row.approvalId} AND grant_id=${row.grantId}`,
      ).toEqual([]);
    },
  );

  it.each([
    ['registered', 'admitted'],
    ['registered', 'closed_no_effect'],
    ['registered', 'rejected_no_effect'],
    ['admitted', 'committed'],
    ['admitted', 'closed_no_effect'],
    ['admitted', 'rejected_no_effect'],
  ] as const)('allows the legal operation edge %s -> %s', async (from, to) => {
    if (!client) throw new Error('Allocated PostgreSQL fixture is not available');
    const row = operationSeed(from);
    await insertOperation(row);
    const stamp = new Date(row.registeredAt.getTime() + (from === 'registered' ? 1_000 : 2_000));
    if (to === 'admitted')
      await client`UPDATE owner_call_grant_operations SET phase='admitted',admitted_at=${stamp},updated_at=${stamp}
        WHERE owner_id=${row.ownerId} AND approval_id=${row.approvalId} AND grant_id=${row.grantId}`;
    else if (to === 'committed')
      await client`UPDATE owner_call_grant_operations SET phase='committed',committed_at=${stamp},
        created_policy_id=${randomUUID()},wake_generation=1,updated_at=${stamp}
        WHERE owner_id=${row.ownerId} AND approval_id=${row.approvalId} AND grant_id=${row.grantId}`;
    else if (to === 'closed_no_effect')
      await client`UPDATE owner_call_grant_operations SET phase='closed_no_effect',closed_at=${stamp},updated_at=${stamp}
        WHERE owner_id=${row.ownerId} AND approval_id=${row.approvalId} AND grant_id=${row.grantId}`;
    else
      await client`UPDATE owner_call_grant_operations SET phase='rejected_no_effect',rejected_at=${stamp},updated_at=${stamp}
        WHERE owner_id=${row.ownerId} AND approval_id=${row.approvalId} AND grant_id=${row.grantId}`;
    const [saved] = await client`SELECT phase FROM owner_call_grant_operations
      WHERE owner_id=${row.ownerId} AND approval_id=${row.approvalId} AND grant_id=${row.grantId}`;
    expect(saved?.phase).toBe(to);
  });

  it.each([
    ['registered', 'admitted', "closed_at=registered_at + interval '3 seconds'"],
    ['admitted', 'committed', "admitted_at=admitted_at + interval '1 millisecond'"],
    ['admitted', 'closed_no_effect', "admitted_at=admitted_at + interval '1 millisecond'"],
    ['admitted', 'rejected_no_effect', "admitted_at=admitted_at + interval '1 millisecond'"],
  ] as const)(
    'rejects forbidden companion-field mutation during %s -> %s',
    async (from, to, forbidden) => {
      if (!client) throw new Error('Allocated PostgreSQL fixture is not available');
      const row = operationSeed(from);
      await insertOperation(row);
      const [before] = await client`SELECT * FROM owner_call_grant_operations
      WHERE owner_id=${row.ownerId} AND approval_id=${row.approvalId} AND grant_id=${row.grantId}`;
      const stamp = "registered_at + interval '3 seconds'";
      const allowed =
        to === 'admitted'
          ? `admitted_at=${stamp}`
          : to === 'committed'
            ? `committed_at=${stamp},created_policy_id='${randomUUID()}'::uuid,wake_generation=1`
            : to === 'closed_no_effect'
              ? `closed_at=${stamp}`
              : `rejected_at=${stamp}`;
      await expect(
        client.unsafe(
          `UPDATE owner_call_grant_operations SET phase='${to}',${allowed},updated_at=${stamp},${forbidden} WHERE owner_id='${row.ownerId}' AND approval_id='${row.approvalId}' AND grant_id='${row.grantId}'`,
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
      const [after] = await client`SELECT * FROM owner_call_grant_operations
      WHERE owner_id=${row.ownerId} AND approval_id=${row.approvalId} AND grant_id=${row.grantId}`;
      expect(after).toEqual(before);
    },
  );

  it.each([
    'owner_id',
    'approval_id',
    'grant_id',
    'purpose',
    'schema_version',
    'operation_version',
    'task_id',
    'tool_call_id',
    'slot_generation',
    'request_fingerprint',
    'grant_scope_fingerprint',
    'registered_at',
    'review_expires_at',
    'grant_expires_at',
  ])('rejects mutation of immutable operation identity column %s', async (column) => {
    if (!client) throw new Error('Allocated PostgreSQL fixture is not available');
    const row = operationSeed();
    await insertOperation(row);
    const alternatives: Record<string, string> = {
      owner_id: `'${randomUUID()}'::uuid`,
      approval_id: `'${randomUUID()}'::uuid`,
      grant_id: `'${randomUUID()}'::uuid`,
      purpose: `'other-purpose'`,
      schema_version: '2',
      operation_version: '2',
      task_id: `'${randomUUID()}'::uuid`,
      tool_call_id: `'${randomUUID()}'::uuid`,
      slot_generation: '2',
      request_fingerprint: `'${'e'.repeat(64)}'`,
      grant_scope_fingerprint: `'${'f'.repeat(64)}'`,
      registered_at: `registered_at + interval '1 second'`,
      review_expires_at: `review_expires_at + interval '1 second'`,
      grant_expires_at: `grant_expires_at + interval '1 second'`,
    };
    const [before] = await client`SELECT * FROM owner_call_grant_operations
      WHERE owner_id=${row.ownerId} AND approval_id=${row.approvalId} AND grant_id=${row.grantId}`;
    await expect(
      client.unsafe(
        `UPDATE owner_call_grant_operations SET phase='admitted',admitted_at=registered_at + interval '1 second',updated_at=registered_at + interval '1 second',${column}=${alternatives[column]} WHERE owner_id='${row.ownerId}' AND approval_id='${row.approvalId}' AND grant_id='${row.grantId}'`,
      ),
    ).rejects.toMatchObject({ code: 'P0001' });
    const [after] = await client`SELECT * FROM owner_call_grant_operations
      WHERE owner_id=${row.ownerId} AND approval_id=${row.approvalId} AND grant_id=${row.grantId}`;
    expect(after).toEqual(before);
  });

  it.each([
    ['registered', 'committed'],
    ['admitted', 'registered'],
    ['registered', 'registered'],
    ['admitted', 'admitted'],
    ['committed', 'committed'],
    ['closed_no_effect', 'closed_no_effect'],
    ['rejected_no_effect', 'rejected_no_effect'],
  ] as const)('rejects invalid or terminal rewrite %s -> %s', async (from, to) => {
    if (!client) throw new Error('Allocated PostgreSQL fixture is not available');
    const row = operationSeed(from);
    await insertOperation(row);
    await expect(client`UPDATE owner_call_grant_operations SET phase=${to},updated_at=updated_at + interval '1 second'
      WHERE owner_id=${row.ownerId} AND approval_id=${row.approvalId} AND grant_id=${row.grantId}`).rejects.toMatchObject(
      { code: 'P0001' },
    );
    const [after] = await client`SELECT phase,updated_at FROM owner_call_grant_operations
      WHERE owner_id=${row.ownerId} AND approval_id=${row.approvalId} AND grant_id=${row.grantId}`;
    expect(after?.phase).toBe(from);
    expect(after?.updated_at).toEqual(row.updatedAt);
  });

  it('rolls back real approval, policy, task wake, and admitted operation when commit trigger rejects', async () => {
    if (!db || !client) throw new Error('Allocated PostgreSQL fixture is not available');
    vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'true');
    const ownerId = randomUUID();
    const conversationId = randomUUID(),
      taskId = randomUUID(),
      messageId = randomUUID();
    const clientOperationId = randomUUID();
    const text = 'Call +14155550123 now.';
    const args = { brief: { to: '+14155550123', maxMinutes: 8, goal: 'Discuss my appointment.' } };
    await db.insert(agents).values({
      id: ownerId,
      name: `op-${ownerId}`,
      email: `${ownerId}@op.invalid`,
      workspacePrefix: `op/${ownerId}`,
    });
    await db
      .insert(conversations)
      .values({ id: conversationId, agentId: ownerId, channel: 'chat', trust: 'owner' });
    const triggerPayload = {
      source: 'chat',
      agentId: ownerId,
      conversationId,
      trust: 'owner',
      payload: {
        text,
        triggerMessageId: messageId,
        chatAdmission: {
          protocol: 'owner-chat-v1',
          clientOperationId,
          requestHash: 'a'.repeat(64),
          triggerMessageId: messageId,
          phase: 'queued',
        },
      },
    };
    await db.insert(tasks).values({
      id: taskId,
      agentId: ownerId,
      conversationId,
      type: 'chat_turn',
      trust: 'owner',
      status: 'waiting_approval',
      trigger: triggerPayload,
      externalEventId: chatAdmissionExternalEventId({
        agentId: ownerId,
        conversationId,
        clientOperationId,
      }),
    });
    await db.insert(messages).values({
      id: messageId,
      conversationId,
      taskId,
      role: 'user',
      origin: 'owner',
      text,
      parts: [{ type: 'text', text }],
    });
    const created = await createPostgresApprovalRepository(db).create({
      taskId,
      step: 0,
      toolName: 'phone.call',
      args,
      decision: {},
      summary: 'Call the requested number',
    });
    const approvalId = created.approvalId,
      toolCallId = created.toolCallId;
    const now = new Date();
    const grantId = randomUUID();
    const match = {
      schemaVersion: 2 as const,
      grantId,
      action: 'phone.call' as const,
      recipientE164: '+14155550123',
      maxMinutes: 8,
      maxCallsPerHour: 1,
      maxCallsPerDay: 1,
      maxCostUsdMicrosPerCall: 800_000,
      maxCostUsdMicrosPerDay: 800_000,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    };
    const requestFingerprint = phoneCallOwnerNumberReviewSourceFingerprint(args);
    const grantScopeFingerprint = phoneCallOwnerActionGrantScopeFingerprint(match);
    if (!requestFingerprint || !grantScopeFingerprint)
      throw new Error('Fixture fingerprints did not bind');
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    const [message] = await db.select().from(messages).where(eq(messages.id, messageId));
    if (!task || !conversation || !message)
      throw new Error('Persisted owner request fixture is incomplete');
    const directOwnerRequest = directOwnerCallRequestBinding(
      task,
      conversation,
      message,
      'waiting_approval',
    );
    if (!directOwnerRequest) throw new Error('Fixture owner request did not bind');
    const operationRow = {
      ownerId,
      approvalId,
      grantId,
      taskId,
      toolCallId,
      slotGeneration: 1,
      requestFingerprint,
      grantScopeFingerprint,
      phase: 'admitted' as const,
      registeredAt: now,
      reviewExpiresAt: new Date(now.getTime() + 10 * 60_000),
      grantExpiresAt: new Date(match.expiresAt),
      admittedAt: now,
      committedAt: null,
      closedAt: null,
      rejectedAt: null,
      createdPolicyId: null,
      wakeGeneration: null,
      updatedAt: now,
    };
    await db.insert(ownerCallGrantOperations).values(operationRow);
    await db.insert(ownerCallGrantOperationSlots).values({
      ownerId,
      approvalId,
      purpose: 'owner-call-grant-operation.v1',
      schemaVersion: 1,
      generation: 1,
      currentGrantId: grantId,
    });
    const binding = {
      expectedApprovalId: approvalId,
      expectedAgentId: ownerId,
      expectedTaskId: taskId,
      expectedToolCallId: toolCallId,
      sourceArgsFingerprint: requestFingerprint,
      reviewIssuedAt: now.toISOString(),
      reviewExpiresAt: operationRow.reviewExpiresAt.toISOString(),
      validityDays: 1 as const,
      directOwnerRequest,
      match,
      operation: {
        ownerId,
        approvalId,
        grantId,
        taskId,
        toolCallId,
        slotGeneration: 1,
        requestFingerprint,
        grantScopeFingerprint,
      },
    };
    const slotKey = and(
      eq(ownerCallGrantOperationSlots.ownerId, ownerId),
      eq(ownerCallGrantOperationSlots.approvalId, approvalId),
    );
    const [slotBeforeResolve] = await db.select().from(ownerCallGrantOperationSlots).where(slotKey);
    if (!slotBeforeResolve) throw new Error('Operation slot sentinel fixture is incomplete');
    expect(slotBeforeResolve).toMatchObject({ generation: 1, currentGrantId: grantId });
    const fn = `test_owner_call_fail_${randomUUID().replaceAll('-', '')}`;
    const trg = `${fn}_trigger`;
    await client.unsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.grant_id='${grantId}'::uuid AND NEW.phase='committed' THEN
        RAISE EXCEPTION 'injected owner call receipt commit failure';
      END IF;
      RETURN NEW;
    END; $$`);
    await client.unsafe(`CREATE TRIGGER ${trg} BEFORE UPDATE ON owner_call_grant_operations
      FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      const resolution = await createPostgresApprovalRepository(db)
        .resolve({
          approvalId,
          expectedAgentId: ownerId,
          decision: 'approved',
          via: 'web',
          policy: {
            agentId: ownerId,
            toolName: 'phone.call',
            templateKey: 'phone.call.owner_action.v2',
            match,
            effect: 'allow',
          },
          ownerCallActionGrant: binding,
        })
        .then(
          (value) => ({ value, error: undefined as unknown }),
          (error: unknown) => ({ value: undefined, error }),
        );
      expect(resolution.value).toBeUndefined();
      const causes: Array<Record<string, unknown>> = [];
      let cause: unknown = resolution.error;
      for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth += 1) {
        const record = cause as Record<string, unknown>;
        causes.push(record);
        cause = record.cause;
      }
      expect(
        causes.some(
          (error) =>
            error.code === 'P0001' &&
            error.message === 'injected owner call receipt commit failure',
        ),
      ).toBe(true);
      const [savedApproval] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
      const [savedCall] = await db.select().from(toolCalls).where(eq(toolCalls.id, toolCallId));
      const [savedTask] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      const [savedOperation] = await db
        .select()
        .from(ownerCallGrantOperations)
        .where(
          and(
            eq(ownerCallGrantOperations.ownerId, ownerId),
            eq(ownerCallGrantOperations.approvalId, approvalId),
          ),
        );
      const [savedSlotAfterFailure] = await db
        .select()
        .from(ownerCallGrantOperationSlots)
        .where(slotKey);
      expect(savedApproval?.status).toBe('pending');
      expect(savedCall?.status).toBe('awaiting_approval');
      expect(savedTask).toMatchObject({ status: 'waiting_approval', queueGeneration: 0 });
      expect(savedOperation).toMatchObject({
        phase: 'admitted',
        createdPolicyId: null,
        wakeGeneration: null,
      });
      expect(savedSlotAfterFailure).toEqual(slotBeforeResolve);
      expect(
        await db.select().from(approvalPolicies).where(eq(approvalPolicies.agentId, ownerId)),
      ).toEqual([]);
    } finally {
      await client.unsafe(`DROP TRIGGER IF EXISTS ${trg} ON owner_call_grant_operations`);
      await client.unsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
  });
}, 60_000);

describe('private owner-call allocation marker cleanup', () => {
  it('deletes the owned marker and rejects a same-content replacement inode', async () => {
    const parent = target;
    if (!parent) throw new Error('PostgreSQL fixture target was not initialized');
    const token = randomUUID().replaceAll('-', '').slice(0, 24);
    const markerTarget = allocateTestTarget(parent.databaseUrl, token);
    const markerPath = testTargetMarkerPath(markerTarget.token);
    let cleanupExpected: { identity: PrivateMarkerIdentity; bytes: Buffer } | undefined;
    let failure: unknown;
    let cleanupFailure: unknown;
    let heldOriginal: Awaited<ReturnType<typeof open>> | undefined;

    try {
      const successful = await createPrivateTargetMarker(markerPath, markerTarget, parent.token);
      cleanupExpected = successful;
      await removeRejectedCreateMarker(markerPath, markerTarget, parent.token, successful);
      cleanupExpected = undefined;
      await expect(lstat(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });

      const original = await createPrivateTargetMarker(markerPath, markerTarget, parent.token);
      cleanupExpected = original;
      heldOriginal = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const heldStat = await heldOriginal.stat({ bigint: true });
      expect(heldStat.dev).toBe(original.identity.dev);
      expect(heldStat.ino).toBe(original.identity.ino);
      const pathStat = await lstat(markerPath, { bigint: true });
      expect(pathStat.dev).toBe(original.identity.dev);
      expect(pathStat.ino).toBe(original.identity.ino);
      await unlink(markerPath);
      cleanupExpected = undefined;
      const replacementExpected = await createPrivateTargetMarker(
        markerPath,
        markerTarget,
        parent.token,
      );
      cleanupExpected = replacementExpected;
      expect(replacementExpected.identity.dev).toBe(original.identity.dev);
      expect(replacementExpected.identity.ino).not.toBe(original.identity.ino);
      await expect(
        removeRejectedCreateMarker(markerPath, markerTarget, parent.token, original),
      ).rejects.toThrow('marker identity changed');
      expect(await readFile(markerPath)).toEqual(replacementExpected.bytes);
      const replacementPathStat = await lstat(markerPath, { bigint: true });
      expect(replacementPathStat.ino).toBe(replacementExpected.identity.ino);
      await removeRejectedCreateMarker(markerPath, markerTarget, parent.token, replacementExpected);
      cleanupExpected = undefined;
    } catch (error) {
      failure = error;
    }

    if (heldOriginal) {
      try {
        await heldOriginal.close();
      } catch (error) {
        cleanupFailure = error;
      }
    }
    if (cleanupExpected) {
      try {
        await removeRejectedCreateMarker(markerPath, markerTarget, parent.token, cleanupExpected);
      } catch (error) {
        cleanupFailure = cleanupFailure
          ? new AggregateError([cleanupFailure, error], 'Marker cleanup was incomplete')
          : error;
      }
    }
    if (failure && cleanupFailure)
      throw new AggregateError([failure, cleanupFailure], 'Marker helper case and cleanup failed');
    if (failure) throw failure;
    if (cleanupFailure) throw cleanupFailure;
  });
});
