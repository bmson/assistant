import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createManifest, validateManifest } from './release-manifest.mjs';
import { deriveSchemaVersion } from './release-schema-version.mjs';

const contract = JSON.parse(await readFile(new URL('./release-contracts.json', import.meta.url)));
const journal = JSON.parse(
  await readFile(new URL('../../packages/db/drizzle/meta/_journal.json', import.meta.url)),
);
const selected = ['agent', 'web', 'browser', 'code', 'processor'];
const digests = Object.fromEntries(selected.map((name) => [name, `sha256:${'a'.repeat(64)}`]));
const manifest = (schemaVersion, contracts = contract) =>
  createManifest({
    release: 'bridge-fixture',
    imageRoot: 'registry/test',
    selected,
    digests,
    contract: contracts,
    schemaVersion,
  });

test('bridge ships schema 128 and every new selected image also supports additive 129', () => {
  assert.equal(deriveSchemaVersion('postgres', journal, contract), 128);
  for (const name of ['agent', 'web'])
    assert.deepEqual(contract.components[name].schema.postgres, { min: 128, max: 129 });
  for (const name of ['browser', 'code', 'processor'])
    assert.deepEqual(contract.components[name].schema.postgres, { min: 0, max: 129 });
  assert.equal(validateManifest(manifest(128)), true);
  assert.equal(validateManifest(manifest(129)), true);
});
test('old artifact declarations remain insufficient for 129; future schema remains rejected', () => {
  const historical = structuredClone(contract);
  for (const name of selected) historical.components[name].schema.postgres.max = 128;
  assert.throws(() => validateManifest(manifest(129, historical)), /incompatible.*129/);
  assert.throws(() => validateManifest(manifest(130)), /incompatible.*130/);
  const webOnly = createManifest({
    release: 'bridge-fixture',
    imageRoot: 'registry/test',
    selected: ['web'],
    digests,
    contract,
    schemaVersion: 129,
  });
  assert.throws(
    () =>
      validateManifest(webOnly, {
        liveAgentApi: 1,
        liveAgentSchemaMin: 128,
        liveAgentSchemaMax: 128,
      }),
    /live agent schema/,
  );
  assert.equal(
    validateManifest(webOnly, {
      liveAgentApi: 1,
      liveAgentSchemaMin: 128,
      liveAgentSchemaMax: 129,
    }),
    true,
  );
});
test('Firestore schema contract stays at 1 for every selected component', () => {
  assert.equal(deriveSchemaVersion('firestore', journal, contract), 1);
  for (const name of selected)
    assert.deepEqual(contract.components[name].schema.firestore, { min: 1, max: 1 });
});
