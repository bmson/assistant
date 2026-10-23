import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoRoot, 'scripts/question-regression.ts');
const denyEgress = path.join(repoRoot, 'scripts/deny-test-egress.mjs');
const invalidDatabaseUrl = 'not-a-database-url';

function runCli(args: string[]) {
  const env = {
    PATH: process.env.PATH ?? '',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'C',
    LC_ALL: 'C',
    ASSISTANT_TEST_NO_EXTERNAL_CREDENTIALS: '1',
  };
  expect(
    Object.keys(env).some((key) => /(?:API_KEY|TOKEN|CREDENTIAL|SECRET|ACCESS_KEY)$/i.test(key)),
  ).toBe(false);
  return spawnSync(process.execPath, ['--import', 'tsx', '--import', denyEgress, cli, ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function readPreparation(directory: string) {
  return JSON.parse(readFileSync(path.join(directory, 'preparation.json'), 'utf8')) as {
    manifestVersion: number;
    mode: string;
    status: string;
    suite: string;
    partition: string;
    version: string;
    sourceCommit: string;
    sourceHashes: Record<string, string>;
    dirtySourceIdentity: {
      dirtyFileHashes: Record<string, string | null>;
      workingDiffSha256: string;
      scope: string;
    };
    configSha256: string | null;
    corpusSha256: string;
    schemaManifestSha256: string;
    blockers: string[];
    cases: Array<{
      id: string;
      run: {
        status: string;
        modelCalls: unknown;
        toolCalls: unknown;
        latencyMs: unknown;
        tokens: unknown;
        costUsd: unknown;
        quality: string;
      };
    }>;
  };
}

describe('calendar diagnostic preparation CLI', () => {
  it('prepares diagnostic and holdout receipts without database, credentials, inference, or overwrite', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'calendar-diagnostic-cli-'));
    try {
      const diagnosticDir = path.join(root, 'diagnostic');
      const defaultPreparation = runCli([
        '--suite',
        'calendar-diagnostic',
        '--database',
        invalidDatabaseUrl,
        '--output',
        diagnosticDir,
      ]);
      expect(defaultPreparation.status, defaultPreparation.stderr).toBe(0);
      const diagnostic = readPreparation(diagnosticDir);
      expect(diagnostic).toMatchObject({
        manifestVersion: 1,
        mode: 'prepare',
        status: 'not_run',
        suite: 'calendar-diagnostic',
        partition: 'diagnostic',
        version: 'calendar-diagnostic-v1',
        configSha256: null,
        blockers: ['inference_not_requested', 'database_not_accessed', 'credential_not_checked'],
      });
      expect(diagnostic.cases).toHaveLength(6);
      expect(diagnostic.cases.every((entry) => entry.run.status === 'not_run')).toBe(true);
      expect(
        diagnostic.cases.every(
          (entry) =>
            [
              entry.run.modelCalls,
              entry.run.toolCalls,
              entry.run.latencyMs,
              entry.run.tokens,
              entry.run.costUsd,
            ].every((value) => value === null) && entry.run.quality === 'not_evaluated',
        ),
      ).toBe(true);
      expect(Object.keys(diagnostic.sourceHashes)).toContain(
        'packages/tools/src/question-regression/calendar-diagnostic-tools.ts',
      );
      expect(
        Object.values(diagnostic.sourceHashes).every((hash) => /^[a-f0-9]{64}$/.test(hash)),
      ).toBe(true);
      for (const seam of [
        'packages/core/src/workflow/calendar-event-analysis.ts',
        'packages/core/src/workflow/calendar-relationship.ts',
        'packages/persistence/src/calendar-occurrence.ts',
        'packages/core/src/workflow/read-intent.ts',
        'packages/core/src/workflow/executor/step-loop.ts',
        'packages/core/src/workflow/calendar-agenda.ts',
        'packages/core/src/workflow/response-cards.ts',
        'packages/core/src/workflow/briefing.ts',
        'packages/core/src/workflow/calendar-source-link.ts',
      ])
        expect(diagnostic.sourceHashes[seam]).toMatch(/^[a-f0-9]{64}$/);
      expect(diagnostic.dirtySourceIdentity.workingDiffSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(diagnostic.dirtySourceIdentity.scope).toContain('not an exhaustive');
      expect(diagnostic.corpusSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(diagnostic.schemaManifestSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(statSync(diagnosticDir).mode & 0o777).toBe(0o700);
      const receiptPath = path.join(diagnosticDir, 'preparation.json');
      expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
      const originalReceipt = readFileSync(receiptPath);

      const overwrite = runCli([
        '--suite',
        'calendar-diagnostic',
        '--database',
        invalidDatabaseUrl,
        '--output',
        diagnosticDir,
      ]);
      expect(overwrite.status).not.toBe(0);
      expect(readFileSync(receiptPath)).toEqual(originalReceipt);
      expect(readdirSync(diagnosticDir)).toEqual(['preparation.json']);

      const holdoutDir = path.join(root, 'holdout');
      const holdoutRun = runCli([
        '--suite',
        'calendar-diagnostic',
        '--partition',
        'holdout',
        '--prepare',
        '--database',
        invalidDatabaseUrl,
        '--output',
        holdoutDir,
      ]);
      expect(holdoutRun.status, holdoutRun.stderr).toBe(0);
      const holdout = readPreparation(holdoutDir);
      expect(holdout).toMatchObject({
        suite: 'calendar-diagnostic',
        partition: 'holdout',
        status: 'not_run',
      });
      expect(holdout.version).toContain('holdout');
      expect(holdout.cases).toHaveLength(6);
      expect(holdout.cases.every((entry) => entry.run.status === 'not_run')).toBe(true);

      const invalidCaseDir = path.join(root, 'invalid-case');
      const invalidCase = runCli([
        '--suite',
        'calendar-diagnostic',
        '--cases',
        'missing-diagnostic-case',
        '--database',
        invalidDatabaseUrl,
        '--output',
        invalidCaseDir,
      ]);
      expect(invalidCase.status).not.toBe(0);
      expect(`${invalidCase.stdout}\n${invalidCase.stderr}`).toContain('unknown case ID');
      expect(() => statSync(invalidCaseDir)).toThrow();

      const liveDir = path.join(root, 'live-rejected');
      const livePreparation = runCli([
        '--suite',
        'calendar-diagnostic',
        '--prepare',
        '--live',
        '--database',
        invalidDatabaseUrl,
        '--output',
        liveDir,
      ]);
      expect(livePreparation.status).not.toBe(0);
      expect(`${livePreparation.stdout}\n${livePreparation.stderr}`).toContain(
        'cannot request --live',
      );
      expect(() => statSync(liveDir)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
