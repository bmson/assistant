import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDb } from '@assistant/db';
import {
  allocateTestTarget,
  assertAllocatedTestDatabaseOwnership,
  assertAllocatedTestTargetMarker,
} from '../../../scripts/test-target.js';

/** A whole installation for tests using workers and independent database connections. */
export async function createIsolatedTestDatabase() {
  const parent = assertAllocatedTestTargetMarker({
    databaseUrl: process.env.DATABASE_URL,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  });
  const target = allocateTestTarget(parent.databaseUrl);
  const env = {
    ...process.env,
    TEST_DATABASE_URL: target.databaseUrl,
    DATABASE_URL: target.databaseUrl,
    ASSISTANT_TEST_TARGET_TOKEN: target.token,
    ASSISTANT_TEST_TARGET_KIND: 'standard',
    ASSISTANT_RESTORE_TARGET_DATABASE_URL: '',
    ASSISTANT_RESTORE_TARGET_TOKEN: '',
  };
  const run = promisify(execFile);
  const db = createDb(target.databaseUrl);
  async function close() {
    try {
      await db.$client.end();
    } finally {
      await run('pnpm', ['--filter', '@assistant/db', 'test:cleanup'], {
        env: { ...env, ASSISTANT_TEST_CLEANUP: '1' },
      });
    }
  }
  try {
    await run('pnpm', ['--filter', '@assistant/db', 'test:prepare'], { env });
    await assertAllocatedTestDatabaseOwnership(db, target);
    return { db, databaseUrl: target.databaseUrl, close };
  } catch (error) {
    await close();
    throw error;
  }
}
