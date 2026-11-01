import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptStoredCredential, encryptStoredCredential } from '@assistant/core/mcp-secrets';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigForTest } from '../packages/config/src/index.js';
import {
  buildBillingSetupReport,
  formatBillingSetupReport,
  parseBillingSetupArguments,
  writeSealedBillingCredential,
} from './billing-setup.js';

function makeConfig(overrides: Record<string, string> = {}) {
  resetConfigForTest();
  return loadConfig(overrides);
}

describe('offline billing setup helper', () => {
  beforeEach(() => resetConfigForTest());
  afterEach(() => {
    resetConfigForTest();
    vi.restoreAllMocks();
  });

  it('reports exact GCP configuration and IAM needs without claiming remote verification', () => {
    const report = buildBillingSetupReport(
      makeConfig({
        GCP_PROJECT: 'assistant-project',
        GCP_BILLING_EXPORT_TABLE: 'billing-project.billing_dataset.gcp_billing_export_v1_123',
        GCP_BILLING_QUERY_PROJECT: '',
        GCP_BILLING_LOCATION: 'US',
        GCP_BILLING_SCOPE: 'project',
        GCP_BILLING_MAX_BYTES: '420000000',
      }),
    );

    expect(report.googleCloud).toMatchObject({
      exportTable: 'billing-project.billing_dataset.gcp_billing_export_v1_123',
      queryProject: 'billing-project',
      queryProjectSource: 'export-table',
      location: 'US',
      scope: 'project',
      projectFilter: 'assistant-project',
      maxBytesBilled: 420_000_000,
      configReady: true,
      proposedPrincipal: 'assistant-web@assistant-project.iam.gserviceaccount.com',
      remotePermissionsChecked: false,
      requiredRoles: [
        { role: 'roles/bigquery.jobUser', resource: 'query project billing-project' },
        {
          role: 'roles/bigquery.dataViewer',
          resource: 'export dataset billing-project.billing_dataset',
        },
      ],
    });
  });

  it('marks missing export/project and unknown runtime identity rather than implying access', () => {
    const report = buildBillingSetupReport(
      makeConfig({
        GCP_PROJECT: '',
        GCP_BILLING_EXPORT_TABLE: '',
        GCP_BILLING_QUERY_PROJECT: '',
        GCP_BILLING_SCOPE: 'project',
      }),
    );
    expect(report.googleCloud).toMatchObject({
      exportTable: null,
      queryProject: null,
      queryProjectSource: 'missing',
      projectFilter: null,
      configReady: false,
      proposedPrincipal: null,
      remotePermissionsChecked: false,
    });
    expect(report.googleCloud.runtimeServiceAccountNote).toContain('Unknown');
  });

  it('shows OpenAI credential presence and explicit filters without printing ciphertext', () => {
    const encryptedMarker = `v2.${'a'.repeat(16)}.${'b'.repeat(22)}.${'c'.repeat(48)}`;
    const config = makeConfig({
      OPENAI_BILLING_ADMIN_KEY_ENCRYPTED: encryptedMarker,
      OPENAI_BILLING_PROJECT_IDS: 'proj_1, proj_2',
      OPENAI_BILLING_API_KEY_IDS: 'key_1',
      OPENAI_BILLING_ACCOUNT_LABEL: 'Personal account',
    });
    const report = buildBillingSetupReport(config);
    const output = formatBillingSetupReport(report);
    expect(report.openAI).toEqual({
      encryptedAdminCredential: 'configured',
      projectFilters: ['proj_1', 'proj_2'],
      projectFiltersStatus: 'configured',
      apiKeyFilters: ['key_1'],
      apiKeyFiltersStatus: 'configured',
      accountLabel: 'configured',
      queryReady: true,
    });
    expect(output).toContain('Project filters: proj_1, proj_2');
    expect(output).toContain('API key filters: key_1');
    expect(output).not.toContain(encryptedMarker);
  });

  it('hides malformed or credential-shaped OpenAI filters and does not claim query readiness', () => {
    const pastedKey = `sk-admin-${'q'.repeat(64)}`;
    const report = buildBillingSetupReport(
      makeConfig({
        OPENAI_BILLING_ADMIN_KEY_ENCRYPTED: 'not-a-v2-ciphertext',
        OPENAI_BILLING_PROJECT_IDS: pastedKey,
        OPENAI_BILLING_API_KEY_IDS: 'key_valid,invalid-id',
      }),
    );
    const output = formatBillingSetupReport(report);
    expect(report.openAI).toMatchObject({
      encryptedAdminCredential: 'invalid',
      projectFilters: [],
      projectFiltersStatus: 'invalid',
      apiKeyFilters: [],
      apiKeyFiltersStatus: 'invalid',
      queryReady: false,
    });
    expect(output).toContain('Project filters: invalid (values hidden)');
    expect(output).toContain('API key filters: invalid (values hidden)');
    expect(output).not.toContain(pastedKey);
    expect(output).not.toContain('invalid-id');
    expect(output).toContain('Encrypted admin credential: invalid');
  });

  it('rejects more filters than the connector can honor without exposing their values', () => {
    const report = buildBillingSetupReport(
      makeConfig({
        OPENAI_BILLING_ADMIN_KEY_ENCRYPTED: `v2.${'a'.repeat(16)}.${'b'.repeat(22)}.${'c'.repeat(48)}`,
        OPENAI_BILLING_PROJECT_IDS: Array.from({ length: 26 }, (_, index) => `proj_${index}`).join(
          ',',
        ),
      }),
    );
    expect(report.openAI.projectFiltersStatus).toBe('invalid');
    expect(report.openAI.queryReady).toBe(false);
    expect(formatBillingSetupReport(report)).not.toContain('proj_25');
  });

  it('does not call anything on import and parses only the explicit check or seal modes', () => {
    expect(parseBillingSetupArguments([])).toEqual({ mode: 'check' });
    expect(parseBillingSetupArguments(['--check'])).toEqual({ mode: 'check' });
    expect(parseBillingSetupArguments(['--help'])).toEqual({ mode: 'help' });
    expect(
      parseBillingSetupArguments([
        '--seal-openai',
        '--output',
        '.env.openai-billing.local',
        '--confirm-admin-credential',
      ]),
    ).toEqual({ mode: 'seal', outputPath: '.env.openai-billing.local' });
    expect(() => parseBillingSetupArguments(['--seal-openai'])).toThrow('requires');
    expect(() => parseBillingSetupArguments(['--check', '--seal-openai'])).toThrow('Unsupported');
    expect(() =>
      parseBillingSetupArguments(['--seal-openai', '--output', '--confirm-admin-credential']),
    ).toThrow();
  });

  it('seals a piped admin key with the existing AES-GCM format into a new ignored 0600 file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'assistant-billing-setup-'));
    await mkdir(path.join(directory, '.billing'));
    const credential = `sk-admin-${'x'.repeat(64)}`;
    process.env.MCP_ENC_KEY = '42'.repeat(32);
    resetConfigForTest();
    try {
      const outputPath = writeSealedBillingCredential({
        repoRoot: directory,
        outputPath: '.billing/openai-admin.env',
        credential,
        encrypt: encryptStoredCredential,
        isIgnored: (relative) => relative === '.billing/openai-admin.env',
      });
      const contents = await readFile(outputPath, 'utf8');
      const mode = (await stat(outputPath)).mode & 0o777;
      const encrypted = contents.match(
        /^OPENAI_BILLING_ADMIN_KEY_ENCRYPTED=(v2\.[^\r\n]+)\n$/,
      )?.[1];
      expect(mode).toBe(0o600);
      expect(encrypted).toBeDefined();
      expect(contents).not.toContain(credential);
      expect(decryptStoredCredential(encrypted ?? '')).toBe(credential);
    } finally {
      delete process.env.MCP_ENC_KEY;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('blocks invalid credentials, tracked output, path escape, symlink parents, and overwrites', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'assistant-billing-setup-'));
    const credential = `sk-admin-${'y'.repeat(64)}`;
    const encrypt = (value: string) => `v2.test.${Buffer.from(value).toString('base64url')}`;
    const ignored = (relative: string) => relative.endsWith('.local');
    try {
      expect(() =>
        writeSealedBillingCredential({
          repoRoot: directory,
          outputPath: 'tracked.env',
          credential,
          encrypt,
          isIgnored: () => false,
        }),
      ).toThrow('git-ignored');
      expect(() =>
        writeSealedBillingCredential({
          repoRoot: directory,
          outputPath: '../outside.local',
          credential,
          encrypt,
          isIgnored: ignored,
        }),
      ).toThrow('inside the workspace');
      await symlink(tmpdir(), path.join(directory, 'linked'));
      expect(() =>
        writeSealedBillingCredential({
          repoRoot: directory,
          outputPath: 'linked/new.local',
          credential,
          encrypt,
          isIgnored: ignored,
        }),
      ).toThrow('symlinks');
      expect(() =>
        writeSealedBillingCredential({
          repoRoot: directory,
          outputPath: 'first.local',
          credential: 'sk-project-not-an-admin-key',
          encrypt,
          isIgnored: ignored,
        }),
      ).toThrow('valid sk-admin-');

      await writeFile(path.join(directory, 'existing.local'), 'keep me', { mode: 0o600 });
      expect(() =>
        writeSealedBillingCredential({
          repoRoot: directory,
          outputPath: 'existing.local',
          credential,
          encrypt,
          isIgnored: ignored,
        }),
      ).toThrow('already exists');
      expect(await readFile(path.join(directory, 'existing.local'), 'utf8')).toBe('keep me');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('runs the actual CLI with pipe input and refuses an actual terminal without reading it', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'assistant-billing-cli-'));
    const credential = `sk-admin-${'p'.repeat(64)}`;
    const script = fileURLToPath(new URL('./billing-setup.ts', import.meta.url));
    const loader = import.meta.resolve('tsx');
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: directory,
      ASSISTANT_REPO_ROOT: directory,
      MCP_ENC_KEY: '42'.repeat(32),
      NODE_ENV: 'test',
    };
    try {
      execFileSync('git', ['init', '-q', directory], { stdio: 'ignore' });
      await writeFile(path.join(directory, '.gitignore'), '.env.*.local\n');
      const args = [
        '--import',
        loader,
        script,
        '--seal-openai',
        '--output',
        '.env.billing.local',
        '--confirm-admin-credential',
      ];
      const piped = spawnSync(process.execPath, args, {
        cwd: directory,
        env,
        input: `${credential}\n`,
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect(piped.status, piped.stderr).toBe(0);
      expect(piped.stdout).toContain('Wrote encrypted credential');
      expect(piped.stdout + piped.stderr).not.toContain(credential);
      const stored = await readFile(path.join(directory, '.env.billing.local'), 'utf8');
      expect(stored).toMatch(/^OPENAI_BILLING_ADMIN_KEY_ENCRYPTED=v2\./);
      expect(stored).not.toContain(credential);
      expect((await stat(path.join(directory, '.env.billing.local'))).mode & 0o777).toBe(0o600);

      // The helper must refuse real TTY input, before any credential is sent.
      // Python's standard POSIX pty module supplies the child's terminal fd;
      // stdout/stderr remain pipes, so no interactive input is echoed.
      if (process.platform !== 'win32') {
        const terminalArgs = [...args];
        terminalArgs[terminalArgs.indexOf('.env.billing.local')] = '.env.terminal.local';
        const python =
          'import json,os,pty,subprocess,sys\nm,s=pty.openpty()\np=subprocess.run(json.loads(sys.argv[1]),stdin=s,capture_output=True,text=True,timeout=10)\nos.close(s)\nos.close(m)\nprint(json.dumps({"status":p.returncode,"stdout":p.stdout,"stderr":p.stderr}))';
        const tty = spawnSync(
          'python3',
          ['-c', python, JSON.stringify([process.execPath, ...terminalArgs])],
          {
            cwd: directory,
            env,
            encoding: 'utf8',
            timeout: 15_000,
          },
        );
        expect(tty.status, tty.stderr).toBe(0);
        const result = JSON.parse(tty.stdout);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('interactive terminal input is disabled');
        expect(result.stdout + result.stderr).not.toContain(credential);
        await expect(stat(path.join(directory, '.env.terminal.local'))).rejects.toThrow();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps credential text out of validation errors', () => {
    const marker = `secret-${'z'.repeat(48)}`;
    let message = '';
    try {
      writeSealedBillingCredential({
        repoRoot: tmpdir(),
        outputPath: '.env.local',
        credential: marker,
        encrypt: (value) => value,
        isIgnored: () => true,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('valid sk-admin-');
    expect(message).not.toContain(marker);
  });
});
