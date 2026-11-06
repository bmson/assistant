import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  allowedUrl,
  BASIC_EDITOR_COMMANDS,
  collectInventory,
  createReadOnlyGet,
  DATABASE,
  listPages,
  recoveryPoint,
  requireBasicEditorReadiness,
  requiresBasicEditorPreflight,
  serviceFacts,
  verifyManifest,
  verifyPrerequisitesBinding,
  verifyWifEnvironment,
} from './owner-editor-release-inventory.js';

const manifest = readFileSync(
  new URL('./fixtures/owner-editor-release-indexes.json', import.meta.url),
);
const now = Date.parse('2026-10-26T17:00:00Z');
const db = {
  name: DATABASE,
  uid: '11111111-1111-4111-8111-111111111111',
  locationId: 'us-west1',
  pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_ENABLED',
  earliestVersionTime: '2026-10-20T17:00:00Z',
  versionRetentionPeriod: '604800s',
};
const env = {
  GITHUB_ACTIONS: 'true',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '123',
  GITHUB_REPOSITORY: 'bmson/assistant',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_RUN_ATTEMPT: '1',
  GCP_PROJECT: 'bmson-assistant',
  GITHUB_WORKSPACE: '/workspace',
  RUNNER_TEMP: '/runner',
  GCP_DEPLOY_SERVICE_ACCOUNT: 'deployer@bmson-assistant.iam.gserviceaccount.com',
  GCP_WORKLOAD_IDENTITY_PROVIDER:
    'projects/123/locations/global/workloadIdentityPools/pool/providers/provider',
  CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/workspace/gha-creds-file.json',
  GOOGLE_APPLICATION_CREDENTIALS: '/workspace/gha-creds-file.json',
};
const credential = {
  type: 'external_account',
  audience: `//iam.googleapis.com/${env.GCP_WORKLOAD_IDENTITY_PROVIDER}`,
  token_url: 'https://sts.googleapis.com/v1/token',
  service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${env.GCP_DEPLOY_SERVICE_ACCOUNT}:generateAccessToken`,
};
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
const prerequisiteEnv: NodeJS.ProcessEnv = {
  ...env,
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF:
    'bmson/assistant/.github/workflows/owner-editor-release-inventory.yml@refs/heads/main',
  GITHUB_WORKFLOW_SHA: env.GITHUB_SHA,
  OWNER_EDITOR_CHECKOUT_SHA: env.GITHUB_SHA,
  OWNER_EDITOR_APPROVED_SOURCE_SHA: env.GITHUB_SHA,
  OWNER_EDITOR_APPROVED_PROJECT_SHA256: fingerprint(env.GCP_PROJECT),
  OWNER_EDITOR_APPROVED_SERVICE_ACCOUNT_SHA256: fingerprint(env.GCP_DEPLOY_SERVICE_ACCOUNT),
  OWNER_EDITOR_APPROVED_WIF_PROVIDER_SHA256: fingerprint(env.GCP_WORKLOAD_IDENTITY_PROVIDER),
};
const bindingFailures: Array<[string, NodeJS.ProcessEnv]> = [];
for (const key of [
  'OWNER_EDITOR_APPROVED_SOURCE_SHA',
  'GITHUB_SHA',
  'GITHUB_WORKFLOW_SHA',
  'OWNER_EDITOR_CHECKOUT_SHA',
  'OWNER_EDITOR_APPROVED_PROJECT_SHA256',
  'OWNER_EDITOR_APPROVED_SERVICE_ACCOUNT_SHA256',
  'OWNER_EDITOR_APPROVED_WIF_PROVIDER_SHA256',
  'GCP_PROJECT',
  'GCP_DEPLOY_SERVICE_ACCOUNT',
  'GCP_WORKLOAD_IDENTITY_PROVIDER',
]) {
  bindingFailures.push([`missing ${key}`, { [key]: undefined }]);
  bindingFailures.push([`empty ${key}`, { [key]: '' }]);
}
for (const key of [
  'GITHUB_SHA',
  'GITHUB_WORKFLOW_SHA',
  'OWNER_EDITOR_CHECKOUT_SHA',
  'OWNER_EDITOR_APPROVED_SOURCE_SHA',
])
  for (const value of ['b'.repeat(40), 'A'.repeat(40), `${'a'.repeat(40)}\n`, 'a'.repeat(39)])
    bindingFailures.push([`source ${key} ${JSON.stringify(value)}`, { [key]: value }]);
for (const key of [
  'OWNER_EDITOR_APPROVED_PROJECT_SHA256',
  'OWNER_EDITOR_APPROVED_SERVICE_ACCOUNT_SHA256',
  'OWNER_EDITOR_APPROVED_WIF_PROVIDER_SHA256',
])
  for (const value of ['b'.repeat(64), 'A'.repeat(64), `${'a'.repeat(64)}\n`, ` ${'a'.repeat(64)}`])
    bindingFailures.push([`digest ${key} ${JSON.stringify(value)}`, { [key]: value }]);
bindingFailures.push(
  ['different project', { GCP_PROJECT: 'other-project' }],
  [
    'different account',
    { GCP_DEPLOY_SERVICE_ACCOUNT: 'other@bmson-assistant.iam.gserviceaccount.com' },
  ],
  [
    'different provider',
    { GCP_WORKLOAD_IDENTITY_PROVIDER: `${env.GCP_WORKLOAD_IDENTITY_PROVIDER}2` },
  ],
  ['account whitespace', { GCP_DEPLOY_SERVICE_ACCOUNT: `${env.GCP_DEPLOY_SERVICE_ACCOUNT}\n` }],
  [
    'provider whitespace',
    { GCP_WORKLOAD_IDENTITY_PROVIDER: `${env.GCP_WORKLOAD_IDENTITY_PROVIDER}\n` },
  ],
  ['wrong event', { GITHUB_EVENT_NAME: 'push' }],
  ['missing event', { GITHUB_EVENT_NAME: undefined }],
  [
    'wrong workflow',
    { GITHUB_WORKFLOW_REF: 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main' },
  ],
  ['missing workflow', { GITHUB_WORKFLOW_REF: undefined }],
  ['wrong repository', { GITHUB_REPOSITORY: 'other/assistant' }],
  ['wrong branch', { GITHUB_REF: 'refs/heads/topic' }],
  ['second attempt', { GITHUB_RUN_ATTEMPT: '2' }],
);

describe('prerequisites pre-auth source and configuration binding', () => {
  it('accepts exact synthetic bindings without reading credentials', () => {
    const input = { ...prerequisiteEnv };
    Object.defineProperty(input, 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE', {
      get() {
        throw new Error('credential access forbidden');
      },
    });
    expect(() => verifyPrerequisitesBinding(input)).not.toThrow();
  });
  it.each(bindingFailures)('fails closed: %s', (_name, change) => {
    expect(() => verifyPrerequisitesBinding({ ...prerequisiteEnv, ...change })).toThrow(
      'prerequisites binding mismatch',
    );
  });
  it('rejects a trailing newline even when all four source values match', () => {
    const source = `${env.GITHUB_SHA}\n`;
    expect(() =>
      verifyPrerequisitesBinding({
        ...prerequisiteEnv,
        GITHUB_SHA: source,
        GITHUB_WORKFLOW_SHA: source,
        OWNER_EDITOR_CHECKOUT_SHA: source,
        OWNER_EDITOR_APPROVED_SOURCE_SHA: source,
      }),
    ).toThrow('prerequisites binding mismatch');
  });
  it.each([
    ['valid', {}],
    ['missing approval', { OWNER_EDITOR_APPROVED_SOURCE_SHA: undefined }],
    ['wrong workflow SHA', { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) }],
    ['wrong checkout', { OWNER_EDITOR_CHECKOUT_SHA: 'b'.repeat(40) }],
    ['wrong project hash', { OWNER_EDITOR_APPROVED_PROJECT_SHA256: 'b'.repeat(64) }],
    ['wrong account hash', { OWNER_EDITOR_APPROVED_SERVICE_ACCOUNT_SHA256: 'b'.repeat(64) }],
    ['wrong provider hash', { OWNER_EDITOR_APPROVED_WIF_PROVIDER_SHA256: 'b'.repeat(64) }],
    ['private input', { GCP_WORKLOAD_IDENTITY_PROVIDER: 'PRIVATE_INPUT_MUST_NOT_APPEAR' }],
  ] as Array<[string, NodeJS.ProcessEnv]>)('real --verify-source fixture: %s', (name, change) => {
    const dir = mkdtempSync(join(tmpdir(), 'prerequisites-binding-'));
    const sentinel = 'PRIVATE_INPUT_MUST_NOT_APPEAR';
    try {
      const manifestPath = join(dir, '.approved-index-source/infra/gcp/firestore');
      mkdirSync(manifestPath, { recursive: true });
      writeFileSync(join(manifestPath, 'firestore.indexes.json'), manifest);
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      for (const tool of ['gcloud', 'auth', 'curl'])
        writeFileSync(
          join(bin, tool),
          `#!/bin/sh\nprintf invoked > '${dir}/unexpected-call'\nexit 99\n`,
          { mode: 0o700 },
        );
      // No inherited credentials, database URL, cloud configuration or provider keys.
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
          fileURLToPath(new URL('./owner-editor-release-inventory.ts', import.meta.url)),
          '--verify-source',
        ],
        {
          cwd: dir,
          encoding: 'utf8',
          timeout: 5000,
          maxBuffer: 65536,
          env: {
            ...prerequisiteEnv,
            ...change,
            PATH: `${bin}:${process.env.PATH}`,
            GITHUB_WORKSPACE: dir,
            RUNNER_TEMP: dir,
            CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: join(dir, sentinel),
            GOOGLE_APPLICATION_CREDENTIALS: join(dir, sentinel),
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(name === 'valid' ? 0 : 1);
      const output = result.stdout + result.stderr;
      for (const privateValue of [
        sentinel,
        env.GCP_DEPLOY_SERVICE_ACCOUNT,
        env.GCP_WORKLOAD_IDENTITY_PROVIDER,
      ])
        expect(output).not.toContain(privateValue);
      if (name === 'valid') expect(output).toBe('');
      else
        expect(JSON.parse(result.stderr)).toMatchObject({
          outcome: 'inventory_failed',
          stage: 'protected_context',
          authorityEstablished: false,
          mutationAuthorized: false,
        });
      expect(existsSync(join(dir, 'unexpected-call'))).toBe(false);
      expect(existsSync(join(dir, 'owner-editor-release-inventory.json'))).toBe(false);
      expect(existsSync(join(dir, sentinel))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('binds only the prerequisites job before normal-success auth and preserves recovery', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/owner-editor-release-inventory.yml', import.meta.url),
      'utf8',
    );
    const recovery = workflow.slice(workflow.indexOf('  recovery-pair:\n'));
    expect(fingerprint(recovery)).toBe(
      '3777df478f8a3c56fbf4bde98aace57a44d1406a3d678c19a7714ca9080e9dea',
    );
    const observe = workflow.split('  observe:\n')[1]?.split('  recovery-pair:\n')[0];
    if (!observe) throw new Error('observe job missing');
    for (const input of [
      'source_sha',
      'project_sha256',
      'service_account_sha256',
      'wif_provider_sha256',
    ]) {
      // Input blocks remain optional for the separate recovery-pair dispatch contract.
      const block = workflow
        .split(/(?=^ {6}[a-z0-9_]+:\n)/m)
        .find((part) => part.startsWith(`      prerequisites_${input}:\n`));
      if (!block) throw new Error('prerequisites input missing');
      expect(block).toContain('type: string');
      expect(block).toContain('required: false');
      expect(observe).toContain(`inputs.prerequisites_${input}`);
      expect(recovery).not.toContain(`inputs.prerequisites_${input}`);
    }
    const verify = observe.indexOf('OWNER_EDITOR_CHECKOUT_SHA="$(git rev-parse HEAD)"');
    const auth = observe.indexOf(
      'uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093',
    );
    const setup = observe.indexOf(
      'uses: google-github-actions/setup-gcloud@aa5489c8933f4cc7a4f7d45035b3b1440c9c10db',
    );
    expect(verify).toBeGreaterThan(0);
    expect(verify).toBeLessThan(auth);
    expect(auth).toBeLessThan(setup);
    const beforeCollect = observe.slice(0, observe.indexOf('      - name: Read bounded'));
    expect(beforeCollect).not.toContain('continue-on-error:');
    expect(beforeCollect).not.toContain('always()');
    expect(observe).toContain(' --verify-source');
    expect(observe).toContain(' --collect');
  });
});

function service(target?: { workspaceId: string; ownerId: string }) {
  const values = {
    PERSISTENCE_DRIVER: 'firestore',
    FIRESTORE_DATABASE_ID: 'assistant-production',
    ASSISTANT_RELEASE_SCHEMA_DRIVER: 'firestore',
    ASSISTANT_RELEASE_SCHEMA_MIN: '1',
    ASSISTANT_RELEASE_SCHEMA_MAX: '1',
    ASSISTANT_RELEASE_API_CONTRACT: '1',
  };
  return {
    name: 'projects/bmson-assistant/locations/us-west1/services/assistant-agent',
    template: {
      serviceAccount: env.GCP_DEPLOY_SERVICE_ACCOUNT,
      containers: [
        {
          image: `us-west1-docker.pkg.dev/bmson-assistant/assistant/agent@sha256:${'a'.repeat(64)}`,
          env: [
            ...Object.entries(values).map(([name, value]) => ({ name, value })),
            { name: 'PRIVATE_VALUE', value: 'secret-do-not-retain' },
            ...(target
              ? [
                  { name: 'ASSISTANT_WORKSPACE_ID', value: target.workspaceId },
                  { name: 'FIRESTORE_AGENT_ID', value: target.ownerId },
                ]
              : []),
          ],
        },
      ],
    },
    trafficStatuses: [{ revision: 'assistant-agent-00001-abc', percent: 100 }],
  };
}
describe('protected read-only release inventory', () => {
  it('binds the actual repository release contract to the inventory preflight', () => {
    const actualContract = JSON.parse(
      readFileSync(new URL('../infra/gcp/release-contracts.json', import.meta.url), 'utf8'),
    );
    expect(requiresBasicEditorPreflight(actualContract, true)).toBe(true);
    expect(() => requiresBasicEditorPreflight(actualContract, false)).toThrow(
      'capability declaration mismatch',
    );
  });

  it('requires the exact intrinsic person-note capability when the runtime exists', () => {
    const contract = (capability?: unknown) => ({
      components: { web: capability === undefined ? {} : { ownerEditorV1: capability } },
    });
    expect(requiresBasicEditorPreflight(contract(), false)).toBe(false);
    expect(requiresBasicEditorPreflight(contract([...BASIC_EDITOR_COMMANDS]), true)).toBe(true);
    for (const [capability, present] of [
      [undefined, true],
      [[], true],
      [[...BASIC_EDITOR_COMMANDS, 'remove_person'], true],
      [BASIC_EDITOR_COMMANDS.filter((command) => command !== 'create_owner_memory'), true],
      [[...BASIC_EDITOR_COMMANDS, 'unknown_command'], true],
      [BASIC_EDITOR_COMMANDS, false],
    ] as const)
      expect(() => requiresBasicEditorPreflight(contract(capability), present)).toThrow();
  });
  it('fails closed on unknown, missing, disabled or unbound epoch and incomplete release evidence', () => {
    const ready = {
      indexes: { status: 'exact_manifest_parity' },
      services: [{ servingRevisionVerified: true }, { servingRevisionVerified: true }],
      recoveryPoint: { kind: 'pitr' },
      editorReadiness: {
        status: 'ready',
        epochReady: true,
        ownerMatched: true,
        privacyBound: true,
        observationStable: true,
        consistentSnapshot: false,
      },
    };
    expect(() => requireBasicEditorReadiness(ready)).not.toThrow();
    for (const status of ['unknown', 'missing', 'unavailable'])
      expect(() =>
        requireBasicEditorReadiness({
          ...ready,
          editorReadiness: { ...ready.editorReadiness, status },
        }),
      ).toThrow();
    for (const property of ['epochReady', 'ownerMatched', 'privacyBound', 'observationStable'])
      expect(() =>
        requireBasicEditorReadiness({
          ...ready,
          editorReadiness: { ...ready.editorReadiness, [property]: false },
        }),
      ).toThrow();
    for (const change of [
      { indexes: { status: 'missing_approved_index' } },
      { recoveryPoint: null },
      { services: [] },
    ])
      expect(() => requireBasicEditorReadiness({ ...ready, ...change })).toThrow();
  });
  it('places the gate before delivery guard execution without changing automatic deploy triggers', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/deploy.yml', import.meta.url),
      'utf8',
    );
    expect(workflow.indexOf(' --release-preflight')).toBeLessThan(
      workflow.indexOf('python3 infra/gcp/firestore-delivery-guard.py run'),
    );
    expect(workflow).toContain('workflow_run:');
    expect(workflow).toContain('version: 576.0.0');
    expect(workflow).toContain(
      'basic editor delivery requires the reviewed Firestore production path',
    );
    expect(
      workflow.indexOf('basic editor delivery requires the reviewed Firestore production path'),
    ).toBeLessThan(workflow.indexOf(' --release-preflight'));
  });
  it.each([
    { runtime: false, driver: 'postgres', components: 'agent,web', succeeds: true },
    { runtime: true, driver: 'firestore', components: 'agent,web', succeeds: true },
    { runtime: true, driver: 'postgres', components: 'agent,web', succeeds: false },
    { runtime: true, driver: 'firestore', components: 'web', succeeds: false },
  ])(
    'executes actual workflow driver selection: %j',
    ({ runtime, driver, components, succeeds }) => {
      const workflow = readFileSync(
        new URL('../.github/workflows/deploy.yml', import.meta.url),
        'utf8',
      );
      const step = workflow
        .split('      - name: Resolve live release path')[1]
        ?.split('      - name:')[0];
      const script = step
        ?.split('        run: |\n')[1]
        ?.split('\n')
        .map((line) => line.replace(/^ {10}/, ''))
        .join('\n');
      if (!script) throw new Error('workflow selection missing');
      const dir = mkdtempSync(join(tmpdir(), 'editor-driver-test-'));
      try {
        if (runtime) {
          mkdirSync(join(dir, 'apps/web/lib'), { recursive: true });
          writeFileSync(join(dir, 'apps/web/lib/owner-editor-runtime.ts'), 'test-only');
        }
        const output = join(dir, 'output');
        const result = spawnSync(
          'bash',
          [
            '-euo',
            'pipefail',
            '-c',
            `gcloud() { node -e 'process.stdout.write(process.env.SERVICE_JSON)'; }\n${script}`,
          ],
          {
            cwd: dir,
            encoding: 'utf8',
            env: {
              PATH: process.env.PATH,
              RELEASE_COMPONENTS: components,
              GCP_PROJECT: 'bmson-assistant',
              GCP_REGION: 'us-west1',
              GITHUB_OUTPUT: output,
              SERVICE_JSON: JSON.stringify({
                spec: {
                  template: {
                    spec: {
                      containers: [{ env: [{ name: 'PERSISTENCE_DRIVER', value: driver }] }],
                    },
                  },
                },
              }),
            },
          },
        );
        expect(result.status === 0, result.stderr).toBe(succeeds);
        if (succeeds)
          expect(readFileSync(output, 'utf8')).toContain(
            `firestore_pair=${driver === 'firestore'}`,
          );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it('pins manifest bytes and rejects pre-auth source drift', () => {
    expect(verifyManifest(manifest).groups).toContain('ownerEditorOperations');
    expect(() => verifyManifest(Buffer.concat([manifest, Buffer.from(' ')]))).toThrow();
  });
  it.each([
    `http://firestore.googleapis.com/v1/${DATABASE}`,
    `https://evil.example/v1/${DATABASE}`,
    'https://firestore.googleapis.com/v1/projects/other/databases/assistant-production',
    `https://firestore.googleapis.com/v1/${DATABASE}/documents/private`,
    'https://run.googleapis.com/v2/projects/bmson-assistant/locations/us-west1/services/assistant-web?alt=media',
    `https://firestore.googleapis.com/v1/${DATABASE}/collectionGroups/-/fields`,
  ])('rejects target %s before dispatch', (url) => expect(() => allowedUrl(url)).toThrow());
  it.each([
    String.fromCharCode(0),
    String.fromCharCode(9),
    ' ',
    String.fromCharCode(31),
    String.fromCharCode(32),
    String.fromCharCode(127),
    'a'.repeat(2049),
  ])('rejects bounded/control page tokens before dispatch', (token) => {
    const url = new URL(
      `https://firestore.googleapis.com/v1/${DATABASE}/collectionGroups/-/indexes`,
    );
    url.searchParams.set('pageToken', token);
    expect(() => allowedUrl(url.href)).toThrow();
  });
  it('requires complete pagination and rejects repeated tokens', async () => {
    let calls = 0;
    await expect(
      listPages(
        async () => {
          calls++;
          return { indexes: [], nextPageToken: 'again' };
        },
        `https://firestore.googleapis.com/v1/${DATABASE}/collectionGroups/-/indexes`,
        'indexes',
      ),
    ).rejects.toThrow('repeated');
    expect(calls).toBe(2);
  });
  it('rejects omitted or malformed page identities and unexpected page data', async () => {
    await expect(
      listPages(
        async () => ({ indexes: {}, nextPageToken: '' }),
        `https://firestore.googleapis.com/v1/${DATABASE}/collectionGroups/-/indexes`,
        'indexes',
      ),
    ).rejects.toThrow();
    await expect(
      listPages(
        async () => ({ indexes: [], unexpected: 'secret' }),
        `https://firestore.googleapis.com/v1/${DATABASE}/collectionGroups/-/indexes`,
        'indexes',
      ),
    ).rejects.toThrow();
  });
  it('accepts explicit WIF configuration without claiming caller provenance', () =>
    expect(verifyWifEnvironment(env, () => credential).principal).toBe(
      env.GCP_DEPLOY_SERVICE_ACCOUNT,
    ));
  it.each([
    { ...env, GITHUB_RUN_ATTEMPT: '2' },
    { ...env, GITHUB_REF: 'refs/heads/topic' },
    { ...env, CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/home/default.json' },
    { ...env, GOOGLE_APPLICATION_CREDENTIALS: '/different.json' },
  ])('rejects default/untrusted credential context', (input) =>
    expect(() => verifyWifEnvironment(input, () => credential)).toThrow(),
  );
  it('rejects wrong WIF audience or impersonated account', () => {
    expect(() =>
      verifyWifEnvironment(env, () => ({ ...credential, audience: '//wrong' })),
    ).toThrow();
    expect(() =>
      verifyWifEnvironment(env, () => ({
        ...credential,
        service_account_impersonation_url: 'https://evil/token',
      })),
    ).toThrow();
  });
  it('requires known PITR retention and valid coverage', () => {
    expect(recoveryPoint(db, [], now)).toMatchObject({ kind: 'pitr', restorationProven: false });
    expect(() => recoveryPoint({ ...db, earliestVersionTime: 'unknown' }, [], now)).toThrow();
    expect(() => recoveryPoint({ ...db, versionRetentionPeriod: undefined }, [], now)).toThrow();
    expect(() => recoveryPoint({ ...db, name: `${DATABASE}other` }, [], now)).toThrow();
  });
  it('reports backup uncovered interval and rejects stale or foreign backups', () => {
    const backup = {
      name: 'projects/bmson-assistant/locations/us-west1/backups/b1',
      database: DATABASE,
      databaseUid: db.uid,
      state: 'READY',
      snapshotTime: '2026-10-26T16:00:00Z',
      expireTime: '2026-10-27T00:00:00Z',
    };
    expect(
      recoveryPoint(
        { ...db, pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_DISABLED' },
        [backup],
        now,
      ),
    ).toMatchObject({
      kind: 'backup',
      uncoveredWriteIntervalSeconds: 3600,
      restorationProven: false,
    });
    expect(() =>
      recoveryPoint(
        { ...db, pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_DISABLED' },
        [{ ...backup, database: 'foreign' }],
        now,
      ),
    ).toThrow();
    expect(() =>
      recoveryPoint(
        { ...db, pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_DISABLED' },
        [{ ...backup, snapshotTime: '2026-10-20T16:00:00Z' }],
        now,
      ),
    ).toThrow();
  });
  it('binds recovery observations to the current database incarnation', () => {
    const disabled = { ...db, pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_DISABLED' };
    const backup = {
      name: 'projects/bmson-assistant/locations/us-west1/backups/b1',
      database: DATABASE,
      databaseUid: db.uid,
      state: 'READY',
      snapshotTime: '2026-10-26T16:00:00Z',
      expireTime: '2026-10-27T00:00:00Z',
    };
    expect(recoveryPoint(disabled, [backup], now).databaseUid).toBe(db.uid);
    expect(() =>
      recoveryPoint(
        disabled,
        [{ ...backup, databaseUid: '22222222-2222-4222-8222-222222222222' }],
        now,
      ),
    ).toThrow('incarnation');
    expect(() => recoveryPoint(disabled, [{ ...backup, databaseUid: undefined }], now)).toThrow();
    expect(() => recoveryPoint({ ...disabled, uid: undefined }, [backup], now)).toThrow();
    expect(() => recoveryPoint({ ...db, uid: 'not-a-uuid' }, [], now)).toThrow();
  });
  it('keeps PITR observation time separate from an unqualified whole-minute proposal', () => {
    const result = recoveryPoint(db, [], now + 12345);
    expect(result).toMatchObject({
      kind: 'pitr',
      observedAt: '2026-10-26T17:00:12.345Z',
      operationCheckpoint: null,
      operationCheckpointQualified: false,
      proposedWholeMinuteSnapshot: '2026-10-26T17:00:00.000Z',
      roundingMilliseconds: 12345,
      uncoveredWriteIntervalMilliseconds: 12345,
      expiryGuaranteed: false,
      restorationProven: false,
    });
    const boundary = recoveryPoint(
      { ...db, earliestVersionTime: '2026-10-26T17:00:00.001Z' },
      [],
      now + 12345,
    );
    expect(boundary).toMatchObject({
      proposedWholeMinuteSnapshot: null,
      checkpointLimitation: 'rounded_minute_outside_observed_coverage',
      operationCheckpoint: null,
      operationCheckpointQualified: false,
    });
    expect(() =>
      recoveryPoint({ ...db, earliestVersionTime: '2026-10-26T17:01:00Z' }, [], now + 12345),
    ).toThrow();
  });
  it.each(['2026-10-26T17:00:00.000000001Z', '2026-10-26T17:00:00.000999999Z'])(
    'preserves sub-millisecond coverage bound %s and refuses the preceding minute',
    (earliestVersionTime) => {
      expect(recoveryPoint({ ...db, earliestVersionTime }, [], now + 12345)).toMatchObject({
        earliestVersionTime,
        earliestComparisonUpperBound: '2026-10-26T17:00:00.001Z',
        proposedWholeMinuteSnapshot: null,
        operationCheckpoint: null,
        operationCheckpointQualified: false,
        checkpointLimitation: 'rounded_minute_outside_observed_coverage',
      });
    },
  );
  it('accepts an exactly representable minute without moving the coverage lower bound', () => {
    expect(
      recoveryPoint(
        { ...db, earliestVersionTime: '2026-10-26T17:00:00.000000000Z' },
        [],
        now + 12345,
      ),
    ).toMatchObject({
      earliestVersionTime: '2026-10-26T17:00:00.000000000Z',
      earliestComparisonUpperBound: '2026-10-26T17:00:00.000Z',
      proposedWholeMinuteSnapshot: '2026-10-26T17:00:00.000Z',
      operationCheckpointQualified: false,
    });
  });
  it('uses conservative directional backup time bounds and preserves wire facts', () => {
    const disabled = { ...db, pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_DISABLED' };
    const backup = {
      name: 'projects/bmson-assistant/locations/us-west1/backups/b1',
      database: DATABASE,
      databaseUid: db.uid,
      state: 'READY',
      snapshotTime: '2026-10-25T15:00:00.000000000Z',
      expireTime: '2026-10-27T00:00:00.000000001Z',
    };
    expect(recoveryPoint(disabled, [backup], now)).toMatchObject({
      kind: 'backup',
      snapshotTime: backup.snapshotTime,
      checkpoint: backup.snapshotTime,
      expiresAt: backup.expireTime,
      snapshotAgeComparisonLowerBound: '2026-10-25T15:00:00.000Z',
      snapshotFutureComparisonUpperBound: '2026-10-25T15:00:00.000Z',
      expiryComparisonLowerBound: '2026-10-27T00:00:00.000Z',
      operationCheckpointQualified: false,
    });
    expect(() =>
      recoveryPoint(disabled, [{ ...backup, snapshotTime: '2026-10-25T14:59:59.999999999Z' }], now),
    ).toThrow();
    expect(() =>
      recoveryPoint(disabled, [{ ...backup, snapshotTime: '2026-10-26T17:00:00.000000001Z' }], now),
    ).toThrow();
    expect(() =>
      recoveryPoint(disabled, [{ ...backup, expireTime: '2026-10-26T17:00:00.000000001Z' }], now),
    ).toThrow();
    expect(() =>
      recoveryPoint(disabled, [{ ...backup, expireTime: '2026-10-26T17:00:00.000000000Z' }], now),
    ).toThrow();
    expect(
      recoveryPoint(disabled, [{ ...backup, expireTime: '2026-10-26T17:00:00.001000000Z' }], now),
    ).toMatchObject({ kind: 'backup', expiresAt: '2026-10-26T17:00:00.001000000Z' });
  });
  it('retains only approved release fields and hashes the private configuration', () => {
    const facts = serviceFacts(service(), 'agent');
    expect(JSON.stringify(facts)).not.toContain('secret-do-not-retain');
    expect(facts.servingRevisionVerified).toBe(false);
    expect(() => serviceFacts({ ...service(), trafficStatuses: [] }, 'agent')).toThrow();
  });
  it('dispatches GET only, rejects redirect mode changes and limits body bytes', async () => {
    const calls: RequestInit[] = [];
    const fake = (async (_url: unknown, options: RequestInit) => {
      calls.push(options);
      return new Response('{}');
    }) as typeof fetch;
    await createReadOnlyGet(
      'a'.repeat(30),
      Date.now() + 1000,
      fake,
    )(`https://firestore.googleapis.com/v1/${DATABASE}`);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', redirect: 'error' });
    const huge = (async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))) as typeof fetch;
    await expect(
      createReadOnlyGet(
        'a'.repeat(30),
        Date.now() + 1000,
        huge,
      )(`https://firestore.googleapis.com/v1/${DATABASE}`),
    ).rejects.toThrow('bound');
  });
  it('does not dispatch after deadline or invalid target', async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response('{}');
    }) as typeof fetch;
    const read = createReadOnlyGet('a'.repeat(30), Date.now() - 1, fake);
    await expect(read(`https://firestore.googleapis.com/v1/${DATABASE}`)).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it.each(['bound', 'unbound', 'mismatched', 'revision-mismatch'] as const)(
    'collects and redacts editor target state: %s',
    async (mode) => {
      const target = {
        workspaceId: 'private-installation',
        ownerId: '11111111-1111-4111-8111-111111111111',
      };
      let observations = 0;
      const spec = JSON.parse(manifest.toString()) as {
        indexes: Array<{
          collectionGroup: string;
          queryScope: string;
          fields: Array<Record<string, unknown>>;
        }>;
        fieldOverrides: Array<{ collectionGroup: string; fieldPath: string }>;
      };
      const prefix = `${DATABASE}/collectionGroups/`;
      const composites = spec.indexes.map((index, n) => {
        const fields = index.fields.map((field) => ({ ...field }));
        if (!fields.some((field) => field.fieldPath === '__name__')) {
          const position = fields.findIndex((field) => field.vectorConfig !== undefined);
          const name = {
            fieldPath: '__name__',
            order: fields.at(-1)?.order === 'DESCENDING' ? 'DESCENDING' : 'ASCENDING',
          };
          if (position >= 0) fields.splice(position, 0, name);
          else fields.push(name);
        }
        return {
          name: `${prefix}${index.collectionGroup}/indexes/i${n}`,
          fields,
          queryScope: index.queryScope,
          state: 'READY',
        };
      });
      const fields = [
        ...spec.fieldOverrides.map((field) => ({
          name: `${prefix}${field.collectionGroup}/fields/${field.fieldPath}`,
          indexConfig: {},
        })),
        {
          name: `${prefix}__default__/fields/*`,
          indexConfig: {
            usesAncestorConfig: false,
            reverting: false,
            indexes: [
              {
                queryScope: 'COLLECTION',
                state: 'READY',
                fields: [{ fieldPath: '*', order: 'ASCENDING' }],
              },
              {
                queryScope: 'COLLECTION',
                state: 'READY',
                fields: [{ fieldPath: '*', order: 'DESCENDING' }],
              },
              {
                queryScope: 'COLLECTION',
                state: 'READY',
                fields: [{ fieldPath: '*', arrayConfig: 'CONTAINS' }],
              },
            ],
          },
        },
      ];
      const calls: string[] = [];
      const read = async (url: string) => {
        calls.push(url);
        if (url === `https://firestore.googleapis.com/v1/${DATABASE}`) return db;
        const component = url.includes('assistant-web') ? 'web' : 'agent';
        const svc = JSON.parse(
          JSON.stringify(
            service(
              mode === 'unbound'
                ? undefined
                : {
                    ...target,
                    workspaceId:
                      mode === 'mismatched' && component === 'web'
                        ? 'other-installation'
                        : target.workspaceId,
                  },
            ),
          )
            .replaceAll('assistant-agent', `assistant-${component}`)
            .replaceAll('/agent@', `/${component}@`),
        ) as ReturnType<typeof service>;
        const traffic = svc.trafficStatuses[0];
        if (!traffic) throw new Error('missing fake traffic fixture');
        if (url.includes('/revisions/')) {
          if (mode === 'revision-mismatch')
            svc.template.containers[0]?.env.push({
              name: 'FIRESTORE_AGENT_ID',
              value: target.ownerId,
            });
          return {
            name: `${svc.name}/revisions/${traffic.revision}`,
            ...svc.template,
          };
        }
        return svc;
      };
      const lists = { composites, fields, evidence: 'pinned-gcloud-576-complete-lists' as const };
      const observe = async (observed: typeof target) => {
        observations++;
        expect(observed).toEqual(target);
        return { status: 'missing', reason: 'editor_epoch_missing' };
      };
      if (mode === 'revision-mismatch') {
        await expect(collectInventory(read, manifest, now, lists, observe)).rejects.toThrow(
          'serving editor target mismatch',
        );
        expect(observations).toBe(0);
        return;
      }
      const result = await collectInventory(read, manifest, now, lists, observe);
      expect(observations).toBe(mode === 'bound' ? 1 : 0);
      expect(result.editorReadiness).toEqual(
        mode === 'bound'
          ? { status: 'missing', reason: 'editor_epoch_missing' }
          : { status: 'unknown', reason: 'editor_target_unbound_or_not_collected' },
      );
      expect(JSON.stringify(result)).not.toContain(target.workspaceId);
      // Database incarnation uses a different UUID from the private owner target.
      expect(JSON.stringify(result.services)).not.toContain(target.ownerId);
      expect(result.indexes.status).toBe('exact_manifest_parity');
      expect(result).toMatchObject({
        trafficAuthorized: false,
        maintenanceAuthorized: false,
        mutationAuthorized: false,
        recoveryPairQualified: false,
      });
      expect(result.services.every((item) => item.servingRevisionVerified)).toBe(true);
      expect(calls).toHaveLength(5);
      expect(JSON.stringify(result)).not.toContain('secret-do-not-retain');
      await expect(
        collectInventory(
          async (url) => (url.includes('/revisions/') ? { name: 'wrong' } : read(url)),
          manifest,
          now,
          { composites, fields, evidence: 'pinned-gcloud-576-complete-lists' },
        ),
      ).rejects.toThrow();
    },
  );
  it('fails closed without promoting a partial collector to authority', async () => {
    await expect(
      collectInventory(async () => ({ unexpected: 'do-not-retain' }), manifest, now),
    ).rejects.toThrow();
  });
});
