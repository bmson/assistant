import { writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { assertAllocatedTestTarget, testTargetMarkerPath } from './test-target.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for test database preparation.');
const targetToken = process.env.ASSISTANT_TEST_TARGET_TOKEN;
if (!targetToken) throw new Error('An allocated test target token is required.');
if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to reset a test database with NODE_ENV=production.');
}

if (
  process.env.ASSISTANT_TEST_TARGET_KIND &&
  !['standard', 'restore'].includes(process.env.ASSISTANT_TEST_TARGET_KIND)
)
  throw new Error('ASSISTANT_TEST_TARGET_KIND must be standard or restore.');
const database = assertAllocatedTestTarget({
  databaseUrl,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  kind: process.env.ASSISTANT_TEST_TARGET_KIND === 'restore' ? 'restore' : 'standard',
});
const restoreTargetUrl = process.env.ASSISTANT_RESTORE_TARGET_DATABASE_URL;
const restoreTargetToken = process.env.ASSISTANT_RESTORE_TARGET_TOKEN;
if (Boolean(restoreTargetUrl) !== Boolean(restoreTargetToken))
  throw new Error('Restore snapshot target URL and token must be supplied together.');
const restoreTarget =
  restoreTargetUrl && restoreTargetToken
    ? {
        url: restoreTargetUrl,
        token: restoreTargetToken,
        database: assertAllocatedTestTarget({
          databaseUrl: restoreTargetUrl,
          testDatabaseUrl: restoreTargetUrl,
          token: restoreTargetToken,
          kind: 'restore',
        }),
      }
    : undefined;
if (restoreTarget) {
  if (process.env.ASSISTANT_TEST_TARGET_KIND !== 'restore' || restoreTargetToken === targetToken)
    throw new Error('Restore snapshot source and target require distinct restore run identities.');
  if (restoreTarget.database === database)
    throw new Error('Restore snapshot source and target database names must differ.');
  const source = new URL(databaseUrl);
  const destination = new URL(restoreTarget.url);
  if (
    source.protocol !== destination.protocol ||
    source.hostname !== destination.hostname ||
    source.port !== destination.port ||
    source.username !== destination.username ||
    source.password !== destination.password ||
    source.searchParams.toString() !== destination.searchParams.toString()
  )
    throw new Error('Restore snapshot pair must use one local PostgreSQL authority.');
}
const target = new URL(databaseUrl);
const markerPath = testTargetMarkerPath(targetToken);
const restoreMarkerPath = restoreTarget ? testTargetMarkerPath(restoreTarget.token) : undefined;

target.pathname = '/postgres';
const admin = postgres(target.toString(), { max: 1, onnotice: () => {} });

try {
  await admin`SELECT 1`;
  // Record intent before allocating the database so interruption between
  // CREATE DATABASE and sentinel creation is visible to cleanup. The marker
  // only locates a candidate; cleanup still requires the sentinel before drop.
  await writeFile(markerPath, JSON.stringify({ databaseUrl, token: targetToken }), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  // Create-only allocation: an existing name is a collision and is never reset.
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  await admin.unsafe(`COMMENT ON DATABASE "${database}" IS 'assistant-test-target:${targetToken}'`);
  if (restoreTarget && restoreMarkerPath) {
    // The second target is created empty and intentionally receives no schema,
    // migration, or seed. A snapshot test must prove the restore populates it.
    await writeFile(
      restoreMarkerPath,
      JSON.stringify({ databaseUrl: restoreTarget.url, token: restoreTarget.token }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    await admin.unsafe(`CREATE DATABASE "${restoreTarget.database}"`);
    await admin.unsafe(
      `COMMENT ON DATABASE "${restoreTarget.database}" IS 'assistant-test-target:${restoreTarget.token}'`,
    );
  }
} finally {
  await admin.end({ timeout: 5 });
}
