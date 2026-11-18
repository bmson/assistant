/** Read-only native writer inventory. The transport and cryptographic verifier are trusted code dependencies. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { canonicalEstimatedCostJson } from '@assistant/persistence';
import {
  type BootstrapReceipt,
  bootstrapDigest,
  reviewedBootstrap,
  verifyCurrentSnapshot,
} from './owner-release-current-snapshot.js';

const project = 'bmson-assistant',
  location = 'us-west1';
const root = `projects/${project}/locations/${location}`;
const roles = ['agent', 'web', 'browser', 'code', 'processor'] as const;
const workers = ['browser', 'code', 'processor'] as const;
type Role = (typeof roles)[number];
type Obj = Record<string, unknown>;
export type BaselineReadJson = (url: string) => Promise<unknown>;
/** Implementations MUST cryptographically verify the exact bundle, subject, issuer, identity and source. */
export type VerifyBaselineImageSignature = (input: {
  role: Role;
  image: string;
  source: string;
  bundle?: Uint8Array;
  certificateIdentity: string;
  certificateIssuer: string;
}) => Promise<void>;
/** The protected caller supplies a reviewed, pinned Cosign executable and isolated registry
 * credential environment. This runs Cosign itself; exit status or a supplied digest alone is
 * never accepted as image signature evidence. */
export function createBaselineCosignRegistryVerifier(input: {
  executable: string;
  executableSha256: string;
  environment: NodeJS.ProcessEnv;
}): VerifyBaselineImageSignature {
  requireThat(isAbsolute(input.executable) && /^[a-f0-9]{64}$/.test(input.executableSha256));
  const stat = lstatSync(input.executable);
  requireThat(
    stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 256 * 1024 * 1024,
  );
  requireThat(
    createHash('sha256').update(readFileSync(input.executable)).digest('hex') ===
      input.executableSha256,
  );
  const run = (args: string[]) =>
    execFileSync(input.executable, args, {
      env: input.environment,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const version = obj(JSON.parse(run(['version', '--json'])));
  const rawVersion = version.gitVersion ?? version.GitVersion;
  requireThat(typeof rawVersion === 'string');
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[A-Za-z0-9.-]+)?$/.exec(rawVersion);
  requireThat(match);
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  requireThat(major > 3 || (major === 3 && (minor > 1 || (minor === 1 && patch >= 3))));
  return async ({ image, source, certificateIdentity, certificateIssuer, bundle }) => {
    // The registry path verifies exact subject, OIDC issuer, workflow identity, and source extension.
    // Offline bundle verification requires separate reviewed trusted-root handling.
    requireThat(
      bundle === undefined &&
        /^us-west1-docker\.pkg\.dev\/bmson-assistant\/assistant\/(agent|web|browser|code|processor)@sha256:[a-f0-9]{64}$/.test(
          image,
        ),
    );
    requireThat(
      /^[a-f0-9]{40}$/.test(source) &&
        certificateIdentity ===
          'https://github.com/bmson/assistant/.github/workflows/deploy.yml@refs/heads/main' &&
        certificateIssuer === 'https://token.actions.githubusercontent.com',
    );
    const verified = JSON.parse(
      run([
        'verify',
        '--output=json',
        `--certificate-identity=${certificateIdentity}`,
        `--certificate-oidc-issuer=${certificateIssuer}`,
        `--certificate-github-workflow-sha=${source}`,
        image,
      ]),
    );
    requireThat(Array.isArray(verified) && verified.length > 0 && verified.length <= 16);
  };
}
export interface BaselineWriterDrainInputs {
  readJson: BaselineReadJson;
  source: string;
  reviewedCurrent: BootstrapReceipt;
  reviewedCurrentDigest: string;
  reviewedManifest: unknown;
  signatureBundles?: Record<Role, Uint8Array>;
  verifyImageSignature: VerifyBaselineImageSignature;
  /** Verify uninterrupted ownership of all holds from the fixed cutoff through the
   * current observation. Equality of two native snapshots cannot prove this. */
  verifyHoldContinuity?: (input: {
    cutoff: string;
    source: string;
    drainDigest: string;
    nativeDigest: string;
  }) => Promise<void>;
}
export interface ReviewedBaselineDrainPacket {
  format: 1;
  source: string;
  cutoff: string;
  censusDigest: string;
  nativeDigest: string;
  writersDigest: string;
}
const digest = (v: unknown) =>
  createHash('sha256').update(canonicalEstimatedCostJson(v)).digest('hex');
function obj(v: unknown): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Writer evidence malformed');
  return v as Obj;
}
function requireThat(v: unknown): asserts v {
  if (!v) throw new Error('Writer drain unproven');
}
function manifestImages(raw: unknown, source: string) {
  const m = obj(raw),
    keys = [
      'format',
      'release',
      'selected',
      'storageDriver',
      'schemaVersion',
      'components',
      'manifestDigest',
    ];
  requireThat(
    Object.keys(m).sort().join(',') === keys.sort().join(',') &&
      m.format === 1 &&
      m.release === source &&
      m.storageDriver === 'firestore' &&
      Number.isSafeInteger(m.schemaVersion),
  );
  requireThat(
    Array.isArray(m.selected) &&
      m.selected.length === 5 &&
      roles.every((r) => (m.selected as unknown[]).includes(r)),
  );
  const components = obj(m.components);
  requireThat(Object.keys(components).length === 5);
  const unsigned = { ...m };
  delete unsigned.manifestDigest;
  const manifestDigest = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  requireThat(m.manifestDigest === manifestDigest);
  const images = Object.fromEntries(
    roles.map((role) => {
      const c = obj(components[role]),
        image = c.image,
        hash = c.digest;
      requireThat(
        typeof hash === 'string' &&
          /^sha256:[a-f0-9]{64}$/.test(hash) &&
          image === `us-west1-docker.pkg.dev/${project}/assistant/${role}@${hash}`,
      );
      const schema = obj(c.schema);
      requireThat(
        Number.isSafeInteger(schema.min) &&
          Number.isSafeInteger(schema.max) &&
          (schema.min as number) <= (m.schemaVersion as number) &&
          (schema.max as number) >= (m.schemaVersion as number),
      );
      return [role, image];
    }),
  ) as Record<Role, string>;
  return { manifestDigest, images };
}
/** Reconstruct the normal five-component manifest from current native templates and
 * the exact source's release-contracts.json, then authenticate it during verification. */
export async function reconstructBaselineWriterManifest(input: {
  source: string;
  readJson: BaselineReadJson;
  releaseContract: unknown;
}): Promise<unknown> {
  requireThat(/^[a-f0-9]{40}$/.test(input.source));
  const contract = obj(input.releaseContract),
    contractComponents = obj(contract.components);
  const schemaVersion = obj(contract.storageSchemaVersion).firestore;
  requireThat(Number.isSafeInteger(schemaVersion));
  const components: Record<string, unknown> = {};
  for (const role of roles) {
    const isService = role === 'agent' || role === 'web';
    const resource = `${root}/${isService ? 'services' : 'jobs'}/assistant-${role}`;
    const raw = obj(await input.readJson(`https://run.googleapis.com/v2/${resource}`));
    requireThat(raw.name === resource);
    const template = isService ? obj(raw.template) : obj(obj(raw.template).template);
    requireThat(Array.isArray(template.containers) && template.containers.length === 1);
    const image = obj(template.containers[0]).image;
    const pattern = new RegExp(
      `^us-west1-docker\\.pkg\\.dev/bmson-assistant/assistant/${role}@(sha256:[a-f0-9]{64})$`,
    );
    requireThat(typeof image === 'string');
    const match = pattern.exec(image);
    requireThat(match);
    const compatibility = obj(contractComponents[role]),
      schema = obj(compatibility.schema);
    components[role] = {
      image,
      digest: match[1],
      apiContract: compatibility.apiContract,
      peerApi: compatibility.peerApi,
      schema: schema.firestore,
    };
  }
  const manifest = {
    format: 1,
    release: input.source,
    selected: [...roles],
    storageDriver: 'firestore',
    schemaVersion,
    components,
  };
  return {
    ...manifest,
    manifestDigest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  };
}

function envValues(container: Obj): Record<string, string> {
  requireThat(Array.isArray(container.env) && container.env.length <= 256);
  const result: Record<string, string> = {};
  const seen = new Set<string>();
  for (const item of container.env) {
    const e = obj(item);
    requireThat(typeof e.name === 'string' && !seen.has(e.name));
    seen.add(e.name);
    if (typeof e.value === 'string' && !e.valueSource && !e.valueFrom) result[e.name] = e.value;
  }
  return result;
}
async function pages(read: BaselineReadJson, base: string, key: string, extra = '') {
  const all: Obj[] = [],
    seen = new Set<string>();
  let token = '';
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ pageSize: '100' });
    if (extra) query.set('responseView', extra);
    if (token) query.set('pageToken', token);
    const result = obj(await read(`${base}?${query}`));
    requireThat(Object.keys(result).every((k) => k === key || k === 'nextPageToken'));
    const rows = result[key] ?? [];
    requireThat(Array.isArray(rows) && rows.length <= 100);
    all.push(...rows.map(obj));
    requireThat(all.length <= 10000);
    if (result.nextPageToken === undefined || result.nextPageToken === '') return all;
    requireThat(
      typeof result.nextPageToken === 'string' &&
        result.nextPageToken.length > 0 &&
        result.nextPageToken.length <= 2048 &&
        !Array.from(result.nextPageToken).some(
          (c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127,
        ) &&
        !seen.has(result.nextPageToken),
    );
    token = result.nextPageToken;
    seen.add(token);
  }
  throw new Error('Writer inventory pagination incomplete');
}
function taskClear(task: Obj, queue: string) {
  requireThat(typeof task.name === 'string' && task.name.startsWith(`${queue}/tasks/`));
  const number = (x: unknown) => {
    if (x === undefined) return 0;
    const n = typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : x;
    requireThat(typeof n === 'number' && Number.isSafeInteger(n) && n >= 0);
    return n;
  };
  const dispatched = number(task.dispatchCount),
    responded = number(task.responseCount);
  requireThat(dispatched === responded);
  if (dispatched === 0 && task.lastAttempt !== undefined)
    requireThat(Object.keys(obj(task.lastAttempt)).length === 0);
  if (dispatched > 0) {
    const attempt = obj(task.lastAttempt);
    requireThat(
      typeof attempt.dispatchTime === 'string' && typeof attempt.responseTime === 'string',
    );
  }
}
function executionClear(execution: Obj, job: string) {
  requireThat(
    typeof execution.name === 'string' && execution.name.startsWith(`${job}/executions/`),
  );
  if (
    typeof execution.completionTime === 'string' &&
    Number.isFinite(Date.parse(execution.completionTime))
  )
    return;
  requireThat(Array.isArray(execution.conditions) && execution.conditions.length <= 32);
  const terminal = execution.conditions.map(obj).filter((x) => x.type === 'Completed');
  requireThat(
    terminal.length === 1 &&
      (terminal[0]?.state === 'CONDITION_SUCCEEDED' ||
        terminal[0]?.state === 'CONDITION_FAILED' ||
        terminal[0]?.status === 'True'),
  );
}
export async function observeBaselineWriterDrain(input: BaselineWriterDrainInputs) {
  requireThat(/^[a-f0-9]{40}$/.test(input.source));
  const current = reviewedBootstrap(
    input.reviewedCurrent,
    input.reviewedCurrentDigest,
    input.source,
  );
  requireThat(current.kind === 'disabled-bootstrap');
  const { images, manifestDigest } = manifestImages(input.reviewedManifest, input.source);
  const serviceObservations: Obj[] = [];
  let agentEnv: Record<string, string> | undefined;
  for (const role of ['agent', 'web'] as const) {
    const binding = current.services[role];
    requireThat(
      binding.image === images[role] &&
        binding.proof.source === input.source &&
        binding.proof.paused === true &&
        binding.proof.manifest === manifestDigest,
    );
    const base = `https://run.googleapis.com/v2/${root}/services/assistant-${role}`;
    const service = obj(await input.readJson(base)),
      revision = obj(await input.readJson(`${base}/revisions/${binding.revision}`));
    verifyCurrentSnapshot(binding, service, revision, true);
    const template = obj(service.template),
      containers = template.containers;
    requireThat(
      Array.isArray(containers) &&
        containers.length === 1 &&
        obj(containers[0]).image === images[role],
    );
    const env = envValues(obj(containers[0]));
    requireThat(Array.isArray(revision.containers) && revision.containers.length === 1);
    const revisionEnv = envValues(obj(revision.containers[0]));
    const keys = [
      'ASSISTANT_RELEASE_WRITES_PAUSED',
      'ASSISTANT_RELEASE_SOURCE_SHA',
      'ASSISTANT_RELEASE_MANIFEST',
      ...(role === 'agent'
        ? workers.flatMap((r) => [`${r.toUpperCase()}_DRIVER`, `${r.toUpperCase()}_JOB_NAME`])
        : []),
    ];
    requireThat(keys.every((key) => env[key] === revisionEnv[key]));
    requireThat(
      env.ASSISTANT_RELEASE_WRITES_PAUSED === 'true' &&
        env.ASSISTANT_RELEASE_SOURCE_SHA === input.source &&
        env.ASSISTANT_RELEASE_MANIFEST === manifestDigest,
    );
    if (role === 'agent') agentEnv = env;
    serviceObservations.push({
      role,
      serviceDigest: digest(service),
      revisionDigest: digest(revision),
    });
  }
  requireThat(agentEnv);
  for (const role of workers)
    requireThat(
      agentEnv[`${role.toUpperCase()}_DRIVER`] === 'cloudrun' &&
        agentEnv[`${role.toUpperCase()}_JOB_NAME`] === `assistant-${role}`,
    );
  const workerObservations: Obj[] = [];
  for (const role of workers) {
    const jobName = `${root}/jobs/assistant-${role}`,
      job = obj(await input.readJson(`https://run.googleapis.com/v2/${jobName}`));
    requireThat(job.name === jobName && job.reconciling !== true);
    const template = obj(obj(job.template).template),
      containers = template.containers;
    requireThat(
      template.serviceAccount === `assistant-${role}@${project}.iam.gserviceaccount.com` &&
        Array.isArray(containers) &&
        containers.length === 1 &&
        obj(containers[0]).image === images[role],
    );
    const executions = await pages(
      input.readJson,
      `https://run.googleapis.com/v2/${jobName}/executions`,
      'executions',
    );
    for (const execution of executions) executionClear(execution, jobName);
    workerObservations.push({ role, jobDigest: digest(job), executionsDigest: digest(executions) });
  }
  const queueName = `${root}/queues/agent-steps`,
    queue = obj(await input.readJson(`https://cloudtasks.googleapis.com/v2/${queueName}`));
  requireThat(queue.name === queueName && queue.state === 'PAUSED');
  const tasks = await pages(
    input.readJson,
    `https://cloudtasks.googleapis.com/v2/${queueName}/tasks`,
    'tasks',
    'BASIC',
  );
  for (const task of tasks) taskClear(task, queueName);
  const schedulers: Obj[] = [];
  for (const name of ['assistant-sweep', 'assistant-gmail-sync', 'assistant-gmail-watch']) {
    const expected = `${root}/jobs/${name}`,
      scheduler = obj(await input.readJson(`https://cloudscheduler.googleapis.com/v1/${expected}`));
    requireThat(scheduler.name === expected && scheduler.state === 'PAUSED');
    schedulers.push({ name, digest: digest(scheduler) });
  }
  const subscriptionName = `projects/${project}/subscriptions/gmail-events-push`,
    subscription = obj(
      await input.readJson(`https://pubsub.googleapis.com/v1/${subscriptionName}`),
    );
  requireThat(
    subscription.name === subscriptionName &&
      (subscription.pushConfig === undefined ||
        Object.keys(obj(subscription.pushConfig)).length === 0),
  );
  const signatureDigests: Record<string, string> = {};
  for (const role of roles) {
    const bundle = input.signatureBundles?.[role];
    if (bundle !== undefined) {
      requireThat(
        bundle instanceof Uint8Array && bundle.length > 0 && bundle.length <= 4 * 1024 * 1024,
      );
      signatureDigests[role] = createHash('sha256').update(bundle).digest('hex');
    } else signatureDigests[role] = 'registry';
    await input.verifyImageSignature({
      role,
      image: images[role],
      source: input.source,
      bundle,
      certificateIdentity:
        'https://github.com/bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
      certificateIssuer: 'https://token.actions.githubusercontent.com',
    });
  }
  const writersDigest = digest({
    source: input.source,
    manifestDigest,
    images,
    signatureDigests,
    certificateIdentity:
      'https://github.com/bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
    certificateIssuer: 'https://token.actions.githubusercontent.com',
    services: serviceObservations,
    workers: workerObservations.map(({ role, jobDigest }) => ({ role, jobDigest })),
  });
  const nativeDigest = digest({
    services: serviceObservations,
    workers: workerObservations,
    queue: digest(queue),
    tasks: digest(tasks),
    schedulers,
    subscription: digest(subscription),
  });
  return { sourceDigest: bootstrapDigest(current), nativeDigest, writersDigest, manifestDigest };
}
export async function verifyBaselineWriterDrain(
  input: BaselineWriterDrainInputs & { drainPacket: unknown; censusDigest: string; now: Date },
) {
  const p = obj(input.drainPacket);
  requireThat(
    Object.keys(p).sort().join(',') ===
      'censusDigest,cutoff,format,nativeDigest,source,writersDigest' &&
      p.format === 1 &&
      p.source === input.source &&
      typeof p.cutoff === 'string' &&
      Number.isFinite(Date.parse(p.cutoff)) &&
      new Date(p.cutoff).toISOString() === p.cutoff &&
      Date.parse(p.cutoff) <= input.now.getTime() &&
      typeof p.censusDigest === 'string' &&
      /^[a-f0-9]{64}$/.test(p.censusDigest) &&
      p.censusDigest === input.censusDigest,
  );
  requireThat(digest(p) === input.reviewedCurrent.drainReceiptSha256);
  const observed = await observeBaselineWriterDrain(input);
  requireThat(
    p.nativeDigest === observed.nativeDigest && p.writersDigest === observed.writersDigest,
  );
  if (typeof input.verifyHoldContinuity !== 'function')
    throw new Error('Continuous delivery-hold evidence verifier unavailable');
  await input.verifyHoldContinuity({
    cutoff: p.cutoff as string,
    source: input.source,
    drainDigest: digest(p),
    nativeDigest: observed.nativeDigest,
  });
  return {
    cutoff: p.cutoff,
    sourceDigest: observed.sourceDigest,
    drainDigest: digest(p),
    writersDigest: observed.writersDigest,
    censusDigest: input.censusDigest,
  };
}
