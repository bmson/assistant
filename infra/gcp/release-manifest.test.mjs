import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createManifest, validateManifest } from './release-manifest.mjs';
import { deriveSchemaVersion } from './release-schema-version.mjs';

const digestA = `sha256:${'a'.repeat(64)}`;
const digestB = `sha256:${'b'.repeat(64)}`;
const CURRENT_SCHEMA = 119;
const component = {
  apiContract: 1,
  peerApi: { min: 1, max: 1 },
  schema: {
    postgres: { min: CURRENT_SCHEMA, max: CURRENT_SCHEMA },
    firestore: { min: 1, max: 1 },
  },
};
const contract = {
  storageSchemaVersion: { postgres: CURRENT_SCHEMA, firestore: 1 },
  components: {
    agent: component,
    web: component,
    browser: component,
    code: component,
    processor: component,
  },
};

test('manifest pins selected service images by immutable digest and contract range', () => {
  const manifest = createManifest({
    release: 'abc123',
    imageRoot: 'us-west1-docker.pkg.dev/test/assistant',
    selected: ['agent', 'web'],
    digests: { agent: digestA, web: digestB },
    contract,
    schemaVersion: CURRENT_SCHEMA,
  });
  assert.equal(manifest.components.agent.image.endsWith(`@${digestA}`), true);
  assert.equal(manifest.components.web.schema.min, CURRENT_SCHEMA);
  assert.equal(manifest.components.web.schema.max, CURRENT_SCHEMA);
  assert.equal(manifest.storageDriver, 'postgres');
  assert.deepEqual(manifest.selected, ['agent', 'web']);
  assert.equal(validateManifest(manifest), true);
});

test('manifest rejects mutable tags, missing selected images, incompatible schema, and incompatible mixed release', () => {
  assert.throws(
    () =>
      createManifest({
        release: 'abc123',
        imageRoot: 'registry/repo',
        selected: ['agent'],
        digests: { agent: 'latest' },
        contract,
        schemaVersion: CURRENT_SCHEMA,
      }),
    /immutable sha256 digest/,
  );
  const manifest = createManifest({
    release: 'abc123',
    imageRoot: 'registry/repo',
    selected: ['agent'],
    digests: { agent: digestA },
    contract,
    schemaVersion: CURRENT_SCHEMA,
  });
  manifest.schemaVersion = 97;
  assert.throws(() => validateManifest(manifest), /incompatible with postgres schema/);
  const pair = createManifest({
    release: 'abc123',
    imageRoot: 'registry/repo',
    selected: ['agent', 'web'],
    digests: { agent: digestA, web: digestB },
    contract,
    schemaVersion: CURRENT_SCHEMA,
  });
  pair.components.web.peerApi.min = 2;
  assert.throws(() => validateManifest(pair), /new web and agent API contracts are incompatible/);
});

test('web-only release is allowed only with proven compatible live agent metadata', () => {
  const manifest = createManifest({
    release: 'abc123',
    imageRoot: 'registry/repo',
    selected: ['web'],
    digests: { web: digestB },
    contract,
    storageDriver: 'postgres',
    schemaVersion: CURRENT_SCHEMA,
  });
  assert.throws(() => validateManifest(manifest), /requires proven live-agent/);
  assert.throws(
    () =>
      validateManifest(manifest, {
        liveAgentApi: 2,
        liveAgentSchemaMin: CURRENT_SCHEMA,
        liveAgentSchemaMax: CURRENT_SCHEMA,
      }),
    /incompatible with the live agent API/,
  );
  assert.throws(
    () =>
      validateManifest(manifest, {
        liveAgentApi: 1,
        liveAgentSchemaMin: 98,
        liveAgentSchemaMax: 98,
      }),
    /incompatible with the live agent schema/,
  );
  assert.equal(
    validateManifest(manifest, {
      liveAgentApi: 1,
      liveAgentSchemaMin: CURRENT_SCHEMA,
      liveAgentSchemaMax: CURRENT_SCHEMA,
    }),
    true,
  );
});

test('journal-derived schema matches current artifacts and blocks older or unreviewed schemas', () => {
  const current = {
    entries: [{ idx: CURRENT_SCHEMA, tag: '0119_0119_embedding_space_identity' }],
  };
  assert.equal(deriveSchemaVersion('postgres', current, contract), CURRENT_SCHEMA);
  assert.throws(
    () =>
      deriveSchemaVersion(
        'postgres',
        { entries: [{ idx: CURRENT_SCHEMA - 1, tag: '0118_historical' }] },
        contract,
      ),
    new RegExp(
      `agent compatibility range ${CURRENT_SCHEMA}-${CURRENT_SCHEMA} excludes postgres schema ${CURRENT_SCHEMA - 1}`,
    ),
  );

  const unreviewed = JSON.parse(JSON.stringify(contract));
  unreviewed.components.agent.schema.postgres.max = CURRENT_SCHEMA;
  unreviewed.components.web.schema.postgres.max = CURRENT_SCHEMA;
  const future = {
    entries: [
      { idx: CURRENT_SCHEMA + 1, tag: `${String(CURRENT_SCHEMA + 1).padStart(4, '0')}_future` },
    ],
  };
  assert.throws(
    () => deriveSchemaVersion('postgres', future, unreviewed),
    new RegExp(
      `agent compatibility range ${CURRENT_SCHEMA}-${CURRENT_SCHEMA} excludes postgres schema ${CURRENT_SCHEMA + 1}`,
    ),
  );
  const manifest = createManifest({
    release: 'abc123',
    imageRoot: 'registry/repo',
    selected: ['agent', 'web'],
    digests: { agent: digestA, web: digestB },
    contract: unreviewed,
    schemaVersion: CURRENT_SCHEMA + 1,
  });
  assert.throws(
    () => validateManifest(manifest),
    new RegExp(`incompatible with postgres schema ${CURRENT_SCHEMA + 1}`),
  );

  // A release manifest must also check both currently selected components;
  // broadening only one side cannot make the pair appear compatible.
  const incompletelyReviewed = JSON.parse(JSON.stringify(contract));
  incompletelyReviewed.components.agent.schema.postgres.max = CURRENT_SCHEMA;
  incompletelyReviewed.components.web.schema.postgres.min = 99;
  incompletelyReviewed.components.web.schema.postgres.max = CURRENT_SCHEMA - 1;
  assert.throws(
    () => deriveSchemaVersion('postgres', current, incompletelyReviewed),
    new RegExp(
      `web compatibility range 99-${CURRENT_SCHEMA - 1} excludes postgres schema ${CURRENT_SCHEMA}`,
    ),
  );
});
