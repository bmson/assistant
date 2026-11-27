import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createManifest, validateManifest } from './release-manifest.mjs';
import { deriveSchemaVersion } from './release-schema-version.mjs';

const contract = JSON.parse(await readFile(new URL('./release-contracts.json', import.meta.url)));
const journal = JSON.parse(
  await readFile(new URL('../../packages/db/drizzle/meta/_journal.json', import.meta.url)),
);
const oldContract = JSON.parse(
  await readFile(new URL('./fixtures/release-contracts.schema137.json', import.meta.url)),
);
const roles = ['agent', 'web', 'browser', 'code', 'processor'];
function manifest(driver, version, selected = roles) {
  return createManifest({
    release: 'schema-143-signal-and-household-calendar-fixture',
    imageRoot: 'registry/test',
    selected,
    digests: Object.fromEntries(roles.map((role) => [role, `sha256:${'a'.repeat(64)}`])),
    contract,
    storageDriver: driver,
    schemaVersion: version,
  });
}

test('current images declare the signal and household Calendar migrations on PostgreSQL', () => {
  assert.equal(deriveSchemaVersion('postgres', journal, contract), 143);
  assert.equal(deriveSchemaVersion('firestore', journal, contract), 1);
  assert.deepEqual(
    journal.entries.slice(-2).map(({ tag }) => tag),
    ['0142_signal_store', '0143_google_household_calendar_choices'],
  );
  assert.equal(validateManifest(manifest('postgres', 143)), true);
  assert.equal(validateManifest(manifest('firestore', 1)), true);
  for (const role of roles) {
    assert.deepEqual(contract.components[role].schema.postgres, { min: 143, max: 143 });
    assert.deepEqual(contract.components[role].schema.firestore, { min: 1, max: 1 });
    for (const prior of [141, 142])
      assert.throws(() => validateManifest(manifest('postgres', prior, [role])), /incompatible/);
  }
});

test('each mixed Firestore pair fails even though both images read schema 1', () => {
  for (const role of ['agent', 'web']) {
    const current = manifest('firestore', 1, ['agent', 'web']);
    const { apiContract, peerApi } = oldContract.components[role];
    Object.assign(current.components[role], { apiContract, peerApi });
    assert.throws(() => validateManifest(current), /API contracts are incompatible/);
  }
  const webOnly = manifest('firestore', 1, ['web']);
  assert.throws(() => validateManifest(webOnly), /requires proven live-agent/);
  const liveAgent = { liveAgentSchemaMin: 1, liveAgentSchemaMax: 1 };
  for (const api of [1, 2]) {
    assert.throws(
      () => validateManifest(webOnly, { ...liveAgent, liveAgentApi: api }),
      /incompatible with the live agent API contract/,
    );
  }
  assert.equal(validateManifest(webOnly, { ...liveAgent, liveAgentApi: 3 }), true);
});
