import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvidenceStore } from './cutover-evidence.js';
import {
  buildRetirementReport,
  classifyPath,
  type OwnerDecisions,
  renderRetirementReport,
  scanRepository,
  verifyFirestorePath,
} from './cutover-retirement-report.js';
import { type CutoverConfig, configSha256, type Inventory, STEPS } from './cutover-steps.js';

const config = {
  gcp: { project: 'bmson-assistant', region: 'us-west1', firestoreLocation: 'us-west1' },
  installationId: 'assistant',
  neon: { projectId: 'proud-sun-123', branchId: 'br-main', endpointId: 'ep-main' },
  assets: { expectedRecovered: 12, expectedUnresolved: 5 },
  firestoreDatabaseId: 'assistant-db',
  dispatcher: {
    schedulerJobs: ['assistant-sweep'],
    queues: [],
    pushSubscriptions: [],
  },
  services: [
    {
      name: 'assistant-web',
      health: { path: '/api/health', expectReleaseSha: true },
      ready: { path: '/api/ready', authenticated: false, expectDatabase: 'firestore' },
    },
    {
      name: 'assistant-agent',
      health: { path: '/health', expectReleaseSha: true },
      ready: { path: '/ready', authenticated: false, expectDatabase: 'firestore' },
    },
  ],
} as unknown as CutoverConfig;

const unresolved = Array.from({ length: 5 }, (_, index) => ({
  sourceRecordId: `missing-${index + 1}`,
  classification: index < 2 ? 'import-original' : 'generated-artifact',
}));

function cleanInventory(): Inventory {
  return {
    capturedAt: '2026-09-24T12:00:00Z',
    services: ['assistant-web', 'assistant-agent'].map((name) => ({
      name,
      url: `https://${name}-x.a.run.app`,
      latestReadyRevision: `${name}-00009`,
      traffic: [{ revision: `${name}-00009`, percent: 100, latest: true }],
      image: 'img@sha256:x',
      envNames: ['PERSISTENCE_DRIVER', 'FIRESTORE_DATABASE_ID'],
      config: { PERSISTENCE_DRIVER: 'firestore', FIRESTORE_DATABASE_ID: 'assistant-db' },
      secretRefs: [{ env: 'AUTH_SECRET', secret: 'auth-secret', version: '3' }],
    })),
    jobs: [{ name: 'assistant-processor', image: 'p', envNames: [], secretRefs: [] }],
    schedulerJobs: [
      {
        name: 'assistant-sweep',
        state: 'ENABLED',
        schedule: '* * * * *',
        targetHost: 'assistant-agent-x.a.run.app',
      },
    ],
    queues: [{ name: 'agent-steps', state: 'PAUSED' }],
    subscriptions: [],
    secrets: ['auth-secret', 'database-url', 'database-url-final-export'],
  };
}

function cleanLiveProof(inventory = cleanInventory(), capturedAt = '2026-10-02T12:00:00Z') {
  const currentInventory = { ...inventory, capturedAt };
  return {
    capturedAt,
    inventory: currentInventory,
    services: config.services.map((target) => ({
      name: target.name,
      ok: true,
      probes: {
        health: { ok: true },
        ready: { ok: true, database: 'firestore' },
      },
    })),
    sourceStillFenced: { passed: true },
    dispatcher: { ok: true },
  };
}

function writeEvidence(
  store: EvidenceStore,
  inventory: Inventory,
  options: { skip?: string; liveAt?: string } = {},
) {
  const hash = configSha256(config);
  let previous: string | null = null;
  const results: Record<string, unknown> = {
    fence: { fenceId: 'neon:proud-sun-123:op-1' },
    'drain-proof': { drainedAt: '2026-09-24T09:00:00Z' },
    'snapshot-branch': { branch: { id: 'br-snapshot' }, exportSecret: 'database-url-final-export' },
    'final-export': {
      snapshot: { uri: 'gs://b/snap.json', generation: '9', sha256: 'f'.repeat(64) },
    },
    'verify-import': { verify: { summary: { verified: true, writes: 87517 } } },
    assets: {
      unresolved,
      present: 98,
      backedUp: 98,
      restored: 98,
      recoveredVerified: Array.from({ length: 12 }, (_, index) => `recovered-${index}`),
      backupPrefix: 'gs://backup/assets/',
      restorePrefix: 'gs://backup/restore/',
    },
    'firestore-backup': {
      backup: { documents: 87517, canonicalHash: 'h' },
      restore: { canonicalHash: 'h' },
      backupPrefix: 'gs://b/fs',
    },
    'live-verify': { inventory, services: [{ name: 'assistant-web', ok: true }] },
  };
  for (const step of STEPS) {
    if (step.name === options.skip) break;
    const at =
      step.name === 'live-verify'
        ? (options.liveAt ?? '2026-09-24T12:00:00Z')
        : '2026-09-24T10:00:00Z';
    store.write({
      format: 'assistant-cutover-evidence',
      version: 1,
      step: step.name,
      index: step.index,
      status: 'passed',
      mutating: step.mutating,
      confirmed: step.mutating,
      configSha256: hash,
      previousSha256: previous,
      startedAt: at,
      completedAt: at,
      result: results[step.name] ?? {},
    });
    previous = store.fileSha256(step.index, step.name);
  }
}

const decisions: OwnerDecisions = {
  acceptedLosses: unresolved.map((item) => ({
    sourceRecordId: item.sourceRecordId,
    decision: 'accepted-loss',
    decidedBy: 'owner',
    decidedAt: '2026-10-01T10:00:00Z',
    reason: 'No copy exists on any owner device; derived memories retained.',
  })),
  postgresArchive: {
    uri: 'gs://bmson-assistant-workspace/workspace/assistant/backups/final.dump',
    generation: '123',
    sha256: 'e'.repeat(64),
    restoreTestedAt: '2026-10-01T09:00:00Z',
    retainedUntil: '2027-10-01T00:00:00Z',
  },
};

const cleanRepo = [
  { path: 'apps/web/lib/db.ts', text: 'const url = process.env.DATABASE_URL;' },
  {
    path: '.github/workflows/ci.yml',
    text: '  DATABASE_URL: postgres://assistant:assistant@localhost:5432/assistant',
  },
  { path: 'docs/recovery.md', text: 'The database-url secret.' },
  { path: 'scripts/cutover-steps.ts', text: 'database-url' },
];

/** A minimal repository with both release paths, mirroring infra/gcp. */
function releaseRepo(overrides: Record<string, string> = {}) {
  const files: Record<string, string> = {
    'infra/gcp/release.sh': [
      '# Selects release-postgres.sh or release-firestore.sh.',
      'source "$ROOT/release-persistence.sh"',
      'firestore) exec bash "$ROOT/release-firestore.sh" ;;',
      'postgres) exec bash "$ROOT/release-postgres.sh" ;;',
    ].join('\n'),
    'infra/gcp/release-persistence.sh': 'service_persistence_driver() { :; }',
    'infra/gcp/release-firestore.sh': [
      '# Mirrors release-postgres.sh without its database steps.',
      'const databaseEnv = /^DATABASE_URL$/; // retirement-scan: forbids',
      'gcloud builds submit --config infra/gcp/cloudbuild-firestore.yaml',
    ].join('\n'),
    'infra/gcp/cloudbuild-firestore.yaml': 'args: [build, -f, infra/docker/agent.Dockerfile]',
    'infra/docker/agent.Dockerfile': 'FROM node:22-slim',
    'infra/gcp/release-postgres.sh': [
      'source "$(dirname "$0")/release-diagnostics.sh"',
      '--set-secrets "DATABASE_URL=database-url:latest"',
    ].join('\n'),
    'infra/gcp/release-diagnostics.sh': '# the job contains DATABASE_URL via Secret Manager.',
    'infra/gcp/deploy.sh': [
      'refuse_firestore_installation || exit 1',
      'make_secret database-url "$PROD_DATABASE_URL"',
    ].join('\n'),
    'infra/docker/backup.sh': 'pg_dump --dbname="$DATABASE_URL"',
    'infra/docker/database-admin.sh': ': "$DATABASE_URL"',
    ...overrides,
  };
  return [...cleanRepo, ...Object.entries(files).map(([path, text]) => ({ path, text }))];
}

function store() {
  return new EvidenceStore(mkdtempSync(join(tmpdir(), 'retirement-')));
}

describe('repository dependency scan', () => {
  it('separates blocking release, backup, Terraform, and CI paths from inactive code and docs', () => {
    expect(classifyPath('infra/gcp/release.sh', '--set-secrets DATABASE_URL=database-url')).toBe(
      'release-pipeline',
    );
    expect(classifyPath('infra/docker/backup.sh', 'pg_dump')).toBe('backup-tooling');
    expect(classifyPath('infra/gcp/consumer/terraform/runtime.tf', 'database-url')).toBe(
      'terraform',
    );
    expect(classifyPath('.github/workflows/nightly.yml', 'DATABASE_URL: secrets.PROD_DB')).toBe(
      'ci-workflow',
    );
    expect(
      classifyPath(
        '.github/workflows/ci.yml',
        'DATABASE_URL: postgres://assistant:assistant@localhost',
      ),
    ).toBe('tests');
    expect(classifyPath('infra/gcp/workspace-export.sh', 'database-url')).toBe('migration-tooling');
    expect(classifyPath('packages/db/src/client.ts', 'DATABASE_URL')).toBe('application-code');
    expect(classifyPath('packages/db/src/client.test.ts', 'DATABASE_URL')).toBe('tests');
    expect(classifyPath('scripts/retract-messages.ts', 'PROD_DATABASE_URL')).toBe(
      'operator-script',
    );
    expect(classifyPath('docs/recovery.md', 'pg_restore')).toBe('documentation');
    expect(classifyPath('Makefile', 'DATABASE_URL')).toBe('unclassified');
  });

  it('reports each file and line and skips the cutover tooling itself', () => {
    const findings = scanRepository([
      { path: 'infra/gcp/deploy.sh', text: 'a\nmake_secret database-url "$X"\nb\nDATABASE_URL=1' },
      { path: 'scripts/cutover-neon-fence.ts', text: 'DATABASE_URL' },
      { path: 'README.md', text: 'nothing here' },
    ]);
    expect(findings).toEqual([
      { path: 'infra/gcp/deploy.sh', lines: [2, 4], class: 'release-pipeline' },
    ]);
  });
});

describe('Firestore release path proof', () => {
  it('proves PostgreSQL-only files unreachable and keeps guards non-blocking', () => {
    const result = verifyFirestorePath(releaseRepo());
    expect(result).toMatchObject({ ok: true, problems: [] });
    expect(result.closure).toEqual([
      'infra/docker/agent.Dockerfile',
      'infra/gcp/cloudbuild-firestore.yaml',
      'infra/gcp/release-firestore.sh',
    ]);
    expect(result.postgresOnly.every((item) => item.proven)).toBe(true);
    const classes = Object.fromEntries(
      scanRepository(releaseRepo())
        .filter((item) => item.path.startsWith('infra/'))
        .map((item) => [item.path, item.class]),
    );
    expect(classes).toEqual({
      'infra/docker/backup.sh': 'postgres-only',
      'infra/docker/database-admin.sh': 'postgres-only',
      'infra/gcp/deploy.sh': 'postgres-only',
      'infra/gcp/release-diagnostics.sh': 'postgres-only',
      'infra/gcp/release-firestore.sh': 'guard',
      'infra/gcp/release-postgres.sh': 'postgres-only',
    });
  });

  it('fails when the Firestore path reaches a PostgreSQL-only file or references the database', () => {
    const sourcesPostgres = releaseRepo({
      'infra/gcp/release-firestore.sh': 'source "$(dirname "$0")/release-diagnostics.sh"',
    });
    const reached = verifyFirestorePath(sourcesPostgres);
    expect(reached.ok).toBe(false);
    expect(reached.problems).toContain(
      'infra/gcp/release-diagnostics.sh is reachable from the Firestore release path',
    );
    const reachedClass = scanRepository(sourcesPostgres).find(
      (item) => item.path === 'infra/gcp/release-diagnostics.sh',
    )?.class;
    expect(reachedClass).toBe('release-pipeline');

    const direct = verifyFirestorePath(
      releaseRepo({
        'infra/gcp/release-firestore.sh':
          'gcloud run services update x --set-secrets DATABASE_URL=database-url:1',
      }),
    );
    expect(direct.problems).toEqual([
      'infra/gcp/release-firestore.sh (Firestore release path) references the database',
    ]);
  });

  it('requires the deploy.sh guard and ignores scripts named only in comments', () => {
    const unguarded = releaseRepo({ 'infra/gcp/deploy.sh': 'make_secret database-url "$X"' });
    expect(verifyFirestorePath(unguarded).problems).toEqual([
      'infra/gcp/deploy.sh lost its guard (refuse_firestore_installation || exit 1)',
    ]);
    const deployClass = scanRepository(unguarded).find(
      (item) => item.path === 'infra/gcp/deploy.sh',
    )?.class;
    expect(deployClass).toBe('release-pipeline');
    // releaseRepo's Firestore entry names release-postgres.sh in a comment only.
    expect(verifyFirestorePath(releaseRepo()).closure).not.toContain(
      'infra/gcp/release-postgres.sh',
    );
  });

  it('holds for this repository', async () => {
    const { execFileSync } = await import('node:child_process');
    const { readFileSync } = await import('node:fs');
    const root = new URL('..', import.meta.url).pathname;
    const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .flatMap((path) => {
        try {
          const bytes = readFileSync(join(root, path));
          return bytes.includes(0) ? [] : [{ path, text: bytes.toString('utf8') }];
        } catch {
          return [];
        }
      });
    expect(verifyFirestorePath(files).problems).toEqual([]);
    const blocking = scanRepository(files)
      .filter((item) =>
        ['release-pipeline', 'backup-tooling', 'terraform', 'ci-workflow', 'unclassified'].includes(
          item.class,
        ),
      )
      .map((item) => item.path);
    expect(blocking).toEqual([]);
  });
});

describe('retirement evidence report', () => {
  it('is READY only with complete evidence, clean cloud config and repo, archive, and owner decisions', () => {
    const evidence = store();
    writeEvidence(evidence, cleanInventory());
    const report = buildRetirementReport({
      config,
      store: evidence,
      findings: scanRepository(releaseRepo()),
      firestorePath: verifyFirestorePath(releaseRepo()),
      decisions,
      now: new Date('2026-10-02T12:00:00Z'),
      minObservationHours: 168,
      liveProof: cleanLiveProof(),
    });
    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(report.ready).toBe(true);
    expect(report.retirementActions.join('\n')).toContain('database-url-final-export');
    expect(report.retirementActions.join('\n')).toContain('br-snapshot');
    const markdown = renderRetirementReport(report);
    expect(markdown).toContain('Verdict: READY');
    expect(markdown).toContain('accepted loss by owner');
    expect(markdown).toContain('## Firestore release path');
    expect(markdown).toContain('### postgres-only');
    expect(markdown).toContain('### application-code');
  });

  it('lists the five unrecoverable asset references as requiring an owner decision', () => {
    const evidence = store();
    writeEvidence(evidence, cleanInventory());
    const partial = {
      ...decisions,
      acceptedLosses: decisions.acceptedLosses?.slice(0, 3),
    };
    const report = buildRetirementReport({
      config,
      store: evidence,
      findings: [],
      decisions: partial,
      now: new Date('2026-10-02T12:00:00Z'),
      minObservationHours: 168,
    });
    expect(report.ready).toBe(false);
    const check = report.checks.find((item) => item.name.startsWith('Owner accepted-loss'));
    expect(check).toMatchObject({ ok: false, detail: 'missing-4, missing-5' });
    const markdown = renderRetirementReport(report);
    expect(markdown.match(/\*\*required\*\*/g)).toHaveLength(2);
    expect(report.unresolvedAssets).toHaveLength(5);
  });

  it('blocks on remaining Cloud Run, Scheduler, and repository database dependencies', () => {
    const evidence = store();
    const inventory = cleanInventory();
    inventory.jobs.push({
      name: 'assistant-migrate',
      image: 'm',
      envNames: ['DATABASE_URL'],
      secretRefs: [{ env: 'DATABASE_URL', secret: 'database-url', version: 'latest' }],
    });
    inventory.schedulerJobs.push({
      name: 'assistant-legacy',
      state: 'ENABLED',
      schedule: '* * * * *',
      targetHost: 'old-agent.a.run.app',
    });
    writeEvidence(evidence, inventory);
    const legacyRepo = [
      ...cleanRepo,
      { path: 'infra/gcp/release.sh', text: '--set-secrets "DATABASE_URL=database-url:latest"' },
      { path: 'infra/docker/backup.sh', text: 'pg_dump --dbname="$DATABASE_URL"' },
    ];
    const liveProof = cleanLiveProof(inventory);
    liveProof.dispatcher = { ok: false };
    const report = buildRetirementReport({
      config,
      store: evidence,
      findings: scanRepository(legacyRepo),
      firestorePath: verifyFirestorePath(legacyRepo),
      decisions,
      now: new Date('2026-10-02T12:00:00Z'),
      minObservationHours: 168,
      liveProof,
    });
    const failed = report.checks.filter((check) => !check.ok).map((check) => check.name);
    expect(failed).toEqual(
      expect.arrayContaining([
        'No Cloud Run service or job references DATABASE_URL or a database secret',
        'Every enabled Scheduler job targets a Firestore service',
        'Current health, Firestore readiness, dispatcher routing, and source provider fence are verified',
        'No release, backup, Terraform, or CI path depends on the database',
        'Firestore release path reaches no PostgreSQL dependency',
      ]),
    );
    expect(renderRetirementReport(report)).toContain('Verdict: NOT READY');
  });

  it('blocks on incomplete evidence, a short observation window, and a missing archive', () => {
    const evidence = store();
    writeEvidence(evidence, cleanInventory(), { skip: 'live-verify' });
    const report = buildRetirementReport({
      config,
      store: evidence,
      findings: [],
      decisions: { acceptedLosses: decisions.acceptedLosses },
      now: new Date('2026-09-24T13:00:00Z'),
      minObservationHours: 168,
    });
    const failed = report.checks.filter((check) => !check.ok).map((check) => check.name);
    expect(failed).toEqual(
      expect.arrayContaining([
        'All cutover steps passed under this configuration',
        'Minimum production observation window elapsed (168 hours)',
        'No Cloud Run service or job references DATABASE_URL or a database secret',
        'A separately retained PostgreSQL archive has a tested restore',
      ]),
    );
  });

  it('prefers a fresh read-only inventory over the live-verify snapshot', () => {
    const evidence = store();
    writeEvidence(evidence, cleanInventory());
    const fresh = cleanInventory();
    fresh.services.push({
      ...(fresh.services[0] as Inventory['services'][number]),
      name: 'assistant-web-legacy',
      secretRefs: [{ env: 'DATABASE_URL', secret: 'database-url', version: 'latest' }],
    });
    const report = buildRetirementReport({
      config,
      store: evidence,
      findings: [],
      decisions,
      now: new Date('2026-10-02T12:00:00Z'),
      minObservationHours: 168,
      liveInventory: fresh,
    });
    expect(report.inventorySource).toBe('fresh read-only capture (operational proof missing)');
    expect(report.cloudDependencies.map((item) => item.name)).toEqual(['assistant-web-legacy']);
    expect(report.ready).toBe(false);
  });

  it('fails closed on a rollback record even with fresh Firestore traffic and elapsed observation', () => {
    const evidence = store();
    writeEvidence(evidence, cleanInventory());
    evidence.writeRecord('cutover-rollback-result-123.json', {
      format: 'assistant-cutover-rollback',
      status: 'completed',
      passed: true,
    });
    const report = buildRetirementReport({
      config,
      store: evidence,
      findings: scanRepository(releaseRepo()),
      firestorePath: verifyFirestorePath(releaseRepo()),
      decisions,
      now: new Date('2026-10-02T12:00:00Z'),
      minObservationHours: 168,
      liveProof: cleanLiveProof(),
    });
    expect(report.ready).toBe(false);
    expect(report.checks.find((check) => check.name.startsWith('No rollback'))).toEqual({
      name: 'No rollback record invalidates this cutover retirement evidence',
      ok: false,
      detail: 'cutover-rollback-result-123.json',
    });
  });

  it('fails closed on stale inventory, split serving traffic, wrong driver, or missing provider proof', () => {
    const evidence = store();
    writeEvidence(evidence, cleanInventory());
    const inventory = cleanInventory();
    const web = inventory.services[0];
    if (web) {
      web.config.PERSISTENCE_DRIVER = 'firestore';
      web.traffic = [
        { revision: 'assistant-web-old', percent: 50, latest: false },
        { revision: web.latestReadyRevision, percent: 50, latest: true },
      ];
    }
    const proof = cleanLiveProof(inventory, '2026-10-02T11:00:00Z');
    proof.sourceStillFenced = { passed: false };
    const report = buildRetirementReport({
      config,
      store: evidence,
      findings: scanRepository(releaseRepo()),
      firestorePath: verifyFirestorePath(releaseRepo()),
      decisions,
      now: new Date('2026-10-02T12:00:00Z'),
      minObservationHours: 168,
      liveProof: proof,
    });
    const failed = report.checks.filter((check) => !check.ok).map((check) => check.name);
    expect(failed).toEqual(
      expect.arrayContaining([
        'Current Cloud inventory is fresh (at most 15 minutes old)',
        'Every configured service currently serves its Firestore revision and database',
        'Current health, Firestore readiness, dispatcher routing, and source provider fence are verified',
      ]),
    );
  });
});
