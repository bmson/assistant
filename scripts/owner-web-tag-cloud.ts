/** Existing protected WIF only; no local credential discovery or target selection. */
import { execFile } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { verifyWifEnvironment } from './owner-editor-release-inventory.js';
import { nativeRetirementClient } from './owner-web-tag-native.js';

const exec = promisify(execFile);
export async function protectedWebTagCloud() {
  const identity = verifyWifEnvironment(process.env, (file) => {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768)
      throw new Error('Invalid WIF file');
    return JSON.parse(readFileSync(file, 'utf8'));
  });
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
    } catch {
      throw new Error('Protected native command failed');
    }
  }
  const version = JSON.parse(await command(['version', '--format=json']));
  if (version['Google Cloud SDK'] !== '576.0.0') throw new Error('Unaudited cloud CLI');
  return nativeRetirementClient((await command(['auth', 'print-access-token', '--quiet'])).trim());
}
