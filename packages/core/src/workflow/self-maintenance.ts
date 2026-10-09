import {
  agents,
  type Db,
  improvementProposals,
  type SelfMaintenanceRow,
  selfMaintenance,
} from '@assistant/db';
import type { ExecutionPersistence, SelfMaintenanceRepository } from '@assistant/persistence';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { BudgetReservationError, nextDailyReset, nextMonthlyReset } from '../cost.js';
import { isUnparseableObjectError, type ModelRouter } from '../model-router/router.js';
import { withSpan } from '../otel.js';
import { reportRepair } from './self-repair.js';

/**
 * Self-maintenance (Phase 21). The bot proposes fixes to its OWN repo for
 * code-shaped findings (from Phase 12), but the guarantees that keep this safe
 * live HERE, in code, not in a prompt:
 *
 *  - The FENCE (`isProtectedPath`): the bot may NEVER change code that governs
 *    its own autonomy or deployment — infra/, migrations, and the approval /
 *    policy / trust / taint / auth / secrets code paths (including this file).
 *    A finding that targets a protected path is recorded `blocked`, never a PR.
 *  - PR-ONLY: it opens a pull request against its own GitHub identity; it never
 *    pushes to main and never triggers a deploy. Merge is ALWAYS the owner's.
 *  - ONE open self-PR at a time.
 *  - Self-PRs are labeled so anomaly detection (Phase 18) watches the pattern.
 *
 * Opening a PR needs a GitHub token the owner provides; without it the PR path
 * is inert (the backlog still populates). This module does NOT auto-write
 * patches — that heavier, higher-risk loop stays owner-gated.
 */

// ── The fence ─────────────────────────────────────────────────────────────────

/** Directory prefixes the bot must never modify (deploy/infra/schema-history). */
const PROTECTED_PREFIXES = [
  'infra/',
  '.github/',
  'packages/db/drizzle/', // applied migrations — history is immutable
];

/**
 * Exact files whose behavior is the bot's own guardrails. Editing any of these
 * could widen the bot's autonomy, so they are off-limits to self-maintenance.
 */
const PROTECTED_FILES = new Set([
  // approval / policy / trust / risk gate
  'packages/tools/src/dispatcher.ts',
  'packages/tools/src/registry.ts',
  'packages/tools/src/policies.ts',
  'packages/core/src/workflow/approvals.ts',
  'packages/core/src/workflow/anomaly.ts',
  // taint model + executor security
  'packages/core/src/events.ts',
  'packages/core/src/workflow/executor.ts',
  // self-referential guardrails (the fence, the eval, the dream)
  'packages/core/src/workflow/self-maintenance.ts',
  'packages/core/src/workflow/improve.ts',
  'packages/core/src/workflow/dream.ts',
  // secrets / config / db shape / seed
  'packages/core/src/config.ts',
  'packages/db/src/schema.ts',
  'packages/db/src/seed.ts',
  // OAuth / auth entry points
  'scripts/auth-bot.ts',
]);

/** Substrings/patterns that mark a path as security-sensitive regardless of exact name. */
const PROTECTED_PATTERNS = [
  /(^|[/-])auth(\.|\/|-)/i,
  /(?:^|[/-])(?:passkeys?|device[-/]keys?)(?:[./-]|$)/i,
  /credential/i,
  /secret/i,
  /(^|\/)\.env/i,
  /taint/i,
  /oidc/i,
  /webhooks?\./i, // webhook auth surfaces
  /email-provenance/i,
  /workflow\/executor\//, // every executor internal (step-loop, phases, tool-context, …)
];

function normalizeRepoPath(path: string): string {
  return path
    .replaceAll('\\', '/')
    .replace(/^\.?\/+/, '')
    .trim();
}

/**
 * True when a repo path is off-limits to self-maintenance. Fails CLOSED: an
 * empty, traversing, or absolute path is treated as protected.
 */
export function isProtectedPath(path: string): boolean {
  const raw = (path ?? '').trim();
  // Fail closed on absolute paths, traversal, and NUL BEFORE normalization —
  // a self-maintenance change may only touch relative paths inside the repo.
  if (
    !raw ||
    raw.startsWith('/') ||
    raw.startsWith('~') ||
    raw.includes('..') ||
    raw.includes('\0')
  ) {
    return true;
  }
  const p = normalizeRepoPath(raw);
  if (!p) return true;
  if (PROTECTED_PREFIXES.some((prefix) => p.startsWith(prefix))) return true;
  if (PROTECTED_FILES.has(p)) return true;
  if (PROTECTED_PATTERNS.some((re) => re.test(p))) return true;
  return false;
}

/** Split a set of changed files into what self-maintenance may and may not touch. */
export function partitionChangedFiles(paths: string[]): { allowed: string[]; blocked: string[] } {
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const path of paths) (isProtectedPath(path) ? blocked : allowed).push(path);
  return { allowed, blocked };
}

// ── Backlog (code job) ────────────────────────────────────────────────────────

const MaintenanceDraftSchema = z.object({
  items: z
    .array(
      z.object({
        proposalId: z.string().optional(),
        codeShaped: z.boolean().describe('true only if this is a concrete code fix in this repo'),
        title: z.string().min(3).max(200),
        diagnosis: z.string().max(1500).default(''),
        targetArea: z
          .string()
          .max(200)
          .default('')
          .describe('The single most likely repo file path the fix touches.'),
      }),
    )
    .max(5)
    .default([]),
});

const MAINTAIN_SYSTEM = [
  "You triage the assistant's own open improvement proposals for ones that are a concrete CODE fix in THIS repository (a bug, a brittle selector, a missing guard).",
  'For each code-shaped one, include its exact proposalId, give a short diagnosis and the single most likely repo-relative file path it touches (e.g. "packages/core/src/browse.ts").',
  'Ignore anything that is a config/model-routing change, a prompt tweak, or not clearly code. If nothing is code-shaped, return an empty items array. Never propose changes to security, approval, policy, infra, auth, or migration files.',
].join('\n');

export interface SelfMaintenanceResult {
  backlog: number;
  blocked: number;
}

/**
 * Code job `self.maintain`: turn code-shaped open proposals into fenced backlog
 * items (diagnosis only — no patch is written). A finding whose target area is
 * a protected path is recorded `blocked`, so the fence's refusals are auditable.
 */
export async function runSelfMaintenance(
  deps: {
    db: Db;
    router: ModelRouter;
    heartbeat?: () => Promise<void>;
    /** The portable backlog store; without it the job reads and writes PostgreSQL. */
    persistence?: Pick<ExecutionPersistence, 'selfMaintenance' | 'selfRepair'>;
  },
  opts: { agentId?: string; taskId?: string } = {},
): Promise<SelfMaintenanceResult> {
  const { db, router } = deps;
  const store = deps.persistence?.selfMaintenance ?? postgresSelfMaintenance(db);
  return withSpan('self.maintain', {}, async () => {
    await deps.heartbeat?.();
    const [fallbackAgent] =
      opts.agentId || deps.persistence?.selfMaintenance
        ? []
        : await db.select({ id: agents.id }).from(agents).limit(1);
    const agentId = opts.agentId ?? fallbackAgent?.id;
    if (!agentId) return { backlog: 0, blocked: 0 };

    const open = await store.openProposals(agentId, 20);
    if (open.length === 0) return { backlog: 0, blocked: 0 };

    const prompt = [
      'Open improvement proposals:',
      ...open.map(
        (p) => `- [${p.kind}] ${p.title}: ${p.rationale.slice(0, 200)} (proposalId=${p.id})`,
      ),
    ].join('\n');

    const outcome = await router
      .object<z.infer<typeof MaintenanceDraftSchema>>('reason', {
        taskId: opts.taskId,
        schema: MaintenanceDraftSchema,
        system: MAINTAIN_SYSTEM,
        prompt,
      })
      .catch((err) => {
        if (!isUnparseableObjectError(err)) throw err;
        console.error('self-maintain: could not structure output', err);
        return null;
      });
    await deps.heartbeat?.();
    if (outcome === null) return { backlog: 0, blocked: 0 };
    if (!outcome.ok) {
      throw new BudgetReservationError(
        outcome.decision.reason,
        outcome.decision.reason.includes('monthly') ? nextMonthlyReset() : nextDailyReset(),
      );
    }

    let backlog = 0;
    let blocked = 0;
    for (const item of outcome.object.items) {
      if (!item.codeShaped) continue;
      const proposal = open.find((row) => row.id === item.proposalId);
      if (deps.persistence?.selfRepair && proposal) {
        await reportRepair(deps.persistence.selfRepair, agentId, {
          source: 'proposal',
          sourceTaskId: proposal.evidenceIds?.find((id) => /^[a-f0-9-]{36}$/i.test(id)),
          proposalId: proposal.id,
          key: proposal.id,
          title: proposal.title,
          summary: `${proposal.rationale}\n${item.diagnosis}`,
        });
      }
      // The fence decides status: a protected target is recorded, never worked.
      const isBlocked = !item.targetArea || isProtectedPath(item.targetArea);
      const inserted = await store.insert(agentId, {
        title: item.title.trim().slice(0, 200),
        diagnosis: item.diagnosis,
        targetArea: item.targetArea,
        status: isBlocked ? 'blocked' : 'backlog',
        blockedReason: isBlocked
          ? item.targetArea
            ? 'targets a protected path (autonomy/trust/infra) — self-maintenance may not touch it'
            : 'no target file identified'
          : null,
      });
      if (inserted) {
        if (isBlocked) blocked += 1;
        else backlog += 1;
      }
    }
    return { backlog, blocked };
  });
}

/** The backlog's PostgreSQL reads and ledger, with the queries it has always run. */
function postgresSelfMaintenance(db: Db): SelfMaintenanceRepository {
  return {
    kind: 'self-maintenance-repository',
    openProposals: (agentId, limit) =>
      db
        .select({
          id: improvementProposals.id,
          kind: improvementProposals.kind,
          title: improvementProposals.title,
          rationale: improvementProposals.rationale,
          evidenceIds: improvementProposals.evidenceIds,
        })
        .from(improvementProposals)
        .where(
          and(eq(improvementProposals.agentId, agentId), eq(improvementProposals.status, 'open')),
        )
        .limit(limit),
    async insert(agentId, item) {
      const [row] = await db
        .insert(selfMaintenance)
        .values({ agentId, ...item })
        .onConflictDoNothing({
          target: [selfMaintenance.agentId, selfMaintenance.title],
        })
        .returning({ id: selfMaintenance.id });
      return Boolean(row);
    },
  };
}

// ── PR primitive (gated; inert without a GitHub token) ────────────────────────

/** Runs a `gh`/git command; injected so the flow is testable without a real repo. */
export type GhRunner = (args: string[]) => Promise<{ stdout: string; code: number }>;

export interface OpenSelfPrInput {
  itemId: string;
  branch: string;
  changedFiles: string[];
  prTitle: string;
  prBody: string;
}

/**
 * Open a self-maintenance PR — the ONLY sanctioned write to the bot's own repo,
 * and heavily fenced: rejects if any changed file is protected, if the token is
 * absent, or if a self-PR is already open (one at a time). It opens a PR against
 * the configured repo and labels it 'self-maintenance'; it never merges, never
 * pushes to a protected branch, and never triggers a deploy. Merge stays the
 * owner's. Returns the fence/gate outcome so refusals are explicit.
 */
export async function openSelfMaintenancePR(
  deps: { db: Db; gh?: GhRunner },
  agentId: string,
  input: OpenSelfPrInput,
): Promise<{ opened: boolean; reason?: string; prUrl?: string }> {
  const config = loadConfig();
  if (!config.GITHUB_TOKEN || !config.GITHUB_REPO) {
    return { opened: false, reason: 'GitHub token/repo not configured — PRs are disabled' };
  }
  if (input.changedFiles.length === 0) return { opened: false, reason: 'no changed files' };
  const { blocked } = partitionChangedFiles(input.changedFiles);
  if (blocked.length > 0) {
    return { opened: false, reason: `blocked by the fence: ${blocked.join(', ')}` };
  }
  if (/^(main|master)$/i.test(input.branch)) {
    return { opened: false, reason: 'refusing to target a protected branch' };
  }

  // One open self-PR at a time.
  const [existing] = await deps.db
    .select({ id: selfMaintenance.id })
    .from(selfMaintenance)
    .where(and(eq(selfMaintenance.agentId, agentId), eq(selfMaintenance.status, 'pr_open')))
    .limit(1);
  if (existing) return { opened: false, reason: 'a self-maintenance PR is already open' };

  const gh = deps.gh;
  if (!gh) return { opened: false, reason: 'no gh runner available' };
  // PR-only: create against the configured repo with the self-maintenance label.
  const res = await gh([
    'pr',
    'create',
    '--repo',
    config.GITHUB_REPO,
    '--base',
    'main',
    '--head',
    input.branch,
    '--title',
    input.prTitle,
    '--body',
    input.prBody,
    '--label',
    'self-maintenance',
  ]);
  if (res.code !== 0) return { opened: false, reason: `gh pr create failed: ${res.stdout}` };
  const prUrl = res.stdout.trim();
  await deps.db
    .update(selfMaintenance)
    .set({ status: 'pr_open', prUrl, updatedAt: sql`now()` })
    .where(eq(selfMaintenance.id, input.itemId));
  return { opened: true, prUrl };
}

// ── Dashboard helpers ─────────────────────────────────────────────────────────

export async function listSelfMaintenance(db: Db, agentId: string): Promise<SelfMaintenanceRow[]> {
  return db
    .select()
    .from(selfMaintenance)
    .where(and(eq(selfMaintenance.agentId, agentId), ne(selfMaintenance.status, 'dismissed')))
    .orderBy(desc(selfMaintenance.createdAt))
    .limit(100);
}

export async function dismissSelfMaintenance(db: Db, id: string): Promise<void> {
  await db
    .update(selfMaintenance)
    .set({ status: 'dismissed', updatedAt: sql`now()` })
    .where(eq(selfMaintenance.id, id));
}
