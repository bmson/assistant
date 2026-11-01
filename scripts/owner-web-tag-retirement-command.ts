/** Protected one-time historical retirement. Fixed pins only, no general admin inputs. */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { verifyPreAuthEnvironment } from './owner-editor-release-inventory.js';
import { protectedWebTagCloud } from './owner-web-tag-cloud.js';
import {
  executeOwnedWebTagRetirement,
  HISTORICAL_WEB_TAGS,
  planOwnedWebTagRetirement,
  type RetirementPlan,
} from './owner-web-tag-retirement.js';
import { retirementFailureTracker } from './owner-web-tag-retirement-failure.js';

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
export async function runRetirementCommand(tracker: ReturnType<typeof retirementFailureTracker>) {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['--verify-source', '--plan', '--apply'].includes(mode ?? ''))
    throw new Error('Invalid retirement mode');
  tracker.mark('protected_context');
  verifyRetirementContext(process.env);
  if (mode === '--verify-source') return;
  tracker.mark('reviewed_packet_time');
  const observedAt =
    mode === '--apply'
      ? verifyReviewedPacketTime(process.env.OWNER_TAG_REVIEWED_OBSERVED_AT, Date.now())
      : new Date().toISOString();
  if (
    mode === '--apply' &&
    !/^[a-f0-9]{64}$/.test(process.env.OWNER_TAG_REVIEWED_PLAN_SHA256 ?? '')
  )
    throw new Error('Missing reviewed retirement hash');
  const io = await protectedWebTagCloud(tracker.mark);
  const [old, current] = HISTORICAL_WEB_TAGS;
  if (!old || !current) throw new Error('Missing historical pins');
  tracker.mark('plan_read_service');
  const before = await io.readService();
  const native: Record<string, unknown> = {};
  for (const proof of [old, current]) {
    tracker.mark(proof === old ? 'plan_read_historical_revision' : 'plan_read_current_revision');
    native[proof.revision] = await io.readRevision(proof.revision);
  }
  tracker.mark('plan_validation');
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
  tracker.mark('packet_write');
  writeFileSync(
    'owner-web-tag-retirement-plan.json',
    `${JSON.stringify({ packet, packetSha256 })}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  if (mode === '--plan') return;
  tracker.mark('reviewed_packet_match');
  verifyReviewedPacketTime(observedAt, Date.now());
  if (packetSha256 !== process.env.OWNER_TAG_REVIEWED_PLAN_SHA256)
    throw new Error('Fresh retirement state differs from reviewed packet; no write attempted');
  const result = await executeOwnedWebTagRetirement(plan, {
    ...io,
    readService: () => {
      tracker.mark('apply_service_read');
      return io.readService();
    },
    patchTraffic: (body) => {
      tracker.mark('apply_write_boundary');
      // Fresh reads may consume the remaining review lifetime; check at the write boundary.
      verifyReviewedPacketTime(observedAt, Date.now());
      tracker.markMutationPossible();
      tracker.mark('apply_patch');
      return io.patchTraffic(body);
    },
    waitOperation: (operation) => {
      tracker.mark('apply_wait_operation');
      return io.waitOperation(operation);
    },
    drain: (seconds) => {
      tracker.mark('apply_drain');
      return io.drain(seconds);
    },
  });
  tracker.mark('result_write');
  writeFileSync(
    'owner-web-tag-retirement-result.json',
    `${JSON.stringify({ source: process.env.GITHUB_SHA, packetSha256, ...result })}\n`,
    { flag: 'wx', mode: 0o600 },
  );
}
if (process.argv[1]?.endsWith('/owner-web-tag-retirement-command.ts')) {
  const tracker = retirementFailureTracker(process.env, process.argv[2]);
  runRetirementCommand(tracker).catch((error: unknown) => {
    // No raw provider exceptions, token values, request bodies or credential paths in logs.
    const receipt = tracker.receipt(error);
    process.stderr.write(`${JSON.stringify(receipt)}\n`);
    try {
      writeFileSync('owner-web-tag-retirement-failure.json', `${JSON.stringify(receipt)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    } catch {
      /* Preserve the original failure; never expose filesystem exceptions. */
    }
    process.exitCode = 1;
  });
}
