import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createManifest, validateManifest } from './release-manifest.mjs';
import { deriveSchemaVersion } from './release-schema-version.mjs';

const sourceContract = JSON.parse(
  await readFile(new URL('./release-contracts.json', import.meta.url)),
);
const journal = JSON.parse(
  await readFile(new URL('../../packages/db/drizzle/meta/_journal.json', import.meta.url)),
);
const selected = ['agent', 'web', 'browser', 'code', 'processor'];
const digests = Object.fromEntries(selected.map((name) => [name, `sha256:${'a'.repeat(64)}`]));

function bridgeContract() {
  const contract = structuredClone(sourceContract);
  contract.components.agent.schema.postgres = { min: 132, max: 133 };
  return contract;
}

function manifest(schemaVersion, contract, names = selected) {
  return createManifest({
    release: 'schema-133-contract-fixture',
    imageRoot: 'registry/test',
    selected: names,
    digests,
    contract,
    schemaVersion,
  });
}

test('132 bridge is compatible before migration and declares compatibility at 133', () => {
  const bridge = bridgeContract();
  for (const schemaVersion of [132, 133])
    assert.equal(validateManifest(manifest(schemaVersion, bridge)), true);
  assert.throws(() => validateManifest(manifest(134, bridge)), /incompatible.*134/);
});

test('final 133 target ranges are exact and keep API and Firestore contracts unchanged', () => {
  const target = sourceContract;
  assert.deepEqual(target.components.agent.schema.postgres, { min: 133, max: 133 });
  assert.deepEqual(target.components.web.schema.postgres, { min: 132, max: 133 });
  for (const name of ['browser', 'code', 'processor'])
    assert.deepEqual(target.components[name].schema.postgres, { min: 0, max: 133 });
  for (const name of selected) {
    assert.equal(target.components[name].apiContract, 1);
    assert.deepEqual(target.components[name].peerApi, { min: 1, max: 1 });
    assert.deepEqual(target.components[name].schema.firestore, { min: 1, max: 1 });
  }
  assert.deepEqual(target.storageSchemaVersion, { firestore: 1 });
  assert.equal(deriveSchemaVersion('postgres', journal, target), 133);
  assert.equal(validateManifest(manifest(133, target)), true);
  assert.throws(() => validateManifest(manifest(132, target)), /agent is incompatible.*132/);
});

test('web-only 133 release needs live agent metadata from the 132 bridge, not old 132-only serving', () => {
  const target = sourceContract;
  const webOnly = manifest(133, target, ['web']);
  assert.throws(() => validateManifest(webOnly), /requires proven live-agent/);
  assert.throws(
    () =>
      validateManifest(webOnly, {
        liveAgentApi: 1,
        liveAgentSchemaMin: 132,
        liveAgentSchemaMax: 132,
      }),
    /incompatible with the live agent schema/,
  );
  assert.equal(
    validateManifest(webOnly, {
      liveAgentApi: 1,
      liveAgentSchemaMin: 132,
      liveAgentSchemaMax: 133,
    }),
    true,
  );
});
