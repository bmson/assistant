import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { readGoalSessionEvidence } from './goal-session-safety.js';
import {
  assertAllocatedTestTarget,
  type TestTargetKind,
  testTargetMarkerPath,
} from './test-target.js';

export interface RecoveredGoalSessionTarget {
  databaseUrl: string;
  databaseName: string;
  token: string;
  kind: TestTargetKind;
}

/** Resolve a prior rehearsal only through the allocator's private, exact target marker. */
export async function recoverGoalSessionTargetFromMarker(input: {
  evidenceParent: string;
  runId: string;
}): Promise<RecoveredGoalSessionTarget> {
  const evidenceDirectory = path.join(input.evidenceParent, `goal-session-${input.runId}`);
  const events = await readGoalSessionEvidence(evidenceDirectory, input.runId);
  if (!events) throw new Error('Refusing recovery: rehearsal journal is invalid or not private');
  const targetEvent = events.find((entry) => entry.event === 'rehearsal_target');
  if (
    !targetEvent ||
    typeof targetEvent.targetToken !== 'string' ||
    !/^[a-f0-9]{24}$/.test(targetEvent.targetToken) ||
    typeof targetEvent.databaseName !== 'string'
  )
    throw new Error('Refusing recovery: journal has no valid allocator target identity');

  const token = targetEvent.targetToken;
  const markerPath = testTargetMarkerPath(token);
  const markerStat = await lstat(markerPath).catch(() => null);
  if (!markerStat?.isFile() || markerStat.isSymbolicLink() || (markerStat.mode & 0o077) !== 0)
    throw new Error('Refusing recovery: allocator ownership marker is missing or not private');
  let marker: { databaseUrl?: unknown; token?: unknown };
  try {
    marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
      databaseUrl?: unknown;
      token?: unknown;
    };
  } catch {
    throw new Error('Refusing recovery: allocator ownership marker is malformed');
  }
  if (marker.token !== token || typeof marker.databaseUrl !== 'string')
    throw new Error('Refusing recovery: allocator ownership marker does not match the journal');

  for (const kind of ['standard', 'restore'] satisfies TestTargetKind[]) {
    try {
      const databaseName = assertAllocatedTestTarget({
        databaseUrl: marker.databaseUrl,
        testDatabaseUrl: marker.databaseUrl,
        token,
        kind,
      });
      if (databaseName !== targetEvent.databaseName) continue;
      return { databaseUrl: marker.databaseUrl, databaseName, token, kind };
    } catch {
      // Check the other supported allocator naming scheme; both remain loopback-only.
    }
  }
  throw new Error('Refusing recovery: journal target does not match the allocator marker');
}
