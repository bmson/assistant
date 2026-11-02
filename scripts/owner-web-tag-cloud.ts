/** Existing protected WIF only; no local credential discovery or target selection. */
import { execFile } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { verifyWifEnvironment } from './owner-editor-release-inventory.js';
import { nativeRetirementClient } from './owner-web-tag-native.js';

const exec = promisify(execFile);
export type ProtectedCloudStage =
  | 'cloud_wif_validation'
  | 'cloud_runner_validation'
  | 'cloud_binary_validation'
  | 'cloud_sdk_version'
  | 'cloud_access_token'
  | 'cloud_native_client';
export type ProtectedCommandReason =
  | 'sdk_binary_not_found'
  | 'sdk_permission_denied'
  | 'sdk_command_timed_out'
  | 'sdk_output_limit'
  | 'sdk_nonzero_exit'
  | 'sdk_command_failed';
export class ProtectedCloudCommandError extends Error {
  constructor(readonly reason: ProtectedCommandReason) {
    super('Protected native command failed');
  }
}
export function protectedCommandReason(error: unknown): ProtectedCommandReason {
  try {
    const value = error as { code?: unknown; killed?: unknown } | null;
    if (value?.code === 'ENOENT') return 'sdk_binary_not_found';
    if (value?.code === 'EACCES') return 'sdk_permission_denied';
    if (value?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'sdk_output_limit';
    if (value?.killed === true) return 'sdk_command_timed_out';
    if (
      typeof value?.code === 'number' &&
      Number.isInteger(value.code) &&
      value.code > 0 &&
      value.code <= 255
    )
      return 'sdk_nonzero_exit';
  } catch {
    /* Never inspect or expose hostile exception fields further. */
  }
  return 'sdk_command_failed';
}
export async function protectedWebTagCredential(
  mark: (stage: ProtectedCloudStage) => void = () => undefined,
) {
  mark('cloud_wif_validation');
  const identity = verifyWifEnvironment(process.env, (file) => {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768)
      throw new Error('Invalid WIF file');
    return JSON.parse(readFileSync(file, 'utf8'));
  });
  mark('cloud_runner_validation');
  if (!process.env.RUNNER_TEMP) throw new Error('Missing protected temporary directory');
  const childEnv = {
    PATH: '/usr/bin:/bin',
    HOME: process.env.HOME,
    CLOUDSDK_CONFIG: resolve(process.env.RUNNER_TEMP, 'owner-tag-admission-gcloud'),
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: identity.file,
    CLOUDSDK_CORE_PROJECT: 'bmson-assistant',
    CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
    CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: 'true',
  };
  // setup-gcloud uses its verified tool cache; never resolve a credentialed binary via PATH.
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    process.env.RUNNER_TOOL_CACHE !== '/opt/hostedtoolcache'
  )
    throw new Error('Unsupported protected cloud runner');
  mark('cloud_binary_validation');
  const binary = '/opt/hostedtoolcache/gcloud/576.0.0/x64/bin/gcloud';
  const binaryStat = lstatSync(binary);
  if (!binaryStat.isFile() || binaryStat.isSymbolicLink() || (binaryStat.mode & 0o111) === 0)
    throw new Error('Invalid protected cloud binary');
  async function command(args: string[]) {
    try {
      return (
        await exec(binary, args, {
          env: childEnv,
          timeout: 10_000,
          maxBuffer: 32768,
          killSignal: 'SIGKILL',
        })
      ).stdout;
    } catch (error) {
      throw new ProtectedCloudCommandError(protectedCommandReason(error));
    }
  }
  mark('cloud_sdk_version');
  const version = JSON.parse(await command(['version', '--format=json']));
  if (version['Google Cloud SDK'] !== '576.0.0') throw new Error('Unaudited cloud CLI');
  mark('cloud_access_token');
  const token = (await command(['auth', 'print-access-token', '--quiet'])).trim();
  mark('cloud_native_client');
  return token;
}
/** Existing retirement entrypoint retains its exact single-target transport. */
export async function protectedWebTagCloud(
  mark: (stage: ProtectedCloudStage) => void = () => undefined,
) {
  return nativeRetirementClient(await protectedWebTagCredential(mark));
}
