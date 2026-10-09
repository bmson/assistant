import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { MigrationBundle } from '../packages/persistence/src/migration.js';
import {
  canonicalJson,
  type EvidenceStore,
  type StepEvidence,
  sha256Hex,
  verifyEvidenceChain,
} from './cutover-evidence.js';
import {
  applyNeonFence,
  type Clock,
  createSnapshotBranch,
  type NeonApi,
  neonUrlForHost,
  removeNeonFence,
  type SqlProbe,
  verifyNeonFence,
  witnessSourceUnchanged,
} from './cutover-neon-fence.js';
import { migrationAssetReferences } from './workspace-asset-audit.js';
import type { AssetRecoveryManifest, AssetRecoveryStorage } from './workspace-asset-recovery.js';

// ---------------------------------------------------------------------------
// Configuration. Non-secret identities only; credentials are read at run time.

export type ServiceTarget = {
  name: string;
  /** Immutable image reference, preferably a digest, built from releaseSha. */
  image: string;
  env: Record<string, string>;
  /** Env name -> "secret-name:version". Must not name a database secret. */
  secrets: Record<string, string>;
  health?: { path: string; expectReleaseSha: boolean };
  ready?: { path: string; authenticated: boolean; expectDatabase?: string };
};

export type CutoverConfig = {
  gcp: { project: string; region: string; firestoreLocation: string };
  installationId: string;
  workspaceBucket: string;
  releaseSha: string;
  sourceAgentId: string;
  embedding: { provider: string; model: string; dimensions: number; revision: string };
  firestoreDatabaseId: string;
  neon: { projectId: string; branchId: string; endpointId: string; snapshotBranchName: string };
  fence: { samples: number; intervalSeconds: number; allowAvailabilityStarts: boolean };
  sourceDatabaseSecret: string;
  exportDatabaseSecret: string;
  exportServiceAccount: string;
  /** Services that receive POSTGRES_SOURCE_WRITES_FENCED=true during quiesce (defense in depth). */
  appWriteGateServices: string[];
  assets: {
    recoveryManifest: string;
    recoveryPrefix: string;
    backupPrefix: string;
    restorePrefix: string;
    expectedRecovered: number;
    expectedUnresolved: number;
  };
  firestoreBackup: { gcsPrefix: string; restoreDatabaseId: string };
  services: ServiceTarget[];
  dispatcher: {
    schedulerJobs: string[];
    queues: string[];
    pushSubscriptions: Array<{ name: string } & PushTarget>;
    /** Legacy Cloud Tasks retained while paused would be delivered to the Firestore runtime. */
    acceptLegacyTaskBacklog: boolean;
  };
};

/**
 * Where a push subscription delivers, and the OIDC identity Pub/Sub signs each
 * push with. Re-pointing a subscription without its identity would strip the
 * token the webhook verifies, so the pair always travels together.
 */
export type PushTarget = { endpoint: string; oidcServiceAccount?: string; oidcAudience?: string };

export function pushConfigArgs(name: string, target: PushTarget): string[] {
  return [
    'pubsub',
    'subscriptions',
    'modify-push-config',
    name,
    `--push-endpoint=${target.endpoint}`,
    ...(target.oidcServiceAccount
      ? [`--push-auth-service-account=${target.oidcServiceAccount}`]
      : []),
    ...(target.oidcAudience ? [`--push-auth-token-audience=${target.oidcAudience}`] : []),
  ];
}

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const GS_PREFIX = /^gs:\/\/[a-z0-9._-]+\/.+\/$/;

/** Names that make a Cloud Run template depend on the old database. */
export function isDatabaseEnvName(name: string): boolean {
  return /^(DATABASE_URL|PROD_DATABASE_URL|MIGRATION_DATABASE_URL|PG[A-Z_]*|POSTGRES_[A-Z_]+|NEON_[A-Z_]+)$/.test(
    name,
  );
}

export function isDatabaseSecretName(name: string): boolean {
  return /^database-url($|-)|neon|postgres/i.test(name);
}

export function validateCutoverConfig(config: CutoverConfig): CutoverConfig {
  const fail = (message: string): never => {
    throw new Error(`Invalid cutover config: ${message}`);
  };
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.gcp?.project ?? '')) fail('gcp.project');
  if (!/^[a-z]+-[a-z]+\d$/.test(config.gcp.region)) fail('gcp.region');
  if (!/^[a-z0-9-]+$/.test(config.gcp.firestoreLocation)) fail('gcp.firestoreLocation');
  if (!/^[a-zA-Z0-9_-]+$/.test(config.installationId)) fail('installationId');
  if (config.workspaceBucket !== `${config.gcp.project}-workspace`) fail('workspaceBucket');
  if (!SHA.test(config.releaseSha)) fail('releaseSha must be a full commit SHA');
  if (!UUID.test(config.sourceAgentId)) fail('sourceAgentId');
  if (!Number.isInteger(config.embedding?.dimensions)) fail('embedding.dimensions');
  if (!/^[a-z][a-z0-9-]{3,62}$/.test(config.firestoreDatabaseId)) fail('firestoreDatabaseId');
  if (config.firestoreDatabaseId.startsWith('assistant-restore-'))
    fail('firestoreDatabaseId must not be a restore rehearsal database');
  if (!/^br-/.test(config.neon?.branchId ?? '') || !/^ep-/.test(config.neon.endpointId))
    fail('neon identities');
  if (!NAME.test(config.neon.snapshotBranchName)) fail('neon.snapshotBranchName');
  if (!Number.isInteger(config.fence?.samples) || config.fence.samples < 2)
    fail('fence.samples must be at least 2');
  if (!(config.fence.intervalSeconds >= 60)) fail('fence.intervalSeconds must be at least 60');
  if (!isDatabaseSecretName(config.sourceDatabaseSecret)) fail('sourceDatabaseSecret');
  if (
    !/^database-url-[a-z0-9-]+$/.test(config.exportDatabaseSecret) ||
    config.exportDatabaseSecret === config.sourceDatabaseSecret
  )
    fail('exportDatabaseSecret must be a separate database-url-* secret');
  if (!/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(config.exportServiceAccount))
    fail('exportServiceAccount');
  const workspace = `gs://${config.workspaceBucket}/workspace/${config.installationId}/`;
  for (const key of ['recoveryPrefix', 'backupPrefix', 'restorePrefix'] as const) {
    if (!GS_PREFIX.test(config.assets?.[key] ?? '')) fail(`assets.${key}`);
  }
  if (!config.assets.recoveryPrefix.startsWith(`${workspace}migration-recovery/`))
    fail('assets.recoveryPrefix must be under the installation migration-recovery prefix');
  if (config.assets.backupPrefix === config.assets.restorePrefix)
    fail('asset backup and restore prefixes must differ');
  if (!GS_PREFIX.test(`${config.firestoreBackup?.gcsPrefix ?? ''}/`))
    fail('firestoreBackup.gcsPrefix');
  if (!/^assistant-restore-[a-z0-9-]{1,45}$/.test(config.firestoreBackup.restoreDatabaseId))
    fail('firestoreBackup.restoreDatabaseId must start with assistant-restore-');
  if (!Array.isArray(config.services) || config.services.length === 0) fail('services');
  for (const service of config.services) {
    if (!NAME.test(service.name)) fail(`service name ${service.name}`);
    if (!service.image.includes('@sha256:') && !service.image.endsWith(`:${config.releaseSha}`))
      fail(`${service.name} image must be a digest or tagged with releaseSha`);
    for (const name of Object.keys(service.env))
      if (isDatabaseEnvName(name)) fail(`${service.name} env ${name} is a database setting`);
    for (const [name, ref] of Object.entries(service.secrets)) {
      if (isDatabaseEnvName(name) || isDatabaseSecretName(ref.split(':')[0] ?? ''))
        fail(`${service.name} secret ${name} references the database`);
    }
    if (service.env.PERSISTENCE_DRIVER !== 'firestore')
      fail(`${service.name} must set PERSISTENCE_DRIVER=firestore`);
    if (service.env.FIRESTORE_DATABASE_ID !== config.firestoreDatabaseId)
      fail(`${service.name} FIRESTORE_DATABASE_ID must equal firestoreDatabaseId`);
  }
  return config;
}

// ---------------------------------------------------------------------------
// Adapters. Tests supply fakes; cutover.ts supplies the real implementations.

export type Gcloud = {
  /** Runs gcloud with --project and --format=json appended, returning parsed output. */
  json<T = unknown>(args: string[]): Promise<T>;
  /** Runs gcloud with --project appended; stdin is used for secret payloads. */
  run(args: string[], options?: { stdin?: string }): Promise<string>;
};

export type CommandRunner = (
  command: string,
  args: string[],
  env: Record<string, string>,
) => Promise<{ code: number; stdout: string }>;

export type HttpGet = (url: string, bearer?: string) => Promise<{ status: number; body: unknown }>;

export type CutoverDeps = {
  gcloud: Gcloud;
  commands: CommandRunner;
  neon: NeonApi;
  probe: SqlProbe;
  clock: Clock;
  storage: () => Promise<AssetRecoveryStorage>;
  http: HttpGet;
  readFile: (path: string) => Promise<Buffer>;
};

// ---------------------------------------------------------------------------
// Inventory. Records names, states, hosts, and secret references, never values.

export type SecretRef = { env: string; secret: string; version: string };
export type ServiceInventory = {
  name: string;
  /** Absent in evidence recorded before runtime identities were captured. */
  serviceAccount?: string | null;
  url: string | null;
  latestReadyRevision: string | null;
  traffic: Array<{ revision: string | null; percent: number; latest: boolean }>;
  image: string | null;
  envNames: string[];
  config: Record<string, string>;
  secretRefs: SecretRef[];
};
export type JobInventory = {
  name: string;
  image: string | null;
  envNames: string[];
  secretRefs: SecretRef[];
};
export type Inventory = {
  capturedAt: string;
  services: ServiceInventory[];
  jobs: JobInventory[];
  schedulerJobs: Array<{
    name: string;
    state: string;
    schedule: string;
    targetHost: string | null;
  }>;
  queues: Array<{ name: string; state: string }>;
  subscriptions: Array<{ name: string; topic: string; pushHost: string | null }>;
  secrets: string[];
};

/** Non-secret configuration values worth recording verbatim. */
const RECORDED_ENV = new Set([
  'PERSISTENCE_DRIVER',
  'QUEUE_DRIVER',
  'FIRESTORE_DATABASE_ID',
  'FIRESTORE_AGENT_ID',
  'POSTGRES_SOURCE_WRITES_FENCED',
  'ASSISTANT_MODULES',
  'ASSISTANT_WORKSPACE_ID',
  'BUILD_SHA',
]);

type EnvEntry = {
  name?: string;
  value?: string;
  valueFrom?: { secretKeyRef?: { name?: string; key?: string } };
};
type Container = { image?: string; env?: EnvEntry[] };

function containerSummary(container: Container | undefined) {
  const env = container?.env ?? [];
  return {
    image: container?.image ?? null,
    envNames: env.map((item) => item.name ?? '').filter(Boolean),
    config: Object.fromEntries(
      env
        .filter((item) => item.name && RECORDED_ENV.has(item.name) && item.value !== undefined)
        .map((item) => [item.name as string, String(item.value)]),
    ),
    secretRefs: env
      .filter((item) => item.name && item.valueFrom?.secretKeyRef?.name)
      .map((item) => ({
        env: item.name as string,
        secret: item.valueFrom?.secretKeyRef?.name as string,
        version: item.valueFrom?.secretKeyRef?.key ?? 'latest',
      })),
  };
}

const lastSegment = (name: string | undefined) => (name ?? '').split('/').at(-1) ?? '';
function hostOf(uri: string | undefined | null): string | null {
  if (!uri) return null;
  try {
    return new URL(uri).host;
  } catch {
    return null;
  }
}

type RunService = {
  metadata?: { name?: string };
  status?: {
    url?: string;
    latestReadyRevisionName?: string;
    traffic?: Array<{ revisionName?: string; percent?: number; latestRevision?: boolean }>;
  };
  spec?: { template?: { spec?: { serviceAccountName?: string; containers?: Container[] } } };
};
type RunJob = {
  metadata?: { name?: string };
  spec?: { template?: { spec?: { template?: { spec?: { containers?: Container[] } } } } };
};

export function serviceInventory(item: RunService): ServiceInventory {
  return {
    name: item.metadata?.name ?? '',
    serviceAccount: item.spec?.template?.spec?.serviceAccountName ?? null,
    url: item.status?.url ?? null,
    latestReadyRevision: item.status?.latestReadyRevisionName ?? null,
    traffic: (item.status?.traffic ?? []).map((entry) => ({
      revision:
        entry.revisionName ??
        (entry.latestRevision ? (item.status?.latestReadyRevisionName ?? null) : null),
      percent: entry.percent ?? 0,
      latest: entry.latestRevision === true,
    })),
    ...containerSummary(item.spec?.template?.spec?.containers?.[0]),
  };
}

export async function captureInventory(config: CutoverConfig, deps: CutoverDeps) {
  const region = config.gcp.region;
  const [services, jobs, scheduler, queues, subscriptions, secrets] = await Promise.all([
    deps.gcloud.json<RunService[]>(['run', 'services', 'list', '--region', region]),
    deps.gcloud.json<RunJob[]>(['run', 'jobs', 'list', '--region', region]),
    deps.gcloud.json<
      Array<{ name?: string; state?: string; schedule?: string; httpTarget?: { uri?: string } }>
    >(['scheduler', 'jobs', 'list', '--location', region]),
    deps.gcloud.json<Array<{ name?: string; state?: string }>>([
      'tasks',
      'queues',
      'list',
      '--location',
      region,
    ]),
    deps.gcloud.json<
      Array<{
        name?: string;
        topic?: string;
        pushConfig?: {
          pushEndpoint?: string;
          oidcToken?: { serviceAccountEmail?: string; audience?: string };
        };
      }>
    >(['pubsub', 'subscriptions', 'list']),
    deps.gcloud.json<Array<{ name?: string }>>(['secrets', 'list']),
  ]);
  const inventory: Inventory = {
    capturedAt: deps.clock.now().toISOString(),
    services: services.map(serviceInventory),
    jobs: jobs.map((item) => ({
      name: item.metadata?.name ?? '',
      ...(({ image, envNames, secretRefs }) => ({ image, envNames, secretRefs }))(
        containerSummary(item.spec?.template?.spec?.template?.spec?.containers?.[0]),
      ),
    })),
    schedulerJobs: scheduler.map((item) => ({
      name: lastSegment(item.name),
      state: item.state ?? 'UNKNOWN',
      schedule: item.schedule ?? '',
      targetHost: hostOf(item.httpTarget?.uri),
    })),
    queues: queues.map((item) => ({
      name: lastSegment(item.name),
      state: item.state ?? 'UNKNOWN',
    })),
    subscriptions: subscriptions.map((item) => ({
      name: lastSegment(item.name),
      topic: lastSegment(item.topic),
      pushHost: hostOf(item.pushConfig?.pushEndpoint),
    })),
    secrets: secrets.map((item) => lastSegment(item.name)).sort(),
  };
  // Push endpoints can carry verification tokens; keep the full values out of step evidence.
  const pushEndpoints: Record<string, PushTarget> = Object.fromEntries(
    subscriptions
      .filter((item) => item.pushConfig?.pushEndpoint)
      .map((item) => {
        const oidc = item.pushConfig?.oidcToken;
        const target: PushTarget = {
          endpoint: item.pushConfig?.pushEndpoint as string,
          ...(oidc?.serviceAccountEmail ? { oidcServiceAccount: oidc.serviceAccountEmail } : {}),
          ...(oidc?.audience ? { oidcAudience: oidc.audience } : {}),
        };
        return [lastSegment(item.name), target];
      }),
  );
  return { inventory, pushEndpoints };
}

export function databaseDependencies(inventory: Inventory) {
  const templates = [
    ...inventory.services.map((item) => ({ kind: 'service' as const, ...item })),
    ...inventory.jobs.map((item) => ({ kind: 'job' as const, ...item })),
  ];
  return templates
    .map((item) => ({
      kind: item.kind,
      name: item.name,
      databaseEnv: item.envNames.filter(isDatabaseEnvName),
      databaseSecrets: item.secretRefs
        .filter((ref) => isDatabaseEnvName(ref.env) || isDatabaseSecretName(ref.secret))
        .map((ref) => `${ref.env}=${ref.secret}:${ref.version}`),
    }))
    .filter((item) => item.databaseEnv.length > 0 || item.databaseSecrets.length > 0);
}

// ---------------------------------------------------------------------------
// Step engine.

export type StepContext = {
  config: CutoverConfig;
  deps: CutoverDeps;
  store: EvidenceStore;
  evidence<T>(step: StepName): T;
  sourceUrl(): Promise<string>;
};

type StepResult = { passed: boolean; result: Record<string, unknown> };

type StepDefinition = {
  name: StepName;
  mutating: boolean;
  summary: string;
  run(context: StepContext): Promise<StepResult>;
};

export const STEP_NAMES = [
  'preflight',
  'quiesce',
  'fence',
  'drain-proof',
  'snapshot-branch',
  'final-export',
  'source-witness',
  'import',
  'verify-import',
  'assets',
  'firestore-backup',
  'activate',
  'switch-services',
  'dispatcher',
  'live-verify',
] as const;
export type StepName = (typeof STEP_NAMES)[number];

function check(checks: Array<{ name: string; ok: boolean }>, name: string, ok: boolean) {
  checks.push({ name, ok });
  return ok;
}

/** The JSON summary line a Cloud Run job printed, found in Cloud Logging. */
function findSummary<T>(
  entries: Array<{ textPayload?: string; jsonPayload?: unknown }>,
  requiredKey: string,
): T | null {
  for (const entry of entries) {
    // Cloud Logging stores a single-line JSON stdout write as jsonPayload and
    // anything else (including pretty-printed JSON) as textPayload.
    let parsed: unknown = entry.jsonPayload;
    if (!parsed) {
      const text = entry.textPayload?.trim();
      if (!text?.startsWith('{')) continue;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue; // Not the summary line.
      }
    }
    if (parsed && typeof parsed === 'object' && requiredKey in parsed) return parsed as T;
  }
  return null;
}

async function jobSummary<T extends Record<string, unknown>>(
  context: StepContext,
  job: string,
  notBefore: string,
  requiredKey: string,
): Promise<{ execution: string; summary: T }> {
  const { gcloud } = context.deps;
  const region = context.config.gcp.region;
  const executions = await gcloud.json<
    Array<{
      metadata?: { name?: string; creationTimestamp?: string };
      status?: { succeededCount?: number };
    }>
  >(['run', 'jobs', 'executions', 'list', '--job', job, '--region', region, '--limit', '5']);
  const execution = executions
    .filter((item) => (item.metadata?.creationTimestamp ?? '') >= notBefore)
    .sort((a, b) =>
      (b.metadata?.creationTimestamp ?? '').localeCompare(a.metadata?.creationTimestamp ?? ''),
    )[0];
  const name = execution?.metadata?.name;
  if (!name || (execution.status?.succeededCount ?? 0) < 1)
    throw new Error(`No successful ${job} execution started after ${notBefore}`);
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Unexpected Cloud Run execution name');
  // Entries become readable a few seconds after the execution completes, so an
  // immediate read can miss the summary. Poll for about a minute before failing.
  for (let attempt = 0; attempt < 7; attempt++) {
    if (attempt > 0) await context.deps.clock.sleep(10_000);
    const summary = findSummary<T>(
      await gcloud.json<Array<{ textPayload?: string; jsonPayload?: unknown }>>([
        'logging',
        'read',
        `resource.type="cloud_run_job" AND resource.labels.job_name="${job}" AND labels."run.googleapis.com/execution_name"="${name}"`,
        '--limit',
        '200',
        '--freshness',
        '2d',
      ]),
      requiredKey,
    );
    if (summary) return { execution: name, summary };
  }
  throw new Error(`Execution ${name} did not log a ${job} summary`);
}

/** Parse the final JSON object a CLI printed to stdout. */
export function lastJsonObject(stdout: string): Record<string, unknown> {
  const starts = [...stdout.matchAll(/^\{/gm)].map((match) => match.index ?? 0).reverse();
  for (const start of starts) {
    try {
      const value = JSON.parse(stdout.slice(start)) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value))
        return value as Record<string, unknown>;
    } catch {
      // Try an earlier opening brace.
    }
  }
  throw new Error('Command did not print a JSON result');
}

async function runCli(
  context: StepContext,
  command: string,
  args: string[],
  env = {},
  acceptedCodes: number[] = [0],
) {
  const { code, stdout } = await context.deps.commands(command, args, env);
  if (!acceptedCodes.includes(code))
    throw new Error(`${command} ${args[0] ?? ''} exited with status ${code}`);
  return lastJsonObject(stdout);
}

function commonJobEnv(config: CutoverConfig): Record<string, string> {
  return {
    GCP_PROJECT: config.gcp.project,
    GCP_REGION: config.gcp.region,
    MIGRATION_SOURCE_AGENT_ID: config.sourceAgentId,
    FIRESTORE_TARGET_DATABASE_ID: config.firestoreDatabaseId,
  };
}

function dispatchIdle(inventory: Inventory) {
  return {
    enabledSchedulerJobs: inventory.schedulerJobs
      .filter((item) => item.state === 'ENABLED')
      .map((item) => item.name),
    runningQueues: inventory.queues
      .filter((item) => item.state === 'RUNNING')
      .map((item) => item.name),
    pushSubscriptions: inventory.subscriptions
      .filter((item) => item.pushHost)
      .map((item) => item.name),
  };
}

function stepsDefinition(): StepDefinition[] {
  return [
    {
      name: 'preflight',
      mutating: false,
      summary: 'Validate identities, capture the writer inventory, and check every target.',
      async run(context) {
        const { config, deps } = context;
        const checks: Array<{ name: string; ok: boolean }> = [];
        const accounts = await deps.gcloud.json<Array<{ account?: string }>>([
          'auth',
          'list',
          '--filter=status:ACTIVE',
        ]);
        check(checks, 'gcloud has an active account', accounts.length > 0);
        const { inventory, pushEndpoints } = await captureInventory(config, deps);
        // Retried preflights overwrite this: nothing has changed production yet.
        const pushEndpointEvidence = `${JSON.stringify(pushEndpoints)}\n`;
        context.store.writePrivate('push-endpoints.json', pushEndpointEvidence, {
          overwrite: true,
        });
        const migrate = inventory.jobs.find((job) => job.name === 'assistant-migrate');
        check(
          checks,
          'released migration job uses releaseSha',
          migrate?.image ===
            `${config.gcp.region}-docker.pkg.dev/${config.gcp.project}/assistant/migrate:${config.releaseSha}`,
        );
        const databases = await deps.gcloud.json<
          Array<{ name?: string; pointInTimeRecoveryEnablement?: string }>
        >(['firestore', 'databases', 'list']);
        const target = databases.find((db) => lastSegment(db.name) === config.firestoreDatabaseId);
        check(checks, 'target Firestore database exists', Boolean(target));
        check(
          checks,
          'target Firestore database has point-in-time recovery',
          target?.pointInTimeRecoveryEnablement === 'POINT_IN_TIME_RECOVERY_ENABLED',
        );
        // Once switched, each service reads and writes the target as its runtime
        // identity; without a grant every request is refused.
        const policy = await deps.gcloud.json<{
          bindings?: Array<{
            role?: string;
            members?: string[];
            condition?: { expression?: string };
          }>;
        }>(['projects', 'get-iam-policy', config.gcp.project]);
        for (const service of config.services) {
          const account = inventory.services.find(
            (item) => item.name === service.name,
          )?.serviceAccount;
          check(
            checks,
            `service ${service.name} runtime identity can use the target Firestore database`,
            Boolean(account) &&
              firestoreAccessGranted(policy.bindings ?? [], `serviceAccount:${account}`, config),
          );
        }
        check(
          checks,
          'restore rehearsal database does not exist yet',
          !databases.some(
            (db) => lastSegment(db.name) === config.firestoreBackup.restoreDatabaseId,
          ),
        );
        for (const service of config.services)
          check(
            checks,
            `service ${service.name} exists`,
            inventory.services.some((item) => item.name === service.name),
          );
        for (const job of config.dispatcher.schedulerJobs)
          check(
            checks,
            `scheduler job ${job} exists`,
            inventory.schedulerJobs.some((i) => i.name === job),
          );
        for (const queue of config.dispatcher.queues)
          check(
            checks,
            `queue ${queue} exists`,
            inventory.queues.some((i) => i.name === queue),
          );
        for (const subscription of config.dispatcher.pushSubscriptions) {
          const live = pushEndpoints[subscription.name];
          check(
            checks,
            `push subscription ${subscription.name} keeps its live OIDC identity`,
            live !== undefined &&
              (live.oidcServiceAccount ?? '') === (subscription.oidcServiceAccount ?? '') &&
              (live.oidcAudience ?? '') === (subscription.oidcAudience ?? ''),
          );
        }
        check(
          checks,
          'source database secret exists',
          inventory.secrets.includes(config.sourceDatabaseSecret),
        );
        const manifest = JSON.parse(
          (await deps.readFile(config.assets.recoveryManifest)).toString('utf8'),
        ) as AssetRecoveryManifest;
        check(
          checks,
          'recovery manifest prefix matches',
          manifest.destinationPrefix === config.assets.recoveryPrefix,
        );
        check(
          checks,
          `recovery manifest lists ${config.assets.expectedRecovered} recovered objects`,
          manifest.recovered.length === config.assets.expectedRecovered &&
            manifest.recovered.every((entry) => entry.verified && entry.createOnly),
        );
        check(
          checks,
          `recovery manifest lists ${config.assets.expectedUnresolved} unresolved references`,
          manifest.missing.length === config.assets.expectedUnresolved,
        );
        const endpoint = await deps.neon.getEndpoint(config.neon.projectId, config.neon.endpointId);
        check(
          checks,
          'Neon endpoint is the configured branch read-write endpoint',
          endpoint.type === 'read_write' && endpoint.branch_id === config.neon.branchId,
        );
        const sourceUrl = await context.sourceUrl();
        // Fails if the secret points anywhere but the configured Neon endpoint.
        neonUrlForHost(sourceUrl, config.neon.endpointId, endpoint.host);
        check(checks, 'database-url secret points at the configured Neon endpoint', true);
        const sessions =
          endpoint.disabled === true
            ? null
            : await deps.probe.sessionInventory(
                neonUrlForHost(sourceUrl, config.neon.endpointId, endpoint.host),
              );
        return {
          passed: checks.every((item) => item.ok),
          result: {
            checks,
            inventory,
            pushEndpointsSha256: sha256Hex(pushEndpointEvidence),
            databaseDependencies: databaseDependencies(inventory),
            neonEndpoint: {
              id: endpoint.id,
              host: endpoint.host,
              disabled: endpoint.disabled === true,
              currentState: endpoint.current_state,
            },
            sourceSessions: sessions,
            recovery: {
              recovered: manifest.recovered.length,
              unresolved: manifest.missing.map((entry) => ({
                sourceRecordId: entry.sourceRecordId,
                classification: entry.classification,
              })),
            },
          },
        };
      },
    },
    {
      name: 'quiesce',
      mutating: true,
      summary: 'Pause Scheduler jobs and queues, detach push subscriptions, enable the app gate.',
      async run(context) {
        const { config, deps } = context;
        const region = config.gcp.region;
        const preflight = context.evidence<{ inventory: Inventory }>('preflight').inventory;
        const runHosts = new Set(
          preflight.services.map((item) => hostOf(item.url)).filter(Boolean),
        );
        // Act on the current state so a retried quiesce does not re-pause resources;
        // rollback restores from the preflight inventory, not from this attempt.
        const { inventory: before } = await captureInventory(config, deps);
        const paused: string[] = [];
        for (const job of before.schedulerJobs.filter((item) => item.state === 'ENABLED')) {
          await deps.gcloud.run(['scheduler', 'jobs', 'pause', job.name, '--location', region]);
          paused.push(job.name);
        }
        const pausedQueues: string[] = [];
        for (const queue of before.queues.filter((item) => item.state === 'RUNNING')) {
          await deps.gcloud.run(['tasks', 'queues', 'pause', queue.name, '--location', region]);
          pausedQueues.push(queue.name);
        }
        const detached: string[] = [];
        for (const subscription of before.subscriptions) {
          if (!subscription.pushHost || !runHosts.has(subscription.pushHost)) continue;
          // An empty push endpoint converts the subscription to pull; its backlog is retained.
          await deps.gcloud.run([
            'pubsub',
            'subscriptions',
            'modify-push-config',
            subscription.name,
            '--push-endpoint=',
          ]);
          detached.push(subscription.name);
        }
        const gated: Array<{ name: string; revision: string | null }> = [];
        for (const name of config.appWriteGateServices) {
          await deps.gcloud.run([
            'run',
            'services',
            'update',
            name,
            '--region',
            region,
            '--update-env-vars',
            'POSTGRES_SOURCE_WRITES_FENCED=true',
            '--quiet',
          ]);
          const described = serviceInventory(
            await deps.gcloud.json<RunService>([
              'run',
              'services',
              'describe',
              name,
              '--region',
              region,
            ]),
          );
          gated.push({ name, revision: described.latestReadyRevision });
        }
        const { inventory } = await captureInventory(config, deps);
        const idle = dispatchIdle(inventory);
        const stillPushing = inventory.subscriptions.filter(
          (item) => item.pushHost && runHosts.has(item.pushHost),
        );
        const gateOk = config.appWriteGateServices.every(
          (name) =>
            inventory.services.find((item) => item.name === name)?.config
              .POSTGRES_SOURCE_WRITES_FENCED === 'true',
        );
        return {
          passed:
            idle.enabledSchedulerJobs.length === 0 &&
            idle.runningQueues.length === 0 &&
            stillPushing.length === 0 &&
            gateOk,
          result: {
            pausedSchedulerJobs: paused,
            pausedQueues,
            detachedSubscriptions: detached,
            appWriteGate: gated,
            after: { ...idle, pushSubscriptions: stillPushing.map((item) => item.name) },
            inventory,
          },
        };
      },
    },
    {
      name: 'fence',
      mutating: true,
      summary: 'Disable the Neon read-write endpoint (provider write fence).',
      async run(context) {
        const { config, deps } = context;
        const result = await applyNeonFence(deps.neon, deps.probe, neonTarget(config), {
          confirm: true,
          sourceUrl: await context.sourceUrl(),
          clock: deps.clock,
        });
        return { passed: result.after.disabled && result.after.currentState === 'idle', result };
      },
    },
    {
      name: 'drain-proof',
      mutating: false,
      summary: 'Sample the fence repeatedly and record queue backlog.',
      async run(context) {
        const { config, deps } = context;
        const fence = context.evidence<{ completedAt: string }>('fence');
        const verification = await verifyNeonFence(deps.neon, deps.probe, neonTarget(config), {
          sourceUrl: await context.sourceUrl(),
          fencedAt: fence.completedAt,
          samples: config.fence.samples,
          intervalMs: config.fence.intervalSeconds * 1000,
          allowAvailabilityStarts: config.fence.allowAvailabilityStarts,
          clock: deps.clock,
        });
        const { inventory } = await captureInventory(config, deps);
        const idle = dispatchIdle(inventory);
        const backlog: Record<string, number> = {};
        for (const queue of inventory.queues) {
          const tasks = await deps.gcloud.json<unknown[]>([
            'tasks',
            'list',
            '--queue',
            queue.name,
            '--location',
            config.gcp.region,
            '--limit',
            '1000',
          ]);
          backlog[queue.name] = tasks.length;
        }
        return {
          passed:
            verification.passed &&
            idle.enabledSchedulerJobs.length === 0 &&
            idle.runningQueues.length === 0,
          result: {
            verification,
            dispatch: idle,
            queueBacklog: backlog,
            // Activation compares this with the export timestamp.
            drainedAt: verification.lastSampleAt,
          },
        };
      },
    },
    {
      name: 'snapshot-branch',
      mutating: true,
      summary: 'Create the read-only snapshot branch and its export secret.',
      async run(context) {
        const { config, deps } = context;
        const { evidence, exportUrl } = await createSnapshotBranch(
          deps.neon,
          deps.probe,
          neonTarget(config),
          {
            confirm: true,
            sourceUrl: await context.sourceUrl(),
            name: attemptName(config.neon.snapshotBranchName, context, 'snapshot-branch'),
            clock: deps.clock,
          },
        );
        const secrets = await deps.gcloud.json<Array<{ name?: string }>>(['secrets', 'list']);
        const secret = config.exportDatabaseSecret;
        if (!secrets.some((item) => lastSegment(item.name) === secret))
          await deps.gcloud.run([
            'secrets',
            'create',
            secret,
            '--replication-policy=automatic',
            '--labels=purpose=cutover-final-export',
          ]);
        const version = await deps.gcloud.run(
          ['secrets', 'versions', 'add', secret, '--data-file=-', '--format=value(name)'],
          { stdin: exportUrl },
        );
        await deps.gcloud.run([
          'secrets',
          'add-iam-policy-binding',
          secret,
          `--member=serviceAccount:${config.exportServiceAccount}`,
          '--role=roles/secretmanager.secretAccessor',
          '--quiet',
        ]);
        return {
          passed: evidence.passed,
          result: {
            ...evidence,
            exportSecret: secret,
            exportSecretVersion: lastSegment(version.trim()),
          },
        };
      },
    },
    {
      name: 'final-export',
      mutating: true,
      summary: 'Export the fenced snapshot in Cloud Run and pin its bytes.',
      async run(context) {
        const { config, deps, store } = context;
        const checks: Array<{ name: string; ok: boolean }> = [];
        const startedAt = deps.clock.now().toISOString();
        const { code } = await deps.commands('bash', ['infra/gcp/workspace-export.sh'], {
          ...commonJobEnv(config),
          EXPORT_RELEASE_SHA: config.releaseSha,
          EXPORT_DATABASE_SECRET: config.exportDatabaseSecret,
          MIGRATION_EMBEDDING_PROVIDER: config.embedding.provider,
          MIGRATION_EMBEDDING_MODEL: config.embedding.model,
          MIGRATION_EMBEDDING_DIMENSIONS: String(config.embedding.dimensions),
          MIGRATION_EMBEDDING_REVISION: config.embedding.revision,
        });
        if (code !== 0) throw new Error(`workspace-export.sh exited with status ${code}`);
        const job = serviceInventoryForJob(
          await deps.gcloud.json<RunJob>([
            'run',
            'jobs',
            'describe',
            'assistant-workspace-export',
            '--region',
            config.gcp.region,
          ]),
        );
        check(
          checks,
          'export job read the snapshot secret',
          job.secretRefs.some(
            (ref) => ref.env === 'DATABASE_URL' && ref.secret === config.exportDatabaseSecret,
          ),
        );
        const { execution, summary } = await jobSummary<{
          uri: string;
          records: number;
          bundleChecksum: string;
          byteLength: number;
          sha256: string;
          generation: string;
        }>(context, 'assistant-workspace-export', startedAt, 'sha256');
        const prefix = `gs://${config.workspaceBucket}/workspace/${config.installationId}/migration/snapshots/`;
        check(
          checks,
          'snapshot is in the installation snapshot prefix',
          summary.uri.startsWith(prefix),
        );
        const object = await deps.gcloud.json<{ generation?: string; size?: string | number }>([
          'storage',
          'objects',
          'describe',
          summary.uri,
        ]);
        check(
          checks,
          'object generation and size match the job summary',
          String(object.generation) === summary.generation &&
            Number(object.size) === summary.byteLength,
        );
        const local = store.privatePath('final-snapshot.json');
        await deps.gcloud.run(['storage', 'cp', `${summary.uri}#${summary.generation}`, local]);
        const bytes = await deps.readFile(local);
        check(
          checks,
          'downloaded bytes match the pinned SHA-256',
          bytes.length === summary.byteLength && sha256Hex(bytes) === summary.sha256,
        );
        const bundle = JSON.parse(bytes.toString('utf8')) as MigrationBundle;
        const drain = context.evidence<{ drainedAt: string }>('drain-proof');
        const exportedAt = bundle.manifest.source.exportedAt ?? '';
        check(
          checks,
          'complete version 3 bundle',
          bundle.manifest.formatVersion === 3 &&
            bundle.manifest.coverage.complete === true &&
            bundle.manifest.coverage.omittedTables.length === 0,
        );
        check(
          checks,
          'bundle source agent matches',
          bundle.manifest.source.agentId === config.sourceAgentId,
        );
        check(
          checks,
          'bundle target matches',
          bundle.manifest.target.projectId === config.gcp.project &&
            bundle.manifest.target.databaseId === config.firestoreDatabaseId &&
            bundle.manifest.target.installationId === config.installationId,
        );
        check(
          checks,
          'bundle checksum matches the job summary',
          bundle.manifest.bundleChecksum === summary.bundleChecksum,
        );
        check(
          checks,
          'record count matches the job summary',
          bundle.records.length === summary.records,
        );
        check(
          checks,
          'export started after the drain proof',
          Date.parse(exportedAt) >= Date.parse(drain.drainedAt),
        );
        return {
          passed: checks.every((item) => item.ok),
          result: {
            checks,
            execution,
            snapshot: {
              uri: summary.uri,
              generation: summary.generation,
              sha256: summary.sha256,
              byteLength: summary.byteLength,
              bundleChecksum: summary.bundleChecksum,
              records: summary.records,
              exportedAt,
              tables: bundle.manifest.tables,
            },
            exportImageCommit: config.releaseSha,
          },
        };
      },
    },
    {
      name: 'source-witness',
      mutating: true,
      summary: 'Branch the source head again and prove it did not advance.',
      async run(context) {
        const { config, deps } = context;
        const snapshot = context.evidence<{
          lsn: string;
          lsnSource: 'neon-parent-lsn' | 'replay-lsn';
        }>('snapshot-branch');
        const result = await witnessSourceUnchanged(deps.neon, deps.probe, neonTarget(config), {
          confirm: true,
          sourceUrl: await context.sourceUrl(),
          snapshotLsn: snapshot.lsn,
          snapshotLsnSource: snapshot.lsnSource,
          name: `${config.neon.snapshotBranchName}-witness`.slice(0, 60),
          clock: deps.clock,
        });
        return { passed: result.passed, result };
      },
    },
    {
      name: 'import',
      mutating: true,
      summary: 'Preview, then import the pinned snapshot into the empty target.',
      async run(context) {
        const { config } = context;
        const snapshot = context.evidence<{
          snapshot: { uri: string; generation: string; sha256: string };
        }>('final-export').snapshot;
        const run = async (mode: 'preview' | 'write') => {
          const startedAt = context.deps.clock.now().toISOString();
          const { code } = await context.deps.commands('bash', ['infra/gcp/workspace-import.sh'], {
            ...commonJobEnv(config),
            IMPORT_RELEASE_SHA: config.releaseSha,
            MIGRATION_IMPORT_MODE: mode,
            MIGRATION_SNAPSHOT_URI: snapshot.uri,
            MIGRATION_SNAPSHOT_GENERATION: snapshot.generation,
            MIGRATION_SNAPSHOT_SHA256: snapshot.sha256,
          });
          if (code !== 0) throw new Error(`workspace-import.sh ${mode} exited with status ${code}`);
          return jobSummary<ImportSummary>(
            context,
            'assistant-workspace-import',
            startedAt,
            'writes',
          );
        };
        const preview = await run('preview');
        const write = await run('write');
        const checks: Array<{ name: string; ok: boolean }> = [];
        check(checks, 'preview reported preview mode', preview.summary.mode === 'preview');
        check(checks, 'write verified its import', write.summary.verified === true);
        check(
          checks,
          'write and preview agree on writes',
          write.summary.writes === preview.summary.writes,
        );
        check(
          checks,
          'import pinned the exported bytes',
          write.summary.snapshotSha256 === snapshot.sha256,
        );
        return {
          passed: checks.every((item) => item.ok),
          result: { checks, preview, write },
        };
      },
    },
    {
      name: 'verify-import',
      mutating: false,
      summary: 'Independently re-read the target: counts and canonical hashes.',
      async run(context) {
        const { config } = context;
        const exported = context.evidence<{
          snapshot: {
            uri: string;
            generation: string;
            sha256: string;
            bundleChecksum: string;
            records: number;
          };
        }>('final-export').snapshot;
        const imported = context.evidence<{ preview: { summary: ImportSummary } }>('import').preview
          .summary;
        const startedAt = context.deps.clock.now().toISOString();
        const { code } = await context.deps.commands('bash', ['infra/gcp/workspace-import.sh'], {
          ...commonJobEnv(config),
          IMPORT_RELEASE_SHA: config.releaseSha,
          MIGRATION_IMPORT_MODE: 'verify',
          MIGRATION_SNAPSHOT_URI: exported.uri,
          MIGRATION_SNAPSHOT_GENERATION: exported.generation,
          MIGRATION_SNAPSHOT_SHA256: exported.sha256,
        });
        if (code !== 0) throw new Error(`workspace-import.sh verify exited with status ${code}`);
        const verify = await jobSummary<ImportSummary>(
          context,
          'assistant-workspace-import',
          startedAt,
          'writes',
        );
        const checks: Array<{ name: string; ok: boolean }> = [];
        check(checks, 'verify mode reported verified', verify.summary.verified === true);
        check(
          checks,
          'source record count matches export',
          verify.summary.records === exported.records,
        );
        check(checks, 'document writes match preview', verify.summary.writes === imported.writes);
        check(
          checks,
          'collection counts match preview',
          canonicalJson(verify.summary.collections) === canonicalJson(imported.collections),
        );
        check(
          checks,
          'bundle checksum matches export',
          verify.summary.bundleChecksum === exported.bundleChecksum,
        );
        return { passed: checks.every((item) => item.ok), result: { checks, verify } };
      },
    },
    {
      name: 'assets',
      mutating: true,
      summary:
        'Audit assets, confirm the 12 recovered objects, back up and restore every present asset.',
      async run(context) {
        return assetsStep(context);
      },
    },
    {
      name: 'firestore-backup',
      mutating: true,
      summary: 'Managed Firestore backup, restore into an isolated database, parity, delete it.',
      async run(context) {
        const { config, deps, store } = context;
        const imported = context.evidence<{ verify: { summary: ImportSummary } }>('verify-import')
          .verify.summary;
        const snapshotTime = new Date(
          Math.floor(deps.clock.now().getTime() / 60_000) * 60_000 - 60_000,
        )
          .toISOString()
          .replace('.000Z', 'Z');
        // A retry needs a fresh export prefix, manifest, and restore database: the
        // backup tool never overwrites a manifest or adopts an existing database.
        const attempt = store.attempt(stepByName('firestore-backup').index, 'firestore-backup');
        const suffix = attempt === 1 ? '' : `-r${attempt}`;
        const gcsPrefix = `${config.firestoreBackup.gcsPrefix}${suffix}`;
        const restoreDatabaseId = `${config.firestoreBackup.restoreDatabaseId}${suffix}`.slice(
          0,
          63,
        );
        const manifestName = `firestore-backup-manifest${suffix}.json`;
        const manifest = store.privatePath(manifestName);
        const common = [
          '--gcloud-auth',
          '--project-id',
          config.gcp.project,
          '--installation-id',
          config.installationId,
        ];
        const backup = await runCli(context, 'pnpm', [
          'exec',
          'tsx',
          'scripts/firestore-managed-backup.ts',
          '--backup',
          '--execute',
          ...common,
          '--database-id',
          config.firestoreDatabaseId,
          '--gcs-prefix',
          gcsPrefix,
          '--snapshot-time',
          snapshotTime,
          '--manifest',
          manifest,
        ]);
        const restore = await runCli(context, 'pnpm', [
          'exec',
          'tsx',
          'scripts/firestore-managed-backup.ts',
          '--restore',
          '--execute',
          ...common,
          '--database-id',
          restoreDatabaseId,
          '--location',
          config.gcp.firestoreLocation,
          '--manifest',
          manifest,
        ]);
        const checks: Array<{ name: string; ok: boolean }> = [];
        check(checks, 'backup completed', backup.completed === true);
        check(checks, 'restore completed', restore.completed === true);
        check(
          checks,
          'backup documents equal imported writes',
          backup.documents === imported.writes,
        );
        check(
          checks,
          'restore document count matches backup',
          restore.documents === backup.documents,
        );
        check(
          checks,
          'restore canonical hash matches backup',
          restore.canonicalHash === backup.canonicalHash,
        );
        let deleted = false;
        if (checks.every((item) => item.ok)) {
          await deps.gcloud.run([
            'firestore',
            'databases',
            'delete',
            `--database=${restoreDatabaseId}`,
            '--quiet',
          ]);
          const remaining = await deps.gcloud.json<Array<{ name?: string }>>([
            'firestore',
            'databases',
            'list',
          ]);
          deleted = !remaining.some((db) => lastSegment(db.name) === restoreDatabaseId);
          check(checks, 'isolated restore database deleted', deleted);
        }
        return {
          passed: checks.every((item) => item.ok),
          result: {
            checks,
            snapshotTime,
            backup: { ...backup, manifest: `private/${manifestName}` },
            restore: { ...restore, databaseId: restoreDatabaseId },
            backupPrefix: gcsPrefix,
            manifestSha256: sha256Hex(await deps.readFile(manifest)),
          },
        };
      },
    },
    {
      name: 'activate',
      mutating: true,
      summary: 'Activate the Firestore migration marker while every dispatcher is still paused.',
      async run(context) {
        const { config, deps, store } = context;
        const fence = context.evidence<{ fenceId: string }>('fence');
        const drain = context.evidence<{ drainedAt: string }>('drain-proof');
        const snapshot = context.evidence<{
          snapshot: { uri: string; generation: string; sha256: string; bundleChecksum: string };
        }>('final-export').snapshot;
        const { inventory } = await captureInventory(config, deps);
        const idle = dispatchIdle(inventory);
        if (idle.enabledSchedulerJobs.length || idle.runningQueues.length)
          throw new Error('A dispatcher is running; activation needs zero active dispatchers');
        const result = await runCli(context, 'pnpm', [
          'workspace:import',
          '--activate',
          '--allow-cloud',
          '--gcloud-auth',
          '--in',
          store.privatePath('final-snapshot.json'),
          '--agent-id',
          config.sourceAgentId,
          '--project-id',
          config.gcp.project,
          '--database-id',
          config.firestoreDatabaseId,
          '--installation-id',
          config.installationId,
          '--source-write-fence-id',
          fence.fenceId,
          '--source-writes-drained-at',
          drain.drainedAt,
          '--snapshot-uri',
          snapshot.uri,
          '--snapshot-generation',
          snapshot.generation,
          '--snapshot-sha256',
          snapshot.sha256,
        ]);
        return {
          passed: result.activated === true && result.bundleChecksum === snapshot.bundleChecksum,
          result: { activation: result, dispatchersBeforeActivation: idle },
        };
      },
    },
    {
      name: 'switch-services',
      mutating: true,
      summary: 'Deploy the Firestore composition without DATABASE_URL and route all traffic to it.',
      async run(context) {
        const { config, deps } = context;
        const region = config.gcp.region;
        const switched: Array<Record<string, unknown>> = [];
        for (const service of config.services) {
          const current = serviceInventory(
            await deps.gcloud.json<RunService>([
              'run',
              'services',
              'describe',
              service.name,
              '--region',
              region,
            ]),
          );
          // The image carries BUILD_SHA; a service-level value would pin the
          // reported release and fail every later release's SHA check.
          const removeEnv = current.envNames.filter(
            (name) =>
              name === 'BUILD_SHA' ||
              (isDatabaseEnvName(name) && !current.secretRefs.some((ref) => ref.env === name)),
          );
          const removeSecrets = current.secretRefs
            .filter((ref) => isDatabaseEnvName(ref.env) || isDatabaseSecretName(ref.secret))
            .map((ref) => ref.env);
          const args = [
            'run',
            'services',
            'update',
            service.name,
            '--region',
            region,
            '--image',
            service.image,
            `--update-env-vars=^@^${Object.entries(service.env)
              .map(([key, value]) => `${key}=${value}`)
              .join('@')}`,
            '--quiet',
          ];
          if (removeEnv.length) args.push(`--remove-env-vars=${removeEnv.join(',')}`);
          if (removeSecrets.length) args.push(`--remove-secrets=${removeSecrets.join(',')}`);
          if (Object.keys(service.secrets).length)
            args.push(
              `--update-secrets=${Object.entries(service.secrets)
                .map(([key, value]) => `${key}=${value}`)
                .join(',')}`,
            );
          await deps.gcloud.run(args);
          await deps.gcloud.run([
            'run',
            'services',
            'update-traffic',
            service.name,
            '--region',
            region,
            '--to-latest',
          ]);
          const after = serviceInventory(
            await deps.gcloud.json<RunService>([
              'run',
              'services',
              'describe',
              service.name,
              '--region',
              region,
            ]),
          );
          switched.push({
            name: service.name,
            previousRevision: current.latestReadyRevision,
            revision: after.latestReadyRevision,
            image: after.image,
            removedEnv: removeEnv,
            removedSecrets: removeSecrets,
            ...serviceTemplateChecks(after, service, config),
          });
        }
        return {
          passed: switched.every((item) => item.ok === true),
          result: { services: switched },
        };
      },
    },
    {
      name: 'dispatcher',
      mutating: true,
      summary: 'Resume exactly the configured Firestore dispatch path.',
      async run(context) {
        const { config, deps } = context;
        const region = config.gcp.region;
        const backlog = context.evidence<{ queueBacklog: Record<string, number> }>(
          'drain-proof',
        ).queueBacklog;
        const legacyTasks = config.dispatcher.queues.reduce(
          (sum, queue) => sum + (backlog[queue] ?? 0),
          0,
        );
        if (legacyTasks > 0 && !config.dispatcher.acceptLegacyTaskBacklog)
          throw new Error(
            `${legacyTasks} legacy Cloud Tasks are paused in dispatcher queues; purge them or set acceptLegacyTaskBacklog`,
          );
        const switched = context.evidence<{ services: Array<{ name: string }> }>(
          'switch-services',
        ).services;
        const { inventory: current } = await captureInventory(config, deps);
        const runtimeHosts = new Set(
          current.services
            .filter((item) => switched.some((s) => s.name === item.name))
            .map((item) => hostOf(item.url))
            .filter(Boolean),
        );
        for (const job of config.dispatcher.schedulerJobs)
          if (current.schedulerJobs.find((item) => item.name === job)?.state !== 'ENABLED')
            await deps.gcloud.run(['scheduler', 'jobs', 'resume', job, '--location', region]);
        for (const queue of config.dispatcher.queues)
          if (current.queues.find((item) => item.name === queue)?.state !== 'RUNNING')
            await deps.gcloud.run(['tasks', 'queues', 'resume', queue, '--location', region]);
        for (const { name, ...target } of config.dispatcher.pushSubscriptions)
          await deps.gcloud.run(pushConfigArgs(name, target));
        const { inventory } = await captureInventory(config, deps);
        const idle = dispatchIdle(inventory);
        const same = (a: string[], b: string[]) =>
          canonicalJson([...a].sort()) === canonicalJson([...b].sort());
        const checks: Array<{ name: string; ok: boolean }> = [];
        check(
          checks,
          'enabled Scheduler jobs are exactly the configured set',
          same(idle.enabledSchedulerJobs, config.dispatcher.schedulerJobs),
        );
        check(
          checks,
          'running queues are exactly the configured set',
          same(idle.runningQueues, config.dispatcher.queues),
        );
        check(
          checks,
          'push subscriptions are exactly the configured set',
          same(
            idle.pushSubscriptions,
            config.dispatcher.pushSubscriptions.map((item) => item.name),
          ),
        );
        check(
          checks,
          'every enabled Scheduler job targets a switched Firestore service',
          inventory.schedulerJobs
            .filter((item) => item.state === 'ENABLED')
            .every((item) => item.targetHost !== null && runtimeHosts.has(item.targetHost)),
        );
        check(
          checks,
          'every push subscription targets a switched Firestore service',
          inventory.subscriptions
            .filter((item) => item.pushHost)
            .every((item) => runtimeHosts.has(item.pushHost as string)),
        );
        return {
          passed: checks.every((item) => item.ok),
          result: { checks, active: idle, legacyTaskBacklog: legacyTasks },
        };
      },
    },
    {
      name: 'live-verify',
      mutating: false,
      summary:
        'Release commit, health, Firestore readiness, no database secret, source still fenced.',
      async run(context) {
        return liveVerifyStep(context);
      },
    },
  ];
}

type ImportSummary = {
  mode: string;
  records: number;
  writes: number;
  collections: Record<string, number>;
  verified?: boolean;
  resumed?: boolean;
  snapshotSha256?: string;
  bundleChecksum?: string;
};

const FIRESTORE_DATA_ROLES = new Set([
  'roles/datastore.user',
  'roles/datastore.owner',
  'roles/editor',
  'roles/owner',
]);

/** A data-access role on the whole project, or conditioned on exactly the target database. */
function firestoreAccessGranted(
  bindings: Array<{ role?: string; members?: string[]; condition?: { expression?: string } }>,
  member: string,
  config: CutoverConfig,
): boolean {
  const target = `resource.name == "projects/${config.gcp.project}/databases/${config.firestoreDatabaseId}"`;
  return bindings.some(
    (binding) =>
      FIRESTORE_DATA_ROLES.has(binding.role ?? '') &&
      (binding.members ?? []).includes(member) &&
      (!binding.condition?.expression || binding.condition.expression.trim() === target),
  );
}

function serviceInventoryForJob(item: RunJob) {
  return containerSummary(item.spec?.template?.spec?.template?.spec?.containers?.[0]);
}

function attemptName(base: string, context: StepContext, step: StepName): string {
  const attempt = context.store.attempt(stepByName(step).index, step);
  return attempt === 1 ? base : `${base}-r${attempt}`.slice(0, 62);
}

function neonTarget(config: CutoverConfig) {
  return {
    projectId: config.neon.projectId,
    branchId: config.neon.branchId,
    endpointId: config.neon.endpointId,
  };
}

function serviceTemplateChecks(
  item: ServiceInventory,
  target: ServiceTarget,
  config: CutoverConfig,
) {
  const databaseEnv = item.envNames.filter(isDatabaseEnvName);
  const databaseSecrets = item.secretRefs.filter(
    (ref) => isDatabaseEnvName(ref.env) || isDatabaseSecretName(ref.secret),
  );
  const serving = item.traffic.filter((entry) => entry.percent > 0);
  const checks = {
    image: item.image === target.image,
    persistence: item.config.PERSISTENCE_DRIVER === 'firestore',
    firestoreDatabase: item.config.FIRESTORE_DATABASE_ID === config.firestoreDatabaseId,
    noDatabaseEnv: databaseEnv.length === 0,
    noDatabaseSecret: databaseSecrets.length === 0,
    allTrafficOnLatest:
      serving.length === 1 &&
      serving[0]?.percent === 100 &&
      serving[0].revision === item.latestReadyRevision,
  };
  return {
    checks,
    databaseEnv,
    databaseSecrets: databaseSecrets.map((ref) => ref.env),
    ok: Object.values(checks).every(Boolean),
  };
}

async function assetsStep(context: StepContext): Promise<StepResult> {
  const { config, deps, store } = context;
  const bundlePath = store.privatePath('final-snapshot.json');
  const common = ['--bucket', config.workspaceBucket, '--gcloud-auth'];
  // The audit exits 2 when it finds missing or mismatched objects. Missing
  // objects are expected here (the recovery manifest accounts for them), so keep
  // its report and let the checks below decide.
  const audit = await runCli(
    context,
    'pnpm',
    ['workspace:assets-audit', '--bundle', bundlePath, '--verify-digests', ...common],
    {},
    [0, 2],
  );
  const recovery = await runCli(context, 'pnpm', [
    'workspace:assets-recover',
    '--bundle',
    bundlePath,
    '--manifest',
    config.assets.recoveryManifest,
    '--target-bucket',
    config.workspaceBucket,
    '--recovery-prefix',
    config.assets.recoveryPrefix,
    '--gcloud-auth',
  ]);
  const manifest = JSON.parse(
    (await deps.readFile(config.assets.recoveryManifest)).toString('utf8'),
  ) as AssetRecoveryManifest;
  const bundle = JSON.parse((await deps.readFile(bundlePath)).toString('utf8')) as MigrationBundle;
  const references = migrationAssetReferences(bundle);
  const recoveredIds = new Map(manifest.recovered.map((entry) => [entry.sourceRecordId, entry]));
  const unresolvedIds = new Set(manifest.missing.map((entry) => entry.sourceRecordId));
  const storage = await deps.storage();
  const parse = (prefix: string) => {
    const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(prefix);
    if (!match?.[1] || !match[2]) throw new Error('Invalid gs:// prefix');
    return { bucket: match[1], name: match[2] };
  };
  const backupRoot = parse(config.assets.backupPrefix);
  const restoreRoot = parse(config.assets.restorePrefix);
  const copyVerified = async (
    source: { bucket: string; name: string; generation: string },
    destination: { bucket: string; name: string },
    digest: string,
  ) => {
    const existing = await storage.stat(destination);
    const generation = existing
      ? existing.generation
      : await storage.copyCreateOnly(source, destination);
    return (await storage.sha256({ ...destination, generation })) === digest;
  };
  let present = 0;
  let bytes = 0;
  let backedUp = 0;
  let restored = 0;
  const unaccountedMissing: string[] = [];
  const recoveredVerified: string[] = [];
  const sizeMismatches: string[] = [];
  for (const reference of references) {
    const live = {
      bucket: config.workspaceBucket,
      name: `workspace/${config.installationId}/${reference.path}`,
    };
    const stat = await storage.stat(live);
    if (!stat) {
      if (!unresolvedIds.has(reference.id)) unaccountedMissing.push(reference.id);
      continue;
    }
    present++;
    bytes += stat.size;
    const source = { ...live, generation: stat.generation };
    const digest = await storage.sha256(source);
    const recovered = recoveredIds.get(reference.id);
    if (
      recovered &&
      recovered.destination.sha256 === digest &&
      recovered.destination.bytes === stat.size
    )
      recoveredVerified.push(reference.id);
    // A recovered object's row was written while its bytes were missing, so its
    // recorded size can be stale; the recovery hash above verifies those bytes.
    if (
      reference.expectedBytes !== undefined &&
      stat.size !== reference.expectedBytes &&
      !recoveredVerified.includes(reference.id)
    )
      sizeMismatches.push(reference.id);
    const backup = { bucket: backupRoot.bucket, name: `${backupRoot.name}${reference.path}` };
    if (!(await copyVerified(source, backup, digest))) continue;
    backedUp++;
    const backupStat = await storage.stat(backup);
    if (!backupStat) continue;
    const restoreTarget = {
      bucket: restoreRoot.bucket,
      name: `${restoreRoot.name}${reference.path}`,
    };
    if (await copyVerified({ ...backup, generation: backupStat.generation }, restoreTarget, digest))
      restored++;
  }
  const unresolved = manifest.missing.map((entry) => ({
    sourceRecordId: entry.sourceRecordId,
    classification: entry.classification,
    decision: 'owner-accepted-loss-required',
  }));
  const checks: Array<{ name: string; ok: boolean }> = [];
  check(checks, 'recovery resolver has nothing left to copy', recovery.plannedCopies === 0);
  check(
    checks,
    `all ${config.assets.expectedRecovered} recovered objects are live with their recovery hash`,
    recovery.alreadyPresent === config.assets.expectedRecovered &&
      recoveredVerified.length === config.assets.expectedRecovered,
  );
  check(checks, 'no missing asset outside the recovery manifest', unaccountedMissing.length === 0);
  check(
    checks,
    `exactly ${config.assets.expectedUnresolved} unresolved references`,
    references.length - present === config.assets.expectedUnresolved,
  );
  check(
    checks,
    'every present asset is in the backup with identical SHA-256',
    backedUp === present,
  );
  check(checks, 'every backup restores with identical SHA-256', restored === present);
  check(checks, 'audit found no digest mismatch', audit.digestMismatches === 0);
  check(
    checks,
    'no size mismatch outside hash-verified recovered objects',
    sizeMismatches.length === 0,
  );
  return {
    passed: checks.every((item) => item.ok),
    result: {
      checks,
      audit,
      recovery,
      references: references.length,
      present,
      presentBytes: bytes,
      backedUp,
      restored,
      backupPrefix: config.assets.backupPrefix,
      restorePrefix: config.assets.restorePrefix,
      recoveredVerified,
      sizeMismatches,
      unaccountedMissing,
      unresolved,
    },
  };
}

async function liveVerifyStep(context: StepContext): Promise<StepResult> {
  const { config, deps } = context;
  const { inventory } = await captureInventory(config, deps);
  const services: Array<Record<string, unknown>> = [];
  let identityToken: string | undefined;
  for (const target of config.services) {
    const item = inventory.services.find((service) => service.name === target.name);
    if (!item?.url) {
      services.push({ name: target.name, ok: false, reason: 'service missing' });
      continue;
    }
    const template = serviceTemplateChecks(item, target, config);
    const probes: Record<string, unknown> = {};
    let probesOk = true;
    if (target.health) {
      const response = await deps.http(`${item.url}${target.health.path}`);
      const sha = (response.body as { sha?: unknown } | null)?.sha;
      const ok =
        response.status === 200 && (!target.health.expectReleaseSha || sha === config.releaseSha);
      probes.health = { status: response.status, sha: typeof sha === 'string' ? sha : null, ok };
      probesOk &&= ok;
    }
    if (target.ready) {
      if (target.ready.authenticated && !identityToken)
        identityToken = (await deps.gcloud.run(['auth', 'print-identity-token'])).trim();
      const response = await deps.http(
        `${item.url}${target.ready.path}`,
        target.ready.authenticated ? identityToken : undefined,
      );
      const database = (response.body as { database?: unknown } | null)?.database;
      const ok =
        response.status === 200 &&
        (!target.ready.expectDatabase || database === target.ready.expectDatabase);
      probes.ready = {
        status: response.status,
        database: typeof database === 'string' ? database : null,
        ok,
      };
      probesOk &&= ok;
    }
    services.push({
      name: target.name,
      revision: item.latestReadyRevision,
      ...template,
      probes,
      ok: template.ok && probesOk,
    });
  }
  const dependencies = databaseDependencies(inventory);
  const servingDependencies = dependencies.filter((item) => item.kind === 'service');
  const fence = context.evidence<{ completedAt: string }>('fence');
  const neon = await verifyNeonFence(deps.neon, deps.probe, neonTarget(config), {
    sourceUrl: await context.sourceUrl(),
    fencedAt: fence.completedAt,
    samples: 2,
    intervalMs: 5_000,
    allowAvailabilityStarts: config.fence.allowAvailabilityStarts,
    clock: deps.clock,
  });
  return {
    passed:
      services.every((item) => item.ok === true) && servingDependencies.length === 0 && neon.passed,
    result: {
      releaseSha: config.releaseSha,
      services,
      servingDatabaseDependencies: servingDependencies,
      // Jobs are not serving traffic; they are retirement blockers until deleted or rewritten.
      jobDatabaseDependencies: dependencies.filter((item) => item.kind === 'job'),
      sourceStillFenced: neon,
      inventory,
    },
  };
}

/**
 * A fresh, read-only proof for the PostgreSQL retirement report. Historical
 * cutover evidence establishes that the observation window elapsed; this pass
 * checks who is serving now, what persistence that traffic uses, current
 * health/readiness, dispatcher routing, and the source provider fence.
 */
export async function captureRetirementProof(
  config: CutoverConfig,
  deps: CutoverDeps,
  store: EvidenceStore,
) {
  const outcome = await liveVerifyStep(makeContext(config, deps, store));
  const inventory = outcome.result.inventory as Inventory;
  const current = dispatchIdle(inventory);
  const same = (a: string[], b: string[]) =>
    canonicalJson([...a].sort()) === canonicalJson([...b].sort());
  const expectedSubscriptions = config.dispatcher.pushSubscriptions.map((item) => item.name);
  const runtimeHosts = new Set(
    inventory.services
      .filter((service) => config.services.some((target) => target.name === service.name))
      .map((service) => hostOf(service.url))
      .filter((host): host is string => Boolean(host)),
  );
  const dispatcherChecks = {
    schedulerJobs: same(current.enabledSchedulerJobs, config.dispatcher.schedulerJobs),
    queues: same(current.runningQueues, config.dispatcher.queues),
    subscriptions: same(current.pushSubscriptions, expectedSubscriptions),
    schedulerTargets: inventory.schedulerJobs
      .filter((job) => job.state === 'ENABLED')
      .every((job) => Boolean(job.targetHost && runtimeHosts.has(job.targetHost))),
    subscriptionTargets: inventory.subscriptions
      .filter((subscription) => subscription.pushHost)
      .every((subscription) => runtimeHosts.has(subscription.pushHost as string)),
  };
  const services = outcome.result.services as Array<{
    name: string;
    ok: boolean;
    probes?: {
      health?: { ok?: boolean };
      ready?: { ok?: boolean; database?: string | null };
    };
  }>;
  const sourceStillFenced = outcome.result.sourceStillFenced as { passed?: boolean };
  const configuredProbes =
    config.services.length > 0 &&
    config.services.every((target) => Boolean(target.health || target.ready)) &&
    config.services.some((target) => target.ready?.expectDatabase === 'firestore');
  const operationalChecks = {
    liveVerifyPassed: outcome.passed,
    healthAndReadyConfigured: configuredProbes,
    healthAndReadyPassed: config.services.every((target) => {
      const service = services.find((item) => item.name === target.name);
      return Boolean(
        service?.ok &&
          (!target.health || service.probes?.health?.ok) &&
          (!target.ready ||
            (service.probes?.ready?.ok &&
              service.probes.ready.database === target.ready.expectDatabase)),
      );
    }),
    providerFencePassed: sourceStillFenced?.passed === true,
    dispatcherMatches: Object.values(dispatcherChecks).every(Boolean),
  };
  return {
    capturedAt: inventory.capturedAt,
    inventory,
    services,
    sourceStillFenced,
    dispatcher: { checks: dispatcherChecks, ok: Object.values(dispatcherChecks).every(Boolean) },
    checks: operationalChecks,
  };
}

// ---------------------------------------------------------------------------
// Runner.

export const STEPS: ReadonlyArray<StepDefinition & { index: number }> = stepsDefinition().map(
  (step, position) => ({ ...step, index: position + 1 }),
);

export function stepByName(name: string) {
  const step = STEPS.find((item) => item.name === name);
  if (!step)
    throw new Error(`Unknown cutover step ${name}; expected one of ${STEP_NAMES.join(', ')}`);
  return step;
}

export function configSha256(config: CutoverConfig): string {
  return sha256Hex(canonicalJson(config));
}

type CutoverRunIdentity = {
  format: 'assistant-cutover-run';
  version: 1;
  configSha256: string;
};

type CutoverIntent = {
  format: 'assistant-cutover-intent';
  version: 1;
  step: StepName;
  index: number;
  attempt: number;
  configSha256: string;
  startedAt: string;
};

function assertEvidenceMatchesConfig(config: CutoverConfig, store: EvidenceStore): void {
  const hash = configSha256(config);
  const run = store.readRecord<CutoverRunIdentity>('cutover-run.json');
  if (run) {
    if (run.format !== 'assistant-cutover-run' || run.version !== 1 || run.configSha256 !== hash)
      throw new Error('Cutover evidence belongs to a different configuration');
  }

  const ordered = STEPS.map((step) => store.read(step.index, step.name));
  let previous: string | null = null;
  let stopped = false;
  for (let index = 0; index < ordered.length; index += 1) {
    const evidence = ordered[index];
    if (!evidence) {
      stopped = true;
      continue;
    }
    if (stopped) throw new Error('Cutover evidence has a gap in its ordered step chain');
    if (evidence.configSha256 !== hash)
      throw new Error('Cutover evidence belongs to a different configuration');
    if (evidence.previousSha256 !== previous)
      throw new Error(`${evidence.step}: previous evidence hash does not match`);
    if (evidence.status !== 'passed') {
      stopped = true;
      continue;
    }
    previous = store.fileSha256(evidence.index, evidence.step);
  }
  if (!run) {
    store.writeRecord('cutover-run.json', {
      format: 'assistant-cutover-run',
      version: 1,
      configSha256: hash,
    } satisfies CutoverRunIdentity);
  }
}

function unresolvedCutoverIntents(
  store: EvidenceStore,
): Array<{ name: string; value: CutoverIntent }> {
  const intents = store
    .records<CutoverIntent>('cutover-intent-')
    .filter(({ value }) => value.format === 'assistant-cutover-intent' && value.version === 1);
  const resolutions = store.records<{
    format?: unknown;
    intent?: unknown;
    configSha256?: unknown;
  }>('cutover-resolved-');
  const resolved = new Set(
    resolutions
      .filter(({ value }) => value.format === 'assistant-cutover-resolution')
      .map(({ value }) => `${value.intent}:${value.configSha256}`),
  );
  return intents.filter(({ name, value }) => !resolved.has(`${name}:${value.configSha256}`));
}

function assertNoUnresolvedIntent(store: EvidenceStore): void {
  const unresolved = unresolvedCutoverIntents(store)[0];
  if (unresolved)
    throw new Error(
      `Cutover step ${unresolved.value.step} has an unresolved durable intent; reconcile or roll back before resuming`,
    );
}

function makeContext(config: CutoverConfig, deps: CutoverDeps, store: EvidenceStore): StepContext {
  let sourceUrl: Promise<string> | undefined;
  return {
    config,
    deps,
    store,
    evidence<T>(name: StepName) {
      const step = stepByName(name);
      const evidence = store.read<T>(step.index, step.name);
      if (evidence?.status !== 'passed') throw new Error(`Step ${name} has not passed`);
      return evidence.result;
    },
    sourceUrl() {
      // Read from Secret Manager into memory only; never logged or written.
      sourceUrl ??= deps.gcloud
        .run(['secrets', 'versions', 'access', 'latest', `--secret=${config.sourceDatabaseSecret}`])
        .then((value) => value.trim());
      return sourceUrl;
    },
  };
}

export function cutoverStatus(config: CutoverConfig, store: EvidenceStore) {
  const hash = configSha256(config);
  const chain = verifyEvidenceChain(
    store,
    STEPS.map((step) => ({ index: step.index, name: step.name })),
  );
  return {
    configSha256: hash,
    chain,
    steps: STEPS.map((step) => {
      const evidence = store.read(step.index, step.name);
      return {
        index: step.index,
        name: step.name,
        mutating: step.mutating,
        status: evidence ? evidence.status : 'pending',
        completedAt: evidence?.completedAt ?? null,
        configMatches: evidence ? evidence.configSha256 === hash : null,
      };
    }),
  };
}

/**
 * Run one step. Prior steps must have passed under the same configuration.
 * A passed step is skipped (resumable); a failed one is archived and retried.
 * Mutating steps require `confirm` to equal the step name.
 */
export async function runCutoverStep(
  name: string,
  config: CutoverConfig,
  deps: CutoverDeps,
  store: EvidenceStore,
  options: { confirm?: string } = {},
): Promise<StepEvidence> {
  validateCutoverConfig(config);
  assertEvidenceMatchesConfig(config, store);
  assertNoUnresolvedIntent(store);
  const step = stepByName(name);
  const hash = configSha256(config);
  const existing = store.read(step.index, step.name);
  if (existing?.status === 'passed') {
    if (existing.configSha256 !== hash)
      throw new Error(`Step ${name} passed under a different configuration`);
    return existing;
  }
  let previousSha: string | null = null;
  for (const prior of STEPS.filter((item) => item.index < step.index)) {
    const evidence = store.read(prior.index, prior.name);
    if (evidence?.status !== 'passed')
      throw new Error(`Step ${prior.name} must pass before ${name}`);
    if (evidence.configSha256 !== hash)
      throw new Error(`Step ${prior.name} passed under a different configuration`);
    previousSha = store.fileSha256(prior.index, prior.name);
  }
  if (step.mutating && options.confirm !== step.name)
    throw new Error(`Step ${name} changes production; rerun with --confirm ${name}`);
  const startedAt = deps.clock.now().toISOString();
  const attempt = store.attempt(step.index, step.name);
  const intentName = `cutover-intent-${String(step.index).padStart(2, '0')}-${step.name}-${attempt}.json`;
  if (step.mutating) {
    store.writeRecord(intentName, {
      format: 'assistant-cutover-intent',
      version: 1,
      step: step.name,
      index: step.index,
      attempt,
      configSha256: hash,
      startedAt,
    } satisfies CutoverIntent);
  }
  let outcome: StepResult;
  let error: string | undefined;
  try {
    outcome = await step.run(makeContext(config, deps, store));
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Step failed';
    outcome = { passed: false, result: {} };
  }
  const evidence: StepEvidence = {
    format: 'assistant-cutover-evidence',
    version: 1,
    step: step.name,
    index: step.index,
    status: outcome.passed ? 'passed' : 'failed',
    mutating: step.mutating,
    confirmed: step.mutating,
    configSha256: hash,
    previousSha256: previousSha,
    startedAt,
    completedAt: deps.clock.now().toISOString(),
    result: outcome.result,
    ...(error ? { error } : {}),
  };
  store.write(evidence);
  if (step.mutating && !error) {
    store.writeRecord(
      `cutover-resolved-${String(step.index).padStart(2, '0')}-${step.name}-${attempt}.json`,
      {
        format: 'assistant-cutover-resolution',
        intent: intentName,
        configSha256: hash,
        status: evidence.status,
        completedAt: evidence.completedAt,
      },
    );
  }
  return evidence;
}

// ---------------------------------------------------------------------------
// Rollback. Restores PostgreSQL authority in the reverse order of the cutover.

export async function rollbackCutover(
  config: CutoverConfig,
  deps: CutoverDeps,
  store: EvidenceStore,
  options: { confirm?: string; acceptFirestoreDivergence?: boolean },
) {
  validateCutoverConfig(config);
  assertEvidenceMatchesConfig(config, store);
  if (options.confirm !== 'rollback')
    throw new Error('Rollback changes production; rerun with --confirm rollback');
  const context = makeContext(config, deps, store);
  const passed = (name: StepName) => store.read(stepByName(name).index, name)?.status === 'passed';
  const intents = store.records<CutoverIntent>('cutover-intent-').map(({ value }) => value);
  const attempted = (name: StepName) =>
    store.read(stepByName(name).index, name) !== null ||
    intents.some((intent) => intent.step === name && intent.configSha256 === configSha256(config));
  const preflight = context.evidence<{ inventory: Inventory; pushEndpointsSha256?: string }>(
    'preflight',
  );
  const pushEndpointBytes = await deps.readFile(store.privatePath('push-endpoints.json'));
  if (
    typeof preflight.pushEndpointsSha256 !== 'string' ||
    sha256Hex(pushEndpointBytes) !== preflight.pushEndpointsSha256
  )
    throw new Error('Rollback push-endpoint material does not match the preflight evidence');
  const pushEndpoints = JSON.parse(pushEndpointBytes.toString('utf8')) as Record<
    string,
    PushTarget | string
  >;
  if (
    (attempted('switch-services') || attempted('dispatcher')) &&
    !options.acceptFirestoreDivergence
  )
    throw new Error(
      'Production already served from Firestore; writes made there will not return to PostgreSQL. Pass --accept-firestore-divergence to roll back anyway.',
    );
  const preflightInventory = preflight.inventory;
  const region = config.gcp.region;
  const actions: string[] = [];
  const rollbackId = randomUUID();
  const rollbackConfigSha256 = configSha256(config);
  let actionSequence = 0;
  store.writeRecord(`cutover-rollback-start-${rollbackId}.json`, {
    format: 'assistant-cutover-rollback',
    version: 1,
    rollbackId,
    configSha256: rollbackConfigSha256,
    status: 'started',
    startedAt: deps.clock.now().toISOString(),
  });
  const run = async (label: string, args: string[]) => {
    actionSequence += 1;
    const actionId = `${rollbackId}-${String(actionSequence).padStart(3, '0')}`;
    store.writeRecord(`cutover-rollback-action-${actionId}.json`, {
      format: 'assistant-cutover-rollback-action',
      version: 1,
      rollbackId,
      configSha256: rollbackConfigSha256,
      action: label,
      status: 'intent',
      startedAt: deps.clock.now().toISOString(),
    });
    await deps.gcloud.run(args);
    actions.push(label);
    store.writeRecord(`cutover-rollback-done-${actionId}.json`, {
      format: 'assistant-cutover-rollback-action',
      version: 1,
      rollbackId,
      configSha256: rollbackConfigSha256,
      action: label,
      status: 'completed',
      completedAt: deps.clock.now().toISOString(),
    });
  };
  // 1. Stop the Firestore dispatch path first so only one dispatcher ever runs.
  if (attempted('dispatcher')) {
    for (const job of config.dispatcher.schedulerJobs)
      await run(`pause scheduler ${job}`, [
        'scheduler',
        'jobs',
        'pause',
        job,
        '--location',
        region,
      ]);
    for (const queue of config.dispatcher.queues)
      await run(`pause queue ${queue}`, ['tasks', 'queues', 'pause', queue, '--location', region]);
    for (const subscription of config.dispatcher.pushSubscriptions)
      await run(`detach ${subscription.name}`, [
        'pubsub',
        'subscriptions',
        'modify-push-config',
        subscription.name,
        '--push-endpoint=',
      ]);
  }
  // 2. Restore the PostgreSQL provider write capability.
  let unfence: Awaited<ReturnType<typeof removeNeonFence>> | null = null;
  if (attempted('fence')) {
    actionSequence += 1;
    const actionId = `${rollbackId}-${String(actionSequence).padStart(3, '0')}`;
    store.writeRecord(`cutover-rollback-action-${actionId}.json`, {
      format: 'assistant-cutover-rollback-action',
      version: 1,
      rollbackId,
      configSha256: rollbackConfigSha256,
      action: 're-enable Neon read-write endpoint',
      status: 'intent',
      startedAt: deps.clock.now().toISOString(),
    });
    unfence = await removeNeonFence(deps.neon, deps.probe, neonTarget(config), {
      confirm: true,
      sourceUrl: await context.sourceUrl(),
      clock: deps.clock,
    });
    actions.push('re-enable Neon read-write endpoint');
    store.writeRecord(`cutover-rollback-done-${actionId}.json`, {
      format: 'assistant-cutover-rollback-action',
      version: 1,
      rollbackId,
      configSha256: rollbackConfigSha256,
      action: 're-enable Neon read-write endpoint',
      status: 'completed',
      completedAt: deps.clock.now().toISOString(),
    });
  }
  // 3. Restore the source-write gate if quiesce was interrupted after changing it.
  if (attempted('quiesce')) {
    for (const name of config.appWriteGateServices) {
      const original = preflightInventory.services.find((item) => item.name === name)?.config
        .POSTGRES_SOURCE_WRITES_FENCED;
      if (original !== undefined && original !== 'true' && original !== 'false')
        throw new Error(`Cannot safely restore the prior source-write gate for ${name}`);
      await run(
        `restore source-write gate ${name}`,
        original === undefined
          ? [
              'run',
              'services',
              'update',
              name,
              '--region',
              region,
              '--remove-env-vars=POSTGRES_SOURCE_WRITES_FENCED',
              '--quiet',
            ]
          : [
              'run',
              'services',
              'update',
              name,
              '--region',
              region,
              `--update-env-vars=^@^POSTGRES_SOURCE_WRITES_FENCED=${original}`,
              '--quiet',
            ],
      );
    }
  }
  // 4. Route traffic back to the exact pre-cutover revisions.
  const touched = new Set([...config.services.map((s) => s.name), ...config.appWriteGateServices]);
  for (const service of preflightInventory.services.filter((item) => touched.has(item.name))) {
    const revisions = service.traffic
      .filter((entry) => entry.percent > 0 && entry.revision)
      .map((entry) => `${entry.revision}=${entry.percent}`);
    if (revisions.length === 0) continue;
    await run(`restore traffic ${service.name}`, [
      'run',
      'services',
      'update-traffic',
      service.name,
      '--region',
      region,
      `--to-revisions=${revisions.join(',')}`,
    ]);
  }
  // 5. Resume the exact legacy dispatch resources recorded before quiesce.
  if (attempted('quiesce')) {
    for (const job of preflightInventory.schedulerJobs.filter((item) => item.state === 'ENABLED'))
      await run(`resume scheduler ${job.name}`, [
        'scheduler',
        'jobs',
        'resume',
        job.name,
        '--location',
        region,
      ]);
    for (const queue of preflightInventory.queues.filter((item) => item.state === 'RUNNING'))
      await run(`resume queue ${queue.name}`, [
        'tasks',
        'queues',
        'resume',
        queue.name,
        '--location',
        region,
      ]);
    // Evidence written before OIDC identities were recorded holds the bare endpoint.
    for (const [name, target] of Object.entries(pushEndpoints))
      await run(
        `restore push ${name}`,
        pushConfigArgs(name, typeof target === 'string' ? { endpoint: target } : target),
      );
  }
  const { inventory } = await captureInventory(config, deps);
  const restoredTraffic = preflightInventory.services
    .filter((item) => touched.has(item.name))
    .every((before) => {
      const after = inventory.services.find((item) => item.name === before.name);
      const serving = (value: ServiceInventory | undefined) =>
        canonicalJson(
          (value?.traffic ?? [])
            .filter((entry) => entry.percent > 0)
            .map((entry) => [entry.revision, entry.percent])
            .sort(),
        );
      return serving(before) === serving(after);
    });
  const restoredSourceWriteGates = config.appWriteGateServices.every((name) => {
    const before = preflightInventory.services.find((item) => item.name === name)?.config
      .POSTGRES_SOURCE_WRITES_FENCED;
    const after = inventory.services.find((item) => item.name === name)?.config
      .POSTGRES_SOURCE_WRITES_FENCED;
    return before === after;
  });
  const legacyDispatch =
    canonicalJson(dispatchIdle(preflightInventory)) === canonicalJson(dispatchIdle(inventory));
  const result = {
    kind: 'cutover-rollback',
    configSha256: rollbackConfigSha256,
    rollbackId,
    completedAt: deps.clock.now().toISOString(),
    stepsReached: STEPS.filter((step) => passed(step.name)).map((step) => step.name),
    actions,
    unfence,
    restoredTraffic,
    restoredSourceWriteGates,
    legacyDispatchRestored: legacyDispatch,
    // The Firestore target keeps its imported (and possibly activated) data. A new
    // cutover must import into a new empty database or installation.
    firestoreTargetRetained: config.firestoreDatabaseId,
    passed:
      restoredTraffic &&
      restoredSourceWriteGates &&
      legacyDispatch &&
      (unfence ? unfence.passed : true),
  };
  store.writeRecord(`rollback-${result.completedAt.replace(/[:.]/g, '')}.json`, result);
  store.writeRecord(`cutover-rollback-result-${rollbackId}.json`, {
    format: 'assistant-cutover-rollback',
    version: 1,
    rollbackId,
    configSha256: rollbackConfigSha256,
    status: result.passed ? 'completed' : 'verification-failed',
    completedAt: result.completedAt,
    passed: result.passed,
  });
  return result;
}

export async function readCutoverConfig(path: string): Promise<CutoverConfig> {
  return validateCutoverConfig(JSON.parse(await readFile(path, 'utf8')) as CutoverConfig);
}
