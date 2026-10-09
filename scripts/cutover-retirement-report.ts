import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { EvidenceStore, verifyEvidenceChain } from './cutover-evidence.js';
import {
  type CutoverConfig,
  captureRetirementProof,
  configSha256,
  databaseDependencies,
  type Inventory,
  isDatabaseEnvName,
  isDatabaseSecretName,
  readCutoverConfig,
  STEPS,
} from './cutover-steps.js';

/**
 * Builds the PostgreSQL retirement evidence report from the cutover evidence,
 * the repository, and (optionally) a fresh read-only Cloud Run inventory. The
 * report is READY only when deleting the Neon database would remove no
 * remaining runtime or recovery dependency, and every asset reference without
 * recoverable bytes has an explicit owner accepted-loss decision.
 */

export type OwnerDecisions = {
  /** One entry per unresolved asset reference from the assets step. */
  acceptedLosses?: Array<{
    sourceRecordId: string;
    decision: 'accepted-loss';
    decidedBy: string;
    decidedAt: string;
    reason: string;
  }>;
  /** The separately retained PostgreSQL archive (retirement gate 7). */
  postgresArchive?: {
    uri: string;
    generation: string;
    sha256: string;
    restoreTestedAt: string;
    retainedUntil: string;
  };
};

export type DependencyClass =
  | 'release-pipeline'
  | 'backup-tooling'
  | 'terraform'
  | 'ci-workflow'
  | 'unclassified'
  | 'application-code'
  | 'migration-tooling'
  | 'operator-script'
  | 'tests'
  | 'local-development'
  | 'documentation'
  | 'postgres-only'
  | 'guard';

export const RETIREMENT_INVENTORY_MAX_AGE_MS = 15 * 60_000;

export type RetirementLiveProof = {
  capturedAt: string;
  inventory: Inventory;
  services: Array<{
    name: string;
    ok: boolean;
    probes?: {
      health?: { ok?: boolean };
      ready?: { ok?: boolean; database?: string | null };
    };
  }>;
  sourceStillFenced?: { passed?: boolean };
  dispatcher?: { ok?: boolean };
};

/** Classes whose presence means deleting Neon would break something still in use. */
const BLOCKING_CLASSES = new Set<DependencyClass>([
  'release-pipeline',
  'backup-tooling',
  'terraform',
  'ci-workflow',
  'unclassified',
]);

const CLASS_NOTES: Record<DependencyClass, string> = {
  'release-pipeline':
    'A release would redeploy DATABASE_URL onto services or run the PostgreSQL migration/backup job.',
  'backup-tooling': 'The PostgreSQL backup path connects to the source database.',
  terraform: 'Infrastructure code would provision or reference the PostgreSQL dependency.',
  'ci-workflow': 'A workflow reaches a non-local PostgreSQL database or its secret.',
  unclassified: 'Not recognized; review before deleting the database.',
  'application-code':
    'PostgreSQL composition code. Inactive while live verification shows no serving template sets DATABASE_URL; delete when the PostgreSQL driver is removed.',
  'migration-tooling':
    'Reads the source only when an operator runs it manually; retire with the database.',
  'operator-script':
    'Manual maintenance script with a PostgreSQL path; port or delete, it is not a runtime or recovery dependency.',
  tests: 'Tests against a local or disposable PostgreSQL database.',
  'local-development': 'Local development defaults (docker compose, .env.example).',
  documentation: 'Documentation references; update wording after retirement.',
  'postgres-only':
    'Runs only on the PostgreSQL path. Proven unreachable from the Firestore release path (and guarded where noted); delete with the database.',
  guard:
    'Code that rejects a database setting (marked `retirement-scan: forbids`); it enforces the Firestore path rather than depending on the database.',
};

/**
 * Files that run only while the installation is on PostgreSQL. Each is
 * reported as postgres-only only while the proof holds: it is unreachable from
 * the Firestore release entry point, and its guard (when listed) is present.
 * Otherwise it falls back to its blocking class.
 */
export const POSTGRES_ONLY_FILES: ReadonlyArray<{ path: string; reason: string; guard?: string }> =
  [
    {
      path: 'infra/gcp/release-postgres.sh',
      reason:
        'PostgreSQL release; infra/gcp/release.sh runs it only for PERSISTENCE_DRIVER=postgres.',
    },
    {
      path: 'infra/gcp/release-diagnostics.sh',
      reason: 'Migration-job diagnostics sourced only by release-postgres.sh.',
    },
    {
      path: 'infra/gcp/deploy.sh',
      reason: 'PostgreSQL provisioner; refuses to run once assistant-agent uses Firestore.',
      guard: 'refuse_firestore_installation || exit 1',
    },
    {
      path: 'infra/docker/backup.sh',
      reason: 'pg_dump entrypoint of the backup image, which only release-postgres.sh runs.',
    },
    {
      path: 'infra/docker/database-admin.sh',
      reason: 'Direct-connection helper used by the PostgreSQL backup and migration jobs.',
    },
  ];

/** What deploy.yml's release job runs, and what it hands over to on Firestore. */
export const RELEASE_SELECTOR = 'infra/gcp/release.sh';
export const FIRESTORE_RELEASE_ENTRY = 'infra/gcp/release-firestore.sh';
const FORBIDS_MARKER = 'retirement-scan: forbids';
const REFERENCE = /[A-Za-z0-9_./-]*[A-Za-z0-9_-]+(?:\.sh|\.ya?ml|\.Dockerfile)\b/g;

/**
 * Every tracked file transitively named by the Firestore release entry point:
 * sourced or executed scripts, Cloud Build configs, and the Dockerfiles those
 * build. A reference resolves by full path, or by name beside the referrer.
 */
export function firestoreReleaseClosure(files: Array<{ path: string; text: string }>): string[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const queue = [FIRESTORE_RELEASE_ENTRY];
  while (queue.length) {
    const path = queue.shift() as string;
    if (seen.has(path) || !byPath.has(path)) continue;
    seen.add(path);
    const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    // Comments name other scripts for the reader; only code lines are followed.
    const code = (byPath.get(path)?.text ?? '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    for (const match of code.match(REFERENCE) ?? []) {
      const name = match.replace(/^\.?\//, '');
      const candidates = [name, `${directory}${name.split('/').at(-1)}`];
      for (const candidate of candidates) if (byPath.has(candidate)) queue.push(candidate);
    }
  }
  return [...seen].sort();
}

export type FirestorePathResult = {
  ok: boolean;
  closure: string[];
  problems: string[];
  postgresOnly: Array<{ path: string; reason: string; proven: boolean }>;
};

/** Static proof that the Firestore release path has no PostgreSQL dependency. */
export function verifyFirestorePath(
  files: Array<{ path: string; text: string }>,
): FirestorePathResult {
  const problems: string[] = [];
  const byPath = new Map(files.map((file) => [file.path, file]));
  const selector = byPath.get(RELEASE_SELECTOR);
  if (!byPath.has(FIRESTORE_RELEASE_ENTRY)) problems.push(`${FIRESTORE_RELEASE_ENTRY} is missing`);
  if (!selector?.text.includes(FIRESTORE_RELEASE_ENTRY.split('/').at(-1) as string))
    problems.push(`${RELEASE_SELECTOR} does not hand over to ${FIRESTORE_RELEASE_ENTRY}`);
  const closure = firestoreReleaseClosure(files);
  // Without a Firestore entry point that the selector hands over to, nothing
  // can be proven PostgreSQL-only: every such file keeps its blocking class.
  const pathExists = problems.length === 0;
  const postgresOnly = POSTGRES_ONLY_FILES.map((entry) => {
    const file = byPath.get(entry.path);
    const reachable = closure.includes(entry.path);
    // A deleted file needs no guard; an existing one must keep it.
    const guarded = !entry.guard || !file || file.text.includes(entry.guard);
    if (reachable) problems.push(`${entry.path} is reachable from the Firestore release path`);
    if (!guarded) problems.push(`${entry.path} lost its guard (${entry.guard})`);
    return { path: entry.path, reason: entry.reason, proven: pathExists && !reachable && guarded };
  });
  const unproven = new Set(postgresOnly.filter((item) => !item.proven).map((item) => item.path));
  for (const finding of scanRepository(files, { unproven }))
    if (
      (closure.includes(finding.path) || finding.path === RELEASE_SELECTOR) &&
      finding.class !== 'guard'
    )
      problems.push(`${finding.path} (Firestore release path) references the database`);
  return { ok: problems.length === 0, closure, problems, postgresOnly };
}

const PATTERN =
  /DATABASE_URL|database-url|\bneon\b|neon\.tech|pg_dump|pg_restore|postgres(?:ql)?:\/\//i;

/** Files that exist only to perform this migration and retirement. */
const SELF = /^scripts\/cutover[-.]/;
const SELF_REFERENCE = /scripts\/cutover[-.][a-z-]*\.ts/;

export function classifyPath(path: string, line: string): DependencyClass {
  const local = /localhost|127\.0\.0\.1|assistant:assistant@/.test(line);
  if (/\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)tests?\//.test(path) || /\.test\.sh$/.test(path))
    return 'tests';
  if (/\.(md|mdx)$/.test(path) || path.startsWith('docs/')) return 'documentation';
  if (/\.tf$|\.tfvars$|\.tftest\.hcl$/.test(path)) return 'terraform';
  if (
    path === '.env.example' ||
    path === 'docker-compose.yml' ||
    /^vitest\.config|^turbo\.json$/.test(path)
  )
    return 'local-development';
  if (/^infra\/gcp\/(deploy|release(-[a-z-]+)?)\.sh$|^infra\/gcp\/cloudbuild/.test(path))
    return 'release-pipeline';
  if (/^\.github\/workflows\/deploy\.ya?ml$/.test(path)) return 'release-pipeline';
  if (/^infra\/docker\/(backup|database-admin|migrate)/.test(path)) return 'backup-tooling';
  if (
    /workspace-export|workspace-migration-export|workspace-export-job/.test(path) ||
    /^\.github\/workflows\/workspace-(export|import)\.ya?ml$/.test(path)
  )
    return 'migration-tooling';
  if (path.startsWith('.github/workflows/')) return local ? 'tests' : 'ci-workflow';
  if (/^(apps|packages|workers)\//.test(path)) return 'application-code';
  if (path.startsWith('scripts/')) return local ? 'local-development' : 'operator-script';
  if (path.startsWith('infra/')) return 'unclassified';
  return local ? 'local-development' : 'unclassified';
}

export type RepoFinding = { path: string; lines: number[]; class: DependencyClass };

export function scanRepository(
  files: Array<{ path: string; text: string }>,
  options: { unproven?: ReadonlySet<string> } = {},
): RepoFinding[] {
  // PostgreSQL-only status needs proof; without a caller-supplied result, prove it here.
  const unproven =
    options.unproven ??
    new Set(
      verifyFirestorePath(files)
        .postgresOnly.filter((item) => !item.proven)
        .map((item) => item.path),
    );
  const postgresOnly = new Set(POSTGRES_ONLY_FILES.map((entry) => entry.path));
  const findings: RepoFinding[] = [];
  for (const file of files) {
    if (SELF.test(file.path) || file.path === 'pnpm-lock.yaml') continue;
    const byClass = new Map<DependencyClass, number[]>();
    file.text.split('\n').forEach((line, index) => {
      // Lines that only name the cutover tooling (for example package.json scripts) are not dependencies.
      if (!PATTERN.test(line) || SELF_REFERENCE.test(line)) return;
      const kind: DependencyClass = line.includes(FORBIDS_MARKER)
        ? 'guard'
        : postgresOnly.has(file.path) && !unproven.has(file.path)
          ? 'postgres-only'
          : classifyPath(file.path, line);
      byClass.set(kind, [...(byClass.get(kind) ?? []), index + 1]);
    });
    for (const [kind, lines] of byClass) findings.push({ path: file.path, lines, class: kind });
  }
  return findings.sort((a, b) => a.path.localeCompare(b.path));
}

type Check = { name: string; ok: boolean; detail?: string };

type AssetsEvidence = {
  unresolved: Array<{ sourceRecordId: string; classification: string }>;
  present: number;
  backedUp: number;
  restored: number;
  recoveredVerified: string[];
  backupPrefix: string;
  restorePrefix: string;
};

export function buildRetirementReport(input: {
  config: CutoverConfig;
  store: EvidenceStore;
  findings: RepoFinding[];
  decisions: OwnerDecisions;
  now: Date;
  minObservationHours: number;
  liveInventory?: Inventory;
  /** Current, read-only proof; historical cutover evidence is not sufficient. */
  liveProof?: RetirementLiveProof;
  /** Static proof for the Firestore release path; computed by verifyFirestorePath. */
  firestorePath?: FirestorePathResult;
}) {
  const { config, store, decisions } = input;
  const steps = STEPS.map((step) => ({ step, evidence: store.read(step.index, step.name) }));
  const result = <T>(name: string) =>
    steps.find((item) => item.step.name === name)?.evidence?.result as T | undefined;
  const blocking: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => blocking.push({ name, ok, detail });

  // 1. Every cutover step passed under this configuration, with an intact chain.
  const hash = configSha256(config);
  const incomplete = steps.filter(
    (item) => item.evidence?.status !== 'passed' || item.evidence.configSha256 !== hash,
  );
  add(
    'All cutover steps passed under this configuration',
    incomplete.length === 0,
    incomplete.map((item) => item.step.name).join(', ') || undefined,
  );
  const chain = verifyEvidenceChain(
    store,
    STEPS.map((step) => ({ index: step.index, name: step.name })),
  );
  add('Evidence chain is intact', chain.ok, chain.problems.join('; ') || undefined);

  // 2. Observed under real workload after the switch.
  const liveAt = steps.find((item) => item.step.name === 'live-verify')?.evidence?.completedAt;
  const observedHours = liveAt ? (input.now.getTime() - Date.parse(liveAt)) / 3_600_000 : 0;
  add(
    `Minimum production observation window elapsed (${input.minObservationHours} hours)`,
    observedHours >= input.minObservationHours,
    `${observedHours.toFixed(1)} hours since live verification`,
  );

  // 3. Live Cloud Run, Scheduler, and Pub/Sub configuration.
  const live = result<{ inventory: Inventory; services: Array<{ name: string }> }>('live-verify');
  const inventory = input.liveProof?.inventory ?? input.liveInventory ?? live?.inventory;
  const inventorySource = input.liveProof
    ? 'fresh read-only operational proof'
    : input.liveInventory
      ? 'fresh read-only capture (operational proof missing)'
      : 'historical live-verify evidence';
  const captureAge = input.liveProof
    ? input.now.getTime() - Date.parse(input.liveProof.capturedAt)
    : Number.POSITIVE_INFINITY;
  const inventoryAge = inventory
    ? input.now.getTime() - Date.parse(inventory.capturedAt)
    : Number.POSITIVE_INFINITY;
  const inventoryFresh =
    Number.isFinite(captureAge) &&
    Number.isFinite(inventoryAge) &&
    captureAge >= -2 * 60_000 &&
    captureAge <= RETIREMENT_INVENTORY_MAX_AGE_MS &&
    inventoryAge >= -2 * 60_000 &&
    inventoryAge <= RETIREMENT_INVENTORY_MAX_AGE_MS &&
    Math.abs(captureAge - inventoryAge) <= 60_000;
  add(
    `Current Cloud inventory is fresh (at most ${RETIREMENT_INVENTORY_MAX_AGE_MS / 60_000} minutes old)`,
    inventoryFresh,
    input.liveProof
      ? `${Math.round(captureAge / 60_000)} minutes old`
      : 'current proof not captured',
  );
  const rollbackRecords = [
    ...store.records<unknown>('cutover-rollback-'),
    ...store.records<unknown>('rollback-'),
  ];
  add(
    'No rollback record invalidates this cutover retirement evidence',
    rollbackRecords.length === 0,
    rollbackRecords.map((record) => record.name).join(', ') || undefined,
  );
  const cloudDependencies = inventory ? databaseDependencies(inventory) : [];
  add(
    'No Cloud Run service or job references DATABASE_URL or a database secret',
    Boolean(inventory) && cloudDependencies.length === 0,
    cloudDependencies.map((item) => `${item.kind} ${item.name}`).join(', ') || undefined,
  );
  const firestoreHosts = new Set(
    (inventory?.services ?? [])
      .filter((item) => config.services.some((service) => service.name === item.name))
      .map((item) => (item.url ? new URL(item.url).host : null))
      .filter(Boolean),
  );
  const strayJobs = (inventory?.schedulerJobs ?? []).filter(
    (item) =>
      item.state === 'ENABLED' && (!item.targetHost || !firestoreHosts.has(item.targetHost)),
  );
  add(
    'Every enabled Scheduler job targets a Firestore service',
    Boolean(inventory) && strayJobs.length === 0,
    strayJobs.map((item) => item.name).join(', ') || undefined,
  );
  const straySubscriptions = (inventory?.subscriptions ?? []).filter(
    (item) => item.pushHost && !firestoreHosts.has(item.pushHost),
  );
  add(
    'Every push subscription targets a Firestore service',
    Boolean(inventory) && straySubscriptions.length === 0,
    straySubscriptions.map((item) => item.name).join(', ') || undefined,
  );

  const servingProof = config.services.map((target) => {
    const service = inventory?.services.find((item) => item.name === target.name);
    const serving = service?.traffic.filter((entry) => entry.percent > 0) ?? [];
    return Boolean(
      service &&
        service.latestReadyRevision &&
        serving.length === 1 &&
        serving[0]?.percent === 100 &&
        serving[0].revision === service.latestReadyRevision &&
        service.config.PERSISTENCE_DRIVER === 'firestore' &&
        service.config.FIRESTORE_DATABASE_ID === config.firestoreDatabaseId &&
        service.envNames.every((name) => !isDatabaseEnvName(name)) &&
        service.secretRefs.every(
          (ref) => !isDatabaseEnvName(ref.env) && !isDatabaseSecretName(ref.secret),
        ),
    );
  });
  add(
    'Every configured service currently serves its Firestore revision and database',
    Boolean(input.liveProof) && servingProof.length > 0 && servingProof.every(Boolean),
    config.services
      .filter((_, index) => !servingProof[index])
      .map((item) => item.name)
      .join(', ') || (!input.liveProof ? 'current proof not captured' : undefined),
  );
  const targetProbes = input.liveProof?.services ?? [];
  const healthReadyConfigured =
    config.services.length > 0 &&
    config.services.every((target) => Boolean(target.health || target.ready)) &&
    config.services.some((target) => target.ready?.expectDatabase === 'firestore');
  const healthReadyPassed = config.services.every((target) => {
    const service = targetProbes.find((item) => item.name === target.name);
    return Boolean(
      service?.ok &&
        (!target.health || service.probes?.health?.ok) &&
        (!target.ready ||
          (service.probes?.ready?.ok &&
            service.probes.ready.database === target.ready.expectDatabase)),
    );
  });
  add(
    'Current health, Firestore readiness, dispatcher routing, and source provider fence are verified',
    Boolean(
      input.liveProof &&
        healthReadyConfigured &&
        healthReadyPassed &&
        input.liveProof.sourceStillFenced?.passed === true &&
        input.liveProof.dispatcher?.ok === true,
    ),
    !input.liveProof
      ? 'current proof not captured'
      : !healthReadyConfigured
        ? 'every service needs a health or readiness probe, and a readiness probe must confirm Firestore'
        : !healthReadyPassed
          ? 'current health or readiness probe failed or did not identify the configured persistence driver'
          : input.liveProof.sourceStillFenced?.passed !== true
            ? 'source provider fence is not currently proven'
            : input.liveProof.dispatcher?.ok !== true
              ? 'current dispatcher state does not match the Firestore configuration'
              : undefined,
  );

  // 4. Repository: the Firestore release path, then release, backups, Terraform, CI.
  add(
    'Firestore release path reaches no PostgreSQL dependency',
    input.firestorePath?.ok === true,
    input.firestorePath ? input.firestorePath.problems.join('; ') || undefined : 'not evaluated',
  );
  const blockingFindings = input.findings.filter((item) => BLOCKING_CLASSES.has(item.class));
  add(
    'No release, backup, Terraform, or CI path depends on the database',
    blockingFindings.length === 0,
    blockingFindings.map((item) => item.path).join(', ') || undefined,
  );
  add(
    'Application PostgreSQL code is inactive (no serving template sets DATABASE_URL)',
    Boolean(input.liveProof) && servingProof.length > 0 && servingProof.every(Boolean),
  );

  // 5. PostgreSQL-independent recovery exists.
  const backup = result<{
    backup: { documents: number; canonicalHash: string };
    restore: { canonicalHash: string };
    backupPrefix: string;
  }>('firestore-backup');
  add(
    'Managed Firestore backup restored with canonical-hash parity',
    Boolean(backup && backup.backup.canonicalHash === backup.restore.canonicalHash),
  );
  const assets = result<AssetsEvidence>('assets');
  add(
    'Every present asset is backed up and restorable with SHA-256 parity',
    Boolean(assets && assets.backedUp === assets.present && assets.restored === assets.present),
  );
  add(
    `All ${config.assets.expectedRecovered} recovered historical objects are live and backed up`,
    (assets?.recoveredVerified.length ?? 0) === config.assets.expectedRecovered,
  );
  const archive = decisions.postgresArchive;
  add(
    'A separately retained PostgreSQL archive has a tested restore',
    Boolean(
      archive &&
        /^gs:\/\//.test(archive.uri) &&
        /^[0-9a-f]{64}$/.test(archive.sha256) &&
        Date.parse(archive.restoreTestedAt) > 0 &&
        Date.parse(archive.retainedUntil) > input.now.getTime(),
    ),
    archive ? `${archive.uri}#${archive.generation}` : 'no archive recorded in the decisions file',
  );

  // 6. Owner accepted-loss decisions for references with no recoverable bytes.
  const unresolved = assets?.unresolved ?? [];
  const decided = new Map(
    (decisions.acceptedLosses ?? [])
      .filter(
        (item) =>
          item.decision === 'accepted-loss' &&
          item.decidedBy.trim() &&
          item.reason.trim() &&
          Date.parse(item.decidedAt) > 0,
      )
      .map((item) => [item.sourceRecordId, item]),
  );
  const undecided = unresolved.filter((item) => !decided.has(item.sourceRecordId));
  add(
    `Owner accepted-loss decision recorded for all ${unresolved.length} unrecoverable asset references`,
    unresolved.length === config.assets.expectedUnresolved && undecided.length === 0,
    undecided.map((item) => item.sourceRecordId).join(', ') || undefined,
  );

  const snapshot = result<{ exportSecret: string; branch: { id: string } }>('snapshot-branch');
  const fence = result<{ fenceId: string }>('fence');
  const databaseSecrets = (inventory?.secrets ?? []).filter(isDatabaseSecretName);
  return {
    generatedAt: input.now.toISOString(),
    ready: blocking.every((item) => item.ok),
    configSha256: hash,
    inventorySource,
    checks: blocking,
    cloudDependencies,
    strayScheduler: strayJobs.map((item) => item.name),
    straySubscriptions: straySubscriptions.map((item) => item.name),
    repository: input.findings,
    firestorePath: input.firestorePath ?? null,
    unresolvedAssets: unresolved.map((item) => ({
      ...item,
      decision: decided.get(item.sourceRecordId) ?? null,
    })),
    evidence: {
      fenceId: fence?.fenceId ?? null,
      drainedAt: result<{ drainedAt: string }>('drain-proof')?.drainedAt ?? null,
      snapshot: result<{ snapshot: Record<string, unknown> }>('final-export')?.snapshot ?? null,
      verify:
        result<{ verify: { summary: Record<string, unknown> } }>('verify-import')?.verify.summary ??
        null,
      firestoreBackup: backup ?? null,
      assets: assets
        ? {
            present: assets.present,
            backedUp: assets.backedUp,
            restored: assets.restored,
            backupPrefix: assets.backupPrefix,
            restorePrefix: assets.restorePrefix,
          }
        : null,
      liveServices: live?.services ?? null,
    },
    // What retirement will delete, in order, once the report is READY.
    retirementActions: [
      `Delete the Neon project ${config.neon.projectId} (source branch ${config.neon.branchId}, endpoint ${config.neon.endpointId}${snapshot ? `, snapshot branch ${snapshot.branch.id}` : ''}), or first remove its branch protection.`,
      ...databaseSecrets.map((name) => `Delete Secret Manager secret ${name} (all versions).`),
      'Revoke the Neon API key used for the cutover.',
      'Delete Cloud Run revisions and jobs that still reference database secrets; the PostgreSQL rollback path ends here.',
    ],
  };
}

export type RetirementReport = ReturnType<typeof buildRetirementReport>;

const CLASS_ORDER: DependencyClass[] = [
  'release-pipeline',
  'backup-tooling',
  'terraform',
  'ci-workflow',
  'unclassified',
  'application-code',
  'migration-tooling',
  'operator-script',
  'tests',
  'local-development',
  'postgres-only',
  'guard',
  'documentation',
];

export function renderRetirementReport(report: RetirementReport): string {
  const lines: string[] = [];
  const mark = (ok: boolean) => (ok ? 'PASS' : 'BLOCKED');
  lines.push('# PostgreSQL retirement evidence report', '');
  lines.push(
    `Generated ${report.generatedAt}. Configuration SHA-256 \`${report.configSha256}\`. Cloud inventory: ${report.inventorySource}.`,
    '',
  );
  lines.push(
    report.ready
      ? '**Verdict: READY.** Deleting the Neon database removes no remaining runtime or recovery dependency found by these checks.'
      : '**Verdict: NOT READY.** Do not delete the Neon database. Every BLOCKED row below must pass first.',
    '',
  );
  lines.push('## Gate checks', '', '| Check | Result | Detail |', '| --- | --- | --- |');
  for (const check of report.checks)
    lines.push(
      `| ${check.name} | ${mark(check.ok)} | ${(check.detail ?? '').replaceAll('|', '\\|')} |`,
    );
  lines.push('', '## Cloud configuration still referencing the database', '');
  if (report.cloudDependencies.length === 0) lines.push('None.');
  for (const item of report.cloudDependencies)
    lines.push(
      `- ${item.kind} \`${item.name}\`: ${[...item.databaseEnv, ...item.databaseSecrets].join(', ')}`,
    );
  if (report.strayScheduler.length)
    lines.push(
      `- Scheduler jobs not targeting a Firestore service: ${report.strayScheduler.join(', ')}`,
    );
  if (report.straySubscriptions.length)
    lines.push(
      `- Push subscriptions not targeting a Firestore service: ${report.straySubscriptions.join(', ')}`,
    );
  lines.push('', '## Repository references', '');
  for (const kind of CLASS_ORDER) {
    const findings = report.repository.filter((item) => item.class === kind);
    if (findings.length === 0) continue;
    lines.push(
      `### ${kind}${BLOCKING_CLASSES.has(kind) ? ' (blocking)' : ''}`,
      '',
      CLASS_NOTES[kind],
      '',
    );
    for (const finding of findings)
      lines.push(
        `- \`${finding.path}\` line${finding.lines.length > 1 ? 's' : ''} ${finding.lines.slice(0, 12).join(', ')}${finding.lines.length > 12 ? ', …' : ''}`,
      );
    lines.push('');
  }
  if (report.firestorePath) {
    lines.push('## Firestore release path', '');
    lines.push(
      `Entry \`${FIRESTORE_RELEASE_ENTRY}\` (selected by \`${RELEASE_SELECTOR}\`) reaches: ${report.firestorePath.closure.map((path) => `\`${path}\``).join(', ')}.`,
      '',
      '| PostgreSQL-only file | Proven | Why it cannot run on Firestore |',
      '| --- | --- | --- |',
    );
    for (const item of report.firestorePath.postgresOnly)
      lines.push(`| \`${item.path}\` | ${item.proven ? 'yes' : '**no**'} | ${item.reason} |`);
    lines.push('');
  }
  lines.push('## Asset references without recoverable bytes', '');
  if (report.unresolvedAssets.length === 0) lines.push('None.');
  lines.push('| Source record | Classification | Owner decision |', '| --- | --- | --- |');
  for (const item of report.unresolvedAssets)
    lines.push(
      `| \`${item.sourceRecordId}\` | ${item.classification} | ${item.decision ? `accepted loss by ${item.decision.decidedBy} at ${item.decision.decidedAt}: ${item.decision.reason}` : '**required**'} |`,
    );
  lines.push('', '## Cutover evidence', '');
  lines.push('```json', JSON.stringify(report.evidence, null, 2), '```', '');
  lines.push('## Retirement actions once READY', '');
  for (const action of report.retirementActions) lines.push(`1. ${action}`);
  lines.push('');
  return lines.join('\n');
}

const execFileAsync = promisify(execFile);

async function repositoryFiles(repo: string) {
  const { stdout } = await execFileAsync('git', ['-C', repo, 'ls-files', '-z'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const paths = stdout.split('\0').filter(Boolean);
  const files: Array<{ path: string; text: string }> = [];
  for (const path of paths) {
    const bytes = await readFile(join(repo, path)).catch(() => null);
    if (!bytes || bytes.length > 2_000_000 || bytes.includes(0)) continue;
    files.push({ path, text: bytes.toString('utf8') });
  }
  return files;
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      'evidence-dir': { type: 'string' },
      repo: { type: 'string', default: '.' },
      decisions: { type: 'string' },
      out: { type: 'string' },
      'min-observation-hours': { type: 'string', default: '168' },
      live: { type: 'boolean', default: false },
      'static-only': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const files = await repositoryFiles(values.repo);
  const firestorePath = verifyFirestorePath(files);
  if (values['static-only']) {
    // Repository-only proof, used by CI: needs no evidence, config, or cloud access.
    const findings = scanRepository(files);
    const blocking = findings.filter((item) => BLOCKING_CLASSES.has(item.class));
    const counts = findings.reduce<Record<string, number>>((result, item) => {
      result[item.class] = (result[item.class] ?? 0) + 1;
      return result;
    }, {});
    console.log(
      JSON.stringify(
        {
          firestorePath: { ok: firestorePath.ok, problems: firestorePath.problems },
          blockingFiles: blocking.map(
            (item) => `${item.path}:${item.lines.join(',')} (${item.class})`,
          ),
          filesByClass: counts,
          postgresOnly: firestorePath.postgresOnly,
        },
        null,
        2,
      ),
    );
    if (!firestorePath.ok || blocking.length) process.exitCode = 1;
    return;
  }
  if (!values.config || !values['evidence-dir'] || !values.out)
    throw new Error(
      'Usage: pnpm cutover:retirement-report --config cutover.json --evidence-dir DIR --out report.md [--decisions owner-decisions.json] [--live]\n       pnpm cutover:retirement-report --static-only',
    );
  const config = await readCutoverConfig(values.config);
  const store = new EvidenceStore(values['evidence-dir']);
  const decisions = values.decisions
    ? (JSON.parse(await readFile(values.decisions, 'utf8')) as OwnerDecisions)
    : {};
  let liveProof: RetirementLiveProof | undefined;
  if (values.live) {
    // Fresh list/describe, health/readiness, dispatcher, and provider-fence
    // checks only. Sensitive source URL and identity-token values stay in
    // memory and are never included in the report.
    const { createRetirementProofDeps } = await import('./cutover.js');
    liveProof = await captureRetirementProof(config, createRetirementProofDeps(config), store);
  }
  const report = buildRetirementReport({
    config,
    store,
    findings: scanRepository(files),
    decisions,
    now: new Date(),
    minObservationHours: Number(values['min-observation-hours']),
    liveProof,
    firestorePath,
  });
  await writeFile(values.out, renderRetirementReport(report), { flag: 'wx', mode: 0o600 });
  await writeFile(`${values.out}.json`, `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(JSON.stringify({ ready: report.ready, checks: report.checks }, null, 2));
  if (!report.ready) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
