/** Protected one-time historical retirement. Fixed pins only, no general admin inputs. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  verifyPreAuthEnvironment,
  verifyWifEnvironment,
} from './owner-editor-release-inventory.js';
import { nativeRetirementClient } from './owner-web-tag-native.js';
import {
  executeOwnedWebTagRetirement,
  HISTORICAL_WEB_TAGS,
  planOwnedWebTagRetirement,
  type RetirementPlan,
} from './owner-web-tag-retirement.js';

const exec = promisify(execFile);
const WORKFLOW = 'bmson/assistant/.github/workflows/owner-web-tag-retirement.yml@refs/heads/main';
export function verifyRetirementContext(env: NodeJS.ProcessEnv) {
  verifyPreAuthEnvironment(env);
  if (
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_WORKFLOW_REF !== WORKFLOW ||
    env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA ||
    env.OWNER_TAG_REVIEWED_SOURCE !== env.GITHUB_SHA
  )
    throw new Error('Unreviewed retirement workflow source');
}
export function retirementPacket(plan: RetirementPlan, source: string, observedAt: string) {
  return { format: 1, source, observedAt, plan };
}
export function retirementPacketHash(packet: ReturnType<typeof retirementPacket>) {
  return createHash('sha256').update(JSON.stringify(packet)).digest('hex');
}
export function verifyReviewedPacketTime(value: unknown, now: number): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    throw new Error('Invalid reviewed observation time');
  const time = Date.parse(value);
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString() !== value ||
    time > now ||
    now - time > 30 * 60_000
  )
    throw new Error('Reviewed retirement observation expired');
  return value;
}
async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['--verify-source', '--plan', '--apply'].includes(mode ?? ''))
    throw new Error('Invalid retirement mode');
  verifyRetirementContext(process.env);
  if (mode === '--verify-source') return;
  const observedAt =
    mode === '--apply'
      ? verifyReviewedPacketTime(process.env.OWNER_TAG_REVIEWED_OBSERVED_AT, Date.now())
      : new Date().toISOString();
  if (
    mode === '--apply' &&
    !/^[a-f0-9]{64}$/.test(process.env.OWNER_TAG_REVIEWED_PLAN_SHA256 ?? '')
  )
    throw new Error('Missing reviewed retirement hash');
  const identity = verifyWifEnvironment(process.env, (file) => {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768)
      throw new Error('Invalid WIF file');
    return JSON.parse(readFileSync(file, 'utf8'));
  });
  if (!process.env.RUNNER_TEMP) throw new Error('Missing protected temporary directory');
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLOUDSDK_CONFIG: resolve(process.env.RUNNER_TEMP, 'owner-tag-retirement-gcloud'),
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: identity.file,
    CLOUDSDK_CORE_PROJECT: 'bmson-assistant',
    CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
    CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: 'true',
  };
  async function command(args: string[]) {
    try {
      return (
        await exec('gcloud', args, {
          env: childEnv,
          timeout: 10_000,
          maxBuffer: 32768,
          killSignal: 'SIGKILL',
        })
      ).stdout;
    } catch {
      throw new Error('Protected cloud credential command failed');
    }
  }
  const version = JSON.parse(await command(['version', '--format=json']));
  if (version['Google Cloud SDK'] !== '576.0.0') throw new Error('Unaudited cloud CLI');
  const token = (await command(['auth', 'print-access-token', '--quiet'])).trim();
  const io = nativeRetirementClient(token);
  const [old, current] = HISTORICAL_WEB_TAGS;
  if (!old || !current) throw new Error('Missing historical pins');
  const before = await io.readService();
  const native: Record<string, unknown> = {};
  for (const proof of [old, current])
    native[proof.revision] = await io.readRevision(proof.revision);
  const plan = planOwnedWebTagRetirement(before, native, [old], {
    revision: current.revision,
    image: current.image,
    tag: current.tag,
    uriSha256: current.uriSha256,
    paused: false,
  });
  const packet = retirementPacket(plan, process.env.GITHUB_SHA ?? '', observedAt);
  const packetSha256 = retirementPacketHash(packet);
  // Receipt contains only public resource identities, hashes and CAS metadata, no native env/spec.
  writeFileSync(
    'owner-web-tag-retirement-plan.json',
    `${JSON.stringify({ packet, packetSha256 })}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  if (mode === '--plan') return;
  verifyReviewedPacketTime(observedAt, Date.now());
  if (packetSha256 !== process.env.OWNER_TAG_REVIEWED_PLAN_SHA256)
    throw new Error('Fresh retirement state differs from reviewed packet; no write attempted');
  const result = await executeOwnedWebTagRetirement(plan, {
    ...io,
    patchTraffic: (body) => {
      // Fresh reads may consume the remaining review lifetime; check at the write boundary.
      verifyReviewedPacketTime(observedAt, Date.now());
      return io.patchTraffic(body);
    },
  });
  writeFileSync(
    'owner-web-tag-retirement-result.json',
    `${JSON.stringify({ source: process.env.GITHUB_SHA, packetSha256, ...result })}\n`,
    { flag: 'wx', mode: 0o600 },
  );
}
if (process.argv[1]?.endsWith('/owner-web-tag-retirement-command.ts')) {
  main().catch(() => {
    // No raw provider exceptions, token values, request bodies or credential paths in logs.
    process.stderr.write(
      'Exact-owned web tag retirement stopped; do not retry uncertain apply or admit writes.\n',
    );
    process.exitCode = 1;
  });
}
