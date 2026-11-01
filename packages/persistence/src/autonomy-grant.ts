import { z } from 'zod';

/** How a task's bounded autonomy permission was armed. */
export type AutonomyGrantSource = 'card' | 'composer' | 'goal';

export const AutonomyGrantSchema = z.object({
  grantedAt: z.iso.datetime(),
  grantedVia: z.enum(['card', 'composer', 'goal']),
  approvalId: z.string().min(1).optional(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable().optional(),
});

export type AutonomyGrant = z.infer<typeof AutonomyGrantSchema>;

/** A grant expires after this window unless revoked sooner. */
export const AUTONOMY_GRANT_TTL_HOURS = 24;

/** Shared live validator used by dispatch and the atomic execution adapters. */
export function activeAutonomyGrant(
  task: { autonomyGrant?: unknown; trust?: string | null },
  nowMs: number,
): AutonomyGrant | null {
  if (task.trust !== 'owner' && task.trust !== 'assistant') return null;
  const parsed = AutonomyGrantSchema.safeParse(task.autonomyGrant);
  if (!parsed.success) return null;
  const grant = parsed.data;
  if (grant.revokedAt != null || !Number.isFinite(nowMs)) return null;
  const grantedAt = Date.parse(grant.grantedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  if (
    !Number.isFinite(grantedAt) ||
    !Number.isFinite(expiresAt) ||
    grantedAt > nowMs ||
    expiresAt <= nowMs ||
    expiresAt <= grantedAt ||
    expiresAt - grantedAt > AUTONOMY_GRANT_TTL_HOURS * 3_600_000
  )
    return null;
  if (grant.grantedVia === 'card' && !grant.approvalId) return null;
  return grant;
}

/** Exact snapshot for a direct-owner grant used to downgrade an approval. */
export interface ExpectedOwnerAutonomyGrantBinding {
  trust: 'owner';
  grant: AutonomyGrant;
}

/**
 * Revalidate the same grant under the task lock and repository clock. A newly
 * issued or changed grant must cause the old execution decision to be retried.
 */
export function ownerAutonomyGrantBindingMatches(
  expected: ExpectedOwnerAutonomyGrantBinding,
  task: { autonomyGrant?: unknown; trust?: string | null },
  repositoryNow: Date,
): boolean {
  if (
    !expected ||
    expected.trust !== 'owner' ||
    !(repositoryNow instanceof Date) ||
    !Number.isFinite(repositoryNow.getTime())
  )
    return false;
  const current = activeAutonomyGrant(task, repositoryNow.getTime());
  return Boolean(
    task.trust === 'owner' &&
      current &&
      current.grantedAt === expected.grant.grantedAt &&
      current.grantedVia === expected.grant.grantedVia &&
      current.approvalId === expected.grant.approvalId &&
      current.expiresAt === expected.grant.expiresAt &&
      current.revokedAt === expected.grant.revokedAt,
  );
}
