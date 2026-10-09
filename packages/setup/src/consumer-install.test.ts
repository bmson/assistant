import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { provisionConsumerInstallation } from './consumer-install.js';
import { advanceInstallationStage, createInstallationManifest } from './installation-manifest.js';
import { sha256File } from './installation-provenance.js';
import type { CommandRunner } from './runner.js';

const execFileAsync = promisify(execFile);
const requiredServiceRows = [
  'artifactregistry.googleapis.com',
  'cloudresourcemanager.googleapis.com',
  'firestore.googleapis.com',
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
  'serviceusage.googleapis.com',
  'storage.googleapis.com',
  'aiplatform.googleapis.com',
].map((name) => ({ config: { name } }));
const indexSpec = JSON.parse(
  readFileSync('infra/gcp/firestore/firestore.indexes.json', 'utf8'),
) as {
  indexes: Array<{
    collectionGroup: string;
    queryScope: string;
    fields: Array<{
      fieldPath: string;
      order?: string;
      vectorConfig?: { dimension: number; flat: Record<string, never> };
    }>;
  }>;
  fieldOverrides: Array<{ collectionGroup: string; fieldPath: string }>;
};
const indexPrefix = 'projects/customer-project/databases/(default)/collectionGroups/';
const compositeIndexRows = indexSpec.indexes.map((index, number) => {
  const fields = [...index.fields];
  if (!fields.some((field) => field.fieldPath === '__name__')) {
    const documentName = {
      fieldPath: '__name__',
      order: index.fields.at(-1)?.order === 'DESCENDING' ? 'DESCENDING' : 'ASCENDING',
    };
    const vectorPosition = fields.findIndex((field) => field.vectorConfig !== undefined);
    if (vectorPosition === fields.length - 1) fields.splice(vectorPosition, 0, documentName);
    else fields.push(documentName);
  }
  return {
    name: `${indexPrefix}${index.collectionGroup}/indexes/${number + 1}`,
    queryScope: index.queryScope,
    fields,
    state: 'READY',
  };
});
const fieldOverrideRows = indexSpec.fieldOverrides.map((field) => ({
  name: `${indexPrefix}${field.collectionGroup}/fields/${field.fieldPath}`,
  indexConfig: { indexes: [] },
}));

const archiveFiles = [
  'infra/gcp/consumer/terraform/main.tf',
  'infra/gcp/consumer/terraform/variables.tf',
  'infra/gcp/consumer/terraform/outputs.tf',
  'infra/gcp/consumer/terraform/versions.tf',
  'infra/gcp/consumer/terraform/.terraform.lock.hcl',
  'infra/gcp/consumer/terraform/firestore-indexes.tf',
  'infra/gcp/firestore/firestore.indexes.json',
  'infra/gcp/consumer/terraform/runtime.tf',
] as const;

async function foundationArchive(
  path: string,
  options: { omit?: string; replace?: { path: string; content: string } } = {},
): Promise<void> {
  let source = process.cwd();
  if (options.replace) {
    source = await mkdtemp(join(tmpdir(), 'assistant-consumer-archive-'));
    for (const file of archiveFiles) {
      const destination = join(source, file);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(
        destination,
        file === options.replace.path
          ? options.replace.content
          : await readFile(resolve(process.cwd(), file)),
      );
    }
  }
  await execFileAsync(
    'tar',
    ['-czf', path, '-C', source, ...archiveFiles.filter((file) => file !== options.omit)],
    { env: { ...process.env, COPYFILE_DISABLE: '1' } },
  );
}

function manifest(digest: string, dailyBackupRetentionDays?: number) {
  return createInstallationManifest({
    identity: {
      installationId: 'consumer-install',
      projectId: 'customer-project',
      region: 'us-central1',
      databaseId: '(default)',
      release: {
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        archiveDigest: digest,
      },
    },
    modules: [],
    modelProvider: 'google',
    ...(dailyBackupRetentionDays === undefined
      ? {}
      : {
          backupSchedule: { recurrence: 'daily' as const, retentionDays: dailyBackupRetentionDays },
        }),
    resources: [],
    createdAt: '2026-09-12T12:00:00.000Z',
  });
}

function fakeRunner(
  log: string[],
  describeBucket = false,
  firestoreList = '[]',
  terraformOutput: unknown = {
    project_id: { value: 'customer-project' },
    installation_id: { value: 'consumer-install' },
    region: { value: 'us-central1' },
    firestore_database_name: { value: '(default)' },
    daily_backup_schedule_name: { value: null },
    assets_bucket_name: { value: 'customer-project-consumer-install-assets' },
    source_bucket_name: { value: 'customer-project-consumer-install-source' },
    artifact_registry_repository: {
      value: 'consumer-install',
    },
    runtime_service_account_email: {
      value: 'consumer-install-runtime@customer-project.iam.gserviceaccount.com',
    },
  },
  foreignBucket = false,
  receiptDigest = '',
): CommandRunner {
  return {
    async run(command, args) {
      log.push([command, ...args].join(' '));
      if (command === 'terraform' && args[0] === 'version') {
        return { ok: true, stdout: '{"terraform_version":"1.14.5"}', stderr: '' };
      }
      if (command === 'gcloud' && args[0] === 'auth' && args[1] === 'print-access-token') {
        return { ok: true, stdout: 'test-access-token', stderr: '' };
      }
      if (command === 'gcloud' && args[0] === 'projects') {
        return {
          ok: true,
          stdout: args.includes('--format=value(projectNumber)') ? '123456789' : 'customer-project',
          stderr: '',
        };
      }
      if (command === 'gcloud' && args[0] === 'billing') {
        return {
          ok: true,
          stdout: JSON.stringify({
            projectId: 'customer-project',
            billingEnabled: true,
            billingAccountName: 'billingAccounts/ABCDEF-123456-ABCDEF',
          }),
          stderr: '',
        };
      }
      if (
        command === 'gcloud' &&
        args[0] === 'secrets' &&
        args[1] === 'versions' &&
        args[2] === 'describe'
      ) {
        return { ok: true, stdout: JSON.stringify({ state: 'ENABLED' }), stderr: '' };
      }
      if (command === 'gcloud' && args[0] === 'services') {
        return { ok: true, stdout: JSON.stringify(requiredServiceRows), stderr: '' };
      }
      if (command === 'gcloud' && args[0] === 'firestore' && args[1] === 'indexes') {
        return {
          ok: true,
          stdout: JSON.stringify(args[2] === 'composite' ? compositeIndexRows : fieldOverrideRows),
          stderr: '',
        };
      }
      if (command === 'gcloud' && args[0] === 'firestore') {
        return { ok: true, stdout: firestoreList, stderr: '' };
      }
      if (
        command === 'gcloud' &&
        args[0] === 'storage' &&
        args[1] === 'buckets' &&
        args[2] === 'describe'
      ) {
        return describeBucket
          ? {
              ok: true,
              stdout: JSON.stringify({
                name: 'customer-project-consumer-install-state',
                project_number: '123456789',
                location: 'US-CENTRAL1',
                uniform_bucket_level_access: true,
                public_access_prevention: 'enforced',
                labels: foreignBucket
                  ? { installation: 'other', managed_by: 'terraform' }
                  : {
                      installation: 'consumer-install',
                      managed_by: 'assistant-consumer-bootstrap',
                    },
              }),
              stderr: '',
            }
          : { ok: false, stdout: '', stderr: 'NOT_FOUND' };
      }
      if (
        command === 'gcloud' &&
        args[0] === 'storage' &&
        args[1] === 'objects' &&
        args[2] === 'describe'
      ) {
        return describeBucket
          ? {
              ok: true,
              stdout: JSON.stringify({
                metadata: {
                  assistant_installation: foreignBucket ? 'other' : 'consumer-install',
                  assistant_archive_digest: receiptDigest,
                },
              }),
              stderr: '',
            }
          : { ok: false, stdout: '', stderr: 'NOT_FOUND' };
      }
      if (command === 'terraform' && args.includes('output')) {
        return { ok: true, stdout: JSON.stringify(terraformOutput), stderr: '' };
      }
      if (command === 'terraform' && args.includes('show') && args.includes('-json')) {
        return { ok: true, stdout: JSON.stringify({ resource_changes: [] }), stderr: '' };
      }
      return { ok: true, stdout: '{}', stderr: '' };
    },
  };
}

describe('consumer installation', () => {
  it('checks Terraform compatibility before creating customer resources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-terraform-version-'));
    const archive = join(dir, 'release.tar.gz');
    const state = join(dir, 'state.json');
    await foundationArchive(archive);
    const log: string[] = [];
    const runner = fakeRunner(log);
    const baseRun = runner.run.bind(runner);
    runner.run = (command, args) =>
      command === 'terraform' && args[0] === 'version'
        ? Promise.resolve({
            ok: true,
            stdout: '{"terraform_version":"1.5.7"}',
            stderr: '',
          })
        : baseRun(command, args);

    await expect(
      provisionConsumerInstallation(
        { runner },
        {
          manifest: manifest(await sha256File(archive)),
          archivePath: archive,
          statePath: state,
          terraformDir: 'infra/gcp/consumer/terraform',
          stateBucket: 'customer-project-consumer-install-state',
          apply: true,
        },
      ),
    ).rejects.toThrow('Terraform 1.5.7 is too old');
    expect(log.some((entry) => entry.includes('storage buckets create'))).toBe(false);
    expect(log.some((entry) => entry.startsWith('terraform -chdir='))).toBe(false);
    await expect(readFile(state)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    {
      name: 'disabled billing',
      billing: {
        ok: true,
        stdout: JSON.stringify({ projectId: 'customer-project', billingEnabled: false }),
        stderr: '',
      },
      message: 'needs an active billing account',
    },
    {
      name: 'unverifiable billing',
      billing: { ok: false, stdout: '', stderr: 'private billing account details' },
      message: 'Cannot verify billing',
    },
  ])('stops before any cloud mutation for $name', async ({ billing, message }) => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-billing-'));
    const archive = join(dir, 'release.tar.gz');
    const state = join(dir, 'state.json');
    await foundationArchive(archive);
    const log: string[] = [];
    const runner = fakeRunner(log);
    const baseRun = runner.run.bind(runner);
    runner.run = (command, args) =>
      command === 'gcloud' && args[0] === 'billing'
        ? Promise.resolve(billing)
        : baseRun(command, args);
    await expect(
      provisionConsumerInstallation(
        { runner },
        {
          manifest: manifest(await sha256File(archive)),
          archivePath: archive,
          statePath: state,
          terraformDir: 'infra/gcp/consumer/terraform',
          stateBucket: 'customer-project-consumer-install-state',
          apply: true,
        },
      ),
    ).rejects.toThrow(message);
    expect(
      log.some(
        (entry) =>
          entry.includes('services enable') ||
          entry.includes('storage buckets create') ||
          entry.includes('terraform'),
      ),
    ).toBe(false);
    await expect(readFile(state)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rechecks billing before resuming a provisioned foundation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-billing-'));
    const archive = join(dir, 'release.tar.gz');
    const state = join(dir, 'state.json');
    await foundationArchive(archive);
    const source = manifest(await sha256File(archive));
    const options = {
      manifest: source,
      archivePath: archive,
      statePath: state,
      terraformDir: 'infra/gcp/consumer/terraform',
      stateBucket: 'customer-project-consumer-install-state',
      apply: true,
      now: () => '2026-09-12T12:00:10.000Z',
    };
    await provisionConsumerInstallation({ runner: fakeRunner([]) }, options);
    const log: string[] = [];
    const runner = fakeRunner(log);
    const baseRun = runner.run.bind(runner);
    runner.run = (command, args) =>
      command === 'gcloud' && args[0] === 'billing'
        ? Promise.resolve({ ok: true, stdout: '{"billingEnabled":false}', stderr: '' })
        : baseRun(command, args);
    await expect(provisionConsumerInstallation({ runner }, options)).rejects.toThrow(
      'needs an active billing account',
    );
    expect(log.some((entry) => entry.startsWith('terraform'))).toBe(false);
    expect(JSON.parse(await readFile(state, 'utf8')).stage.current).toBe('provisioned');
  });

  const runtimeConfig = {
    firestoreAgentId: '11111111-1111-4111-8111-111111111111',
    firestoreEmbeddingSpace: {
      provider: 'vertex',
      model: 'gemini-embedding-001',
      dimensions: 1536,
      revision: 'seed-v1',
    },
    vertexLocation: 'global',
    ownerEmail: 'owner@example.com',
    webAuthUrl: 'https://assistant.example.com',
    authSecretVersion: 1,
    googleClientIdVersion: 2,
    googleClientSecretVersion: 3,
  };
  const runtimeImages = (() => {
    const root = 'us-central1-docker.pkg.dev/customer-project/consumer-install';
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const web = `sha256:${'a'.repeat(64)}`;
    const agent = `sha256:${'b'.repeat(64)}`;
    return {
      schemaVersion: 1,
      sourceSha: sha,
      sourceArchiveDigest: `sha256:${'c'.repeat(64)}`,
      projectId: 'customer-project',
      region: 'us-central1',
      repositoryId: 'consumer-install',
      tags: { web: `${root}/web:${sha}`, agent: `${root}/agent:${sha}` },
      images: {
        web: { digest: web, reference: `${root}/web@${web}`, tag: `${root}/web:${sha}` },
        agent: { digest: agent, reference: `${root}/agent@${agent}`, tag: `${root}/agent:${sha}` },
      },
      terraform: { web_image_digest: web, agent_image_digest: agent },
    };
  })();

  it('deploys a verified private runtime and checkpoints only after both revisions are ready', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-runtime-'));
    const archive = join(dir, 'release.tar.gz');
    const state = join(dir, 'state.json');
    await foundationArchive(archive);
    const source = manifest(await sha256File(archive), 7);
    const logs: string[] = [];
    const runner = fakeRunner(logs);
    let agentPublic = false;
    let agentIamDisabled = false;
    let broadPlan = false;
    let secretEnabled = true;
    let mobileSecretEnabled = true;
    const secretLookups: string[] = [];
    const baseRun = runner.run.bind(runner);
    runner.run = async (command, args) => {
      if (command === 'gcloud' && args[0] === 'secrets') {
        secretLookups.push(args.join(' '));
        return {
          ok: true,
          stdout: JSON.stringify({
            state:
              secretEnabled &&
              (!args.some((arg) => arg.includes('mobile-api-token')) || mobileSecretEnabled)
                ? 'ENABLED'
                : 'DISABLED',
          }),
          stderr: '',
        };
      }
      if (command === 'gcloud' && args[0] === 'run' && args[2] === 'get-iam-policy') {
        const publicWeb =
          args[3]?.endsWith('-web') &&
          logs.some((entry) => entry.includes('apply') && entry.includes('owner-access.tfplan'));
        return {
          ok: true,
          stdout: JSON.stringify({
            bindings:
              publicWeb || (agentPublic && args[3]?.endsWith('-agent'))
                ? [{ role: 'roles/run.invoker', members: ['allUsers'] }]
                : [],
          }),
          stderr: '',
        };
      }
      if (command === 'gcloud' && args[0] === 'run') {
        const name = args[3]?.endsWith('-web') ? 'web' : 'agent';
        if (name === 'agent')
          return {
            ok: true,
            stdout: JSON.stringify({
              metadata: {
                name: 'consumer-install-agent',
                annotations: {
                  'run.googleapis.com/invoker-iam-disabled': agentIamDisabled ? 'true' : 'false',
                },
              },
              spec: {
                template: {
                  spec: {
                    containers: [
                      {
                        image: runtimeImages.images.agent.reference,
                        env: [{ name: 'ASSISTANT_RELEASE_SHA', value: runtimeImages.sourceSha }],
                      },
                    ],
                  },
                },
              },
              // Cloud Run service metadata carries the template env on the
              // service spec in production; include both the service-level
              // view and the legacy template fixture shape here.
              template: {
                containers: [
                  {
                    image: runtimeImages.images.agent.reference,
                    env: [{ name: 'ASSISTANT_RELEASE_SHA', value: runtimeImages.sourceSha }],
                  },
                ],
              },
              status: {
                conditions: [{ type: 'Ready', status: 'True' }],
                latestCreatedRevisionName: 'rev-2',
                latestReadyRevisionName: 'rev-2',
                traffic: [{ revisionName: 'rev-2', percent: 100 }],
              },
            }),
            stderr: '',
          };
        return {
          ok: true,
          stdout: JSON.stringify({
            name: `consumer-install-${name}`,
            uri: 'https://consumer-install-web-abc.a.run.app',
            invokerIamDisabled: false,
            template: {
              containers: [
                {
                  image: runtimeImages.images[name].reference,
                  env: [
                    { name: 'OWNER_EMAIL', value: runtimeConfig.ownerEmail },
                    { name: 'AUTH_URL', value: runtimeConfig.webAuthUrl },
                    { name: 'AUTH_DEV_BYPASS', value: 'false' },
                    { name: 'AUTH_LOCALHOST_BYPASS', value: 'false' },
                    { name: 'VERTEX_LOCATION', value: runtimeConfig.vertexLocation },
                    { name: 'ASSISTANT_RELEASE_SHA', value: runtimeImages.sourceSha },
                  ],
                },
              ],
            },
            conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
            latestCreatedRevision: 'rev-1',
            latestReadyRevision: 'rev-1',
            status: { traffic: [{ revisionName: 'rev-1', percent: 100 }] },
          }),
          stderr: '',
        };
      }
      if (command === 'terraform' && args.includes('output')) {
        const result = await baseRun(command, args);
        return {
          ...result,
          stdout: JSON.stringify({
            ...JSON.parse(result.stdout),
            cloud_run_web_service_name: { value: 'consumer-install-web' },
            cloud_run_agent_service_name: { value: 'consumer-install-agent' },
            daily_backup_schedule_name: {
              value: 'projects/customer-project/databases/(default)/backupSchedules/daily',
            },
          }),
        };
      }
      if (command === 'terraform' && args.includes('show')) {
        return {
          ok: true,
          stdout: JSON.stringify({
            resource_changes: [
              {
                address: 'google_cloud_run_v2_service_iam_member.web_public["current"]',
                change: {
                  actions: ['create'],
                  after: {
                    member: 'allUsers',
                    role: 'roles/run.invoker',
                    name: 'consumer-install-web',
                  },
                },
              },
              ...(broadPlan
                ? [
                    {
                      address: 'google_cloud_run_v2_service.agent["current"]',
                      change: { actions: ['update'] },
                    },
                  ]
                : []),
            ],
          }),
          stderr: '',
        };
      }
      return baseRun(command, args);
    };
    const options = {
      manifest: source,
      archivePath: archive,
      statePath: state,
      terraformDir: 'infra/gcp/consumer/terraform',
      stateBucket: 'customer-project-consumer-install-state',
      apply: true,
      now: () => '2026-09-12T12:00:10.000Z',
    };
    const foundation = await provisionConsumerInstallation({ runner }, options);
    expect(foundation.manifest.stage.current).toBe('provisioned');
    await expect(
      provisionConsumerInstallation(
        { runner },
        {
          ...options,
          runtime: {
            images: runtimeImages,
            config: { ...runtimeConfig, vertexLocation: 'not-a-location' },
          },
        },
      ),
    ).rejects.toThrow('Vertex region or global');
    const runtime = {
      images: runtimeImages,
      config: { ...runtimeConfig, mobileApiTokenVersion: 4 },
    };
    const beforeIamGate = logs.length;
    await expect(
      provisionConsumerInstallation(
        {
          runner,
          fetcher: async () =>
            new Response(JSON.stringify({ permissions: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        },
        { ...options, runtime },
      ),
    ).rejects.toThrow(
      'Cloud Run deployer lacks iam.serviceAccounts.actAs on consumer-install-runtime@customer-project.iam.gserviceaccount.com; grant roles/iam.serviceAccountUser on this service account, then retry',
    );
    expect(
      logs
        .slice(beforeIamGate)
        .some((entry) => entry.includes('-target=google_service_account.web')),
    ).toBe(true);
    expect(
      logs
        .slice(beforeIamGate)
        .some(
          (entry) =>
            entry.includes('apply') &&
            entry.includes('web_image_digest=') &&
            !entry.includes('-target=google_service_account.web'),
        ),
    ).toBe(false);
    const iamChecks: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      iamChecks.push(`${String(input)} ${new Headers(init?.headers).get('authorization')}`);
      return new Response(JSON.stringify({ permissions: ['iam.serviceAccounts.actAs'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const result = await provisionConsumerInstallation(
      { runner, fetcher },
      { ...options, runtime },
    );
    expect(result.manifest.stage.current).toBe('initialized');
    expect(result.manifest.selection.backupSchedule).toEqual({
      recurrence: 'daily',
      retentionDays: 7,
    });
    expect(result.manifest.resources).toContainEqual(
      expect.objectContaining({
        kind: 'firestore-backup-schedule',
        name: 'projects/customer-project/databases/(default)/backupSchedules/daily',
      }),
    );
    expect(result.runtimeReady).toBe(false);
    expect(result.pending).toEqual(['ready']);
    expect(
      secretLookups.some((entry) =>
        entry.includes('secrets versions describe 4 --secret=consumer-install-mobile-api-token'),
      ),
    ).toBe(true);
    expect(logs.some((entry) => entry.includes('mobile_api_token_version=4'))).toBe(true);
    expect(logs.some((entry) => entry.includes('vertex_location=global'))).toBe(true);
    expect(logs.some((entry) => entry.includes('daily_backup_schedule_enabled=true'))).toBe(true);
    expect(logs.some((entry) => entry.includes('backup_retention_days=7'))).toBe(true);
    expect(
      logs.filter((entry) => entry.includes('terraform') && entry.includes('apply')).length,
    ).toBe(4);
    expect(iamChecks).toEqual([
      expect.stringContaining(
        'consumer-install-runtime%40customer-project.iam.gserviceaccount.com:testIamPermissions Bearer test-access-token',
      ),
      expect.stringContaining(
        'consumer-install-web%40customer-project.iam.gserviceaccount.com:testIamPermissions Bearer test-access-token',
      ),
    ]);
    const targetApplyIndex = logs.findIndex((entry) =>
      entry.includes('-target=google_service_account.web'),
    );
    expect(targetApplyIndex).toBeGreaterThanOrEqual(0);
    expect(
      logs.findIndex(
        (entry, index) =>
          index > targetApplyIndex &&
          entry.includes('web_image_digest=') &&
          entry.includes('plan') &&
          entry.includes('runtime.tfplan'),
      ),
    ).toBeGreaterThan(targetApplyIndex);
    const callback = 'https://assistant.example.com/api/auth/callback/google';
    secretEnabled = false;
    await expect(
      provisionConsumerInstallation(
        { runner },
        {
          ...options,
          runtime,
          ownerAccessCallback: callback,
          apply: false,
        },
      ),
    ).rejects.toThrow('secret version must be enabled');
    secretEnabled = true;
    mobileSecretEnabled = false;
    await expect(
      provisionConsumerInstallation(
        { runner },
        { ...options, runtime, ownerAccessCallback: callback, apply: false },
      ),
    ).rejects.toThrow('mobile-api-token secret version must be enabled');
    mobileSecretEnabled = true;
    await expect(
      provisionConsumerInstallation(
        { runner },
        {
          ...options,
          runtime,
          ownerAccessCallback: 'https://wrong.example.com/api/auth/callback/google',
        },
      ),
    ).rejects.toThrow('Confirmed OAuth callback must exactly match');
    const preview = await provisionConsumerInstallation(
      { runner },
      {
        ...options,
        runtime,
        ownerAccessCallback: callback,
        apply: false,
      },
    );
    expect(preview.ownerAccess?.publicInvoker).toBe(false);
    expect(preview.ownerAccess?.webUrl).toBe('https://consumer-install-web-abc.a.run.app');
    expect(logs.filter((entry) => entry.includes('allow_public_web_invoker=true'))).toHaveLength(0);
    agentPublic = true;
    await expect(
      provisionConsumerInstallation(
        { runner },
        {
          ...options,
          runtime,
          ownerAccessCallback: callback,
        },
      ),
    ).rejects.toThrow('Agent service has a public invoker binding');
    agentPublic = false;
    agentIamDisabled = true;
    await expect(
      provisionConsumerInstallation(
        { runner },
        {
          ...options,
          runtime,
          ownerAccessCallback: callback,
        },
      ),
    ).rejects.toThrow('Cloud Run IAM configuration differs');
    agentIamDisabled = false;
    expect(logs.filter((entry) => entry.includes('allow_public_web_invoker=true'))).toHaveLength(0);
    broadPlan = true;
    await expect(
      provisionConsumerInstallation(
        { runner },
        {
          ...options,
          runtime,
          ownerAccessCallback: callback,
        },
      ),
    ).rejects.toThrow('Owner-access Terraform plan includes unexpected changes');
    broadPlan = false;
    expect(
      logs.filter((entry) => entry.includes('apply') && entry.includes('owner-access.tfplan')),
    ).toHaveLength(0);
    const exposed = await provisionConsumerInstallation(
      { runner },
      {
        ...options,
        runtime,
        ownerAccessCallback: callback,
      },
    );
    expect(exposed.ownerAccess?.publicInvoker).toBe(true);
    expect(exposed.runtimeReady).toBe(false);
    expect(exposed.manifest.stage.current).toBe('initialized');
    expect(logs.filter((entry) => entry.includes('allow_public_web_invoker=true'))).toHaveLength(2);
    const retried = await provisionConsumerInstallation(
      { runner },
      {
        ...options,
        runtime,
        ownerAccessCallback: callback,
      },
    );
    expect(retried.ownerAccess?.publicInvoker).toBe(true);
    expect(logs.some((entry) => entry.includes('web_image_digest=sha256:'))).toBe(true);
    expect(JSON.parse(await readFile(state, 'utf8')).stage.current).toBe('initialized');
    const resumed = await provisionConsumerInstallation({ runner }, { ...options, runtime });
    expect(resumed.manifest.stage.current).toBe('initialized');
    expect(
      logs.filter((entry) => entry.includes('terraform') && entry.includes('apply')).length,
    ).toBe(5);
    await expect(
      provisionConsumerInstallation(
        { runner },
        {
          ...options,
          runtime: {
            images: runtimeImages,
            config: { ...runtimeConfig, ownerEmail: 'other@example.com' },
          },
        },
      ),
    ).rejects.toThrow('differs from the initialized checkpoint');
    await expect(
      provisionConsumerInstallation(
        { runner },
        { ...options, runtime: { images: runtimeImages, config: runtimeConfig } },
      ),
    ).rejects.toThrow('differs from the initialized checkpoint');
  });

  it.each([0, 1.5, 'latest', null])(
    'rejects a non-numbered mobile secret version %s before cloud access',
    async (mobileApiTokenVersion) => {
      const dir = await mkdtemp(join(tmpdir(), 'assistant-mobile-token-validation-'));
      const archive = join(dir, 'release.tar.gz');
      await foundationArchive(archive);
      const log: string[] = [];
      await expect(
        provisionConsumerInstallation(
          { runner: fakeRunner(log) },
          {
            manifest: manifest(await sha256File(archive)),
            archivePath: archive,
            statePath: join(dir, 'state.json'),
            terraformDir: 'infra/gcp/consumer/terraform',
            stateBucket: 'customer-project-consumer-install-state',
            apply: false,
            runtime: {
              images: runtimeImages,
              config: { ...runtimeConfig, mobileApiTokenVersion },
            },
          },
        ),
      ).rejects.toThrow('positive numbered mobileApiTokenVersion');
      expect(log).toHaveLength(0);
    },
  );

  it('rejects image manifests for another customer before cloud access', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-runtime-'));
    const archive = join(dir, 'release.tar.gz');
    await foundationArchive(archive);
    const log: string[] = [];
    await expect(
      provisionConsumerInstallation(
        { runner: fakeRunner(log) },
        {
          manifest: manifest(await sha256File(archive)),
          archivePath: archive,
          statePath: join(dir, 'state.json'),
          terraformDir: 'infra/gcp/consumer/terraform',
          stateBucket: 'customer-project-consumer-install-state',
          apply: true,
          runtime: {
            images: { ...runtimeImages, projectId: 'other-project' },
            config: runtimeConfig,
          },
        },
      ),
    ).rejects.toThrow('does not match this installation');
    expect(log).toEqual([]);
  });

  it('does not checkpoint a runtime whose Cloud Run revision is still starting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-runtime-'));
    const archive = join(dir, 'release.tar.gz');
    const state = join(dir, 'state.json');
    await foundationArchive(archive);
    const source = manifest(await sha256File(archive));
    const runner = fakeRunner([]);
    const baseRun = runner.run.bind(runner);
    runner.run = async (command, args) => {
      if (command === 'gcloud' && args[0] === 'secrets')
        return { ok: true, stdout: '{"state":"ENABLED"}', stderr: '' };
      if (command === 'gcloud' && args[0] === 'run')
        return { ok: true, stdout: '{"name":"consumer-install-web","conditions":[]}', stderr: '' };
      if (command === 'terraform' && args.includes('output')) {
        const result = await baseRun(command, args);
        return {
          ...result,
          stdout: JSON.stringify({
            ...JSON.parse(result.stdout),
            cloud_run_web_service_name: { value: 'consumer-install-web' },
            cloud_run_agent_service_name: { value: 'consumer-install-agent' },
          }),
        };
      }
      return baseRun(command, args);
    };
    const options = {
      manifest: source,
      archivePath: archive,
      statePath: state,
      terraformDir: 'infra/gcp/consumer/terraform',
      stateBucket: 'customer-project-consumer-install-state',
      apply: true,
      now: () => '2026-09-12T12:00:10.000Z',
    };
    await provisionConsumerInstallation({ runner }, options);
    await expect(
      provisionConsumerInstallation(
        {
          runner,
          fetcher: async () =>
            new Response(JSON.stringify({ permissions: ['iam.serviceAccounts.actAs'] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        },
        { ...options, runtime: { images: runtimeImages, config: runtimeConfig } },
      ),
    ).rejects.toThrow('not serving the expected ready digest');
    expect(JSON.parse(await readFile(state, 'utf8')).stage.current).toBe('provisioned');
  });
  it('dry-run verifies the archive and absence without provisioning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-'));
    const archive = join(dir, 'release.tar.gz');
    const state = join(dir, 'state.json');
    await foundationArchive(archive);
    const digest = await sha256File(archive);
    const log: string[] = [];
    const result = await provisionConsumerInstallation(
      { runner: fakeRunner(log) },
      {
        manifest: manifest(digest),
        archivePath: archive,
        statePath: state,
        terraformDir: 'infra/gcp/consumer/terraform',
        stateBucket: 'customer-project-consumer-install-state',
        apply: false,
      },
    );
    expect(result.applied).toBe(false);
    expect(result.runtimeReady).toBe(false);
    expect(log.some((entry) => entry.includes('terraform'))).toBe(false);
    await expect(readFile(state)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports Cloud Resource Manager as a prerequisite when disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-api-'));
    const archive = join(dir, 'release.tar.gz');
    await foundationArchive(archive);
    const log: string[] = [];
    const runner = fakeRunner(log);
    const baseRun = runner.run.bind(runner);
    runner.run = (command, args) =>
      command === 'gcloud' && args[0] === 'services' && args[1] === 'list'
        ? Promise.resolve({
            ok: true,
            stdout: JSON.stringify(
              requiredServiceRows.filter(
                (row) => row.config.name !== 'cloudresourcemanager.googleapis.com',
              ),
            ),
            stderr: '',
          })
        : baseRun(command, args);
    const result = await provisionConsumerInstallation(
      { runner },
      {
        manifest: manifest(await sha256File(archive)),
        archivePath: archive,
        statePath: join(dir, 'state.json'),
        terraformDir: 'infra/gcp/consumer/terraform',
        stateBucket: 'customer-project-consumer-install-state',
        apply: false,
      },
    );
    expect(result.disabledApis).toEqual(['cloudresourcemanager.googleapis.com']);
    expect(log.some((entry) => entry.includes('services enable'))).toBe(false);
  });

  it('applies foundation stages and leaves readiness gated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-'));
    const archive = join(dir, 'release.tar.gz');
    const state = join(dir, 'state.json');
    await foundationArchive(archive);
    const digest = await sha256File(archive);
    const log: string[] = [];
    const terraformLog: string[] = [];
    const terraformRunner = fakeRunner(terraformLog);
    const runTerraform = terraformRunner.run.bind(terraformRunner);
    let verifiedIndexInputs = false;
    terraformRunner.run = async (command, args) => {
      if (command === 'terraform' && args.includes('apply')) {
        const terraformDir = args[0]?.replace(/^-chdir=/, '');
        if (!terraformDir) throw new Error('missing Terraform working directory');
        const indexTerraform = await readFile(join(terraformDir, 'firestore-indexes.tf'));
        const indexSpec = await readFile(
          resolve(terraformDir, '../../firestore/firestore.indexes.json'),
        );
        expect(indexTerraform).toEqual(
          await readFile('infra/gcp/consumer/terraform/firestore-indexes.tf'),
        );
        expect(indexSpec).toEqual(await readFile('infra/gcp/firestore/firestore.indexes.json'));
        verifiedIndexInputs = true;
      }
      return runTerraform(command, args);
    };
    const result = await provisionConsumerInstallation(
      { runner: fakeRunner(log), terraform: terraformRunner },
      {
        manifest: manifest(digest),
        archivePath: archive,
        statePath: state,
        terraformDir: 'infra/gcp/consumer/terraform',
        stateBucket: 'customer-project-consumer-install-state',
        apply: true,
        now: (() => {
          let seconds = 0;
          return () => `2026-09-12T12:00:0${String(++seconds)}.000Z`;
        })(),
      },
    );
    expect(result.manifest.stage.current).toBe('provisioned');
    expect(result.manifest.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'state-bucket', owner: 'bootstrap' }),
        expect.objectContaining({ kind: 'release-receipt', owner: 'bootstrap' }),
        expect.objectContaining({
          kind: 'artifact-registry',
          name: 'projects/customer-project/locations/us-central1/repositories/consumer-install',
        }),
      ]),
    );
    expect(result.runtimeReady).toBe(false);
    expect(result.pending).toEqual(['initialized', 'ready']);
    expect(log.some((entry) => entry.includes('storage cp'))).toBe(true);
    expect(
      terraformLog.some((entry) => entry.includes('init -input=false -lockfile=readonly')),
    ).toBe(true);
    expect(terraformLog.some((entry) => entry.includes('apply -auto-approve -parallelism=1'))).toBe(
      true,
    );
    expect(verifiedIndexInputs).toBe(true);
    expect(JSON.parse(await readFile(state, 'utf8')).stage.current).toBe('provisioned');
  });

  it('leaves state bootstrapped when an index is still building after Terraform apply', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-'));
    const archive = join(dir, 'release.tar.gz');
    const state = join(dir, 'state.json');
    await foundationArchive(archive);
    const runner = fakeRunner([]);
    const original = runner.run.bind(runner);
    runner.run = async (command, args) => {
      if (command === 'gcloud' && args[0] === 'firestore' && args[2] === 'composite') {
        return {
          ok: true,
          stdout: JSON.stringify([
            { ...compositeIndexRows[0], state: 'CREATING' },
            ...compositeIndexRows.slice(1),
          ]),
          stderr: '',
        };
      }
      return original(command, args);
    };
    await expect(
      provisionConsumerInstallation(
        { runner, indexReadinessWait: { timeoutMs: 0 } },
        {
          manifest: manifest(await sha256File(archive)),
          archivePath: archive,
          statePath: state,
          terraformDir: 'infra/gcp/consumer/terraform',
          stateBucket: 'customer-project-consumer-install-state',
          apply: true,
        },
      ),
    ).rejects.toThrow('did not become READY');
    expect(JSON.parse(await readFile(state, 'utf8')).stage.current).toBe('bootstrapped');
  });

  it('rechecks persisted provisioned state without another Terraform apply', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-'));
    const archive = join(dir, 'release.tar.gz');
    const state = join(dir, 'state.json');
    await foundationArchive(archive);
    const options = {
      manifest: manifest(await sha256File(archive)),
      archivePath: archive,
      statePath: state,
      terraformDir: 'infra/gcp/consumer/terraform',
      stateBucket: 'customer-project-consumer-install-state',
      apply: true,
    } as const;
    await provisionConsumerInstallation({ runner: fakeRunner([]) }, options);
    const log: string[] = [];
    const runner = fakeRunner(log);
    const original = runner.run.bind(runner);
    runner.run = async (command, args) =>
      command === 'gcloud' && args[0] === 'firestore' && args[2] === 'composite'
        ? { ok: true, stdout: JSON.stringify(compositeIndexRows.slice(1)), stderr: '' }
        : original(command, args);
    await expect(provisionConsumerInstallation({ runner }, options)).rejects.toThrow(
      'differ from the trusted installation manifest',
    );
    await expect(
      provisionConsumerInstallation({ runner }, { ...options, apply: false }),
    ).rejects.toThrow('differ from the trusted installation manifest');
    expect(log.some((entry) => entry.startsWith('terraform '))).toBe(false);
    expect(JSON.parse(await readFile(state, 'utf8')).stage.current).toBe('provisioned');
  });

  it.each([
    'infra/gcp/consumer/terraform/firestore-indexes.tf',
    'infra/gcp/firestore/firestore.indexes.json',
  ])('rejects an archive missing trusted index input %s before cloud access', async (missing) => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-'));
    const archive = join(dir, 'release.tar.gz');
    await foundationArchive(archive, { omit: missing });
    const log: string[] = [];
    await expect(
      provisionConsumerInstallation(
        { runner: fakeRunner(log) },
        {
          manifest: manifest(await sha256File(archive)),
          archivePath: archive,
          statePath: join(dir, 'state.json'),
          terraformDir: 'infra/gcp/consumer/terraform',
          stateBucket: 'customer-project-consumer-install-state',
          apply: true,
        },
      ),
    ).rejects.toThrow(`Installation archive is missing ${missing}`);
    expect(log).toEqual([]);
  });

  it('rejects an altered index specification before cloud access', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-'));
    const archive = join(dir, 'release.tar.gz');
    await foundationArchive(archive, {
      replace: { path: 'infra/gcp/firestore/firestore.indexes.json', content: '{}' },
    });
    const log: string[] = [];
    await expect(
      provisionConsumerInstallation(
        { runner: fakeRunner(log) },
        {
          manifest: manifest(await sha256File(archive)),
          archivePath: archive,
          statePath: join(dir, 'state.json'),
          terraformDir: 'infra/gcp/consumer/terraform',
          stateBucket: 'customer-project-consumer-install-state',
          apply: true,
        },
      ),
    ).rejects.toThrow(
      'Installation archive foundation mismatch for infra/gcp/firestore/firestore.indexes.json',
    );
    expect(log).toEqual([]);
  });

  it('fails closed when a state bucket exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-'));
    const archive = join(dir, 'release.tar.gz');
    await foundationArchive(archive);
    const digest = await sha256File(archive);
    await expect(
      provisionConsumerInstallation(
        { runner: fakeRunner([], true, '[]', undefined, true) },
        {
          manifest: manifest(digest),
          archivePath: archive,
          statePath: join(dir, 'state.json'),
          terraformDir: 'infra/gcp/consumer/terraform',
          stateBucket: 'customer-project-consumer-install-state',
          apply: true,
        },
      ),
    ).rejects.toThrow('Refusing to adopt');
  });

  it('rejects malformed or existing database listings before apply', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-'));
    const archive = join(dir, 'release.tar.gz');
    await foundationArchive(archive);
    const digest = await sha256File(archive);
    const options = {
      manifest: manifest(digest),
      archivePath: archive,
      statePath: join(dir, 'state.json'),
      terraformDir: 'infra/gcp/consumer/terraform',
      stateBucket: 'customer-project-consumer-install-state',
      apply: true,
    } as const;
    await expect(
      provisionConsumerInstallation({ runner: fakeRunner([], false, '{}') }, options),
    ).rejects.toThrow('malformed JSON');
    await expect(
      provisionConsumerInstallation(
        {
          runner: fakeRunner(
            [],
            false,
            '[{"name":"projects/customer-project/databases/(default)"}]',
          ),
        },
        options,
      ),
    ).rejects.toThrow('Refusing to adopt existing Firestore database');
  });

  it('rejects state bucket changes and fabricated advanced manifests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-'));
    const archive = join(dir, 'release.tar.gz');
    await foundationArchive(archive);
    const digest = await sha256File(archive);
    const base = {
      archivePath: archive,
      statePath: join(dir, 'state.json'),
      terraformDir: 'infra/gcp/consumer/terraform',
      apply: false,
    } as const;
    await expect(
      provisionConsumerInstallation(
        { runner: fakeRunner([]) },
        { ...base, manifest: manifest(digest), stateBucket: 'foreign-state-bucket' },
      ),
    ).rejects.toThrow('State bucket must be');
    const advanced = advanceInstallationStage(
      manifest(digest),
      'authorized',
      '2026-09-12T12:01:00.000Z',
    );
    await expect(
      provisionConsumerInstallation(
        { runner: fakeRunner([]) },
        { ...base, manifest: advanced, stateBucket: 'customer-project-consumer-install-state' },
      ),
    ).rejects.toThrow('advanced manifest');
  });

  it('resumes an ambiguous upload when the verified ownership receipt exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-'));
    const archive = join(dir, 'release.tar.gz');
    const state = join(dir, 'state.json');
    await foundationArchive(archive);
    const digest = await sha256File(archive);
    const base = {
      manifest: manifest(digest),
      archivePath: archive,
      statePath: state,
      terraformDir: 'infra/gcp/consumer/terraform',
      stateBucket: 'customer-project-consumer-install-state',
      apply: true,
    } as const;
    const first = fakeRunner([]);
    const original = first.run;
    first.run = async (command, args) => {
      if (command === 'gcloud' && args[0] === 'storage' && args[1] === 'cp')
        return { ok: false, stdout: '', stderr: 'upload failed' };
      return original(command, args);
    };
    await expect(provisionConsumerInstallation({ runner: first }, base)).rejects.toThrow(
      'upload failed',
    );
    expect(JSON.parse(await readFile(state, 'utf8')).stage.current).toBe('authorized');
    const resumed = await provisionConsumerInstallation(
      { runner: fakeRunner([], true, '[]', undefined, false, digest) },
      base,
    );
    expect(resumed.manifest.stage.current).toBe('provisioned');
  });

  it.each([
    { project_number: '987654321' },
    { location: 'EU' },
    { uniform_bucket_level_access: false },
    { public_access_prevention: 'inherited' },
  ])(
    'rejects a matching receipt on a bucket with unsafe identity or policy: %j',
    async (override) => {
      const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-'));
      const archive = join(dir, 'release.tar.gz');
      await foundationArchive(archive);
      const digest = await sha256File(archive);
      const log: string[] = [];
      const original = fakeRunner(log, true, '[]', undefined, false, digest);
      const runner: CommandRunner = {
        async run(command, args) {
          const result = await original.run(command, args);
          if (
            command === 'gcloud' &&
            args[0] === 'storage' &&
            args[1] === 'buckets' &&
            args[2] === 'describe'
          )
            return {
              ...result,
              stdout: JSON.stringify({ ...JSON.parse(result.stdout), ...override }),
            };
          return result;
        },
      };
      await expect(
        provisionConsumerInstallation(
          { runner },
          {
            manifest: manifest(digest),
            archivePath: archive,
            statePath: join(dir, 'state.json'),
            terraformDir: 'infra/gcp/consumer/terraform',
            stateBucket: 'customer-project-consumer-install-state',
            apply: true,
          },
        ),
      ).rejects.toThrow('project, location, or access protection differs');
      expect(
        log.some((entry) => entry.startsWith('terraform -chdir=') || entry.includes('storage cp')),
      ).toBe(false);
    },
  );

  it('rejects invalid Terraform output without exposing command details', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-'));
    const archive = join(dir, 'release.tar.gz');
    await foundationArchive(archive);
    const digest = await sha256File(archive);
    await expect(
      provisionConsumerInstallation(
        { runner: fakeRunner([], false, '[]', {}) },
        {
          manifest: manifest(digest),
          archivePath: archive,
          statePath: join(dir, 'state.json'),
          terraformDir: 'infra/gcp/consumer/terraform',
          stateBucket: 'customer-project-consumer-install-state',
          apply: true,
        },
      ),
    ).rejects.toThrow('Terraform output missing project_id');
  });

  it('deploys a passkey runtime with a generated auth secret, then verifies readiness', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-passkey-'));
    const archive = join(dir, 'release.tar.gz');
    const state = join(dir, 'state.json');
    await foundationArchive(archive);
    const source = manifest(await sha256File(archive));
    const logs: string[] = [];
    const runner = fakeRunner(logs);
    const passkeyUrl = 'https://consumer-install-web-123456789.us-central1.run.app';
    const release = '0123456789abcdef0123456789abcdef01234567';
    let secretExists = false;
    let secretLabels: Record<string, string> = {
      installation: 'consumer-install',
      'managed-by': 'assistant-installer',
    };
    let versions: string[] = [];
    let secretFileMode = -1;
    let webPublic = false;
    let servingPercent = 100;
    let servingReleaseSha = runtimeImages.sourceSha;
    const baseRun = runner.run.bind(runner);
    runner.run = async (command, args) => {
      if (command === 'gcloud' && args[0] === 'secrets' && args[1] === 'describe') {
        return secretExists
          ? { ok: true, stdout: JSON.stringify({ labels: secretLabels }), stderr: '' }
          : { ok: false, stdout: '', stderr: 'NOT_FOUND: secret does not exist' };
      }
      if (command === 'gcloud' && args[0] === 'secrets' && args[1] === 'create') {
        secretExists = true;
        return { ok: true, stdout: '', stderr: '' };
      }
      if (command === 'gcloud' && args[1] === 'versions' && args[2] === 'list') {
        return {
          ok: true,
          stdout: JSON.stringify(versions.map((name) => ({ name }))),
          stderr: '',
        };
      }
      if (command === 'gcloud' && args[1] === 'versions' && args[2] === 'add') {
        const file = args.find((arg) => arg.startsWith('--data-file='))?.slice(12) ?? '';
        const { stat } = await import('node:fs/promises');
        secretFileMode = (await stat(file)).mode & 0o777;
        const name = `projects/customer-project/secrets/consumer-install-auth-secret/versions/${versions.length + 1}`;
        versions = [...versions, name];
        return { ok: true, stdout: JSON.stringify({ name }), stderr: '' };
      }
      if (command === 'gcloud' && args[1] === 'versions' && args[2] === 'describe') {
        return { ok: true, stdout: JSON.stringify({ state: 'ENABLED' }), stderr: '' };
      }
      if (command === 'gcloud' && args[0] === 'run' && args[2] === 'get-iam-policy') {
        return {
          ok: true,
          stdout: JSON.stringify({
            bindings:
              webPublic && args[3]?.endsWith('-web')
                ? [{ role: 'roles/run.invoker', members: ['allUsers'] }]
                : [],
          }),
          stderr: '',
        };
      }
      if (command === 'gcloud' && args[0] === 'run') {
        const name = args[3]?.endsWith('-web') ? 'web' : 'agent';
        return {
          ok: true,
          stdout: JSON.stringify({
            name: `consumer-install-${name}`,
            uri: passkeyUrl,
            invokerIamDisabled: false,
            template: {
              containers: [
                {
                  image: runtimeImages.images[name].reference,
                  env: [
                    { name: 'OWNER_EMAIL', value: 'owner@example.com' },
                    { name: 'OWNER_AUTH_MODE', value: 'passkey' },
                    { name: 'AUTH_URL', value: passkeyUrl },
                    { name: 'AUTH_DEV_BYPASS', value: 'false' },
                    { name: 'AUTH_LOCALHOST_BYPASS', value: 'false' },
                    { name: 'VERTEX_LOCATION', value: 'global' },
                    { name: 'ASSISTANT_RELEASE_SHA', value: servingReleaseSha },
                  ],
                },
              ],
            },
            conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
            latestCreatedRevision: 'rev-1',
            latestReadyRevision: 'rev-1',
            status: { traffic: [{ revisionName: 'rev-1', percent: servingPercent }] },
          }),
          stderr: '',
        };
      }
      if (
        command === 'terraform' &&
        args.includes('plan') &&
        args.includes(`web_image_digest=${runtimeImages.terraform.web_image_digest}`) &&
        !args.some((arg) => arg.startsWith('-target'))
      )
        webPublic = args.includes('allow_public_web_invoker=true');
      if (command === 'terraform' && args.includes('output')) {
        const result = await baseRun(command, args);
        return {
          ...result,
          stdout: JSON.stringify({
            ...JSON.parse(result.stdout),
            cloud_run_web_service_name: { value: 'consumer-install-web' },
            cloud_run_agent_service_name: { value: 'consumer-install-agent' },
          }),
        };
      }
      return baseRun(command, args);
    };
    const passkeyConfig = {
      firestoreAgentId: '11111111-1111-4111-8111-111111111111',
      firestoreEmbeddingSpace: {
        provider: 'vertex',
        model: 'gemini-embedding-001',
        dimensions: 1536,
        revision: 'seed-v1',
      },
      vertexLocation: 'global',
      ownerEmail: 'owner@example.com',
      ownerAuth: 'passkey',
    };
    const runtime = { images: runtimeImages, config: passkeyConfig };
    const options = {
      manifest: source,
      archivePath: archive,
      statePath: state,
      terraformDir: 'infra/gcp/consumer/terraform',
      stateBucket: 'customer-project-consumer-install-state',
      apply: true,
      now: () => '2026-09-12T12:00:10.000Z',
    };
    await expect(
      provisionConsumerInstallation(
        { runner },
        {
          ...options,
          runtime: {
            images: runtimeImages,
            config: { ...passkeyConfig, googleClientIdVersion: 2 },
          },
        },
      ),
    ).rejects.toThrow('does not use Google OAuth client secrets');
    await provisionConsumerInstallation({ runner }, options);
    const fetcher: typeof fetch = async () =>
      new Response(JSON.stringify({ permissions: ['iam.serviceAccounts.actAs'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    // A foreign secret with the installer's name is never adopted.
    secretExists = true;
    secretLabels = { installation: 'other' } as Record<string, string>;
    await expect(
      provisionConsumerInstallation({ runner, fetcher }, { ...options, runtime }),
    ).rejects.toThrow('Refusing to adopt existing secret');
    secretExists = false;
    secretLabels = { installation: 'consumer-install', 'managed-by': 'assistant-installer' };

    const deployed = await provisionConsumerInstallation(
      { runner, fetcher },
      { ...options, runtime },
    );
    expect(deployed.manifest.stage.current).toBe('initialized');
    expect(secretFileMode).toBe(0o600);
    expect(versions).toHaveLength(1);
    expect(deployed.ownerAccess).toMatchObject({
      ownerAuth: 'passkey',
      authOrigin: passkeyUrl,
      publicInvoker: true,
    });
    expect(deployed.ownerAccess?.callback).toBeUndefined();
    expect(deployed.manifest.resources).toContainEqual(
      expect.objectContaining({
        kind: 'auth-secret-version',
        name: 'projects/customer-project/secrets/consumer-install-auth-secret/versions/1',
      }),
    );
    const runtimeApply = logs.find(
      (entry) =>
        entry.includes('plan') &&
        entry.includes('web_image_digest=') &&
        !entry.includes('-target='),
    );
    expect(runtimeApply).toContain('owner_auth_mode=passkey');
    expect(runtimeApply).toContain('allow_public_web_invoker=true');
    expect(runtimeApply).toContain(`web_auth_url=${passkeyUrl}`);
    expect(runtimeApply).toContain('auth_secret_version=1');
    expect(runtimeApply).not.toContain('google_client_id_version');
    await expect(
      provisionConsumerInstallation(
        { runner },
        {
          ...options,
          runtime,
          ownerAccessCallback: `${passkeyUrl}/api/auth/callback/google`,
        },
      ),
    ).rejects.toThrow('need no OAuth callback');

    let claimed = false;
    let ownerReplyDelivered = false;
    let healthSha = release;
    const httpFetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/api/health'))
        return Response.json({ ok: true, service: 'web', sha: healthSha });
      if (url.endsWith('/api/owner/status')) return Response.json({ mode: 'passkey', claimed });
      return new Response('not found', { status: 404 });
    };
    const verify = {
      nativeAppVersion: '1.0.0+synthetic',
      nativePairingConfirmed: true,
      evidence: async () => ({
        runtimeData: { ready: true, issues: [] },
        ownerReplyDelivered,
      }),
    };
    servingPercent = 50;
    await expect(
      provisionConsumerInstallation(
        { runner, fetcher: httpFetcher },
        { ...options, apply: false, runtime, verify },
      ),
    ).rejects.toThrow('not serving the expected ready digest revision');
    servingPercent = 100;
    servingReleaseSha = 'f'.repeat(40);
    await expect(
      provisionConsumerInstallation(
        { runner, fetcher: httpFetcher },
        { ...options, apply: false, runtime, verify },
      ),
    ).rejects.toThrow('not serving the expected ready digest revision');
    servingReleaseSha = runtimeImages.sourceSha;
    const pending = await provisionConsumerInstallation(
      { runner, fetcher: httpFetcher },
      { ...options, runtime, verify },
    );
    expect(pending.runtimeReady).toBe(false);
    expect(pending.manifest.stage.current).toBe('initialized');
    expect(
      pending.verification?.checks.filter((check) => !check.ok).map((check) => check.name),
    ).toEqual(['owner-claimed', 'native-reply-delivery']);
    claimed = true;
    ownerReplyDelivered = true;
    healthSha = 'f'.repeat(40);
    const stale = await provisionConsumerInstallation(
      { runner, fetcher: httpFetcher },
      { ...options, runtime, verify },
    );
    expect(stale.verification?.passed).toBe(false);
    healthSha = release;
    // A working server/model is insufficient for the native-first handoff.
    for (const nativeEvidence of [
      { nativeAppVersion: undefined, nativePairingConfirmed: false },
      { nativeAppVersion: '1.0.0+synthetic', nativePairingConfirmed: false },
      { nativeAppVersion: undefined, nativePairingConfirmed: true },
    ]) {
      const unpaired = await provisionConsumerInstallation(
        { runner, fetcher: httpFetcher },
        { ...options, runtime, verify: { ...verify, ...nativeEvidence } },
      );
      expect(unpaired.runtimeReady).toBe(false);
      expect(unpaired.manifest.stage.current).toBe('initialized');
      expect(
        unpaired.verification?.checks.some((check) => check.name === 'native-pairing' && !check.ok),
      ).toBe(true);
    }
    await expect(
      provisionConsumerInstallation(
        { runner, fetcher: httpFetcher },
        {
          ...options,
          runtime,
          verify: { ...verify, nativeAppVersion: 'unknown installed version' },
        },
      ),
    ).rejects.toThrow('Native app version');
    const previewed = await provisionConsumerInstallation(
      { runner, fetcher: httpFetcher },
      { ...options, apply: false, runtime, verify },
    );
    expect(previewed.verification?.passed).toBe(true);
    expect(previewed.manifest.stage.current).toBe('initialized');
    const ready = await provisionConsumerInstallation(
      { runner, fetcher: httpFetcher },
      { ...options, runtime, verify },
    );
    expect(ready.runtimeReady).toBe(true);
    expect(
      ready.verification?.checks.find((check) => check.name === 'native-app-installed')?.detail,
    ).toContain('not machine-verified');
    expect(ready.manifest.stage.current).toBe('ready');
    expect(JSON.parse(await readFile(state, 'utf8')).stage.current).toBe('ready');
    // A ready install re-verifies idempotently and reuses the recorded secret version.
    const again = await provisionConsumerInstallation(
      { runner, fetcher: httpFetcher },
      { ...options, runtime, verify },
    );
    expect(again.runtimeReady).toBe(true);
    expect(versions).toHaveLength(1);
  });

  it('rejects a runtime plan that deletes or replaces existing resources before apply', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-consumer-runtime-plan-delete-'));
    const archive = join(dir, 'release.tar.gz');
    const state = join(dir, 'state.json');
    await foundationArchive(archive);
    const initial = manifest(await sha256File(archive));
    const provisioned = advanceInstallationStage(
      advanceInstallationStage(
        advanceInstallationStage(initial, 'authorized', '2026-09-12T12:00:01.000Z'),
        'bootstrapped',
        '2026-09-12T12:00:02.000Z',
      ),
      'provisioned',
      '2026-09-12T12:00:03.000Z',
    );
    await writeFile(state, JSON.stringify(provisioned));
    const logs: string[] = [];
    const terraformRunner = fakeRunner(logs);
    const run = terraformRunner.run.bind(terraformRunner);
    let runtimePlanShown = false;
    terraformRunner.run = async (command, args) => {
      if (command === 'terraform' && args.includes('show') && args.includes('-json')) {
        const planPath = args.at(-1) ?? '';
        if (planPath.endsWith('runtime.tfplan')) {
          runtimePlanShown = true;
          return {
            ok: true,
            stdout: JSON.stringify({
              resource_changes: [
                {
                  address: 'google_cloud_run_v2_service.web',
                  change: { actions: ['delete', 'create'] },
                },
              ],
            }),
            stderr: '',
          };
        }
      }
      return run(command, args);
    };
    const runtime = {
      images: runtimeImages,
      config: runtimeConfig,
      authSecretVersion: '1',
    };
    await expect(
      provisionConsumerInstallation(
        {
          runner: fakeRunner([]),
          terraform: terraformRunner,
          fetcher: async () =>
            new Response(JSON.stringify({ permissions: ['iam.serviceAccounts.actAs'] })),
        },
        {
          manifest: provisioned,
          archivePath: archive,
          statePath: state,
          terraformDir: 'infra/gcp/consumer/terraform',
          stateBucket: 'customer-project-consumer-install-state',
          apply: true,
          runtime,
        },
      ),
    ).rejects.toThrow(
      'would delete or replace existing resources: google_cloud_run_v2_service.web',
    );
    expect(runtimePlanShown).toBe(true);
    expect(logs.some((entry) => entry.includes('apply') && entry.endsWith('runtime.tfplan'))).toBe(
      false,
    );
  });
});
