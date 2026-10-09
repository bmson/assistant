import type { RepairIssue, RepairStatus } from './self-repair.js';
export type RepairStage =
  | 'queued'
  | 'investigation'
  | 'coding_dispatch'
  | 'validation'
  | 'pr_review'
  | 'merge'
  | 'rollout'
  | 'verification'
  | 'unknown';
export interface RepairOutcome {
  version: 1;
  status: RepairStatus;
  stage: RepairStage;
  message: string;
  nextStep: string;
}
const stages: Partial<Record<RepairStatus, RepairStage>> = {
  reported: 'queued',
  investigating: 'investigation',
  fixing: 'coding_dispatch',
  testing: 'validation',
  pr_open: 'pr_review',
  merged: 'rollout',
  monitoring: 'verification',
  resolved: 'verification',
};
const names: Record<RepairStage, string> = {
  queued: 'Queue',
  investigation: 'Investigation',
  coding_dispatch: 'Coding dispatch',
  validation: 'Validation',
  pr_review: 'PR review',
  merge: 'Merge',
  rollout: 'Rollout',
  verification: 'Behavior verification',
  unknown: 'Repair',
};
const next: Record<RepairStage, string> = {
  queued: 'Open Improvements to check the queue and coding allowance.',
  investigation:
    'Add the missing steps and expected behavior in Improvements, then request a new investigation.',
  coding_dispatch:
    'Check the recorded coding run before requesting another attempt; an unconfirmed dispatch may still be running.',
  validation: 'Review the recorded check results in Improvements or the linked PR before retrying.',
  pr_review: 'Review the linked PR and its checks in Improvements.',
  merge: 'Check the PR merge result before requesting further work.',
  rollout: 'Check the release status for the merged change. Deployment has not been confirmed.',
  verification:
    'Reproduce the original problem on the current app and confirm the result in Improvements.',
  unknown:
    'Open Improvements to inspect the recorded evidence. The failed stage is not established.',
};
export function repairOutcome(issue: RepairIssue, failureStage?: RepairStage): RepairOutcome {
  let stage = stages[issue.status];
  if (!stage && ['failed', 'blocked'].includes(issue.status)) {
    stage =
      failureStage ??
      (issue.data.outcome?.status === issue.status && Object.hasOwn(names, issue.data.outcome.stage)
        ? issue.data.outcome.stage
        : undefined) ??
      [...issue.data.history]
        .reverse()
        .map((entry) => stages[entry.status])
        .find(Boolean);
  }
  stage ??= 'unknown';
  let message = `${names[stage]} ${issue.status === 'blocked' ? 'needs attention' : issue.status === 'failed' ? 'did not complete' : 'is in progress'}.`;
  let nextStep = next[stage];
  if (issue.status === 'reported') message = 'The report is saved and queued for investigation.';
  if (issue.status === 'pr_open')
    message =
      'A proposed change is ready for PR review. It has not been confirmed deployed or fixed.';
  if (issue.status === 'merged')
    message = 'The proposed change was merged. Deployment has not been confirmed.';
  if (issue.status === 'monitoring') {
    message =
      issue.data.mergeSha && issue.data.monitoringAt
        ? 'Deployment was confirmed for the merged change. The original behavior still needs verification.'
        : 'The repair is marked for monitoring, but deployment evidence is unavailable.';
  }
  if (issue.status === 'resolved') {
    message = 'The issue is marked resolved.';
    nextStep = 'Report again if the original problem returns.';
  }
  if (issue.status === 'dismissed') {
    message = 'The report was dismissed.';
    nextStep = 'Report again if further investigation is needed.';
  }
  if (issue.status === 'blocked' && issue.data.ownerActionRequired) {
    message = issue.data.lastError ?? 'The investigation is blocked pending an owner action.';
    nextStep = issue.data.ownerActionRequired;
  }
  return { version: 1, status: issue.status, stage, message, nextStep };
}
