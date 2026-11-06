// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Literal GitHub workflow syntax under test.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    /^ {6}native_web_qualification:/.test(line) ? [index] : [],
  );
  if (starts.length !== 1) return undefined;
  const start = starts[0] as number;
  if (!/^ {6}native_web_qualification:[ \t]*(?:#.*)?$/.test(lines[start] as string))
    return undefined;

  const defaults: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {6}[A-Za-z_][A-Za-z0-9_-]*:/.test(line)) break;
    if (/^ {0,5}\S/.test(line)) break;
    const match = /^ {8}default:[ \t]*(.*?)[ \t]*$/.exec(line);
    if (match) defaults.push(match[1] as string);
  }
  if (defaults.length !== 1) return undefined;
  const value = defaults[0] as string;
  return /^(?:off|'off'|"off")(?:[ \t]+#.*)?$/.test(value) ? 'off' : undefined;
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
      '      native_web_qualification: # selector block',
      `        default: ${value} # YAML comment`,
      '      sha:',
      '        default: "on"',
    ].join('\n');
    expect(nativeWebQualificationDefault(source)).toBe('off');
  });
  it.each([
    '      native_web_qualification:\n        default: on\n      sha:\n        default: off',
    '      native_web_qualification:\n        description: no default\n      sha: # sibling option\n        default: off',
    '      native_web_qualification:\n        default: off\n        default: "off"\n      sha:',
    '      native_web_qualification:\n        description: one\n      native_web_qualification: # duplicate\n        default: off',
    '      native_web_qualification: off\n        default: off',
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

describe('same-workflow recovery build isolation', () => {
  it('defaults build-only off and preserves the complete normal image job', () => {
    expect(workflow).toMatch(
      / {6}build_only:\n(?: {8}[^\n]*\n)* {8}default: false\n {8}type: boolean/,
    );
    const image = jobs.get('image') ?? '';
    for (const evidence of [
      'Build the image',
      'Scan the image',
      'Generate the SBOM and push the image',
      'Smoke-test agent image',
      'Verify web assets',
      'Sign the image and attach its SBOM attestation',
    ])
      expect(image).toContain(evidence);
    expect(image).toContain('registryManifestDigest:$digest');
    expect(image).toContain('sbomSha256:$sbomSha256');
    expect(image).toContain('ref="${IMAGE_ROOT}/${IMAGE_NAME}@${digest}"');
    expect(image).toContain(
      'cosign sign --yes --bundle "sbom/${IMAGE_NAME}-signature.sigstore.json" "$ref"',
    );
    expect(image.indexOf('Sign the image')).toBeLessThan(image.indexOf('Upload the release SBOM'));
    expect(image).toContain('--bundle "sbom/${IMAGE_NAME}-sbom.sigstore.json"');
    expect(image).toContain('cosign attest --yes --type spdxjson');
  });
  it.each(['success', 'failure', 'cancelled', 'skipped'])(
    'build-only skips release and every nested always/cleanup path after %s',
    (status) => {
      const values = context({
        'inputs.native_web_qualification': 'off',
        'inputs.build_only': true,
      });
      expect(evaluate(condition('plan'), values)).toBe(true);
      expect(evaluate(condition('image'), values)).toBe(true);
      expect(evaluate(condition('release'), values, status === 'success')).toBe(false);
      expect(evaluate(condition('native_web_qualification'), values, status === 'success')).toBe(
        false,
      );
      // Closed job inventory above prevents an ungated new mutation/cleanup job.
      for (const [name, body] of jobs) {
        if (
          /firestore-delivery-guard|cleanup-current|infra\/gcp\/release\.sh/.test(
            body.replace(/^\s*#.*$/gm, ''),
          )
        )
          expect(name).toBe('release');
      }
    },
  );
  it('cannot combine build-only with the separate read-only qualifier', () => {
    const values = context({ 'inputs.build_only': true });
    for (const job of jobs.keys()) expect(evaluate(condition(job), values)).toBe(false);
  });
  it('runs the pure scope check from trusted source before normal main-CI verification', () => {
    const plan = jobs.get('plan') ?? '';
    const trusted = plan.indexOf('Checkout trusted workflow source');
    const scope = plan.indexOf('Validate build-only scope');
    const ci = plan.indexOf('Verify exact source passed main CI');
    const target = plan.indexOf('Checkout exact release source');
    expect(trusted).toBeLessThan(scope);
    expect(scope).toBeLessThan(ci);
    expect(ci).toBeLessThan(target);
    expect(plan).toContain('if: inputs.build_only == true');
    expect(plan).toContain('run: bash infra/gcp/verify-build-only-context.sh');
    expect(plan).toContain('BOOTSTRAP_SNAPSHOT: ${{ inputs.bootstrap_snapshot }}');
    expect(plan).not.toMatch(/google-github-actions|gcloud/);
  });
  const valid = {
    BUILD_ONLY: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_RUN_ID: '123',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_REPOSITORY: 'bmson/assistant',
    GITHUB_WORKFLOW_REF: 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
    RELEASE_SHA: source,
    GITHUB_SHA: source,
    GITHUB_WORKFLOW_SHA: source,
    REQUESTED_COMPONENTS: 'full',
    REQUESTED_PERSISTENCE: 'firestore',
    NATIVE_WEB_QUALIFICATION: 'off',
    BREAK_GLASS: 'false',
  };
  function validate(overrides: NodeJS.ProcessEnv = {}) {
    return spawnSync('/bin/bash', ['infra/gcp/verify-build-only-context.sh'], {
      cwd: new URL('..', import.meta.url),
      env: { ...valid, ...overrides },
      encoding: 'utf8',
      timeout: 3000,
    });
  }
  it('accepts the first exact-main paired Firestore build without provider access', () => {
    expect(validate().status).toBe(0);
  });
  it.each([
    { BUILD_ONLY: 'false' },
    { GITHUB_ACTIONS: 'false' },
    { GITHUB_RUN_ID: '' },
    { GITHUB_EVENT_NAME: 'workflow_run' },
    { GITHUB_REF: 'refs/heads/other' },
    { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_REPOSITORY: 'other/assistant' },
    { GITHUB_WORKFLOW_REF: 'bmson/assistant/.github/workflows/other.yml@refs/heads/main' },
    { RELEASE_SHA: 'abc' },
    { GITHUB_SHA: 'b'.repeat(40) },
    { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) },
    { REQUESTED_COMPONENTS: 'web' },
    { REQUESTED_PERSISTENCE: 'auto' },
    { REQUESTED_PERSISTENCE: 'postgres' },
    { NATIVE_WEB_QUALIFICATION: 'read_only' },
    { BREAK_GLASS: 'true' },
    { BOOTSTRAP_SNAPSHOT: '{}' },
    { BOOTSTRAP_SNAPSHOT_SHA256: 'c'.repeat(64) },
  ])('rejects unsafe build-only context before authentication: %j', (override) => {
    const result = validate(override);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Build-only requires');
  });
});

describe('immutable recovery image evidence from actual image-job commands', () => {
  function stepCommands(name: string) {
    const body = jobs.get('image') ?? '';
    const step =
      body.slice(body.indexOf(`      - name: ${name}\n`)).split(/\n {6}(?:- |#)/)[0] ?? '';
    const commands = step.split('        run: |\n')[1];
    if (!commands) throw new Error('Missing image-job commands');
    return commands.replace(/^ {10}/gm, '');
  }
  const digest = `sha256:${'1'.repeat(64)}`;
  const other = `sha256:${'2'.repeat(64)}`;
  const mockCommands = `
syft() { printf '{"spdxVersion":"SPDX-2.3"}' > "sbom/$IMAGE_NAME.spdx.json"; }
docker() {
  if [[ "$1" == push ]]; then printf 'latest: digest: %s size: 123\\n' "$PUSH_DIGEST";
  elif [[ "$1 $2" == 'image inspect' ]]; then printf 'sha256:local-image\\n';
  else return 2; fi
}
gcloud() { printf '%s\\n' "$REGISTRY_DIGEST"; }
timeout() { shift; shift; shift; "$@"; }
cosign() { printf '%s\\n' "$*" >> "$RUNNER_TEMP/signing.log"; }
`;
  function execute(registryDigest: string, image = 'web') {
    const directory = mkdtempSync(join(tmpdir(), 'assistant-recovery-image-test-'));
    writeFileSync(
      join(directory, 'agent-image-smoke.json'),
      JSON.stringify({ localImageId: 'sha256:local-image' }),
    );
    const result = spawnSync(
      '/bin/bash',
      [
        '-euo',
        'pipefail',
        '-c',
        mockCommands +
          '\n' +
          stepCommands('Generate the SBOM and push the image') +
          '\n' +
          stepCommands('Sign the image and attach its SBOM attestation'),
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 5000,
        env: {
          PATH: process.env.PATH ?? '',
          RUNNER_TEMP: directory,
          GCP_REGION: 'us-west1',
          GCP_PROJECT: 'bmson-assistant',
          ARTIFACT_REPOSITORY: 'assistant',
          IMAGE_NAME: image,
          RELEASE_SHA: source,
          GITHUB_WORKFLOW_REF: 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
          GITHUB_WORKFLOW_SHA: source,
          GITHUB_RUN_ID: '123',
          GITHUB_RUN_ATTEMPT: '1',
          PUSH_DIGEST: digest,
          REGISTRY_DIGEST: registryDigest,
        },
      },
    );
    return { directory, result };
  }
  it.each(['web', 'agent'])(
    'retains %s pushed digest and SBOM binding, then signs and attests only that immutable subject',
    (image) => {
      const { directory, result } = execute(digest, image);
      try {
        expect(result.status, result.stderr).toBe(0);
        const receipt = JSON.parse(
          readFileSync(join(directory, `sbom/${image}-build-receipt.json`), 'utf8'),
        );
        expect(receipt.registryManifestDigest).toBe(digest);
        expect(receipt.source).toBe(source);
        expect(receipt.sbomSha256).toMatch(/^[a-f0-9]{64}$/);
        const signed = readFileSync(join(directory, 'signing.log'), 'utf8');
        expect(signed).toContain(
          `sign --yes --bundle sbom/${image}-signature.sigstore.json us-west1-docker.pkg.dev/bmson-assistant/assistant/${image}@${digest}`,
        );
        expect(signed).toContain(
          `--predicate sbom/${image}.spdx.json --bundle sbom/${image}-sbom.sigstore.json us-west1-docker.pkg.dev/bmson-assistant/assistant/${image}@${digest}`,
        );
        expect(signed).not.toContain(`${image}:${source}`);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it('refuses registry/tag drift before emitting an accepted receipt or signing another subject', () => {
    const { directory, result } = execute(other);
    try {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Artifact Registry digest differs');
      expect(() => readFileSync(join(directory, 'signing.log'))).toThrow();
      expect(() => readFileSync(join(directory, 'sbom/web-build-receipt.json'))).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
