import { describe, expect, it } from 'vitest';
import { ProtectedCloudCommandError, protectedCommandReason } from './owner-web-tag-cloud.js';
import {
  type RetirementStage,
  retirementFailureReason,
  retirementFailureTracker,
} from './owner-web-tag-retirement-failure.js';

const secret = 'PRIVATE_TOKEN_STDERR_REQUEST_RESOURCE_AND_RECORD';
describe('safe retirement failure facts', () => {
  it.each([
    [{ code: 'ENOENT', stderr: secret }, 'sdk_binary_not_found'],
    [{ code: 'EACCES', stdout: secret }, 'sdk_permission_denied'],
    [
      { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stderr: secret, killed: true },
      'sdk_output_limit',
    ],
    [{ killed: true, stderr: secret }, 'sdk_command_timed_out'],
    [{ code: 1, stderr: secret }, 'sdk_nonzero_exit'],
    [{ code: secret, message: secret }, 'sdk_command_failed'],
    [null, 'sdk_command_failed'],
  ])('reduces command failures to an allowlisted category', (error, reason) =>
    expect(protectedCommandReason(error)).toBe(reason),
  );
  it('does not expose hostile exception getters or forged reason/stage values', () => {
    const hostile = Object.defineProperty({}, 'code', {
      get() {
        throw new Error(secret);
      },
    });
    expect(protectedCommandReason(hostile)).toBe('sdk_command_failed');
    expect(
      retirementFailureReason(new ProtectedCloudCommandError(secret as 'sdk_command_failed')),
    ).toBe('unclassified_stop');
    const tracker = retirementFailureTracker({ GITHUB_SHA: secret, GITHUB_RUN_ID: secret }, secret);
    tracker.mark(secret as RetirementStage);
    expect(tracker.receipt(new Error(secret))).toMatchObject({
      source: null,
      runId: null,
      mode: 'unqualified',
      stage: 'unclassified_stage',
      reason: 'unclassified_stop',
      mutationState: 'not_attempted',
    });
    expect(JSON.stringify(tracker.receipt(hostile))).not.toContain(secret);
  });
  it.each([
    ['Desired and observed traffic differ', 'traffic_disagreement'],
    ['Legacy request timeout exceeds drain bound', 'timeout_exceeds_drain'],
    ['Unknown nonserving target must be preserved', 'unowned_target_preserved'],
    ['Native read rejected', 'native_read_rejected'],
    ['Native PATCH outcome uncertain; do not retry', 'patch_uncertain'],
  ])('returns only a fixed reason for recognized failures', (message, code) =>
    expect(retirementFailureReason(new Error(message))).toBe(code),
  );
  it('preserves possible mutation after PATCH instead of claiming no-write from a failure', () => {
    const tracker = retirementFailureTracker(
      { GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123' },
      '--apply',
    );
    tracker.mark('apply_write_boundary');
    expect(tracker.receipt(new Error(secret)).mutationState).toBe('not_attempted');
    tracker.markMutationPossible();
    tracker.mark('apply_patch');
    const receipt = tracker.receipt(new Error('Native PATCH outcome uncertain; do not retry'));
    expect(receipt).toMatchObject({
      stage: 'apply_patch',
      reason: 'patch_uncertain',
      mutationState: 'may_have_been_attempted',
      retryAuthorized: false,
      readiness: 'unknown',
      authorityEstablished: false,
    });
    expect(JSON.stringify(receipt)).not.toContain(secret);
  });
});
