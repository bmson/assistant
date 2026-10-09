import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRetirementProofDeps } from './cutover.js';
import { EvidenceStore } from './cutover-evidence.js';
import type { NeonApi, NeonEndpoint, NeonOperation, SqlProbe } from './cutover-neon-fence.js';
import {
  type CutoverConfig,
  type CutoverDeps,
  captureRetirementProof,
  cutoverStatus,
  lastJsonObject,
  type PushTarget,
  rollbackCutover,
  runCutoverStep,
  STEP_NAMES,
  validateCutoverConfig,
} from './cutover-steps.js';
import type { AssetRecoveryStorage } from './workspace-asset-recovery.js';

const SHA = 'a'.repeat(40);
const PROJECT = 'bmson-assistant';
const BUCKET = `${PROJECT}-workspace`;
const SECRET_URL =
  'postgres://app:hunter2-secret@ep-main-1-pooler.us-west-2.aws.neon.tech/neondb?sslmode=require';
const AGENT = '11111111-2222-4333-8444-555555555555';
const PUSH_IDENTITY = {
  oidcServiceAccount: `assistant-gmail-push@${PROJECT}.iam.gserviceaccount.com`,
  oidcAudience: 'https://assistant-agent-x.a.run.app/webhooks/gmail',
};
const RECOVERY_PREFIX = `gs://${BUCKET}/workspace/assistant/migration-recovery/run/`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function baseConfig(dir: string): CutoverConfig {
  const manifestPath = join(dir, 'recovery-manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      destinationPrefix: RECOVERY_PREFIX,
      recovered: [
        {
          sourceRecordId: 'recovered-1',
          destination: {
            objectUri: `${RECOVERY_PREFIX}objects/recovered-1`,
            generation: '7',
            bytes: 9,
            sha256: digest('recovered'),
          },
          verified: true,
          createOnly: true,
        },
      ],
      missing: [{ sourceRecordId: 'missing-1', classification: 'no-byte-candidate' }],
    }),
  );
  return {
    gcp: { project: PROJECT, region: 'us-west1', firestoreLocation: 'us-west1' },
    installationId: 'assistant',
    workspaceBucket: BUCKET,
    releaseSha: SHA,
    sourceAgentId: AGENT,
    embedding: { provider: 'openrouter', model: 'embed', dimensions: 1536, revision: 'r1' },
    firestoreDatabaseId: 'assistant-production',
    neon: {
      projectId: 'proud-sun-123',
      branchId: 'br-main-1',
      endpointId: 'ep-main-1',
      snapshotBranchName: 'cutover-final-20260924',
    },
    fence: { samples: 2, intervalSeconds: 3600, allowAvailabilityStarts: false },
    sourceDatabaseSecret: 'database-url',
    exportDatabaseSecret: 'database-url-final-export',
    exportServiceAccount: `assistant-agent@${PROJECT}.iam.gserviceaccount.com`,
    appWriteGateServices: ['assistant-web', 'assistant-agent'],
    assets: {
      recoveryManifest: manifestPath,
      recoveryPrefix: RECOVERY_PREFIX,
      backupPrefix: `gs://${PROJECT}-cutover-backup/assets/final/`,
      restorePrefix: `gs://${PROJECT}-cutover-backup/assets/restore-final/`,
      expectedRecovered: 1,
      expectedUnresolved: 1,
    },
    firestoreBackup: {
      gcsPrefix: `gs://${BUCKET}/workspace/assistant/firestore-backups/final`,
      restoreDatabaseId: 'assistant-restore-final-20260924',
    },
    services: ['assistant-web', 'assistant-agent'].map((name) => ({
      name,
      image: `us-west1-docker.pkg.dev/${PROJECT}/assistant/${name}@sha256:${'b'.repeat(64)}`,
      env: { PERSISTENCE_DRIVER: 'firestore', FIRESTORE_DATABASE_ID: 'assistant-production' },
      secrets: { AUTH_SECRET: 'auth-secret:3' },
      ...(name === 'assistant-web'
        ? { health: { path: '/api/health', expectReleaseSha: true } }
        : { ready: { path: '/ready', authenticated: true, expectDatabase: 'firestore' } }),
    })),
    dispatcher: {
      schedulerJobs: ['assistant-sweep'],
      queues: [],
      pushSubscriptions: [
        {
          name: 'gmail-events-push',
          endpoint: 'https://assistant-agent-x.a.run.app/webhooks/gmail',
          oidcServiceAccount: PUSH_IDENTITY.oidcServiceAccount,
          oidcAudience: PUSH_IDENTITY.oidcAudience,
        },
      ],
      acceptLegacyTaskBacklog: false,
    },
  };
}

type EnvEntry = {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef: { name: string; key: string } };
};
type Service = {
  url: string;
  revision: number;
  traffic: Array<{ revisionName: string; percent: number }>;
  image: string;
  env: EnvEntry[];
};

function bundleFixture() {
  const record = (table: string, id: string, data: Record<string, unknown>) => ({
    table,
    collection: table,
    id,
    data,
    checksum: 'x',
  });
  return {
    manifest: {
      format: 'assistant-workspace-migration',
      formatVersion: 3,
      mode: 'export',
      source: {
        kind: 'postgresql',
        agentId: AGENT,
        scope: 'installation',
        snapshot: 's',
        exportedAt: '2026-09-24T12:00:00.000000Z',
      },
      target: {
        projectId: PROJECT,
        databaseId: 'assistant-production',
        installationId: 'assistant',
      },
      tables: { files: { collection: 'files', count: 2, checksum: 'c1' } },
      coverage: { complete: true, supportedTables: [], omittedTables: [] },
      recordCount: 3,
      bundleChecksum: 'bundle-checksum',
      unsupportedTables: [],
    },
    records: [
      record('files', 'present-1', {
        workspacePath: 'files/a.pdf',
        bytes: 7,
        sha256: null,
        taskId: null,
      }),
      // Written while the bytes were missing, so its recorded size is stale.
      record('files', 'recovered-1', {
        workspacePath: 'imports/b.zip',
        bytes: 0,
        sha256: null,
        taskId: null,
      }),
      record('files', 'missing-1', {
        workspacePath: 'traces/c.zip',
        bytes: 0,
        sha256: null,
        taskId: null,
      }),
    ],
  };
}

/** An in-memory model of the owner's project, Neon, GCS, and the job CLIs. */
function fakeWorld(options: { leaveDatabaseSecretOn?: string; restoreHashes?: string[] } = {}) {
  const restoreHashes = [...(options.restoreHashes ?? [])];
  const backupCalls: string[][] = [];
  let now = Date.parse('2026-09-24T08:00:00Z');
  const tick = (ms = 1000) => {
    now += ms;
  };
  const iso = () => new Date(now).toISOString();
  const calls: string[] = [];
  const services = new Map<string, Service>();
  for (const name of ['assistant-web', 'assistant-agent']) {
    services.set(name, {
      url: `https://${name}-x.a.run.app`,
      revision: 1,
      traffic: [{ revisionName: `${name}-00001`, percent: 100 }],
      image: `old-${name}`,
      env: [
        { name: 'PERSISTENCE_DRIVER', value: 'postgres' },
        // A value pinned on the service by an earlier release.
        { name: 'BUILD_SHA', value: 'stale-release' },
        {
          name: 'DATABASE_URL',
          valueFrom: { secretKeyRef: { name: 'database-url', key: 'latest' } },
        },
      ],
    });
  }
  services.set('assistant-web-firestore-rehearsal', {
    url: 'https://rehearsal-x.a.run.app',
    revision: 1,
    traffic: [{ revisionName: 'assistant-web-firestore-rehearsal-00001', percent: 100 }],
    image: 'rehearsal',
    env: [{ name: 'PERSISTENCE_DRIVER', value: 'firestore' }],
  });
  const jobs = new Map<string, { image: string; env: EnvEntry[] }>([
    [
      'assistant-migrate',
      {
        image: `us-west1-docker.pkg.dev/${PROJECT}/assistant/migrate:${SHA}`,
        env: [
          {
            name: 'DATABASE_URL',
            valueFrom: { secretKeyRef: { name: 'database-url', key: 'latest' } },
          },
        ],
      },
    ],
  ]);
  const scheduler = new Map([
    [
      'assistant-sweep',
      { state: 'ENABLED', uri: 'https://assistant-agent-x.a.run.app/internal/sweep' },
    ],
    [
      'assistant-canaries',
      { state: 'PAUSED', uri: 'https://assistant-agent-x.a.run.app/internal/canaries/run' },
    ],
  ]);
  const queues = new Map([['agent-steps', 'RUNNING']]);
  const subscriptions = new Map<string, PushTarget>([
    [
      'gmail-events-push',
      {
        endpoint: 'https://assistant-agent-x.a.run.app/webhooks/gmail?token=push-token-secret',
        ...PUSH_IDENTITY,
      },
    ],
  ]);
  const secrets = new Set(['database-url', 'auth-secret']);
  const databases = [
    {
      name: `projects/${PROJECT}/databases/assistant-production`,
      pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_ENABLED',
    },
  ];
  const executions: Array<{ job: string; name: string; created: string; summary: unknown }> = [];
  const loggedQueries = new Set<string>();
  const iamPolicy = {
    bindings: ['assistant-web', 'assistant-agent'].map((name) => ({
      role: 'roles/datastore.user',
      members: [`serviceAccount:${name}@${PROJECT}.iam.gserviceaccount.com`],
      condition: {
        expression: `resource.name == "projects/${PROJECT}/databases/assistant-production"`,
      },
    })),
  };
  const bundle = bundleFixture();
  const bundleBytes = Buffer.from(JSON.stringify(bundle));
  const snapshotUri = `gs://${BUCKET}/workspace/assistant/migration/snapshots/assistant-workspace-export-abc.json`;
  const importSummary = (mode: string) => ({
    mode,
    records: 3,
    derivedMetadata: 2,
    writes: 6,
    collections: { files: 2, importSources: 1 },
    verified: mode !== 'preview' ? true : undefined,
    snapshotUri,
    snapshotGeneration: '99',
    snapshotSha256: digest(bundleBytes.toString()),
    bundleChecksum: 'bundle-checksum',
  });

  const envEntries = (env: EnvEntry[]) => env;
  const describeService = (name: string) => {
    const service = services.get(name);
    if (!service) throw new Error(`no service ${name}`);
    return {
      metadata: { name },
      status: {
        url: service.url,
        latestReadyRevisionName: `${name}-0000${service.revision}`,
        traffic: service.traffic,
      },
      spec: {
        template: {
          spec: {
            serviceAccountName: `${name}@${PROJECT}.iam.gserviceaccount.com`,
            containers: [{ image: service.image, env: envEntries(service.env) }],
          },
        },
      },
    };
  };
  const setEnv = (service: Service, name: string, value?: string) => {
    service.env = service.env.filter((item) => item.name !== name);
    if (value !== undefined) service.env.push({ name, value });
  };
  const newRevision = (name: string) => {
    const service = services.get(name) as Service;
    service.revision++;
    service.traffic = [{ revisionName: `${name}-0000${service.revision}`, percent: 100 }];
  };

  const gcloud = {
    async json<T>(args: string[]): Promise<T> {
      const key = args.slice(0, 3).join(' ');
      calls.push(`json ${args.join(' ')}`);
      const value = (() => {
        if (key === 'auth list --filter=status:ACTIVE') return [{ account: 'owner@example.com' }];
        if (key === 'run services list') return [...services.keys()].map(describeService);
        if (key === 'run services describe') return describeService(args[3] as string);
        if (key === 'run jobs list' || key === 'run jobs describe') {
          const described = [...jobs.entries()]
            .filter(([name]) => key === 'run jobs list' || name === args[3])
            .map(([name, job]) => ({
              metadata: { name },
              spec: {
                template: {
                  spec: {
                    template: { spec: { containers: [{ image: job.image, env: job.env }] } },
                  },
                },
              },
            }));
          return key === 'run jobs list' ? described : described[0];
        }
        if (key === 'scheduler jobs list')
          return [...scheduler.entries()].map(([name, job]) => ({
            name: `projects/${PROJECT}/locations/us-west1/jobs/${name}`,
            state: job.state,
            schedule: '* * * * *',
            httpTarget: { uri: job.uri },
          }));
        if (key === 'tasks queues list')
          return [...queues.entries()].map(([name, state]) => ({
            name: `projects/p/locations/l/queues/${name}`,
            state,
          }));
        if (key === 'tasks list --queue') return [];
        if (key === 'pubsub subscriptions list')
          return [...subscriptions.entries()].map(([name, target]) => ({
            name: `projects/${PROJECT}/subscriptions/${name}`,
            topic: `projects/${PROJECT}/topics/gmail-events`,
            pushConfig: target.endpoint
              ? {
                  pushEndpoint: target.endpoint,
                  ...(target.oidcServiceAccount
                    ? {
                        oidcToken: {
                          serviceAccountEmail: target.oidcServiceAccount,
                          audience: target.oidcAudience,
                        },
                      }
                    : {}),
                }
              : {},
          }));
        if (key === 'secrets list')
          return [...secrets].map((name) => ({ name: `projects/1/secrets/${name}` }));
        if (key === 'firestore databases list') return databases;
        if (key.startsWith('projects get-iam-policy')) return iamPolicy;
        if (key === 'run jobs executions')
          return executions
            .filter((item) => item.job === args[5])
            .map((item) => ({
              metadata: { name: item.name, creationTimestamp: item.created },
              status: { succeededCount: 1 },
            }));
        if (key.startsWith('logging read')) {
          // Like Cloud Logging, an execution's entries are not readable on the
          // first query right after it completes.
          if (!loggedQueries.has(args[2] as string)) {
            loggedQueries.add(args[2] as string);
            return [];
          }
          return (
            executions
              .filter((item) => (args[2] as string).includes(`"${item.name}"`))
              // Like Cloud Logging: a single-line JSON write lands in jsonPayload,
              // anything else (here, pretty-printed JSON) in textPayload.
              .map((item) =>
                item.job === 'assistant-workspace-export'
                  ? { jsonPayload: item.summary }
                  : { textPayload: JSON.stringify(item.summary, null, 2) },
              )
          );
        }
        if (key === 'storage objects describe')
          return { generation: '99', size: String(bundleBytes.length) };
        throw new Error(`unexpected gcloud json ${args.join(' ')}`);
      })();
      return structuredClone(value) as T;
    },
    async run(args: string[], options: { stdin?: string } = {}) {
      calls.push(`run ${args.join(' ')}`);
      tick();
      const key = args.slice(0, 3).join(' ');
      if (key === 'secrets versions access') return `${SECRET_URL}\n`;
      if (key === 'scheduler jobs pause' || key === 'scheduler jobs resume') {
        const job = scheduler.get(args[3] as string);
        if (job) job.state = args[2] === 'pause' ? 'PAUSED' : 'ENABLED';
        return '';
      }
      if (key === 'tasks queues pause' || key === 'tasks queues resume') {
        queues.set(args[3] as string, args[2] === 'pause' ? 'PAUSED' : 'RUNNING');
        return '';
      }
      if (key === 'pubsub subscriptions modify-push-config') {
        // Like Pub/Sub, a push config without an auth flag carries no OIDC token.
        const flag = (prefix: string) =>
          args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
        const endpoint = flag('--push-endpoint=') ?? '';
        const oidcServiceAccount = flag('--push-auth-service-account=');
        const oidcAudience = flag('--push-auth-token-audience=');
        subscriptions.set(args[3] as string, {
          endpoint,
          ...(endpoint && oidcServiceAccount ? { oidcServiceAccount } : {}),
          ...(endpoint && oidcAudience ? { oidcAudience } : {}),
        });
        return '';
      }
      if (key === 'run services update') {
        const name = args[3] as string;
        const service = services.get(name) as Service;
        for (const arg of args) {
          if (arg === 'POSTGRES_SOURCE_WRITES_FENCED=true')
            setEnv(service, 'POSTGRES_SOURCE_WRITES_FENCED', 'true');
          if (arg.startsWith('--update-env-vars=^@^'))
            for (const pair of arg.slice('--update-env-vars=^@^'.length).split('@')) {
              const [envName, ...rest] = pair.split('=');
              setEnv(service, envName as string, rest.join('='));
            }
          if (arg.startsWith('--remove-env-vars=') || arg.startsWith('--remove-secrets=')) {
            const names = arg.slice(arg.indexOf('=') + 1).split(',');
            service.env = service.env.filter((item) => !names.includes(item.name));
          }
          if (arg.startsWith('--update-secrets='))
            for (const pair of arg.slice('--update-secrets='.length).split(',')) {
              const [envName, ref] = pair.split('=');
              const [secret, version] = (ref as string).split(':');
              service.env.push({
                name: envName as string,
                valueFrom: { secretKeyRef: { name: secret as string, key: version as string } },
              });
            }
        }
        const imageIndex = args.indexOf('--image');
        if (imageIndex > 0) service.image = args[imageIndex + 1] as string;
        newRevision(name);
        return '';
      }
      if (key === 'run services update-traffic') {
        const service = services.get(args[3] as string) as Service;
        const to = args.find((arg) => arg.startsWith('--to-revisions='));
        if (to) {
          service.traffic = to
            .slice('--to-revisions='.length)
            .split(',')
            .map((pair) => {
              const [revisionName, percent] = pair.split('=');
              return { revisionName: revisionName as string, percent: Number(percent) };
            });
        }
        return '';
      }
      if (key.startsWith('secrets create')) {
        secrets.add(args[2] as string);
        return '';
      }
      if (key.startsWith('secrets versions add')) {
        expect(options.stdin).toContain('ep-child-1.us-west-2.aws.neon.tech');
        return `projects/1/secrets/${args[3]}/versions/1\n`;
      }
      if (key.startsWith('secrets add-iam-policy-binding')) return '';
      if (key === 'storage cp gs://' || args[0] === 'storage') {
        writeFileSync(args[3] as string, bundleBytes);
        return '';
      }
      if (key.startsWith('firestore databases delete')) return '';
      if (key === 'auth print-identity-token') return 'identity-token\n';
      throw new Error(`unexpected gcloud run ${args.join(' ')}`);
    },
  };

  let execution = 0;
  const commands: CutoverDeps['commands'] = async (command, args, env) => {
    calls.push(`cmd ${command} ${args.join(' ')}`);
    tick(60_000);
    const script = args[0];
    if (script === 'infra/gcp/workspace-export.sh') {
      expect(env.EXPORT_DATABASE_SECRET).toBe('database-url-final-export');
      jobs.set('assistant-workspace-export', {
        image: 'migrate',
        env: [
          {
            name: 'DATABASE_URL',
            valueFrom: {
              secretKeyRef: { name: env.EXPORT_DATABASE_SECRET as string, key: 'latest' },
            },
          },
        ],
      });
      executions.push({
        job: 'assistant-workspace-export',
        name: `assistant-workspace-export-${++execution}`,
        created: iso(),
        summary: {
          uri: snapshotUri,
          records: 3,
          bundleChecksum: 'bundle-checksum',
          byteLength: bundleBytes.length,
          sha256: digest(bundleBytes.toString()),
          generation: '99',
        },
      });
      return { code: 0, stdout: '' };
    }
    if (script === 'infra/gcp/workspace-import.sh') {
      executions.push({
        job: 'assistant-workspace-import',
        name: `assistant-workspace-import-${++execution}`,
        created: iso(),
        summary: importSummary(env.MIGRATION_IMPORT_MODE as string),
      });
      return { code: 0, stdout: 'Running\n' };
    }
    // Like the real audit: exit 2 for the manifest's missing object and the
    // recovered object's stale size.
    if (args[0] === 'workspace:assets-audit')
      return {
        code: 2,
        stdout: JSON.stringify({
          references: 3,
          missingObjects: 1,
          digestMismatches: 0,
          sizeMismatches: 1,
        }),
      };
    if (args[0] === 'workspace:assets-recover')
      return {
        code: 0,
        stdout: JSON.stringify({
          plannedCopies: 0,
          alreadyPresent: 1,
          recoverableReferences: 1,
          unresolvedReferences: 1,
        }),
      };
    if (args.includes('scripts/firestore-managed-backup.ts')) {
      backupCalls.push(args);
      if (args.includes('--backup')) {
        const manifest = args[args.indexOf('--manifest') + 1] as string;
        writeFileSync(manifest, '{"manifest":true}');
        return {
          code: 0,
          stdout: `log line\n${JSON.stringify({ mode: 'backup', completed: true, documents: 6, canonicalHash: 'h' }, null, 2)}\n`,
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          mode: 'restore',
          completed: true,
          documents: 6,
          canonicalHash: restoreHashes.shift() ?? 'h',
        }),
      };
    }
    if (args[0] === 'workspace:import' && args[1] === '--activate')
      return {
        code: 0,
        stdout: JSON.stringify({
          activated: true,
          alreadyActivated: false,
          bundleChecksum: 'bundle-checksum',
        }),
      };
    throw new Error(`unexpected command ${command} ${args.join(' ')}`);
  };

  // Neon: one read-write endpoint that the fence disables; branches get read-only computes.
  const endpoint: NeonEndpoint = {
    id: 'ep-main-1',
    branch_id: 'br-main-1',
    project_id: 'proud-sun-123',
    host: 'ep-main-1.us-west-2.aws.neon.tech',
    type: 'read_write',
    current_state: 'active',
    disabled: false,
  };
  const operations: NeonOperation[] = [];
  let branchCount = 0;
  const neon: NeonApi = {
    getEndpoint: async () => ({ ...endpoint }),
    setEndpointDisabled: async (_p, _e, disabled) => {
      endpoint.disabled = disabled;
      endpoint.current_state = disabled ? 'idle' : 'active';
      const op = {
        id: `op-${operations.length + 1}`,
        action: disabled ? 'suspend_compute' : 'start_compute',
        status: 'finished',
        endpoint_id: endpoint.id,
        created_at: iso(),
      };
      operations.push(op);
      return { endpoint: { ...endpoint }, operations: [op] };
    },
    getOperation: async (_p, id) => operations.find((op) => op.id === id) as NeonOperation,
    listOperations: async () => operations,
    createBranch: async (_p, request) => {
      branchCount++;
      return {
        branch: { id: `br-child-${branchCount}`, name: request.name, parent_lsn: '0/AB' },
        endpoints: [
          {
            ...endpoint,
            id: `ep-child-${branchCount}`,
            branch_id: `br-child-${branchCount}`,
            host: `ep-child-${branchCount}.us-west-2.aws.neon.tech`,
            type: 'read_only',
            disabled: false,
            current_state: 'active',
          },
        ],
        operations: [],
      };
    },
    getBranch: async (_p, id) => ({ id, name: id }),
    deleteBranch: async () => ({ operations: [] }),
  };
  const probe: SqlProbe = {
    tryConnect: async () =>
      endpoint.disabled
        ? { connected: false, refusedByServer: true, code: 'XX000' }
        : { connected: true, refusedByServer: false, code: 'CONNECTED' },
    readOnlyProof: async () => ({
      readable: true,
      inRecovery: true,
      readWriteRejectedCode: '0A000',
      xidRejectedCode: '25006',
      replayLsn: '0/AB',
    }),
    sessionInventory: async () => ({
      total: 3,
      withTransactionId: 1,
      byRole: { app: 3 },
      byApplication: { '(none)': 3 },
      byState: { active: 1, idle: 2 },
    }),
    primaryWriteState: async () => ({ inRecovery: false, transactionReadOnly: 'off' }),
  };

  // GCS: live objects for the present and recovered references.
  const objects = new Map<string, { generation: string; size: number; digest: string }>([
    [
      `${BUCKET}/workspace/assistant/files/a.pdf`,
      { generation: '1', size: 7, digest: digest('present') },
    ],
    [
      `${BUCKET}/workspace/assistant/imports/b.zip`,
      { generation: '2', size: 9, digest: digest('recovered') },
    ],
  ]);
  const storage: AssetRecoveryStorage = {
    stat: async (ref) => {
      const object = objects.get(`${ref.bucket}/${ref.name}`);
      return object ? { generation: object.generation, size: object.size } : null;
    },
    sha256: async (ref) => objects.get(`${ref.bucket}/${ref.name}`)?.digest ?? '',
    copyCreateOnly: async (source, destination) => {
      const key = `${destination.bucket}/${destination.name}`;
      if (objects.has(key)) throw new Error('exists');
      const from = objects.get(`${source.bucket}/${source.name}`);
      if (!from) throw new Error('missing source');
      objects.set(key, { ...from, generation: '50' });
      return '50';
    },
  };

  const deps: CutoverDeps = {
    gcloud,
    commands,
    neon,
    probe,
    clock: { now: () => new Date(now), sleep: async (ms) => tick(ms) },
    storage: async () => storage,
    http: async (url, bearer) => {
      calls.push(`http ${url}`);
      if (url.endsWith('/api/health')) return { status: 200, body: { ok: true, sha: SHA } };
      if (url.endsWith('/ready'))
        return bearer
          ? { status: 200, body: { ready: true, database: 'firestore' } }
          : { status: 403, body: null };
      return { status: 404, body: null };
    },
    readFile: (path) => readFile(path),
  };
  if (options.leaveDatabaseSecretOn) {
    services.set(options.leaveDatabaseSecretOn, {
      url: 'https://legacy-x.a.run.app',
      revision: 1,
      traffic: [{ revisionName: `${options.leaveDatabaseSecretOn}-00001`, percent: 100 }],
      image: 'legacy',
      env: [
        {
          name: 'DATABASE_URL',
          valueFrom: { secretKeyRef: { name: 'database-url', key: 'latest' } },
        },
      ],
    });
  }
  return {
    deps,
    calls,
    services,
    scheduler,
    queues,
    subscriptions,
    endpoint,
    objects,
    iamPolicy,
    backupCalls,
  };
}

function setup(options: Parameters<typeof fakeWorld>[0] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cutover-test-'));
  const config = baseConfig(dir);
  const store = new EvidenceStore(join(dir, 'evidence'));
  return { dir, config, store, world: fakeWorld(options) };
}

async function runAll(
  config: CutoverConfig,
  deps: CutoverDeps,
  store: EvidenceStore,
  until: (typeof STEP_NAMES)[number] = 'live-verify',
) {
  for (const step of STEP_NAMES) {
    const evidence = await runCutoverStep(step, config, deps, store, { confirm: step });
    if (evidence.status !== 'passed')
      throw new Error(`${step} failed: ${evidence.error ?? JSON.stringify(evidence.result)}`);
    if (step === until) break;
  }
}

type CrashWorkerMode = 'kill-after-effect' | 'evidence-write-eio' | 'retry';
type CrashWorkerInput = {
  config: CutoverConfig;
  evidenceDirectory: string;
  statePath: string;
  mode: CrashWorkerMode;
};
type CrashSchedulerState = {
  scheduler: 'ENABLED' | 'PAUSED';
  effectCount: number;
  pushEndpoint: string;
};

async function setupCrashRecovery(mode: CrashWorkerMode = 'kill-after-effect') {
  const dir = mkdtempSync(join(tmpdir(), 'cutover-crash-test-'));
  const config = baseConfig(dir);
  config.appWriteGateServices = [];
  const evidenceDirectory = join(dir, 'evidence');
  const store = new EvidenceStore(evidenceDirectory);
  const world = fakeWorld();
  const preflight = await runCutoverStep('preflight', config, world.deps, store);
  expect(preflight.status).toBe('passed');
  const statePath = join(dir, 'fake-scheduler.json');
  writeFileSync(
    statePath,
    `${JSON.stringify({
      scheduler: 'ENABLED',
      effectCount: 0,
      pushEndpoint: config.dispatcher.pushSubscriptions[0]?.endpoint ?? '',
    } satisfies CrashSchedulerState)}\n`,
    { mode: 0o600 },
  );
  const inputPath = join(dir, 'worker-input.json');
  writeFileSync(
    inputPath,
    `${JSON.stringify({ config, evidenceDirectory, statePath, mode } satisfies CrashWorkerInput)}\n`,
    { mode: 0o600 },
  );
  return { config, dir, evidenceDirectory, inputPath, statePath, world };
}

function runCrashWorker(inputPath: string, mode?: CrashWorkerMode) {
  if (mode) {
    const current = JSON.parse(readFileSync(inputPath, 'utf8')) as CrashWorkerInput;
    writeFileSync(inputPath, `${JSON.stringify({ ...current, mode })}\n`, { mode: 0o600 });
  }
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      join(process.cwd(), 'scripts/cutover-crash-worker.test-fixture.ts'),
      inputPath,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 20_000,
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
    },
  );
}

function readCrashState(path: string): CrashSchedulerState {
  return JSON.parse(readFileSync(path, 'utf8')) as CrashSchedulerState;
}

describe('cutover configuration', () => {
  it('rejects database settings in the target composition and unsafe identities', () => {
    const { config } = setup();
    expect(validateCutoverConfig(config)).toBe(config);
    const withDatabase = structuredClone(config);
    (withDatabase.services[0] as CutoverConfig['services'][number]).env.DATABASE_URL = 'x';
    expect(() => validateCutoverConfig(withDatabase)).toThrow('database setting');
    const withSecret = structuredClone(config);
    (withSecret.services[1] as CutoverConfig['services'][number]).secrets.DB =
      'database-url:latest';
    expect(() => validateCutoverConfig(withSecret)).toThrow('references the database');
    const sameSecret = { ...structuredClone(config), exportDatabaseSecret: 'database-url' };
    expect(() => validateCutoverConfig(sameSecret)).toThrow('exportDatabaseSecret');
    const restoreTarget = {
      ...structuredClone(config),
      firestoreDatabaseId: 'assistant-restore-x',
    };
    expect(() => validateCutoverConfig(restoreTarget)).toThrow('restore rehearsal');
  });

  it('parses the last JSON object printed by a CLI', () => {
    expect(lastJsonObject('noise\n{"a":1}\nmore\n{\n  "b": 2\n}\n')).toEqual({ b: 2 });
    expect(() => lastJsonObject('no json')).toThrow('JSON');
  });
});

describe('retirement proof dependencies', () => {
  it('refuses mutations and broader database queries outside the minimal fence probe', async () => {
    vi.stubEnv('NEON_API_KEY', 'test-only-placeholder');
    const { config } = setup();
    try {
      const deps = createRetirementProofDeps(config);
      await expect(
        deps.gcloud.run(['scheduler', 'jobs', 'resume', 'assistant-sweep']),
      ).rejects.toThrow('Retirement proof dependencies refuse mutating operations');
      await expect(
        deps.neon.deleteBranch(config.neon.projectId, config.neon.branchId),
      ).rejects.toThrow('Retirement proof dependencies refuse mutating operations');
      await expect(deps.probe.readOnlyProof('postgres://not-used')).rejects.toThrow(
        'Retirement proof dependencies refuse mutating operations',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('cutover orchestration', () => {
  it('runs every step with evidence, proving the fence, parity, and a PostgreSQL-free runtime', async () => {
    const { config, store, world } = setup();
    await runAll(config, world.deps, store);

    const status = cutoverStatus(config, store);
    expect(status.steps.every((step) => step.status === 'passed')).toBe(true);
    expect(status.chain).toEqual({ ok: true, problems: [] });

    // Provider fence and final export ordering.
    expect(world.endpoint.disabled).toBe(true);
    const drain = store.read<{ drainedAt: string }>(4, 'drain-proof')?.result;
    const exported = store.read<{ snapshot: { exportedAt: string } }>(6, 'final-export')?.result;
    expect(drain?.drainedAt).toBeDefined();

    // Exactly the configured dispatch path is active and targets the switched agent.
    expect(world.scheduler.get('assistant-sweep')?.state).toBe('ENABLED');
    expect(world.scheduler.get('assistant-canaries')?.state).toBe('PAUSED');
    expect(world.queues.get('agent-steps')).toBe('PAUSED');
    // Re-pointing the push subscription keeps the OIDC identity its webhook verifies.
    expect(world.subscriptions.get('gmail-events-push')).toEqual({
      endpoint: 'https://assistant-agent-x.a.run.app/webhooks/gmail',
      ...PUSH_IDENTITY,
    });

    // The switched services carry no database env or secret and run the release image.
    for (const name of ['assistant-web', 'assistant-agent']) {
      const env = world.services.get(name)?.env ?? [];
      expect(env.some((item) => item.name === 'DATABASE_URL')).toBe(false);
      expect(env.some((item) => item.name === 'POSTGRES_SOURCE_WRITES_FENCED')).toBe(false);
      expect(env.find((item) => item.name === 'PERSISTENCE_DRIVER')?.value).toBe('firestore');
      // The release SHA comes from the image; an env value would pin it for later releases.
      expect(env.some((item) => item.name === 'BUILD_SHA')).toBe(false);
    }
    const live = store.read<{ jobDatabaseDependencies: Array<{ name: string }> }>(
      15,
      'live-verify',
    );
    expect(live?.result.jobDatabaseDependencies.map((item) => item.name)).toEqual(
      expect.arrayContaining(['assistant-migrate', 'assistant-workspace-export']),
    );

    // Assets: present and recovered objects backed up and restored; one owner decision remains.
    const assets = store.read<{ backedUp: number; restored: number; unresolved: unknown[] }>(
      10,
      'assets',
    );
    expect(assets?.result).toMatchObject({ backedUp: 2, restored: 2 });
    expect(assets?.result.unresolved).toEqual([
      {
        sourceRecordId: 'missing-1',
        classification: 'no-byte-candidate',
        decision: 'owner-accepted-loss-required',
      },
    ]);
    expect(exported).toBeDefined();

    // Nothing in the evidence directory contains the database password or push token.
    for (const name of readdirSync(store.directory).filter((file) => file.endsWith('.json'))) {
      const text = readFileSync(join(store.directory, name), 'utf8');
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('push-token-secret');
      expect(statSync(join(store.directory, name)).mode & 0o077).toBe(0);
    }
  });

  it('captures current retirement proof and fails if traffic drifts off the Firestore revision', async () => {
    const { config, store, world } = setup();
    await runAll(config, world.deps, store);

    const healthy = await captureRetirementProof(config, world.deps, store);
    expect(healthy.checks).toEqual({
      liveVerifyPassed: true,
      healthAndReadyConfigured: true,
      healthAndReadyPassed: true,
      providerFencePassed: true,
      dispatcherMatches: true,
    });
    expect(healthy.capturedAt).toBe(healthy.inventory.capturedAt);

    const service = world.services.get('assistant-web');
    if (!service) throw new Error('expected assistant-web in fake inventory');
    service.traffic = [{ revisionName: 'assistant-web-old', percent: 100 }];
    const drifted = await captureRetirementProof(config, world.deps, store);
    expect(drifted.checks.liveVerifyPassed).toBe(false);
  });

  it('refuses a push subscription whose configured OIDC identity differs from the live one', async () => {
    const { config, store, world } = setup();
    const [push] = config.dispatcher.pushSubscriptions;
    config.dispatcher.pushSubscriptions = [
      { name: push?.name as string, endpoint: push?.endpoint as string },
    ];
    const preflight = await runCutoverStep('preflight', config, world.deps, store);
    expect(preflight.status).toBe('failed');
    expect(JSON.stringify(preflight)).toContain(
      'push subscription gmail-events-push keeps its live OIDC identity',
    );
    expect(JSON.stringify(preflight)).not.toContain('assistant-gmail-push@');
  });

  it('fails assets on a size mismatch that no recovery hash explains', async () => {
    const { config, store, world } = setup();
    await runAll(config, world.deps, store, 'verify-import');
    const live = world.objects.get(`${BUCKET}/workspace/assistant/files/a.pdf`);
    if (live) live.size = 8;
    const assets = await runCutoverStep('assets', config, world.deps, store, { confirm: 'assets' });
    expect(assets.status).toBe('failed');
    expect(JSON.stringify(assets.result)).toContain('"sizeMismatches":["present-1"]');
  });

  it('refuses a preflight when a runtime identity cannot use the target database', async () => {
    const { config, store, world } = setup();
    // Access to a rehearsal database does not count for the production target.
    const agent = world.iamPolicy.bindings[1];
    if (agent?.condition)
      agent.condition.expression = `resource.name == "projects/${PROJECT}/databases/assistant-rehearsal"`;
    const preflight = await runCutoverStep('preflight', config, world.deps, store);
    expect(preflight.status).toBe('failed');
    const failed = (preflight.result as { checks: Array<{ name: string; ok: boolean }> }).checks
      .filter((item) => !item.ok)
      .map((item) => item.name);
    expect(failed).toEqual([
      'service assistant-agent runtime identity can use the target Firestore database',
    ]);
  });

  it('requires a per-step confirmation before any production change', async () => {
    const { config, store, world } = setup();
    await runCutoverStep('preflight', config, world.deps, store);
    const before = world.calls.filter((call) => call.startsWith('run')).length;
    await expect(runCutoverStep('quiesce', config, world.deps, store)).rejects.toThrow(
      '--confirm quiesce',
    );
    await expect(
      runCutoverStep('quiesce', config, world.deps, store, { confirm: 'fence' }),
    ).rejects.toThrow('--confirm quiesce');
    expect(world.calls.filter((call) => call.startsWith('run')).length).toBe(before);
    expect(store.read(2, 'quiesce')).toBeNull();
  });

  it('enforces order, resumes passed steps, and refuses a changed configuration', async () => {
    const { config, store, world } = setup();
    await expect(
      runCutoverStep('fence', config, world.deps, store, { confirm: 'fence' }),
    ).rejects.toThrow('preflight must pass');
    const first = await runCutoverStep('preflight', config, world.deps, store);
    const calls = world.calls.length;
    const again = await runCutoverStep('preflight', config, world.deps, store);
    expect(again).toEqual(first);
    expect(world.calls.length).toBe(calls);
    const changed = { ...config, releaseSha: 'c'.repeat(40) };
    await expect(runCutoverStep('preflight', changed, world.deps, store)).rejects.toThrow(
      'different configuration',
    );
  });

  it('records a failed step, keeps it, and lets it be retried', async () => {
    const { config, store, world } = setup();
    await runAll(config, world.deps, store, 'quiesce');
    // The endpoint stays reachable: the first drain proof must fail, not pass silently.
    await runCutoverStep('fence', config, world.deps, store, { confirm: 'fence' });
    world.endpoint.disabled = false;
    const failed = await runCutoverStep('drain-proof', config, world.deps, store);
    expect(failed.status).toBe('failed');
    world.endpoint.disabled = true;
    world.endpoint.current_state = 'idle';
    const retried = await runCutoverStep('drain-proof', config, world.deps, store);
    expect(retried.status).toBe('passed');
    expect(
      readdirSync(store.directory).some((name) => name.startsWith('04-drain-proof.failed-')),
    ).toBe(true);
  });

  it('fails live verification while any serving template still references the database', async () => {
    const { config, store, world } = setup({ leaveDatabaseSecretOn: 'assistant-legacy-worker' });
    await runAll(config, world.deps, store, 'dispatcher');
    const live = await runCutoverStep('live-verify', config, world.deps, store);
    expect(live.status).toBe('failed');
    expect(
      (live.result as { servingDatabaseDependencies: Array<{ name: string }> })
        .servingDatabaseDependencies,
    ).toEqual([expect.objectContaining({ name: 'assistant-legacy-worker' })]);
  });
});

describe('cutover retries', () => {
  it('retries a failed Firestore backup with a fresh prefix, manifest, and restore database', async () => {
    const { config, store, world } = setup({ restoreHashes: ['different'] });
    await runAll(config, world.deps, store, 'assets');
    const failed = await runCutoverStep('firestore-backup', config, world.deps, store, {
      confirm: 'firestore-backup',
    });
    expect(failed.status).toBe('failed');
    // A parity failure never deletes the restore database it could not verify.
    expect(world.calls.some((call) => call.includes('databases delete'))).toBe(false);
    const retried = await runCutoverStep('firestore-backup', config, world.deps, store, {
      confirm: 'firestore-backup',
    });
    expect(retried.status).toBe('passed');
    const [, , retryBackup, retryRestore] = world.backupCalls;
    expect(retryBackup).toContain(`${config.firestoreBackup.gcsPrefix}-r2`);
    expect(retryRestore).toContain(`${config.firestoreBackup.restoreDatabaseId}-r2`);
    expect(world.calls).toContain(
      `run firestore databases delete --database=${config.firestoreBackup.restoreDatabaseId}-r2 --quiet`,
    );
  });

  it('does not re-pause resources already paused by a partial quiesce', async () => {
    const { config, store, world } = setup();
    await runCutoverStep('preflight', config, world.deps, store);
    world.scheduler.set('assistant-sweep', {
      state: 'PAUSED',
      uri: 'https://assistant-agent-x.a.run.app/internal/sweep',
    });
    await runCutoverStep('quiesce', config, world.deps, store, { confirm: 'quiesce' });
    expect(world.calls.some((call) => call.startsWith('run scheduler jobs pause'))).toBe(false);
    // Rollback still restores the preflight state, which had the job enabled.
    await rollbackCutover(config, world.deps, store, { confirm: 'rollback' });
    expect(world.scheduler.get('assistant-sweep')?.state).toBe('ENABLED');
  });

  it('journals a mutating intent before a lost response and rolls back from that intent', async () => {
    const { config, store, world } = setup();
    await runCutoverStep('preflight', config, world.deps, store);
    const originalRun = world.deps.gcloud.run.bind(world.deps.gcloud);
    world.deps.gcloud.run = async (args, options) => {
      const response = await originalRun(args, options);
      if (args[0] === 'scheduler' && args[1] === 'jobs' && args[2] === 'pause')
        throw new Error('connection lost after the remote mutation');
      return response;
    };

    const failed = await runCutoverStep('quiesce', config, world.deps, store, {
      confirm: 'quiesce',
    });
    expect(failed.status).toBe('failed');
    expect(world.scheduler.get('assistant-sweep')?.state).toBe('PAUSED');
    expect(store.records('cutover-intent-')).toHaveLength(1);
    const callsBeforeRetry = world.calls.length;
    await expect(
      runCutoverStep('quiesce', config, world.deps, store, { confirm: 'quiesce' }),
    ).rejects.toThrow('unresolved durable intent');
    expect(world.calls).toHaveLength(callsBeforeRetry);

    world.deps.gcloud.run = originalRun;
    const rolledBack = await rollbackCutover(config, world.deps, store, { confirm: 'rollback' });
    expect(rolledBack.passed).toBe(true);
    expect(rolledBack.restoredSourceWriteGates).toBe(true);
    expect(world.scheduler.get('assistant-sweep')?.state).toBe('ENABLED');
    expect(store.records('cutover-rollback-action-').length).toBeGreaterThan(0);
  });

  it('refuses a second effect after a process is killed between mutation and evidence', async () => {
    const fixture = await setupCrashRecovery();
    const child = runCrashWorker(fixture.inputPath);

    expect(child.signal).toBe('SIGKILL');
    const afterCrash = readCrashState(fixture.statePath);
    expect(afterCrash).toMatchObject({ scheduler: 'PAUSED', effectCount: 1 });
    const reopened = new EvidenceStore(fixture.evidenceDirectory);
    expect(reopened.records('cutover-intent-')).toHaveLength(1);
    expect(reopened.read(1, 'quiesce')).toBeNull();

    const retry = runCrashWorker(fixture.inputPath, 'retry');
    expect(retry.status).toBe(43);
    expect(retry.stderr).toContain('unresolved durable intent');
    expect(readCrashState(fixture.statePath)).toEqual(afterCrash);
  });

  it('keeps a successful effect fenced when writing its step evidence fails with EIO', async () => {
    const fixture = await setupCrashRecovery();
    const child = runCrashWorker(fixture.inputPath, 'evidence-write-eio');

    expect(child.status).toBe(42);
    expect(child.stderr).toContain('simulated evidence-store EIO');
    const afterWriteFailure = readCrashState(fixture.statePath);
    expect(afterWriteFailure).toMatchObject({
      scheduler: 'PAUSED',
      effectCount: 2,
      pushEndpoint: '',
    });
    const reopened = new EvidenceStore(fixture.evidenceDirectory);
    expect(reopened.records('cutover-intent-')).toHaveLength(1);
    expect(reopened.read(1, 'quiesce')).toBeNull();

    const retry = runCrashWorker(fixture.inputPath, 'retry');
    expect(retry.status).toBe(43);
    expect(retry.stderr).toContain('unresolved durable intent');
    expect(readCrashState(fixture.statePath)).toEqual(afterWriteFailure);
  });
});

describe('cutover rollback', () => {
  it('unfences Neon, restores prior traffic and legacy dispatch before any Firestore serving', async () => {
    const { config, store, world } = setup();
    await runAll(config, world.deps, store, 'import');
    await expect(rollbackCutover(config, world.deps, store, {})).rejects.toThrow(
      '--confirm rollback',
    );
    const result = await rollbackCutover(config, world.deps, store, { confirm: 'rollback' });
    expect(result.passed).toBe(true);
    expect(world.endpoint.disabled).toBe(false);
    expect(world.scheduler.get('assistant-sweep')?.state).toBe('ENABLED');
    expect(world.queues.get('agent-steps')).toBe('RUNNING');
    expect(world.subscriptions.get('gmail-events-push')).toEqual({
      endpoint: 'https://assistant-agent-x.a.run.app/webhooks/gmail?token=push-token-secret',
      ...PUSH_IDENTITY,
    });
    expect(world.services.get('assistant-agent')?.traffic).toEqual([
      { revisionName: 'assistant-agent-00001', percent: 100 },
    ]);
    const record = readdirSync(store.directory).find((name) => name.startsWith('rollback-'));
    expect(record).toBeDefined();
    expect(readFileSync(join(store.directory, record as string), 'utf8')).not.toContain('token');
  });

  it('requires accepting Firestore divergence after production switched', async () => {
    const { config, store, world } = setup();
    await runAll(config, world.deps, store, 'switch-services');
    await expect(
      rollbackCutover(config, world.deps, store, { confirm: 'rollback' }),
    ).rejects.toThrow('accept-firestore-divergence');
    const result = await rollbackCutover(config, world.deps, store, {
      confirm: 'rollback',
      acceptFirestoreDivergence: true,
    });
    expect(result.passed).toBe(true);
    expect(world.services.get('assistant-web')?.traffic).toEqual([
      { revisionName: 'assistant-web-00001', percent: 100 },
    ]);
  });

  it('rejects a changed config and edited rollback material before any cloud read', async () => {
    const { config, store, world } = setup();
    await runAll(config, world.deps, store, 'quiesce');
    const callsBefore = world.calls.length;
    const changed = structuredClone(config);
    changed.neon.snapshotBranchName = 'br-other-rehearsal';
    await expect(
      rollbackCutover(changed, world.deps, store, { confirm: 'rollback' }),
    ).rejects.toThrow('different configuration');
    expect(world.calls).toHaveLength(callsBefore);

    writeFileSync(store.privatePath('push-endpoints.json'), '{}\n');
    await expect(
      rollbackCutover(config, world.deps, store, { confirm: 'rollback' }),
    ).rejects.toThrow('does not match the preflight evidence');
    expect(world.calls).toHaveLength(callsBefore);
  });

  it('rejects a broken evidence chain before the first rollback mutation', async () => {
    const { config, store, world } = setup();
    await runAll(config, world.deps, store, 'quiesce');
    const preflight = store.read(1, 'preflight');
    expect(preflight).not.toBeNull();
    writeFileSync(
      store.path(1, 'preflight'),
      `${JSON.stringify({ ...preflight, result: { edited: true } })}\n`,
    );
    const callsBefore = world.calls.length;

    await expect(
      rollbackCutover(config, world.deps, store, { confirm: 'rollback' }),
    ).rejects.toThrow('previous evidence hash does not match');
    expect(world.calls).toHaveLength(callsBefore);
  });
});
