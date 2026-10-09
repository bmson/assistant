import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { testTargetMarkerPath } from './test-target.js';

const rootDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!rootDatabaseUrl)
  throw new Error('TEST_DATABASE_URL is required for cleanup integration tests.');
const baseDatabaseUrl = rootDatabaseUrl;

function allocateUrl(token: string): { databaseName: string; databaseUrl: string } {
  const databaseName = `assistant_${token}_test`;
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return { databaseName, databaseUrl: url.toString() };
}

function runCleanup(databaseUrl: string, token: string) {
  return spawnSync('pnpm', ['--filter', '@assistant/db', 'test:cleanup'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      TEST_DATABASE_URL: databaseUrl,
      ASSISTANT_TEST_TARGET_TOKEN: token,
    },
    timeout: 15_000,
  });
}

describe('disposable test database cleanup', () => {
  const adminUrl = new URL(baseDatabaseUrl);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });

  afterAll(async () => {
    await admin.end({ timeout: 5 });
  });

  it('preserves a colliding database with no allocator sentinel', async () => {
    const token = randomBytes(12).toString('hex');
    const { databaseName, databaseUrl } = allocateUrl(token);
    const markerPath = testTargetMarkerPath(token);
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    await writeFile(markerPath, JSON.stringify({ databaseUrl, token }), {
      mode: 0o600,
      flag: 'wx',
    });

    try {
      const result = runCleanup(databaseUrl, token);
      expect(result.status, result.stderr).not.toBe(0);
      const rows = await admin<{ exists: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${databaseName}) AS exists
      `;
      expect(rows[0]?.exists).toBe(true);
    } finally {
      await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      await unlink(markerPath).catch(() => {});
    }
  });

  it('drops an allocated database only when its target sentinel matches', async () => {
    const token = randomBytes(12).toString('hex');
    const { databaseName, databaseUrl } = allocateUrl(token);
    const markerPath = testTargetMarkerPath(token);
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    await admin.unsafe(`COMMENT ON DATABASE "${databaseName}" IS 'assistant-test-target:${token}'`);
    await writeFile(markerPath, JSON.stringify({ databaseUrl, token }), {
      mode: 0o600,
      flag: 'wx',
    });

    try {
      const result = runCleanup(databaseUrl, token);
      expect(result.status, result.stderr).toBe(0);
      const rows = await admin<{ exists: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${databaseName}) AS exists
      `;
      expect(rows[0]?.exists).toBe(false);
    } finally {
      const rows = await admin<{ exists: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${databaseName}) AS exists
      `;
      if (rows[0]?.exists) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      await unlink(markerPath).catch(() => {});
    }
  });
});
