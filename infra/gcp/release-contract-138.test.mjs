import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
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
    release: 'schema-146-handoff-foundation-fixture',
    imageRoot: 'registry/test',
    selected,
    digests: Object.fromEntries(roles.map((role) => [role, `sha256:${'a'.repeat(64)}`])),
    contract,
    storageDriver: driver,
    schemaVersion: version,
  });
}

test('candidate images declare exact schema 146 for the handoff foundation', () => {
  assert.equal(deriveSchemaVersion('postgres', journal, contract), 146);
  assert.equal(deriveSchemaVersion('firestore', journal, contract), 1);
  assert.deepEqual(
    journal.entries.slice(-5).map(({ tag }) => tag),
    [
      '0142_signal_store',
      '0143_google_household_calendar_choices',
      '0144_home_weather',
      '0145_saved_places',
      '0146_household_handoffs',
    ],
  );
  assert.equal(validateManifest(manifest('postgres', 146)), true);
  assert.equal(validateManifest(manifest('firestore', 1)), true);
  for (const role of roles) {
    assert.deepEqual(contract.components[role].schema.postgres, { min: 146, max: 146 });
    assert.deepEqual(contract.components[role].schema.firestore, { min: 1, max: 1 });
    for (const prior of [142, 143, 144, 145, 147, 148])
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

test('schema 146 rejects mixed and undeclared candidate pairs', () => {
  for (const role of ['agent', 'web']) {
    const mixed = manifest('postgres', 146, ['agent', 'web']);
    mixed.components[role].schema = { min: 145, max: 145 };
    assert.throws(() => validateManifest(mixed), /incompatible with postgres schema 146/);

    const undeclared = manifest('postgres', 146, ['agent', 'web']);
    undeclared.components[role].schema = {};
    assert.throws(() => validateManifest(undeclared), /lacks a declared postgres schema range/);
    undeclared.components[role].schema = { min: 146, max: 146 };
    delete undeclared.components[role].apiContract;
    assert.throws(() => validateManifest(undeclared), /lacks a declared service API contract/);
  }
  const webOnly = manifest('postgres', 146, ['web']);
  assert.throws(() => validateManifest(webOnly), /requires proven live-agent/);
  assert.throws(
    () =>
      validateManifest(webOnly, {
        liveAgentApi: 3,
        liveAgentSchemaMin: 145,
        liveAgentSchemaMax: 145,
      }),
    /incompatible with the live agent schema/,
  );
});

const preflightPath = fileURLToPath(new URL('./release-staged-services.sh', import.meta.url));

function preflight(driver, agentSchema, webSchema, agentApi, webApi) {
  const fixtureRevision = (schema, api, peer) =>
    JSON.stringify({
      spec: {
        containers: [
          {
            env: Object.entries({
              ASSISTANT_RELEASE_API_CONTRACT: api,
              [`ASSISTANT_RELEASE_${peer}_API_MIN`]: api,
              [`ASSISTANT_RELEASE_${peer}_API_MAX`]: api,
              ASSISTANT_RELEASE_SCHEMA_DRIVER: driver,
              ASSISTANT_RELEASE_SCHEMA_MIN: schema,
              ASSISTANT_RELEASE_SCHEMA_MAX: schema,
            }).flatMap(([name, value]) =>
              value === undefined ? [] : [{ name, value: String(value) }],
            ),
          },
        ],
      },
    });
  return spawnSync(
    'bash',
    [
      '-c',
      `
    source "$1"
    release_service_json() { printf '%s' '{"status":{"traffic":[{"percent":100,"revisionName":"fixture"}]}}'; }
    release_revision_json() {
      if [[ "$1" == assistant-agent ]]; then printf '%s' "$FIXTURE_AGENT"; else printf '%s' "$FIXTURE_WEB"; fi
    }
    release_preflight_compatibility agent,web
  `,
      'schema-146-preflight',
      preflightPath,
    ],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        RELEASE_PERSISTENCE_DRIVER: driver,
        FIXTURE_AGENT: fixtureRevision(agentSchema, agentApi, 'WEB'),
        FIXTURE_WEB: fixtureRevision(webSchema, webApi, 'AGENT'),
      },
      timeout: 10_000,
    },
  );
}

test('ordinary release preflight requires both live roles to declare the target schema and peer API', () => {
  for (const [agentSchema, webSchema] of [
    [145, 146],
    [146, 145],
    [undefined, 146],
    [146, undefined],
  ]) {
    const closed = preflight('postgres', agentSchema, webSchema, 3, 3);
    assert.equal(closed.status, 1, closed.stderr);
    assert.match(closed.stderr, /does not declare compatibility with postgres schema 146/);
  }
  const accepted = preflight('postgres', 146, 146, 3, 3);
  assert.equal(accepted.status, 0, accepted.stderr);

  for (const [agentApi, webApi] of [
    [1, 3],
    [3, 1],
    [undefined, 3],
    [3, undefined],
  ]) {
    const closed = preflight('firestore', 1, 1, agentApi, webApi);
    assert.equal(closed.status, 1, closed.stderr);
    assert.match(closed.stderr, /do not prove both mixed-version combinations safe/);
  }
  const firestore = preflight('firestore', 1, 1, 3, 3);
  assert.equal(firestore.status, 0, firestore.stderr);
});
