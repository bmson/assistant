import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({
  apply: vi.fn(),
  dismiss: vi.fn(),
  requestFix: vi.fn(),
}));
const repairActions = vi.hoisted(() => ({
  decision: vi.fn(),
  report: vi.fn(),
}));
vi.mock('@/app/improvements/actions', () => ({
  applyProposalAction: actions.apply,
  dismissProposalAction: actions.dismiss,
  requestProposalCodeFixAction: actions.requestFix,
}));
vi.mock('./repair-actions', () => ({
  repairDecisionAction: repairActions.decision,
  reportRepairAction: repairActions.report,
}));

import { ProposalCard } from './proposal-card';
import {
  isRepairConfirmationCurrent,
  primaryRepairAction,
  RepairPanel,
  type RepairView,
} from './repair-panel';

const proposal = {
  id: '12345678-1234-4234-8234-123456789abc',
  kind: 'note',
  title: 'Fix',
  rationale: 'Why',
  suggestion: 'Retry',
  evidenceCount: 0,
  applyable: false,
  createdLabel: '',
};

it('offers a code-fix request only when the service is available', () => {
  const available = renderToStaticMarkup(<ProposalCard proposal={proposal} canRequestFix />);
  expect(available).toContain('Request code fix');
  expect(available).toContain('Mark reviewed');

  const unavailable = renderToStaticMarkup(<ProposalCard proposal={proposal} />);
  expect(unavailable).not.toContain('Request code fix');
  expect(unavailable).toContain('Mark reviewed');
});

const repairFixture = (overrides: Partial<RepairView> = {}): RepairView => ({
  id: '12345678-1234-4234-8234-123456789abc',
  title: 'A long repair title that should wrap inside the card instead of widening the page',
  summary: 'Original issue summary',
  status: 'pr_open',
  diagnosis: 'The issue was caused by an incorrect retry boundary.',
  lastError: '',
  manualRunRequested: false,
  queuePosition: null,
  waitingReason: null,
  workerProvider: 'github',
  prNumber: null,
  sourceTaskId: null,
  prUrl: 'https://github.com/example/repo/pull/31',
  runUrl: 'https://github.com/example/repo/actions/runs/41',
  mergeSha: null,
  updatedAt: '2026-10-21T19:00:00.000Z',
  codeReview: {
    commitSha: 'abcdef0123456789',
    approved: true,
    modelId: 'review-model',
    summary: 'The saved review approved the change.',
    reviewedAt: '2026-10-21T18:00:00.000Z',
  },
  outcome: {
    message: 'A proposed change is ready for PR review.',
    nextStep: 'Review the linked PR.',
  },
  deploymentConfirmed: false,
  history: [{ status: 'testing', at: '2026-10-21T17:00:00.000Z', detail: 'Checks recorded.' }],
  ...overrides,
});

it('labels PR evidence as recorded, shows freshness without claiming it was checked, and preserves review history', () => {
  const markup = renderToStaticMarkup(
    <RepairPanel
      overview={{ enabled: true, configured: true, dailyLimit: 2, issues: [repairFixture()] }}
    />,
  );

  expect(markup).toContain('Pull request recorded');
  expect(markup).toContain('The pull request may have changed since that review.');
  expect(markup).toContain('Last recorded update');
  expect(markup).not.toContain('Last checked');
  expect(markup).not.toContain('PR ready to review');
  expect(markup).not.toContain('Open recorded pull request');
  expect(markup).toContain('Review recorded pull request');
  expect(markup).toContain('Diagnosis and history');
  expect(markup).toContain('Saved independent review');
  expect(markup).not.toContain('Confirm fixed');

  const monitoring = renderToStaticMarkup(
    <RepairPanel
      overview={{
        enabled: true,
        configured: true,
        dailyLimit: 2,
        issues: [
          repairFixture({
            status: 'monitoring',
            prUrl: null,
            mergeSha: 'fedcba9876543210',
            deploymentConfirmed: true,
            codeReview: null,
          }),
        ],
      }}
    />,
  );
  expect(monitoring).toContain('Deployment observed · needs confirmation');
  expect(monitoring).toContain('A deployment was observed for the merged revision.');
  expect(monitoring).toContain('Confirm fixed');
  expect(monitoring).toContain('Merged revision');

  const monitoringWithoutDeploymentEvidence = renderToStaticMarkup(
    <RepairPanel
      overview={{
        enabled: true,
        configured: true,
        dailyLimit: 2,
        issues: [
          repairFixture({
            status: 'monitoring',
            prUrl: null,
            mergeSha: null,
            deploymentConfirmed: false,
            codeReview: null,
          }),
        ],
      }}
    />,
  );
  expect(monitoringWithoutDeploymentEvidence).toContain('Deployment evidence unavailable');
  expect(monitoringWithoutDeploymentEvidence).not.toContain('Confirm fixed');
});

it('keeps daily retry primary and separately explains the extra billable attempt and dismiss action', () => {
  const markup = renderToStaticMarkup(
    <RepairPanel
      overview={{
        enabled: true,
        configured: true,
        dailyLimit: 2,
        issues: [
          repairFixture({
            status: 'blocked',
            prUrl: null,
            codeReview: null,
            outcome: {
              message: 'The publisher is not configured.',
              nextStep: 'Check the publisher settings before retrying.',
            },
          }),
        ],
      }}
    />,
  );

  expect(markup.indexOf('The publisher is not configured.')).toBeLessThan(
    markup.indexOf('Retry within daily allowance'),
  );
  expect(markup).toContain('Retry within daily allowance');
  expect(markup).toContain('Start extra attempt…');
  expect(markup).toContain(
    'One manual attempt is beyond the automatic daily allowance and may incur provider charges.',
  );
  expect(markup).toContain('More');
  expect(markup).toContain('Dismiss report');
  expect(markup).toContain('Retry within daily allowance');
  expect(primaryRepairAction(repairFixture({ status: 'blocked', prUrl: null }))).toBe(null);

  const alreadyRequested = renderToStaticMarkup(
    <RepairPanel
      overview={{
        enabled: true,
        configured: true,
        dailyLimit: 2,
        issues: [repairFixture({ status: 'reported', manualRunRequested: true, prUrl: null })],
      }}
    />,
  );
  expect(alreadyRequested).toContain('Manual run requested');
  expect(alreadyRequested).not.toContain('Start extra attempt');

  const failedWithoutPR = renderToStaticMarkup(
    <RepairPanel
      overview={{
        enabled: true,
        configured: true,
        dailyLimit: 2,
        issues: [repairFixture({ status: 'failed', prUrl: null, codeReview: null })],
      }}
    />,
  );
  expect(failedWithoutPR).toContain('Retry within daily allowance');
  expect(failedWithoutPR).toContain('Start extra attempt…');
  expect(primaryRepairAction(repairFixture({ status: 'failed', prUrl: null }))).toBe('retry');
  expect(primaryRepairAction(repairFixture({ status: 'pr_open' }))).toBe('review-pr');

  const failedGitHubPR = renderToStaticMarkup(
    <RepairPanel
      overview={{
        enabled: true,
        configured: true,
        dailyLimit: 2,
        issues: [
          repairFixture({
            status: 'failed',
            workerProvider: 'github',
            prNumber: 42,
            prUrl: 'https://github.com/example/repo/pull/42',
          }),
        ],
      }}
    />,
  );
  expect(failedGitHubPR).toContain('Open recorded pull request');
  expect(failedGitHubPR).not.toContain('Retry within daily allowance');
  expect(failedGitHubPR).not.toContain('Start extra attempt');

  const failedHostedPR = renderToStaticMarkup(
    <RepairPanel
      overview={{
        enabled: true,
        configured: true,
        dailyLimit: 2,
        issues: [
          repairFixture({
            status: 'failed',
            workerProvider: 'openai_hosted',
            prNumber: 43,
            prUrl: 'https://github.com/example/repo/pull/43',
          }),
        ],
      }}
    />,
  );
  expect(failedHostedPR).toContain('Retry within daily allowance');
  expect(failedHostedPR).toContain('Start extra attempt…');
  expect(
    primaryRepairAction(
      repairFixture({
        status: 'failed',
        workerProvider: 'openai_hosted',
        prNumber: 43,
        prUrl: 'https://github.com/example/repo/pull/43',
      }),
    ),
  ).toBe(null);
});

it('keeps closed report evidence available in the past-reports disclosure', () => {
  const markup = renderToStaticMarkup(
    <RepairPanel
      overview={{
        enabled: true,
        configured: true,
        dailyLimit: 2,
        issues: [repairFixture({ status: 'resolved', prUrl: null })],
      }}
    />,
  );

  expect(markup).toContain('Past reports (1)');
  expect(markup).toContain('Confirmed fixed');
  expect(markup).toContain('Diagnosis and history');
  expect(markup).not.toContain('Confirm fixed');
});

it('blocks a confirmed action when the rendered report revision or eligibility changed', () => {
  const issue = repairFixture({ status: 'blocked', prUrl: null, codeReview: null });
  const overview = { enabled: true, configured: true, dailyLimit: 2, issues: [issue] };
  const extraAttempt = {
    issueId: issue.id,
    action: 'run_now' as const,
    issueRevision: JSON.stringify([issue.status, issue.updatedAt, false]),
  };
  const dismiss = {
    issueId: issue.id,
    action: 'dismiss' as const,
    issueRevision: JSON.stringify([issue.status, issue.updatedAt, false]),
  };

  expect(isRepairConfirmationCurrent(extraAttempt, overview)).toBe(true);
  expect(isRepairConfirmationCurrent(dismiss, overview)).toBe(true);
  expect(
    isRepairConfirmationCurrent(extraAttempt, {
      ...overview,
      configured: false,
    }),
  ).toBe(false);
  expect(
    isRepairConfirmationCurrent(extraAttempt, {
      ...overview,
      issues: [{ ...issue, status: 'pr_open' }],
    }),
  ).toBe(false);
  expect(
    isRepairConfirmationCurrent(dismiss, {
      ...overview,
      issues: [{ ...issue, updatedAt: '2026-10-22T19:00:00.000Z' }],
    }),
  ).toBe(false);
  expect(
    isRepairConfirmationCurrent(extraAttempt, {
      ...overview,
      issues: [{ ...issue, manualRunRequested: true }],
    }),
  ).toBe(false);
  expect(
    isRepairConfirmationCurrent(extraAttempt, {
      ...overview,
      issues: [{ ...issue, workerProvider: 'github', prNumber: 42 }],
    }),
  ).toBe(false);
  expect(
    isRepairConfirmationCurrent(extraAttempt, {
      ...overview,
      issues: [{ ...issue, workerProvider: 'openai_hosted', prNumber: 42 }],
    }),
  ).toBe(true);
});
