import { createHash, createPublicKey, verify } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import type { ArchivedRoleEvidence } from './owner-archived-runtime-pack.js';
import { bootstrapDigest, object } from './owner-release-current-snapshot.js';
import { boundedResponseJson } from './owner-web-release-operator-hold.js';

const require = createRequire(import.meta.url);
const { API3_RECOVERY_REVIEW_PUBLIC_KEY } =
  require('../infra/gcp/api3-recovery-review-key.mjs') as {
    API3_RECOVERY_REVIEW_PUBLIC_KEY: string;
  };

export const maintenanceRunName = 'owner-release-before-maintenance';
export const maintenanceWorkflowPath = '.github/workflows/owner-editor-v1-maintenance.yml';
export const maintenanceWorkflowRef = `bmson/assistant/${maintenanceWorkflowPath}@refs/heads/main`;
export const maintenanceRunDomain = 'owner-release-before-maintenance-v1\0';
const sourcePattern = /^[a-f0-9]{40}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const positiveId = /^[1-9][0-9]{0,19}$/;
const maxReviewAge = 30 * 60_000;

function check(value: unknown): asserts value {
  if (!value) throw new Error('Protected before-maintenance evidence held');
}

function exact(value: unknown, keys: string[]) {
  const row = object(value);
  check(Object.keys(row).sort().join(',') === keys.sort().join(','));
  return row;
}

function decode(value: unknown, max: number) {
  check(
    typeof value === 'string' &&
      /^[A-Za-z0-9_-]+$/.test(value) &&
      value.length <= Math.ceil((max * 4) / 3),
  );
  const bytes = Buffer.from(value, 'base64url');
  check(bytes.length <= max && bytes.toString('base64url') === value);
  return bytes;
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

export function readBeforeMaintenanceIntent(
  envelope: string,
  source: string,
  key = API3_RECOVERY_REVIEW_PUBLIC_KEY,
  now = Date.now(),
) {
  check(Buffer.byteLength(envelope) > 0 && Buffer.byteLength(envelope) <= 8192);
  const outer = exact(JSON.parse(envelope), ['payload', 'signature']);
  const bytes = decode(outer.payload, 4096);
  const signature = decode(outer.signature, 64);
  const publicKey = createPublicKey({ key: decode(key, 128), format: 'der', type: 'spki' });
  check(
    publicKey.asymmetricKeyType === 'ed25519' &&
      signature.length === 64 &&
      verify(null, Buffer.concat([Buffer.from(maintenanceRunDomain), bytes]), publicKey, signature),
  );
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const row = exact(JSON.parse(text), [
    'format',
    'kind',
    'source',
    'workflowRef',
    'project',
    'region',
    'database',
    'generation',
    'objectSha256',
    'packSha256',
    'nativeBindingSha256',
    'recoveryEvidenceSha256',
    'candidateBuildRunId',
    'candidateBuildSha256',
    'candidateReviewSha256',
    'reviewedAt',
    'expiresAt',
  ]);
  check(
    JSON.stringify(row) === text &&
      row.format === 1 &&
      row.kind === maintenanceRunName &&
      sourcePattern.test(source) &&
      row.source === source &&
      row.workflowRef === maintenanceWorkflowRef &&
      row.project === 'bmson-assistant' &&
      row.region === 'us-west1' &&
      row.database === 'assistant-production' &&
      matches(row.generation, positiveId) &&
      matches(row.objectSha256, hashPattern) &&
      matches(row.packSha256, hashPattern) &&
      matches(row.nativeBindingSha256, hashPattern) &&
      matches(row.recoveryEvidenceSha256, hashPattern) &&
      matches(row.candidateBuildRunId, positiveId) &&
      matches(row.candidateBuildSha256, hashPattern) &&
      matches(row.candidateReviewSha256, hashPattern) &&
      typeof row.reviewedAt === 'number' &&
      Number.isSafeInteger(row.reviewedAt) &&
      typeof row.expiresAt === 'number' &&
      Number.isSafeInteger(row.expiresAt) &&
      row.reviewedAt > 0 &&
      row.reviewedAt <= now &&
      now < row.expiresAt &&
      row.expiresAt - row.reviewedAt <= maxReviewAge,
  );
  return {
    intentSha256: createHash('sha256').update(bytes).digest('hex'),
    source,
    generation: row.generation,
    objectSha256: row.objectSha256,
    packSha256: row.packSha256,
    nativeBindingSha256: row.nativeBindingSha256,
    recoveryEvidenceSha256: row.recoveryEvidenceSha256,
    candidateBuildRunId: row.candidateBuildRunId,
    candidateBuildSha256: row.candidateBuildSha256,
    candidateReviewSha256: row.candidateReviewSha256,
    reviewedAt: row.reviewedAt,
    expiresAt: row.expiresAt,
  };
}

export function protectedBeforeMaintenanceContext(env: NodeJS.ProcessEnv, head: string) {
  check(
    sourcePattern.test(head) &&
      env.GITHUB_ACTIONS === 'true' &&
      env.GITHUB_REPOSITORY === 'bmson/assistant' &&
      env.GITHUB_REF === 'refs/heads/main' &&
      env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      env.GITHUB_WORKFLOW_REF === maintenanceWorkflowRef &&
      env.GITHUB_SHA === head &&
      env.GITHUB_WORKFLOW_SHA === head &&
      env.OWNER_EDITOR_RELEASE_SHA === head &&
      env.GITHUB_JOB === 'maintenance' &&
      env.GITHUB_RUN_ATTEMPT === '1' &&
      matches(env.GITHUB_RUN_ID, positiveId) &&
      env.GCP_PROJECT === 'bmson-assistant' &&
      env.OWNER_EDITOR_MAINTENANCE_MODE === 'before-maintenance' &&
      !env.OWNER_EDITOR_V1_REVIEWED_PACKET &&
      !env.OWNER_EDITOR_V1_REVIEWED_PACKET_SHA256 &&
      !env.OWNER_EDITOR_PACKET_RECIPIENT_PUBLIC_KEY,
  );
  const intent = readBeforeMaintenanceIntent(
    env.OWNER_RELEASE_BEFORE_MAINTENANCE_INTENT ?? '',
    head,
  );
  check(
    intent.candidateBuildRunId !== env.GITHUB_RUN_ID &&
      env.OWNER_ARCHIVED_RUNTIME_GENERATION === intent.generation &&
      env.OWNER_ARCHIVED_RUNTIME_OBJECT_SHA256 === intent.objectSha256,
  );
  return { intent, runId: env.GITHUB_RUN_ID };
}

export async function readTrustedMaintenanceRun(
  runId: string,
  source: string,
  token: string,
  request: typeof fetch = fetch,
) {
  check(
    positiveId.test(runId) && sourcePattern.test(source) && /^[A-Za-z0-9._~-]{1,4096}$/.test(token),
  );
  const response = await request(
    `https://api.github.com/repos/bmson/assistant/actions/runs/${runId}/attempts/1`,
    {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  const run = object(await boundedResponseJson(response, 32768));
  check(
    String(run.id) === runId &&
      run.run_attempt === 1 &&
      run.event === 'workflow_dispatch' &&
      run.head_sha === source &&
      run.head_branch === 'main' &&
      run.path === maintenanceWorkflowPath &&
      run.status === 'in_progress' &&
      object(run.repository).full_name === 'bmson/assistant' &&
      object(run.head_repository).full_name === 'bmson/assistant',
  );
  return bootstrapDigest({
    runId,
    source,
    event: run.event,
    workflowPath: run.path,
    attempt: run.run_attempt,
  });
}

export function archivedOriginalReceiptBinding(pack: {
  nativeBinding: unknown;
  roles: Record<'agent' | 'web', ArchivedRoleEvidence>;
}) {
  const bindings = exact(pack.nativeBinding, ['format', 'roles']);
  check(bindings.format === 1);
  const roles = exact(bindings.roles, ['agent', 'web']);
  const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  function roleBinding(role: 'agent' | 'web') {
    const row = object(roles[role]);
    check(
      matches(row.revision, new RegExp(`^assistant-${role}-[a-z0-9-]{1,63}$`)) &&
        matches(row.serviceUidSha256, hashPattern) &&
        matches(row.revisionUidSha256, hashPattern),
    );
    return {
      revision: row.revision,
      serviceUidSha256: row.serviceUidSha256,
      revisionUidSha256: row.revisionUidSha256,
      parent: digest(pack.roles[role].parent),
      child: digest(pack.roles[role].child),
    };
  }
  return { agent: roleBinding('agent'), web: roleBinding('web') };
}

export function createBeforeMaintenanceReceipt(input: {
  intent: ReturnType<typeof readBeforeMaintenanceIntent>;
  runId: string;
  runIdentitySha256: string;
  archivedReadbackSha256: string;
  original: ReturnType<typeof archivedOriginalReceiptBinding>;
  observedAt: number;
}) {
  const { intent, runId, runIdentitySha256, archivedReadbackSha256, original, observedAt } = input;
  check(
    positiveId.test(runId) &&
      hashPattern.test(runIdentitySha256) &&
      hashPattern.test(archivedReadbackSha256) &&
      Number.isSafeInteger(observedAt) &&
      observedAt >= intent.reviewedAt &&
      observedAt < intent.expiresAt,
  );
  return {
    format: 1,
    kind: maintenanceRunName,
    source: intent.source,
    runId,
    attempt: '1',
    workflowRef: maintenanceWorkflowRef,
    workflowSha: intent.source,
    runIdentitySha256,
    intentSha256: intent.intentSha256,
    archiveGeneration: intent.generation,
    archiveObjectSha256: intent.objectSha256,
    packSha256: intent.packSha256,
    nativeBindingSha256: intent.nativeBindingSha256,
    recoveryEvidenceSha256: intent.recoveryEvidenceSha256,
    candidateBuildRunId: intent.candidateBuildRunId,
    candidateBuildSha256: intent.candidateBuildSha256,
    candidateReviewSha256: intent.candidateReviewSha256,
    original,
    archivedReadbackSha256,
    observedAt,
    expiresAt: intent.expiresAt,
    recoveryTargetsReadBack: true,
    mutationAuthorized: false,
    admissionChangePerformed: false,
  } as const;
}

export function writeBeforeMaintenanceReceipt(
  directory: string,
  receipt: ReturnType<typeof createBeforeMaintenanceReceipt>,
) {
  check(directory.startsWith('/') && basename(directory).length > 0);
  writeFileSync(join(directory, `${maintenanceRunName}.json`), `${JSON.stringify(receipt)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}
