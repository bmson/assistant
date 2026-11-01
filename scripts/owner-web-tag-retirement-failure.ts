/** Allowlisted failure facts only. Never serialize an exception or provider response. */
import { ProtectedCloudCommandError, type ProtectedCloudStage } from './owner-web-tag-cloud.js';
import { describeWebTrafficDiscrepancy } from './owner-web-traffic-discrepancy.js';

export type RetirementStage =
  | ProtectedCloudStage
  | 'arguments'
  | 'protected_context'
  | 'reviewed_packet_time'
  | 'plan_read_service'
  | 'plan_read_historical_revision'
  | 'plan_read_current_revision'
  | 'plan_validation'
  | 'packet_write'
  | 'reviewed_packet_match'
  | 'apply_service_read'
  | 'apply_revision_read'
  | 'apply_write_boundary'
  | 'apply_patch'
  | 'apply_wait_operation'
  | 'apply_drain'
  | 'result_write';
const stages = new Set<RetirementStage>([
  'cloud_wif_validation',
  'cloud_runner_validation',
  'cloud_binary_validation',
  'cloud_sdk_version',
  'cloud_access_token',
  'cloud_native_client',
  'arguments',
  'protected_context',
  'reviewed_packet_time',
  'plan_read_service',
  'plan_read_historical_revision',
  'plan_read_current_revision',
  'plan_validation',
  'packet_write',
  'reviewed_packet_match',
  'apply_service_read',
  'apply_revision_read',
  'apply_write_boundary',
  'apply_patch',
  'apply_wait_operation',
  'apply_drain',
  'result_write',
]);
const commandReasons = new Set([
  'sdk_binary_not_found',
  'sdk_permission_denied',
  'sdk_command_timed_out',
  'sdk_output_limit',
  'sdk_nonzero_exit',
  'sdk_command_failed',
]);
const messages = new Map([
  ['Invalid WIF file', 'credential_file_refused'],
  ['Unsupported protected cloud runner', 'runner_refused'],
  ['Invalid protected cloud binary', 'binary_refused'],
  ['Unaudited cloud CLI', 'sdk_version_refused'],
  ['Native read rejected', 'native_read_rejected'],
  ['Native read failed', 'native_read_failed'],
  ['Native response unreadable; do not retry mutation', 'native_response_unreadable'],
  ['Desired and observed traffic differ', 'traffic_disagreement'],
  ['Service is not settled', 'service_unsettled'],
  ['Service generation is not observed', 'generation_unobserved'],
  ['Invalid retirement metadata', 'metadata_refused'],
  ['Invalid retirement identity', 'identity_refused'],
  ['Immutable revision identity mismatch', 'immutable_revision_mismatch'],
  ['Immutable image mismatch', 'immutable_image_mismatch'],
  ['Immutable pause mismatch', 'immutable_pause_mismatch'],
  ['Legacy request timeout exceeds drain bound', 'timeout_exceeds_drain'],
  ['Unknown nonserving target must be preserved', 'unowned_target_preserved'],
  ['Current 100 identity changed', 'current_identity_changed'],
  ['Current service template identity mismatch', 'current_template_mismatch'],
  ['Proven tag was reassigned or active', 'proven_tag_changed'],
  ['Retirement plan is stale; no write attempted', 'plan_stale'],
  ['Native PATCH outcome uncertain; do not retry', 'patch_uncertain'],
  ['Native PATCH rejected; do not retry', 'patch_rejected'],
  ['Native operation failed', 'operation_failed'],
  ['Native operation unsettled; do not retry mutation', 'operation_unsettled'],
  ['Service version changed or drain stability evidence is missing', 'drain_stability_unproven'],
  ['Reviewed retirement observation expired', 'review_expired'],
  [
    'Fresh retirement state differs from reviewed packet; no write attempted',
    'reviewed_packet_changed',
  ],
]);
export function retirementFailureReason(error: unknown): string {
  try {
    if (error instanceof ProtectedCloudCommandError && commandReasons.has(error.reason))
      return error.reason;
    if (error instanceof Error) {
      const reason = messages.get(error.message);
      if (reason) return reason;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return 'filesystem_not_found';
      if (code === 'EACCES') return 'filesystem_access_denied';
    }
  } catch {
    /* A hostile exception still becomes a fixed opaque code. */
  }
  return 'unclassified_stop';
}
export function retirementFailureTracker(env: NodeJS.ProcessEnv, argument: unknown) {
  let stage: RetirementStage = 'arguments',
    mutationPossible = false;
  let trafficDiscrepancy: ReturnType<typeof describeWebTrafficDiscrepancy> | undefined;
  const mode =
    argument === '--plan'
      ? 'plan'
      : argument === '--apply'
        ? 'apply'
        : argument === '--verify-source'
          ? 'verify_source'
          : 'unqualified';
  return {
    noteTrafficSnapshot: (raw: unknown) => {
      trafficDiscrepancy = describeWebTrafficDiscrepancy(raw);
    },
    mark: (value: RetirementStage) => {
      stage = value;
    },
    markMutationPossible: () => {
      mutationPossible = true;
    },
    receipt: (error: unknown) => ({
      format: 1,
      source: /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ? env.GITHUB_SHA : null,
      runId: /^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? '') ? env.GITHUB_RUN_ID : null,
      mode,
      stage: stages.has(stage) ? stage : 'unclassified_stage',
      reason: retirementFailureReason(error),
      mutationState: mutationPossible ? 'may_have_been_attempted' : 'not_attempted',
      readiness: 'unknown',
      authorityEstablished: false,
      retryAuthorized: false,
      ...(trafficDiscrepancy ? { trafficDiscrepancy } : {}),
    }),
  };
}
