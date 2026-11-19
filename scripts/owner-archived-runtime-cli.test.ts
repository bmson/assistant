import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('./owner-editor-release-inventory.ts', import.meta.url));
const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('standalone archived-runtime inventory CLI', () => {
  it.each([
    ['missing reviewed pack', ['--observe-archived-runtime'], true, 'archived_runtime_evidence'],
    ['unapproved source', ['--observe-archived-runtime'], false, 'protected_context'],
    ['unreviewed path argument', ['--observe-archived-runtime', '/other'], true, 'arguments'],
  ] as const)('rejects %s before credentials or provider access', (_name, args, valid, stage) => {
    const dir = mkdtempSync(join(tmpdir(), 'archived-runtime-cli-'));
    const source = 'a'.repeat(40);
    const principal = 'test@example.iam.gserviceaccount.com';
    const provider = 'projects/123/locations/global/workloadIdentityPools/pool/providers/provider';
    try {
      writeFileSync(join(dir, 'gcloud'), '#!/bin/sh\ntouch gcloud-called\nexit 1\n', {
        mode: 0o700,
      });
      const result = spawnSync(process.execPath, [tsx, cli, ...args], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: `${dir}:${process.env.PATH}`,
          RUNNER_TEMP: dir,
          GITHUB_ACTIONS: 'true',
          GITHUB_SHA: source,
          GITHUB_WORKFLOW_SHA: source,
          GITHUB_WORKSPACE: dir,
          GITHUB_REPOSITORY: 'bmson/assistant',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_RUN_ID: '123',
          GITHUB_RUN_ATTEMPT: '1',
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          GITHUB_WORKFLOW_REF:
            'bmson/assistant/.github/workflows/owner-editor-release-inventory.yml@refs/heads/main',
          GCP_PROJECT: 'bmson-assistant',
          GCP_DEPLOY_SERVICE_ACCOUNT: principal,
          GCP_WORKLOAD_IDENTITY_PROVIDER: provider,
          OWNER_EDITOR_CHECKOUT_SHA: source,
          OWNER_EDITOR_APPROVED_SOURCE_SHA: valid ? source : 'b'.repeat(40),
          OWNER_EDITOR_APPROVED_PROJECT_SHA256: sha256('bmson-assistant'),
          OWNER_EDITOR_APPROVED_SERVICE_ACCOUNT_SHA256: sha256(principal),
          OWNER_EDITOR_APPROVED_WIF_PROVIDER_SHA256: sha256(provider),
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({ outcome: 'inventory_failed', stage });
      expect(result.stderr).not.toContain(dir);
      expect(existsSync(join(dir, 'gcloud-called'))).toBe(false);
      expect(existsSync(join(dir, 'owner-archived-runtime-observation.json'))).toBe(false);
      expect(existsSync(join(dir, 'owner-editor-release-inventory.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
