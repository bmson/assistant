import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createDb } from '@assistant/db';
import {
  assertGoalSessionDatabaseOwnership,
  reconcileGoalSessionRun,
} from './goal-session-reconciliation.js';
import {
  goalSessionTerminalState,
  isEmptyPrivateGoalSessionDirectory,
  readGoalSessionEvidence,
} from './goal-session-safety.js';
import { recoverGoalSessionTargetFromMarker } from './goal-session-target.js';

if (process.env.NODE_ENV === 'production') throw new Error('Refusing orphan cleanup in production');
const evidenceParent = process.env.ASSISTANT_GOAL_SESSION_EVIDENCE_DIR;
if (!evidenceParent)
  throw new Error('Set ASSISTANT_GOAL_SESSION_EVIDENCE_DIR to the private evidence directory');

let scanned = 0;
let cleaned = 0;
let skipped = 0;
let failed = 0;
const entries = await readdir(evidenceParent, { withFileTypes: true });
for (const entry of entries) {
  const match =
    /^goal-session-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
      entry.name,
    );
  if (!entry.isDirectory() || !match?.[1]) continue;
  const runId = match[1];
  const directory = path.join(evidenceParent, entry.name);
  const events = await readGoalSessionEvidence(directory, runId);
  if (!events) {
    if (await isEmptyPrivateGoalSessionDirectory(directory, runId)) {
      skipped += 1;
      continue;
    }
    failed += 1;
    continue;
  }
  if (events.some((item) => item.event === 'fixture_cleanup_complete')) {
    skipped += 1;
    continue;
  }
  const terminalState = goalSessionTerminalState(events);
  if (terminalState === 'valid') {
    skipped += 1;
    continue;
  }
  if (terminalState === 'invalid') {
    failed += 1;
    continue;
  }
  if (events.length === 0) {
    // A first record interrupted while still pending has no durable fixture intent.
    // Leave the private pending file untouched; do not resolve a DB target or publish a terminal.
    skipped += 1;
    continue;
  }
  if (!events.some((item) => item.event === 'goal_fixture_planned')) {
    skipped += 1;
    continue;
  }
  scanned += 1;
  let target: Awaited<ReturnType<typeof recoverGoalSessionTargetFromMarker>>;
  try {
    target = await recoverGoalSessionTargetFromMarker({ evidenceParent, runId });
  } catch {
    failed += 1;
    continue;
  }
  const db = createDb(target.databaseUrl, { max: 2 });
  try {
    await assertGoalSessionDatabaseOwnership(db, target);
    const result = await reconcileGoalSessionRun({ db, directory, runId, target });
    if (result === 'cleaned' || result === 'already-clean') cleaned += 1;
    else skipped += 1;
  } catch {
    // Keep the journal intact for a safe retry; do not print URLs or row contents.
    failed += 1;
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

console.log(
  `goal rehearsal orphan recovery scanned ${scanned}; cleaned ${cleaned}; skipped ${skipped}; failed ${failed}`,
);
if (failed > 0) process.exitCode = 1;
