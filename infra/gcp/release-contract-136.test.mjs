// Historical schema-136 contract, frozen before the estimated cost migration.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createManifest, validateManifest } from './release-manifest.mjs';
import { deriveSchemaVersion } from './release-schema-version.mjs';

const contract = JSON.parse(
  await readFile(new URL('./fixtures/release-contracts.schema136.json', import.meta.url)),
);
const journal = JSON.parse(
  await readFile(new URL('./fixtures/postgres-journal.schema136.json', import.meta.url)),
);
const roles = ['agent', 'web', 'browser', 'code', 'processor'];
function manifest(version, selected = roles) {
  return createManifest({
    release: 'schema-136-personal-calendar-fixture',
    imageRoot: 'registry/test',
    selected,
    digests: Object.fromEntries(roles.map((role) => [role, `sha256:${'a'.repeat(64)}`])),
    contract,
    schemaVersion: version,
  });
}
test('Calendar server entry points require schema 136 and all released roles admit it', () => {
  assert.equal(deriveSchemaVersion('postgres', journal, contract), 136);
  assert.equal(validateManifest(manifest(136)), true);
  for (const role of roles) {
    assert.deepEqual(contract.components[role].schema.postgres, {
      min: ['web', 'agent'].includes(role) ? 136 : 135,
      max: 136,
    });
    assert.deepEqual(contract.components[role].schema.firestore, { min: 1, max: 1 });
    assert.throws(() => validateManifest(manifest(137, [role])), /incompatible/);
  }
  for (const role of ['web', 'agent'])
    assert.throws(() => validateManifest(manifest(135, [role])), /incompatible/);
  for (const role of ['browser', 'code', 'processor'])
    assert.equal(validateManifest(manifest(135, [role])), true);
});
test('a web-only Calendar release requires live-agent compatibility with schema 136', () => {
  const web = manifest(136, ['web']);
  assert.throws(() => validateManifest(web), /requires proven live-agent/);
  assert.throws(
    () =>
      validateManifest(web, { liveAgentApi: 1, liveAgentSchemaMin: 135, liveAgentSchemaMax: 135 }),
    /incompatible/,
  );
  assert.equal(
    validateManifest(web, { liveAgentApi: 1, liveAgentSchemaMin: 136, liveAgentSchemaMax: 136 }),
    true,
  );
});
