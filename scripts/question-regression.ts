import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ModelRouter } from '@assistant/core/model-router';
import { agents, budgets, createDb, modelRoles, models } from '@assistant/db';
import {
  APPLICATION_CASES,
  ASSISTANT_SCENARIOS,
  assertReplayDatabaseUrl,
  CALENDAR_DIAGNOSTIC_CASES,
  CALENDAR_DIAGNOSTIC_HOLDOUT_VERSION,
  CALENDAR_DIAGNOSTIC_HOLDOUTS,
  CALENDAR_DIAGNOSTIC_VERSION,
  type DiagnosticInterruptedReceipt,
  evaluateCalendarDiagnostic,
  OPEN_ENDED_SCENARIOS,
  QUESTION_CASES,
  type QuestionResult,
  runQuestion,
  summarizeQuestions,
} from '@assistant/tools/question-regression';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  captureDiagnosticCase,
  decideDiagnosticRunControl,
} from './question-regression-control.js';
import { buildQuestionPreparation } from './question-regression-preparation.js';
import { allocateTestTarget, isolatedTestEnvironment } from './test-target.js';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    prepare: { type: 'boolean', default: false },
    partition: { type: 'string', default: 'diagnostic' },
    'model-config': { type: 'string' },
    database: { type: 'string' },
    cases: { type: 'string' },
    suite: { type: 'string', default: 'audit' },
    output: { type: 'string' },
    budget: { type: 'string', default: '5' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'pnpm eval:questions [--suite audit|assistant|open-ended|calendar-diagnostic|all] [--prepare] [--partition diagnostic|holdout] [--live --model-config <snapshot.json>] [--cases id,id] [--budget 5] [--output <directory>] [--database <loopback _test URL>]\nDefaults to scripted audit replay. Calendar diagnostics default to preparation only: NOT_RUN receipts, no database or inference. Their real entry routing includes deterministic calendar gates, not a model-quality claim. Live mode requires an explicit captured model configuration and existing credential. All external tools are intercepted; task state rolls back.',
  );
  process.exit(0);
}
const maxSpend = Number(values.budget);
if (!Number.isFinite(maxSpend) || maxSpend < 0.1 || maxSpend > 20)
  throw new Error('--budget must be $0.10–$20');
if (
  !['audit', 'assistant', 'open-ended', 'calendar-diagnostic', 'all'].includes(values.suite ?? '')
)
  throw new Error('--suite must be audit, assistant, open-ended, calendar-diagnostic or all');
if (!['diagnostic', 'holdout'].includes(values.partition ?? ''))
  throw new Error('--partition must be diagnostic or holdout');
if (values.prepare && (values.suite !== 'calendar-diagnostic' || values.live))
  throw new Error('--prepare is a calendar-diagnostic-only mode and cannot request --live');
if (values.suite === 'open-ended' && !values.live)
  throw new Error('The open-ended suite requires --live; scripted answers do not measure quality');
const corpus =
  values.suite === 'calendar-diagnostic'
    ? values.partition === 'holdout'
      ? CALENDAR_DIAGNOSTIC_HOLDOUTS
      : CALENDAR_DIAGNOSTIC_CASES
    : values.suite === 'open-ended'
      ? OPEN_ENDED_SCENARIOS
      : values.suite === 'assistant'
        ? ASSISTANT_SCENARIOS
        : values.suite === 'all'
          ? [...QUESTION_CASES, ...ASSISTANT_SCENARIOS]
          : QUESTION_CASES;
const ids = values.cases?.split(',');
if (ids?.some((id) => !corpus.some((fixture) => fixture.id === id)))
  throw new Error('--cases contains an unknown case ID');
const fixtures = corpus.filter((fixture) => !ids || ids.includes(fixture.id));
const sourceFiles = [
  'scripts/question-regression.ts',
  'scripts/question-regression-preparation.ts',
  'scripts/question-regression-control.ts',
  'packages/tools/src/question-regression/harness.ts',
  'packages/tools/src/question-regression/corpus.ts',
  'packages/tools/src/question-regression/calendar-diagnostic-tools.ts',
  'packages/tools/src/question-regression/calendar-diagnostic-corpus.ts',
  'packages/tools/src/question-regression/calendar-diagnostic-holdout.ts',
  'packages/tools/src/question-regression/calendar-diagnostic-grader.ts',
  'packages/tools/src/question-regression/calendar-diagnostic-trace.ts',
  'packages/tools/src/question-regression/calendar-diagnostic-accounting.ts',
  'packages/core/src/workflow/planner.ts',
  'packages/core/src/workflow/read-intent.ts',
  'packages/core/src/workflow/executor/step-loop.ts',
  'packages/core/src/workflow/calendar-agenda.ts',
  'packages/core/src/workflow/response-cards.ts',
  'packages/core/src/workflow/briefing.ts',
  'packages/core/src/workflow/calendar-source-link.ts',
  'packages/core/src/workflow/executor/finalize.ts',
  'packages/core/src/workflow/response-contract.ts',
  'packages/core/src/workflow/calendar-event-analysis.ts',
  'packages/core/src/workflow/calendar-relationship.ts',
  'packages/persistence/src/calendar-occurrence.ts',
  'packages/tools/src/google/calendar.ts',
];
async function dirtySourceIdentity() {
  // Hash scoped dirty code, including untracked sources; never copy file contents.
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--modified', '--others', '--exclude-standard'],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(
      (file) =>
        /^(?:packages|scripts|apps|docs)\//.test(file) && /\.(?:ts|tsx|swift|json|md)$/.test(file),
    )
    .sort();
  const dirtyFileHashes = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => {
        try {
          return [
            file,
            createHash('sha256')
              .update(await readFile(file))
              .digest('hex'),
          ];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [file, null];
          throw error;
        }
      }),
    ),
  );
  const workingDiffSha256 = createHash('sha256')
    .update(files.length ? execFileSync('git', ['diff', '--binary', 'HEAD', '--', ...files]) : '')
    .digest('hex');
  return {
    dirtyFileHashes,
    workingDiffSha256,
    scope:
      'Dirty ts/tsx/swift/json/md files under packages/scripts/apps/docs; selected seam hashes are not an exhaustive transitive dependency manifest.',
  };
}
async function prepareCalendarRun(blockers: string[]) {
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ]),
    ),
  );
  const configuration = values['model-config'] ? await readFile(values['model-config']) : null;
  const manifest = buildQuestionPreparation({
    fixtures,
    suite: values.suite ?? '',
    partition: values.partition ?? 'diagnostic',
    version:
      values.partition === 'holdout'
        ? CALENDAR_DIAGNOSTIC_HOLDOUT_VERSION
        : CALENDAR_DIAGNOSTIC_VERSION,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    sourceHashes,
    dirtySourceIdentity: await dirtySourceIdentity(),
    configSha256: configuration ? createHash('sha256').update(configuration).digest('hex') : null,
    blockers,
  });
  const directory =
    values.output ??
    `.workspace/question-regression/runs/${new Date().toISOString().replaceAll(':', '-')}`;
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  await writeFile(`${directory}/preparation.json`, JSON.stringify(manifest, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(JSON.stringify({ status: 'not_run', directory, cases: fixtures.length, blockers }));
}
if (values.suite === 'calendar-diagnostic' && !values.live) {
  await prepareCalendarRun([
    'inference_not_requested',
    'database_not_accessed',
    'credential_not_checked',
  ]);
  process.exit(0);
}
try {
  process.loadEnvFile('.env');
} catch {
  /* CI can supply configuration directly. */
}
Object.assign(process.env, {
  OWNER_NAME: 'Fixture Owner',
  OWNER_EMAIL: 'owner@example.org',
  OWNER_PHONE: '',
  ASSISTANT_NAME: 'Regression Assistant',
  ASSISTANT_EMAIL: 'assistant@example.org',
  ASSISTANT_SIGNATURE: '',
  ASSISTANT_WORKSPACE_ID: 'question-regression',
  ASSISTANT_TIMEZONE: 'America/Los_Angeles',
});
process.env.CHAT_RECALL_ENABLED = 'false';
process.env.AUTH_DEV_BYPASS = 'false';
process.env.QUEUE_DRIVER = 'local';
if (
  values.suite === 'calendar-diagnostic' &&
  values.live &&
  (!values['model-config'] || !process.env.OPENROUTER_API_KEY)
) {
  await prepareCalendarRun([
    ...(!values['model-config'] ? ['model_configuration_not_supplied'] : []),
    ...(!process.env.OPENROUTER_API_KEY ? ['existing_credential_unavailable'] : []),
    'database_not_accessed',
  ]);
  process.exit(1);
}
if (values.live && (!values['model-config'] || !process.env.OPENROUTER_API_KEY))
  throw new Error(
    'Live replay requires --model-config and an existing OPENROUTER_API_KEY; no new credential is created.',
  );
const sourceDatabaseUrl = assertReplayDatabaseUrl(
  values.database ?? 'postgres://assistant:assistant@localhost:5432/assistant_questions_test',
);
const target = allocateTestTarget(sourceDatabaseUrl);
const databaseUrl = target.databaseUrl;
process.env.DATABASE_URL = databaseUrl;
process.env.TEST_DATABASE_URL = databaseUrl;
process.env.ASSISTANT_TEST_TARGET_TOKEN = target.token;
const modelSnapshotSchema = z.object({
  capturedAt: z.string(),
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      capabilities: z.record(z.string(), z.unknown()),
      promptCostPerMTok: z.string().nullable(),
      completionCostPerMTok: z.string().nullable(),
      latencyClass: z.string(),
      enabled: z.boolean(),
    }),
  ),
  roles: z.array(
    z.object({
      role: z.enum(['plan', 'classify', 'extract', 'draft', 'reason', 'rewrite', 'embed', 'batch']),
      primaryModel: z.string(),
      fallbackModel: z.string(),
      params: z.record(z.string(), z.unknown()),
    }),
  ),
});
const snapshot = values['model-config']
  ? modelSnapshotSchema.parse(JSON.parse(await readFile(values['model-config'], 'utf8')))
  : undefined;
if (
  snapshot &&
  (snapshot.roles.length !== 8 ||
    new Set(snapshot.roles.map((role) => role.role)).size !== 8 ||
    snapshot.roles.some(
      (role) =>
        !snapshot.models.some((model) => model.id === role.primaryModel && model.enabled) ||
        !snapshot.models.some((model) => model.id === role.fallbackModel && model.enabled),
    ))
)
  throw new Error(
    'Snapshot must contain all eight roles and their enabled primary/fallback models',
  );
const outputDir =
  values.output ??
  `.workspace/question-regression/runs/${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(path.dirname(outputDir), { recursive: true, mode: 0o700 });
await mkdir(outputDir, { mode: 0o700 }); // Refuse to overwrite earlier evidence.
// Serialize resets of the same replay database, including concurrent live runs.
const replayTarget = new URL(databaseUrl);
const lockName = createHash('sha256')
  .update(`${replayTarget.hostname}:${replayTarget.port || '5432'}${replayTarget.pathname}`)
  .digest('hex')
  .slice(0, 16);
const lockPath = path.join(tmpdir(), `assistant-question-replay-${lockName}.lock`);
let lock: number;
try {
  lock = openSync(lockPath, 'wx', 0o600);
} catch {
  throw new Error(
    `Another replay owns this database. If it crashed, remove the stale lock: ${lockPath}`,
  );
}
process.on('exit', () => {
  closeSync(lock);
  unlinkSync(lockPath);
});
const isolatedEnv = {
  ...(values.live ? process.env : isolatedTestEnvironment(process.env)),
  DATABASE_URL: databaseUrl,
  TEST_DATABASE_URL: databaseUrl,
  ASSISTANT_TEST_TARGET_TOKEN: target.token,
  ...(!values.live
    ? {
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          `--import=${new URL('./deny-test-egress.mjs', import.meta.url).href}`,
        ]
          .filter(Boolean)
          .join(' '),
      }
    : {}),
};
const prepared = spawnSync('pnpm', ['--filter', '@assistant/db', 'test:prepare'], {
  env: isolatedEnv,
  encoding: 'utf8',
});
await writeFile(`${outputDir}/prepare.log`, `${prepared.stdout ?? ''}\n${prepared.stderr ?? ''}`, {
  mode: 0o600,
});
if (prepared.error || prepared.status !== 0) {
  spawnSync('pnpm', ['--filter', '@assistant/db', 'test:cleanup'], {
    env: isolatedEnv,
    stdio: 'ignore',
  });
  throw new Error(`Local test database preparation failed; see ${outputDir}/prepare.log`);
}
const db = createDb(databaseUrl);
const results: QuestionResult[] = [];
const notRun: string[] = [];
const notRunReasons: Record<string, string> = {};
const interruptedCases: DiagnosticInterruptedReceipt[] = [];
let cleanupFailed = false;
function runControl(remainingBudgetUsd: number) {
  return decideDiagnosticRunControl({
    fixtureIds: fixtures.map((fixture) => fixture.id),
    completed: results.map((result) => ({
      id: result.id,
      failures: result.failures,
      accountingStatus:
        result.diagnostic?.accounting.status ??
        (values.suite === 'calendar-diagnostic' ? 'incomplete' : 'not-applicable'),
    })),
    interrupted: interruptedCases.at(-1),
    live: values.live,
    remainingBudgetUsd,
    cleanupFailed,
  });
}
function retainNotRun(control: ReturnType<typeof runControl>) {
  for (const id of control.notRun) if (!notRun.includes(id)) notRun.push(id);
  Object.assign(notRunReasons, control.notRunReasons);
}
try {
  if (snapshot) {
    for (const model of snapshot.models)
      await db.insert(models).values(model).onConflictDoUpdate({ target: models.id, set: model });
    for (const role of snapshot.roles)
      await db
        .insert(modelRoles)
        .values(role)
        .onConflictDoUpdate({ target: modelRoles.role, set: role });
  }
  // Dedicated replay database only; no production identity, memory, calendars or inboxes.
  await db
    .update(agents)
    .set({ timezone: 'America/Los_Angeles', name: 'Regression Assistant', signature: '' });
  await db
    .update(budgets)
    .set({ limitUsd: String(maxSpend), softPct: 100 })
    .where(eq(budgets.scope, 'daily'));
  await db
    .update(budgets)
    .set({ limitUsd: String(maxSpend), softPct: 100 })
    .where(eq(budgets.scope, 'monthly'));
  for (const fixture of fixtures) {
    const spent = summarizeQuestions(results).costUsd;
    // Each transaction rolls back its cost ledger. Carry actual spend forward explicitly.
    const remaining = maxSpend - spent;
    const preflight = runControl(remaining);
    if (preflight.stopReason) {
      retainNotRun(preflight);
      break;
    }
    const deadline = AbortSignal.timeout(120_000);
    const captured = await captureDiagnosticCase(fixture.id, () =>
      runQuestion(db, fixture, {
        taskLimitUsd: Math.min(1, remaining / 1.1),
        ...(values.live
          ? {
              router: (replayDb) => {
                const router = new ModelRouter(replayDb, process.env.OPENROUTER_API_KEY ?? '');
                return new Proxy(router, {
                  get(target, property) {
                    const method = Reflect.get(target, property);
                    if (typeof method !== 'function') return method;
                    if (!['step', 'object', 'generate', 'embed'].includes(String(property)))
                      return method.bind(target);
                    return (first: unknown, options: Record<string, unknown> = {}) => {
                      deadline.throwIfAborted();
                      const signal =
                        options.abortSignal instanceof AbortSignal
                          ? AbortSignal.any([deadline, options.abortSignal])
                          : deadline;
                      return method.call(target, first, { ...options, abortSignal: signal });
                    };
                  },
                });
              },
            }
          : {}),
      }),
    );
    if (captured.interrupted) {
      const receipt = captured.interrupted;
      interruptedCases.push(receipt);
      await writeFile(`${outputDir}/${fixture.id}.json`, JSON.stringify(receipt, null, 2), {
        mode: 0o600,
      });
      retainNotRun(runControl(remaining));
      break;
    }
    const result = captured.result;
    if (values.suite === 'calendar-diagnostic') {
      result.failures.push(...evaluateCalendarDiagnostic(fixture, result));
    }
    results.push(result);
    await writeFile(`${outputDir}/${fixture.id}.json`, JSON.stringify(result, null, 2), {
      mode: 0o600,
    });
    console.log(
      `${result.failures.length ? 'FAIL' : fixture.independentRubric ? 'CHECKS_PASS_QUALITY_PENDING' : 'PASS'} ${fixture.id} ${(result.elapsedMs / 1000).toFixed(1)}s recorded $${result.costUsd.toFixed(4)}${result.diagnostic?.accounting.status === 'incomplete' ? ' (accounting incomplete)' : ''} (${result.approvals} approvals)`,
    );
    // Rollback discards reservations. An unknown charge must stop this pack,
    // rather than treating its missing cost as free allowance for another case.
    if (result.diagnostic?.accounting.status === 'incomplete') {
      retainNotRun(runControl(maxSpend - summarizeQuestions(results).costUsd));
      break;
    }
  }
} finally {
  try {
    await db.$client.end();
  } catch {
    cleanupFailed = true;
  }
  try {
    const cleanup = spawnSync('pnpm', ['--filter', '@assistant/db', 'test:cleanup'], {
      env: isolatedEnv,
      stdio: 'inherit',
    });
    cleanupFailed ||= Boolean(cleanup.error || cleanup.status !== 0);
  } catch {
    cleanupFailed = true;
  }
}
const finalControl = runControl(maxSpend - summarizeQuestions(results).costUsd);
retainNotRun(finalControl);
const summary = {
  ...summarizeQuestions(results),
  notRun,
  notRunReasons,
  interruptedCases,
  chargeOutcome: finalControl.chargeOutcome,
  cleanupFailed,
  mode: values.live ? 'live' : 'scripted',
  suite: values.suite,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  corpusSha256: createHash('sha256').update(JSON.stringify(corpus)).digest('hex'),
  ...(values.suite === 'calendar-diagnostic'
    ? {
        partition: values.partition,
        version:
          values.partition === 'holdout'
            ? CALENDAR_DIAGNOSTIC_HOLDOUT_VERSION
            : CALENDAR_DIAGNOSTIC_VERSION,
        dirtySourceIdentity: await dirtySourceIdentity(),
        sourceHashes: Object.fromEntries(
          await Promise.all(
            sourceFiles.map(async (file) => [
              file,
              createHash('sha256')
                .update(await readFile(file))
                .digest('hex'),
            ]),
          ),
        ),
        configSha256: values['model-config']
          ? createHash('sha256')
              .update(await readFile(values['model-config']))
              .digest('hex')
          : null,
        attribution:
          'Actual production entry routing; calendar private-read planning and some final projections are deterministic. Only observed router calls are model evidence. Independent utility review remains pending.',
        holdoutExposure: 'Development-exposed; not blind.',
        parityLimitations: [
          'Trace captures router message content, not the exact model-visible tool set, schema, tool choice or provider options. Registered fixture schemas are separately hashed; exact provider-request parity is unverified.',
          'Router entry calls do not identify all provider attempts, retries or fallback charges. Ledger coverage is conservative, not provider invoice reconciliation.',
        ],
        accountingComplete: finalControl.accountingComplete,
      }
    : {}),
  independentQualityReview: fixtures.some((fixture) => fixture.independentRubric)
    ? {
        status: 'pending',
        scope:
          'Automated checks cover effects and completion only. No open-ended quality pass is issued.',
        cases: fixtures
          .filter((fixture) => fixture.independentRubric)
          .map((fixture) => ({ id: fixture.id, rubric: fixture.independentRubric })),
      }
    : undefined,
  configCapturedAt: snapshot?.capturedAt ?? null,
  executedRecords: [...new Set(results.flatMap((result) => result.records))].sort((a, b) => a - b),
  applicationCoverage: APPLICATION_CASES,
  boundaries: [
    'Tool responses are frozen sanitized fixtures; model calls alone use the network in live mode.',
    'Executor, dispatcher, contracts and output verification are real; task state is rolled back.',
    'Most executor cases pre-set a plan; clarification also exercises the actual planner with scripted decisions. Application triage and real-model planning are separate checks.',
    'Saved rows are intercepted replay state, not proof of production memory/graph persistence.',
    'Formatting checks cover response structure; simulator/device visual tests remain separate.',
    '120-second per-case deadline; $1 per-task cap with the existing 10% owner-response allowance.',
  ],
};
await writeFile(`${outputDir}/summary.json`, JSON.stringify(summary, null, 2), { mode: 0o600 });
const rows = results
  .map(
    (result) =>
      `| ${result.id} | ${result.failures.length ? 'FAIL' : summary.independentQualityReview ? 'Checks pass; quality pending' : 'PASS'} | ${(result.elapsedMs / 1000).toFixed(1)}s | $${result.costUsd.toFixed(4)} | ${result.approvals} | ${result.failures.join('; ').replaceAll('|', '\\|')} |`,
  )
  .join('\n');
await writeFile(
  `${outputDir}/report.md`,
  `# Question regression\n\nMode: ${summary.mode}. Suite: ${summary.suite}. Commit: ${summary.commit}. ${summary.passed}/${summary.cases} passed. Not run: ${notRun.length}. Recorded cost: $${summary.costUsd.toFixed(4)}. Interrupted cases: ${interruptedCases.length}; their charges are unknown. Cleanup failed: ${cleanupFailed}. p50 ${(summary.p50Ms / 1000).toFixed(1)}s; p95 ${(summary.p95Ms / 1000).toFixed(1)}s.\n\n| Case | Result | Time | Cost | Approvals | Failures |\n|---|---|---:|---:|---:|---|\n${rows}\n\n${summary.boundaries.map((text) => `- ${text}`).join('\n')}\n`,
  { mode: 0o600 },
);
console.log(JSON.stringify(summary, null, 2));
process.exitCode = finalControl.exitCode;
