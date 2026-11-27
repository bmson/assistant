/** Private, generation-pinned inputs for the ordinary upgrade from the reviewed API 3 pair. */
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  estimatedCostReleaseProfile,
  validateEstimatedCostReleaseInvocation,
} from '../infra/gcp/estimated-cost-release-config.mjs';
import { verifyReuseContext } from '../infra/gcp/verify-prebuilt-firestore.mjs';
import { ORDINARY_IDENTITY, ORDINARY_WORKERS } from './owner-api3-recovery-pins.js';
import { ARCHIVE_BUCKET } from './owner-archived-runtime-hosted.js';
import { verifyPreAuthEnvironment } from './owner-editor-release-inventory.js';
import {
  bootstrapDigest,
  object,
  reviewedCurrentEnvironment,
} from './owner-release-current-snapshot.js';
import {
  loadRetainedServingImageEvidence,
  PRIOR_SERVING_IMAGE_BUILD,
  PRIOR_SERVING_IMAGE_SOURCE,
  RETAINED_SERVING_IMAGE_FILE,
  RETAINED_SERVING_IMAGE_LIMIT,
  readOrdinaryReleasePacket,
} from './owner-serving-image-evidence.js';
import { protectedWebTagCredential } from './owner-web-tag-cloud.js';

const WORKER_FILE = 'ordinary-api3-workers.json';
const WORKER_LIMIT = 512 * 1024;
// The service identities, immutable revisions, image references and native release
// proofs in the reviewed snapshot. Mutable service metadata is still read live.
const REVIEWED_PAIR = 'b20498a1c8bbef6651ed7eb58545ce44e2a7df775d357551b23539b76ced113d';

type Pin = { object: string; generation: string; sha256: string };
function requireIntake(value: unknown): asserts value {
  if (!value) throw new Error('Ordinary release recovery evidence held');
}

export function verifyOrdinaryReleaseContext(env: NodeJS.ProcessEnv) {
  const source = env.IMAGE_TAG ?? '';
  verifyReuseContext(env, source);
  verifyPreAuthEnvironment(env);
  requireIntake(
    env.OWNER_ORDINARY_API3_RECOVERY === 'true' &&
      env.BUILD_ONLY === 'false' &&
      env.BREAK_GLASS === 'false' &&
      ['', 'false'].includes(env.CURRENT_ONLY_CLEANUP ?? '') &&
      ![
        env.ARCHIVE_MAINTENANCE_RUN_ID,
        env.OWNER_RELEASE_RESTORE_TARGET_PROOF,
        env.OWNER_RELEASE_RECLOSED_PREDECESSOR_RUN_ID,
        env.API3_RECOVERY_PROOF,
        env.ESTIMATED_COST_DRAIN_PACKET_JSON,
        env.GOOGLE_CALENDAR_OAUTH_CALLBACK_URL,
        env.OWNER_API3_RECOVERY_GENERATION,
        env.OWNER_API3_RECOVERY_SHA256,
      ].some((v) => v !== undefined && v !== ''),
  );
  const profile = estimatedCostReleaseProfile(env.ESTIMATED_COST_RELEASE_PROFILE_JSON);
  requireIntake(profile?.mode === 'compatible-off');
  validateEstimatedCostReleaseInvocation(profile, env);
  const current = reviewedCurrentEnvironment(env, source);
  requireIntake(current?.kind === 'current-snapshot');
  const identities = (['agent', 'web'] as const).map((role) => {
    const { service, uid, revision, image, proof } = current.services[role];
    return { service, uid, revision, image, proof };
  });
  requireIntake(bootstrapDigest(identities) === REVIEWED_PAIR);
}

export async function fetchOrdinaryReleasePacket(
  pin: Pin,
  limit: number,
  token: string,
  request: typeof fetch = fetch,
): Promise<Buffer> {
  requireIntake(/^[A-Za-z0-9._~-]{20,8192}$/.test(token));
  const url = new URL(
    `https://storage.googleapis.com/download/storage/v1/b/${ARCHIVE_BUCKET}/o/${encodeURIComponent(pin.object)}`,
  );
  url.search = new URLSearchParams({
    alt: 'media',
    generation: pin.generation,
    ifGenerationMatch: pin.generation,
  }).toString();
  const response = await request(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'identity' },
  });
  const reader = response.body?.getReader();
  requireIntake(reader);
  try {
    const count = response.headers.get('content-length');
    const generation = response.headers.get('x-goog-generation');
    requireIntake(
      response.status === 200 &&
        !response.headers.has('content-encoding') &&
        (generation === null || generation === pin.generation) &&
        (count === null || (/^[1-9][0-9]*$/.test(count) && Number(count) <= limit)),
    );
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireIntake(size <= limit);
      chunks.push(value);
    }
    requireIntake(size > 0 && (count === null || Number(count) === size));
    const bytes = Buffer.concat(chunks, size);
    requireIntake(createHash('sha256').update(bytes).digest('hex') === pin.sha256);
    return bytes;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

// The generation and byte hash bind all native observations and the offline review.
// Translate the original *production* job image separately from the signed replacement build.
function qualifiedWorkers(packet: Record<string, unknown>) {
  const identity = object(packet.servingIdentity);
  const retention = object(packet.retention);
  const transport = object(packet.restoreTransport);
  requireIntake(
    packet.format === 1 &&
      packet.kind === 'worker-recovery-qualification' &&
      transport.api === 'Cloud Run v2 Jobs.Patch' &&
      transport.precondition === 'current job etag' &&
      packet.source === 'b333b3c17cd1c3349dde13597c8d5261b138df15' &&
      packet.buildRun === '45867245208' &&
      packet.previousSource === PRIOR_SERVING_IMAGE_SOURCE &&
      packet.previousBuildRun === PRIOR_SERVING_IMAGE_BUILD &&
      identity.bucket === ARCHIVE_BUCKET &&
      identity.object === ORDINARY_IDENTITY.object &&
      identity.generation === ORDINARY_IDENTITY.generation &&
      identity.sha256 === ORDINARY_IDENTITY.sha256 &&
      retention.repository ===
        'projects/bmson-assistant/locations/us-west1/repositories/assistant-release-recovery' &&
      retention.immutableTags === true &&
      retention.cleanupPolicyCount === 0,
  );
  const roles = object(packet.roles);
  requireIntake(Object.keys(roles).sort().join(',') === 'browser,code,processor');
  const verified = (role: 'browser' | 'code' | 'processor') => {
    const row = object(roles[role]);
    requireIntake(
      typeof row.previousImage === 'string' &&
        typeof row.recoveryImage === 'string' &&
        typeof row.originalImage === 'string' &&
        typeof row.isolatedRecoveryImage === 'string' &&
        row.recoveryImage.startsWith(
          `us-west1-docker.pkg.dev/bmson-assistant/assistant-release-recovery/${role}@`,
        ),
    );
    const digest = row.recoveryImage.split('@')[1] ?? '';
    requireIntake(
      /^sha256:[a-f0-9]{64}$/.test(digest) &&
        row.originalImage ===
          `us-west1-docker.pkg.dev/bmson-assistant/assistant/${role}@${digest}` &&
        row.isolatedRecoveryImage.endsWith(`/${role}@${digest}`) &&
        row.controlImage !== row.isolatedRecoveryImage &&
        row.successfulTasks === 1 &&
        row.workloadMarker === `recovery-workload-${role}-passed` &&
        /^[a-f0-9]{64}$/.test(String(row.unchangedExecutionConfigSha256)),
    );
    return { originalImage: row.previousImage, recoveryImage: row.recoveryImage };
  };
  return {
    workers: {
      browser: verified('browser'),
      code: verified('code'),
      processor: verified('processor'),
    },
  };
}

export function loadQualifiedWorkerRecovery(env: NodeJS.ProcessEnv = process.env) {
  if (
    env.OWNER_API3_RECOVERY_GENERATION === undefined &&
    env.OWNER_API3_RECOVERY_SHA256 === undefined
  )
    return undefined;
  requireIntake(
    env.OWNER_API3_RECOVERY_GENERATION === ORDINARY_IDENTITY.generation &&
      env.OWNER_API3_RECOVERY_SHA256 === ORDINARY_IDENTITY.sha256 &&
      env.RUNNER_TEMP &&
      isAbsolute(env.RUNNER_TEMP),
  );
  const bytes = readOrdinaryReleasePacket(join(env.RUNNER_TEMP, WORKER_FILE), WORKER_LIMIT);
  requireIntake(createHash('sha256').update(bytes).digest('hex') === ORDINARY_WORKERS.sha256);
  const packet = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  return qualifiedWorkers(packet);
}

async function install(env: NodeJS.ProcessEnv) {
  verifyOrdinaryReleaseContext(env);
  const temp = env.RUNNER_TEMP;
  requireIntake(temp && isAbsolute(temp) && env.GITHUB_ENV && isAbsolute(env.GITHUB_ENV));
  const token = await protectedWebTagCredential();
  const entries = [
    {
      file: RETAINED_SERVING_IMAGE_FILE,
      pin: ORDINARY_IDENTITY,
      limit: RETAINED_SERVING_IMAGE_LIMIT,
    },
    { file: WORKER_FILE, pin: ORDINARY_WORKERS, limit: WORKER_LIMIT },
  ];
  const bytes = await Promise.all(
    entries.map(({ pin, limit }) => fetchOrdinaryReleasePacket(pin, limit, token)),
  );
  const created: string[] = [];
  try {
    for (const [i, { file }] of entries.entries()) {
      const packet = bytes[i];
      requireIntake(packet);
      const path = join(temp, file);
      const fd = openSync(path, 'wx', 0o600);
      created.push(path);
      try {
        writeFileSync(fd, packet);
      } finally {
        closeSync(fd);
      }
    }
    const bindings = {
      OWNER_API3_RECOVERY_GENERATION: ORDINARY_IDENTITY.generation,
      OWNER_API3_RECOVERY_SHA256: ORDINARY_IDENTITY.sha256,
    };
    const verified = { ...env, ...bindings };
    requireIntake(
      loadRetainedServingImageEvidence(verified) && loadQualifiedWorkerRecovery(verified),
    );
    appendFileSync(
      env.GITHUB_ENV,
      Object.entries(bindings)
        .map(([key, val]) => `${key}=${val}\n`)
        .join(''),
    );
  } catch (error) {
    for (const path of created) unlinkSync(path);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = async () => {
    requireIntake(process.argv.length === 3 && process.argv[2] === '--install');
    await install(process.env);
  };
  run().catch(() => {
    console.error('Ordinary release recovery evidence held.');
    process.exitCode = 1;
  });
}
