import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createManifest, validateManifest } from './release-manifest.mjs';
import { deriveSchemaVersion } from './release-schema-version.mjs';

const contract = JSON.parse(await readFile(new URL('./release-contracts.json', import.meta.url)));
const legacy = JSON.parse(
  await readFile(new URL('./fixtures/release-contracts.schema132-legacy.json', import.meta.url)),
);
const journal = JSON.parse(
  await readFile(new URL('../../packages/db/drizzle/meta/_journal.json', import.meta.url)),
);
const names = ['agent', 'web', 'browser', 'code', 'processor'];
const digests = Object.fromEntries(names.map((name) => [name, `sha256:${'a'.repeat(64)}`]));

function liveMetadata(selected, driver = 'postgres') {
  if (!selected.includes('web') || selected.includes('agent')) return {};
  const range = driver === 'firestore' ? { min: 1, max: 1 } : { min: 132, max: 133 };
  return { liveAgentApi: 1, liveAgentSchemaMin: range.min, liveAgentSchemaMax: range.max };
}

function manifest(selected, schemaVersion, sourceContract = contract, driver = 'postgres') {
  return createManifest({
    release: `schema-${driver}-${schemaVersion}`,
    imageRoot: 'example.invalid/assistant',
    selected,
    digests,
    contract: sourceContract,
    storageDriver: driver,
    schemaVersion,
  });
}

function assertAccepted(
  selected,
  schemaVersion,
  sourceContract = contract,
  driver = 'postgres',
  live = liveMetadata(selected, driver),
) {
  assert.equal(
    validateManifest(manifest(selected, schemaVersion, sourceContract, driver), live),
    true,
  );
}

function assertRejected(
  selected,
  schemaVersion,
  cause,
  sourceContract = contract,
  driver = 'postgres',
  live = liveMetadata(selected, driver),
) {
  assert.throws(
    () => validateManifest(manifest(selected, schemaVersion, sourceContract, driver), live),
    (error) => error instanceof Error && error.message === cause,
  );
}

test('bridge contract derives schema 132 and declares component-accurate ranges', () => {
  assert.equal(deriveSchemaVersion('postgres', journal, contract), 132);
  for (const component of ['agent', 'web'])
    assert.deepEqual(contract.components[component].schema.postgres, { min: 132, max: 133 });
  for (const component of ['browser', 'code', 'processor'])
    assert.deepEqual(contract.components[component].schema.postgres, { min: 0, max: 133 });
});

test('agent and web accept 132/133 and reject 131/134 for their own schema bounds', () => {
  for (const component of ['agent', 'web']) {
    for (const version of [132, 133]) assertAccepted([component], version);
    for (const version of [131, 134])
      assertRejected(
        [component],
        version,
        `${component} is incompatible with postgres schema ${version}`,
      );
  }
});

test('selected workers accept 131/132/133 and reject 134', () => {
  for (const component of ['browser', 'code', 'processor']) {
    for (const version of [0, 131, 132, 133]) assertAccepted([component], version);
    for (const version of [-1, 134])
      assertRejected(
        [component],
        version,
        `${component} is incompatible with postgres schema ${version}`,
      );
  }
});

test('web-only positive cases supply explicit live agent API and schema metadata', () => {
  const live = { liveAgentApi: 1, liveAgentSchemaMin: 132, liveAgentSchemaMax: 133 };
  assertAccepted(['web'], 132, contract, 'postgres', live);
  assertAccepted(['web'], 133, contract, 'postgres', live);
  assertRejected(
    ['web'],
    133,
    'web-only release is incompatible with the live agent schema contract',
    contract,
    'postgres',
    {
      liveAgentApi: 1,
      liveAgentSchemaMin: 132,
      liveAgentSchemaMax: 132,
    },
  );
});

test('web-only without live metadata fails for the specific missing-proof reason', () => {
  assertRejected(
    ['web'],
    133,
    'web-only release requires proven live-agent API and schema metadata',
    contract,
    'postgres',
    {},
  );
});

test('historical schema-132 contract stays 132-only, including web-only with live proof', () => {
  for (const component of ['agent', 'web']) {
    assertAccepted([component], 132, legacy);
    assertRejected(
      [component],
      133,
      `${component} is incompatible with postgres schema 133`,
      legacy,
    );
  }
  assertRejected(['web'], 133, 'web is incompatible with postgres schema 133', legacy, 'postgres', {
    liveAgentApi: 1,
    liveAgentSchemaMin: 132,
    liveAgentSchemaMax: 133,
  });
});

test('Firestore remains schema 1 for every selected component', () => {
  for (const component of names) {
    assertAccepted([component], 1, contract, 'firestore');
    assertRejected(
      [component],
      2,
      `${component} is incompatible with firestore schema 2`,
      contract,
      'firestore',
    );
  }
  assertAccepted(['web'], 1, contract, 'firestore', {
    liveAgentApi: 1,
    liveAgentSchemaMin: 1,
    liveAgentSchemaMax: 1,
  });
  assertRejected(
    ['web'],
    1,
    'web-only release is incompatible with the live agent schema contract',
    contract,
    'firestore',
    {
      liveAgentApi: 1,
      liveAgentSchemaMin: 2,
      liveAgentSchemaMax: 2,
    },
  );
});
