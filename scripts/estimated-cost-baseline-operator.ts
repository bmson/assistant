/** Existing-human operator and separately authenticated read-only release preflight. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applyFirestoreEstimatedCostBaseline,
  createInstallationStore,
  decodeRecord,
  documentKey,
  type InstallationStore,
  inspectFirestoreEstimatedCostBaseline,
  prepareFirestoreEstimatedCostBaseline,
  readbackFirestoreEstimatedCostBaseline,
} from '@assistant/firestore';
import {
  type EstimatedCostBaselineContext,
  type EstimatedCostBaselineProposal,
  type EstimatedCostBaselineReceipt,
  type EstimatedCostBaselineWitness,
  estimatedCostProvisionDigest,
  parseHistoricalUnknownBaseline,
  validateEstimatedCostBaselineHistoricalWitness,
  validateEstimatedCostBaselineProposal,
} from '@assistant/persistence';
import { OAuth2Client } from 'google-auth-library';
import { ownerEditorFirestorePrivacyToken } from '../packages/firestore/src/owner-editor-repository.js';
import {
  type BaselineWriterDrainInputs,
  createBaselineCosignRegistryVerifier,
  observeBaselineWriterDrain,
  verifyBaselineWriterDrain,
} from './estimated-cost-baseline-writer-drain.js';
import { estimatedCostMetadataRead } from './estimated-cost-release-native-read.js';
import { parseInventoryList } from './owner-editor-inventory-diagnostics.js';
import {
  collectInventory,
  createReadOnlyGet,
  serviceFacts,
  verifyManifest,
} from './owner-editor-release-inventory.js';
import {
  localGlobalIndexArgs,
  localInventoryEnvironment,
  readLocalTokenIdentity,
  verifyLocalAccount,
  verifyLocalOperatorSource,
} from './owner-editor-v1-local-operator.js';
import {
  type BootstrapReceipt,
  bootstrapDigest,
  reviewedCurrentEnvironment,
  verifyCurrentSnapshot,
} from './owner-release-current-snapshot.js';
import { createImageResolutionReader } from './owner-release-image-resolution.js';

const project = 'bmson-assistant',
  database = 'assistant-production',
  account = 'bmson@bmson.com';
type Mode = 'inspect' | 'observe-drain' | 'prepare' | 'apply' | 'readback' | 'verify-enable';
export type BaselineOperatorPacket = {
  format: 1;
  witness: EstimatedCostBaselineWitness;
  proposal: EstimatedCostBaselineProposal;
};
type WriterDrainEvidence = {
  cutoff: string;
  sourceDigest: string;
  drainDigest: string;
  writersDigest: string;
  censusDigest: string;
};

export interface VerifiedBaselineEnablePrerequisites {
  target: EstimatedCostBaselineContext['target'];
  ownerId: string;
  source: string;
  baselineReceiptSha256: string;
  writersReceiptSha256: string;
  drainReceiptSha256: string;
}
/** Read the immutable canonical baseline and same-transaction native marker.
 * With no original packet, a completed privacy job cannot be bound to its original
 * generation, so that state is conservatively unavailable. */
export async function readBaselineReceiptForEnable(
  store: InstallationStore,
  context: EstimatedCostBaselineContext,
) {
  if (
    context.target.driver !== 'firestore' ||
    store.projectId !== context.target.projectId ||
    store.databaseId !== context.target.databaseId ||
    store.installationId !== context.target.installationId
  )
    throw new Error('Baseline target mismatch');
  return store.db.runTransaction(
    async (tx) => {
      const owners = await tx.get(store.collection('agents').select('id').limit(2));
      const owner = owners.docs[0];
      if (
        owners.size !== 1 ||
        !owner ||
        owner.id !== documentKey(context.ownerId) ||
        owner.get('id') !== context.ownerId
      )
        throw new Error('Baseline owner unavailable');
      const name = `estimated-cost-baseline:${store.installationId}`;
      const [job, baseline, marker] = await tx.getAll(
        store.doc('privacyErasureJobs', context.ownerId),
        store.doc('estimatedCostBaselines', store.installationId),
        store.doc('maintenanceCursors', name),
      );
      if (
        !job ||
        !baseline ||
        !marker ||
        ownerEditorFirestorePrivacyToken(job, context.ownerId) !== null ||
        !baseline.exists ||
        !marker.exists ||
        baseline.get('ownerId') !== context.ownerId ||
        baseline.get('installationId') !== context.target.installationId ||
        marker.get('name') !== name ||
        typeof marker.get('cursor') !== 'string' ||
        !/^[a-f0-9]{64}$/.test(marker.get('cursor')) ||
        !baseline.createTime ||
        !baseline.updateTime ||
        !marker.createTime ||
        !marker.updateTime ||
        !baseline.createTime.isEqual(marker.createTime) ||
        !baseline.updateTime.isEqual(baseline.createTime) ||
        !marker.updateTime.isEqual(marker.createTime)
      )
        throw new Error('Canonical baseline receipt unavailable');
      const rows = parseHistoricalUnknownBaseline(decodeRecord(baseline.get('rows')));
      const rowDigest = rows && createHash('sha256').update(JSON.stringify(rows)).digest('hex');
      if (!rows || rowDigest !== baseline.get('digest'))
        throw new Error('Canonical baseline rows unavailable');
      return {
        proposalDigest: marker.get('cursor') as string,
        installationId: context.target.installationId,
        ownerId: context.ownerId,
        digest: rowDigest,
        rows,
        createdVersion: `${baseline.updateTime.seconds}:${baseline.updateTime.nanoseconds}`,
        createdAt: baseline.createTime.toDate().toISOString(),
      };
    },
    { readOnly: true },
  );
}

/** Caller supplies independently authenticated read transport and real signature verifier. */
export async function verifyEstimatedCostBaselineEnablePrerequisites(input: {
  writerDrain: BaselineWriterDrainInputs & { drainPacket: unknown };
  store: InstallationStore;
  context: EstimatedCostBaselineContext;
  baselineReceiptSha256: string;
}): Promise<VerifiedBaselineEnablePrerequisites> {
  const { store, context, writerDrain } = input;
  if (
    writerDrain.source !== context.releaseSha ||
    !/^[a-f0-9]{64}$/.test(input.baselineReceiptSha256)
  )
    throw new Error('Baseline release source mismatch');
  const before = await inspectFirestoreEstimatedCostBaseline(store, context);
  const evidence = await verifyBaselineWriterDrain({
    ...writerDrain,
    censusDigest: before.censusDigest,
    now: context.now(),
  });
  const receipt = await readBaselineReceiptForEnable(store, context);
  if (
    estimatedCostProvisionDigest(receipt) !== input.baselineReceiptSha256 ||
    Date.parse(receipt.createdAt) < Date.parse(evidence.cutoff)
  )
    throw new Error('Reviewed canonical baseline receipt mismatch');
  const after = await inspectFirestoreEstimatedCostBaseline(store, context);
  if (before.censusDigest !== after.censusDigest)
    throw new Error('Baseline census changed during preflight');
  return {
    target: context.target,
    ownerId: context.ownerId,
    source: context.releaseSha,
    baselineReceiptSha256: estimatedCostProvisionDigest(receipt),
    writersReceiptSha256: evidence.writersDigest,
    drainReceiptSha256: evidence.drainDigest,
  };
}

export function parseBaselineOperatorPacket(
  raw: unknown,
  reviewedDigest: string,
  target: EstimatedCostBaselineContext['target'],
  ownerId: string,
): BaselineOperatorPacket {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== 'format,proposal,witness' ||
    !/^[a-f0-9]{64}$/.test(reviewedDigest) ||
    estimatedCostProvisionDigest(raw) !== reviewedDigest
  )
    throw new Error('Baseline reviewed packet mismatch');
  const packet = raw as BaselineOperatorPacket;
  if (packet.format !== 1 || !packet.witness || packet.witness.ownerId !== ownerId)
    throw new Error('Baseline packet owner mismatch');
  validateEstimatedCostBaselineHistoricalWitness(packet.witness, target);
  validateEstimatedCostBaselineProposal(packet.proposal, packet.witness);
  return packet;
}
export function requireReviewedBaselineFreeze(
  current: BootstrapReceipt | undefined,
  head: string,
  facts: ReturnType<typeof serviceFacts>[],
) {
  if (
    !current ||
    current.kind !== 'disabled-bootstrap' ||
    current.source !== head ||
    facts.length !== 2 ||
    facts.some((fact) => fact.nonsecretReleaseConfig.ASSISTANT_RELEASE_WRITES_PAUSED !== 'true') ||
    ['agent', 'web'].some((role) => {
      const proof = current.services[role as 'agent' | 'web'].proof;
      return proof.source !== head || proof.paused !== true;
    })
  )
    throw new Error('Reviewed disabled and paused service source required');
}
function privateFile(path: string, max: number): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max || (stat.mode & 0o077) !== 0)
    throw new Error('Private bounded file required');
  return readFileSync(path, 'utf8');
}
function privateDirectory(path: string): string {
  if (!path) throw new Error('Private output directory required');
  const directory = resolve(path),
    stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error('Private output directory required');
  return directory;
}
function writePrivate(directory: string, name: string, data: unknown) {
  const text = `${JSON.stringify(data)}\n`;
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Operator file bound');
  writeFileSync(resolve(directory, name), text, { flag: 'wx', mode: 0o600 });
}
async function main(
  override?: 'verify-enable',
): Promise<VerifiedBaselineEnablePrerequisites | undefined> {
  if (!override && process.argv.length !== 2) throw new Error('Invalid arguments');
  const env = process.env,
    mode = (override ?? env.ESTIMATED_COST_BASELINE_MODE) as Mode;
  if (!['inspect', 'observe-drain', 'prepare', 'apply', 'readback', 'verify-enable'].includes(mode))
    throw new Error('Invalid mode');
  const git = (args: string[]) =>
    execFileSync('git', args, { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 }).trim();
  const head = git(['rev-parse', 'HEAD']);
  verifyLocalOperatorSource(
    {
      ...env,
      OWNER_EDITOR_LOCAL_OPERATOR: env.ESTIMATED_COST_LOCAL_OPERATOR,
      OWNER_EDITOR_RELEASE_SHA: env.ESTIMATED_COST_RELEASE_SHA,
      OWNER_EDITOR_MAINTENANCE_MODE: 'prepare-initialize',
    },
    head,
    git(['ls-remote', '--exit-code', 'https://github.com/bmson/assistant.git', 'refs/heads/main']),
    git(['status', '--porcelain', '--untracked-files=all']),
    JSON.parse(readFileSync('infra/gcp/release-contracts.json', 'utf8')),
    lstatSync('apps/web/lib/owner-editor-runtime.ts').isFile(),
  );
  const current = reviewedCurrentEnvironment(env, head);
  if (!current) throw new Error('Reviewed current service snapshot required');
  const output = privateDirectory(env.ESTIMATED_COST_BASELINE_OUTPUT_DIRECTORY ?? '');
  const rawPacket =
    mode === 'apply' || mode === 'readback' || mode === 'verify-enable'
      ? JSON.parse(privateFile(env.ESTIMATED_COST_BASELINE_PACKET_FILE ?? '', 1024 * 1024))
      : undefined;
  const started = Date.now();
  let bytes = 0,
    inventoryEnv: NodeJS.ProcessEnv | undefined;
  const command = (args: string[], maxBuffer = 2 * 1024 * 1024) => {
    const remaining = started + 60000 - Date.now();
    if (remaining <= 0) throw new Error('Operator deadline');
    const value = execFileSync('gcloud', args, {
      encoding: 'utf8',
      timeout: Math.min(8000, remaining),
      maxBuffer,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: inventoryEnv ?? env,
    });
    bytes += Buffer.byteLength(value);
    if (bytes > 8 * 1024 * 1024) throw new Error('Operator output bound');
    return value;
  };
  const active = JSON.parse(
    command(['auth', 'list', '--filter=status:ACTIVE', '--format=json'], 32768),
  );
  const impersonation = spawnSync(
    'gcloud',
    ['config', 'get-value', 'auth/impersonate_service_account'],
    {
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: 32768,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    },
  );
  verifyLocalAccount(active, impersonation);
  if (JSON.parse(command(['version', '--format=json'], 32768))['Google Cloud SDK'] !== '586.0.0')
    throw new Error('Unaudited local CLI');
  const token = command(
    ['auth', 'print-access-token', `--account=${account}`, '--quiet'],
    16384,
  ).trim();
  if (!/^[A-Za-z0-9._~-]{20,8192}$/.test(token)) throw new Error('Invalid operator token');
  await readLocalTokenIdentity(
    await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    }),
  );
  const config = mkdtempSync(join(tmpdir(), 'estimated-cost-local-gcloud-'));
  inventoryEnv = localInventoryEnvironment(env, token, config);
  try {
    const global = {
      composites: parseInventoryList(command(localGlobalIndexArgs('composite'))),
      fields: parseInventoryList(command(localGlobalIndexArgs('fields'))),
      evidence: 'reviewed-local-gcloud-586-complete-lists' as const,
    };
    const manifest = readFileSync('infra/gcp/firestore/firestore.indexes.json');
    verifyManifest(manifest);
    const read = createReadOnlyGet(token, started + 60000);
    const inventory = await collectInventory(
      read,
      manifest,
      Date.now(),
      global,
      undefined,
      undefined,
      current,
      createImageResolutionReader(token),
    );
    if (
      inventory.indexes.status !== 'exact_manifest_parity' ||
      !['pitr', 'backup'].includes(inventory.recoveryPoint.kind) ||
      Date.now() - Date.parse(inventory.observedAt) > 120000
    )
      throw new Error('Current inventory unavailable');
    const facts = [];
    for (const role of ['agent', 'web'] as const) {
      const base = `https://run.googleapis.com/v2/projects/${project}/locations/us-west1/services/assistant-${role}`;
      const service = await read(base);
      const revision = await read(`${base}/revisions/${current.services[role].revision}`);
      verifyCurrentSnapshot(
        current.services[role],
        service,
        revision,
        current.kind === 'disabled-bootstrap',
      );
      facts.push(serviceFacts(service, role));
    }
    const target = facts[0]?.editorMetadataTarget;
    if (!target || JSON.stringify(target) !== JSON.stringify(facts[1]?.editorMetadataTarget))
      throw new Error('Owner target unbound');
    const context: EstimatedCostBaselineContext = {
      ownerId: target.ownerId,
      target: {
        driver: 'firestore',
        projectId: project,
        databaseId: database,
        installationId: target.workspaceId,
      },
      releaseSha: head,
      now: () => new Date(),
    };
    const packet = rawPacket
      ? parseBaselineOperatorPacket(
          rawPacket,
          env.ESTIMATED_COST_BASELINE_REVIEWED_PACKET_SHA256 ?? '',
          context.target,
          context.ownerId,
        )
      : undefined;
    const auth = new OAuth2Client();
    auth.setCredentials({ access_token: token });
    const store = createInstallationStore({
      projectId: project,
      databaseId: database,
      installationId: target.workspaceId,
      authClient: auth,
    });
    try {
      if (mode === 'readback') {
        if (!packet) throw new Error('Reviewed packet required');
        const receipt = await readbackFirestoreEstimatedCostBaseline(
          store,
          context,
          packet.witness,
          packet.proposal,
        );
        writePrivate(output, 'baseline-readback.json', receipt);
        process.stdout.write(
          `${JSON.stringify({ outcome: 'readback', proposalDigest: receipt.proposalDigest })}\n`,
        );
        return;
      }
      requireReviewedBaselineFreeze(current, head, facts);
      const observedCutoff = new Date().toISOString();
      const inspection = await inspectFirestoreEstimatedCostBaseline(store, context);
      if (mode === 'inspect') {
        writePrivate(output, 'baseline-inspection.json', {
          format: 1,
          source: head,
          snapshotDigest: bootstrapDigest(current),
          ...inspection,
        });
        process.stdout.write(
          `${JSON.stringify({ outcome: 'inspected', censusDigest: inspection.censusDigest })}\n`,
        );
        return;
      }
      {
        const manifest = JSON.parse(
          privateFile(env.ESTIMATED_COST_BASELINE_MANIFEST_FILE ?? '', 1024 * 1024),
        );
        const registryDirectory = privateDirectory(
          env.ESTIMATED_COST_REGISTRY_CONFIG_DIRECTORY ?? '',
        );
        const verifier = createBaselineCosignRegistryVerifier({
          executable: env.ESTIMATED_COST_COSIGN_BINARY ?? '',
          executableSha256: env.ESTIMATED_COST_COSIGN_SHA256 ?? '',
          environment: {
            PATH: env.PATH,
            HOME: env.HOME,
            DOCKER_CONFIG: registryDirectory,
            CLOUDSDK_CONFIG: config,
            CLOUDSDK_AUTH_ACCESS_TOKEN: token,
            CLOUDSDK_CORE_PROJECT: project,
          },
        });
        const writerDrain: BaselineWriterDrainInputs = {
          source: head,
          reviewedCurrent: current,
          reviewedCurrentDigest: bootstrapDigest(current),
          reviewedManifest: manifest,
          readJson: estimatedCostMetadataRead(token, started + 60000),
          verifyImageSignature: verifier,
        };
        if (mode !== 'observe-drain') {
          const drainPacket = JSON.parse(
            privateFile(env.ESTIMATED_COST_BASELINE_DRAIN_FILE ?? '', 32768),
          );
          const evidence = await verifyBaselineWriterDrain({
            ...writerDrain,
            drainPacket,
            censusDigest: inspection.censusDigest,
            now: context.now(),
          });
          if (
            evidence.censusDigest !== inspection.censusDigest ||
            evidence.sourceDigest !== bootstrapDigest(current) ||
            evidence.drainDigest !== current.drainReceiptSha256
          )
            throw new Error('Native writer drain evidence does not match');
          return await executeReviewedBaseline(store, context, mode, packet, evidence, output);
        }
        const observations = await observeBaselineWriterDrain(writerDrain);
        const after = await inspectFirestoreEstimatedCostBaseline(store, context);
        if (after.censusDigest !== inspection.censusDigest)
          throw new Error('Baseline census changed during observation');
        const draft = {
          format: 1,
          source: head,
          cutoff: observedCutoff,
          censusDigest: inspection.censusDigest,
          nativeDigest: observations.nativeDigest,
          writersDigest: observations.writersDigest,
        };
        writePrivate(output, 'baseline-drain-proposed.json', draft);
        process.stdout.write(
          `${JSON.stringify({ outcome: 'drain_observed_review_required', drainDigest: estimatedCostProvisionDigest(draft) })}\n`,
        );
        return;
      }
    } finally {
      await store.db.terminate();
    }
  } finally {
    rmSync(config, { recursive: true });
  }
}
async function executeReviewedBaseline(
  store: InstallationStore,
  context: EstimatedCostBaselineContext,
  mode: Mode,
  packet: BaselineOperatorPacket | undefined,
  evidence: WriterDrainEvidence,
  output: string,
): Promise<VerifiedBaselineEnablePrerequisites | undefined> {
  const head = context.releaseSha;
  if (mode === 'prepare') {
    const now = Date.now();
    const witness: EstimatedCostBaselineWitness = {
      format: 1,
      operationId: randomUUID(),
      ownerId: context.ownerId,
      target: context.target,
      releaseSha: head,
      cutoff: evidence.cutoff,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 10 * 60000).toISOString(),
      sourceDigest: evidence.sourceDigest,
      drainDigest: evidence.drainDigest,
      observedCensusDigest: evidence.censusDigest,
    };
    const proposal = await prepareFirestoreEstimatedCostBaseline(store, context, witness);
    const result = { format: 1 as const, witness, proposal };
    writePrivate(output, 'baseline-proposal.json', result);
    process.stdout.write(
      `${JSON.stringify({ outcome: 'prepared', packetDigest: estimatedCostProvisionDigest(result) })}\n`,
    );
    return;
  }
  if (
    !packet ||
    packet.witness.releaseSha !== head ||
    packet.witness.sourceDigest !== evidence.sourceDigest ||
    packet.witness.drainDigest !== evidence.drainDigest ||
    packet.witness.cutoff !== evidence.cutoff ||
    packet.witness.observedCensusDigest !== evidence.censusDigest
  )
    throw new Error('Reviewed proposal differs from current drain');
  if (mode === 'verify-enable') {
    const receipt = await readbackFirestoreEstimatedCostBaseline(
      store,
      context,
      packet.witness,
      packet.proposal,
    );
    return {
      target: context.target,
      ownerId: context.ownerId,
      source: head,
      baselineReceiptSha256: estimatedCostProvisionDigest(receipt),
      writersReceiptSha256: evidence.writersDigest,
      drainReceiptSha256: evidence.drainDigest,
    };
  }
  writePrivate(output, 'baseline-apply-intent.json', {
    format: 1,
    packetDigest: estimatedCostProvisionDigest(packet),
    packet,
  });
  let receipt: EstimatedCostBaselineReceipt;
  try {
    receipt = await applyFirestoreEstimatedCostBaseline(
      store,
      context,
      packet.witness,
      packet.proposal,
    );
  } catch {
    receipt = await readbackFirestoreEstimatedCostBaseline(
      store,
      context,
      packet.witness,
      packet.proposal,
    );
  }
  writePrivate(output, 'baseline-readback.json', receipt);
  process.stdout.write(
    `${JSON.stringify({ outcome: 'readback', proposalDigest: receipt.proposalDigest })}\n`,
  );
  return undefined;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    process.stderr.write(
      `Baseline operator held: ${error instanceof Error && error.message === 'Continuous delivery-hold evidence verifier unavailable' ? error.message : 'preconditions or readback unproven'}. No automatic write retry.\n`,
    );
    process.exitCode = 1;
  });
