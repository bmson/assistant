import { createHmac } from 'node:crypto';
import { loadConfig } from '@assistant/config';
import type { Db } from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import { sql } from 'drizzle-orm';

export interface Readiness {
  ready: boolean;
  database: 'ready' | 'unavailable';
}

/**
 * Readiness through an injected probe, for compositions without SQL. The
 * probe resolves true when the configured owner record is readable.
 */
export async function checkReadinessWithProbe(
  probe: () => Promise<boolean>,
): Promise<{ ready: boolean; database: 'firestore' | 'unavailable' }> {
  try {
    return (await probe())
      ? { ready: true, database: 'firestore' }
      : { ready: false, database: 'unavailable' };
  } catch {
    return { ready: false, database: 'unavailable' };
  }
}

/** A deliberately small dependency check suitable for readiness probes. */
export async function checkReadiness(db: Db): Promise<Readiness> {
  try {
    await db.execute(sql`select 1`);
    return { ready: true, database: 'ready' };
  } catch {
    return { ready: false, database: 'unavailable' };
  }
}

/** Issue a proof for the local QA harness only. This does not open a database connection. */
export function localQaInstallationProof(
  requestUrl: string,
  nonce: string | null,
): string | undefined {
  if (process.env.NODE_ENV !== 'development') return;
  const token = process.env.ASSISTANT_TEST_TARGET_TOKEN;
  if (!nonce || !/^[0-9a-f]{32}$/.test(nonce) || !token) return;
  try {
    const config = loadConfig();
    if (
      new URL(requestUrl).origin !== config.AUTH_URL ||
      !config.AUTH_DEV_BYPASS ||
      config.RESTORE_REHEARSAL ||
      config.PERSISTENCE_DRIVER !== 'postgres'
    )
      return;
    assertAllocatedTestTarget({
      databaseUrl: config.DATABASE_URL,
      testDatabaseUrl: process.env.TEST_DATABASE_URL,
      token,
    });
    return createHmac('sha256', token).update(config.DATABASE_URL).update(nonce).digest('hex');
  } catch {
    return;
  }
}
