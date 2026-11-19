import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const workflow = await readFile(
  new URL('../../.github/workflows/memory-witness-schema-135-qualification.yml', import.meta.url),
  'utf8',
);
const title =
  'qualifies the schema 140 migration image, runtime readiness, and generic write compatibility';
const selectedFile = 'packages/db/src/memory-witness-135-role-qualification.test.ts';
const qualification = await readFile(new URL(`../../${selectedFile}`, import.meta.url), 'utf8');

test('current schema 140 qualification binds coherent artifacts, exact test selection and role ranges', () => {
  assert.ok(workflow.includes('name: Memory witness schema 140 qualification'));
  assert.ok(workflow.includes("assert manifest['schemaVersion']==140"));
  assert.ok(workflow.includes("assert manifest['components'][role]['schema']['min']==140"));
  assert.ok(workflow.includes("assert manifest['components'][role]['schema']['max']==140"));
  assert.ok(workflow.includes(`title='${title}'`));
  assert.ok(qualification.includes(`'${title}'`));
  assert.ok(workflow.includes(`pnpm test ${selectedFile}`));
  assert.ok(workflow.includes(`'fileSuffix':'${selectedFile}'`));
  assert.ok(workflow.includes("report.get('numTotalTests')==1"));
  assert.ok(workflow.includes("report.get('numPendingTests')==0"));
  assert.ok(workflow.includes('if not ok: raise SystemExit'));
  assert.ok(workflow.includes('steps.schema140_populated_test.outcome'));
  assert.ok(!workflow.includes('schema-135-local-image-manifest.json'));
  assert.ok(workflow.includes('schema-140-local-image-manifest.json'));
});

test('forward qualification retains populated data through the 0135 to 0140 tail', () => {
  assert.ok(qualification.includes('journal.entries.slice(0, 135)'));
  assert.ok(qualification.includes("toBe('0134_owner_memory_creation')"));
  assert.ok(qualification.includes('journal.entries.slice(135)'));
  for (const migration of [
    '0135_memory_write_witness',
    '0136_google_calendar_connections',
    '0137_estimated_cost_approval',
    '0138_mcp_oauth_state',
    '0139_research_assignment_state',
    '0140_cost_event_accounted_at',
  ])
    assert.ok(qualification.includes(migration));
  assert.equal(qualification.split('await runMemoryWitnessMigrationImage(').length - 1, 2);
  assert.ok(qualification.includes('expect([...forwardLedger]).toEqual(expectedForwardLedger)'));
  assert.ok(qualification.includes("to_regclass('public.google_calendar_connections')"));
  assert.ok(qualification.includes('expect(calendarAfter?.state).toEqual(calendarState)'));
  assert.ok(qualification.includes('expect(legacyReservation).toEqual({'));
  assert.ok(
    qualification.includes(
      "expect(legacyCostEvent).toEqual({ usd: '0.123000', accountedAt: null })",
    ),
  );
  assert.ok(
    qualification.includes(
      "expect(costAccountingColumn).toEqual({ nullable: 'YES', type: 'timestamp with time zone' })",
    ),
  );
  assert.ok(qualification.includes("'estimated_cost_grants'"));
  assert.ok(qualification.includes("'estimated_cost_quote_requests'"));
  assert.ok(qualification.includes('witnessIsSqlNull: true'));
  assert.ok(qualification.includes('expect(legacyMcpConnection).toEqual({'));
  assert.ok(qualification.includes('oauthState: null'));
  assert.ok(qualification.includes('await qualifyMemoryWitnessRoleImages('));
  assert.ok(qualification.includes('schema-140-forward-upgrade.json'));
});
