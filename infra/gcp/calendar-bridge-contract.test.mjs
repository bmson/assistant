import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createManifest, validateManifest } from './release-manifest.mjs';
import { deriveSchemaVersion } from './release-schema-version.mjs';

const historicalContractBytes = await readFile(
  new URL('./fixtures/release-contracts.schema132.json', import.meta.url),
);
const historicalJournalBytes = await readFile(
  new URL('./fixtures/postgres-journal.schema132.json', import.meta.url),
);
assert.equal(
  createHash('sha256').update(historicalContractBytes).digest('hex'),
  '33370d187575b95377c36bea587f8588777d377d560ca98c549b244a34d1898b',
);
assert.equal(
  createHash('sha256').update(historicalJournalBytes).digest('hex'),
  '2088a29e71a01c6f4a5b33cc8f2af7f24194ded8135ade6827f8fea829d0ec26',
);
const contract = JSON.parse(historicalContractBytes.toString('utf8'));
const journal = JSON.parse(historicalJournalBytes.toString('utf8'));
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

test('combined owner editing ships schema 132 and every selected image supports its schema', () => {
  assert.equal(deriveSchemaVersion('postgres', journal, contract), 132);
  for (const name of ['agent', 'web'])
    assert.deepEqual(contract.components[name].schema.postgres, { min: 132, max: 132 });
  for (const name of ['browser', 'code', 'processor'])
    assert.deepEqual(contract.components[name].schema.postgres, { min: 0, max: 132 });
  assert.throws(() => validateManifest(manifest(129)), /incompatible.*129/);
  assert.throws(() => validateManifest(manifest(130)), /incompatible.*130/);
  assert.throws(() => validateManifest(manifest(131)), /incompatible.*131/);
  assert.equal(validateManifest(manifest(132)), true);
});
test('frozen draft-131 declarations keep their original schema boundary', () => {
  const draft131 = structuredClone(contract);
  for (const name of selected) draft131.components[name].schema.postgres.max = 131;
  for (const name of ['agent', 'web']) draft131.components[name].schema.postgres.min = 131;
  assert.throws(() => validateManifest(manifest(130, draft131)), /incompatible.*130/);
  assert.equal(validateManifest(manifest(131, draft131)), true);
  assert.throws(() => validateManifest(manifest(132, draft131)), /incompatible.*132/);
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
  assert.throws(() => validateManifest(manifest(133)), /incompatible.*133/);
  const webOnly = createManifest({
    release: 'bridge-fixture',
    imageRoot: 'registry/test',
    selected: ['web'],
    digests,
    contract,
    schemaVersion: 132,
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
  assert.throws(
    () =>
      validateManifest(webOnly, {
        liveAgentApi: 1,
        liveAgentSchemaMin: 128,
        liveAgentSchemaMax: 131,
      }),
    /live agent schema/,
  );
  assert.equal(
    validateManifest(webOnly, {
      liveAgentApi: 1,
      liveAgentSchemaMin: 128,
      liveAgentSchemaMax: 132,
    }),
    true,
  );
});
test('Firestore schema contract stays at 1 for every selected component', () => {
  assert.equal(deriveSchemaVersion('firestore', journal, contract), 1);
  for (const name of selected)
    assert.deepEqual(contract.components[name].schema.firestore, { min: 1, max: 1 });
});
