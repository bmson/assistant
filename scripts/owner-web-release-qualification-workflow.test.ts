// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Literal GitHub workflow syntax under test.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
// Deliberately limited to this workflow's exact job indentation and boolean grammar.
// Unknown syntax/job additions fail these assertions instead of silently being interpreted.
const jobs = new Map(
  [...workflow.matchAll(/^ {2}([a-z_]+):\n([\s\S]*?)(?=^ {2}[a-z_]+:\n|$(?![\s\S]))/gm)]
    .filter((m) => ['plan', 'image', 'release', 'native_web_qualification'].includes(m[1] ?? ''))
    .map((m) => [m[1] as string, m[2] as string]),
);
function nativeWebQualificationDefault(source: string): string | undefined {
  const lines = source.split(/\r?\n/);
  const starts = lines.flatMap((line, index) =>
    /^ {6}native_web_qualification:[ \t]*$/.test(line) ? [index] : [],
  );
  if (starts.length !== 1) return undefined;

  const defaults: string[] = [];
  for (const line of lines.slice((starts[0] as number) + 1)) {
    if (/^ {6}[A-Za-z_][A-Za-z0-9_-]*:[ \t]*$/.test(line)) break;
    if (/^ {0,5}\S/.test(line)) break;
    const match = /^ {8}default:[ \t]*(.*?)[ \t]*$/.exec(line);
    if (match) defaults.push(match[1] as string);
  }
  if (defaults.length !== 1) return undefined;
  const value = defaults[0] as string;
  return value === 'off' || value === "'off'" || value === '"off"' ? 'off' : undefined;
}
function condition(job: string) {
  const text = jobs.get(job);
  if (!text) throw new Error('Missing job');
  const m = text.match(/^ {4}if: (.*)\n((?: {6}.*\n)*)/m);
  if (!m) throw new Error('Missing job guard');
  return (m[1] === '>-' ? m[2] : m[1])?.trim().replace(/\s+/g, ' ') as string;
}
function evaluate(expression: string, values: Record<string, unknown>, success = true) {
  let text = expression.replace(/'(?:[^']*)'/g, (m) => JSON.stringify(m.slice(1, -1)));
  text = text.replace(/\b(?:github|inputs)\.[a-zA-Z0-9_.]+/g, (m) =>
    JSON.stringify(values[m] ?? ''),
  );
  text = text.replace(/\balways\(\)/g, 'true').replace(/\bsuccess\(\)/g, String(success));
  if (/[^\s()=!&|]/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '').replace(/\b(?:true|false)\b/g, '')))
    throw new Error('Unsupported expression');
  // Trusted source expression with every context value replaced by a JSON literal.
  return Boolean(Function(`"use strict";return (${text})`)());
}
const source = 'a'.repeat(40);
function context(overrides: Record<string, unknown> = {}) {
  return {
    'github.event_name': 'workflow_dispatch',
    'github.ref': 'refs/heads/main',
    'github.run_attempt': '1',
    'github.workflow_ref': 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
    'github.workflow_sha': source,
    'github.sha': source,
    'inputs.native_web_qualification': 'read_only',
    'inputs.sha': '',
    'inputs.break_glass': false,
    ...overrides,
  };
}
describe('default-off workflow isolation for the read-only qualification', () => {
  it('enumerates every job and retains production environment and shared non-cancelling lock', () => {
    expect(
      [...workflow.slice(workflow.indexOf('\njobs:')).matchAll(/^ {2}([a-z_]+):$/gm)].map(
        (m) => m[1],
      ),
    ).toEqual(['plan', 'image', 'release', 'native_web_qualification']);
    expect(nativeWebQualificationDefault(workflow)).toBe('off');
    expect(workflow).toContain('group: production-deploy\n  cancel-in-progress: false');
    expect(jobs.get('native_web_qualification')).toContain('environment: production');
  });
  it.each(["'off'", '"off"', 'off'])('reads valid YAML default formatting %s as off', (value) => {
    const source = [
      '      native_web_qualification:',
      `        default: ${value}`,
      '      sha:',
      '        default: "on"',
    ].join('\n');
    expect(nativeWebQualificationDefault(source)).toBe('off');
  });
  it.each([
    '      native_web_qualification:\n        default: on\n      sha:\n        default: off',
    '      native_web_qualification:\n        description: no default\n      sha:\n        default: off',
    '      native_web_qualification:\n        default: off\n        default: "off"\n      sha:',
    '      native_web_qualification:\n        description: one\n      native_web_qualification:\n        default: off',
  ])('rejects changed, missing, or ambiguous selector defaults', (source) => {
    expect(nativeWebQualificationDefault(source)).toBeUndefined();
  });
  it.each(['success', 'failure', 'cancelled', 'skipped'])(
    'skips every normal job and therefore every nested always/failure/hold/cleanup step when prior status is %s',
    (status) => {
      for (const job of ['plan', 'image', 'release'])
        expect(evaluate(condition(job), context(), status === 'success')).toBe(false);
      expect(evaluate(condition('native_web_qualification'), context())).toBe(true);
      const release = jobs.get('release') ?? '';
      for (const path of [
        'restore',
        'cleanup-current.py',
        'release.sh',
        'always()',
        'firestore-delivery-guard.py',
      ])
        expect(release).toContain(path);
    },
  );
  it.each([
    { 'inputs.native_web_qualification': 'unknown' },
    { 'github.ref': 'refs/heads/other' },
    { 'github.run_attempt': '2' },
    { 'github.event_name': 'push' },
    { 'github.workflow_ref': 'bmson/assistant/.github/workflows/other.yml@refs/heads/main' },
    { 'github.workflow_sha': 'b'.repeat(40) },
    { 'inputs.sha': 'b'.repeat(40) },
    { 'inputs.break_glass': true },
  ])('refuses invalid qualifier context %j', (override) => {
    expect(evaluate(condition('native_web_qualification'), context(override))).toBe(false);
  });
  it.each(['', 'off'])('preserves the ordinary manual path for selector %j', (selector) => {
    const values = context({ 'inputs.native_web_qualification': selector });
    expect(evaluate(condition('plan'), values)).toBe(true);
    expect(evaluate(condition('image'), values)).toBe(true);
    expect(evaluate(condition('release'), values)).toBe(true);
    expect(evaluate(condition('native_web_qualification'), values)).toBe(false);
  });
  it('preserves successful same-repository main-push CI deployment', () => {
    const values = context({
      'github.event_name': 'workflow_run',
      'inputs.native_web_qualification': '',
      'github.event.workflow_run.conclusion': 'success',
      'github.event.workflow_run.event': 'push',
      'github.event.workflow_run.head_repository.full_name': 'bmson/assistant',
      'github.repository': 'bmson/assistant',
      'github.event.workflow_run.head_branch': 'main',
    });
    expect(evaluate(condition('plan'), values)).toBe(true);
    expect(evaluate(condition('native_web_qualification'), values)).toBe(false);
  });
  it('allows only source setup, the probe, and one fixed redacted report upload in the qualifier job', () => {
    const job = jobs.get('native_web_qualification') ?? '';
    const actions = [...job.matchAll(/uses: ([^\n]+)/g)].map((m) => m[1]);
    expect(actions).toEqual([
      'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5',
      'pnpm/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa',
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      'actions/upload-artifact@65462800fd760344b1a7b4382951275a0abb4808',
    ]);
    expect(job).not.toContain('cache:');
    expect(job).toContain('persist-credentials: false');
    expect(job).toContain('ref: ${{ github.workflow_sha }}');
    expect(job).toContain('pnpm install --frozen-lockfile --ignore-scripts');
    expect(job).toContain('pnpm exec tsx scripts/owner-web-release-qualification.ts --read-only');
    expect(job).toContain('path: ${{ runner.temp }}/owner-web-release-qualification.json');
    expect(job).toContain('overwrite: false');
    expect(job).not.toMatch(
      /google-github-actions|gcloud|docker|release\.sh|cleanup|delivery-guard|--apply/,
    );
    expect([...job.matchAll(/uses: actions\/upload-artifact/g)]).toHaveLength(1);
    expect(job.indexOf('git rev-parse HEAD')).toBeLessThan(job.indexOf('pnpm install'));
  });
});
