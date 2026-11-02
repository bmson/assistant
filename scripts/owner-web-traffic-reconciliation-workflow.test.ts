// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Literal reviewed workflow expressions.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const yml = readFileSync(
  new URL('../.github/workflows/owner-web-traffic-reconciliation.yml', import.meta.url),
  'utf8',
);
const job = yml.slice(yml.indexOf('\njobs:'));
function eligible(overrides: Record<string, unknown> = {}) {
  const values = {
    'github.ref': 'refs/heads/main',
    'github.run_attempt': '1',
    'github.event_name': 'workflow_dispatch',
    'inputs.mode': 'plan',
    'github.workflow_ref':
      'bmson/assistant/.github/workflows/owner-web-traffic-reconciliation.yml@refs/heads/main',
    'github.workflow_sha': 'a'.repeat(40),
    'github.sha': 'a'.repeat(40),
    'inputs.reviewed_source_sha': 'a'.repeat(40),
    ...overrides,
  };
  const match = job.match(/ {4}if: >-\n((?: {6}.*\n)+)/);
  if (!match?.[1]) throw new Error('Missing protected job gate');
  const expression = match[1]
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/'([^']*)'/g, (_, s) => JSON.stringify(s))
    .replace(/\b(?:github|inputs)\.[a-zA-Z0-9_.]+/g, (k) =>
      JSON.stringify(values[k as keyof typeof values] ?? ''),
    );
  if (
    /[^\s()=!&|]/.test(
      expression.replace(/"(?:[^"\\]|\\.)*"/g, '').replace(/\b(?:true|false)\b/g, ''),
    )
  )
    throw new Error('Unsupported guard syntax');
  return Boolean(Function(`"use strict";return (${expression})`)());
}
describe('dedicated fixed correction workflow controls', () => {
  it('has only manual plan/apply and one protected job, with no release or cleanup trigger', () => {
    expect(yml).toContain('workflow_dispatch:');
    expect(yml).toContain('options: [plan, apply]');
    expect(yml).toContain('default: plan');
    expect(yml).not.toMatch(/workflow_run:|pull_request:|^ {2}push:/m);
    expect([...job.matchAll(/^ {2}([a-z_]+):$/gm)].map((m) => m[1])).toEqual(['reconcile']);
    expect(yml).toContain('group: production-deploy\n  cancel-in-progress: false');
    expect(job).toContain('environment: production');
  });
  it.each(['plan', 'apply'])('accepts only valid protected context for %s', (mode) =>
    expect(eligible({ 'inputs.mode': mode })).toBe(true),
  );
  it.each([
    { 'github.ref': 'refs/heads/other' },
    { 'github.run_attempt': '2' },
    { 'github.event_name': 'push' },
    { 'inputs.mode': 'unknown' },
    { 'inputs.mode': '' },
    { 'github.workflow_ref': 'other' },
    { 'github.workflow_sha': 'b'.repeat(40) },
    { 'inputs.reviewed_source_sha': 'b'.repeat(40) },
  ])('skips the entire credentialed job for invalid context %j', (overrides) =>
    expect(eligible(overrides)).toBe(false),
  );
  it('checks source before auth and isolates plan from apply', () => {
    expect(job.indexOf('--verify-source')).toBeLessThan(job.indexOf('google-github-actions/auth@'));
    expect(job).toContain(
      "if: inputs.mode == 'plan'\n        run: pnpm exec tsx scripts/owner-web-traffic-reconciliation-command.ts --plan",
    );
    expect(job).toContain(
      "if: inputs.mode == 'apply'\n        run: pnpm exec tsx scripts/owner-web-traffic-reconciliation-command.ts --apply",
    );
    expect(job).toContain('ref: ${{ github.workflow_sha }}');
    expect(job).toContain('persist-credentials: false');
    expect(job).toContain('pnpm install --frozen-lockfile --ignore-scripts');
    expect(job).toContain('version: 576.0.0');
  });
  it('archives only fixed sanitized receipt files and cannot call retirement/release/cleanup/annotations', () => {
    expect(job).toContain('if: always()');
    expect(job).toContain(
      'owner-web-traffic-reconciliation-plan.json\n            owner-web-traffic-reconciliation-result.json\n            owner-web-traffic-reconciliation-failure.json',
    );
    expect(job).toContain('overwrite: false');
    expect(job).not.toMatch(
      /release\.sh|release-firestore|cleanup-current|retirement-command|updateMask=annotations|--resume|--rollback|createR|delivery-guard/,
    );
    expect([...job.matchAll(/uses: actions\/upload-artifact/g)]).toHaveLength(1);
  });
});
