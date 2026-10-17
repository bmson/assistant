import { describe, expect, it } from 'vitest';
import { repairOutcome } from './repair-outcome.js';
import { type RepairIssue, repairTransition } from './self-repair.js';

function issue(status: RepairIssue['status']): RepairIssue {
  return {
    id: 'issue',
    agentId: 'owner',
    fingerprint: 'f',
    status,
    version: 1,
    createdAt: new Date('2026-10-07Z'),
    updatedAt: new Date('2026-10-07Z'),
    data: {
      title: 'Broken flow',
      summary: 'Expected behavior',
      source: 'feedback',
      lastError: 'provider timeout sk-proj-SECRETSECRET',
      history: [],
    },
  };
}
describe('deterministic repair outcomes', () => {
  it('explains a known sandbox setup failure without exposing arbitrary provider errors', () => {
    const failed = issue('failed');
    failed.data.lastError = 'Hosted sandbox setup failed. No coding result was published.';
    expect(repairOutcome(failed)).toMatchObject({
      message: 'The coding sandbox could not start. No code was published.',
    });
    failed.data.lastError = 'provider timeout sk-proj-SECRETSECRET';
    expect(JSON.stringify(repairOutcome(failed))).not.toContain('SECRET');
  });
  it('explains a rejected protected patch without suggesting that coding is still running', () => {
    const failed = issue('failed');
    failed.data.lastError = 'Hosted result contains duplicate or protected paths';
    expect(repairOutcome(failed)).toMatchObject({
      message: 'The proposed patch included duplicate or protected files. No PR was published.',
      nextStep: expect.stringContaining('owner-led'),
    });
  });
  it.each([
    ['investigating', 'investigation'],
    ['fixing', 'coding_dispatch'],
    ['testing', 'validation'],
    ['pr_open', 'pr_review'],
    ['merged', 'rollout'],
    ['monitoring', 'verification'],
  ] as const)('retains failed %s stage and actionable copy', (status, stage) => {
    const failed = repairTransition(issue(status), 'failed', {}, new Date());
    expect(failed.data.outcome).toMatchObject({ status: 'failed', stage });
    const projected = repairOutcome(failed);
    expect(projected.message).toContain('did not complete');
    expect(projected.nextStep.length).toBeGreaterThan(20);
    expect(JSON.stringify(projected)).not.toContain('SECRET');
    expect(JSON.stringify(projected)).not.toContain('timeout');
  });
  it('accepts a typed merge failure distinct from PR review', () => {
    const value = repairTransition(
      issue('pr_open'),
      'failed',
      { outcome: { version: 1, status: 'failed', stage: 'merge', message: '', nextStep: '' } },
      new Date(),
    );
    expect(repairOutcome(value).stage).toBe('merge');
  });
  it('does not promote merged or legacy monitoring status to deployed/fixed', () => {
    expect(repairOutcome(issue('merged')).message).toContain('Deployment has not been confirmed');
    expect(repairOutcome(issue('monitoring')).message).toContain('evidence is unavailable');
    const confirmed = issue('monitoring');
    confirmed.data.mergeSha = 'revision';
    confirmed.data.monitoringAt = new Date().toISOString();
    expect(repairOutcome(confirmed).message).toContain('still needs verification');
  });
  it('labels unknown historical failure stage honestly', () => {
    expect(repairOutcome(issue('failed'))).toMatchObject({
      stage: 'unknown',
      nextStep: expect.stringContaining('not established'),
    });
  });
});
