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
  QUESTION_CASES,
  type QuestionResult,
  runQuestion,
  summarizeQuestions,
} from '@assistant/tools/question-regression';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { allocateTestTarget, isolatedTestEnvironment } from './test-target.js';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
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
    'pnpm eval:questions [--suite audit|assistant|all] [--live --model-config <snapshot.json>] [--cases id,id] [--budget 5] [--output <directory>] [--database <loopback _test URL>]\nDefaults to scripted audit replay. The assistant suite exercises interaction, approval and recovery scenarios. Live mode uses the existing OpenRouter credential and captured production model roles. All external tools are intercepted; all task state rolls back.',
  );
  process.exit(0);
}
const sourceDatabaseUrl = assertReplayDatabaseUrl(
  values.database ?? 'postgres://assistant:assistant@localhost:5432/assistant_questions_test',
);
const target = allocateTestTarget(sourceDatabaseUrl);
const databaseUrl = target.databaseUrl;
const maxSpend = Number(values.budget);
if (!Number.isFinite(maxSpend) || maxSpend < 0.1 || maxSpend > 20)
  throw new Error('--budget must be $0.10–$20');
if (!['audit', 'assistant', 'all'].includes(values.suite ?? ''))
  throw new Error('--suite must be audit, assistant or all');
const corpus =
  values.suite === 'assistant'
    ? ASSISTANT_SCENARIOS
    : values.suite === 'all'
      ? [...QUESTION_CASES, ...ASSISTANT_SCENARIOS]
      : QUESTION_CASES;
const ids = values.cases?.split(',');
if (ids?.some((id) => !corpus.some((fixture) => fixture.id === id)))
  throw new Error('--cases contains an unknown case ID');
const fixtures = corpus.filter((fixture) => !ids || ids.includes(fixture.id));
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
process.env.DATABASE_URL = databaseUrl;
process.env.TEST_DATABASE_URL = databaseUrl;
process.env.ASSISTANT_TEST_TARGET_TOKEN = target.token;
process.env.CHAT_RECALL_ENABLED = 'false';
process.env.AUTH_DEV_BYPASS = 'false';
process.env.QUEUE_DRIVER = 'local';
if (values.live && (!values['model-config'] || !process.env.OPENROUTER_API_KEY))
  throw new Error(
    'Live replay requires --model-config and an existing OPENROUTER_API_KEY; no new credential is created.',
  );
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
let cleanupFailed = false;
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
    if (values.live && remaining < 0.1) {
      notRun.push(fixture.id);
      continue;
    }
    const deadline = AbortSignal.timeout(120_000);
    const result = await runQuestion(db, fixture, {
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
    });
    results.push(result);
    await writeFile(`${outputDir}/${fixture.id}.json`, JSON.stringify(result, null, 2), {
      mode: 0o600,
    });
    console.log(
      `${result.failures.length ? 'FAIL' : 'PASS'} ${fixture.id} ${(result.elapsedMs / 1000).toFixed(1)}s $${result.costUsd.toFixed(4)} (${result.approvals} approvals)`,
    );
  }
} finally {
  await db.$client.end();
  const cleanup = spawnSync('pnpm', ['--filter', '@assistant/db', 'test:cleanup'], {
    env: isolatedEnv,
    stdio: 'inherit',
  });
  cleanupFailed = Boolean(cleanup.error || cleanup.status !== 0);
}
if (cleanupFailed) throw new Error('Disposable question replay database cleanup failed.');
const summary = {
  ...summarizeQuestions(results),
  notRun,
  mode: values.live ? 'live' : 'scripted',
  suite: values.suite,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  corpusSha256: createHash('sha256').update(JSON.stringify(corpus)).digest('hex'),
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
      `| ${result.id} | ${result.failures.length ? 'FAIL' : 'PASS'} | ${(result.elapsedMs / 1000).toFixed(1)}s | $${result.costUsd.toFixed(4)} | ${result.approvals} | ${result.failures.join('; ').replaceAll('|', '\\|')} |`,
  )
  .join('\n');
await writeFile(
  `${outputDir}/report.md`,
  `# Question regression\n\nMode: ${summary.mode}. Suite: ${summary.suite}. Commit: ${summary.commit}. ${summary.passed}/${summary.cases} passed. Not run: ${notRun.length}. Cost: $${summary.costUsd.toFixed(4)}. p50 ${(summary.p50Ms / 1000).toFixed(1)}s; p95 ${(summary.p95Ms / 1000).toFixed(1)}s.\n\n| Case | Result | Time | Cost | Approvals | Failures |\n|---|---|---:|---:|---:|---|\n${rows}\n\n${summary.boundaries.map((text) => `- ${text}`).join('\n')}\n`,
  { mode: 0o600 },
);
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.failed || notRun.length ? 1 : 0;
