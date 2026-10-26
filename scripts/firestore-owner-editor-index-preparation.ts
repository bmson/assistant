import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import {
  ConsumerIndexBuildingError,
  provisionTargetFirestoreIndexes,
  verifyConsumerIndexReadiness,
  waitForConsumerIndexReadiness,
} from '../packages/setup/src/consumer-index-readiness.js';
import type { InstallationIdentity } from '../packages/setup/src/installation-manifest.js';
import { type CommandRunner, systemRunner } from '../packages/setup/src/runner.js';

const execFileAsync = promisify(execFile);
export const BASELINE_COMMIT = '236a35a5e05163855c9b708414bf389d90cd15c2';
export const APPROVED_SOURCE_COMMIT = '61c74edd9c67a77814d148565fb82651c0e2091e';
export const BASELINE_SHA256 = 'f76e7670a29973fe21394b3a96220846b006ca7783efa412235a8550d8163be6';
export const APPROVED_SHA256 = '5baaca10aa089b2eac771de7c9086317206bd937d09a89ea6e937ac945e03cd1';
export const TARGET_PROJECT_ID = 'bmson-assistant';
export const TARGET_DATABASE_ID = 'assistant-production';
export const TARGET_REGION = 'us-west1';
export const REQUIRED_FIRESTORE_PERMISSIONS = [
  'datastore.indexes.create',
  'datastore.indexes.get',
  'datastore.indexes.list',
] as const;
const MAX_DEPLOY_RUN_PAGES = 50;
const DEPLOY_RUNS_TIMEOUT_MS = 30_000;
const MAX_POLICY_EXPLANATION_BYTES = 1024 * 1024;
const POLICY_TROUBLESHOOTER_ENDPOINT =
  'https://policytroubleshooter.googleapis.com/v3/iam:troubleshoot';
const FIRESTORE_DATABASE_RESOURCE =
  '//firestore.googleapis.com/projects/bmson-assistant/databases/assistant-production';
const MANIFEST_PATH = 'infra/gcp/firestore/firestore.indexes.json';
const APPROVED_INDEX = {
  collectionGroup: 'ownerEditorOperations',
  queryScope: 'COLLECTION',
  fields: [
    { fieldPath: 'ownerId', order: 'ASCENDING' },
    { fieldPath: 'formIssuedAt', order: 'ASCENDING' },
    { fieldPath: 'id', order: 'ASCENDING' },
  ],
};

export type ActiveDeployCheck = () => Promise<void>;
export type PermissionCheck = () => Promise<void>;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function parseManifest(
  bytes: Buffer,
  label: string,
): { indexes: unknown[]; fieldOverrides: unknown[] } {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} manifest is invalid JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} manifest is malformed`);
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.indexes) || !Array.isArray(record.fieldOverrides))
    throw new Error(`${label} manifest is malformed`);
  return { indexes: record.indexes, fieldOverrides: record.fieldOverrides };
}

/** Verify byte-pinned provenance and the sole approved structural delta. */
export function ownerEditorIndexDelta(baselineBytes: Buffer, approvedBytes: Buffer): Buffer {
  if (sha256(baselineBytes) !== BASELINE_SHA256)
    throw new Error('Pinned baseline manifest hash mismatch');
  if (sha256(approvedBytes) !== APPROVED_SHA256) throw new Error('Approved manifest hash mismatch');
  const baseline = parseManifest(baselineBytes, 'Baseline');
  const approved = parseManifest(approvedBytes, 'Approved');
  const additions = approved.indexes.filter(
    (item) => !baseline.indexes.some((old) => canonical(old) === canonical(item)),
  );
  const removals = baseline.indexes.filter(
    (item) => !approved.indexes.some((next) => canonical(item) === canonical(next)),
  );
  if (
    additions.length !== 1 ||
    canonical(additions[0]) !== canonical(APPROVED_INDEX) ||
    removals.length !== 0
  )
    throw new Error('Approved manifest must add only the owner editor operations index');
  if (canonical(baseline.fieldOverrides) !== canonical(approved.fieldOverrides))
    throw new Error('Approved manifest changes field overrides');
  return Buffer.from(JSON.stringify({ indexes: [APPROVED_INDEX], fieldOverrides: [] }));
}

/**
 * Prepare exactly the approved owner-editor index. Existing canonical helpers
 * remain authoritative for database inventory, creation, and READY checks.
 */
export async function prepareOwnerEditorIndex(input: {
  runner: CommandRunner;
  identity: InstallationIdentity;
  baselineBytes: Buffer;
  approvedBytes: Buffer;
  assertNoActiveDeployRuns: ActiveDeployCheck;
  assertPermissions: PermissionCheck;
  wait?: (runner: CommandRunner, identity: InstallationIdentity, spec: Buffer) => Promise<void>;
}): Promise<'already-ready' | 'created'> {
  const delta = ownerEditorIndexDelta(input.baselineBytes, input.approvedBytes);
  await input.assertPermissions();
  try {
    await verifyConsumerIndexReadiness(input.runner, input.identity, input.approvedBytes);
    await input.assertNoActiveDeployRuns();
    return 'already-ready';
  } catch (error) {
    if (error instanceof ConsumerIndexBuildingError) {
      const wait =
        input.wait ??
        ((runner, identity, spec) => waitForConsumerIndexReadiness(runner, identity, spec));
      await wait(input.runner, input.identity, input.approvedBytes);
      await input.assertNoActiveDeployRuns();
      return 'already-ready';
    }
    // READY exact target inventory is idempotent. Every other failure is
    // accepted for baseline classification only if the full target verifier
    // proves that it is precisely the approved union (including a CREATING
    // owner index, which the bounded canonical waiter can resolve).
  }

  let baselineIsExact = false;
  try {
    await verifyConsumerIndexReadiness(input.runner, input.identity, input.baselineBytes);
    baselineIsExact = true;
  } catch (error) {
    // Baseline must be exact and READY before a create. If the full target is
    // not already present or building, its verifier below fails closed.
    if (error instanceof Error && /is CREATING|not READY/.test(error.message)) throw error;
  }
  if (!baselineIsExact) {
    const wait =
      input.wait ??
      ((runner, identity, spec) => waitForConsumerIndexReadiness(runner, identity, spec));
    await wait(input.runner, input.identity, input.approvedBytes);
    await input.assertNoActiveDeployRuns();
    return 'already-ready';
  }

  await input.assertNoActiveDeployRuns();
  const created = await provisionTargetFirestoreIndexes(input.runner, input.identity, delta);
  if (created.indexesCreated !== 1 || created.exemptionsCreated !== 0)
    throw new Error('Index preparation did not submit exactly one index and zero field changes');
  const wait =
    input.wait ??
    ((runner, identity, spec) => waitForConsumerIndexReadiness(runner, identity, spec));
  await wait(input.runner, input.identity, input.approvedBytes);
  await input.assertNoActiveDeployRuns();
  await verifyConsumerIndexReadiness(input.runner, input.identity, input.approvedBytes);
  return 'created';
}

/** Paginate both nonterminal statuses; API or pagination uncertainty fails closed. */
export async function assertNoActiveProductionDeployRuns(input: {
  repository: string;
  token: string;
  currentRunId: string;
  fetcher?: typeof fetch;
}): Promise<void> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository))
    throw new Error('Deploy run listing repository identity is malformed');
  const fetcher = input.fetcher ?? fetch;
  const endpointPath = `/repos/${input.repository}/actions/workflows/deploy.yml/runs`;
  const active: string[] = [];
  const deadline = Date.now() + DEPLOY_RUNS_TIMEOUT_MS;
  let url: string | null = `https://api.github.com${endpointPath}?per_page=100`;
  const seen = new Set<string>();
  const seenRunIds = new Set<number>();
  let received = 0;
  let totalCount: number | null = null;
  let pages = 0;
  while (url) {
    if (Date.now() >= deadline || pages >= MAX_DEPLOY_RUN_PAGES)
      throw new Error('Deploy run listing exceeded its bounded completeness limit');
    if (seen.has(url)) throw new Error('Deploy run listing pagination loop');
    seen.add(url);
    pages++;
    const response: Response = await fetcher(url, {
      headers: {
        authorization: `Bearer ${input.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    if (!response.ok) throw new Error(`Deploy run listing failed (${response.status})`);
    const body: unknown = await response.json();
    if (
      !body ||
      typeof body !== 'object' ||
      !Array.isArray((body as { workflow_runs?: unknown }).workflow_runs) ||
      !Number.isSafeInteger((body as { total_count?: unknown }).total_count)
    )
      throw new Error('Deploy run listing returned malformed data');
    if (totalCount === null) {
      totalCount = (body as { total_count: number }).total_count;
      if (totalCount < 0 || totalCount > MAX_DEPLOY_RUN_PAGES * 100)
        throw new Error('Deploy run listing exceeds its bounded completeness limit');
    } else if (totalCount !== (body as { total_count: number }).total_count) {
      throw new Error('Deploy run listing changed during pagination');
    }
    const runs = (body as { workflow_runs: unknown[] }).workflow_runs;
    if (runs.length > 100 || received + runs.length > totalCount)
      throw new Error('Deploy run listing page exceeds its count bounds');
    for (const raw of runs) {
      if (!raw || typeof raw !== 'object') throw new Error('Deploy run record is malformed');
      const run = raw as Record<string, unknown>;
      if (
        typeof run.status !== 'string' ||
        typeof run.id !== 'number' ||
        !Number.isSafeInteger(run.id) ||
        run.id <= 0 ||
        typeof run.head_branch !== 'string'
      )
        throw new Error('Deploy run record has unknown status or identity');
      if (seenRunIds.has(run.id))
        throw new Error(`Deploy run listing contains duplicate run ID ${run.id}`);
      seenRunIds.add(run.id);
      if (
        !['queued', 'in_progress', 'waiting', 'requested', 'pending', 'completed'].includes(
          run.status,
        )
      )
        throw new Error(`Deploy run listing returned unknown status ${run.status}`);
      if (
        String(run.id) !== input.currentRunId &&
        run.head_branch === 'main' &&
        run.status !== 'completed'
      )
        active.push(`${run.status}:${run.id}`);
    }
    received += runs.length;
    const link: string = response.headers.get('link') ?? '';
    const next: string | undefined = link
      .split(',')
      .map((part: string) => part.trim())
      .find((part: string) => /rel="next"/.test(part));
    if (next && !next.match(/<([^>]+)>/)?.[1])
      throw new Error('Deploy run listing has malformed pagination');
    const nextUrl: string | null = next?.match(/<([^>]+)>/)?.[1] ?? null;
    if (nextUrl) {
      const parsedNext = new URL(nextUrl);
      if (
        parsedNext.origin !== 'https://api.github.com' ||
        parsedNext.username !== '' ||
        parsedNext.password !== '' ||
        parsedNext.hash !== '' ||
        parsedNext.pathname !== endpointPath ||
        parsedNext.searchParams.size !== 2 ||
        parsedNext.searchParams.getAll('per_page').length !== 1 ||
        parsedNext.searchParams.getAll('page').length !== 1 ||
        parsedNext.searchParams.get('per_page') !== '100' ||
        parsedNext.searchParams.get('page') !== String(pages + 1) ||
        runs.length === 0
      )
        throw new Error('Deploy run listing has an unexpected pagination destination');
    }
    url = nextUrl;
  }
  if (received !== totalCount)
    throw new Error('Deploy run listing ended before every page was read');
  if (active.length)
    throw new Error(`Production deploy runs are still queued or running: ${active.join(', ')}`);
}

function argument(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment value ${name} is missing`);
  return value;
}

export function resolveTargetIdentity(projectId: string, databaseId: string): InstallationIdentity {
  if (projectId !== TARGET_PROJECT_ID || databaseId !== TARGET_DATABASE_ID)
    throw new Error(
      'Refusing any Firestore target other than the pinned production project/database',
    );
  return {
    installationId: 'existing-database-owner-editor-index-preparation',
    projectId,
    databaseId,
    region: TARGET_REGION,
    release: { commitSha: APPROVED_SOURCE_COMMIT, archiveDigest: `sha256:${APPROVED_SHA256}` },
  };
}

function targetIdentity(): InstallationIdentity {
  return resolveTargetIdentity(argument('GCP_PROJECT'), argument('FIRESTORE_DATABASE_ID'));
}

export async function assertFirestoreIndexPermissions(input: {
  projectId: string;
  databaseId: string;
  principal: string;
  token: string;
  fetcher?: typeof fetch;
}): Promise<void> {
  if (input.projectId !== TARGET_PROJECT_ID || input.databaseId !== TARGET_DATABASE_ID)
    throw new Error('Permission preflight target does not match pinned production database');
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(input.principal))
    throw new Error('Permission preflight principal is not a service account email');
  for (const permission of REQUIRED_FIRESTORE_PERMISSIONS) {
    const accessTuple = {
      principal: input.principal,
      fullResourceName: FIRESTORE_DATABASE_RESOURCE,
      permission,
    };
    const response = await (input.fetcher ?? fetch)(POLICY_TROUBLESHOOTER_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ accessTuple }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`Firestore policy preflight failed for ${permission} (${response.status})`);
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_POLICY_EXPLANATION_BYTES)
      throw new Error(`Firestore policy preflight exceeded its size limit for ${permission}`);
    let explanation: unknown;
    try {
      explanation = JSON.parse(raw);
    } catch {
      throw new Error(`Firestore policy preflight returned invalid JSON for ${permission}`);
    }
    validateUnconditionalPermissionGrant(explanation, accessTuple);
  }
}

function hasUnknownPolicyState(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('UNKNOWN') || value.includes('UNSPECIFIED');
  if (Array.isArray(value)) return value.some(hasUnknownPolicyState);
  if (value && typeof value === 'object')
    return Object.values(value as Record<string, unknown>).some(hasUnknownPolicyState);
  return false;
}

function validatePolicyEnums(value: unknown, key = ''): void {
  const knownByKey: Record<string, readonly string[]> = {
    overallAccessState: [
      'CAN_ACCESS',
      'CANNOT_ACCESS',
      'UNKNOWN_INFO',
      'UNKNOWN_CONDITIONAL',
      'OVERALL_ACCESS_STATE_UNSPECIFIED',
    ],
    allowAccessState: [
      'ALLOW_ACCESS_STATE_GRANTED',
      'ALLOW_ACCESS_STATE_NOT_GRANTED',
      'ALLOW_ACCESS_STATE_UNKNOWN_CONDITIONAL',
      'ALLOW_ACCESS_STATE_UNKNOWN_INFO',
      'ALLOW_ACCESS_STATE_UNSPECIFIED',
    ],
    denyAccessState: [
      'DENY_ACCESS_STATE_DENIED',
      'DENY_ACCESS_STATE_NOT_DENIED',
      'DENY_ACCESS_STATE_UNKNOWN_CONDITIONAL',
      'DENY_ACCESS_STATE_UNKNOWN_INFO',
      'DENY_ACCESS_STATE_UNSPECIFIED',
    ],
    rolePermission: [
      'ROLE_PERMISSION_INCLUDED',
      'ROLE_PERMISSION_NOT_INCLUDED',
      'ROLE_PERMISSION_UNKNOWN_INFO',
      'ROLE_PERMISSION_UNSPECIFIED',
    ],
    membership: [
      'MEMBERSHIP_MATCHED',
      'MEMBERSHIP_NOT_MATCHED',
      'MEMBERSHIP_UNKNOWN_INFO',
      'MEMBERSHIP_UNKNOWN_UNSUPPORTED',
      'MEMBERSHIP_UNSPECIFIED',
    ],
    relevance: [
      'HEURISTIC_RELEVANCE_HIGH',
      'HEURISTIC_RELEVANCE_NORMAL',
      'HEURISTIC_RELEVANCE_UNSPECIFIED',
    ],
    rolePermissionRelevance: [
      'HEURISTIC_RELEVANCE_HIGH',
      'HEURISTIC_RELEVANCE_NORMAL',
      'HEURISTIC_RELEVANCE_UNSPECIFIED',
    ],
  };
  if (key in knownByKey && (typeof value !== 'string' || !knownByKey[key]?.includes(value)))
    throw new Error(`Policy Troubleshooter returned an unknown ${key} value`);
  if (Array.isArray(value)) {
    for (const item of value) validatePolicyEnums(item);
  } else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>))
      validatePolicyEnums(child, childKey);
  }
}

/** Accept only a known direct service-account binding without an IAM condition. */
export function validateUnconditionalPermissionGrant(
  response: unknown,
  accessTuple: { principal: string; fullResourceName: string; permission: string },
): void {
  const record =
    response && typeof response === 'object' && !Array.isArray(response)
      ? (response as Record<string, unknown>)
      : null;
  if (!record || Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_POLICY_EXPLANATION_BYTES)
    throw new Error('Policy Troubleshooter explanation is malformed or oversized');
  const returnedTuple = record.accessTuple;
  if (!returnedTuple || typeof returnedTuple !== 'object' || Array.isArray(returnedTuple))
    throw new Error('Policy Troubleshooter returned no exact access tuple');
  const tuple = returnedTuple as Record<string, unknown>;
  if (
    tuple.principal !== accessTuple.principal ||
    tuple.fullResourceName !== accessTuple.fullResourceName ||
    tuple.permission !== accessTuple.permission
  )
    throw new Error('Policy Troubleshooter changed the principal/resource/permission tuple');
  const allow = record.allowPolicyExplanation as Record<string, unknown> | undefined;
  const deny = record.denyPolicyExplanation as Record<string, unknown> | undefined;
  if (
    record.overallAccessState !== 'CAN_ACCESS' ||
    !allow ||
    allow.allowAccessState !== 'ALLOW_ACCESS_STATE_GRANTED' ||
    !deny ||
    deny.denyAccessState !== 'DENY_ACCESS_STATE_NOT_DENIED' ||
    hasUnknownPolicyState(record)
  )
    throw new Error(
      'Policy Troubleshooter reports denied, conditional, unknown, or incomplete access',
    );
  validatePolicyEnums(record);
  const policies = allow.explainedPolicies;
  if (!Array.isArray(policies) || policies.length === 0 || policies.length > 100)
    throw new Error('Policy Troubleshooter returned incomplete applicable allow policies');
  const directMember = `serviceAccount:${accessTuple.principal}`;
  let unconditionalGrantFound = false;
  for (const rawPolicy of policies) {
    if (!rawPolicy || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy))
      throw new Error('Policy Troubleshooter returned a malformed allow policy');
    const policy = rawPolicy as Record<string, unknown>;
    if (
      typeof policy.fullResourceName !== 'string' ||
      !policy.policy ||
      typeof policy.policy !== 'object' ||
      Array.isArray(policy.policy)
    )
      throw new Error('Policy Troubleshooter omitted policy identity or policy bindings');
    const policyBody = policy.policy as Record<string, unknown>;
    const bindings = policyBody.bindings;
    const explanations = policy.bindingExplanations;
    if (
      !Array.isArray(bindings) ||
      !Array.isArray(explanations) ||
      bindings.length !== explanations.length
    )
      throw new Error('Policy Troubleshooter policy/binding explanations are incomplete');
    for (let index = 0; index < bindings.length; index++) {
      const binding = bindings[index];
      const explanation = explanations[index];
      if (
        !binding ||
        typeof binding !== 'object' ||
        Array.isArray(binding) ||
        !explanation ||
        typeof explanation !== 'object' ||
        Array.isArray(explanation)
      )
        throw new Error('Policy Troubleshooter returned a malformed binding explanation');
      const bindingRecord = binding as Record<string, unknown>;
      const explanationRecord = explanation as Record<string, unknown>;
      if (typeof bindingRecord.role !== 'string' || bindingRecord.role !== explanationRecord.role)
        throw new Error('Policy Troubleshooter binding role correspondence is unknown');
      const members = bindingRecord.members;
      const memberships = explanationRecord.memberships;
      if (
        !Array.isArray(members) ||
        members.some((member) => typeof member !== 'string') ||
        !memberships ||
        typeof memberships !== 'object' ||
        Array.isArray(memberships) ||
        !explanationRecord.combinedMembership ||
        typeof explanationRecord.combinedMembership !== 'object' ||
        Array.isArray(explanationRecord.combinedMembership)
      )
        throw new Error('Policy Troubleshooter membership explanations are incomplete');
      const membershipMap = memberships as Record<string, unknown>;
      if (
        Object.keys(membershipMap).length !== members.length ||
        members.some((member) => !Object.hasOwn(membershipMap, member))
      )
        throw new Error('Policy Troubleshooter binding membership details are incomplete');
      for (const membership of Object.values(membershipMap)) {
        if (!membership || typeof membership !== 'object' || Array.isArray(membership))
          throw new Error('Policy Troubleshooter returned malformed membership details');
      }
      const directMembership = membershipMap[directMember];
      const combinedMembership = explanationRecord.combinedMembership;
      const matchedDirect =
        Array.isArray(members) &&
        members.includes(directMember) &&
        !!directMembership &&
        typeof directMembership === 'object' &&
        (directMembership as Record<string, unknown>).membership === 'MEMBERSHIP_MATCHED' &&
        !!combinedMembership &&
        typeof combinedMembership === 'object' &&
        (combinedMembership as Record<string, unknown>).membership === 'MEMBERSHIP_MATCHED';
      const unconditional =
        !Object.hasOwn(bindingRecord, 'condition') &&
        !Object.hasOwn(explanationRecord, 'condition') &&
        !Object.hasOwn(explanationRecord, 'conditionExplanation');
      const bindingGrantsPrincipal =
        explanationRecord.allowAccessState === 'ALLOW_ACCESS_STATE_GRANTED' &&
        explanationRecord.rolePermission === 'ROLE_PERMISSION_INCLUDED' &&
        !!combinedMembership &&
        typeof combinedMembership === 'object' &&
        (combinedMembership as Record<string, unknown>).membership === 'MEMBERSHIP_MATCHED';
      if (bindingGrantsPrincipal && !unconditional)
        throw new Error('A conditional binding participates in the required permission grant');
      if (
        explanationRecord.allowAccessState === 'ALLOW_ACCESS_STATE_GRANTED' &&
        explanationRecord.rolePermission === 'ROLE_PERMISSION_INCLUDED' &&
        matchedDirect &&
        unconditional
      )
        unconditionalGrantFound = true;
    }
  }
  if (!unconditionalGrantFound)
    throw new Error(
      'No direct unconditional service-account binding grants the required permission',
    );
}

export function assertKnownArguments(args: string[]): '--verify-source' | 'prepare' {
  if (args.length === 0) return 'prepare';
  if (args.length === 1 && args[0] === '--verify-source') return '--verify-source';
  throw new Error('Unknown command-line arguments; refusing to continue');
}

export function assertActiveGcloudPrincipal(
  activeAccount: string,
  expectedServiceAccount: string,
): void {
  if (!expectedServiceAccount || activeAccount.trim() !== expectedServiceAccount)
    throw new Error(
      'Active gcloud principal does not match the configured production deploy service account',
    );
}

async function main(): Promise<void> {
  const mode = assertKnownArguments(process.argv.slice(2));
  const { stdout: baselineText } = await execFileAsync(
    'git',
    ['show', `${BASELINE_COMMIT}:${MANIFEST_PATH}`],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  const baselineBytes = Buffer.from(baselineText);
  const sourceDirectory = process.env.APPROVED_SOURCE_DIR || '.';
  const { stdout: approvedText } = await execFileAsync(
    'git',
    ['-C', sourceDirectory, 'show', `${APPROVED_SOURCE_COMMIT}:${MANIFEST_PATH}`],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  const approvedBytes = Buffer.from(approvedText);
  ownerEditorIndexDelta(baselineBytes, approvedBytes);
  if (mode === '--verify-source') {
    targetIdentity();
    argument('GCP_WORKLOAD_IDENTITY_PROVIDER');
    argument('GCP_DEPLOY_SERVICE_ACCOUNT');
    process.stdout.write('Pinned baseline and approved index delta verified.\n');
    return;
  }
  const identity = targetIdentity();
  const expectedServiceAccount = argument('GCP_DEPLOY_SERVICE_ACCOUNT');
  const { stdout: activeAccountText } = await execFileAsync('gcloud', [
    'auth',
    'list',
    '--filter=status:ACTIVE',
    '--format=value(account)',
  ]);
  const activeAccount = activeAccountText.trim();
  assertActiveGcloudPrincipal(activeAccount, expectedServiceAccount);
  const { stdout: accessToken } = await execFileAsync('gcloud', ['auth', 'print-access-token']);
  const { projectId, databaseId } = identity;
  await prepareOwnerEditorIndex({
    runner: systemRunner,
    identity,
    baselineBytes,
    approvedBytes,
    assertPermissions: () =>
      assertFirestoreIndexPermissions({
        projectId,
        databaseId,
        principal: expectedServiceAccount,
        token: accessToken.trim(),
      }),
    assertNoActiveDeployRuns: () =>
      assertNoActiveProductionDeployRuns({
        repository: argument('GITHUB_REPOSITORY'),
        token: argument('GITHUB_TOKEN'),
        currentRunId: argument('GITHUB_RUN_ID'),
      }),
  });
  process.stdout.write(`Owner editor index is READY for ${projectId}/${databaseId}.\n`);
}

if (process.argv[1]?.endsWith('firestore-owner-editor-index-preparation.ts')) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Owner editor index preparation failed'}\n`,
    );
    process.exitCode = 1;
  });
}
