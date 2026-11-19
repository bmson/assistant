import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type BootstrapReceipt, bootstrapDigest } from './owner-release-current-snapshot.js';
import { RESTORE_TARGET_REVIEW_DOMAIN } from './owner-restore-target-review.js';

const roles = ['agent', 'web'] as const;
type Role = (typeof roles)[number];
const source = 'e'.repeat(40);
const original = '1c2ea3907bf17b14368846708002f9d4633f2092';
const originalManifest = '9ca6dcbb6a1c4b6e25ca6ea857c86ae1c3103a75d9a8e4e26af801f7b1c32647';
const runId = '123457';
const buildRunId = '123456';
const repository = 'us-west1-docker.pkg.dev/bmson-assistant/assistant';
const recoveryRepository = 'us-west1-docker.pkg.dev/bmson-assistant/assistant-release-recovery';
const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const title = (role: Role) =>
  `projects/bmson-assistant/locations/us-west1/services/assistant-${role}`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = (value: string) => `sha256:${sha(value)}`;
const agentUri = 'https://assistant-agent-synthetic-uw.a.run.app';
const ownerId = '11111111-1111-4111-8111-111111111111';
const installationId = 'synthetic-installation';
const archivePins = {
  agent: [
    '1298263587c4021246c7a4832e174ea95bb5a5a2ffef8359b989ba60d694690b',
    '7ab38d59edcf5d5f47a0884a928249ffd4e0457aa67f3cbf948fae4cb17c65e5',
    '8ed6937de80a52651b1e80d3f464bb5c61149dd433c70cc0064dc3f541a01932',
    '53a47b948298498e031cc6a8f7acd65a53250f42266b0595d02dc7532c9c0f9a',
  ],
  web: [
    '34d027a7e04daf667428d615f60fb537b5090caf785a3c4f65db0a714b42eb0a',
    'fde5cc2ae8bfe91405a4c5a56bcac59cff74f951f89e542a05b387fcc82e8d36',
    '938c1530e8b97793f94eaaa31909d9c03075fadbce2ccfca0fff9811f4fa4b5f',
  ],
} as const;

function roleFixture(role: Role) {
  const config = {
    digest: digest(`${role}-configuration`),
    size: Buffer.byteLength(`${role}-configuration`),
    mediaType: 'application/vnd.oci.image.config.v1+json',
  };
  const layer = {
    digest: digest(`${role}-layer`),
    size: Buffer.byteLength(`${role}-layer`),
    mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
  };
  const child = JSON.stringify({
    schemaVersion: 2,
    mediaType: manifestType,
    config,
    layers: [layer],
  });
  const parent = JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [
      {
        digest: digest(child),
        size: Buffer.byteLength(child),
        mediaType: manifestType,
        platform: { os: 'linux', architecture: 'amd64' },
      },
    ],
  });
  const image = `${repository}/${role}@${digest(parent)}`;
  const peer = role === 'agent' ? 'WEB' : 'AGENT';
  const revisionName = `assistant-${role}-historical-test`;
  const runtime = {
    serviceAccount: `assistant-${role}@bmson-assistant.iam.gserviceaccount.com`,
    containers: [
      {
        name: `${role}-1`,
        image,
        env: Object.entries({
          PERSISTENCE_DRIVER: 'firestore',
          FIRESTORE_DATABASE_ID: 'assistant-production',
          FIRESTORE_AGENT_ID: ownerId,
          ASSISTANT_WORKSPACE_ID: installationId,
          ASSISTANT_RELEASE_SCHEMA_DRIVER: 'firestore',
          ASSISTANT_RELEASE_SCHEMA_MIN: '1',
          ASSISTANT_RELEASE_SCHEMA_MAX: '1',
          ASSISTANT_RELEASE_SCHEMA_VERSION: '1',
          ASSISTANT_RELEASE_API_CONTRACT: '1',
          [`ASSISTANT_RELEASE_${peer}_API_MIN`]: '1',
          [`ASSISTANT_RELEASE_${peer}_API_MAX`]: '1',
          ASSISTANT_RELEASE_SOURCE_SHA: original,
          ASSISTANT_RELEASE_MANIFEST: originalManifest,
          ASSISTANT_RELEASE_WORKFLOW_RUN_ID: '44263661117',
          ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT: '1',
          ASSISTANT_RELEASE_WRITES_PAUSED: 'false',
          MCP_OAUTH_ENABLED: 'false',
          ...(role === 'web' ? { AGENT_URL: agentUri } : {}),
        }).map(([name, value]) => ({ name, value })),
      },
    ],
  };
  const route = {
    type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
    revision: revisionName,
    percent: 100,
  };
  const service = {
    name: title(role),
    uid: `synthetic-service-${role}`,
    generation: '12',
    observedGeneration: '12',
    latestCreatedRevision: revisionName,
    latestReadyRevision: revisionName,
    terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    scaling: { scalingMode: 'MANUAL', manualInstanceCount: 0 },
    traffic: [route],
    trafficStatuses: [route],
    template: { revision: revisionName, ...runtime },
    uri: role === 'agent' ? agentUri : 'https://assistant-web-synthetic-uw.a.run.app',
  };
  const revision = {
    name: `${title(role)}/revisions/${revisionName}`,
    service: title(role),
    uid: `synthetic-revision-${role}`,
    generation: '1',
    observedGeneration: '1',
    conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
    ...runtime,
  };
  const binding = {
    service: service.name,
    uid: service.uid,
    revision: revisionName,
    image,
    serviceSha256: bootstrapDigest(service),
    revisionSha256: bootstrapDigest(revision),
    automaticScaling: { scalingMode: 'AUTOMATIC' },
    proof: {
      uid: sha(revision.uid),
      image,
      source: original,
      manifest: originalManifest,
      runId: '44263661117',
      attempt: '1',
      paused: false,
      templateSha256: bootstrapDigest(service.template),
    },
  };
  return { parent, child, config, layer, service, revision, binding };
}

function runFixture(root: string) {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const cli = join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const from = (...pieces: string[]) => join(root, ...pieces);
  const key = generateKeyPairSync('ed25519');
  const publicKey = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const now = Date.now();
  const native = { agent: roleFixture('agent'), web: roleFixture('web') };
  const current: BootstrapReceipt = {
    format: 1,
    kind: 'disabled-bootstrap',
    source,
    closureReceiptSha256: sha('closure'),
    drainReceiptSha256: sha('drain'),
    recoveryReceiptSha256: sha('recovery'),
    services: { agent: native.agent.binding, web: native.web.binding },
  };
  const candidate = { source, test: 'independent candidate verifier boundary' };
  const build = {
    source,
    runId: buildRunId,
    completedAt: now - 120_000,
    digests: Object.fromEntries(
      ['agent', 'web', 'browser', 'code', 'processor'].map((role) => [
        role,
        digest(`candidate-${role}`),
      ]),
    ),
  };
  const packSha256 = sha('synthetic archive parser boundary');
  const target = (role: Role) => ({
    image: `${recoveryRepository}/${role}@${digest(native[role].child)}`,
    parent: digest(native[role].parent),
    child: digest(native[role].child),
    baselineUidSha256: current.services[role].proof.uid,
    baselineTemplateSha256: current.services[role].proof.templateSha256,
    rehearsalUidSha256: sha(`fresh-review-${role}`),
  });
  const evidence = (outcome: string) => ({ outcome, evidenceSha256: sha(outcome) });
  const payload = {
    format: 1,
    kind: 'owner-release-restore-target',
    purpose: 'restore-paused-original-runtime-pair',
    maintenanceRunId: '98701',
    maintenanceReceiptSha256: sha('completed maintenance receipt'),
    source,
    buildRunId,
    buildAttempt: '1',
    candidateBuildSha256: bootstrapDigest(build),
    candidateReviewSha256: bootstrapDigest(candidate),
    originalSource: original,
    originalRunId: '44263661117',
    originalAttempt: '1',
    project: 'bmson-assistant',
    region: 'us-west1',
    database: 'assistant-production',
    bootstrapSha256: bootstrapDigest(current),
    packSha256,
    observedAt: now - 30_000,
    expiresAt: now + 60_000,
    targets: { agent: target('agent'), web: target('web') },
    rehearsal: {
      project: 'friendly-vigil-514906-p2',
      region: 'us-west1',
      importedBytes: evidence('verified-exact-runtime-bytes'),
      createdPausedPair: evidence('verified-fresh-paused-pair'),
      heldRestore: evidence('verified-held-restore'),
      heldForward: evidence('verified-held-forward'),
    },
  };
  const signed = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return JSON.stringify({
      payload: bytes.toString('base64url'),
      signature: sign(
        null,
        Buffer.concat([Buffer.from(RESTORE_TARGET_REVIEW_DOMAIN), bytes]),
        key.privateKey,
      ).toString('base64url'),
    });
  };
  mkdirSync(from('infra'), { mode: 0o700 });
  cpSync(join(repo, 'scripts'), from('scripts'), { recursive: true });
  symlinkSync(join(repo, 'node_modules'), from('node_modules'), 'dir');
  symlinkSync(join(repo, 'packages'), from('packages'), 'dir');
  cpSync(join(repo, 'infra', 'gcp'), from('infra', 'gcp'), { recursive: true });
  writeFileSync(from('package.json'), '{"type":"module"}');
  writeFileSync(from('verified-build.json'), JSON.stringify(build), { mode: 0o600 });
  writeFileSync(
    from('infra', 'gcp', 'api3-recovery-review-key.mjs'),
    `export const API3_RECOVERY_REVIEW_PUBLIC_KEY = ${JSON.stringify(publicKey)};\n`,
  );
  const replace = (name: string, pins: ReadonlyArray<readonly [string, string]>) => {
    const file = from('scripts', name);
    let text = readFileSync(file, 'utf8');
    for (const [originalPin, testPin] of pins) {
      if (!text.includes(originalPin)) throw new Error('synthetic source pin not found');
      text = text.replaceAll(originalPin, testPin);
    }
    writeFileSync(file, text);
  };
  replace(
    'owner-restore-target-review.ts',
    roles.flatMap(
      (role) =>
        [
          [archivePins[role][0], sha(native[role].parent)],
          [archivePins[role][1], sha(native[role].child)],
        ] as const,
    ),
  );
  const uidPins = {
    agent: '48e24460ff97eb87801e9a876bbdc5690194c65eb0a780a98e97fe828ab94d67',
    web: '4ef1ecfce5e4eb4f54a7fd40c5f9b67cff9714705c355f511e98727d08ae84c9',
  };
  replace(
    'owner-restore-target-verify.ts',
    roles.flatMap((role) => [
      ...archivePins[role]
        .slice(2)
        .map((pin) => [pin, native[role].binding.proof.templateSha256] as const),
      [uidPins[role], native[role].binding.proof.uid] as const,
    ]),
  );

  const stub = (name: string, text: string) => writeFileSync(from('scripts', name), text);
  writeFileSync(
    from('infra', 'gcp', 'api3-recovery-proof.mjs'),
    [
      `export const protectedRecoveryReview = () => (${JSON.stringify(candidate)});`,
      'export function readBoundedJSON() { throw Error("unexpected alternate selector stage"); }',
      'export function verifyPromotionManifest() { throw Error("unexpected alternate selector stage"); }',
    ].join('\n'),
  );
  const substitute = (name: string, declaration: string, replacement: string) => {
    const path = from('scripts', name);
    const original = readFileSync(path, 'utf8');
    if (!original.includes(declaration)) throw new Error('synthetic provider boundary not found');
    stub(
      name,
      `${original.replace(declaration, declaration.startsWith('export async') ? 'async function unusedFixtureImplementation(' : 'function unusedFixtureImplementation(')}\n${replacement}`,
    );
  };
  substitute(
    'owner-editor-release-inventory.ts',
    'export function verifyPreAuthEnvironment(',
    'export function verifyPreAuthEnvironment() {}',
  );
  substitute(
    'estimated-cost-release-profile.ts',
    'export function reviewedEstimatedCostReleaseProfile(',
    `export const reviewedEstimatedCostReleaseProfile = () => (${JSON.stringify({ mode: 'compatible-off', ownerId, installationId })});`,
  );
  substitute(
    'owner-web-release-operator-hold.ts',
    'export async function verifyOperatorOwnedHold(',
    "export async function verifyOperatorOwnedHold() { globalThis.fixtureLog('hold'); }",
  );
  substitute(
    'owner-web-tag-cloud.ts',
    'export async function protectedWebTagCredential(',
    "export async function protectedWebTagCredential() { globalThis.fixtureLog('credential'); return 'synthetic-only'; }",
  );
  substitute(
    'estimated-cost-release-native-read.ts',
    'export function estimatedCostMetadataRead(',
    "export const estimatedCostMetadataRead = (token) => { if (token !== 'synthetic-only') throw Error('unexpected token'); return globalThis.fixtureNative; };",
  );
  const binding = Object.fromEntries(
    roles.map((role) => [
      role,
      {
        revision: native[role].binding.revision,
        serviceUidSha256: bootstrapDigest(native[role].service.uid),
        revisionUidSha256: bootstrapDigest(native[role].revision.uid),
      },
    ]),
  );
  const encoded = Object.fromEntries(
    roles.map((role) => [role, { parent: native[role].parent, child: native[role].child }]),
  );
  stub(
    'owner-archived-runtime-input.ts',
    [
      'export async function loadReviewedArchivedRuntimePack() {',
      "globalThis.fixtureLog('pack');",
      `const assets = ${JSON.stringify(encoded)};`,
      'const roles = Object.fromEntries(Object.entries(assets).map(([role, bytes]) => [role, { parent: Buffer.from(bytes.parent), child: Buffer.from(bytes.child) }]));',
      `return { sha256: ${JSON.stringify(packSha256)}, nativeBinding: { format: 1, roles: ${JSON.stringify(binding)} }, roles };`,
      '}',
    ].join('\n'),
  );

  const handles = Object.fromEntries(
    roles.flatMap((role) => [
      [`https://run.googleapis.com/v2/${native[role].service.name}`, native[role].service],
      [`https://run.googleapis.com/v2/${native[role].revision.name}`, native[role].revision],
    ]),
  );
  const endpoints = Object.fromEntries(
    roles.flatMap((role) => {
      const base = `https://us-west1-docker.pkg.dev/v2/bmson-assistant/assistant-release-recovery/${role}`;
      const { child, config, layer } = native[role];
      return [
        [
          `${base}/manifests/${digest(child)}`,
          { method: 'GET', body: child, role, kind: 'manifest' },
        ],
        ...[config, layer].map((blob, index) => [
          `${base}/blobs/${blob.digest}`,
          {
            method: 'GET',
            body: `${role}-${index === 0 ? 'configuration' : 'layer'}`,
            role,
            kind: index === 0 ? 'config' : 'layer',
            digest: blob.digest,
          },
        ]),
      ];
    }),
  );
  writeFileSync(
    from('fixture.cjs'),
    [
      'const fs = require("node:fs");',
      'globalThis.fixtureLog = (name) => fs.appendFileSync(process.env.FIXTURE_TRACE, name + "\\n");',
      `const native = ${JSON.stringify(handles)};`,
      `const registry = ${JSON.stringify(endpoints)};`,
      'const counts = new Map();',
      'globalThis.fixtureNative = async (url) => {',
      " const value = native[url]; if (!value) throw Error('unexpected native URL');",
      " fixtureLog('native ' + url);",
      ' counts.set(url, (counts.get(url) ?? 0) + 1);',
      " return process.env.FIXTURE_DRIFT === '1' && counts.get(url) > 1 ? {...value, generation:'13'} : value;",
      '};',
      'globalThis.fetch = async (url, init) => {',
      " if (!registry[url] || init.method !== registry[url].method) throw Error('unexpected Registry URL or method');",
      " fixtureLog('registry ' + init.method + ' ' + url);",
      ' const match = registry[url];',
      " if (match.role === 'agent' && process.env.FIXTURE_REGISTRY_404 === match.kind) return new Response(null, { status: 404 });",
      ` if (match.kind === 'manifest') return new Response(match.body, {headers:{'content-type':${JSON.stringify(manifestType)}}});`,
      " const body = match.role === 'agent' && match.kind === 'layer' && process.env.FIXTURE_CORRUPT_LAYER === '1' ? 'x' + match.body.slice(1) : match.body;",
      " return new Response(body, {headers:{'content-length':String(match.body.length),'docker-content-digest':match.digest}});",
      '};',
    ].join('\n'),
  );
  const dispatch = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'bmson/assistant',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: source,
    GITHUB_WORKFLOW_SHA: source,
    IMAGE_TAG: source,
    RELEASE_COMPONENTS: 'agent,web',
    GCP_PROJECT: 'bmson-assistant',
    GCP_REGION: 'us-west1',
    GITHUB_RUN_ID: runId,
    RELEASE_PREBUILT_RUN_ID: buildRunId,
    ARCHIVE_MAINTENANCE_RUN_ID: '98701',
    RELEASE_PREBUILT_IMAGES_PATH: from('verified-build.json'),
    OWNER_RELEASE_RESTORE_TARGET_PROOF: signed(payload),
    OWNER_RELEASE_BOOTSTRAP_RECEIPT: JSON.stringify(current),
    OWNER_RELEASE_BOOTSTRAP_SHA256: bootstrapDigest(current),
    RELEASE_MANIFEST_PATH: from(`assistant-release-${source}.json`),
    RUNNER_TEMP: root,
  };
  const invoke = (name: string, env: Record<string, string> = {}) => {
    const traceFile = from(`${name}.log`);
    writeFileSync(traceFile, '', { mode: 0o600 });
    const child = spawnSync(
      process.execPath,
      [cli, from('scripts', 'owner-release-restore-target.ts'), '--verify', 'before_mutation'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 8_000,
        env: {
          ...dispatch,
          ...env,
          FIXTURE_TRACE: traceFile,
          NODE_OPTIONS: `--require=${from('fixture.cjs')}`,
        },
      },
    );
    return { child, trace: readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean) };
  };
  const envelope = JSON.parse(dispatch.OWNER_RELEASE_RESTORE_TARGET_PROOF);
  const badEvidence = structuredClone(payload);
  badEvidence.rehearsal.importedBytes.evidenceSha256 = sha('changed evidence after signing');
  envelope.payload = Buffer.from(JSON.stringify(badEvidence)).toString('base64url');
  return {
    invoke,
    wrongPackProof: signed({ ...payload, packSha256: sha('other pack') }),
    tamperedEvidenceProof: JSON.stringify(envelope),
  };
}

describe('restore-target selector through normal process entry', () => {
  it('binds the signed target, reads archived Registry children, and refuses missing blobs or native drift', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'restore-target-process-')));
    try {
      const { invoke, wrongPackProof, tamperedEvidenceProof } = runFixture(root);
      const good = invoke('good');
      expect(good.child.stderr, good.trace.join(',')).toBe('');
      expect(good.child.status).toBe(0);
      expect(good.child.stdout).toBe(
        `${JSON.stringify({ format: 1, source, runId, attempt: '1', decision: 'verified' })}\n`,
      );
      expect(good.trace.slice(0, 3)).toEqual(['pack', 'hold', 'credential']);
      expect(good.trace.filter((entry) => entry.startsWith('native '))).toHaveLength(8);
      expect(good.trace.filter((entry) => entry.startsWith('registry GET '))).toHaveLength(6);
      for (const [name, env] of [
        ['missing-manifest', { FIXTURE_REGISTRY_404: 'manifest' }],
        ['missing-blob', { FIXTURE_REGISTRY_404: 'layer' }],
        ['corrupt-layer', { FIXTURE_CORRUPT_LAYER: '1' }],
        ['tampered-evidence', { OWNER_RELEASE_RESTORE_TARGET_PROOF: tamperedEvidenceProof }],
        ['wrong-pack', { OWNER_RELEASE_RESTORE_TARGET_PROOF: wrongPackProof }],
        ['drift', { FIXTURE_DRIFT: '1' }],
        ['empty-proof', { OWNER_RELEASE_RESTORE_TARGET_PROOF: '' }],
      ] as const) {
        const refused = invoke(name, env);
        expect(refused.child.status).toBe(1);
        expect(refused.child.stdout).toBe('');
        expect(refused.child.stderr).toMatch(/Keep delivery held/);
        if (name === 'empty-proof') expect(refused.trace).toEqual([]);
        if (name === 'wrong-pack' || name === 'tampered-evidence')
          expect(refused.trace).toEqual(['pack']);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
