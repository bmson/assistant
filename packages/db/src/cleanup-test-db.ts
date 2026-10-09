import { lstat, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { assertTestCleanupOwnership, testTargetMarkerPath } from './test-target.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for test cleanup.');
if (
  process.env.ASSISTANT_TEST_TARGET_KIND &&
  !['standard', 'restore'].includes(process.env.ASSISTANT_TEST_TARGET_KIND)
)
  throw new Error('ASSISTANT_TEST_TARGET_KIND must be standard or restore.');
const sourceOwnership = assertTestCleanupOwnership({
  databaseUrl,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  kind: process.env.ASSISTANT_TEST_TARGET_KIND === 'restore' ? 'restore' : 'standard',
});
const restoreTargetUrl = process.env.ASSISTANT_RESTORE_TARGET_DATABASE_URL;
const restoreTargetToken = process.env.ASSISTANT_RESTORE_TARGET_TOKEN;
if (Boolean(restoreTargetUrl) !== Boolean(restoreTargetToken))
  throw new Error('Restore snapshot target URL and token must be supplied together.');
const restoreOwnership =
  restoreTargetUrl && restoreTargetToken
    ? assertTestCleanupOwnership({
        databaseUrl: restoreTargetUrl,
        testDatabaseUrl: restoreTargetUrl,
        token: restoreTargetToken,
        kind: 'restore',
      })
    : undefined;
if (restoreOwnership && restoreTargetUrl) {
  if (process.env.ASSISTANT_TEST_TARGET_KIND !== 'restore')
    throw new Error('Restore snapshot cleanup requires restore source ownership.');
  const source = new URL(databaseUrl);
  const destination = new URL(restoreTargetUrl);
  if (
    sourceOwnership.databaseName === restoreOwnership.databaseName ||
    sourceOwnership.token === restoreOwnership.token ||
    sourceOwnership.databaseName.match(/^assistant_restore_([a-f0-9]{12})_test$/)?.[1] ===
      restoreOwnership.databaseName.match(/^assistant_restore_([a-f0-9]{12})_test$/)?.[1]
  )
    throw new Error('Restore snapshot source and target must have distinct run identities.');
  if (
    source.protocol !== destination.protocol ||
    source.hostname !== destination.hostname ||
    source.port !== destination.port ||
    source.username !== destination.username ||
    source.password !== destination.password ||
    source.searchParams.toString() !== destination.searchParams.toString()
  )
    throw new Error('Restore snapshot cleanup targets must use one local PostgreSQL authority.');
}

async function cleanupOne(input: {
  databaseUrl: string;
  databaseName: string;
  token: string;
}): Promise<void> {
  const { databaseUrl, databaseName, token } = input;
  const markerPath = testTargetMarkerPath(token);
  let marker: { databaseUrl?: unknown; token?: unknown };
  try {
    marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
      databaseUrl?: unknown;
      token?: unknown;
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Could not read the disposable test target ownership marker.');
  }
  if (marker.databaseUrl !== databaseUrl || marker.token !== token)
    throw new Error('Disposable test target marker does not match the requested cleanup target.');
  const targetUrl = new URL(databaseUrl);
  targetUrl.pathname = '/postgres';
  const admin = postgres(targetUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const restoreRunId = databaseName.match(/^assistant_restore_([a-f0-9]{12})_test$/)?.[1];
    const readerRole = restoreRunId ? `assistant_restore_reader_${restoreRunId}` : null;
    const readerRoles = readerRole
      ? await admin<{ marker: string | null }[]>`
          SELECT shobj_description(oid, 'pg_authid') AS marker
          FROM pg_roles WHERE rolname = ${readerRole}
        `
      : [];
    if (
      readerRole &&
      readerRoles.length > 0 &&
      readerRoles[0]?.marker !== `assistant-test-target:${token}`
    )
      throw new Error('Refusing to remove a restore reader role without its ownership sentinel.');
    const databases = await admin<{ marker: string | null }[]>`
      SELECT shobj_description(oid, 'pg_database') AS marker
      FROM pg_database WHERE datname = ${databaseName}
    `;
    if (databases.length > 0) {
      if (databases[0]?.marker !== `assistant-test-target:${token}`)
        throw new Error('Refusing to remove a test database without its ownership sentinel.');
      await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    }
    if (readerRole && readerRoles.length > 0) await admin.unsafe(`DROP ROLE "${readerRole}"`);
    const runId = databaseName.match(/^assistant_restore_([a-f0-9]{12})_test$/)?.[1];
    if (runId) {
      const ownedRoots = [
        {
          path: join(tmpdir(), `assistant_restore_${runId}_source_files`),
          marker: `assistant-test-target-workspace:${token}\n`,
        },
        {
          path: join(tmpdir(), `assistant_restore_${runId}_files`),
          marker: `assistant-test-target-workspace:${token}\n`,
        },
        {
          path: join(tmpdir(), `assistant_restore_${runId}_snapshot`),
          marker: `assistant-test-snapshot:${token}\n`,
        },
      ];
      for (const ownedRoot of ownedRoots) {
        const workspaceRoot = ownedRoot.path;
        let info: Awaited<ReturnType<typeof lstat>>;
        try {
          info = await lstat(workspaceRoot);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
          throw new Error('Refusing to remove a workspace without its private directory boundary.');
        const workspaceMarkerPath = join(workspaceRoot, '.assistant-test-owner');
        let markerInfo: Awaited<ReturnType<typeof lstat>>;
        let workspaceMarker: string;
        try {
          markerInfo = await lstat(workspaceMarkerPath);
          workspaceMarker = await readFile(workspaceMarkerPath, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            throw new Error('Refusing to remove an owned workspace with a missing owner marker.');
          throw new Error('Could not read an owned workspace owner marker.');
        }
        if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || (markerInfo.mode & 0o077) !== 0)
          throw new Error('Refusing to remove a workspace without a private owner marker.');
        if (workspaceMarker !== ownedRoot.marker)
          throw new Error('Refusing to remove an owned workspace with a mismatched owner marker.');
        await rm(workspaceRoot, { recursive: true, force: false });
      }
    }
    await unlink(markerPath);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

const errors: unknown[] = [];
for (const target of [
  ...(restoreOwnership && restoreTargetUrl && restoreTargetToken
    ? [{ databaseUrl: restoreTargetUrl, ...restoreOwnership }]
    : []),
  { databaseUrl, ...sourceOwnership },
]) {
  try {
    await cleanupOne(target);
  } catch (error) {
    errors.push(error);
  }
}
if (errors.length > 0) throw new AggregateError(errors, 'Test target cleanup was incomplete.');
