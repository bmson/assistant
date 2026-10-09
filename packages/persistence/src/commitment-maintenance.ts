import type { Records } from './records.js';

type Candidate = Pick<Records['commitments'], 'status' | 'resolvedAt' | 'snoozedUntil'>;

/** An unresolved obligation does not expire merely because nobody mentioned it. */
export function commitmentIsActive(row: Candidate, now: Date): boolean {
  return (
    row.resolvedAt == null &&
    (row.status === 'open' ||
      row.status === 'stale' ||
      (row.status === 'snoozed' && row.snoozedUntil !== null && row.snoozedUntil <= now))
  );
}

export function commitmentMaintenanceTransition(
  row: Candidate,
  now: Date,
): 'woken' | 'restored' | null {
  if (row.resolvedAt != null) return null;
  if (row.status === 'stale') return 'restored';
  if (row.status === 'snoozed' && row.snoozedUntil !== null && row.snoozedUntil <= now)
    return 'woken';
  return null;
}

export interface CommitmentMaintenanceResult {
  woken: number;
  restored: number;
}

/** Wake elapsed snoozes and recover obligations hidden by legacy age cleanup. */
export interface CommitmentMaintenanceRepository {
  readonly kind: 'commitment-maintenance-repository';
  maintain(agentId: string, now: Date): Promise<CommitmentMaintenanceResult>;
}
