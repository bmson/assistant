/** Fixed-target, protected operator entrypoint. Never imported by application code. */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createInstallationStore } from '@assistant/firestore';
import {
  parseOwnerEditorMaintenancePacket,
  prepareOwnerEditorMaintenance,
  runOwnerEditorMaintenance,
} from '@assistant/firestore/owner-editor-maintenance';
import { GoogleAuth } from 'google-auth-library';
import { withHostedArchivedRuntimePack } from './owner-archived-runtime-hosted.js';
import {
  observeArchivedRuntimePair,
  RECLOSED_ARCHIVE_RUN_ID,
  reclosedArchiveOptIn,
} from './owner-archived-runtime-native.js';
import {
  createReadOnlyGet,
  requiresBasicEditorPreflight,
  serviceFacts,
  verifyPreAuthEnvironment,
  verifyWifEnvironment,
} from './owner-editor-release-inventory.js';
import {
  decryptMaintenancePacket,
  encryptMaintenancePacket,
  maintenancePacketDigest,
  packetRecipient,
} from './owner-editor-v1-packet.js';
import { bootstrapDigest } from './owner-release-current-snapshot.js';
import {
  archivedOriginalReceiptBinding,
  createBeforeMaintenanceReceipt,
  protectedBeforeMaintenanceContext,
  readTrustedMaintenanceRun,
  writeBeforeMaintenanceReceipt,
} from './owner-release-maintenance-run.js';
import { verifyHostedReclosedAutomatic } from './owner-release-reclosed-hosted.js';
import { recheckReviewedArchivedRuntimeGraph } from './owner-restore-target-verify.js';

const modes = [
  'prepare-initialize',
  'prepare-disable',
  'dry-run',
  'apply',
  'before-maintenance',
] as const;
function boundedFile(path: string, max: number) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max)
    throw new Error('Invalid private file');
  return readFileSync(path, 'utf8');
}
export function verifyOperatorSource(
  env: NodeJS.ProcessEnv,
  head: string,
  contract: unknown,
  runtimePresent: boolean,
) {
  verifyPreAuthEnvironment(env);
  if (
    !modes.includes(env.OWNER_EDITOR_MAINTENANCE_MODE as (typeof modes)[number]) ||
    head !== env.GITHUB_SHA ||
    head !== env.OWNER_EDITOR_RELEASE_SHA ||
    env.GITHUB_WORKFLOW_REF !==
      'bmson/assistant/.github/workflows/owner-editor-v1-maintenance.yml@refs/heads/main' ||
    !requiresBasicEditorPreflight(contract, runtimePresent) ||
    env.FIRESTORE_EMULATOR_HOST ||
    env.GOOGLE_CLOUD_UNIVERSE_DOMAIN ||
    Object.keys(env).some((k) => k.startsWith('CLOUDSDK_API_ENDPOINT_OVERRIDES_'))
  )
    throw new Error('Untrusted operator source');
  if (
    reclosedArchiveOptIn(env.OWNER_RELEASE_RECLOSED_PREDECESSOR_RUN_ID) &&
    env.OWNER_EDITOR_MAINTENANCE_MODE !== 'before-maintenance'
  )
    throw new Error('Unexpected reclosed predecessor opt-in');
  if (env.OWNER_EDITOR_MAINTENANCE_MODE?.startsWith('prepare-'))
    packetRecipient(env.OWNER_EDITOR_PACKET_RECIPIENT_PUBLIC_KEY ?? '');
  if (env.OWNER_EDITOR_MAINTENANCE_MODE === 'before-maintenance')
    protectedBeforeMaintenanceContext(env, head);
}
export function validateOperatorObservation(raw: unknown, env: NodeJS.ProcessEnv, now: number) {
  if (!raw || typeof raw !== 'object') throw new Error('Missing prerequisite observation');
  const receipt = raw as Record<string, unknown>;
  const indexes = receipt.indexes as { status?: unknown } | undefined;
  const point = receipt.recoveryPoint as { kind?: unknown } | undefined;
  const identity = receipt.observationIdentity as
    | { principal?: unknown; provider?: unknown }
    | undefined;
  const observed = typeof receipt.observedAt === 'string' ? Date.parse(receipt.observedAt) : NaN;
  if (
    receipt.workflowSource !== env.GITHUB_SHA ||
    receipt.workflowRun !== env.GITHUB_RUN_ID ||
    identity?.principal !== env.GCP_DEPLOY_SERVICE_ACCOUNT ||
    identity?.provider !== env.GCP_WORKLOAD_IDENTITY_PROVIDER ||
    indexes?.status !== 'exact_manifest_parity' ||
    !['pitr', 'backup'].includes(String(point?.kind)) ||
    !Number.isFinite(observed) ||
    now < observed ||
    now - observed > 120000 ||
    !Array.isArray(receipt.services) ||
    receipt.services.length !== 2 ||
    !receipt.services.every(
      (s: { servingRevisionVerified?: unknown }) => s?.servingRevisionVerified === true,
    )
  )
    throw new Error('Release prerequisites unproven');
  return receipt.services as Array<Record<string, unknown>>;
}
async function observeBeforeMaintenance(env: NodeJS.ProcessEnv, head: string) {
  const { intent, runId } = protectedBeforeMaintenanceContext(env, head);
  const githubToken = env.OWNER_RELEASE_MAINTENANCE_GITHUB_TOKEN ?? '';
  const identity = verifyWifEnvironment(env, (path) => JSON.parse(boundedFile(path, 32768)));
  const runIdentitySha256 = await readTrustedMaintenanceRun(runId, head, githubToken);
  const auth = new GoogleAuth().fromJSON(JSON.parse(boundedFile(identity.file, 32768)));
  const token = (await auth.getAccessToken()).token;
  if (!token || !env.RUNNER_TEMP)
    throw new Error('Protected before-maintenance identity unavailable');
  const receipt = await withHostedArchivedRuntimePack(env, token, async (pack, binding) => {
    if (
      pack.sha256 !== intent.packSha256 ||
      bootstrapDigest(pack.nativeBinding) !== intent.nativeBindingSha256 ||
      binding.generation !== intent.generation ||
      binding.objectSha256 !== intent.objectSha256
    )
      throw new Error('Reviewed original archive changed');
    const deadline = Date.now() + 60_000;
    const read = createReadOnlyGet(token, deadline);
    const reclosed = reclosedArchiveOptIn(env.OWNER_RELEASE_RECLOSED_PREDECESSOR_RUN_ID)
      ? {
          runId: RECLOSED_ARCHIVE_RUN_ID,
          verify: (pair: Parameters<typeof verifyHostedReclosedAutomatic>[0]['pair']) =>
            verifyHostedReclosedAutomatic({
              pair,
              archivedNativeBinding: pack.nativeBinding,
              token,
              env,
            }),
        }
      : undefined;
    const before = await observeArchivedRuntimePair(pack.nativeBinding, pack.roles, read, reclosed);
    await recheckReviewedArchivedRuntimeGraph(token, pack, fetch, deadline);
    const after = await observeArchivedRuntimePair(pack.nativeBinding, pack.roles, read, reclosed);
    const confirmed = protectedBeforeMaintenanceContext(env, head);
    if (
      bootstrapDigest(before) !== bootstrapDigest(after) ||
      bootstrapDigest(confirmed) !== bootstrapDigest({ intent, runId }) ||
      (await readTrustedMaintenanceRun(runId, head, githubToken)) !== runIdentitySha256
    )
      throw new Error('Before-maintenance proof drifted');
    return createBeforeMaintenanceReceipt({
      intent,
      runId,
      runIdentitySha256,
      archivedReadbackSha256: bootstrapDigest(after),
      original: archivedOriginalReceiptBinding(pack),
      observedAt: Date.now(),
    });
  });
  writeBeforeMaintenanceReceipt(env.RUNNER_TEMP, receipt);
}

async function main() {
  if (process.argv[2] === '--packet-digest') {
    if (process.argv.length !== 4) throw new Error('Invalid digest arguments');
    const packet = JSON.parse(boundedFile(process.argv[3] ?? '', 8192));
    process.stdout.write(`${maintenancePacketDigest(packet)}\n`);
    return;
  }
  if (process.argv[2] === '--decrypt') {
    if (process.argv.length !== 6) throw new Error('Invalid decrypt arguments');
    const envelope = JSON.parse(boundedFile(process.argv[3] ?? '', 16384));
    const packet = decryptMaintenancePacket(envelope, boundedFile(process.argv[4] ?? '', 16384));
    writeFileSync(process.argv[5] ?? '', `${JSON.stringify(packet, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    process.stdout.write(
      `${JSON.stringify({ packetSha256: maintenancePacketDigest(packet), productionAction: false })}\n`,
    );
    return;
  }
  if (
    process.argv.length > 3 ||
    (process.argv[2] !== undefined && process.argv[2] !== '--verify-source')
  )
    throw new Error('Invalid arguments');
  const env = process.env;
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  verifyOperatorSource(
    env,
    head,
    JSON.parse(readFileSync('infra/gcp/release-contracts.json', 'utf8')),
    (() => {
      try {
        return lstatSync('apps/web/lib/owner-editor-runtime.ts').isFile();
      } catch {
        return false;
      }
    })(),
  );
  if (process.argv[2] === '--verify-source') return;
  const mode = env.OWNER_EDITOR_MAINTENANCE_MODE;
  if (mode === 'before-maintenance') return observeBeforeMaintenance(env, head);
  if (env.OWNER_RELEASE_BEFORE_MAINTENANCE_INTENT)
    throw new Error('Unexpected before-maintenance intent');
  const isPrepare = mode === 'prepare-initialize' || mode === 'prepare-disable';
  const packetText = env.OWNER_EDITOR_V1_REVIEWED_PACKET;
  let reviewedPacket: ReturnType<typeof parseOwnerEditorMaintenancePacket> | undefined;
  if (!isPrepare) {
    if (!packetText || Buffer.byteLength(packetText) > 8192)
      throw new Error('Missing private reviewed packet');
    reviewedPacket = parseOwnerEditorMaintenancePacket(JSON.parse(packetText));
    if (
      !/^[a-f0-9]{64}$/.test(env.OWNER_EDITOR_V1_REVIEWED_PACKET_SHA256 ?? '') ||
      maintenancePacketDigest(reviewedPacket) !== env.OWNER_EDITOR_V1_REVIEWED_PACKET_SHA256
    )
      throw new Error('Reviewed packet digest mismatch');
  }
  const receipt = JSON.parse(boundedFile('owner-editor-release-inventory.json', 65536));
  const services = validateOperatorObservation(receipt, env, Date.now());
  const identity = verifyWifEnvironment(env, (path) => JSON.parse(boundedFile(path, 32768)));
  const auth = new GoogleAuth().fromJSON(JSON.parse(boundedFile(identity.file, 32768)));
  const token = (await auth.getAccessToken()).token;
  if (!token) throw new Error('Protected token unavailable');
  const read = createReadOnlyGet(token, Date.now() + 30000);
  const targets = [];
  for (const service of ['agent', 'web'] as const) {
    const facts = serviceFacts(
      await read(
        `https://run.googleapis.com/v2/projects/bmson-assistant/locations/us-west1/services/assistant-${service}`,
      ),
      service,
    );
    const prior = services.find((s) => s.service === service);
    if (
      !prior ||
      prior.revision !== facts.revision ||
      prior.observedTemplateHash !== facts.observedTemplateHash
    )
      throw new Error('Serving target changed');
    targets.push(facts.editorMetadataTarget);
  }
  const target = targets[0];
  if (!target || JSON.stringify(target) !== JSON.stringify(targets[1]))
    throw new Error('Owner target unbound');
  if (
    reviewedPacket &&
    (reviewedPacket.target.ownerId !== target.ownerId ||
      reviewedPacket.target.installationId !== target.workspaceId)
  )
    throw new Error('Reviewed target mismatch');
  const store = createInstallationStore({
    projectId: 'bmson-assistant',
    databaseId: 'assistant-production',
    installationId: target.workspaceId,
    authClient: auth,
  });
  try {
    if (isPrepare) {
      const packet = await prepareOwnerEditorMaintenance(store, {
        ownerId: target.ownerId,
        action: mode === 'prepare-disable' ? 'disable' : 'initialize',
        releaseSha: head,
        now: Date.now(),
      });
      const envelope = encryptMaintenancePacket(
        packet,
        env.OWNER_EDITOR_PACKET_RECIPIENT_PUBLIC_KEY ?? '',
      );
      writeFileSync('owner-editor-v1-packet.encrypted.json', `${JSON.stringify(envelope)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      process.stdout.write(
        `${JSON.stringify({ outcome: 'prepared_encrypted', wrote: false, activationApprovalRequired: true })}\n`,
      );
    } else {
      if (!reviewedPacket || (mode !== 'dry-run' && mode !== 'apply'))
        throw new Error('Missing operation');
      const outcome = await runOwnerEditorMaintenance(store, reviewedPacket, {
        mode,
        releaseSha: head,
        now: Date.now,
      });
      process.stdout.write(
        `${JSON.stringify({ ...outcome, packetSha256: maintenancePacketDigest(reviewedPacket), editingDeliveryProven: false })}\n`,
      );
    }
  } finally {
    await store.db.terminate();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    process.stderr.write(
      'Editor maintenance failed; inspect prerequisites and the private packet. No automatic retry or authority inferred.\n',
    );
    process.exitCode = 1;
  });
