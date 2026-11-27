import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const source = 'e'.repeat(40);

function step(name: string): string {
  const block = workflow.split(`      - name: ${name}\n`)[1]?.split('      - name:')[0];
  const body = block
    ?.split('        run: |\n')[1]
    ?.split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
  if (!body) throw new Error('Missing workflow step');
  return body;
}

const ordinaryPlanEnv = {
  PATH: process.env.PATH,
  GITHUB_JOB: 'plan',
  GITHUB_REPOSITORY: 'bmson/assistant',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'bmson/assistant/.github/workflows/deploy.yml@refs/heads/main',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: source,
  GITHUB_WORKFLOW_SHA: source,
  RELEASE_SHA: source,
  RELEASE_PREBUILT_RUN_ID: '123456',
  API3_RECOVERY_PROOF: '',
  REQUESTED_PERSISTENCE: 'firestore',
  REQUESTED_COMPONENTS: 'full',
  NATIVE_WEB_QUALIFICATION: 'off',
  BUILD_ONLY: 'false',
  BREAK_GLASS: 'false',
  BREAK_GLASS_REASON: '',
  ARCHIVE_MAINTENANCE_RUN_ID: '',
  ARCHIVE_RESTORE_PROOF: '',
  OWNER_RELEASE_RECLOSED_PREDECESSOR_RUN_ID: '',
  OWNER_RELEASE_BOOTSTRAP_RECEIPT: JSON.stringify({ kind: 'current-snapshot', source }),
  OWNER_RELEASE_BOOTSTRAP_SHA256: 'a'.repeat(64),
  ESTIMATED_COST_RELEASE_PROFILE_JSON: JSON.stringify({ mode: 'compatible-off', source }),
  ESTIMATED_COST_DRAIN_PACKET_JSON: '',
  GOOGLE_CALENDAR_OAUTH_CALLBACK_URL: '',
};

describe('ordinary API 3 recovery workflow', () => {
  const plan = step('Validate ordinary API 3 recovery before authentication');
  const command = ['-euo', 'pipefail', '-c', plan];

  it('admits exact-source first-attempt compatible OFF with signed prebuilt images', () => {
    const result = spawnSync('bash', command, { env: ordinaryPlanEnv, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ['GITHUB_JOB', 'image'],
    ['GITHUB_RUN_ATTEMPT', '2'],
    ['GITHUB_REF', 'refs/heads/topic'],
    ['GITHUB_WORKFLOW_SHA', 'f'.repeat(40)],
    ['RELEASE_PREBUILT_RUN_ID', ''],
    ['REQUESTED_PERSISTENCE', 'postgres'],
    ['REQUESTED_COMPONENTS', 'web'],
    ['NATIVE_WEB_QUALIFICATION', 'read_only'],
    ['BUILD_ONLY', 'true'],
    ['BREAK_GLASS', 'true'],
    ['API3_RECOVERY_PROOF', '{}'],
    ['ARCHIVE_MAINTENANCE_RUN_ID', '98765'],
    ['ARCHIVE_RESTORE_PROOF', '{}'],
    ['OWNER_RELEASE_RECLOSED_PREDECESSOR_RUN_ID', '98765'],
    ['OWNER_RELEASE_BOOTSTRAP_RECEIPT', JSON.stringify({ kind: 'disabled-bootstrap', source })],
    ['ESTIMATED_COST_RELEASE_PROFILE_JSON', JSON.stringify({ mode: 'active', source })],
    ['ESTIMATED_COST_DRAIN_PACKET_JSON', '{}'],
  ])('holds incompatible %s', (name, value) => {
    const result = spawnSync('bash', command, {
      env: { ...ordinaryPlanEnv, [name]: value },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
  });

  it('runs both opt-in checks before any hold or delivery guard and suppresses cleanup', () => {
    expect(workflow).toContain('ordinary_api3_recovery:\n');
    expect(
      workflow.indexOf('Authenticate to Google Cloud', workflow.indexOf('\n  release:')),
    ).toBeLessThan(workflow.indexOf('owner-api3-recovery-intake.ts --install'));
    expect(workflow.indexOf('owner-api3-recovery-intake.ts --install')).toBeLessThan(
      workflow.indexOf('owner-worker-recovery.ts --preflight'),
    );
    const worker = workflow.indexOf('owner-worker-recovery.ts --preflight');
    for (const guard of [
      'owner-editor-release-inventory.ts --release-preflight',
      'owner-web-release-operator-hold.ts --wait',
      'firestore-delivery-guard.py run',
    ]) {
      expect(worker).toBeLessThan(workflow.indexOf(guard));
    }
    expect(workflow).toContain(
      "if: vars.CURRENT_ONLY_CLEANUP == 'true' && inputs.archive_maintenance_run_id == '' && inputs.ordinary_api3_recovery != true",
    );
  });
});
