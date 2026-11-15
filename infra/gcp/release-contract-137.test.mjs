import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createManifest, validateManifest } from './release-manifest.mjs';
import { deriveSchemaVersion } from './release-schema-version.mjs';

const contract = JSON.parse(await readFile(new URL('./release-contracts.json', import.meta.url)));
const journal = JSON.parse(
  await readFile(new URL('../../packages/db/drizzle/meta/_journal.json', import.meta.url)),
);
const roles = ['agent', 'web', 'browser', 'code', 'processor'];
function manifest(version, selected = roles) {
  return createManifest({
    release: 'schema-137-estimated-cost-fixture',
    imageRoot: 'registry/test',
    selected,
    digests: Object.fromEntries(roles.map((role) => [role, `sha256:${'a'.repeat(64)}`])),
    contract,
    schemaVersion: version,
  });
}

test('all budget writers require the estimated cost schema and retain Firestore compatibility', () => {
  assert.equal(deriveSchemaVersion('postgres', journal, contract), 137);
  assert.equal(journal.entries.at(-1).tag, '0137_estimated_cost_approval');
  assert.equal(validateManifest(manifest(137)), true);
  for (const role of roles) {
    assert.deepEqual(contract.components[role].schema.postgres, { min: 137, max: 137 });
    assert.deepEqual(contract.components[role].schema.firestore, { min: 1, max: 1 });
    assert.throws(() => validateManifest(manifest(136, [role])), /incompatible/);
    assert.throws(() => validateManifest(manifest(138, [role])), /incompatible/);
  }
});

test('a web-only release cannot run with an escrow-unaware agent', () => {
  const web = manifest(137, ['web']);
  assert.throws(() => validateManifest(web), /requires proven live-agent/);
  assert.throws(
    () =>
      validateManifest(web, { liveAgentApi: 1, liveAgentSchemaMin: 136, liveAgentSchemaMax: 136 }),
    /incompatible/,
  );
  assert.equal(
    validateManifest(web, { liveAgentApi: 1, liveAgentSchemaMin: 137, liveAgentSchemaMax: 137 }),
    true,
  );
});
