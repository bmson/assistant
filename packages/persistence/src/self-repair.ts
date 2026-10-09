import { createHash } from 'node:crypto';
import { type RepairOutcome, repairOutcome } from './repair-outcome.js';
/** Durable repair ledger. Provider and coding credentials never enter these records. */
export const REPAIR_STATUSES = [
  'reported',
  'investigating',
  'fixing',
  'testing',
  'pr_open',
  'merged',
  'monitoring',
  'resolved',
  'blocked',
  'failed',
  'dismissed',
] as const;
export type RepairStatus = (typeof REPAIR_STATUSES)[number];
export const ACTIVE_REPAIR_STATUSES: readonly RepairStatus[] = [
  'investigating',
  'fixing',
  'testing',
  'pr_open',
];
export interface RepairDetails {
  source: 'feedback' | 'failure' | 'proposal';
  symptomKey?: string;
  parentIssueId?: string;
  sourceTaskId?: string;
  conversationId?: string;
  proposalId?: string;
  title: string;
  summary: string;
  diagnosis?: string;
  category?: 'bug' | 'feature' | 'configuration' | 'provider' | 'answer' | 'unknown';
  targetPaths?: string[];
  reproduction?: string;
  acceptance?: string;
  branch?: string;
  runId?: number;
  runUrl?: string;
  prNumber?: number;
  prUrl?: string;
  mergeSha?: string;
  dispatchedAt?: string;
  workerProvider?: 'github' | 'openai_hosted';
  hostedSessionId?: string;
  hostedTurnId?: string;
  hostedSourceSha?: string;
  hostedCommitSha?: string;
  hostedPublishedAt?: string;
  hostedCleanupPending?: boolean;
  monitoringAt?: string;
  lastError?: string;
  outcome?: RepairOutcome;
  notifiedStatus?: RepairStatus;
  /** Set only by an authenticated owner action; authorizes one attempt beyond the automatic cap. */
  manualRunRequestedAt?: string;
  manualRunStartedAt?: string;
  /** Number of safely classified transient investigation failures, not coding dispatches. */
  preDispatchRetryCount?: number;
  /** Earliest time a transient investigation retry may be claimed. */
  nextEligibleAt?: string;
  /** Stable job IDs let repository adapters reconcile actual model usage after a restart. */
  investigationTaskIds?: string[];
  accountedInvestigationTaskIds?: string[];
  investigationStartedAt?: string;
  /** Bounded, credential-free router telemetry for investigation attempts. */
  routerAttempts?: RepairRouterAttempt[];
  modelAccounting?: RepairModelAccounting;
  ownerActionRequired?: string;
  history: Array<{ status: RepairStatus; at: string; detail: string }>;
}
export interface RepairRouterAttempt {
  at: string;
  classification:
    | 'success'
    | 'transient'
    | 'authentication'
    | 'configuration'
    | 'budget'
    | 'unknown';
  providerAttempts: number | null;
  modelId?: string;
  primaryModelId?: string;
  fallbackModelId?: string;
  primaryElapsedMs?: number;
  fallbackElapsedMs?: number;
  failureKind?: string;
  fallbackFailureKind?: string;
  requestProfile?: {
    method: 'object';
    role: string;
    schema: true;
    maxOutputTokens?: number;
    maxRetries?: number;
  };
  /** Exact model-call rows observed for this task at write time; null means unavailable. */
  observedModelCalls: number | null;
  /** Sum of durable model-call rows observed; null means no durable cost row exists. */
  knownCostUsd: string | null;
  accountingComplete: boolean;
}
export interface RepairModelAccounting {
  observedModelCalls: number;
  knownCostUsd: string | null;
  unresolvedReservations: number;
  /** False if telemetry is absent or any attempted call may not yet have a ledger row. */
  complete: boolean;
}
export interface RepairIssue {
  id: string;
  agentId: string;
  fingerprint: string;
  status: RepairStatus;
  version: number;
  data: RepairDetails;
  createdAt: Date;
  updatedAt: Date;
}
export interface RepairReport {
  fingerprint: string;
  source: RepairDetails['source'];
  symptomKey?: string;
  parentIssueId?: string;
  sourceTaskId?: string;
  conversationId?: string;
  proposalId?: string;
  title: string;
  summary: string;
}
export interface SelfRepairRepository {
  report(agentId: string, input: RepairReport): Promise<RepairIssue>;
  list(agentId: string): Promise<RepairIssue[]>;
  /** Atomic per-owner claim; active work and the daily dispatch allowance are checked under a lock. */
  claim(
    agentId: string,
    now: Date,
    dailyLimit: number,
    taskId?: string,
  ): Promise<RepairIssue | null>;
  modelAccounting(agentId: string, taskIds: string[], since: Date): Promise<RepairModelAccounting>;
  /** Compare-and-swap: stale workers and duplicate sweeps cannot overwrite newer state. */
  update(
    issue: RepairIssue,
    status: RepairStatus,
    patch: Partial<RepairDetails>,
    now: Date,
  ): Promise<RepairIssue | null>;
  failures(
    agentId: string,
    since: Date,
  ): Promise<Array<{ taskId: string; title: string; symptomKey?: string; observedAt?: string }>>;
}
export function repairTransition(
  issue: RepairIssue,
  status: RepairStatus,
  patch: Partial<RepairDetails>,
  now: Date,
): RepairIssue {
  const result: RepairIssue = {
    ...issue,
    status,
    version: issue.version + 1,
    updatedAt: now,
    data: {
      ...issue.data,
      ...patch,
      history:
        status === issue.status
          ? issue.data.history
          : [
              ...issue.data.history,
              { status, at: now.toISOString(), detail: patch.lastError ?? patch.diagnosis ?? '' },
            ].slice(-30),
    },
  };
  const priorStage = ['failed', 'blocked'].includes(status)
    ? repairOutcome(issue).stage
    : undefined;
  result.data.outcome = repairOutcome(result, patch.outcome?.stage ?? priorStage);
  return result;
}

/** Group recurring failures without storing raw error text in the grouping key. */
export function repairFailureKey(title: string, state: unknown): string {
  const error =
    state && typeof state === 'object' && 'lastError' in state ? String(state.lastError) : title;
  const signature = error
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\b[a-f0-9]{8}-[a-f0-9-]{27,}\b/g, '[id]')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 1000);
  return createHash('sha256').update(signature).digest('hex');
}

/** A retry joins the back of the queue instead of starving newer reports. */
export function queuedRepairIssues(issues: RepairIssue[]): RepairIssue[] {
  return issues
    .filter((issue) => issue.status === 'reported')
    .sort(
      (a, b) =>
        Number(Boolean(b.data.manualRunRequestedAt)) -
          Number(Boolean(a.data.manualRunRequestedAt)) ||
        a.updatedAt.getTime() - b.updatedAt.getTime() ||
        a.id.localeCompare(b.id),
    );
}

/** Scheduling and atomic claims use the same rolling allowance and active-work fence. */
export function repairQueueReady(issues: RepairIssue[], now: Date, dailyLimit: number): boolean {
  return repairClaimCandidate(issues, now, dailyLimit) !== null;
}

export function repairClaimCandidate(
  issues: RepairIssue[],
  now: Date,
  dailyLimit: number,
): RepairIssue | null {
  if (issues.length > 1000 || issues.some((row) => ACTIVE_REPAIR_STATUSES.includes(row.status)))
    return null;
  const candidate = queuedRepairIssues(issues).find((row) => {
    if (row.data.manualRunRequestedAt) return true;
    if (
      row.data.nextEligibleAt !== undefined &&
      !Number.isFinite(Date.parse(row.data.nextEligibleAt))
    )
      return false;
    const eligible = row.data.nextEligibleAt ? Date.parse(row.data.nextEligibleAt) : NaN;
    return !Number.isFinite(eligible) || eligible <= now.getTime();
  });
  if (!candidate) return null;
  if (
    candidate.data.manualRunRequestedAt &&
    Number.isFinite(Date.parse(candidate.data.manualRunRequestedAt))
  )
    return candidate;
  return repairDispatchesUsed(issues, now) < dailyLimit ? candidate : null;
}

/** Earliest queued retry/capacity wake. Undefined means there is no queued work. */
export function repairQueueNextEligibleAt(
  issues: RepairIssue[],
  now: Date,
  dailyLimit: number,
): Date | undefined {
  if (issues.length > 1000 || issues.some((row) => ACTIVE_REPAIR_STATUSES.includes(row.status)))
    return undefined;
  const queued = queuedRepairIssues(issues).filter(
    (row) =>
      !row.data.manualRunRequestedAt &&
      (row.data.nextEligibleAt === undefined ||
        Number.isFinite(Date.parse(row.data.nextEligibleAt))),
  );
  if (queued.length === 0) return undefined;
  const retryAt = queued
    .map((row) => Date.parse(row.data.nextEligibleAt ?? ''))
    .filter(Number.isFinite)
    .filter((timestamp) => timestamp > now.getTime());
  if (repairDispatchesUsed(issues, now) < dailyLimit) {
    const immediate = queued.some((row) => {
      const eligible = Date.parse(row.data.nextEligibleAt ?? '');
      return !Number.isFinite(eligible) || eligible <= now.getTime();
    });
    if (immediate) return now;
    return retryAt.length ? new Date(Math.min(...retryAt)) : undefined;
  }
  const dispatchTimes = issues
    .flatMap((row) => row.data.history)
    .filter((event) => event.status === 'fixing')
    .map((event) => Date.parse(event.at))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > now.getTime() - 86400000)
    .sort((a, b) => a - b);
  const capacityAt = dispatchTimes[dispatchTimes.length - dailyLimit];
  const capacityWake = capacityAt === undefined ? undefined : capacityAt + 86400000;
  const retryWake = retryAt.length ? Math.min(...retryAt) : undefined;
  const wake = [capacityWake, retryWake].filter((value): value is number => value !== undefined);
  return wake.length ? new Date(Math.max(now.getTime(), Math.min(...wake))) : undefined;
}

export function repairDispatchesUsed(issues: RepairIssue[], now = new Date()): number {
  const since = new Date(now.getTime() - 86400000).toISOString();
  return issues.reduce(
    (sum, row) =>
      sum +
      row.data.history.filter((event) => event.status === 'fixing' && event.at >= since).length,
    0,
  );
}
