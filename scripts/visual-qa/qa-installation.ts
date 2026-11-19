import { createDb } from '@assistant/db';
import {
  assertAllocatedTestDatabaseOwnership,
  assertAllocatedTestTargetMarker,
} from '../test-target.js';

function parseLocalOrigin(value: string | undefined): string {
  if (!value) throw new Error('Set ASSISTANT_QA_WEB_ORIGIN to the dedicated local QA server.');
  try {
    const url = new URL(value);
    if (
      url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.port &&
      value === url.origin
    )
      return url.origin;
  } catch {
    // Avoid echoing a URL that may contain credentials.
  }
  throw new Error('QA requires a literal loopback HTTP origin with an explicit port.');
}

export function requireQaOrigin(requested: string | undefined, configured: string | undefined) {
  const origin = parseLocalOrigin(configured);
  if (requested !== undefined && parseLocalOrigin(requested) !== origin)
    throw new Error('Requested origin does not match the dedicated QA server.');
  return origin;
}

export async function openQaInstallation(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === 'production' || env.ASSISTANT_TEST_TARGET_KIND === 'restore')
    throw new Error('QA requires a disposable QA installation.');
  const target = assertAllocatedTestTargetMarker({
    databaseUrl: env.DATABASE_URL,
    testDatabaseUrl: env.TEST_DATABASE_URL,
    token: env.ASSISTANT_TEST_TARGET_TOKEN,
  });
  const db = createDb(target.databaseUrl);
  try {
    await assertAllocatedTestDatabaseOwnership(db, target);
    return { db, target };
  } catch (error) {
    await db.$client.end({ timeout: 5 });
    throw error;
  }
}
