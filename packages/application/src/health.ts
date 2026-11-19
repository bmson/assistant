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
  requestHost: string | null,
  nonce: string | null,
): string | undefined {
  if (process.env.NODE_ENV !== 'development') return;
  const token = process.env.ASSISTANT_TEST_TARGET_TOKEN;
  if (!nonce || !/^[0-9a-f]{32}$/.test(nonce) || !token) return;
  try {
    const config = loadConfig();
    const origin = new URL(config.AUTH_URL);
    if (
      origin.protocol !== 'http:' ||
      (origin.hostname !== '127.0.0.1' && origin.hostname !== '[::1]') ||
      !origin.port ||
      config.AUTH_URL !== origin.origin ||
      requestHost !== origin.host ||
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
