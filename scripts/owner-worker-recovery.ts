/** Exact worker recovery for the protected ordinary API 3 rollout. */
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { readBoundedJSON } from '../infra/gcp/api3-recovery-proof.mjs';
import { verifyReuseContext } from '../infra/gcp/verify-prebuilt-firestore.mjs';
import { estimatedCostMetadataRead } from './estimated-cost-release-native-read.js';
import { loadQualifiedWorkerRecovery } from './owner-api3-recovery-intake.js';
import { bootstrapDigest, object, RUN_ROOT } from './owner-release-current-snapshot.js';
import { validateImageResolution } from './owner-release-image-resolution.js';
import { loadRetainedServingImageEvidence } from './owner-serving-image-evidence.js';
import { protectedWebTagCredential } from './owner-web-tag-cloud.js';

const registry = 'us-west1-docker.pkg.dev';
const project = 'bmson-assistant';
const releaseRoot = `${registry}/${project}/assistant`;
const recoveryRoot = `${registry}/${project}/assistant-release-recovery`;
const jobs = `projects/${project}/locations/us-west1/jobs/assistant-`;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const roles = ['browser', 'code', 'processor'] as const;
type Role = (typeof roles)[number];
const originalDigests: Record<Role, string> = {
  browser: 'ea82d9c3ccd8ee6de592edcadb2548e33b914434ab350117b11c69981c41927a',
  code: 'fb6cf8ef81dc7b561329e60707d6bed47b74641d3df3f09e1b2414a183f16c98',
  processor: 'b891c2443d21c0fca2147a8e0151e5f699b24dc177a22d57da522b9e53a1c048',
};
// Signed build 45867245208, b333b3c17cd1c3349dde13597c8d5261b138df15.
const recoveryDigests: Record<Role, string> = {
  browser: 'eeb88de87edae44d92e67238e2fb003ec34a17b3292798dd407db135f0d4e5af',
  code: 'b53f34cd9ac96aad110489e3697c57b2b31758e6d5105be138483d890d1affce',
  processor: 'fdcf03abafc15f0c7207ac01e377a0eb71d82c55d2d7c76b8a65834de96da104',
};

function requireWorker(value: unknown): asserts value {
  if (!value) throw new Error('Reviewed worker recovery unproven');
}

function allRoles<T>(read: (role: Role) => Promise<T>): Promise<T[]> {
  return Promise.all(roles.map(read));
}

export function workerImages(raw: unknown) {
  const imageMap = object(raw);
  requireWorker(Object.keys(imageMap).length === roles.length);
  const pinned = (role: Role) => {
    const item = object(imageMap[role]);
    const originalImage = `${releaseRoot}/${role}@sha256:${originalDigests[role]}`;
    const recoveryImage = `${recoveryRoot}/${role}@sha256:${recoveryDigests[role]}`;
    requireWorker(
      Object.keys(item).length === 2 &&
        item.originalImage === originalImage &&
        item.recoveryImage === recoveryImage,
    );
    return { originalImage, recoveryImage };
  };
  return { browser: pinned('browser'), code: pinned('code'), processor: pinned('processor') };
}

const indexType = 'application/vnd.oci.image.index.v1+json';
const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const maxObjectBytes = 2 * 1024 * 1024;
const sha256 = (data: Uint8Array) => `sha256:${createHash('sha256').update(data).digest('hex')}`;

function descriptor(value: unknown) {
  const { digest, size } = object(value);
  requireWorker(
    typeof digest === 'string' &&
      digestPattern.test(digest) &&
      typeof size === 'number' &&
      Number.isSafeInteger(size) &&
      size > 0,
  );
  return { digest, size };
}

async function readOciObject(response: Response, digest: string, size?: number) {
  requireWorker(response.ok && response.body && size !== 0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      requireWorker(length <= maxObjectBytes && (size === undefined || length <= size));
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const content = Buffer.concat(chunks, length);
  requireWorker((size === undefined || size === length) && sha256(content) === digest);
  return content;
}

export async function verifyWorkerGraph(
  role: Role,
  digest: string,
  read: (kind: 'manifests' | 'blobs', method: 'GET' | 'HEAD', digest: string) => Promise<Response>,
) {
  const parent = await readOciObject(await read('manifests', 'GET', digest), digest);
  const index = object(JSON.parse(parent.toString('utf8')));
  requireWorker(
    index.mediaType === indexType &&
      Array.isArray(index.manifests) &&
      index.manifests.length > 0 &&
      index.manifests.length <= 8,
  );
  const children = await Promise.all(
    index.manifests.map(async (value: unknown) => {
      const item = object(value);
      const expected = descriptor(item);
      requireWorker(item.mediaType === manifestType);
      const bytes = await readOciObject(
        await read('manifests', 'GET', expected.digest),
        expected.digest,
        expected.size,
      );
      const manifest = object(JSON.parse(bytes.toString('utf8')));
      requireWorker(
        manifest.schemaVersion === 2 &&
          manifest.mediaType === manifestType &&
          Array.isArray(manifest.layers) &&
          manifest.layers.length > 0 &&
          manifest.layers.length <= 64,
      );
      const config = descriptor(manifest.config);
      const configBytes = await readOciObject(
        await read('blobs', 'GET', config.digest),
        config.digest,
        config.size,
      );
      await Promise.all(
        manifest.layers.map(async (layer: unknown) => {
          const blob = descriptor(layer);
          const response = await read('blobs', 'HEAD', blob.digest);
          requireWorker(
            response.ok && response.headers.get('content-length') === String(blob.size),
          );
        }),
      );
      return { item, bytes, config: object(JSON.parse(configBytes.toString('utf8'))) };
    }),
  );
  const platform = children.filter(({ item }) => {
    const { os, architecture } = object(item.platform);
    return os === 'linux' && architecture === 'amd64';
  });
  const child = platform[0];
  requireWorker(
    platform.length === 1 && child?.config.os === 'linux' && child.config.architecture === 'amd64',
  );
  // The recovery repository holds the same digest-addressed graph as the signed release.
  validateImageResolution(`${releaseRoot}/${role}@${digest}`, parent, child.bytes);
}

export function verifyRecoveryPullability(
  token: string,
  role: Role,
  request: typeof fetch = fetch,
) {
  requireWorker(roles.includes(role) && /^[A-Za-z0-9._~-]{20,8192}$/.test(token));
  const repository = `https://${registry}/v2/${project}/assistant-release-recovery/${role}`;
  const deadline = Date.now() + 60_000;
  return verifyWorkerGraph(
    role,
    `sha256:${recoveryDigests[role]}`,
    async (kind, method, digest) => {
      const remaining = Math.min(15_000, deadline - Date.now());
      requireWorker(remaining > 0);
      const signal = AbortSignal.timeout(remaining);
      let response = await request(`${repository}/${kind}/${digest}`, {
        method,
        signal,
        redirect: 'manual',
        headers: { Authorization: `Bearer ${token}`, Accept: `${indexType}, ${manifestType}, */*` },
      });
      if (kind === 'blobs' && [301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (response.body) void response.body.cancel().catch(() => undefined);
        requireWorker(location);
        const url = new URL(location);
        requireWorker(
          url.protocol === 'https:' &&
            !url.port &&
            !url.username &&
            !url.password &&
            !url.hash &&
            (url.hostname === 'storage.googleapis.com' ||
              url.hostname.endsWith('.storage.googleapis.com')),
        );
        response = await request(url, { method, signal, redirect: 'error' });
      }
      return response;
    },
  );
}

type Baseline = { uid: string; generation: string; configuration: string };
type Images = ReturnType<typeof workerImages>;
type Native = {
  read(role: Role): Promise<unknown>;
  patch(role: Role, body: unknown): Promise<number>;
};

function jobName(role: Role) {
  return jobs + role;
}

function observe(raw: unknown, role: Role) {
  const {
    name,
    uid,
    etag,
    template,
    generation,
    observedGeneration,
    reconciling,
    terminalCondition,
    labels,
    annotations,
    binaryAuthorization,
    launchStage,
    deleteTime,
    expireTime,
    client,
    clientVersion,
  } = object(raw);
  requireWorker(
    name === jobName(role) &&
      !deleteTime &&
      typeof uid === 'string' &&
      uid.length > 0 &&
      !expireTime &&
      typeof etag === 'string' &&
      etag.length > 0 &&
      typeof generation === 'string' &&
      /^[1-9][0-9]*$/.test(generation),
  );
  const execution = object(template);
  const task = object(execution.template);
  const { containers } = task;
  requireWorker(
    task.serviceAccount === `assistant-${role}@${project}.iam.gserviceaccount.com` &&
      Array.isArray(containers) &&
      containers.length === 1,
  );
  const { image, ...container } = object(containers[0]);
  requireWorker(typeof image === 'string');
  const configuration = bootstrapDigest({
    labels,
    annotations,
    binaryAuthorization,
    launchStage,
    client,
    clientVersion,
    template: { ...execution, template: { ...task, containers: [container] } },
  });
  const ready =
    (reconciling === false || reconciling === undefined) &&
    observedGeneration === generation &&
    terminalCondition !== undefined &&
    object(terminalCondition).state === 'CONDITION_SUCCEEDED';
  const patch = (target: string) => ({
    name,
    etag,
    labels,
    annotations,
    binaryAuthorization,
    launchStage,
    client,
    clientVersion,
    template: {
      ...execution,
      template: { ...task, containers: [{ ...container, image: target }] },
    },
  });
  return { uid, image, generation, configuration, ready, patch };
}

export async function preflightWorkers(
  native: Native,
  images: Images,
  pullable: (role: Role) => Promise<void>,
) {
  return Object.fromEntries(
    await allRoles(async (role) => {
      const [job] = await Promise.all([native.read(role), pullable(role)]);
      const { uid, image, generation, configuration, ready } = observe(job, role);
      requireWorker(ready && image === images[role].originalImage);
      return [role, { uid, generation, configuration }] as const;
    }),
  ) as Record<Role, Baseline>;
}

export class WorkerObservationRequired extends Error {}
export class WorkerAdvanceRejected extends Error {}

export async function transitionWorker(
  native: Native,
  role: Role,
  baseline: Baseline,
  from: string,
  to: string,
  restore: boolean,
  wait: () => Promise<void> = () => delay(3000),
) {
  requireWorker(
    typeof baseline.uid === 'string' &&
      /^[1-9][0-9]*$/.test(baseline.generation) &&
      /^[a-f0-9]{64}$/.test(baseline.configuration) &&
      from !== to,
  );
  const initialGeneration = BigInt(baseline.generation) + (restore ? 1n : 0n);
  const sameConfig = (state: ReturnType<typeof observe>) =>
    state.uid === baseline.uid && state.configuration === baseline.configuration;
  const before = observe(await native.read(role), role);
  requireWorker(before.ready && sameConfig(before));
  requireWorker(before.image === from && BigInt(before.generation) === initialGeneration);
  // Submit exactly once. A concurrent write can match our target by coincidence.
  let status: number;
  try {
    status = await native.patch(role, before.patch(to));
  } catch {
    throw new WorkerObservationRequired();
  }
  if (status === 403 && !restore) {
    const after = observe(await native.read(role), role);
    if (
      after.ready &&
      sameConfig(after) &&
      after.generation === before.generation &&
      after.image === from
    )
      throw new WorkerAdvanceRejected();
  }
  if (status < 200 || status >= 300) throw new WorkerObservationRequired();
  const deadline = Date.now() + 180_000;
  for (let attempts = 0; attempts < 60 && Date.now() < deadline; attempts++) {
    try {
      const after = observe(await native.read(role), role);
      const generation = BigInt(after.generation);
      if (!sameConfig(after) || generation > initialGeneration + 1n) break;
      if (after.ready && generation === initialGeneration + 1n && after.image === to)
        return { beforeGeneration: before.generation, observedGeneration: after.generation };
    } catch {
      // A transient GET failure says nothing about the effect of the PATCH.
    }
    await wait();
  }
  throw new WorkerObservationRequired();
}

function nativeWorkers(token: string): Native {
  const read = estimatedCostMetadataRead(token, Date.now() + 215_000);
  return {
    read: (role) => read(RUN_ROOT + jobName(role)),
    async patch(role, body) {
      const response = await fetch(RUN_ROOT + jobName(role), {
        method: 'PATCH',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.body) void response.body.cancel().catch(() => undefined);
      return response.status;
    },
  };
}

async function main() {
  const [command, worker, candidate] = process.argv.slice(2);
  const source = process.env.IMAGE_TAG ?? '';
  verifyReuseContext(process.env, source);
  const prebuilt = object(readBoundedJSON(process.env.RELEASE_PREBUILT_IMAGES_PATH ?? ''));
  requireWorker(
    prebuilt.source === source && prebuilt.runId === process.env.RELEASE_PREBUILT_RUN_ID,
  );
  const digests = object(prebuilt.digests);
  for (const role of roles) {
    const digest = digests[role];
    requireWorker(typeof digest === 'string' && digestPattern.test(digest));
  }
  const qualification = await loadQualifiedWorkerRecovery();
  requireWorker(qualification && loadRetainedServingImageEvidence());
  const images = workerImages(qualification.workers);
  const token = await protectedWebTagCredential();
  if (command === '--preflight' && process.argv.length === 3) {
    const baseline = await preflightWorkers(nativeWorkers(token), images, (role) =>
      verifyRecoveryPullability(token, role),
    );
    process.stdout.write(JSON.stringify(baseline));
    return;
  }
  const role = roles.find((value) => value === worker);
  requireWorker(
    role &&
      candidate === `${releaseRoot}/${role}@${digests[role]}` &&
      (command === '--forward' || command === '--restore') &&
      process.argv.length === 5,
  );
  const raw = process.env.OWNER_WORKER_BASELINE ?? '';
  requireWorker(raw.length > 0 && raw.length <= 4096);
  const baseline = object(JSON.parse(raw))[role] as Baseline;
  const restore = command === '--restore';
  if (restore) await verifyRecoveryPullability(token, role);
  const image = restore ? images[role].recoveryImage : candidate;
  requireWorker(image);
  const observation = await transitionWorker(
    nativeWorkers(token),
    role,
    baseline,
    restore ? candidate : images[role].originalImage,
    image,
    restore,
  );
  console.log(JSON.stringify({ role, command, image, ...observation }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    if (error instanceof WorkerObservationRequired) {
      console.error('Reviewed worker update outcome requires read-only reconciliation.');
      process.exitCode = 75;
    } else if (error instanceof WorkerAdvanceRejected) {
      console.error(
        'Reviewed worker update was denied and the original configuration was confirmed.',
      );
      process.exitCode = 3;
    } else {
      console.error('Reviewed worker recovery precondition failed.');
      process.exitCode = 2;
    }
  });
}
