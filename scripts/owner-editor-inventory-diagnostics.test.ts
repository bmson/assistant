import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  InventoryHttpError,
  inventoryFailureDiagnostic,
} from './owner-editor-inventory-diagnostics.js';
import { decryptInventoryFailure } from './owner-editor-inventory-failure-envelope.js';
import { createReadOnlyGet, DATABASE } from './owner-editor-release-inventory.js';

const secret = 'DO_NOT_LEAK_private-owner-token-generation';

describe('bounded content-free inventory failure diagnostics', () => {
  it('never serializes provider messages, stdout, stderr, names, bodies or private stage input', () => {
    const error = Object.assign(new Error(secret), {
      stdout: secret,
      stderr: secret,
      body: secret,
      url: `https://private.example/${secret}`,
      name: secret,
    });
    const result = inventoryFailureDiagnostic(secret, error);
    expect(result).toEqual({
      format: 1,
      outcome: 'inventory_failed',
      stage: 'unknown',
      errorClass: 'Error',
      httpStatus: null,
      readiness: 'unknown',
      authorityEstablished: false,
      mutationAuthorized: false,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(
      inventoryFailureDiagnostic('database_metadata', {
        name: secret,
        status: 403,
        message: secret,
      }).httpStatus,
    ).toBeNull();
  });
  it('uses only validated internal HTTP status, rejecting numeric strings and out-of-range data', async () => {
    const fake = (async () => new Response(secret, { status: 403 })) as typeof fetch;
    let failure: unknown;
    try {
      await createReadOnlyGet(
        'a'.repeat(30),
        Date.now() + 1000,
        fake,
      )(`https://firestore.googleapis.com/v1/${DATABASE}`);
    } catch (error) {
      failure = error;
    }
    expect(inventoryFailureDiagnostic('database_metadata', failure)).toMatchObject({
      stage: 'database_metadata',
      errorClass: 'HttpError',
      httpStatus: 403,
      authorityEstablished: false,
    });
    expect(JSON.stringify(inventoryFailureDiagnostic('database_metadata', failure))).not.toContain(
      secret,
    );
    for (const status of [99, 600, NaN, 403.5])
      expect(() => new InventoryHttpError(status)).toThrow();
    expect(
      inventoryFailureDiagnostic('cli_composites', { status: '403', message: secret }).httpStatus,
    ).toBeNull();
  });
  it('does not invoke exception content getters', () => {
    const error = new Error();
    Object.defineProperty(error, 'message', {
      get() {
        throw new Error(secret);
      },
    });
    Object.defineProperty(error, 'name', {
      get() {
        throw new Error(secret);
      },
    });
    expect(inventoryFailureDiagnostic('credential_file', error).errorClass).toBe('Error');
  });
  it.each(['changing', 'throwing'] as const)(
    'rejects a %s HTTP status getter without invoking it',
    (mode) => {
      const error = new InventoryHttpError(403);
      let reads = 0;
      Object.defineProperty(error, 'status', {
        get() {
          reads += 1;
          if (mode === 'throwing') throw new Error(secret);
          return reads <= 4 ? 403 : secret;
        },
      });
      const result = inventoryFailureDiagnostic('database_metadata', error);
      expect(result).toEqual({
        format: 1,
        outcome: 'inventory_failed',
        stage: 'database_metadata',
        errorClass: 'HttpError',
        httpStatus: null,
        readiness: 'unknown',
        authorityEstablished: false,
        mutationAuthorized: false,
      });
      expect(reads).toBe(0);
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );
  it.each(['credential_file', 'cli_version', 'cli_composites', 'access_token'] as const)(
    'real CLI fails closed at %s without a receipt or leaking failed payload',
    (stage) => {
      const dir = mkdtempSync(join(tmpdir(), 'inventory-diagnostic-'));
      try {
        const manifestPath = join(dir, '.approved-index-source/infra/gcp/firestore');
        mkdirSync(manifestPath, { recursive: true });
        writeFileSync(
          join(manifestPath, 'firestore.indexes.json'),
          readFileSync(new URL('./fixtures/owner-editor-release-indexes.json', import.meta.url)),
        );
        const bin = join(dir, 'bin');
        mkdirSync(bin);
        writeFileSync(
          join(bin, 'gcloud'),
          `#!/bin/sh\nprintf '%s\\n' "$1" >> '${dir}/commands'\nif [ '${stage}' = 'cli_version' ]; then printf '%s' '${secret}'; exit 0; fi\nif [ "$1" = version ]; then printf '%s' '{"Google Cloud SDK":"576.0.0"}'; exit 0; fi\nif [ '${stage}' = 'access_token' ] && [ "$1" = firestore ]; then\n  printf '%s\\n' "$*" >> '${dir}/index-args'\n  case "$*" in *--page-size=100*) printf '%s' 'INVALID_ARGUMENT: Invalid page size; only 0 supported' >&2; exit 1;; esac\n  printf '%s' '[{"name":"first-page"},{"name":"later-page"}]'; exit 0\nfi\nprintf '%s' '${secret}' >&2\nexit 1\n`,
          { mode: 0o700 },
        );
        const credential = join(dir, 'gha-creds-test.json'),
          provider = 'projects/123/locations/global/workloadIdentityPools/pool/providers/provider',
          principal = 'deployer@bmson-assistant.iam.gserviceaccount.com';
        writeFileSync(
          credential,
          JSON.stringify({
            type: 'external_account',
            audience: stage === 'credential_file' ? secret : `//iam.googleapis.com/${provider}`,
            token_url: 'https://sts.googleapis.com/v1/token',
            service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${principal}:generateAccessToken`,
          }),
        );
        const diagnosticKeys =
          stage === 'cli_composites' ? generateKeyPairSync('rsa', { modulusLength: 3072 }) : null;
        if (stage === 'access_token') {
          // Fake API reproduces rejection of the former nonzero page size.
          const old = spawnSync(
            join(bin, 'gcloud'),
            ['firestore', 'indexes', 'composite', 'list', '--page-size=100'],
            { encoding: 'utf8' },
          );
          expect(old.status).toBe(1);
          expect(old.stderr).toContain('INVALID_ARGUMENT: Invalid page size');
          rmSync(join(dir, 'commands'));
          rmSync(join(dir, 'index-args'));
        }
        const result = spawnSync(
          process.execPath,
          [
            fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
            fileURLToPath(new URL('./owner-editor-release-inventory.ts', import.meta.url)),
            '--collect',
          ],
          {
            cwd: dir,
            encoding: 'utf8',
            timeout: 5000,
            maxBuffer: 65536,
            env: {
              PATH: `${bin}:${process.env.PATH}`,
              GITHUB_ACTIONS: 'true',
              GITHUB_REPOSITORY: 'bmson/assistant',
              GITHUB_REF: 'refs/heads/main',
              GITHUB_RUN_ATTEMPT: '1',
              GITHUB_SHA: 'a'.repeat(40),
              GITHUB_RUN_ID: '123',
              GCP_PROJECT: 'bmson-assistant',
              GCP_DEPLOY_SERVICE_ACCOUNT: principal,
              GCP_WORKLOAD_IDENTITY_PROVIDER: provider,
              GITHUB_WORKSPACE: dir,
              RUNNER_TEMP: dir,
              CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: credential,
              GOOGLE_APPLICATION_CREDENTIALS: credential,
              ...(diagnosticKeys
                ? {
                    OWNER_EDITOR_DIAGNOSTIC_RECIPIENT_PUBLIC_KEY: diagnosticKeys.publicKey
                      .export({ type: 'spki', format: 'pem' })
                      .toString(),
                    OWNER_EDITOR_DIAGNOSTIC_SOURCE_SHA: 'a'.repeat(40),
                  }
                : {}),
            },
          },
        );
        expect(result.status, result.stderr).toBe(1);
        const diagnostic = JSON.parse(result.stderr.trim());
        expect(diagnostic).toMatchObject({
          stage,
          readiness: 'unknown',
          authorityEstablished: false,
          mutationAuthorized: false,
          httpStatus: null,
        });
        expect(result.stdout + result.stderr).not.toContain(secret);
        if (stage === 'cli_composites')
          expect(diagnostic).toMatchObject({
            errorClass: 'ProcessError',
            processFailure: 'nonzero_exit',
            exitCode: 1,
            signalClass: null,
            causeHint: 'unknown',
            diagnosticHintsOnly: true,
          });
        expect(existsSync(join(dir, 'owner-editor-release-inventory.json'))).toBe(false);
        if (diagnosticKeys) {
          const encrypted = readFileSync(
            join(dir, 'owner-editor-inventory-failure.encrypted.json'),
            'utf8',
          );
          expect(encrypted).not.toContain(secret);
          const payload = decryptInventoryFailure(
            JSON.parse(encrypted),
            diagnosticKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
          );
          expect(payload).toMatchObject({
            sourceSha: 'a'.repeat(40),
            runId: '123',
            stage: 'cli_composites',
            stderr: secret,
          });
        } else
          expect(existsSync(join(dir, 'owner-editor-inventory-failure.encrypted.json'))).toBe(
            false,
          );
        if (stage === 'credential_file') expect(existsSync(join(dir, 'commands'))).toBe(false);
        else
          expect(readFileSync(join(dir, 'commands'), 'utf8').trim().split('\n')).toEqual(
            stage === 'cli_version'
              ? ['version']
              : stage === 'access_token'
                ? ['version', 'firestore', 'firestore', 'auth']
                : ['version', 'firestore'],
          );
        if (stage === 'access_token') {
          expect(readFileSync(join(dir, 'index-args'), 'utf8').trim().split('\n')).toEqual(
            ['composite', 'fields'].map(
              (kind) =>
                `firestore indexes ${kind} list --project=bmson-assistant --database=assistant-production --format=json --quiet`,
            ),
          );
          expect(diagnostic).toMatchObject({
            errorClass: 'ProcessError',
            processFailure: 'nonzero_exit',
            exitCode: 1,
          });
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
