/** One-off fixed topology plan/apply; no journal, alias retirement or release continuation. */
import { writeFileSync } from 'node:fs';
import { verifyPreAuthEnvironment } from './owner-editor-release-inventory.js';
import { protectedWebTagCredential } from './owner-web-tag-cloud.js';
import { HISTORICAL_WEB_TAGS } from './owner-web-tag-retirement.js';
import { verifyReviewedPacketTime } from './owner-web-tag-retirement-command.js';
import { retirementFailureTracker } from './owner-web-tag-retirement-failure.js';
import {
  executeWebTrafficReconciliation,
  planWebTrafficReconciliation,
  reconciliationDigest,
  type TrafficReconciliationIO,
  TrafficReconciliationStop,
  type WebTrafficReconciliationPlan,
} from './owner-web-traffic-reconciliation-model.js';
import { nativeWebTrafficReconciliationClient } from './owner-web-traffic-reconciliation-native.js';

const WORKFLOW =
  'bmson/assistant/.github/workflows/owner-web-traffic-reconciliation.yml@refs/heads/main';
export function verifyReconciliationContext(env: NodeJS.ProcessEnv) {
  verifyPreAuthEnvironment(env);
  if (
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_WORKFLOW_REF !== WORKFLOW ||
    env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA ||
    env.OWNER_RECONCILIATION_REVIEWED_SOURCE !== env.GITHUB_SHA
  )
    throw new Error('Unreviewed reconciliation workflow source');
}
export function reconciliationPacket(
  plan: WebTrafficReconciliationPlan,
  source: string,
  observedAt: string,
) {
  return { format: 1, source, observedAt, plan };
}
export const reconciliationPacketHash = (p: ReturnType<typeof reconciliationPacket>) =>
  reconciliationDigest(p);
type Tracker = ReturnType<typeof retirementFailureTracker>;
export interface ReconciliationCommandDependencies {
  cloud: (mark: Tracker['mark']) => Promise<TrafficReconciliationIO>;
  now: () => number;
  write: (path: string, value: unknown) => void;
}
export async function runReconciliationCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  tracker: Tracker,
  deps: ReconciliationCommandDependencies,
) {
  const now = () => {
    const n = deps.now();
    if (!Number.isFinite(n) || n < 0) throw new TrafficReconciliationStop('stale_review');
    return n;
  };
  const reviewedTime = (value: unknown) => {
    try {
      return verifyReviewedPacketTime(value, now());
    } catch {
      throw new TrafficReconciliationStop('stale_review');
    }
  };
  tracker.mark('arguments');
  const mode = args[0];
  if (args.length !== 1 || !['--verify-source', '--plan', '--apply'].includes(mode ?? ''))
    throw new Error('Invalid reconciliation mode');
  tracker.mark('protected_context');
  verifyReconciliationContext(env);
  if (mode === '--verify-source') return;
  tracker.mark('reviewed_packet_time');
  const observedAt =
    mode === '--apply'
      ? reviewedTime(env.OWNER_RECONCILIATION_REVIEWED_OBSERVED_AT)
      : new Date(now()).toISOString();
  if (
    mode === '--apply' &&
    !/^[a-f0-9]{64}$/.test(env.OWNER_RECONCILIATION_REVIEWED_PLAN_SHA256 ?? '')
  )
    throw new TrafficReconciliationStop('invalid_metadata');
  const io = await deps.cloud(tracker.mark);
  tracker.mark('plan_read_service');
  const before = await io.readService(AbortSignal.timeout(15000));
  const native: Record<string, unknown> = {};
  for (const [i, p] of HISTORICAL_WEB_TAGS.entries()) {
    tracker.mark(i === 0 ? 'plan_read_historical_revision' : 'plan_read_current_revision');
    native[p.revision] = await io.readRevision(p.revision, AbortSignal.timeout(15000));
  }
  tracker.mark('plan_validation');
  let plan: WebTrafficReconciliationPlan;
  try {
    plan = planWebTrafficReconciliation(before, native, env.GITHUB_SHA ?? '', observedAt);
  } catch (error) {
    if (
      mode === '--plan' &&
      reconciliationFailureReceipt(tracker, error).reason === 'unexpected_topology'
    )
      tracker.noteTrafficSnapshot(before); // Existing bounded hints; no extra read or mutation authority.
    throw error;
  }
  const packet = reconciliationPacket(plan, env.GITHUB_SHA ?? '', observedAt),
    packetSha256 = reconciliationPacketHash(packet);
  tracker.mark('packet_write');
  deps.write('owner-web-traffic-reconciliation-plan.json', { packet, packetSha256 });
  if (mode === '--plan') return;
  tracker.mark('reviewed_packet_match');
  reviewedTime(observedAt);
  if (packetSha256 !== env.OWNER_RECONCILIATION_REVIEWED_PLAN_SHA256)
    throw new TrafficReconciliationStop('stale_plan');
  const result = await executeWebTrafficReconciliation(
    plan,
    {
      readService: (signal) => {
        tracker.mark('apply_service_read');
        return io.readService(signal);
      },
      readRevision: (name, signal) => {
        tracker.mark('apply_revision_read');
        return io.readRevision(name, signal);
      },
      patchTraffic: (body, options) => {
        tracker.mark('apply_write_boundary');
        reviewedTime(observedAt);
        tracker.markMutationPossible();
        tracker.mark('apply_patch');
        return io.patchTraffic(body, options);
      },
      waitOperation: (operation, signal) => {
        tracker.mark('apply_wait_operation');
        return io.waitOperation(operation, signal);
      },
    },
    now,
  );
  tracker.mark('result_write');
  deps.write('owner-web-traffic-reconciliation-result.json', {
    packetSha256,
    ...result,
  });
}
const reasons = new Set([
  'invalid_metadata',
  'unexpected_topology',
  'native_proof_refused',
  'stale_review',
  'stale_plan',
  'read_failed',
  'patch_unconfirmed',
  'operation_unconfirmed',
  'postcheck_failed',
]);
export function reconciliationFailureReceipt(tracker: Tracker, error: unknown) {
  const receipt = tracker.receipt(error);
  let reason = receipt.reason;
  try {
    if (error instanceof TrafficReconciliationStop && reasons.has(error.reason))
      reason = error.reason;
  } catch {
    /* No hostile exception fields. */
  }
  return {
    ...receipt,
    kind: 'exact_known_web_traffic_reconciliation',
    reason,
    editingAuthorized: false,
    retirementDrainCompleted: false,
    requiresNewNormalRetirementPlan: true,
  };
}
if (process.argv[1]?.endsWith('/owner-web-traffic-reconciliation-command.ts')) {
  const args = process.argv.slice(2),
    tracker = retirementFailureTracker(process.env, args[0]);
  const write = (path: string, value: unknown) =>
    writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
  void runReconciliationCommand(args, process.env, tracker, {
    cloud: async (mark) =>
      nativeWebTrafficReconciliationClient(await protectedWebTagCredential(mark)),
    now: Date.now,
    write,
  }).catch((error: unknown) => {
    const receipt = reconciliationFailureReceipt(tracker, error);
    process.stderr.write(`${JSON.stringify(receipt)}\n`);
    try {
      write('owner-web-traffic-reconciliation-failure.json', receipt);
    } catch {
      /* Preserve original stop; no filesystem disclosure. */
    }
    process.exitCode = 1;
  });
}
