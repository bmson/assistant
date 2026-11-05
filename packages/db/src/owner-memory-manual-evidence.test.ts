import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { OwnerEditorScope } from '@assistant/persistence/owner-editor';
import type { SQL } from 'drizzle-orm';
import { eq, getTableName, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { PgDialect } from 'drizzle-orm/pg-core';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertAllocatedTestDatabaseOwnership,
  assertAllocatedTestTargetMarker,
} from '../../../scripts/test-target.js';
import { projectManualOwnerMemoryCorrection } from '../../persistence/src/owner-memory-manual-projection.js';
import { createDb, type Db } from './client.js';
import { rotatePostgresOwnerEditorEpoch } from './owner-editor-repository.js';
import { collectPostgresManualOwnerMemoryEvidence } from './owner-memory-manual-evidence.js';
import {
  agents,
  contacts,
  importSources,
  memories,
  memoryImportLineage,
  memoryTombstones,
} from './schema.js';
import { allocateTestTarget, testTargetMarkerPath } from './test-target.js';

const PG_ENABLED = Boolean(process.env.ASSISTANT_TEST_TARGET_TOKEN);
const parentTarget = PG_ENABLED
  ? assertAllocatedTestTargetMarker({
      databaseUrl: process.env.DATABASE_URL,
      testDatabaseUrl: process.env.TEST_DATABASE_URL,
      token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
      kind: process.env.ASSISTANT_TEST_TARGET_KIND === 'restore' ? 'restore' : 'standard',
    })
  : undefined;
const migrationsFolder = fileURLToPath(new URL('../drizzle/', import.meta.url));
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

type ChildTarget = ReturnType<typeof allocateTestTarget>;
type NativeTx = Parameters<Parameters<Db['transaction']>[0]>[0];
type PrivateMarker = {
  path: string;
  bytes: Buffer;
  dev: bigint;
  ino: bigint;
  uid: number;
};
type Fixture = {
  memoryId: string;
  oldContent: string;
  oldHash: string;
  replacementContent: string;
  replacementHash: string;
  contactId: string | null;
};
type Manifest = {
  version: 2;
  driver: 'postgres';
  ownerId: string;
  memoryId: string;
  observedAt: string;
  memory: {
    id: string;
    agentId: string;
    content: string;
    contentHash: string;
    source: string | null;
    sourceTaskId: string | null;
    subjectContactId: string | null;
  };
  oldHashTombstone: {
    collection: string;
    key: string;
    state: string;
    value: null;
    nativeVersion: null;
  };
  newHashTombstone: {
    collection: string;
    key: string;
    state: string;
    value: null;
    nativeVersion: null;
  };
  subjectContact: null | {
    collection: 'contacts';
    key: string;
    state: 'present';
    value: {
      id: string;
      name: string;
      aliases: string[];
      trust: string;
      identityAuthority: string | null;
    };
    nativeVersion: { kind: 'postgres_timestamp'; value: string };
  };
  lineageQuery: {
    collection: string;
    scope: { memoryId: string };
    limit: number;
    complete: boolean;
    keys: string[];
  };
  replacement: { content: string; contentHash: string };
};
type QueryTrace = {
  tables: string[];
  limits: Array<{ table: string | undefined; value: number }>;
  tombstonePredicates: unknown[][];
  contactReads: number;
  mutations: string[];
  rawStatements: string[];
};
type QueryContext = { table?: PgTable; tableName?: string; lineageReadNotified?: boolean };

let admin: ReturnType<typeof postgres> | undefined;
let childTarget: ChildTarget | undefined;
let childDb: Db | undefined;
let childMarker: PrivateMarker | undefined;
let ownerId = '';
let ownerEpoch = '';

function newTrace(): QueryTrace {
  return {
    tables: [],
    limits: [],
    tombstonePredicates: [],
    contactReads: 0,
    mutations: [],
    rawStatements: [],
  };
}

/**
 * Observes actual Drizzle SELECT builders while preserving their native
 * execution. Collector DML methods and non-SELECT raw SQL are recorded so a
 * passing observation cannot quietly perform an application write.
 */
function traceTransaction(
  tx: NativeTx,
  trace: QueryTrace,
  afterLineageRead?: () => Promise<void>,
): NativeTx {
  const dialect = new PgDialect();
  const query = (builder: unknown, context: QueryContext): unknown =>
    new Proxy(builder as object, {
      get(target, property) {
        const member = Reflect.get(target, property, target);
        if (property === 'then' && typeof member === 'function') {
          return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
            member.call(
              target,
              (value: unknown) => {
                if (
                  context.tableName === 'memory_import_lineage' &&
                  afterLineageRead &&
                  !context.lineageReadNotified
                ) {
                  context.lineageReadNotified = true;
                  return Promise.resolve()
                    .then(() => afterLineageRead())
                    .then(() => resolve(value), reject);
                }
                return resolve(value);
              },
              reject,
            );
        }
        if (typeof member !== 'function') return member;
        return (...args: unknown[]) => {
          if (property === 'from' && args[0] && typeof args[0] === 'object') {
            context.table = args[0] as PgTable;
            context.tableName = getTableName(context.table);
            trace.tables.push(context.tableName);
            if (context.tableName === 'contacts') trace.contactReads++;
          } else if (property === 'limit' && typeof args[0] === 'number') {
            trace.limits.push({ table: context.tableName, value: args[0] });
          } else if (property === 'where' && context.tableName === 'memory_tombstones') {
            try {
              const condition = args[0] as SQL;
              trace.tombstonePredicates.push(dialect.sqlToQuery(condition).params);
            } catch {
              trace.mutations.push('uninspectable_tombstone_predicate');
            }
          }
          const result = member.apply(target, args);
          return result && typeof result === 'object' ? query(result, context) : result;
        };
      },
    });

  return new Proxy(tx, {
    get(target, property) {
      if (property === 'insert' || property === 'update' || property === 'delete') {
        return (...args: unknown[]) => {
          trace.mutations.push(String(property));
          const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
          return method.apply(target, args);
        };
      }
      if (property === 'select') {
        return (...args: unknown[]) => {
          const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
          return query(method.apply(target, args), {});
        };
      }
      if (property === 'execute') {
        return (statement: SQL) => {
          const rendered = dialect.sqlToQuery(statement).sql;
          trace.rawStatements.push(rendered);
          if (!/^\s*select\b/i.test(rendered)) trace.mutations.push('non_select_execute');
          const method = Reflect.get(target, property, target) as (value: SQL) => unknown;
          return method.call(target, statement);
        };
      }
      const member = Reflect.get(target, property, target);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
}

function makeScope(memoryId: string, expiresAt = Date.now() + 120_000): OwnerEditorScope {
  return {
    ownerId,
    sessionDigest: sha256(`manual-evidence-session:${randomUUID()}`),
    epoch: ownerEpoch,
    privacyGeneration: null,
    command: 'correct_owner_memory',
    operationId: randomUUID(),
    targetId: memoryId,
    nonce: randomUUID(),
    issuedAt: Date.now(),
    expiresAt,
  };
}

async function fixture(withContact = false, source = 'manual'): Promise<Fixture> {
  if (!childDb) throw new Error('Owned PostgreSQL fixture database is unavailable');
  const memoryId = randomUUID();
  const contactId = withContact ? randomUUID() : null;
  const oldContent = `Synthetic manual memory ${randomUUID()}`;
  const replacementContent = `Synthetic corrected memory ${randomUUID()}`;
  const created: Fixture = {
    memoryId,
    oldContent,
    oldHash: sha256(oldContent),
    replacementContent,
    replacementHash: sha256(replacementContent),
    contactId,
  };
  if (contactId) {
    await childDb.insert(contacts).values({
      id: contactId,
      name: 'Synthetic contact',
      aliases: ['Synthetic alias'],
      trust: 'known',
      identityAuthority: null,
    });
  }
  await childDb.insert(memories).values({
    id: memoryId,
    agentId: ownerId,
    category: 'knowledge',
    kind: 'fact',
    content: oldContent,
    contentHash: created.oldHash,
    source,
    sourceTaskId: null,
    subjectContactId: contactId,
    ownerCorrection: null,
    domain: 'other',
    quarantined: false,
  });
  return created;
}

function observedResult(
  value: Awaited<ReturnType<typeof collectPostgresManualOwnerMemoryEvidence>>,
) {
  if (value.kind !== 'observed')
    throw new Error(`Expected observed evidence; received ${value.kind}`);
  return {
    value,
    manifest: value.manifest as unknown as Manifest,
    projection: projectManualOwnerMemoryCorrection(value.manifest),
  };
}

async function capture(
  item: Fixture,
  options: {
    trace?: QueryTrace;
    scope?: OwnerEditorScope;
    configuredOwnerId?: string;
    afterLineageRead?: () => Promise<void>;
  } = {},
) {
  if (!childDb) throw new Error('Owned PostgreSQL fixture database is unavailable');
  const trace = options.trace ?? newTrace();
  const scope = options.scope ?? makeScope(item.memoryId);
  const value = await childDb.transaction((tx) =>
    collectPostgresManualOwnerMemoryEvidence(
      traceTransaction(tx, trace, options.afterLineageRead),
      options.configuredOwnerId ?? ownerId,
      { scope, memoryId: item.memoryId, replacementContent: item.replacementContent },
    ),
  );
  return { value, trace, scope };
}

async function createPrivateMarker(
  target: ChildTarget,
  parentToken: string,
): Promise<PrivateMarker> {
  const path = testTargetMarkerPath(target.token);
  const bytes = Buffer.from(
    JSON.stringify({ databaseUrl: target.databaseUrl, token: target.token, parentToken }),
  );
  if (bytes.length > 4096) throw new Error('Manual evidence test marker exceeded its bound');
  await writeFile(path, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const markerStat = await lstat(path, { bigint: true });
  if (
    !markerStat.isFile() ||
    markerStat.isSymbolicLink() ||
    Number(markerStat.mode & 0o7777n) !== 0o600 ||
    Number(markerStat.uid) !== process.getuid?.()
  )
    throw new Error('Manual evidence child marker did not retain private regular-file identity');
  assertAllocatedTestTargetMarker({
    databaseUrl: target.databaseUrl,
    testDatabaseUrl: target.databaseUrl,
    token: target.token,
    kind: target.kind,
  });
  return { path, bytes, dev: markerStat.dev, ino: markerStat.ino, uid: Number(markerStat.uid) };
}

async function removeExactPrivateMarker(marker: PrivateMarker): Promise<void> {
  const pathStat = await lstat(marker.path, { bigint: true });
  if (
    !pathStat.isFile() ||
    pathStat.isSymbolicLink() ||
    pathStat.dev !== marker.dev ||
    pathStat.ino !== marker.ino ||
    pathStat.size !== BigInt(marker.bytes.length) ||
    Number(pathStat.mode & 0o7777n) !== 0o600 ||
    Number(pathStat.uid) !== marker.uid
  )
    throw new Error('Manual evidence child marker identity changed; preserving marker');
  const bytes = await readFile(marker.path);
  if (!bytes.equals(marker.bytes))
    throw new Error('Manual evidence child marker content changed; preserving marker');
  await unlink(marker.path);
}

async function within<T>(name: string, milliseconds: number, operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${name} exceeded ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe.skipIf(!PG_ENABLED)('native PostgreSQL manual owner-memory evidence collector', () => {
  beforeAll(async () => {
    if (!parentTarget) throw new Error('Allocated PostgreSQL parent target is unavailable');
    if (process.env.ASSISTANT_TEST_NO_EXTERNAL_CREDENTIALS !== '1')
      throw new Error('Run this suite through the isolated test environment');

    const parentDb = createDb(parentTarget.databaseUrl, { max: 1, statementTimeoutMs: 10_000 });
    try {
      await assertAllocatedTestDatabaseOwnership(parentDb, parentTarget);
    } finally {
      await parentDb.$client.end({ timeout: 5 });
    }

    childTarget = allocateTestTarget(parentTarget.databaseUrl);
    childMarker = await createPrivateMarker(childTarget, parentTarget.token);
    const adminUrl = new URL(childTarget.databaseUrl);
    adminUrl.pathname = '/postgres';
    admin = postgres(adminUrl.toString(), {
      max: 1,
      connect_timeout: 10,
      onnotice: () => {},
    });
    await admin.unsafe(`CREATE DATABASE "${childTarget.databaseName}"`);
    await admin.unsafe(
      `COMMENT ON DATABASE "${childTarget.databaseName}" IS 'assistant-test-target:${childTarget.token}'`,
    );

    childDb = createDb(childTarget.databaseUrl, { max: 2, statementTimeoutMs: 10_000 });
    await assertAllocatedTestDatabaseOwnership(childDb, childTarget);
    await migrate(childDb, { migrationsFolder });

    ownerId = randomUUID();
    await childDb.insert(agents).values({
      id: ownerId,
      name: 'Synthetic manual evidence owner',
      email: `${ownerId}@example.test`,
      workspacePrefix: `manual-evidence/${ownerId}`,
    });
    ownerEpoch = await rotatePostgresOwnerEditorEpoch(childDb, ownerId, true);
  }, 100_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    const hadAdminObserver = admin !== undefined;
    if (childDb) {
      try {
        await childDb.$client.end({ timeout: 5 });
      } catch (error) {
        failures.push(error);
      } finally {
        childDb = undefined;
      }
    }
    if (admin && childTarget) {
      try {
        const rows = await admin<{ marker: string | null }[]>`
          SELECT shobj_description(oid, 'pg_database') AS marker
          FROM pg_database WHERE datname=${childTarget.databaseName}`;
        if (rows.length > 0) {
          if (rows.length !== 1 || rows[0]?.marker !== `assistant-test-target:${childTarget.token}`)
            throw new Error('Refusing to drop a manual evidence database without its exact marker');
          await admin.unsafe(`DROP DATABASE "${childTarget.databaseName}"`);
        }
        const remaining = await admin<{ databaseName: string }[]>`
          SELECT datname AS "databaseName" FROM pg_database WHERE datname=${childTarget.databaseName}`;
        if (remaining.length) throw new Error('Owned manual evidence database remains after DROP');
        if (childMarker) await removeExactPrivateMarker(childMarker);
      } catch (error) {
        failures.push(error);
      }
      try {
        await admin.end({ timeout: 5 });
      } catch (error) {
        failures.push(error);
      } finally {
        admin = undefined;
      }
    }
    if (childTarget && !hadAdminObserver)
      failures.push(
        new Error(
          'Cannot verify manual evidence child database cleanup without its admin observer',
        ),
      );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, 'Manual evidence PostgreSQL cleanup failed');
  }, 25_000);

  it('captures independent hash tombstones and bounded empty lineage from the actual transaction', async () => {
    const item = await fixture();
    const trace = newTrace();
    const result = await capture(item, { trace });
    const observed = observedResult(result.value);
    expect(observed.projection).not.toBeNull();
    expect(observed.manifest.version).toBe(2);
    expect(observed.manifest.driver).toBe('postgres');
    expect(observed.manifest.oldHashTombstone).toMatchObject({
      collection: 'memoryTombstones',
      key: `content:${item.oldHash}`,
      state: 'missing',
      value: null,
      nativeVersion: null,
    });
    expect(observed.manifest.newHashTombstone).toMatchObject({
      collection: 'memoryTombstones',
      key: `content:${item.replacementHash}`,
      state: 'missing',
      value: null,
      nativeVersion: null,
    });
    expect(observed.manifest.lineageQuery).toEqual({
      collection: 'memoryImportLineage',
      scope: { memoryId: item.memoryId },
      limit: 2,
      complete: true,
      keys: [],
    });
    expect(observed.manifest.subjectContact).toBeNull();
    expect(observed.value.scopeObservation).toEqual({
      ownerId,
      epoch: ownerEpoch,
      privacyGeneration: null,
    });
    expect(result.scope.ownerId).toBe(observed.value.scopeObservation.ownerId);
    expect(result.scope.epoch).toBe(observed.value.scopeObservation.epoch);
    expect(result.scope.privacyGeneration).toBe(observed.value.scopeObservation.privacyGeneration);
    expect(trace.contactReads).toBe(0);
    expect(trace.tables).not.toContain('contacts');
    expect(trace.tombstonePredicates).toHaveLength(2);
    expect(trace.tombstonePredicates.map((params) => params[0])).toEqual(
      expect.arrayContaining([item.oldHash, item.replacementHash]),
    );
    expect(trace.limits).toContainEqual({ table: 'memory_import_lineage', value: 2 });
    expect(trace.mutations).toEqual([]);
    expect(trace.rawStatements.every((statement) => /^\s*select\b/i.test(statement))).toBe(true);
  }, 25_000);

  it('binds each contact value and exact native microsecond version without a subject read when absent', async () => {
    const item = await fixture(true);
    if (!childDb || !item.contactId) throw new Error('Contact fixture was not created');
    await childDb.execute(sql`
      UPDATE contacts SET updated_at = ${'2026-11-05T12:13:14.123456Z'}::timestamptz
      WHERE id = ${item.contactId}`);

    const base = await capture(item);
    const baseObserved = observedResult(base.value);
    expect(baseObserved.projection).not.toBeNull();
    expect(baseObserved.manifest.subjectContact?.value).toEqual({
      id: item.contactId,
      name: 'Synthetic contact',
      aliases: ['Synthetic alias'],
      trust: 'known',
      identityAuthority: null,
    });
    expect(baseObserved.manifest.subjectContact?.nativeVersion).toEqual({
      kind: 'postgres_timestamp',
      value: '2026-11-05T12:13:14.123456Z',
    });

    const sameVersionChanges: Array<Record<string, unknown>> = [
      { name: 'Synthetic renamed contact' },
      { aliases: ['Synthetic changed alias'] },
      { trust: 'owner' },
      { identityAuthority: 'owner' },
    ];
    for (const change of sameVersionChanges) {
      await childDb.update(contacts).set(change).where(eq(contacts.id, item.contactId));
      const changed = await capture(item);
      const changedObserved = observedResult(changed.value);
      expect(changedObserved.projection).not.toBeNull();
      expect(changedObserved.manifest.subjectContact?.nativeVersion).toEqual(
        baseObserved.manifest.subjectContact?.nativeVersion,
      );
      expect(changedObserved.projection?.prewriteFingerprint).not.toBe(
        baseObserved.projection?.prewriteFingerprint,
      );
      expect(changedObserved.projection?.expectedCurrentFingerprint).not.toBe(
        baseObserved.projection?.expectedCurrentFingerprint,
      );
    }

    await childDb.execute(sql`
      UPDATE contacts SET updated_at = ${'2026-11-05T12:13:14.123457Z'}::timestamptz
      WHERE id = ${item.contactId}`);
    const newerVersion = await capture(item);
    const newerObserved = observedResult(newerVersion.value);
    expect(newerObserved.manifest.subjectContact?.nativeVersion).toEqual({
      kind: 'postgres_timestamp',
      value: '2026-11-05T12:13:14.123457Z',
    });
    expect(newerObserved.projection?.prewriteFingerprint).not.toBe(
      baseObserved.projection?.prewriteFingerprint,
    );
    expect(newerObserved.projection?.expectedCurrentFingerprint).not.toBe(
      baseObserved.projection?.expectedCurrentFingerprint,
    );

    const noSubject = await fixture(false);
    const noSubjectTrace = newTrace();
    const noSubjectResult = await capture(noSubject, { trace: noSubjectTrace });
    expect(observedResult(noSubjectResult.value).manifest.subjectContact).toBeNull();
    expect(noSubjectTrace.contactReads).toBe(0);
    expect(noSubjectTrace.mutations).toEqual([]);
  }, 35_000);

  it('returns unknown for either independently present tombstone, unsupported source, stale scope, or expiry', async () => {
    const item = await fixture();
    for (const contentHash of [item.oldHash, item.replacementHash]) {
      if (!childDb) throw new Error('Owned PostgreSQL fixture database is unavailable');
      await childDb.insert(memoryTombstones).values({ contentHash, reason: 'synthetic_test' });
      const trace = newTrace();
      const result = await capture(item, { trace });
      expect(result.value.kind).toBe('unknown');
      if (result.value.kind === 'unknown') {
        expect(result.value.reason).toMatch(/^[a-z_]+$/);
        expect(result.value.reason).not.toContain(item.oldContent);
        expect(result.value.reason).not.toContain(item.memoryId);
      }
      expect(trace.mutations).toEqual([]);
      await childDb.delete(memoryTombstones).where(eq(memoryTombstones.contentHash, contentHash));
    }

    if (!childDb) throw new Error('Owned PostgreSQL fixture database is unavailable');
    await childDb
      .update(memories)
      .set({ source: 'extraction' })
      .where(eq(memories.id, item.memoryId));
    const unsupported = await capture(item);
    expect(unsupported.value.kind).toBe('unknown');
    await childDb.update(memories).set({ source: 'manual' }).where(eq(memories.id, item.memoryId));

    const wrongEpoch = await capture(item, {
      scope: { ...makeScope(item.memoryId), epoch: randomUUID() },
    });
    expect(wrongEpoch.value.kind).toBe('unknown');
    const wrongOwner = await capture(item, { configuredOwnerId: randomUUID() });
    expect(wrongOwner.value.kind).toBe('unknown');
    const expired = await capture(item, { scope: makeScope(item.memoryId, Date.now() - 1) });
    expect(expired.value.kind).toBe('unknown');
  }, 30_000);

  it('rejects one lineage member and a cap-saturated two-member result, then rereads fresh state', async () => {
    const item = await fixture();
    const baseline = await capture(item);
    expect(observedResult(baseline.value).projection).not.toBeNull();

    const sources = [randomUUID(), randomUUID()].map((id) => `synthetic-lineage-${id}`);
    const [firstSource, secondSource] = sources;
    if (!firstSource || !secondSource) throw new Error('Lineage fixture sources are unavailable');
    if (!childDb) throw new Error('Owned PostgreSQL fixture database is unavailable');
    await childDb.insert(importSources).values(
      sources.map((source) => ({
        agentId: ownerId,
        source,
        workspacePath: `synthetic/${source}`,
        kind: 'text',
        status: 'done',
      })),
    );
    await childDb.insert(memoryImportLineage).values({
      source: firstSource,
      memoryId: item.memoryId,
    });
    const one = await capture(item);
    expect(one.value.kind).toBe('unknown');
    await childDb.insert(memoryImportLineage).values({
      source: secondSource,
      memoryId: item.memoryId,
    });
    const two = await capture(item);
    expect(two.value.kind).toBe('unknown');
    await childDb
      .delete(memoryImportLineage)
      .where(eq(memoryImportLineage.memoryId, item.memoryId));
    await childDb
      .delete(importSources)
      .where(sql`${importSources.source} IN (${sources[0]}, ${sources[1]})`);
    const fresh = await capture(item);
    expect(observedResult(fresh.value).projection).not.toBeNull();
  }, 30_000);

  it('preserves a coded native transaction failure for the owner retry boundary', async () => {
    const item = await fixture();
    if (!childDb) throw new Error('Owned PostgreSQL fixture database is unavailable');
    const failure = Object.assign(new Error('synthetic transaction abort signal'), {
      code: '40001',
    });
    const trace = newTrace();
    const captureWithAbort = childDb.transaction((tx) =>
      collectPostgresManualOwnerMemoryEvidence(
        traceTransaction(tx, trace, async () => {
          throw failure;
        }),
        ownerId,
        {
          scope: makeScope(item.memoryId),
          memoryId: item.memoryId,
          replacementContent: item.replacementContent,
        },
      ),
    );
    await expect(within('coded native transaction error', 15_000, captureWithAbort)).rejects.toBe(
      failure,
    );
    expect(trace.mutations).toEqual([]);
  }, 20_000);

  it('does not reuse an empty lineage read after a concurrent insert on a second native connection', async () => {
    const item = await fixture();
    if (!childDb) throw new Error('Owned PostgreSQL fixture database is unavailable');
    let signalRead!: () => void;
    let resumeRead!: () => void;
    const lineageRead = new Promise<void>((resolve) => (signalRead = resolve));
    const resume = new Promise<void>((resolve) => (resumeRead = resolve));
    let paused = false;
    const inFlightTrace = newTrace();
    const first = childDb.transaction((tx) =>
      collectPostgresManualOwnerMemoryEvidence(
        traceTransaction(tx, inFlightTrace, async () => {
          if (paused) return;
          paused = true;
          signalRead();
          await resume;
        }),
        ownerId,
        {
          scope: makeScope(item.memoryId),
          memoryId: item.memoryId,
          replacementContent: item.replacementContent,
        },
      ),
    );
    let earlierObservation: Awaited<typeof first> | undefined;
    let firstFailure: unknown;
    try {
      await within('lineage observation barrier', 15_000, lineageRead);
      const source = `synthetic-concurrent-lineage-${randomUUID()}`;
      await childDb.insert(importSources).values({
        agentId: ownerId,
        source,
        workspacePath: `synthetic/${source}`,
        kind: 'text',
        status: 'done',
      });
      await childDb.insert(memoryImportLineage).values({ source, memoryId: item.memoryId });
    } catch (error) {
      firstFailure = error;
    } finally {
      resumeRead();
    }
    try {
      earlierObservation = await within('first manual evidence observation', 15_000, first);
    } catch (error) {
      firstFailure ??= error;
      // The native transaction has a 10-second statement timeout. Once its
      // barrier is released, await settlement so no row lock leaks to cleanup.
      await first.catch((drainError: unknown) => {
        firstFailure ??= drainError;
      });
    }
    if (firstFailure) throw firstFailure;
    if (!earlierObservation) throw new Error('First manual evidence observation did not settle');
    expect(['observed', 'unknown']).toContain(earlierObservation.kind);
    if (earlierObservation.kind === 'observed') {
      const manifest = earlierObservation.manifest as unknown as Manifest;
      expect(manifest.lineageQuery.keys).toEqual([]);
    }
    expect(inFlightTrace.mutations).toEqual([]);

    const fresh = await capture(item);
    expect(fresh.value.kind).toBe('unknown');
  }, 35_000);
});
