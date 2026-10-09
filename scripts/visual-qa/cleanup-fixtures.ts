/** Remove one interrupted or completed visual-QA fixture run by its exact private manifest ID. */
import { createDb } from '@assistant/db';
import {
  assertAllocatedTestDatabaseOwnership,
  assertAllocatedTestTargetMarker,
} from '../test-target.js';
import { cleanupVisualQaRuns, readVisualQaManifest } from './fixture-runs.js';

const runId = process.argv[2] ?? '';
if (!/^[0-9a-f-]{36}$/i.test(runId))
  throw new Error('usage: cleanup-fixtures.ts <visual-qa-run-id>');
const target = assertAllocatedTestTargetMarker({
  databaseUrl: process.env.DATABASE_URL,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
  token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  kind: process.env.ASSISTANT_TEST_TARGET_KIND === 'restore' ? 'restore' : 'standard',
});
const db = createDb(target.databaseUrl);
try {
  await assertAllocatedTestDatabaseOwnership(db, target);
  const manifest = await readVisualQaManifest(runId);
  const result = await cleanupVisualQaRuns({
    db,
    target,
    runId,
    fixtureKind: manifest.fixtureKind,
  });
  if (!result.cleaned && !result.skipped) throw new Error(`No fixture run found for ${runId}`);
  console.log(JSON.stringify({ runId, ...result }));
} finally {
  await db.$client.end({ timeout: 5 });
}
