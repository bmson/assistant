import { lstatSync, readFileSync } from 'node:fs';
import type { Db } from '@assistant/db';
import {
  type AllocatedTestTarget,
  allocateTestTarget,
  assertAllocatedTestTarget,
  isolatedTestEnvironment,
  type TestTargetKind,
  testTargetMarkerPath,
} from '@assistant/db/test-target';
import { sql } from 'drizzle-orm';

export {
  type AllocatedTestTarget,
  allocateTestTarget,
  assertAllocatedTestTarget,
  isolatedTestEnvironment,
  type TestTargetKind,
  testTargetMarkerPath,
};

export interface VerifiedScriptTestTarget {
  databaseUrl: string;
  databaseName: string;
  token: string;
  kind: TestTargetKind;
}

/** Require the private marker created by test-db, not just a plausible DB name. */
export function assertAllocatedTestTargetMarker(input: {
  databaseUrl: string | undefined;
  testDatabaseUrl: string | undefined;
  token: string | undefined;
  kind?: TestTargetKind;
}): VerifiedScriptTestTarget {
  const databaseName = assertAllocatedTestTarget(input);
  const token = input.token as string;
  const markerPath = testTargetMarkerPath(token);
  let markerStat: ReturnType<typeof lstatSync>;
  let marker: { databaseUrl?: unknown; token?: unknown };
  try {
    markerStat = lstatSync(markerPath);
    marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      databaseUrl?: unknown;
      token?: unknown;
    };
  } catch {
    throw new Error('Refusing fixture write without the private test allocator marker.');
  }
  if (
    !markerStat.isFile() ||
    markerStat.isSymbolicLink() ||
    (markerStat.mode & 0o077) !== 0 ||
    marker.token !== token ||
    marker.databaseUrl !== input.databaseUrl
  )
    throw new Error('Refusing fixture write: allocator marker does not match the target.');
  return {
    databaseUrl: input.databaseUrl as string,
    databaseName,
    token,
    kind: input.kind ?? 'standard',
  };
}

/** Validate the database-side sentinel before any fixture reads or writes. */
export async function assertAllocatedTestDatabaseOwnership(
  db: Db,
  target: Pick<VerifiedScriptTestTarget, 'databaseName' | 'token'>,
): Promise<void> {
  const [row] = await db.execute<{
    database_name: string;
    ownership_marker: string | null;
  }>(sql`SELECT current_database() AS database_name,
      shobj_description(oid, 'pg_database') AS ownership_marker
    FROM pg_database WHERE datname = current_database()`);
  if (
    row?.database_name !== target.databaseName ||
    row.ownership_marker !== `assistant-test-target:${target.token}`
  )
    throw new Error('Refusing fixture write: database allocator ownership marker is missing.');
}
