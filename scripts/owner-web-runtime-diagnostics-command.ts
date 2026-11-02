/** Separate protected read command. Never used by the retirement or deployment commands. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  verifyPreAuthEnvironment,
  verifyWifEnvironment,
} from './owner-editor-release-inventory.js';
import {
  collectRuntimeDiagnostics,
  DiagnosticError,
  diagnosticWindow,
  runtimeDiagnosticClient,
} from './owner-web-runtime-diagnostics.js';

const WORKFLOW =
  'bmson/assistant/.github/workflows/owner-web-runtime-diagnostics.yml@refs/heads/main';
export function verifyRuntimeDiagnosticContext(env: NodeJS.ProcessEnv) {
  verifyPreAuthEnvironment(env);
  if (
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_WORKFLOW_REF !== WORKFLOW ||
    env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA ||
    env.RUNTIME_DIAGNOSTIC_REVIEWED_SOURCE !== env.GITHUB_SHA
  )
    throw new Error('Unreviewed diagnostic context');
  if (!['true', 'false'].includes(env.RUNTIME_DIAGNOSTIC_INCLUDE_HISTORICAL ?? ''))
    throw new Error('Invalid historical selection');
  return diagnosticWindow(
    env.RUNTIME_DIAGNOSTIC_START ?? '',
    env.RUNTIME_DIAGNOSTIC_END ?? '',
    Date.now(),
  );
}
async function token() {
  const identity = verifyWifEnvironment(process.env, (file) => {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768)
      throw new Error('Invalid WIF file');
    return JSON.parse(readFileSync(file, 'utf8'));
  });
  if (
    !process.env.RUNNER_TEMP ||
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    process.env.RUNNER_TOOL_CACHE !== '/opt/hostedtoolcache'
  )
    throw new Error('Unsupported protected runner');
  const binary = '/opt/hostedtoolcache/gcloud/576.0.0/x64/bin/gcloud',
    stat = lstatSync(binary);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0)
    throw new Error('Invalid protected binary');
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: process.env.HOME,
    CLOUDSDK_CONFIG: resolve(process.env.RUNNER_TEMP, 'owner-web-runtime-diagnostics-gcloud'),
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: identity.file,
    CLOUDSDK_CORE_PROJECT: 'bmson-assistant',
    CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
    CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: 'true',
  };
  const exec = promisify(execFile);
  async function command(args: string[]) {
    try {
      return (
        await exec(binary, args, { env, timeout: 10000, maxBuffer: 32768, killSignal: 'SIGKILL' })
      ).stdout;
    } catch {
      throw new Error('Protected credential read failed');
    }
  }
  if (JSON.parse(await command(['version', '--format=json']))['Google Cloud SDK'] !== '576.0.0')
    throw new Error('Unaudited SDK');
  return (await command(['auth', 'print-access-token', '--quiet'])).trim();
}
async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['--verify-source', '--read'].includes(mode ?? ''))
    throw new Error('Invalid diagnostic mode');
  const window = verifyRuntimeDiagnosticContext(process.env);
  if (mode === '--verify-source') return;
  const observedAt = new Date().toISOString();
  let observation: unknown;
  try {
    observation = await collectRuntimeDiagnostics(
      runtimeDiagnosticClient(await token()),
      window,
      process.env.RUNTIME_DIAGNOSTIC_INCLUDE_HISTORICAL === 'true',
    );
  } catch (error) {
    observation = {
      status: 'unavailable',
      reason: error instanceof DiagnosticError ? error.reason : 'protected_read_unavailable',
      mutationAuthority: false,
    };
  }
  const packet = {
    format: 1,
    diagnosticSource: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    observedAt,
    observation,
  };
  const sha256 = createHash('sha256').update(JSON.stringify(packet)).digest('hex');
  writeFileSync('owner-web-runtime-diagnostics.json', `${JSON.stringify({ packet, sha256 })}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}
if (process.argv[1]?.endsWith('/owner-web-runtime-diagnostics-command.ts')) {
  main().catch(() => {
    process.stderr.write(
      'Protected runtime diagnostics refused; no configuration mutation attempted.\n',
    );
    process.exitCode = 1;
  });
}
