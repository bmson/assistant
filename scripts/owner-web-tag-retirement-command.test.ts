import { describe, expect, it } from 'vitest';
import {
  retirementProfile,
  verifyRetirementContext,
  verifyReviewedPacketTime,
} from './owner-web-tag-retirement-command.js';

const env = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'bmson/assistant',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_RUN_ID: '123',
  GCP_PROJECT: 'bmson-assistant',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
  OWNER_TAG_REVIEWED_SOURCE: 'a'.repeat(40),
  GITHUB_WORKFLOW_REF:
    'bmson/assistant/.github/workflows/owner-web-tag-retirement.yml@refs/heads/main',
  GCP_DEPLOY_SERVICE_ACCOUNT: 'deployer@bmson-assistant.iam.gserviceaccount.com',
  GCP_WORKLOAD_IDENTITY_PROVIDER:
    'projects/123/locations/global/workloadIdentityPools/ci/providers/github',
};
describe('protected retirement command binding', () => {
  it('accepts only exact protected reviewed workflow source', () =>
    expect(() => verifyRetirementContext(env)).not.toThrow());
  it('keeps the old fixed profile default and opts into only the exact newly proven alias', () => {
    expect(retirementProfile(env)).toBe('legacy-01080');
    expect(() =>
      verifyRetirementContext({
        ...env,
        OWNER_TAG_RETIREMENT_PROFILE: 'known-resume-40403696377-1',
      }),
    ).not.toThrow();
    for (const bad of ['', 'canonical', 'all', 'operator', 'known-resume-123-1'])
      expect(() =>
        verifyRetirementContext({ ...env, OWNER_TAG_RETIREMENT_PROFILE: bad }),
      ).toThrow();
  });
  it.each([
    ['GITHUB_ACTIONS', 'false'],
    ['GITHUB_REPOSITORY', 'other/assistant'],
    ['GITHUB_REF', 'refs/heads/branch'],
    ['GITHUB_RUN_ATTEMPT', '2'],
    ['GCP_PROJECT', 'other'],
    ['GITHUB_EVENT_NAME', 'pull_request'],
    ['GITHUB_WORKFLOW_REF', 'other'],
    ['GITHUB_WORKFLOW_SHA', 'b'.repeat(40)],
    ['OWNER_TAG_REVIEWED_SOURCE', 'b'.repeat(40)],
  ])('rejects changed %s', (key, value) =>
    expect(() => verifyRetirementContext({ ...env, [key]: value })).toThrow(),
  );
  it('accepts canonical recent observation time only', () => {
    const now = Date.parse('2026-10-31T12:00:00.000Z');
    expect(verifyReviewedPacketTime('2026-10-31T11:45:00.000Z', now)).toBe(
      '2026-10-31T11:45:00.000Z',
    );
    for (const bad of [
      undefined,
      '2026-10-31T12:01:00.000Z',
      '2026-10-31T11:29:59.999Z',
      '2026-10-31T12:00:00Z',
      '2026-02-30T12:00:00.000Z',
    ])
      expect(() => verifyReviewedPacketTime(bad, now)).toThrow();
  });
});
