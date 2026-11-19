import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayCases } from '../apps/agent/src/proactive-replay-cases.js';
import {
  type ScoredReplayCase,
  scoreReplayKinds,
} from '../apps/agent/src/proactive-replay-score.js';

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
  throw new Error('The replay scorecard requires a loopback FIRESTORE_EMULATOR_HOST.');
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--firestore-suite'))
  throw new Error('Usage: pnpm test:proactive-replay [--firestore-suite]');

function sourceSnapshot() {
  const revision = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  if (revision.status !== 0 || status.status !== 0) return null;
  return { revision: revision.stdout.trim(), clean: status.stdout.length === 0 };
}

const documentedScenarios = Array.from(
  readFileSync(new URL('../docs/proactive/golden-signals.md', import.meta.url), 'utf8').matchAll(
    /^\|\s*(S\d{2})\s*\|\s*([^|]+)\|/gm,
  ),
  ([, id, signal]) => ({ id: id as string, signal: (signal as string).trim() }),
);
const expectedReplayIds = Object.values(replayCases).map(({ id }) => id);
const documentedIds = new Set(documentedScenarios.map(({ id }) => id));
const implementedIds = new Set<string>(
  expectedReplayIds.filter((id) => !id.startsWith('CONTROL-')),
);
if (
  documentedScenarios.length === 0 ||
  documentedIds.size !== documentedScenarios.length ||
  [...implementedIds].some((id) => !documentedIds.has(id))
)
  throw new Error('The replay cases must match unique IDs in the golden-signal scenario table.');

const sourceAtStart = sourceSnapshot();
const evidenceDir = mkdtempSync(join(tmpdir(), 'assistant-proactive-replay-'));
const outputDir = '.artifacts/proactive-replay';
const scope =
  'Frozen synthetic slice, with disposable PostgreSQL and Firestore emulator and a fake push sink.';
try {
  const result = spawnSync(
    'pnpm',
    args[0] === '--firestore-suite'
      ? ['test:firestore']
      : [
          'test',
          'apps/agent/src/proactive-replay.test.ts',
          'apps/agent/src/proactive-replay-score.test.ts',
        ],
    { env: { ...process.env, ASSISTANT_REPLAY_SCORE_TEMP: evidenceDir }, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  const adapters = ['postgres', 'firestore'].map((adapter) => {
    let cases: ScoredReplayCase[] = [];
    try {
      cases = JSON.parse(
        readFileSync(join(evidenceDir, `${adapter}.json`), 'utf8'),
      ) as ScoredReplayCase[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const benchmark = cases.filter(({ id }) => implementedIds.has(id));
    const sum = (
      key:
        | 'matched'
        | 'expected'
        | 'delivered'
        | 'quietViolations'
        | 'setupExpected'
        | 'setupDeliveries'
        | 'setupMatches',
    ) => benchmark.reduce((total, row) => total + row[key], 0);
    const expected = sum('expected') - sum('setupExpected');
    const delivered = sum('delivered') - sum('setupDeliveries');
    const matched = sum('matched') - sum('setupMatches');
    const complete =
      cases.length === expectedReplayIds.length &&
      expectedReplayIds.every((id) => cases.some((entry) => entry.id === id));
    return {
      adapter,
      complete,
      passed: complete && cases.every((entry) => entry.passed),
      score: {
        matched,
        expected,
        delivered,
        recall: expected ? matched / expected : null,
        precision: delivered ? matched / delivered : null,
        quietViolations: sum('quietViolations'),
      },
      perKind: scoreReplayKinds(benchmark),
      cases,
    };
  });
  const scenarios = documentedScenarios.map(({ id, signal }) => ({
    id,
    signal,
    drivers: adapters.map(({ adapter, cases }) => {
      if (!implementedIds.has(id)) return { adapter, status: 'unimplemented' };
      const evidence = cases.find((entry) => entry.id === id);
      if (!evidence) return { adapter, status: 'awaiting-evidence' };
      return { adapter, status: 'covered', result: evidence.passed ? 'pass' : 'fail' };
    }),
  }));
  const coverage = {
    documentedScenarios: documentedScenarios.length,
    implementedScenarios: implementedIds.size,
    scenariosWithEvidenceOnBothDrivers: scenarios.filter(({ drivers }) =>
      drivers.every(({ status }) => status === 'covered'),
    ).length,
    scenarios,
  };
  const sourceAtEnd = sourceSnapshot();
  const source = {
    revision: sourceAtStart?.revision ?? null,
    cleanAtBothChecks:
      sourceAtStart?.clean === true &&
      sourceAtEnd?.clean === true &&
      sourceAtEnd.revision === sourceAtStart.revision,
  };
  const validated = result.status === 0 && adapters.every((adapter) => adapter.complete);
  const passed = validated && adapters.every((adapter) => adapter.passed);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    join(outputDir, 'benchmark-result.json'),
    `${JSON.stringify(
      {
        version: 4,
        source,
        scope,
        replayValidated: validated,
        executedSubsetPassed: passed,
        coverage,
        productionRecall: 'unmeasured',
        adapters,
      },
      null,
      2,
    )}\n`,
  );
  const markdown = [
    '# Proactive replay scorecard',
    '',
    scope,
    '',
    source.revision
      ? 'Source commit ' +
        source.revision +
        (source.cleanAtBothChecks
          ? ' (clean at start and finish).'
          : ' (local edits or revision change).')
      : 'Source revision unavailable.',
    '',
    'Recall divides on-time credit by expected deliveries. Precision divides that credit by observed deliveries. An on-time exact-source match with a durable, grounded card earns one point on the expected channel and half for a channel mismatch. Stack expects no push. Push expects a single call and matching fake and durable acknowledgments. Unknown kind covers excess notices or push calls without ledger entries.',
    '',
    'The S13 same-day control, S14 due setup, and generic control are excluded from the executed subset’s precision and recall.',
    '',
    `Replay validation: ${validated ? 'complete' : 'failed'}. Executed product scenarios: ${passed ? 'all passed' : 'one or more failed or lack validated evidence'}.`,
    '',
    '## Golden-signal coverage',
    '',
    `${coverage.implementedScenarios} of ${coverage.documentedScenarios} documented scenarios have executable fixtures. ${coverage.scenariosWithEvidenceOnBothDrivers} of ${coverage.documentedScenarios} have evidence on both drivers in this run. Overall benchmark recall and precision require full coverage. Production recall remains unmeasured.`,
    '',
    '| ID | Signal | PostgreSQL | Firestore |',
    '| --- | --- | --- | --- |',
  ];
  for (const { id, signal, drivers } of coverage.scenarios) {
    const statuses = drivers.map(({ status, result }) =>
      status === 'covered'
        ? `Covered (${result})`
        : status === 'awaiting-evidence'
          ? 'Awaiting evidence'
          : 'Unimplemented',
    );
    markdown.push(`| ${id} | ${signal} | ${statuses.join(' | ')} |`);
  }
  markdown.push('');
  for (const adapter of adapters) {
    const percent = (value: number | null) =>
      value === null ? '—' : `${(value * 100).toFixed(1)}%`;
    markdown.push(
      `## ${adapter.adapter === 'postgres' ? 'PostgreSQL' : 'Firestore'}`,
      '',
      `On-time recall ${adapter.score.matched}/${adapter.score.expected} (${percent(adapter.score.recall)}) · Precision ${adapter.score.matched}/${adapter.score.delivered} (${percent(adapter.score.precision)}) · Quiet violations ${adapter.score.quietViolations}`,
      '',
      '| Kind | On-time recall | Precision | Misses | False positives |',
      '| --- | ---: | ---: | ---: | ---: |',
    );
    for (const row of adapter.perKind) {
      markdown.push(
        `| ${row.kind ?? 'Unknown (notice or push only)'} | ${row.matched}/${row.expected} (${percent(row.recall)}) | ${row.matched}/${row.delivered} (${percent(row.precision)}) | ${row.misses} | ${row.falsePositives} |`,
      );
    }
    if (!adapter.perKind.length) markdown.push('| — | — | — | — | — |');
    const benchmark = adapter.cases.filter(({ id }) => implementedIds.has(id));
    markdown.push(
      '',
      '### Timing by kind',
      '',
      '| Kind | Case and tick | Channel | Expected window (min) | Ledger delivery times (min) | On-time credit |',
      '| --- | --- | --- | ---: | --- | ---: |',
    );
    for (const row of adapter.perKind) {
      const sameTick = (a: { caseId: string; tick: string }, b: { caseId: string; tick: string }) =>
        a.caseId === b.caseId && a.tick === b.tick;
      for (const check of row.expectations) {
        const minutes = row.observedTiming
          .filter((observation) => sameTick(check, observation))
          .map(({ elapsedMinutes }) => elapsedMinutes);
        markdown.push(
          `| ${row.kind} | ${check.caseId} · ${check.tick} | ${check.channel} | ${check.earliestMinutes}–${check.latestMinutes} | ${minutes.join(', ') || '—'} | ${check.credit} |`,
        );
      }
      for (const observation of row.observedTiming) {
        if (row.expectations.some((check) => sameTick(check, observation))) continue;
        markdown.push(
          `| ${row.kind} | ${observation.caseId} · ${observation.tick} | — | — | ${observation.elapsedMinutes} | 0 |`,
        );
      }
    }
    if (!adapter.perKind.some((row) => row.expectations.length || row.observedTiming.length))
      markdown.push('| — | Evidence unavailable | — | — | — | — |');
    markdown.push(
      '',
      '### Required silence',
      '',
      '| Case and tick | Expected phase and reason | Observations | Violations |',
      '| --- | --- | ---: | ---: |',
    );
    for (const row of benchmark) {
      for (const check of row.quietChecks) {
        markdown.push(
          `| ${row.id} · ${check.tick} | ${check.phase} · ${check.reason} | ${check.observations} | ${check.violations} |`,
        );
      }
    }
    if (!benchmark.some((row) => row.quietChecks.length))
      markdown.push('| — | Evidence unavailable | — | — |');
    markdown.push(
      '',
      '### Replay cases',
      '',
      '| Case | Result | Deliveries outside setup | Setup deliveries | Fake push calls | Timing including setup |',
      '| --- | --- | ---: | ---: | ---: | --- |',
    );
    for (const row of adapter.cases) {
      const minutes = row.ticks.flatMap(({ moments }) =>
        moments.map(({ elapsedMinutes }) => `${elapsedMinutes} min`),
      );
      const calls = row.ticks.reduce((sum, tick) => sum + tick.pushSinkCalls, 0);
      markdown.push(
        `| ${row.id} | ${row.passed ? 'Pass' : 'Fail'} | ${row.delivered - row.setupDeliveries} | ${row.setupDeliveries} | ${calls} | ${minutes.join(', ') || '—'} |`,
      );
    }
    if (!adapter.cases.length) markdown.push('| — | Evidence unavailable | — | — | — | — |');
    markdown.push('');
    for (const row of adapter.cases)
      for (const finding of row.findings) markdown.push(`- ${row.id} — ${finding}`);
    if (adapter.cases.some((row) => row.findings.length)) markdown.push('');
  }
  writeFileSync(join(outputDir, 'benchmark-result.md'), `${markdown.join('\n').trimEnd()}\n`);
  console.log(`Proactive replay scorecard written to ${outputDir}`);
  process.exitCode = validated ? 0 : result.status || 1;
} finally {
  rmSync(evidenceDir, { recursive: true, force: true });
}
