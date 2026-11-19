/** Protected paired-deploy preflight. GETs and canonical receipt readback only;
 * this command never creates a baseline, grant, hold or approval. */
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInstallationStore } from '@assistant/firestore';
import { OAuth2Client } from 'google-auth-library';
import {
  estimatedCostReleaseProfile,
  validateEstimatedCostReleaseInvocation,
} from '../infra/gcp/estimated-cost-release-config.mjs';
import { verifyEstimatedCostBaselineEnablePrerequisites } from './estimated-cost-baseline-operator.js';
import {
  createBaselineCosignRegistryVerifier,
  reconstructBaselineWriterManifest,
} from './estimated-cost-baseline-writer-drain.js';
import { estimatedCostMetadataRead } from './estimated-cost-release-native-read.js';
import {
  recordVerifiedEstimatedCostReleaseProfile,
  reviewedEstimatedCostReleaseProfile,
  verifyEstimatedCostReleaseMetadata,
  verifyNoInheritedEstimatedCostProfile,
} from './estimated-cost-release-profile.js';
import { verifyPreAuthEnvironment } from './owner-editor-release-inventory.js';
import { bootstrapDigest, reviewedCurrentEnvironment } from './owner-release-current-snapshot.js';
import { createImageResolutionReader } from './owner-release-image-resolution.js';
import { protectedWebTagCredential } from './owner-web-tag-cloud.js';

export async function runEstimatedCostReleasePreflight(mode?: string) {
  if (mode === '--verify') {
    reviewedEstimatedCostReleaseProfile();
    return;
  }
  if (mode !== undefined) throw new Error('Invalid spending profile preflight mode');
  const env = process.env;
  const profile = estimatedCostReleaseProfile(env.ESTIMATED_COST_RELEASE_PROFILE_JSON);
  if (!profile) {
    if (env.ESTIMATED_COST_DRAIN_PACKET_JSON) throw new Error('Spending profile missing');
    verifyPreAuthEnvironment(env);
    const token = await protectedWebTagCredential();
    await verifyNoInheritedEstimatedCostProfile(
      estimatedCostMetadataRead(token, Date.now() + 60000),
    );
    return;
  }
  validateEstimatedCostReleaseInvocation(profile, env);
  verifyPreAuthEnvironment(env);
  const current = reviewedCurrentEnvironment(env, profile.source);
  if (!current || !env.RUNNER_TEMP) throw new Error('Reviewed paired snapshot required');
  const token = await protectedWebTagCredential();
  const read = estimatedCostMetadataRead(token, Date.now() + 180000);
  const resolveImage = createImageResolutionReader(token);
  for (const role of ['web', 'agent'] as const) await resolveImage(current.services[role].image);
  const metadataSha256 = await verifyEstimatedCostReleaseMetadata(profile, current, read);
  if (profile.mode === 'compatible-off') {
    if (env.ESTIMATED_COST_DRAIN_PACKET_JSON) throw new Error('Unexpected activation evidence');
    recordVerifiedEstimatedCostReleaseProfile(profile, metadataSha256, undefined);
    return;
  }
  const drain = env.ESTIMATED_COST_DRAIN_PACKET_JSON;
  if (!drain || Buffer.byteLength(drain) > 8192) throw new Error('Reviewed drain packet required');
  const drainPacket: unknown = JSON.parse(drain);
  if (current.kind !== 'disabled-bootstrap')
    throw new Error('Reviewed paused compatible pair required');
  const registryDirectory = mkdtempSync(join(env.RUNNER_TEMP, 'estimated-cost-registry-'));
  const auth = new OAuth2Client();
  auth.setCredentials({ access_token: token });
  const store = createInstallationStore({
    projectId: profile.projectId,
    databaseId: 'assistant-production',
    installationId: profile.installationId,
    authClient: auth,
  });
  try {
    // The pinned installer verifies the release against its pinned public key.
    // Use only its explicit installation path, never a binary found via PATH.
    const installed = resolve(env.RUNNER_TEMP, 'estimated-cost-cosign', 'cosign');
    const executable = realpathSync(installed);
    if (executable !== installed) throw new Error('Pinned signature verifier required');
    const stat = lstatSync(executable);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 256 * 1024 * 1024 ||
      (stat.mode & 0o111) === 0
    )
      throw new Error('Invalid signature verifier');
    const executableSha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
    writeFileSync(
      join(registryDirectory, 'config.json'),
      JSON.stringify({
        auths: {
          'us-west1-docker.pkg.dev': {
            auth: Buffer.from(`oauth2accesstoken:${token}`).toString('base64'),
          },
        },
      }),
      { mode: 0o600, flag: 'wx' },
    );
    const verifyImageSignature = createBaselineCosignRegistryVerifier({
      executable,
      executableSha256,
      environment: {
        PATH: '/usr/bin:/bin',
        HOME: registryDirectory,
        DOCKER_CONFIG: registryDirectory,
      },
    });
    const reviewedManifest = await reconstructBaselineWriterManifest({
      source: profile.source,
      readJson: read,
      releaseContract: JSON.parse(readFileSync('infra/gcp/release-contracts.json', 'utf8')),
    });
    const evidence = await verifyEstimatedCostBaselineEnablePrerequisites({
      store,
      context: {
        ownerId: profile.ownerId,
        target: {
          driver: 'firestore',
          projectId: profile.projectId,
          databaseId: 'assistant-production',
          installationId: profile.installationId,
        },
        releaseSha: profile.source,
        now: () => new Date(),
      },
      baselineReceiptSha256: profile.baselineReceiptSha256 as string,
      writerDrain: {
        readJson: read,
        source: profile.source,
        reviewedCurrent: current,
        reviewedCurrentDigest: bootstrapDigest(current),
        reviewedManifest,
        verifyImageSignature,
        drainPacket,
      },
    });
    if (
      evidence.source !== profile.source ||
      evidence.ownerId !== profile.ownerId ||
      evidence.target.installationId !== profile.installationId ||
      evidence.target.projectId !== profile.projectId
    )
      throw new Error('Verified baseline scope changed');
    recordVerifiedEstimatedCostReleaseProfile(profile, metadataSha256, evidence);
  } finally {
    await store.db.terminate();
    rmSync(registryDirectory, { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runEstimatedCostReleasePreflight(process.argv[2]).catch(() => {
    process.stderr.write(
      'Spending profile preflight held: exact native metadata, baseline or writer drain is unproven. No activation was authorized.\n',
    );
    process.exitCode = 1;
  });
