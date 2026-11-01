import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createManifest, validateManifest } from './release-manifest.mjs';
import { deriveSchemaVersion } from './release-schema-version.mjs';

const contract = JSON.parse(await readFile(new URL('./release-contracts.json', import.meta.url)));
const journal = JSON.parse(
  await readFile(new URL('../../packages/db/drizzle/meta/_journal.json', import.meta.url)),
);
const names = ['agent', 'web', 'browser', 'code', 'processor'];
function manifest(selected = names) {
  return createManifest({
    release: 'schema-134-person-note-writer-fixture',
    imageRoot: 'registry/test',
    selected,
    digests: Object.fromEntries(names.map((name) => [name, `sha256:${'a'.repeat(64)}`])),
    contract,
    schemaVersion: 134,
  });
}

test('the additive command constraint keeps existing minimums and supports schema 134 only', () => {
  const minimums = { agent: 133, web: 132, browser: 0, code: 0, processor: 0 };
  for (const name of names) {
    assert.deepEqual(contract.components[name].schema.postgres, { min: minimums[name], max: 134 });
    assert.equal(contract.components[name].apiContract, 1);
    assert.deepEqual(contract.components[name].peerApi, { min: 1, max: 1 });
    assert.deepEqual(contract.components[name].schema.firestore, { min: 1, max: 1 });
  }
  assert.equal(deriveSchemaVersion('postgres', journal, contract), 134);
  assert.equal(validateManifest(manifest()), true);
  const future = { ...manifest(), schemaVersion: 135 };
  assert.throws(() => validateManifest(future), /incompatible|schema/i);
});

test('schema compatibility does not enable the sixth command', () => {
  assert.deepEqual(contract.components.web.ownerEditorV1, [
    'create_person',
    'update_person_identity',
    'add_family_relationship',
    'correct_owner_family_relationship',
    'correct_owner_memory',
  ]);
});

test('web-only schema 134 requires compatible live-agent metadata', () => {
  const webOnly = manifest(['web']);
  assert.throws(() => validateManifest(webOnly), /requires proven live-agent/);
  assert.throws(
    () =>
      validateManifest(webOnly, {
        liveAgentApi: 1,
        liveAgentSchemaMin: 133,
        liveAgentSchemaMax: 133,
      }),
    /incompatible with the live agent schema/,
  );
  assert.equal(
    validateManifest(webOnly, {
      liveAgentApi: 1,
      liveAgentSchemaMin: 133,
      liveAgentSchemaMax: 134,
    }),
    true,
  );
});
