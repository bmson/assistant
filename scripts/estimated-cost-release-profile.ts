/** Protected release profile receipt. Runtime flags alone never establish a
 * reviewed baseline or an actual numeric credential binding. */
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { estimatedCostProvisionDigest } from '@assistant/persistence';
import {
  type EstimatedCostReleaseProfile,
  estimatedCostNativeEnvironment,
  estimatedCostReleaseProfile,
  pinEstimatedCostProvider,
  requireEstimatedCostReleaseProfile,
  validateEstimatedCostReleaseInvocation,
} from '../infra/gcp/estimated-cost-release-config.mjs';
import {
  type BootstrapReceipt,
  bootstrapDigest,
  object,
  verifyCurrentSnapshot,
} from './owner-release-current-snapshot.js';

type ReadJson = (url: string) => Promise<unknown>;
type Evidence = {
  baselineReceiptSha256: string;
  writersReceiptSha256: string;
  drainReceiptSha256: string;
};
const filename = 'estimated-cost-release-verified.json';
const path = (env: NodeJS.ProcessEnv) => {
  if (!env.RUNNER_TEMP) throw new Error('Estimated cost protected receipt directory missing');
  return resolve(env.RUNNER_TEMP, filename);
};
const requireProof = (value: unknown) => {
  if (!value) throw new Error('Estimated cost release metadata held');
};

/** Refuse a subsequent unconfigured deployment before it can acquire delivery
 * holds, rather than discovering an inherited source manifest during staging. */
export async function verifyNoInheritedEstimatedCostProfile(read: ReadJson) {
  for (const role of ['web', 'agent'] as const) {
    const servicePath = `projects/bmson-assistant/locations/us-west1/services/assistant-${role}`;
    const service = object(await read(`https://run.googleapis.com/v2/${servicePath}`));
    requireProof(service.name === servicePath);
    requireEstimatedCostReleaseProfile(service);
    requireProof(Array.isArray(service.trafficStatuses));
    const current = (service.trafficStatuses as unknown[])
      .map(object)
      .filter((entry) => entry.percent === 100);
    requireProof(
      current.length === 1 &&
        typeof current[0]?.revision === 'string' &&
        new RegExp(`^assistant-${role}-[a-z0-9-]{1,63}$`).test(current[0].revision),
    );
    const revisionPath = `${servicePath}/revisions/${current[0]?.revision}`;
    const revision = object(await read(`https://run.googleapis.com/v2/${revisionPath}`));
    requireProof(revision.name === revisionPath);
    requireEstimatedCostReleaseProfile(revision);
  }
}

export async function verifyEstimatedCostReleaseMetadata(
  profile: EstimatedCostReleaseProfile,
  current: BootstrapReceipt,
  read: ReadJson,
) {
  requireProof(current.source === profile.source);
  const project = object(
    await read('https://cloudresourcemanager.googleapis.com/v3/projects/bmson-assistant'),
  );
  requireProof(
    project.projectId === profile.projectId &&
      project.state === 'ACTIVE' &&
      typeof project.name === 'string' &&
      /^projects\/[0-9]{6,30}$/.test(project.name),
  );
  const projectNumber = String(project.name).split('/')[1];
  if (profile.projectNumber !== undefined) requireProof(profile.projectNumber === projectNumber);
  const secret = object(
    await read(
      `https://secretmanager.googleapis.com/v1/projects/${profile.projectId}/secrets/${profile.providerSecret}/versions/${profile.providerVersion}`,
    ),
  );
  requireProof(
    secret.state === 'ENABLED' &&
      [profile.projectId, projectNumber].some(
        (id) =>
          secret.name ===
          `projects/${id}/secrets/${profile.providerSecret}/versions/${profile.providerVersion}`,
      ),
  );
  const bindings = [];
  for (const role of ['web', 'agent'] as const) {
    const binding = current.services[role];
    const service = await read(`https://run.googleapis.com/v2/${binding.service}`);
    const revision = await read(
      `https://run.googleapis.com/v2/${binding.service}/revisions/${binding.revision}`,
    );
    verifyCurrentSnapshot(binding, service, revision, current.kind === 'disabled-bootstrap');
    // Independent checks on both the service template and immutable selected
    // revision prevent a truthful manifest from concealing another binding.
    for (const raw of [service, revision])
      pinEstimatedCostProvider(estimatedCostNativeEnvironment(raw), profile);
    bindings.push({ role, service: bootstrapDigest(service), revision: bootstrapDigest(revision) });
  }
  return estimatedCostProvisionDigest({ project, secret, bindings });
}

export function recordVerifiedEstimatedCostReleaseProfile(
  profile: EstimatedCostReleaseProfile,
  metadataSha256: string,
  evidence: Evidence | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
) {
  validateEstimatedCostReleaseInvocation(profile, env, now);
  requireProof(/^[a-f0-9]{64}$/.test(metadataSha256));
  if (profile.mode === 'enable') {
    requireProof(evidence);
    for (const key of [
      'baselineReceiptSha256',
      'writersReceiptSha256',
      'drainReceiptSha256',
    ] as const)
      requireProof(evidence?.[key] === profile[key]);
  } else requireProof(evidence === undefined);
  writeFileSync(
    path(env),
    `${JSON.stringify({
      format: 1,
      profileSha256: estimatedCostProvisionDigest(profile),
      source: profile.source,
      runId: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT,
      verifiedAt: new Date(now).toISOString(),
      metadataSha256,
      ...(evidence
        ? {
            evidence: {
              baselineReceiptSha256: evidence.baselineReceiptSha256,
              writersReceiptSha256: evidence.writersReceiptSha256,
              drainReceiptSha256: evidence.drainReceiptSha256,
            },
          }
        : {}),
    })}\n`,
    { flag: 'wx', mode: 0o600 },
  );
}

export function reviewedEstimatedCostReleaseProfile(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): EstimatedCostReleaseProfile | undefined {
  const profile = estimatedCostReleaseProfile(env.ESTIMATED_COST_RELEASE_PROFILE_JSON);
  if (!profile) return undefined;
  validateEstimatedCostReleaseInvocation(profile, env, now);
  const file = path(env),
    stat = lstatSync(file);
  requireProof(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size >= 1 &&
      stat.size <= 16384 &&
      (stat.mode & 0o077) === 0 &&
      (process.getuid === undefined || stat.uid === process.getuid()),
  );
  const receipt = object(JSON.parse(readFileSync(file, 'utf8')));
  requireProof(
    Object.keys(receipt).sort().join(',') ===
      [
        'format',
        'profileSha256',
        'source',
        'runId',
        'attempt',
        'verifiedAt',
        'metadataSha256',
        ...(profile.mode === 'enable' ? ['evidence'] : []),
      ]
        .sort()
        .join(',') &&
      receipt.format === 1 &&
      receipt.profileSha256 === estimatedCostProvisionDigest(profile) &&
      receipt.source === profile.source &&
      receipt.runId === env.GITHUB_RUN_ID &&
      receipt.attempt === env.GITHUB_RUN_ATTEMPT &&
      typeof receipt.verifiedAt === 'string' &&
      Number.isFinite(Date.parse(receipt.verifiedAt)) &&
      new Date(receipt.verifiedAt).toISOString() === receipt.verifiedAt &&
      Date.parse(receipt.verifiedAt) >= Date.parse(profile.reviewedAt) &&
      Date.parse(receipt.verifiedAt) <= now &&
      typeof receipt.metadataSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(receipt.metadataSha256),
  );
  if (profile.mode === 'enable') {
    const evidence = object(receipt.evidence);
    requireProof(
      Object.keys(evidence).sort().join(',') ===
        'baselineReceiptSha256,drainReceiptSha256,writersReceiptSha256',
    );
    for (const key of [
      'baselineReceiptSha256',
      'writersReceiptSha256',
      'drainReceiptSha256',
    ] as const)
      requireProof(evidence[key] === profile[key]);
  }
  return profile;
}
