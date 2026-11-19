import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScoredReplayCase } from '../apps/agent/src/proactive-replay-score.js';

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
    const benchmark = cases.filter(({ id }) => !id.startsWith('CONTROL-'));
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
    return {
      adapter,
      passed: cases.length > 0 && cases.every(({ passed }) => passed),
      score: {
        matched,
        expected,
        delivered,
        recall: expected ? matched / expected : null,
        precision: delivered ? matched / delivered : null,
        quietViolations: sum('quietViolations'),
      },
      cases,
    };
  });
  const sourceAtEnd = sourceSnapshot();
  const source = {
    revision: sourceAtStart?.revision ?? null,
    cleanAtBothChecks:
      sourceAtStart?.clean === true &&
      sourceAtEnd?.clean === true &&
      sourceAtEnd.revision === sourceAtStart.revision,
  };
  const passed = result.status === 0 && adapters.every((adapter) => adapter.passed);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    join(outputDir, 'benchmark-result.json'),
    `${JSON.stringify(
      {
        version: 1,
        source,
        scope,
        passed,
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
    'The channel score reflects the fake push acknowledgment. The S14 due setup and generic control are scored separately from benchmark precision and recall. This is a three-case slice of docs/proactive/golden-signals.md.',
    '',
  ];
  for (const adapter of adapters) {
    const percent = (value: number | null) =>
      value === null ? '—' : `${(value * 100).toFixed(1)}%`;
    markdown.push(
      `## ${adapter.adapter === 'postgres' ? 'PostgreSQL' : 'Firestore'}`,
      '',
      `On-time recall ${adapter.score.matched}/${adapter.score.expected} (${percent(adapter.score.recall)}) · Precision ${adapter.score.matched}/${adapter.score.delivered} (${percent(adapter.score.precision)}) · Quiet violations ${adapter.score.quietViolations}`,
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
  process.exitCode = passed ? 0 : result.status || 1;
} finally {
  rmSync(evidenceDir, { recursive: true, force: true });
}
