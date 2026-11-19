import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createManifest, validateManifest } from './release-manifest.mjs';
import { deriveSchemaVersion } from './release-schema-version.mjs';

// Freeze the pre-0135 compatibility declaration so this historical test does
// not silently become evidence for the current candidate contract.
// The ad81925 journal fixture normalizes one trailing newline; hashes below
// pin fixture bytes rather than claiming raw Git-blob byte identity.
const historicalContractBytes = await readFile(
  new URL('./fixtures/release-contracts.schema134.json', import.meta.url),
);
const historicalJournalBytes = await readFile(
  new URL('./fixtures/postgres-journal.schema134.json', import.meta.url),
);
assert.equal(
  createHash('sha256').update(historicalContractBytes).digest('hex'),
  '7e9166bef85bb64fb010d04301af4338fbd1aa861d44b1644b9512b28fae18f8',
);
assert.equal(
  createHash('sha256').update(historicalJournalBytes).digest('hex'),
  '2ca7b996bc569db04c2e68139cefa276a98146a92c55ba860bde05dc7d4cf67f',
);
const contract = JSON.parse(historicalContractBytes.toString('utf8'));
const journal = JSON.parse(historicalJournalBytes.toString('utf8'));
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

test('frozen pre-creation schema-134 contract preserves its exact five commands', () => {
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
