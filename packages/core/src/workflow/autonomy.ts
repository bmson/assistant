/**
 * Free-range ("bypass approval") autonomy grants (Phase 3).
 *
 * When the owner explicitly asks the assistant to work autonomously, a grant is
 * stamped on the task. The dispatcher then downgrades an otherwise
 * approval-gated call to autonomous — EXCEPT a hard floor the grant can never
 * cross. The grant is ALWAYS created by an authenticated owner action (an
 * approved up-front card, the chat composer's "Autonomous" toggle, or a
 * per-goal setting); it can never be armed from within a task's execution or
 * from external content, and a tainted-origin task can never be armed.
 *
 * This module is the single source of truth for the grant shape and the floor.
 * The floor deliberately takes a structural flags object (not the tools package's
 * ToolFlags) so core does not import tools.
 */

import { z } from 'zod';

/** How a grant was armed — recorded for the audit trail and UI copy. */
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

/**
 * Deterministic detector for an explicit "do this on your own, don't ask me"
 * instruction in the owner's own message. Kept conservative — it must match a
 * clear standing-autonomy phrase, not a passing mention, because a false
 * positive shows an extra approval card (harmless) while the real gate is that
 * the owner still approves that card.
 */
export function looksLikeAutonomyRequest(text: string): boolean {
  const t = ` ${text.toLowerCase()} `;
  return [
    /\bdo (it|this|that|everything|the rest) autonomous/,
    /\bautonomous(ly)?\b.*\b(don'?t|do not|without) (ask|approv|check|bug|confirm)/,
    /\b(don'?t|do not|no need to) (ask|approv|check|confirm|bug) me\b/,
    /\bwithout (asking|approval|checking|confirming|bugging me|bothering me)\b/,
    /\bapprove (everything|it all|them all|all of it|the rest)\b/,
    /\bfree[- ]?range\b/,
    /\bfull (autonomy|authority|control|reign|rein)\b/,
    /\bjust (do it|handle it|take care of it)\b.*\b(don'?t|without|no)\b/,
    /\bgo ahead (and )?(do|handle|take|book|send|schedule).*\b(without|no need|don'?t ask)\b/,
    /\byou (have|got) (my )?(permission|the green light|free rein)\b/,
  ].some((re) => re.test(t));
}

/** Build a fresh grant. `nowMs`/`ttlHours` are injectable for tests. */
export function buildAutonomyGrant(input: {
  grantedVia: AutonomyGrantSource;
  approvalId?: string;
  nowMs: number;
  ttlHours?: number;
}): AutonomyGrant {
  const ttl = input.ttlHours ?? AUTONOMY_GRANT_TTL_HOURS;
  if (
    !Number.isFinite(input.nowMs) ||
    !Number.isFinite(ttl) ||
    ttl <= 0 ||
    ttl > AUTONOMY_GRANT_TTL_HOURS
  ) {
    throw new Error('Autonomy grants require a finite time and a positive TTL of at most 24 hours');
  }
  return {
    grantedAt: new Date(input.nowMs).toISOString(),
    grantedVia: input.grantedVia,
    ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    expiresAt: new Date(input.nowMs + ttl * 3_600_000).toISOString(),
    revokedAt: null,
  };
}

/**
 * The grant on a task IF it is currently in force: parsed, unrevoked, unexpired,
 * and on an owner/assistant task. Returns null otherwise. Trust is checked as
 * defense-in-depth — arming is owner-only, but a grant must never take effect on
 * an unknown/known-sender task even if one were somehow present.
 */
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

/**
 * The hard floor: true means "this call must stay owner-approved even under an
 * active grant". The owner's floor items plus the always-on floor (policy
 * denies and budget) which are enforced elsewhere in the dispatcher:
 *   1. a memory write while the session carries untrusted content,
 *   2. a send to an unverified recipient,
 *   3. the highest-consequence tools (interactive browser, networked code),
 *      marked with the autonomyFloor flag.
 */
export function autonomyFloorBlocks(input: {
  flags: { autonomyFloor?: boolean; writesMemory?: boolean };
  tainted: boolean;
  recipientUnverified: boolean;
}): boolean {
  if (input.flags.autonomyFloor) return true;
  if (input.flags.writesMemory && input.tainted) return true;
  if (input.recipientUnverified) return true;
  return false;
}
