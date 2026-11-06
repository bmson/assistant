/** Explicit existing-user transport; never a fallback from the protected WIF entrypoint. */
import { execFileSync, type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInstallationStore } from '@assistant/firestore';
import {
  parseOwnerEditorMaintenancePacket,
  prepareOwnerEditorMaintenance,
  runOwnerEditorMaintenance,
} from '@assistant/firestore/owner-editor-maintenance';
import { OAuth2Client } from 'google-auth-library';
import { parseInventoryList } from './owner-editor-inventory-diagnostics.js';
import {
  collectInventory,
  createReadOnlyGet,
  requiresBasicEditorPreflight,
  serviceFacts,
  verifyManifest,
} from './owner-editor-release-inventory.js';
import {
  encryptMaintenancePacket,
  maintenancePacketDigest,
  packetRecipient,
} from './owner-editor-v1-packet.js';
import {
  type BootstrapReceipt,
  disabled,
  object,
  reviewedCurrentEnvironment,
  verifyCurrentService,
} from './owner-release-current-snapshot.js';

const modes = ['prepare-initialize', 'prepare-disable', 'dry-run', 'apply'] as const;
const account = 'bmson@bmson.com';
const project = 'bmson-assistant';
const database = 'assistant-production';
function privateFile(path: string, max: number) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max || (stat.mode & 0o077) !== 0)
    throw new Error('Invalid private file');
  return readFileSync(path, 'utf8');
}
export function verifyLocalOperatorSource(
  env: NodeJS.ProcessEnv,
  head: string,
  remoteMain: string,
  dirty: string,
  contract: unknown,
  runtimePresent: boolean,
) {
  if (
    env.GITHUB_ACTIONS ||
    env.OWNER_EDITOR_LOCAL_OPERATOR !== account ||
    !modes.includes(env.OWNER_EDITOR_MAINTENANCE_MODE as (typeof modes)[number]) ||
    !/^[a-f0-9]{40}$/.test(head) ||
    head !== env.OWNER_EDITOR_RELEASE_SHA ||
    remoteMain.trim() !== `${head}\trefs/heads/main` ||
    dirty !== '' ||
    !requiresBasicEditorPreflight(contract, runtimePresent) ||
    [
      'FIRESTORE_EMULATOR_HOST',
      'GOOGLE_CLOUD_UNIVERSE_DOMAIN',
      'CLOUDSDK_CORE_UNIVERSE_DOMAIN',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_GHA_CREDS_PATH',
      'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
      'CLOUDSDK_AUTH_ACCESS_TOKEN',
      'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT',
    ].some((k) => !!env[k]) ||
    Object.keys(env).some((k) => k.startsWith('CLOUDSDK_API_ENDPOINT_OVERRIDES_'))
  )
    throw new Error('Untrusted local operator source');
}
export function verifyLocalAccount(
  active: unknown,
  impersonation: Pick<
    SpawnSyncReturns<string>,
    'status' | 'signal' | 'error' | 'stdout' | 'stderr'
  >,
) {
  const unset =
    impersonation.status === 0 &&
    impersonation.signal === null &&
    impersonation.error === undefined &&
    (((impersonation.stdout === '(unset)' || impersonation.stdout === '(unset)\n') &&
      impersonation.stderr === '') ||
      (impersonation.stdout === '' && impersonation.stderr === '(unset)\n'));
  if (
    !unset ||
    !Array.isArray(active) ||
    active.length !== 1 ||
    active[0]?.account !== account ||
    active[0]?.status !== 'ACTIVE'
  )
    throw new Error('Existing operator identity unavailable');
}
export function verifyTokenIdentity(value: unknown) {
  const identity = value as { email?: unknown; verified_email?: unknown } | null;
  if (!identity || identity.email !== account || identity.verified_email !== true)
    throw new Error('Operator token identity mismatch');
}
export function localGlobalIndexArgs(kind: 'composite' | 'fields') {
  return [
    'firestore',
    'indexes',
    kind,
    'list',
    `--project=${project}`,
    `--database=${database}`,
    `--account=${account}`,
    '--format=json',
    '--quiet',
  ];
}
export async function readLocalTokenIdentity(response: Response) {
  if (!response.ok || !response.body) throw new Error('Operator identity unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 32768) throw new Error('Operator identity bound');
      chunks.push(next.value);
    }
    verifyTokenIdentity(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
export function localInventoryEnvironment(env: NodeJS.ProcessEnv, token: string, config: string) {
  return {
    PATH: env.PATH,
    HOME: env.HOME,
    CLOUDSDK_CONFIG: config,
    CLOUDSDK_AUTH_ACCESS_TOKEN: token,
    CLOUDSDK_CORE_PROJECT: project,
    CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
    CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: 'true',
  };
}
export function verifyLocalAdmission(
  raw: unknown,
  current: BootstrapReceipt | undefined,
  role: 'agent' | 'web',
) {
  if (disabled(object(raw)) && current?.kind !== 'disabled-bootstrap')
    throw new Error('Disabled current service requires reviewed bootstrap binding');
  if (current)
    verifyCurrentService(current.services[role], raw, current.kind === 'disabled-bootstrap');
}
export function verifyLocalPacketReview(
  evidence: { drainSha256: string; recoverySha256: string } | null | undefined,
  current:
    | { kind: string; drainReceiptSha256?: string; recoveryReceiptSha256?: string }
    | undefined,
  mode: string | undefined,
) {
  if (current?.kind !== 'disabled-bootstrap') return;
  if (
    (mode === 'apply' && !evidence) ||
    (evidence &&
      (evidence.drainSha256 !== current.drainReceiptSha256 ||
        evidence.recoverySha256 !== current.recoveryReceiptSha256))
  )
    throw new Error('Reviewed bootstrap and packet evidence differ');
}
async function main() {
  if (process.argv.length !== 2) throw new Error('Invalid arguments');
  const env = process.env;
  const git = (args: string[]) =>
    execFileSync('git', args, { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 }).trim();
  const head = git(['rev-parse', 'HEAD']);
  verifyLocalOperatorSource(
    env,
    head,
    git(['ls-remote', '--exit-code', 'https://github.com/bmson/assistant.git', 'refs/heads/main']),
    git(['status', '--porcelain', '--untracked-files=all']),
    JSON.parse(readFileSync('infra/gcp/release-contracts.json', 'utf8')),
    lstatSync('apps/web/lib/owner-editor-runtime.ts').isFile(),
  );
  const current = reviewedCurrentEnvironment(env, head);
  const mode = env.OWNER_EDITOR_MAINTENANCE_MODE;
  const isPrepare = mode === 'prepare-initialize' || mode === 'prepare-disable';
  const recipient = isPrepare
    ? readFileSync(env.OWNER_EDITOR_LOCAL_RECIPIENT_FILE ?? '', 'utf8')
    : '';
  if (isPrepare) packetRecipient(recipient);
  const packet = isPrepare
    ? undefined
    : parseOwnerEditorMaintenancePacket(
        JSON.parse(privateFile(env.OWNER_EDITOR_LOCAL_PACKET_FILE ?? '', 8192)),
      );
  verifyLocalPacketReview(packet?.evidence, current, mode);
  if (packet && maintenancePacketDigest(packet) !== env.OWNER_EDITOR_V1_REVIEWED_PACKET_SHA256)
    throw new Error('Reviewed packet digest mismatch');
  if (
    packet &&
    (packet.releaseSha !== head || Date.now() < packet.issuedAt || Date.now() >= packet.expiresAt)
  )
    throw new Error('Reviewed packet source or expiry changed');
  const output = resolve(env.OWNER_EDITOR_LOCAL_OUTPUT_DIRECTORY ?? '');
  const stat = lstatSync(output);
  if (
    !env.OWNER_EDITOR_LOCAL_OUTPUT_DIRECTORY ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('Private output directory required');
  const manifest = readFileSync('infra/gcp/firestore/firestore.indexes.json');
  verifyManifest(manifest);
  const started = Date.now();
  let bytes = 0;
  let inventoryEnv: NodeJS.ProcessEnv | undefined;
  const command = (args: string[], maxBuffer = 2 * 1024 * 1024) => {
    const remaining = started + 60000 - Date.now();
    if (remaining <= 0) throw new Error('Operator collection deadline');
    const value = execFileSync('gcloud', args, {
      encoding: 'utf8',
      timeout: Math.min(8000, remaining),
      maxBuffer,
      stdio: ['ignore', 'pipe', 'pipe'],
      // After independent identity verification every inventory CLI call uses
      // that same token; no configured account/credential fallback is possible.
      env: inventoryEnv ?? env,
    });
    bytes += Buffer.byteLength(value);
    if (bytes > 8 * 1024 * 1024) throw new Error('Operator output bound');
    return value;
  };
  const active = JSON.parse(
    command(['auth', 'list', '--filter=status:ACTIVE', '--format=json'], 32768),
  );
  const remaining = started + 60000 - Date.now();
  if (remaining <= 0) throw new Error('Operator collection deadline');
  // Only this local config read accepts the SDK's exact stderr-unset profile.
  // Retain both streams and process status; never synthesize successful output.
  const impersonation = spawnSync(
    'gcloud',
    ['config', 'get-value', 'auth/impersonate_service_account'],
    {
      encoding: 'utf8',
      timeout: Math.min(8000, remaining),
      maxBuffer: 32768,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    },
  );
  const impersonationBytes =
    Buffer.byteLength(impersonation.stdout ?? '') + Buffer.byteLength(impersonation.stderr ?? '');
  bytes += impersonationBytes;
  if (impersonationBytes > 32768 || bytes > 8 * 1024 * 1024)
    throw new Error('Operator output bound');
  verifyLocalAccount(active, impersonation);
  if (JSON.parse(command(['version', '--format=json'], 32768))['Google Cloud SDK'] !== '586.0.0')
    throw new Error('Unaudited local CLI');
  const token = command(
    ['auth', 'print-access-token', `--account=${account}`, '--quiet'],
    16384,
  ).trim();
  if (!/^[A-Za-z0-9._~-]{20,8192}$/.test(token)) throw new Error('Invalid operator token');
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  await readLocalTokenIdentity(response);
  const config = mkdtempSync(join(tmpdir(), 'owner-editor-local-gcloud-'));
  inventoryEnv = localInventoryEnvironment(env, token, config);
  try {
    const global = {
      composites: parseInventoryList(command(localGlobalIndexArgs('composite'))),
      fields: parseInventoryList(command(localGlobalIndexArgs('fields'))),
      evidence: 'reviewed-local-gcloud-586-complete-lists' as const,
    };
    const read = createReadOnlyGet(token, started + 60000);
    const receipt = await collectInventory(
      read,
      manifest,
      Date.now(),
      global,
      undefined,
      undefined,
      current,
    );
    if (receipt.services.some((s) => s.admissionDisabled) && current?.kind !== 'disabled-bootstrap')
      throw new Error('Disabled current pair requires reviewed bootstrap binding');
    if (
      receipt.indexes.status !== 'exact_manifest_parity' ||
      !['pitr', 'backup'].includes(receipt.recoveryPoint.kind) ||
      Date.now() - Date.parse(receipt.observedAt) > 120000
    )
      throw new Error('Prerequisites unproven');
    const targets = [];
    for (const service of ['agent', 'web'] as const) {
      const rawCurrent = await read(
        `https://run.googleapis.com/v2/projects/${project}/locations/us-west1/services/assistant-${service}`,
      );
      verifyLocalAdmission(rawCurrent, current, service);
      const facts = serviceFacts(rawCurrent, service);
      const prior = receipt.services.find((s) => s.service === service);
      if (
        !prior ||
        facts.revision !== prior.revision ||
        facts.observedTemplateHash !== prior.observedTemplateHash
      )
        throw new Error('Serving target changed');
      targets.push(facts.editorMetadataTarget);
    }
    const target = targets[0];
    if (
      !target ||
      JSON.stringify(target) !== JSON.stringify(targets[1]) ||
      (packet &&
        (packet.target.ownerId !== target.ownerId ||
          packet.target.installationId !== target.workspaceId))
    )
      throw new Error('Owner target unbound');
    writeFileSync(
      resolve(output, 'operator-prerequisites.json'),
      `${JSON.stringify({
        ...receipt,
        candidateSource: head,
        operatorSource: head,
        observationIdentity: {
          principal: account,
          binding: 'Google userinfo checked access token; explicit existing-user transport',
        },
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const auth = new OAuth2Client();
    auth.setCredentials({ access_token: token }); // No refresh token or ambient ADC fallback.
    const store = createInstallationStore({
      projectId: project,
      databaseId: database,
      installationId: target.workspaceId,
      authClient: auth,
    });
    try {
      if (isPrepare) {
        const proposal = await prepareOwnerEditorMaintenance(store, {
          ownerId: target.ownerId,
          action: mode === 'prepare-disable' ? 'disable' : 'initialize',
          releaseSha: head,
          now: Date.now(),
        });
        writeFileSync(
          resolve(output, 'owner-editor-v1-packet.encrypted.json'),
          `${JSON.stringify(encryptMaintenancePacket(proposal, recipient))}\n`,
          { flag: 'wx', mode: 0o600 },
        );
        process.stdout.write(
          `${JSON.stringify({ outcome: 'prepared_encrypted', wrote: false, activationApprovalRequired: true })}\n`,
        );
      } else {
        if (!packet || (mode !== 'dry-run' && mode !== 'apply'))
          throw new Error('Missing operation');
        const result = await runOwnerEditorMaintenance(store, packet, {
          mode,
          releaseSha: head,
          now: Date.now,
        });
        process.stdout.write(
          `${JSON.stringify({ ...result, packetSha256: maintenancePacketDigest(packet), editingDeliveryProven: false })}\n`,
        );
      }
    } finally {
      await store.db.terminate();
    }
  } finally {
    rmSync(config, { recursive: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    process.stderr.write(
      'Local operator maintenance failed. No automatic retry, fallback identity or authority inferred.\n',
    );
    process.exitCode = 1;
  });
