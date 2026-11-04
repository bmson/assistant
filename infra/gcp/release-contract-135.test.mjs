import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createManifest, validateManifest } from './release-manifest.mjs';
import { deriveSchemaVersion } from './release-schema-version.mjs';

const contract = JSON.parse(await readFile(new URL('./release-contracts.json', import.meta.url)));
const journal = JSON.parse(
  await readFile(new URL('../../packages/db/drizzle/meta/_journal.json', import.meta.url)),
);
const historical134 = JSON.parse(
  await readFile(new URL('./fixtures/release-contracts.schema134.json', import.meta.url)),
);
const historicalJournal134 = JSON.parse(
  await readFile(new URL('./fixtures/postgres-journal.schema134.json', import.meta.url)),
);
const roles = ['agent', 'web', 'browser', 'code', 'processor'];
const digests = Object.fromEntries(roles.map((role) => [role, `sha256:${'a'.repeat(64)}`]));

function manifest(schemaVersion, selected = roles, sourceContract = contract) {
  return createManifest({
    release: `schema-${schemaVersion}-role-contract-fixture`,
    imageRoot: 'registry/test',
    selected,
    digests,
    contract: sourceContract,
    schemaVersion,
  });
}

test('all five current PostgreSQL role contracts target schema 135 exactly', () => {
  assert.equal(deriveSchemaVersion('postgres', journal, contract), 135);
  assert.equal(validateManifest(manifest(135)), true);
  for (const role of roles) {
    assert.deepEqual(contract.components[role].schema.postgres, { min: 135, max: 135 });
    assert.equal(contract.components[role].apiContract, historical134.components[role].apiContract);
    assert.deepEqual(contract.components[role].peerApi, historical134.components[role].peerApi);
    assert.deepEqual(contract.components[role].schema.firestore, { min: 1, max: 1 });
    assert.equal(
      validateManifest(
        manifest(135, [role]),
        role === 'web'
          ? { liveAgentApi: 1, liveAgentSchemaMin: 135, liveAgentSchemaMax: 135 }
          : undefined,
      ),
      true,
      `${role} must admit schema 135`,
    );
    assert.throws(
      () => validateManifest(manifest(134, [role])),
      new RegExp(`${role} is incompatible.*134`),
    );
    assert.throws(
      () => validateManifest(manifest(136, [role])),
      new RegExp(`${role} is incompatible.*136`),
    );
  }
  assert.deepEqual(contract.storageSchemaVersion, historical134.storageSchemaVersion);
  assert.deepEqual(contract.components.web.ownerEditorV1, [
    'create_person',
    'update_person_identity',
    'add_family_relationship',
    'correct_owner_family_relationship',
    'correct_owner_memory',
    'create_owner_memory',
  ]);
  assert.deepEqual(historical134.components.web.ownerEditorV1, [
    'create_person',
    'update_person_identity',
    'add_family_relationship',
    'correct_owner_family_relationship',
    'correct_owner_memory',
  ]);
});

test('frozen historical 134 contract still accepts 134 and rejects 135', () => {
  assert.equal(deriveSchemaVersion('postgres', historicalJournal134, historical134), 134);
  assert.equal(validateManifest(manifest(134, roles, historical134)), true);
  assert.throws(
    () => validateManifest(manifest(135, roles, historical134)),
    /incompatible with postgres schema 135/,
  );
  for (const role of roles)
    assert.deepEqual(historical134.components[role].schema.postgres.max, 134);
});

test('web-only schema 135 still requires live-agent metadata that covers 135', () => {
  const webOnly = manifest(135, ['web']);
  assert.throws(() => validateManifest(webOnly), /requires proven live-agent/);
  assert.throws(
    () =>
      validateManifest(webOnly, {
        liveAgentApi: 1,
        liveAgentSchemaMin: 133,
        liveAgentSchemaMax: 134,
      }),
    /incompatible with the live agent schema/,
  );
  assert.equal(
    validateManifest(webOnly, {
      liveAgentApi: 1,
      liveAgentSchemaMin: 135,
      liveAgentSchemaMax: 135,
    }),
    true,
  );
});
