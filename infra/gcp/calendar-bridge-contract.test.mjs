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

test('sharing ships schema 130 and every selected image supports its schema', () => {
  assert.equal(deriveSchemaVersion('postgres', journal, contract), 130);
  for (const name of ['agent', 'web'])
    assert.deepEqual(contract.components[name].schema.postgres, { min: 130, max: 130 });
  for (const name of ['browser', 'code', 'processor'])
    assert.deepEqual(contract.components[name].schema.postgres, { min: 0, max: 130 });
  assert.throws(() => validateManifest(manifest(129)), /incompatible.*129/);
  assert.equal(validateManifest(manifest(130)), true);
});
test('frozen schema-128 bridge ranges still permit rollback after additive 129', () => {
  const bridge = structuredClone(contract);
  for (const name of selected) bridge.components[name].schema.postgres.max = 129;
  for (const name of ['agent', 'web']) bridge.components[name].schema.postgres.min = 128;
  const bridgeJournal = {
    ...journal,
    entries: journal.entries.filter((entry) => entry.idx <= 128),
  };
  assert.equal(deriveSchemaVersion('postgres', bridgeJournal, bridge), 128);
  assert.equal(validateManifest(manifest(128, bridge)), true);
  assert.equal(validateManifest(manifest(129, bridge)), true);
  assert.throws(() => validateManifest(manifest(130, bridge)), /incompatible.*130/);
});
test('old artifact declarations remain insufficient for 129; future schema remains rejected', () => {
  const historical = structuredClone(contract);
  for (const name of selected) historical.components[name].schema.postgres.max = 128;
  assert.throws(() => validateManifest(manifest(129, historical)), /incompatible.*129/);
  assert.throws(() => validateManifest(manifest(131)), /incompatible.*131/);
  const webOnly = createManifest({
    release: 'bridge-fixture',
    imageRoot: 'registry/test',
    selected: ['web'],
    digests,
    contract,
    schemaVersion: 130,
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
      liveAgentSchemaMax: 130,
    }),
    true,
  );
});
test('Firestore schema contract stays at 1 for every selected component', () => {
  assert.equal(deriveSchemaVersion('firestore', journal, contract), 1);
  for (const name of selected)
    assert.deepEqual(contract.components[name].schema.firestore, { min: 1, max: 1 });
});
