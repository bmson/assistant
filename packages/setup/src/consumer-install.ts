import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  type ConsumerIndexWaitOptions,
  verifyConsumerIndexReadiness,
  waitForConsumerIndexReadiness,
} from './consumer-index-readiness.js';
import {
  advanceInstallationStage,
  type InstallationManifest,
  type InstallationStage,
  validateInstallationManifest,
} from './installation-manifest.js';
import { persistInstallationProgress, readPersistedInstallation } from './installation-state.js';
import type { CommandResult, CommandRunner } from './runner.js';

const cloudStages: readonly InstallationStage[] = [
  'authorized',
  'bootstrapped',
  'provisioned',
  'initialized',
  'ready',
];

export interface ConsumerInstallOptions {
  manifest: InstallationManifest;
  archivePath: string;
  statePath: string;
  terraformDir: string;
  stateBucket: string;
  apply: boolean;
  runtime?: { images: unknown; config: unknown };
  /** Exact Google OAuth redirect URI confirmed in the customer's Web client. */
  ownerAccessCallback?: string;
  /**
   * Final readiness verification of an initialized runtime. Without `apply`
   * it only reports; with `apply` a fully passing check advances to `ready`.
   */
  verify?: {
    /** Customer-side Firestore evidence gathered by the caller. */
    evidence: (context: ConsumerVerifyContext) => Promise<ConsumerReadinessEvidence>;
    /** Google OAuth installs only: the operator confirms the owner signed in. */
    ownerSignInConfirmed?: boolean;
    /** Operator observes the published native app installed; this is not machine distribution proof. */
    nativeAppVersion?: string;
    /** Operator confirms authenticated pairing on that newly installed native client. */
    nativePairingConfirmed?: boolean;
  };
  now?: () => string;
}

export interface ConsumerVerifyContext {
  ownerAuth: 'google' | 'passkey';
  webUrl: string;
  authOrigin: string;
  agentId: string;
  /** Installed runtime checkpoint; readiness requires a later owner request and reply. */
  runtimeInitializedAt: string;
  /** Current agent revision observed from Cloud Run traffic metadata. */
  servingAgentRevision: string;
  /** Exact source commit injected into both services by the installer. */
  releaseSha: string;
  embeddingSpace: { provider: string; model: string; dimensions: number; revision: string };
}

export interface ConsumerReadinessEvidence {
  /** Result of the read-only runtime data preflight (agent, budget, roles, catalog). */
  runtimeData: { ready: boolean; issues: readonly string[] };
  /** The paired native client acknowledged rendering this installation's owner reply. */
  ownerReplyDelivered: boolean;
}

export interface ConsumerVerificationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ConsumerInstallResult {
  manifest: InstallationManifest;
  applied: boolean;
  runtimeReady: boolean;
  completed: readonly InstallationStage[];
  pending: readonly InstallationStage[];
  note: string;
  disabledApis?: readonly string[];
  ownerAccess?: {
    webUrl: string;
    authOrigin: string;
    ownerAuth: 'google' | 'passkey';
    /** Google OAuth redirect URI; absent for passkey installations. */
    callback?: string;
    publicInvoker: boolean;
  };
  verification?: { passed: boolean; checks: readonly ConsumerVerificationCheck[] };
}

export interface ConsumerInstallDependencies {
  runner: CommandRunner;
  terraform?: CommandRunner;
  indexReadinessWait?: ConsumerIndexWaitOptions;
  /** Injectable IAM API transport for tests; defaults to the Node fetch implementation. */
  fetcher?: typeof fetch;
}

function commandFailed(command: string, result: CommandResult): Error {
  return new Error(`${command} failed: ${result.stderr || result.stdout || 'unknown error'}`);
}

async function runOk(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
): Promise<CommandResult> {
  const result = await runner.run(command, args);
  if (!result.ok) throw commandFailed([command, ...args].join(' '), result);
  return result;
}

function jsonOutput(result: CommandResult, description: string): unknown {
  try {
    return JSON.parse(result.stdout || 'null');
  } catch {
    throw new Error(`${description} returned invalid JSON`);
  }
}

/**
 * Consumer updates reuse a state that may already own live services and IAM.
 * Review the saved plan before applying it and fail closed on any deletion or
 * replacement. Terraform action arrays are intentionally inspected as arrays:
 * a replacement is commonly represented as ["delete", "create"].
 */
function assertRuntimePlanPreservesResources(value: unknown): void {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as { resource_changes?: unknown }).resource_changes)
  )
    throw new Error('Runtime Terraform plan has no inspectable resource changes');
  const destructive = (
    value as { resource_changes: Array<{ address?: unknown; change?: { actions?: unknown } }> }
  ).resource_changes.filter((item) => {
    if (
      !Array.isArray(item.change?.actions) ||
      item.change.actions.some((action) => typeof action !== 'string')
    )
      return true;
    return item.change.actions.includes('delete');
  });
  if (destructive.length) {
    const addresses = destructive.map((item) =>
      typeof item.address === 'string' ? item.address : 'unknown resource',
    );
    throw new Error(
      `Runtime Terraform plan would delete or replace existing resources: ${addresses.join(', ')}`,
    );
  }
}

const minimumTerraformVersion = [1, 6, 0] as const;

async function verifyTerraformVersion(runner: CommandRunner): Promise<void> {
  const result = await runner.run('terraform', ['version', '-json']);
  if (!result.ok)
    throw new Error(
      'Terraform is required before provisioning. Install Terraform 1.6.0 or newer and ensure it is on PATH.',
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('Terraform returned invalid version JSON; install Terraform 1.6.0 or newer.');
  }
  const version =
    parsed && typeof parsed === 'object' && 'terraform_version' in parsed
      ? (parsed as { terraform_version?: unknown }).terraform_version
      : undefined;
  const match =
    typeof version === 'string' ? /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(version) : null;
  if (!match)
    throw new Error('Could not determine the Terraform version; install Terraform 1.6.0 or newer.');
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const tooOld =
    actual[0] < minimumTerraformVersion[0] ||
    (actual[0] === minimumTerraformVersion[0] &&
      (actual[1] < minimumTerraformVersion[1] ||
        (actual[1] === minimumTerraformVersion[1] && actual[2] < minimumTerraformVersion[2])));
  if (tooOld)
    throw new Error(
      `Terraform ${version} is too old; this installer requires Terraform 1.6.0 or newer.`,
    );
}

async function verifyCloudRunActAs(
  runner: CommandRunner,
  fetcher: typeof fetch,
  project: string,
  serviceAccountEmail: string,
): Promise<void> {
  const token = await runner.run('gcloud', ['auth', 'print-access-token']);
  if (!token.ok || !token.stdout.trim())
    throw new Error(
      'Cannot verify Cloud Run service-account access; refresh the active gcloud login and retry',
    );

  let response: Response;
  try {
    response = await fetcher(
      `https://iam.googleapis.com/v1/projects/${encodeURIComponent(project)}/serviceAccounts/${encodeURIComponent(serviceAccountEmail)}:testIamPermissions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.stdout.trim()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ permissions: ['iam.serviceAccounts.actAs'] }),
      },
    );
  } catch {
    throw new Error(
      `Cannot check Cloud Run attachment access on ${serviceAccountEmail}; verify IAM API access and retry`,
    );
  }
  if (!response.ok)
    throw new Error(
      `Cannot check Cloud Run attachment access on ${serviceAccountEmail}; verify IAM API access and retry`,
    );
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`IAM permission check returned invalid data for ${serviceAccountEmail}`);
  }
  const permissions =
    body && typeof body === 'object' && 'permissions' in body
      ? (body as { permissions?: unknown }).permissions
      : undefined;
  if (!Array.isArray(permissions) || !permissions.includes('iam.serviceAccounts.actAs'))
    throw new Error(
      `Cloud Run deployer lacks iam.serviceAccounts.actAs on ${serviceAccountEmail}; grant roles/iam.serviceAccountUser on this service account, then retry`,
    );
}

function hasDatabase(databases: unknown, databaseId: string): boolean {
  if (!Array.isArray(databases)) throw new Error('Firestore database list returned malformed JSON');
  return databases.some((entry) => {
    if (!entry || typeof entry !== 'object')
      throw new Error('Firestore database list contains malformed entry');
    const value = entry as Record<string, unknown>;
    const name = typeof value.name === 'string' ? value.name.split('/').at(-1) : undefined;
    if (!name && typeof value.databaseId !== 'string' && typeof value.id !== 'string')
      throw new Error('Firestore database list contains an entry without an identity');
    return name === databaseId || value.databaseId === databaseId || value.id === databaseId;
  });
}

const requiredApis = (provider: InstallationManifest['selection']['modelProvider']): string[] => [
  'artifactregistry.googleapis.com',
  'cloudresourcemanager.googleapis.com',
  'firestore.googleapis.com',
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
  'serviceusage.googleapis.com',
  'storage.googleapis.com',
  ...(provider === 'google' ? ['aiplatform.googleapis.com'] : []),
];

async function verifyCustomerBilling(runner: CommandRunner, project: string): Promise<void> {
  const described = await runOk(runner, 'gcloud', [
    'projects',
    'describe',
    project,
    '--format=value(projectId)',
  ]);
  if (described.stdout !== project)
    throw new Error('Customer project lookup did not match the installation project');
  const result = await runner.run('gcloud', [
    'billing',
    'projects',
    'describe',
    project,
    '--format=json',
  ]);
  if (!result.ok)
    throw new Error(
      `Cannot verify billing for customer project ${project}; check gcloud billing access and retry`,
    );
  const value = jsonOutput(result, 'Customer project billing') as Record<string, unknown> | null;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value.projectId !== undefined && value.projectId !== project)
  )
    throw new Error('Customer project billing returned malformed or mismatched JSON');
  if (
    value.billingEnabled !== true ||
    typeof value.billingAccountName !== 'string' ||
    !/^billingAccounts\/[A-Za-z0-9-]+$/.test(value.billingAccountName)
  )
    throw new Error(
      `Customer project ${project} needs an active billing account before provisioning`,
    );
}

async function verifyProjectAndDatabase(
  runner: CommandRunner,
  manifest: InstallationManifest,
  apply: boolean,
): Promise<string[]> {
  const project = manifest.identity.projectId;
  const services = await runOk(runner, 'gcloud', [
    'services',
    'list',
    `--project=${project}`,
    '--enabled',
    '--format=json',
  ]);
  const serviceRows = jsonOutput(services, 'Enabled API list');
  if (!Array.isArray(serviceRows)) throw new Error('Enabled API list returned malformed JSON');
  const enabled = new Set(
    serviceRows.flatMap((row) =>
      row &&
      typeof row === 'object' &&
      typeof (row as { config?: { name?: unknown } }).config?.name === 'string'
        ? [(row as { config: { name: string } }).config.name]
        : [],
    ),
  );
  const missing = requiredApis(manifest.selection.modelProvider).filter((api) => !enabled.has(api));
  if (apply && missing.length)
    await runOk(runner, 'gcloud', ['services', 'enable', ...missing, `--project=${project}`]);
  if (!apply && missing.length) return missing;
  const databases = await runOk(runner, 'gcloud', [
    'firestore',
    'databases',
    'list',
    `--project=${project}`,
    '--format=json',
  ]);
  if (hasDatabase(jsonOutput(databases, 'Firestore database list'), manifest.identity.databaseId)) {
    throw new Error(
      `Refusing to adopt existing Firestore database ${manifest.identity.databaseId}`,
    );
  }
  return missing;
}

async function ensureFreshBucket(
  runner: CommandRunner,
  bucket: string,
  project: string,
  region: string,
  installationId: string,
  releaseId: string,
  archiveDigest: string,
): Promise<void> {
  const result = await runner.run('gcloud', [
    'storage',
    'buckets',
    'describe',
    `gs://${bucket}`,
    `--project=${project}`,
    '--format=json',
  ]);
  if (result.ok) {
    const description = jsonOutput(result, 'State bucket description') as Record<
      string,
      unknown
    > | null;
    const projectNumber = await runOk(runner, 'gcloud', [
      'projects',
      'describe',
      project,
      '--format=value(projectNumber)',
    ]);
    if (
      !/^\d+$/.test(projectNumber.stdout) ||
      !description ||
      String(description.project_number) !== projectNumber.stdout ||
      String(description.location).toLowerCase() !== region.toLowerCase() ||
      description.name !== bucket ||
      description.uniform_bucket_level_access !== true ||
      description.public_access_prevention !== 'enforced'
    )
      throw new Error(
        `Refusing to reuse state bucket gs://${bucket}: project, location, or access protection differs`,
      );
    const receipt = await runner.run('gcloud', [
      'storage',
      'objects',
      'describe',
      `gs://${bucket}/releases/${releaseId}.tar.gz`,
      '--format=json',
    ]);
    if (!receipt.ok)
      throw new Error(
        `Refusing to adopt existing customer state bucket gs://${bucket} without an installation receipt`,
      );
    const receiptValue = jsonOutput(receipt, 'Installation receipt');
    const metadata =
      receiptValue && typeof receiptValue === 'object' && 'metadata' in receiptValue
        ? (receiptValue as { metadata?: unknown }).metadata
        : undefined;
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      (metadata as Record<string, unknown>).assistant_installation !== installationId ||
      (metadata as Record<string, unknown>).assistant_archive_digest !== archiveDigest
    ) {
      throw new Error(`Refusing to adopt existing customer state bucket gs://${bucket}`);
    }
    return;
  }
  if (!/(not.?found|404|does not exist)/i.test(result.stderr)) {
    throw commandFailed(`gcloud storage buckets describe gs://${bucket}`, result);
  }
  await runOk(runner, 'gcloud', [
    'storage',
    'buckets',
    'create',
    `gs://${bucket}`,
    `--project=${project}`,
    `--location=${region}`,
    '--uniform-bucket-level-access',
    '--public-access-prevention',
  ]);
}

async function terraform(
  runner: CommandRunner,
  options: ConsumerInstallOptions,
  args: readonly string[],
): Promise<CommandResult> {
  return runOk(runner, 'terraform', [`-chdir=${options.terraformDir}`, ...args]);
}

async function verifyTerraformDirectory(terraformDir: string): Promise<void> {
  const expected = resolve(process.cwd(), 'infra/gcp/consumer/terraform');
  if (resolve(terraformDir) !== expected) {
    throw new Error(`Terraform directory must be the verified consumer foundation: ${expected}`);
  }
  await Promise.all(verifiedFoundationFiles.map((file) => access(resolve(process.cwd(), file))));
}

const verifiedFoundationFiles = [
  'infra/gcp/consumer/terraform/main.tf',
  'infra/gcp/consumer/terraform/variables.tf',
  'infra/gcp/consumer/terraform/outputs.tf',
  'infra/gcp/consumer/terraform/versions.tf',
  'infra/gcp/consumer/terraform/.terraform.lock.hcl',
  'infra/gcp/consumer/terraform/firestore-indexes.tf',
  'infra/gcp/firestore/firestore.indexes.json',
] as const;
const runtimeFile = 'infra/gcp/consumer/terraform/runtime.tf';
const indexSpecPath = 'infra/gcp/firestore/firestore.indexes.json';

function tarString(header: Buffer, start: number, length: number): string {
  return header
    .subarray(start, start + length)
    .toString('utf8')
    .replace(/\0.*$/, '');
}

function tarOctal(header: Buffer, start: number, length: number): number {
  const value = tarString(header, start, length).trim();
  const parsed = Number.parseInt(value || '0', 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error('Installation archive has an invalid tar size');
  return parsed;
}

async function verifyTrustedFoundationArchive(
  archivePath: string,
  expectedDigest: string,
  includeRuntime = false,
): Promise<Map<string, Buffer>> {
  const archiveStat = await stat(archivePath);
  if (!archiveStat.isFile()) throw new Error('Installation archive must be a regular file');
  if (archiveStat.size > 128 * 1024 * 1024)
    throw new Error('Installation archive exceeds the 128 MiB limit');
  const compressed = await readFile(archivePath);
  const actualDigest = `sha256:${createHash('sha256').update(compressed).digest('hex')}`;
  if (actualDigest.toLowerCase() !== expectedDigest.toLowerCase()) {
    throw new Error(
      `Installation archive digest mismatch: expected ${expectedDigest.toLowerCase()}, got ${actualDigest}`,
    );
  }
  if (compressed.length > 128 * 1024 * 1024)
    throw new Error('Installation archive exceeds the 128 MiB limit');
  const tar =
    compressed[0] === 0x1f && compressed[1] === 0x8b
      ? gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 })
      : compressed;
  if (tar.length > 128 * 1024 * 1024)
    throw new Error('Installation archive exceeds the 128 MiB limit');
  const entries = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    if (!path || path.startsWith('/') || path.split('/').includes('..'))
      throw new Error('Installation archive contains an unsafe path');
    const type = header[156];
    const regular = type === 0 || type === 48;
    const directory = type === 5 || type === 53;
    if (type === 1 || type === 2 || (!regular && !directory && type !== 103 && type !== 120))
      throw new Error(`Installation archive contains unsupported entry ${path}`);
    const size = tarOctal(header, 124, 12);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error('Installation archive contains a truncated entry');
    const checksumText = tarString(header, 148, 8).trim();
    const expectedChecksum = Number.parseInt(checksumText, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (!Number.isSafeInteger(expectedChecksum) || actualChecksum !== expectedChecksum)
      throw new Error(`Installation archive has an invalid tar checksum for ${path}`);
    if (type === 103 || type === 120) {
      const pax = tar.subarray(dataStart, dataEnd).toString('utf8');
      if (/\b(?:path|linkpath)=/.test(pax))
        throw new Error('Installation archive uses a PAX path override');
    }
    if (entries.has(path)) throw new Error(`Installation archive contains duplicate entry ${path}`);
    if (regular) entries.set(path, Buffer.from(tar.subarray(dataStart, dataEnd)));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  for (const file of includeRuntime
    ? [...verifiedFoundationFiles, runtimeFile]
    : verifiedFoundationFiles) {
    const archiveEntry = entries.get(file);
    if (!archiveEntry) throw new Error(`Installation archive is missing ${file}`);
    const trusted = await readFile(resolve(process.cwd(), file));
    if (!archiveEntry.equals(trusted))
      throw new Error(`Installation archive foundation mismatch for ${file}`);
  }
  return entries;
}

async function prepareTerraformWorkspace(
  verified: Map<string, Buffer>,
  includeRuntime = false,
): Promise<{ root: string; terraformDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-consumer-terraform-'));
  for (const file of includeRuntime
    ? [...verifiedFoundationFiles, runtimeFile]
    : verifiedFoundationFiles) {
    const content = verified.get(file);
    if (!content) throw new Error(`Verified Terraform file is missing ${file}`);
    const destination = join(root, file);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, { mode: 0o600 });
  }
  return { root, terraformDir: join(root, 'infra/gcp/consumer/terraform') };
}

function validateTerraformOutputs(
  raw: unknown,
  manifest: InstallationManifest,
): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Terraform output was not a JSON object');
  const output = raw as Record<string, unknown>;
  const outputValue = (key: string): unknown => {
    const entry = output[key];
    if (!entry || typeof entry !== 'object' || !('value' in entry))
      throw new Error(`Terraform output missing ${key}`);
    return (entry as { value: unknown }).value;
  };
  if (outputValue('project_id') !== manifest.identity.projectId)
    throw new Error('Terraform output project does not match manifest');
  if (outputValue('installation_id') !== manifest.identity.installationId)
    throw new Error('Terraform output installation does not match manifest');
  if (outputValue('region') !== manifest.identity.region)
    throw new Error('Terraform output region does not match manifest');
  if (outputValue('firestore_database_name') !== manifest.identity.databaseId)
    throw new Error('Terraform output database does not match manifest');
  const backupScheduleName = outputValue('daily_backup_schedule_name');
  if (manifest.selection.backupSchedule) {
    const expectedPrefix = `projects/${manifest.identity.projectId}/databases/${manifest.identity.databaseId}/backupSchedules/`;
    if (
      typeof backupScheduleName !== 'string' ||
      !backupScheduleName.startsWith(expectedPrefix) ||
      backupScheduleName.length === expectedPrefix.length
    )
      throw new Error('Terraform output backup schedule does not match manifest');
  } else if (backupScheduleName !== null) {
    throw new Error('Terraform created an unselected backup schedule');
  }
  const project = manifest.identity.projectId;
  const installation = manifest.identity.installationId;
  if (outputValue('assets_bucket_name') !== `${project}-${installation}-assets`)
    throw new Error('Terraform output assets bucket does not match manifest');
  if (outputValue('source_bucket_name') !== `${project}-${installation}-source`)
    throw new Error('Terraform output source bucket does not match manifest');
  const repositoryName = `projects/${project}/locations/${manifest.identity.region}/repositories/${installation}`;
  // The Google provider returns the short repository ID from `.name`; older
  // Terraform outputs may carry the fully qualified resource name instead.
  if (
    outputValue('artifact_registry_repository') !== installation &&
    outputValue('artifact_registry_repository') !== repositoryName
  )
    throw new Error('Terraform output Artifact Registry does not match manifest');
  if (
    outputValue('runtime_service_account_email') !==
    `${installation}-runtime@${project}.iam.gserviceaccount.com`
  )
    throw new Error('Terraform output runtime identity does not match manifest');
  return output;
}

function foundationResources(output: Record<string, unknown>, manifest: InstallationManifest) {
  const outputValue = (key: string) => (output[key] as { value: string }).value;
  const id = manifest.identity.installationId;
  const owned = (kind: string, name: string, scope: 'installation' | 'project') => ({
    kind,
    name,
    scope,
    owner: 'terraform' as const,
    installationId: id,
  });
  const resources = [
    owned('firestore-database', outputValue('firestore_database_name'), 'project'),
    owned('assets-bucket', outputValue('assets_bucket_name'), 'installation'),
    owned('source-bucket', outputValue('source_bucket_name'), 'installation'),
    owned(
      'artifact-registry',
      `projects/${manifest.identity.projectId}/locations/${manifest.identity.region}/repositories/${id}`,
      'installation',
    ),
    owned('runtime-service-account', outputValue('runtime_service_account_email'), 'installation'),
  ];
  const backupScheduleName = (output.daily_backup_schedule_name as { value: unknown }).value;
  if (typeof backupScheduleName === 'string')
    resources.push(owned('firestore-backup-schedule', backupScheduleName, 'installation'));
  return resources;
}

function terraformVars(
  manifest: InstallationManifest,
  stateBucket: string,
  includeBackend = false,
): string[] {
  const project = manifest.identity.projectId;
  const install = manifest.identity.installationId;
  const vars = [
    '-var',
    `project_id=${project}`,
    '-var',
    `region=${manifest.identity.region}`,
    '-var',
    `installation_id=${install}`,
    '-var',
    `firestore_database_id=${manifest.identity.databaseId}`,
    '-var',
    `create_default_database=${manifest.identity.databaseId === '(default)'}`,
    '-var',
    `firestore_location_id=${manifest.identity.region}`,
    '-var',
    `assets_bucket_name=${project}-${install}-assets`,
    '-var',
    `source_bucket_name=${project}-${install}-source`,
    '-var',
    `artifact_repository_id=${install}`,
    '-var',
    `daily_backup_schedule_enabled=${manifest.selection.backupSchedule !== undefined}`,
    '-var',
    `backup_retention_days=${manifest.selection.backupSchedule?.retentionDays ?? 7}`,
  ];
  return includeBackend
    ? [
        ...vars,
        '-backend-config',
        `bucket=${stateBucket}`,
        '-backend-config',
        `prefix=assistant/${install}`,
      ]
    : vars;
}

type RuntimeInput = {
  webDigest: string;
  agentDigest: string;
  config: {
    firestoreAgentId: string;
    firestoreEmbeddingSpace: {
      provider: string;
      model: string;
      dimensions: number;
      revision: string;
    };
    vertexLocation?: string;
    ownerEmail: string;
    /** `passkey` needs no Google OAuth client; absent means `google`. */
    ownerAuth?: 'passkey';
    /** Required for Google OAuth; passkey defaults to the deterministic Cloud Run URL. */
    webAuthUrl?: string;
    /** Passkey installs may omit this; the installer then generates the secret. */
    authSecretVersion?: number;
    googleClientIdVersion?: number;
    googleClientSecretVersion?: number;
    mobileApiTokenVersion?: number;
  };
  fingerprint: string;
};

/** Runtime input with installer-derived values that are not part of the fingerprint. */
type ResolvedRuntime = RuntimeInput & {
  ownerAuth: 'google' | 'passkey';
  authUrl: string;
  /** Null only during a preview before the installer has generated the secret. */
  authSecretVersion: number | null;
  generatedAuthSecret: boolean;
  releaseSha: string;
};

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be a JSON object`);
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !keys.includes(key)))
    throw new Error(`${label} contains an unsupported field`);
  return data;
}

function validateRuntimeInput(
  raw: NonNullable<ConsumerInstallOptions['runtime']>,
  manifest: InstallationManifest,
): RuntimeInput {
  if (manifest.selection.modelProvider !== 'google')
    throw new Error('Runtime requires the Google model provider');
  const images = record(raw.images, 'Image manifest', [
    'schemaVersion',
    'sourceSha',
    'sourceArchiveDigest',
    'projectId',
    'region',
    'repositoryId',
    'tags',
    'images',
    'terraform',
  ]);
  const project = manifest.identity.projectId;
  const region = manifest.identity.region;
  const id = manifest.identity.installationId;
  if (
    images.schemaVersion !== 1 ||
    images.sourceSha !== manifest.identity.release.commitSha ||
    typeof images.sourceArchiveDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(images.sourceArchiveDigest) ||
    images.projectId !== project ||
    images.region !== region ||
    images.repositoryId !== id
  )
    throw new Error(
      'Image manifest does not match this installation release and customer repository',
    );
  const refs = record(images.images, 'Image references', ['web', 'agent']);
  const tags = record(images.tags, 'Image tags', ['web', 'agent']);
  const tf = record(images.terraform, 'Image Terraform inputs', [
    'web_image_digest',
    'agent_image_digest',
  ]);
  const root = `${region}-docker.pkg.dev/${project}/${id}`;
  const digests = ['web', 'agent'].map((name) => {
    const image = record(refs[name], `${name} image`, ['digest', 'reference', 'tag']);
    const digest = image.digest;
    if (
      typeof digest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(digest) ||
      image.reference !== `${root}/${name}@${digest}` ||
      image.tag !== `${root}/${name}:${images.sourceSha}` ||
      tags[name] !== image.tag ||
      tf[`${name}_image_digest`] !== digest
    )
      throw new Error(
        `${name} image must use the matching customer repository and immutable digest`,
      );
    return digest;
  });
  const config = record(raw.config, 'Runtime config', [
    'firestoreAgentId',
    'firestoreEmbeddingSpace',
    'vertexLocation',
    'ownerEmail',
    'ownerAuth',
    'webAuthUrl',
    'authSecretVersion',
    'googleClientIdVersion',
    'googleClientSecretVersion',
    'mobileApiTokenVersion',
  ]);
  const space = record(config.firestoreEmbeddingSpace, 'Embedding space', [
    'provider',
    'model',
    'dimensions',
    'revision',
  ]);
  if (
    typeof config.firestoreAgentId !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(config.firestoreAgentId)
  )
    throw new Error('Runtime config requires a seeded Firestore agent UUID');
  if (
    space.provider !== 'vertex' ||
    typeof space.model !== 'string' ||
    !space.model ||
    !Number.isInteger(space.dimensions) ||
    space.dimensions !== 1536 ||
    typeof space.revision !== 'string' ||
    !space.revision
  )
    throw new Error('Runtime config requires 1536-dimensional Vertex embedding provenance');
  if (
    config.vertexLocation !== undefined &&
    (typeof config.vertexLocation !== 'string' ||
      !/^(?:global|[a-z][a-z0-9-]*[0-9])$/.test(config.vertexLocation))
  )
    throw new Error('Runtime config requires an explicit Vertex region or global');
  if (config.ownerAuth !== undefined && config.ownerAuth !== 'passkey')
    throw new Error('Runtime config ownerAuth must be "passkey" or omitted for Google OAuth');
  const passkey = config.ownerAuth === 'passkey';
  if (
    typeof config.ownerEmail !== 'string' ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(config.ownerEmail) ||
    ((!passkey || config.webAuthUrl !== undefined) &&
      (typeof config.webAuthUrl !== 'string' ||
        !/^https:\/\/[A-Za-z0-9.-]+(?::443)?$/.test(config.webAuthUrl)))
  )
    throw new Error('Runtime config requires an owner email and HTTPS OAuth origin');
  const numbered = passkey
    ? (['authSecretVersion'] as const).filter((key) => config[key] !== undefined)
    : (['authSecretVersion', 'googleClientIdVersion', 'googleClientSecretVersion'] as const);
  for (const key of numbered) {
    if (!Number.isSafeInteger(config[key]) || (config[key] as number) < 1)
      throw new Error(`Runtime config requires a positive numbered ${key}`);
  }
  if (
    passkey &&
    (config.googleClientIdVersion !== undefined || config.googleClientSecretVersion !== undefined)
  )
    throw new Error('Passkey owner auth does not use Google OAuth client secrets; remove them');
  if (
    config.mobileApiTokenVersion !== undefined &&
    (!Number.isSafeInteger(config.mobileApiTokenVersion) ||
      (config.mobileApiTokenVersion as number) < 1)
  )
    throw new Error('Runtime config requires a positive numbered mobileApiTokenVersion');
  const [webDigest, agentDigest] = digests;
  if (!webDigest || !agentDigest) throw new Error('Image manifest requires web and agent images');
  const normalized = { webDigest, agentDigest, config: config as RuntimeInput['config'] };
  return {
    ...normalized,
    fingerprint: `sha256:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`,
  };
}

async function runRuntimeCheck(
  runner: CommandRunner,
  args: readonly string[],
  label: string,
): Promise<CommandResult> {
  const result = await runner.run('gcloud', args);
  // Cloud command diagnostics can contain headers or environment values. Keep
  // customer credentials and secret payloads out of installer output.
  if (!result.ok)
    throw new Error(`${label} failed; check customer project access and resource prerequisites`);
  return result;
}

async function verifyRuntimePrerequisites(
  runner: CommandRunner,
  manifest: InstallationManifest,
  input: ResolvedRuntime,
): Promise<void> {
  const project = manifest.identity.projectId;
  const region = manifest.identity.region;
  const id = manifest.identity.installationId;
  for (const [name, digest] of [
    ['web', input.webDigest],
    ['agent', input.agentDigest],
  ]) {
    await runRuntimeCheck(
      runner,
      [
        'artifacts',
        'docker',
        'images',
        'describe',
        `${region}-docker.pkg.dev/${project}/${id}/${name}@${digest}`,
        `--project=${project}`,
        '--format=json',
      ],
      `${name} image lookup`,
    );
  }
  const secrets: Array<readonly [string, number]> = [];
  if (input.authSecretVersion !== null) secrets.push(['auth-secret', input.authSecretVersion]);
  if (input.ownerAuth === 'google')
    secrets.push(
      ['google-client-id', input.config.googleClientIdVersion as number],
      ['google-client-secret', input.config.googleClientSecretVersion as number],
    );
  if (input.config.mobileApiTokenVersion !== undefined)
    secrets.push(['mobile-api-token', input.config.mobileApiTokenVersion]);
  for (const [suffix, version] of secrets) {
    const result = await runRuntimeCheck(
      runner,
      [
        'secrets',
        'versions',
        'describe',
        String(version),
        `--secret=${id}-${suffix}`,
        `--project=${project}`,
        '--format=json',
      ],
      `${suffix} secret version lookup`,
    );
    const data = jsonOutput(result, 'Secret version metadata') as { state?: unknown };
    if (data?.state !== 'ENABLED') throw new Error(`${suffix} secret version must be enabled`);
  }
}

function runtimeVars(input: ResolvedRuntime): string[] {
  if (input.authSecretVersion === null)
    throw new Error('The generated auth secret version must exist before runtime apply');
  const vars: Record<string, string> = {
    web_image_digest: input.webDigest,
    agent_image_digest: input.agentDigest,
    firestore_agent_id: input.config.firestoreAgentId,
    firestore_embedding_space: JSON.stringify(input.config.firestoreEmbeddingSpace),
    owner_email: input.config.ownerEmail,
    web_auth_url: input.authUrl,
    auth_secret_version: String(input.authSecretVersion),
    release_sha: input.releaseSha,
  };
  if (input.ownerAuth === 'google') {
    vars.google_client_id_version = String(input.config.googleClientIdVersion);
    vars.google_client_secret_version = String(input.config.googleClientSecretVersion);
  } else {
    // Passkey sign-in is claim-protected by the application, so web is public
    // from the first deploy; the agent stays IAM-private.
    vars.owner_auth_mode = 'passkey';
    vars.allow_public_web_invoker = 'true';
  }
  if (input.config.vertexLocation !== undefined) vars.vertex_location = input.config.vertexLocation;
  if (input.config.mobileApiTokenVersion !== undefined)
    vars.mobile_api_token_version = String(input.config.mobileApiTokenVersion);
  return Object.entries(vars).flatMap(([key, value]) => ['-var', `${key}=${value}`]);
}

async function verifyRuntimeServices(
  runner: CommandRunner,
  manifest: InstallationManifest,
  input: ResolvedRuntime,
): Promise<{ webRevision: string; agentRevision: string }> {
  const { projectId: project, region, installationId: id } = manifest.identity;
  const revisions: Partial<Record<'web' | 'agent', string>> = {};
  for (const [name, digest] of [
    ['web', input.webDigest],
    ['agent', input.agentDigest],
  ]) {
    const result = await runRuntimeCheck(
      runner,
      [
        'run',
        'services',
        'describe',
        `${id}-${name}`,
        `--project=${project}`,
        `--region=${region}`,
        '--format=json',
      ],
      `${name} Cloud Run smoke check`,
    );
    const service = jsonOutput(result, 'Cloud Run service') as Record<string, unknown>;
    const metadata = service?.metadata as { name?: unknown } | undefined;
    const spec = service?.spec as
      | {
          template?: {
            spec?: {
              containers?: Array<{
                image?: unknown;
                env?: Array<{ name?: unknown; value?: unknown }>;
              }>;
            };
          };
        }
      | undefined;
    const status = service?.status as
      | {
          conditions?: Array<{ type?: unknown; state?: unknown; status?: unknown }>;
          latestReadyRevisionName?: unknown;
          latestCreatedRevisionName?: unknown;
          trafficStatuses?: Array<{ revision?: unknown; percent?: unknown }>;
          traffic?: Array<{ revisionName?: unknown; revision?: unknown; percent?: unknown }>;
        }
      | undefined;
    const template = service?.template as
      | {
          containers?: Array<{
            image?: unknown;
            env?: Array<{ name?: unknown; value?: unknown }>;
          }>;
        }
      | undefined;
    const conditions = (service?.conditions ?? status?.conditions) as
      | Array<{ type?: unknown; state?: unknown; status?: unknown }>
      | undefined;
    const image = `${region}-docker.pkg.dev/${project}/${id}/${name}@${digest}`;
    const deployedImage =
      template?.containers?.[0]?.image ?? spec?.template?.spec?.containers?.[0]?.image;
    const env = (spec?.template?.spec?.containers?.[0]?.env ?? template?.containers?.[0]?.env) as
      | Array<{ name?: unknown; value?: unknown }>
      | undefined;
    const releaseSha = env?.find((entry) => entry.name === 'ASSISTANT_RELEASE_SHA')?.value;
    const readyRevision = service?.latestReadyRevision ?? status?.latestReadyRevisionName;
    const createdRevision = service?.latestCreatedRevision ?? status?.latestCreatedRevisionName;
    const revisionName = (value: unknown) =>
      typeof value === 'string' ? value.split('/').filter(Boolean).at(-1) : undefined;
    const normalizedReadyRevision = revisionName(readyRevision);
    const traffic = Array.isArray(status?.trafficStatuses)
      ? status.trafficStatuses.map((entry) => ({
          revision: entry.revision,
          percent: entry.percent,
        }))
      : Array.isArray(status?.traffic)
        ? status.traffic.map((entry) => ({
            revision: entry.revision ?? entry.revisionName,
            percent: entry.percent,
          }))
        : null;
    if (
      (service?.name ?? metadata?.name) !== `${id}-${name}` ||
      deployedImage !== image ||
      !Array.isArray(conditions) ||
      !conditions.some(
        (condition) =>
          condition.type === 'Ready' &&
          (condition.state === 'CONDITION_SUCCEEDED' || condition.status === 'True'),
      ) ||
      typeof readyRevision !== 'string' ||
      !normalizedReadyRevision ||
      revisionName(createdRevision) !== normalizedReadyRevision ||
      releaseSha !== manifest.identity.release.commitSha ||
      !traffic ||
      traffic.length !== 1 ||
      revisionName(traffic[0]?.revision) !== revisionName(readyRevision) ||
      traffic[0]?.percent !== 100
    )
      throw new Error(
        `${name} Cloud Run service is not serving the expected ready digest revision`,
      );
    revisions[name as 'web' | 'agent'] = normalizedReadyRevision;
  }
  if (!revisions.web || !revisions.agent)
    throw new Error('Cloud Run service revisions are incomplete');
  return { webRevision: revisions.web, agentRevision: revisions.agent };
}

async function inspectOwnerAccess(
  runner: CommandRunner,
  manifest: InstallationManifest,
  input: ResolvedRuntime,
  expectedPublic: boolean,
): Promise<NonNullable<ConsumerInstallResult['ownerAccess']>> {
  const { projectId, region, installationId } = manifest.identity;
  const serviceFor = async (name: 'web' | 'agent') =>
    jsonOutput(
      await runRuntimeCheck(
        runner,
        [
          'run',
          'services',
          'describe',
          `${installationId}-${name}`,
          `--project=${projectId}`,
          `--region=${region}`,
          '--format=json',
        ],
        `${name} service lookup`,
      ),
      `${name} service`,
    ) as Record<string, unknown>;
  const [web, agent] = await Promise.all([serviceFor('web'), serviceFor('agent')]);
  const iamDisabled = (service: Record<string, unknown>) =>
    service.invokerIamDisabled === true ||
    (service.metadata as { annotations?: Record<string, unknown> } | undefined)?.annotations?.[
      'run.googleapis.com/invoker-iam-disabled'
    ] === 'true';
  const url = web.uri ?? (web.status as { url?: unknown } | undefined)?.url;
  const container =
    (
      web.template as
        | { containers?: Array<{ env?: Array<{ name?: string; value?: string }> }> }
        | undefined
    )?.containers?.[0] ??
    (
      web.spec as
        | {
            template?: {
              spec?: {
                containers?: Array<{ env?: Array<{ name?: string; value?: string }> }>;
              };
            };
          }
        | undefined
    )?.template?.spec?.containers?.[0];
  const env = new Map(container?.env?.map(({ name, value }) => [name, value]) ?? []);
  if (
    typeof url !== 'string' ||
    !/^https:\/\/[A-Za-z0-9.-]+(?::443)?$/.test(url) ||
    iamDisabled(web) ||
    iamDisabled(agent) ||
    env.get('OWNER_EMAIL') !== input.config.ownerEmail ||
    env.get('AUTH_URL') !== input.authUrl ||
    (input.ownerAuth === 'passkey' && env.get('OWNER_AUTH_MODE') !== 'passkey') ||
    env.get('AUTH_DEV_BYPASS') !== 'false' ||
    env.get('AUTH_LOCALHOST_BYPASS') !== 'false' ||
    env.get('VERTEX_LOCATION') !== (input.config.vertexLocation ?? region)
  )
    throw new Error(
      'Web service URL, owner auth, or Cloud Run IAM configuration differs from the runtime checkpoint',
    );
  const policyFor = async (name: 'web' | 'agent') => {
    const value = jsonOutput(
      await runRuntimeCheck(
        runner,
        [
          'run',
          'services',
          'get-iam-policy',
          `${installationId}-${name}`,
          `--project=${projectId}`,
          `--region=${region}`,
          '--format=json',
        ],
        `${name} IAM policy lookup`,
      ),
      `${name} IAM policy`,
    ) as { bindings?: Array<{ role?: string; members?: string[] }> };
    if (value.bindings !== undefined && !Array.isArray(value.bindings))
      throw new Error(`${name} IAM policy is malformed`);
    const invokers =
      value.bindings?.filter((binding) => binding.role === 'roles/run.invoker') ?? [];
    return {
      allUsers: invokers.some((binding) => binding.members?.includes('allUsers')),
      broad: invokers.some((binding) =>
        binding.members?.some(
          (member) => member === 'allUsers' || member === 'allAuthenticatedUsers',
        ),
      ),
    };
  };
  const [webPolicy, agentPolicy] = await Promise.all([policyFor('web'), policyFor('agent')]);
  if (agentPolicy.broad)
    throw new Error('Agent service has a public invoker binding; refusing owner access');
  if (expectedPublic && !webPolicy.allUsers)
    throw new Error('Web public invoker binding was not verified');
  return {
    webUrl: url,
    authOrigin: input.authUrl,
    ownerAuth: input.ownerAuth,
    ...(input.ownerAuth === 'google'
      ? { callback: `${input.authUrl}/api/auth/callback/google` }
      : {}),
    publicInvoker: webPolicy.allUsers,
  };
}

async function projectNumber(runner: CommandRunner, project: string): Promise<string> {
  const result = await runRuntimeCheck(
    runner,
    ['projects', 'describe', project, '--format=value(projectNumber)'],
    'Customer project number lookup',
  );
  if (!/^\d+$/.test(result.stdout)) throw new Error('Customer project number is malformed');
  return result.stdout;
}

const generatedSecretLabel = 'assistant-installer';

function recordedAuthSecretVersion(manifest: InstallationManifest): number | null {
  const prefix = `projects/${manifest.identity.projectId}/secrets/${manifest.identity.installationId}-auth-secret/versions/`;
  const recorded = manifest.resources.find(
    (resource) => resource.kind === 'auth-secret-version' && resource.name.startsWith(prefix),
  );
  if (!recorded) return null;
  const version = Number(recorded.name.slice(prefix.length));
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error('Recorded auth secret version is malformed');
  return version;
}

/**
 * Passkey installs need only a session-signing secret, which the installer
 * generates in the customer's Secret Manager. The value is written to a
 * private temporary file for `gcloud --data-file` and never printed. A
 * resumed run reuses the lowest enabled version of the installer-labelled
 * secret, so a crash after creation does not rotate the key.
 */
async function ensureGeneratedAuthSecret(
  runner: CommandRunner,
  manifest: InstallationManifest,
): Promise<number> {
  const { projectId: project, installationId: id } = manifest.identity;
  const secret = `${id}-auth-secret`;
  const described = await runner.run('gcloud', [
    'secrets',
    'describe',
    secret,
    `--project=${project}`,
    '--format=json',
  ]);
  if (described.ok) {
    const value = jsonOutput(described, 'Auth secret metadata') as {
      labels?: Record<string, unknown>;
    } | null;
    if (
      value?.labels?.installation !== id ||
      value?.labels?.['managed-by'] !== generatedSecretLabel
    )
      throw new Error(
        `Refusing to adopt existing secret ${secret}; supply its authSecretVersion explicitly or remove it`,
      );
  } else if (/(not.?found|404|does not exist)/i.test(described.stderr)) {
    await runRuntimeCheck(
      runner,
      [
        'secrets',
        'create',
        secret,
        `--project=${project}`,
        '--replication-policy=automatic',
        `--labels=installation=${id},managed-by=${generatedSecretLabel}`,
      ],
      'Auth secret creation',
    );
  } else {
    throw new Error('Auth secret lookup failed; check Secret Manager access and retry');
  }
  const versions = jsonOutput(
    await runRuntimeCheck(
      runner,
      [
        'secrets',
        'versions',
        'list',
        secret,
        `--project=${project}`,
        '--filter=state:ENABLED',
        '--format=json',
      ],
      'Auth secret version lookup',
    ),
    'Auth secret versions',
  );
  if (!Array.isArray(versions)) throw new Error('Auth secret version list is malformed');
  const enabled = versions
    .map((row) =>
      Number(
        String((row as { name?: unknown })?.name ?? '')
          .split('/')
          .at(-1),
      ),
    )
    .filter((version) => Number.isSafeInteger(version) && version > 0)
    .sort((a, b) => a - b);
  if (enabled[0] !== undefined) return enabled[0];
  const scratch = await mkdtemp(join(tmpdir(), 'assistant-auth-secret-'));
  const file = join(scratch, 'value');
  try {
    await writeFile(file, randomBytes(48).toString('base64url'), { mode: 0o600 });
    const added = jsonOutput(
      await runRuntimeCheck(
        runner,
        [
          'secrets',
          'versions',
          'add',
          secret,
          `--project=${project}`,
          `--data-file=${file}`,
          '--format=json',
        ],
        'Auth secret version creation',
      ),
      'Auth secret version',
    ) as { name?: unknown } | null;
    const version = Number(
      String(added?.name ?? '')
        .split('/')
        .at(-1),
    );
    if (!Number.isSafeInteger(version) || version < 1)
      throw new Error('Auth secret version creation returned a malformed version');
    return version;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function resolveRuntime(
  runner: CommandRunner,
  manifest: InstallationManifest,
  input: RuntimeInput,
): Promise<ResolvedRuntime> {
  const ownerAuth = input.config.ownerAuth === 'passkey' ? 'passkey' : 'google';
  const { projectId, installationId, region } = manifest.identity;
  const authUrl =
    input.config.webAuthUrl ??
    `https://${installationId}-web-${await projectNumber(runner, projectId)}.${region}.run.app`;
  const recorded = input.config.authSecretVersion ?? recordedAuthSecretVersion(manifest);
  return {
    ...input,
    ownerAuth,
    authUrl,
    authSecretVersion: recorded,
    generatedAuthSecret: input.config.authSecretVersion === undefined,
    releaseSha: manifest.identity.release.commitSha,
  };
}

async function fetchJson(
  fetcher: typeof fetch,
  url: string,
): Promise<{ ok: boolean; body: Record<string, unknown> | null }> {
  try {
    const response = await fetcher(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: response.ok, body: body && typeof body === 'object' ? body : null };
  } catch {
    return { ok: false, body: null };
  }
}

/** Every final check is recorded; none of them reads or prints secret material. */
async function verifyReadiness(
  dependencies: ConsumerInstallDependencies,
  manifest: InstallationManifest,
  input: ResolvedRuntime,
  verify: NonNullable<ConsumerInstallOptions['verify']>,
): Promise<{ checks: ConsumerVerificationCheck[]; access: ConsumerInstallResult['ownerAccess'] }> {
  const checks: ConsumerVerificationCheck[] = [];
  const nativeVersion = verify.nativeAppVersion?.trim();
  if (nativeVersion && !/^[0-9]+(?:\.[0-9]+){1,3}(?:[+(-][A-Za-z0-9._-]+\)?)?$/.test(nativeVersion))
    throw new Error('Native app version must identify the installed version/build');
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  add(
    'native-app-installed',
    Boolean(nativeVersion),
    nativeVersion
      ? `operator confirmed the native app installed: ${nativeVersion}; distribution availability is not machine-verified`
      : 'install the published native app first, then supply its version/build; this installation uses native conversation',
  );
  add(
    'native-pairing',
    Boolean(nativeVersion && verify.nativePairingConfirmed),
    nativeVersion && verify.nativePairingConfirmed
      ? 'operator confirmed authenticated pairing and loading the new installation on that native client'
      : 'create a device key in the owner administration console, pair the installed app, and confirm authenticated loading',
  );
  const serving = await verifyRuntimeServices(dependencies.runner, manifest, input);
  add(
    'cloud-run-revisions',
    true,
    `web and agent serve the recorded image digests; agent revision ${serving.agentRevision} receives 100% of traffic`,
  );
  const access = await inspectOwnerAccess(dependencies.runner, manifest, input, false);
  add(
    'owner-access',
    access.publicInvoker,
    access.publicInvoker
      ? 'web is publicly invocable and the agent has no public invoker'
      : 'web is still private; complete the owner-access step first',
  );
  const fetcher = dependencies.fetcher ?? globalThis.fetch;
  const release = manifest.identity.release.commitSha;
  for (const base of [...new Set([access.webUrl, access.authOrigin])]) {
    const health = await fetchJson(fetcher, `${base}/api/health`);
    add(
      `health ${base}`,
      health.ok && health.body?.sha === release,
      health.ok
        ? health.body?.sha === release
          ? 'serves the installation release'
          : 'serves a different release'
        : 'health endpoint unreachable',
    );
  }
  if (input.ownerAuth === 'passkey') {
    const status = await fetchJson(fetcher, `${access.authOrigin}/api/owner/status`);
    add(
      'owner-claimed',
      status.ok && status.body?.claimed === true,
      status.body?.claimed === true
        ? 'an owner passkey is registered'
        : 'no owner passkey yet; open the setup link from --issue-owner-claim',
    );
  } else {
    add(
      'owner-signed-in',
      verify.ownerSignInConfirmed === true,
      verify.ownerSignInConfirmed
        ? 'operator confirmed Google sign-in as the owner'
        : 'sign in as the owner, then rerun with --owner-signed-in',
    );
  }
  const evidence = await verify.evidence({
    ownerAuth: input.ownerAuth,
    webUrl: access.webUrl,
    authOrigin: access.authOrigin,
    agentId: input.config.firestoreAgentId,
    runtimeInitializedAt: manifest.stage.updatedAt,
    servingAgentRevision: serving.agentRevision,
    releaseSha: input.releaseSha,
    embeddingSpace: input.config.firestoreEmbeddingSpace,
  });
  add(
    'runtime-data',
    evidence.runtimeData.ready,
    evidence.runtimeData.ready
      ? 'agent, budget, model roles, and catalog are consistent'
      : `runtime data issues: ${evidence.runtimeData.issues.join(', ') || 'unknown'}`,
  );
  add(
    'native-reply-delivery',
    evidence.ownerReplyDelivered,
    evidence.ownerReplyDelivered
      ? 'a model call from the serving agent revision is linked to an owner request and reply acknowledged by the paired client; acknowledgement does not prove the owner read or understood it'
      : 'send a first authenticated conversation from the paired native app, wait for its reply, then rerun verification',
  );
  return { checks, access };
}

/** Provision the customer-owned foundation in resumable, verified stages. */
export async function provisionConsumerInstallation(
  dependencies: ConsumerInstallDependencies,
  options: ConsumerInstallOptions,
): Promise<ConsumerInstallResult> {
  const input = validateInstallationManifest(options.manifest);
  if (input.status !== 'active') throw new Error('Cannot provision an invalidated installation');
  const runtimeInput = options.runtime ? validateRuntimeInput(options.runtime, input) : null;
  if (options.ownerAccessCallback && !runtimeInput)
    throw new Error('Owner access requires the matching runtime images and config');
  if (options.verify && !runtimeInput)
    throw new Error('Verification requires the matching runtime images and config');
  if (options.ownerAccessCallback && runtimeInput?.config.ownerAuth === 'passkey')
    throw new Error(
      'Passkey installations need no OAuth callback; web is public from the runtime deploy',
    );
  if (
    options.ownerAccessCallback &&
    options.ownerAccessCallback !== `${runtimeInput?.config.webAuthUrl}/api/auth/callback/google`
  )
    throw new Error('Confirmed OAuth callback must exactly match the configured AUTH_URL callback');
  const now = options.now ?? (() => new Date().toISOString());
  const terraformRunner = dependencies.terraform ?? dependencies.runner;
  await verifyTerraformDirectory(options.terraformDir);
  // Complete archive verification before any cloud read or write. The returned
  // buffers are the only Terraform inputs used later, preventing unverified
  // files in the checkout (or a second read) from entering the apply.
  const verifiedFoundation = await verifyTrustedFoundationArchive(
    options.archivePath,
    input.identity.release.archiveDigest,
    runtimeInput !== null,
  );
  const trustedIndexSpec = verifiedFoundation.get(indexSpecPath);
  if (!trustedIndexSpec) throw new Error('Verified Firestore index specification is missing');
  const expectedStateBucket = `${input.identity.projectId}-${input.identity.installationId}-state`;
  if (options.stateBucket !== expectedStateBucket)
    throw new Error(`State bucket must be ${expectedStateBucket} for this installation`);

  const persisted = await readPersistedInstallation(options.statePath);
  if (!persisted && input.stage.current !== 'previewed')
    throw new Error('An advanced manifest requires matching persisted installation state');
  let current = persisted ?? input;
  if (current.status !== 'active') throw new Error('Cannot resume an invalidated installation');
  if (persisted && JSON.stringify(persisted.identity) !== JSON.stringify(input.identity)) {
    throw new Error('Persisted installation identity does not match the supplied manifest');
  }
  if (persisted && JSON.stringify(persisted.selection) !== JSON.stringify(input.selection)) {
    throw new Error('Persisted installation selection does not match the supplied manifest');
  }
  if (
    (current.stage.current === 'initialized' || current.stage.current === 'ready') &&
    !runtimeInput
  )
    throw new Error(
      'An initialized runtime requires the same image manifest and runtime config to resume',
    );
  if (
    runtimeInput &&
    (current.stage.current === 'initialized' || current.stage.current === 'ready') &&
    !current.resources.some(
      (resource) =>
        resource.kind === 'runtime-config' && resource.name === runtimeInput.fingerprint,
    )
  )
    throw new Error('Runtime config differs from the initialized checkpoint');
  if (options.ownerAccessCallback && current.stage.current !== 'initialized')
    throw new Error('Deploy and verify the private runtime before enabling owner access');
  if (
    options.verify &&
    current.stage.current !== 'initialized' &&
    current.stage.current !== 'ready'
  )
    throw new Error('Deploy the runtime before running the final verification');
  await verifyCustomerBilling(dependencies.runner, current.identity.projectId);
  let runtime = runtimeInput
    ? await resolveRuntime(dependencies.runner, current, runtimeInput)
    : null;
  if (current.stage.current === 'previewed' || current.stage.current === 'authorized') {
    const missingApis = await verifyProjectAndDatabase(dependencies.runner, current, options.apply);
    if (!options.apply) {
      return {
        manifest: current,
        applied: false,
        runtimeReady: false,
        completed: current.stage.completed,
        pending: cloudStages.filter((stage) => !current.stage.completed.includes(stage)),
        disabledApis: missingApis,
        note: missingApis.length
          ? `Validated archive and project. Required APIs are disabled: ${missingApis.join(', ')}. No resources were changed.`
          : 'Validated archive, project, and database absence. No resources were changed; pass --apply to provision the foundation.',
      };
    }
  }
  if (!options.apply) {
    if (current.stage.current === 'provisioned')
      await verifyConsumerIndexReadiness(dependencies.runner, current.identity, trustedIndexSpec);
    let ownerAccess: ConsumerInstallResult['ownerAccess'];
    if (runtime && current.stage.current === 'initialized' && options.ownerAccessCallback) {
      await verifyRuntimePrerequisites(dependencies.runner, current, runtime);
      await verifyRuntimeServices(dependencies.runner, current, runtime);
      ownerAccess = await inspectOwnerAccess(dependencies.runner, current, runtime, false);
    }
    if (runtime && options.verify) {
      const { checks, access } = await verifyReadiness(
        dependencies,
        current,
        runtime,
        options.verify,
      );
      const passed = checks.every((check) => check.ok);
      return {
        manifest: current,
        applied: false,
        runtimeReady: passed && current.stage.current === 'ready',
        completed: current.stage.completed,
        pending: cloudStages.filter((stage) => !current.stage.completed.includes(stage)),
        ownerAccess: access,
        verification: { passed, checks },
        note: passed
          ? 'All readiness checks passed. No state was changed; rerun with --apply to record the ready stage.'
          : 'Readiness checks did not all pass. No state was changed.',
      };
    }
    return {
      manifest: current,
      applied: false,
      runtimeReady: current.stage.current === 'ready',
      completed: current.stage.completed,
      pending: cloudStages.filter(
        (stage) => !current.stage.completed.includes(stage as InstallationStage),
      ),
      ownerAccess,
      note: ownerAccess
        ? 'Verified private runtime, enabled auth secret versions, web URL, owner auth environment, and service IAM. No resources were changed. Confirm the Google OAuth Web client and HTTPS routing before --apply.'
        : 'Validated archive and project for the persisted foundation stage. No resources were changed.',
    };
  }

  const terraformWillRun =
    current.stage.current === 'previewed' ||
    current.stage.current === 'authorized' ||
    current.stage.current === 'bootstrapped' ||
    (runtime !== null && current.stage.current === 'provisioned') ||
    (options.ownerAccessCallback !== undefined && current.stage.current === 'initialized');
  if (terraformWillRun) await verifyTerraformVersion(terraformRunner);

  if (current.stage.current === 'previewed') {
    const previous = current;
    current = advanceInstallationStage(previous, 'authorized', now());
    await persistInstallationProgress(options.statePath, current, persisted ?? null);
  }
  if (current.stage.current === 'authorized') {
    await ensureFreshBucket(
      dependencies.runner,
      options.stateBucket,
      current.identity.projectId,
      current.identity.region,
      current.identity.installationId,
      current.identity.release.commitSha,
      current.identity.release.archiveDigest,
    );
    await runOk(dependencies.runner, 'gcloud', [
      'storage',
      'cp',
      options.archivePath,
      `gs://${options.stateBucket}/releases/${current.identity.release.commitSha}.tar.gz`,
      `--custom-metadata=assistant_installation=${current.identity.installationId},assistant_archive_digest=${current.identity.release.archiveDigest}`,
    ]);
    const previous = current;
    current = validateInstallationManifest({
      ...advanceInstallationStage(previous, 'bootstrapped', now()),
      resources: [
        ...previous.resources,
        {
          kind: 'state-bucket',
          name: options.stateBucket,
          scope: 'installation',
          owner: 'bootstrap',
          installationId: current.identity.installationId,
        },
        {
          kind: 'release-receipt',
          name: `gs://${options.stateBucket}/releases/${current.identity.release.commitSha}.tar.gz`,
          scope: 'installation',
          owner: 'bootstrap',
          installationId: current.identity.installationId,
        },
      ],
    });
    await persistInstallationProgress(options.statePath, current, previous);
  }
  if (current.stage.current === 'bootstrapped') {
    const workspace = await prepareTerraformWorkspace(verifiedFoundation);
    const terraformOptions = { ...options, terraformDir: workspace.terraformDir };
    await terraform(terraformRunner, terraformOptions, [
      'init',
      '-input=false',
      '-lockfile=readonly',
      '-backend-config',
      `bucket=${options.stateBucket}`,
      '-backend-config',
      `prefix=assistant/${current.identity.installationId}`,
    ]);
    await terraform(terraformRunner, terraformOptions, [
      'apply',
      '-auto-approve',
      // Firestore field exemptions in one database can conflict if created
      // concurrently, even when the provider does not wait for backfill.
      '-parallelism=1',
      ...terraformVars(current, options.stateBucket),
    ]);
    const output = await terraform(terraformRunner, terraformOptions, ['output', '-json']);
    const outputValues = validateTerraformOutputs(jsonOutput(output, 'Terraform output'), current);
    await waitForConsumerIndexReadiness(
      dependencies.runner,
      current.identity,
      trustedIndexSpec,
      dependencies.indexReadinessWait,
    );
    await rm(workspace.root, { recursive: true, force: true });
    const previous = current;
    current = validateInstallationManifest({
      ...advanceInstallationStage(previous, 'provisioned', now()),
      resources: [...current.resources, ...foundationResources(outputValues, current)],
    });
    await persistInstallationProgress(options.statePath, current, previous);
  } else if (
    current.stage.current === 'provisioned' ||
    current.stage.current === 'initialized' ||
    current.stage.current === 'ready'
  ) {
    // Older provisioned manifests did not attest live index readiness. Recheck
    // on resume, and also detect an index removed after an earlier successful run.
    await verifyConsumerIndexReadiness(dependencies.runner, current.identity, trustedIndexSpec);
  }
  if (runtime && current.stage.current === 'provisioned') {
    if (runtime.authSecretVersion === null)
      runtime = {
        ...runtime,
        authSecretVersion: await ensureGeneratedAuthSecret(dependencies.runner, current),
      };
    const deploying = runtime;
    await verifyRuntimePrerequisites(dependencies.runner, current, deploying);
    const workspace = await prepareTerraformWorkspace(verifiedFoundation, true);
    const terraformOptions = { ...options, terraformDir: workspace.terraformDir };
    const initialized = await terraformRunner.run('terraform', [
      `-chdir=${workspace.terraformDir}`,
      'init',
      '-input=false',
      '-lockfile=readonly',
      '-backend-config',
      `bucket=${options.stateBucket}`,
      '-backend-config',
      `prefix=assistant/${current.identity.installationId}`,
    ]);
    if (!initialized.ok)
      throw new Error('Runtime Terraform init failed; check state bucket access and retry');
    const runtimeVarsForApply = [
      ...terraformVars(current, options.stateBucket),
      ...runtimeVars(deploying),
    ];
    const identityPlanPath = join(workspace.root, 'runtime-identities.tfplan');
    const identityPlan = await terraformRunner.run('terraform', [
      `-chdir=${workspace.terraformDir}`,
      'plan',
      '-input=false',
      '-target=google_service_account.web',
      `-out=${identityPlanPath}`,
      ...runtimeVarsForApply,
    ]);
    if (!identityPlan.ok)
      throw new Error(
        'Could not plan the Cloud Run service identities for IAM preflight; retry the runtime install',
      );
    const identityPlanJson = await terraformRunner.run('terraform', [
      `-chdir=${workspace.terraformDir}`,
      'show',
      '-json',
      identityPlanPath,
    ]);
    if (!identityPlanJson.ok)
      throw new Error('Could not inspect the runtime identity Terraform plan');
    assertRuntimePlanPreservesResources(
      jsonOutput(identityPlanJson, 'Runtime identity Terraform plan'),
    );
    const identities = await terraformRunner.run('terraform', [
      `-chdir=${workspace.terraformDir}`,
      'apply',
      '-input=false',
      '-auto-approve',
      identityPlanPath,
    ]);
    if (!identities.ok)
      throw new Error(
        'Could not prepare the Cloud Run service identities for IAM preflight; retry the runtime install',
      );
    const fetcher = dependencies.fetcher ?? globalThis.fetch;
    for (const identity of [
      `${current.identity.installationId}-runtime@${current.identity.projectId}.iam.gserviceaccount.com`,
      `${current.identity.installationId}-web@${current.identity.projectId}.iam.gserviceaccount.com`,
    ])
      await verifyCloudRunActAs(dependencies.runner, fetcher, current.identity.projectId, identity);
    const runtimePlanPath = join(workspace.root, 'runtime.tfplan');
    const planned = await terraformRunner.run('terraform', [
      `-chdir=${workspace.terraformDir}`,
      'plan',
      '-input=false',
      `-out=${runtimePlanPath}`,
      ...runtimeVarsForApply,
    ]);
    if (!planned.ok)
      throw new Error(
        'Runtime Terraform plan failed; review the retained work directory and retry the same inputs',
      );
    const runtimePlanJson = await terraformRunner.run('terraform', [
      `-chdir=${workspace.terraformDir}`,
      'show',
      '-json',
      runtimePlanPath,
    ]);
    if (!runtimePlanJson.ok) throw new Error('Runtime Terraform plan inspection failed');
    assertRuntimePlanPreservesResources(jsonOutput(runtimePlanJson, 'Runtime Terraform plan'));
    const applied = await terraformRunner.run('terraform', [
      `-chdir=${workspace.terraformDir}`,
      'apply',
      '-input=false',
      '-auto-approve',
      runtimePlanPath,
    ]);
    if (!applied.ok)
      throw new Error(
        'Runtime Terraform apply failed; review the retained work directory and retry the same inputs',
      );
    const output = await terraformRunner.run('terraform', [
      `-chdir=${terraformOptions.terraformDir}`,
      'output',
      '-json',
    ]);
    if (!output.ok)
      throw new Error('Runtime Terraform output failed; check retained work directory and retry');
    const values = validateTerraformOutputs(jsonOutput(output, 'Terraform output'), current);
    const expectedNames = {
      cloud_run_web_service_name: `${current.identity.installationId}-web`,
      cloud_run_agent_service_name: `${current.identity.installationId}-agent`,
    };
    for (const [key, name] of Object.entries(expectedNames)) {
      if ((values[key] as { value?: unknown } | undefined)?.value !== name)
        throw new Error(`Runtime Terraform output ${key} does not match installation`);
    }
    await verifyRuntimeServices(dependencies.runner, current, deploying);
    if (deploying.ownerAuth === 'passkey')
      await inspectOwnerAccess(dependencies.runner, current, deploying, true);
    await rm(workspace.root, { recursive: true, force: true });
    const previous = current;
    const secretName = `projects/${current.identity.projectId}/secrets/${current.identity.installationId}-auth-secret`;
    current = validateInstallationManifest({
      ...advanceInstallationStage(previous, 'initialized', now()),
      resources: [
        ...previous.resources,
        // A release rebase keeps the bootstrap-owned secret records.
        ...(deploying.generatedAuthSecret && recordedAuthSecretVersion(previous) === null
          ? [
              {
                kind: 'secret',
                name: secretName,
                scope: 'installation' as const,
                owner: 'bootstrap' as const,
                installationId: current.identity.installationId,
              },
              {
                kind: 'auth-secret-version',
                name: `${secretName}/versions/${deploying.authSecretVersion}`,
                scope: 'installation' as const,
                owner: 'bootstrap' as const,
                installationId: current.identity.installationId,
              },
            ]
          : []),
        {
          kind: 'runtime-config',
          name: deploying.fingerprint,
          scope: 'installation',
          owner: 'terraform',
          installationId: current.identity.installationId,
        },
        ...(['web', 'agent'] as const).map((name) => ({
          kind: 'cloud-run-service',
          name: `${current.identity.installationId}-${name}`,
          scope: 'installation' as const,
          owner: 'terraform' as const,
          installationId: current.identity.installationId,
        })),
      ],
    });
    await persistInstallationProgress(options.statePath, current, previous);
  } else if (runtime && current.stage.current === 'initialized' && !options.verify) {
    await verifyRuntimeServices(dependencies.runner, current, runtime);
  }
  let ownerAccess: ConsumerInstallResult['ownerAccess'];
  if (
    runtime?.ownerAuth === 'passkey' &&
    (current.stage.current === 'initialized' || current.stage.current === 'ready') &&
    !options.verify
  )
    ownerAccess = await inspectOwnerAccess(dependencies.runner, current, runtime, true);
  if (runtime && options.verify) {
    const { checks, access } = await verifyReadiness(
      dependencies,
      current,
      runtime,
      options.verify,
    );
    const passed = checks.every((check) => check.ok);
    if (passed && current.stage.current === 'initialized') {
      const previous = current;
      current = advanceInstallationStage(previous, 'ready', now());
      await persistInstallationProgress(options.statePath, current, previous);
    }
    return {
      manifest: current,
      applied: true,
      runtimeReady: passed && current.stage.current === 'ready',
      completed: current.stage.completed,
      pending: cloudStages.filter((stage) => !current.stage.completed.includes(stage)),
      ownerAccess: access,
      verification: { passed, checks },
      note: passed
        ? 'All readiness checks passed and the installation is recorded as ready.'
        : 'Readiness checks did not all pass; the installation stays initialized. Fix the failing checks and rerun.',
    };
  }
  if (runtime && options.ownerAccessCallback && current.stage.current === 'initialized') {
    await verifyRuntimePrerequisites(dependencies.runner, current, runtime);
    const before = await inspectOwnerAccess(dependencies.runner, current, runtime, false);
    if (before.publicInvoker) ownerAccess = before;
    else {
      const workspace = await prepareTerraformWorkspace(verifiedFoundation, true);
      const initialized = await terraformRunner.run('terraform', [
        `-chdir=${workspace.terraformDir}`,
        'init',
        '-input=false',
        '-lockfile=readonly',
        '-backend-config',
        `bucket=${options.stateBucket}`,
        '-backend-config',
        `prefix=assistant/${current.identity.installationId}`,
      ]);
      if (!initialized.ok)
        throw new Error('Owner-access Terraform init failed; retry the same inputs');
      const planPath = join(workspace.root, 'owner-access.tfplan');
      const planned = await terraformRunner.run('terraform', [
        `-chdir=${workspace.terraformDir}`,
        'plan',
        '-input=false',
        '-target=google_cloud_run_v2_service_iam_member.web_public',
        `-out=${planPath}`,
        ...terraformVars(current, options.stateBucket),
        ...runtimeVars(runtime),
        '-var',
        'allow_public_web_invoker=true',
      ]);
      if (!planned.ok) throw new Error('Owner-access Terraform plan failed; retry the same inputs');
      const shown = await terraformRunner.run('terraform', [
        `-chdir=${workspace.terraformDir}`,
        'show',
        '-json',
        planPath,
      ]);
      if (!shown.ok) throw new Error('Owner-access Terraform plan inspection failed');
      const plan = jsonOutput(shown, 'Owner-access Terraform plan') as {
        resource_changes?: Array<{
          address?: unknown;
          change?: { actions?: unknown; after?: Record<string, unknown> };
        }>;
      };
      const changes = plan.resource_changes;
      const binding = changes?.find(
        (change) =>
          change.address === 'google_cloud_run_v2_service_iam_member.web_public["current"]',
      );
      if (
        !Array.isArray(changes) ||
        !binding ||
        changes.some(
          (change) => change !== binding && JSON.stringify(change.change?.actions) !== '["no-op"]',
        ) ||
        JSON.stringify(binding.change?.actions) !== '["create"]' ||
        binding.change?.after?.member !== 'allUsers' ||
        binding.change?.after?.role !== 'roles/run.invoker' ||
        binding.change?.after?.name !== `${current.identity.installationId}-web`
      )
        throw new Error('Owner-access Terraform plan includes unexpected changes');
      const applied = await terraformRunner.run('terraform', [
        `-chdir=${workspace.terraformDir}`,
        'apply',
        '-input=false',
        '-auto-approve',
        planPath,
      ]);
      if (!applied.ok)
        throw new Error('Owner-access Terraform apply failed; retry the same inputs');
      ownerAccess = await inspectOwnerAccess(dependencies.runner, current, runtime, true);
      await rm(workspace.root, { recursive: true, force: true });
    }
  }
  return {
    manifest: current,
    applied: true,
    runtimeReady: current.stage.current === 'ready',
    completed: current.stage.completed,
    pending: cloudStages.filter((stage) => !current.stage.completed.includes(stage)),
    ownerAccess,
    note:
      ownerAccess?.ownerAuth === 'passkey'
        ? 'Passkey web is public and claim-protected. Issue the one-time setup link (--issue-owner-claim), register the owner passkey and save the recovery code, create a device key in /security, pair the installed native app, send its first conversation, then run --verify with --native-app-version and --native-pairing-confirmed.'
        : ownerAccess
          ? 'Web invocation is public for the operator-confirmed OAuth callback. Verify the customer OAuth client, owner sign-in, native app installation and pairing, and an authenticated owner conversation before claiming runtime readiness.'
          : current.stage.current === 'initialized'
            ? 'Customer-owned Cloud Run services and revisions verified. Owner sign-in, model response, and end-to-end readiness remain gated.'
            : 'Customer-owned foundation and READY indexes verified. Runtime services, owner authentication, and end-to-end readiness remain gated.',
  };
}
