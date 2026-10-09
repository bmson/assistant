import { createHash } from 'node:crypto';
import {
  agents,
  type Db,
  type ImprovementProposalRow,
  improvementProposals,
  isTombstoned,
  knowledgeGraphSources,
  maintenanceCursors,
  memories,
  modelCalls,
  modelRoles,
  models,
  responseChecks,
  tasks,
  toolCalls,
} from '@assistant/db';
import {
  type CodeJobLease,
  type ExecutionPersistence,
  embeddingSpaceIdentityKey,
  type ImprovementActionResult,
  improvementModelChange,
  type SelfImprovementRepository,
  validateImprovementModels,
} from '@assistant/persistence';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { BudgetReservationError, nextDailyReset, nextMonthlyReset } from '../cost.js';
import { isUnparseableObjectError, type ModelRouter } from '../model-router/router.js';
import { withSpan } from '../otel.js';
import { notifyOwnerInNotifications } from './anomaly.js';

/**
 * Self-improvement loop (Phase 12). A nightly eval mines the recent failure,
 * retry, dead-letter, and cost-outlier signals from `tool_calls`/`tasks`/
 * `model_calls`, records the pattern as an `experience` memory, and drafts
 * concrete change proposals. Proposals are NEVER auto-applied — the owner
 * approves a validated model-role change or acknowledges advisory policy,
 * prompt and note suggestions. No code is changed by this review.
 */

const WINDOW_DAYS = 7;
const MIN_FAILURES = 2;
const COST_OUTLIER_USD = 0.1;
/** Fresh graph work is expected; a ten-minute checkpoint is a health signal. */
const GRAPH_STALE_PENDING_MS = 10 * 60 * 1000;

/** Collapse a tool error to a stable signature so repeats group together. */
function errorSignature(error: string | null): string {
  return (error ?? 'unknown')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '<id>')
    .replace(/\d+/g, '#')
    .slice(0, 80)
    .trim();
}

const ProposalDraftSchema = z.object({
  kind: z.enum(['model_role', 'policy', 'prompt', 'note']),
  title: z.string().min(3).max(200),
  rationale: z.string().max(1000).default(''),
  role: z.string().max(20).default('').describe('For model_role: which role to change.'),
  primaryModel: z.string().max(120).default(''),
  fallbackModel: z.string().max(120).default(''),
  toolName: z.string().max(120).default('').describe('For policy: the tool.'),
  suggestion: z.string().max(1000).default('').describe('For prompt/note: the advice.'),
});
const ProposalsOutputSchema = z.object({
  proposals: z.array(ProposalDraftSchema).max(3),
});

const IMPROVE_SYSTEM = [
  "You review the assistant's recent reliability, response-quality, and memory-retrieval health signals and propose AT MOST 3 concrete, conservative improvements.",
  'Kinds: "model_role" (swap a role\'s model — only if a role clearly and repeatedly underperforms; give role + primaryModel), "policy" (a targeted approval rule — rare), "prompt" (advise a wording change — advisory), "note" (a general observation — advisory).',
  'Prefer "note"/"prompt" unless a config change is clearly warranted by the evidence. Each proposal needs a short title and a rationale citing the pattern. If nothing is actionable, return an empty proposals array.',
].join('\n');

export interface SelfImproveResult {
  patterns: number;
  proposalsDrafted: number;
  experienceSaved: boolean;
}

/** The review's PostgreSQL reads and proposal ledger, with the queries it has always run. */
function postgresSelfImprovement(db: Db): SelfImprovementRepository {
  return {
    kind: 'self-improvement-repository',
    async signals({ agentId, since, staleBefore, costOutlierUsd, outlierLimit }) {
      const failedCalls = await db
        .select({ toolName: toolCalls.toolName, error: toolCalls.error, taskId: toolCalls.taskId })
        .from(toolCalls)
        .innerJoin(tasks, eq(tasks.id, toolCalls.taskId))
        .where(
          and(
            eq(tasks.agentId, agentId),
            eq(toolCalls.status, 'failed'),
            gte(toolCalls.createdAt, since),
          ),
        );
      const [stuck] = await db
        .select({ n: sql<number>`count(*)` })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            inArray(tasks.status, ['needs_attention', 'failed']),
            gte(tasks.updatedAt, since),
            gte(tasks.attempt, 2),
          ),
        );
      const outliers = await db
        .select({ role: modelCalls.role, costUsd: modelCalls.costUsd })
        .from(modelCalls)
        .innerJoin(tasks, eq(tasks.id, modelCalls.taskId))
        .where(
          and(
            eq(tasks.agentId, agentId),
            gte(modelCalls.createdAt, since),
            gte(modelCalls.costUsd, String(costOutlierUsd)),
          ),
        )
        .orderBy(desc(modelCalls.costUsd))
        .limit(outlierLimit);
      // The finalization funnel already persists these counters, but a stored
      // metric is only useful if the improvement loop sees it.
      const [quality] = await db
        .select({
          contractBlocks: sql<number>`count(*) FILTER (WHERE ${responseChecks.blocked})`,
          unsupportedClaims: sql<number>`COALESCE(sum(${responseChecks.unsupportedCount}), 0)`,
          mustActRetries: sql<number>`COALESCE(sum(${responseChecks.mustActRetries}), 0)`,
          degradedSteps: sql<number>`COALESCE(sum(${responseChecks.degradedSteps}), 0)`,
          verificationUnavailable: sql<number>`count(*) FILTER (WHERE ${responseChecks.outputVerificationUnavailable})`,
        })
        .from(responseChecks)
        .innerJoin(tasks, eq(tasks.id, responseChecks.taskId))
        .where(and(eq(tasks.agentId, agentId), gte(responseChecks.createdAt, since)));
      const graphStatusRows = await db
        .select({ status: knowledgeGraphSources.status, count: sql<number>`count(*)` })
        .from(knowledgeGraphSources)
        .innerJoin(memories, eq(memories.id, knowledgeGraphSources.memoryId))
        .where(eq(memories.agentId, agentId))
        .groupBy(knowledgeGraphSources.status);
      const graphCounts = new Map(graphStatusRows.map((row) => [row.status, Number(row.count)]));
      const [staleGraph] = await db
        .select({ count: sql<number>`count(*)` })
        .from(knowledgeGraphSources)
        .innerJoin(memories, eq(memories.id, knowledgeGraphSources.memoryId))
        .where(
          and(
            eq(memories.agentId, agentId),
            eq(knowledgeGraphSources.status, 'pending'),
            lt(knowledgeGraphSources.updatedAt, staleBefore),
          ),
        );
      return {
        failedCalls,
        stuckCount: Number(stuck?.n ?? 0),
        costOutliers: outliers,
        contractBlocks: Number(quality?.contractBlocks ?? 0),
        unsupportedClaims: Number(quality?.unsupportedClaims ?? 0),
        mustActRetries: Number(quality?.mustActRetries ?? 0),
        degradedSteps: Number(quality?.degradedSteps ?? 0),
        verificationUnavailable: Number(quality?.verificationUnavailable ?? 0),
        graphFailedSources: graphCounts.get('failed') ?? 0,
        graphStalePending: Number(staleGraph?.count ?? 0),
      };
    },
    async insertProposal(agentId, proposal) {
      const [inserted] = await db
        .insert(improvementProposals)
        .values({ agentId, ...proposal })
        .onConflictDoNothing({
          target: [
            improvementProposals.agentId,
            improvementProposals.kind,
            improvementProposals.title,
          ],
        })
        .returning({ id: improvementProposals.id });
      return Boolean(inserted);
    },
  };
}

/** Nightly self-improvement scan for one selected agent. */
export async function runSelfImprove(
  deps: {
    db: Db;
    router: ModelRouter;
    heartbeat?: () => Promise<void>;
    /**
     * The portable signals, proposal ledger and experience writer; without them
     * the review uses PostgreSQL. The experience memory needs the task lease.
     */
    persistence?: Pick<
      ExecutionPersistence,
      'selfImprovement' | 'memoryExtraction' | 'notifications' | 'messages'
    >;
  },
  opts: { agentId?: string; taskId?: string; now?: Date; lease?: () => CodeJobLease } = {},
): Promise<SelfImproveResult> {
  const { db, router } = deps;
  const portable = deps.persistence?.selfImprovement ? deps.persistence : null;
  const store = portable?.selfImprovement ?? postgresSelfImprovement(db);
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 3600 * 1000);

  return withSpan('self.improve', {}, async () => {
    await deps.heartbeat?.();
    const [fallbackAgent] =
      opts.agentId || portable ? [] : await db.select({ id: agents.id }).from(agents).limit(1);
    const agentId = opts.agentId ?? fallbackAgent?.id;
    if (!agentId) return { patterns: 0, proposalsDrafted: 0, experienceSaved: false };

    const signals = await store.signals({
      agentId,
      since,
      staleBefore: new Date(now.getTime() - GRAPH_STALE_PENDING_MS),
      costOutlierUsd: COST_OUTLIER_USD,
      outlierLimit: 5,
    });

    // 1. Failure patterns by tool + error signature.
    const failedCalls = signals.failedCalls;
    const failureCounts = new Map<string, { toolName: string; sig: string; count: number }>();
    for (const c of failedCalls) {
      const sig = errorSignature(c.error);
      const key = `${c.toolName}|${sig}`;
      const entry = failureCounts.get(key) ?? { toolName: c.toolName, sig, count: 0 };
      entry.count += 1;
      failureCounts.set(key, entry);
    }
    const topFailures = [...failureCounts.values()]
      .filter((f) => f.count >= MIN_FAILURES)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    // 2. Dead-lettered / needs-attention tasks.
    const stuckCount = signals.stuckCount;

    // 3. Cost outliers.
    const outliers = signals.costOutliers;

    // 4. Response quality. The finalization funnel already persists these
    // counters, but a stored metric is only useful if the improvement loop
    // sees it. Aggregate recurring symptoms rather than reacting to one
    // conservative contract correction.
    const {
      contractBlocks,
      unsupportedClaims,
      mustActRetries,
      degradedSteps,
      verificationUnavailable,
    } = signals;
    const responseSignals = [
      contractBlocks >= MIN_FAILURES
        ? `- response contract corrected ${contractBlocks} response(s) with ${unsupportedClaims} unsupported claim(s)`
        : '',
      mustActRetries >= MIN_FAILURES
        ? `- model loop retried ${mustActRetries} required action step(s) without a tool call`
        : '',
      degradedSteps >= MIN_FAILURES ? `- ${degradedSteps} step(s) used fallback models` : '',
      verificationUnavailable >= MIN_FAILURES
        ? `- output verification was unavailable for ${verificationUnavailable} final response(s)`
        : '',
    ].filter(Boolean);

    // 5. GraphRAG is offline by design. That makes a failed extraction or a
    // lease that outlives its normal run easy to miss unless it joins the same
    // owner-visible health review as response regressions.
    const failedGraphSources = signals.graphFailedSources;
    const staleGraphPending = signals.graphStalePending;
    const graphSignals = [
      failedGraphSources >= MIN_FAILURES
        ? `- GraphRAG has ${failedGraphSources} failed source extraction(s)`
        : '',
      staleGraphPending > 0
        ? `- GraphRAG has ${staleGraphPending} source lease(s) pending for over 10 minutes`
        : '',
    ].filter(Boolean);

    if (
      topFailures.length === 0 &&
      stuckCount === 0 &&
      outliers.length === 0 &&
      responseSignals.length === 0 &&
      graphSignals.length === 0
    ) {
      return { patterns: 0, proposalsDrafted: 0, experienceSaved: false };
    }

    const summary = [
      'Recent reliability review (last 7 days):',
      ...topFailures.map((f) => `- ${f.toolName} failed ${f.count}× — "${f.sig}"`),
      stuckCount > 0 ? `- ${stuckCount} task(s) needed attention after retries` : '',
      ...outliers.map((o) => `- expensive ${o.role} call: $${Number(o.costUsd).toFixed(3)}`),
      ...responseSignals,
      ...graphSignals,
    ]
      .filter(Boolean)
      .join('\n');

    // Save the pattern as an experience memory (expires; competence, not fact).
    let experienceSaved = false;
    const content = `Self-improvement review: ${summary.slice(0, 500)}`.slice(0, 600);
    const contentHash = createHash('sha256').update(content).digest('hex');
    const experienceExpiry = new Date(now.getTime() + 90 * 24 * 3600 * 1000);
    if (portable) {
      const extraction = portable.memoryExtraction;
      if (!extraction || !opts.lease)
        throw new Error('Portable self-improvement needs memory extraction and the task lease');
      const space = await router.embeddingSpace();
      const embeddingSpaceKey = embeddingSpaceIdentityKey(space);
      const [embedding] = await router.embed([content], {
        taskId: opts.taskId,
        expectedSpace: space,
      });
      await deps.heartbeat?.();
      if (embedding) {
        // One checkpoint per review task: a reclaimed run never re-saves it.
        const applied = await extraction.applyMemories({
          agentId,
          lease: opts.lease(),
          checkpointKey: 'self-improve.experience',
          originTrust: 'assistant',
          quarantined: false,
          facts: [
            {
              content,
              contentHash,
              embedding,
              embeddingSpaceKey,
              category: 'experience',
              kind: 'episode',
              importance: 2,
              confidence: '0.80',
              domain: null,
              validFrom: null,
              expiresAt: experienceExpiry,
              subject: '',
              relationship: '',
            },
          ],
          occasions: [],
          source: 'self-improve',
        });
        experienceSaved = (applied?.saved ?? 0) > 0;
      }
    } else if (!(await isTombstoned(db, contentHash))) {
      const space = await router.embeddingSpace();
      const embeddingSpaceKey = embeddingSpaceIdentityKey(space);
      const [embedding] = await router.embed([content], {
        taskId: opts.taskId,
        expectedSpace: space,
      });
      await deps.heartbeat?.();
      const [saved] = await db
        .insert(memories)
        .values({
          agentId,
          category: 'experience',
          kind: 'episode',
          content,
          contentHash,
          embedding,
          embeddingSpaceKey,
          importance: 2,
          confidence: '0.80',
          originTrust: 'assistant',
          source: 'self-improve',
          sourceTaskId: opts.taskId,
          expiresAt: experienceExpiry,
        })
        .onConflictDoNothing({ target: memories.contentHash })
        .returning({ id: memories.id });
      experienceSaved = Boolean(saved);
    }

    // Draft concrete proposals.
    const outcome = await router
      .object<z.infer<typeof ProposalsOutputSchema>>('batch', {
        taskId: opts.taskId,
        schema: ProposalsOutputSchema,
        system: IMPROVE_SYSTEM,
        prompt: summary,
      })
      .catch((err) => {
        if (!isUnparseableObjectError(err)) throw err;
        console.error('self-improve: could not structure proposals', err);
        return null;
      });
    await deps.heartbeat?.();
    if (outcome === null) {
      return { patterns: topFailures.length, proposalsDrafted: 0, experienceSaved };
    }
    if (!outcome.ok) {
      throw new BudgetReservationError(
        outcome.decision.reason,
        outcome.decision.reason.includes('monthly') ? nextMonthlyReset() : nextDailyReset(),
      );
    }

    const evidenceIds = [
      ...new Set(failedCalls.flatMap((call) => (call.taskId ? [call.taskId] : []))),
      ...topFailures.map((f) => `${f.toolName}:${f.sig}`),
      ...responseSignals.map((signal) => `response_checks:${signal.slice(2)}`),
      ...graphSignals.map((signal) => `knowledge_graph_sources:${signal.slice(2)}`),
    ].slice(0, 20);
    let proposalsDrafted = 0;
    for (const draft of outcome.object.proposals) {
      const change: Record<string, unknown> =
        draft.kind === 'model_role'
          ? {
              role: draft.role,
              primaryModel: draft.primaryModel,
              fallbackModel: draft.fallbackModel,
            }
          : draft.kind === 'policy'
            ? { toolName: draft.toolName, suggestion: draft.suggestion }
            : { suggestion: draft.suggestion };
      const inserted = await store.insertProposal(agentId, {
        kind: draft.kind,
        title: draft.title.trim().slice(0, 200),
        rationale: draft.rationale,
        change,
        evidenceIds,
      });
      if (inserted) proposalsDrafted += 1;
    }

    if (proposalsDrafted > 0) {
      const text = `I drafted ${proposalsDrafted} improvement proposal${proposalsDrafted === 1 ? '' : 's'} from this week's reliability review. Review them on the [Improvements page](/improvements). No model settings or code were changed by this review.`;
      const notify = portable
        ? async () => {
            const conversationId = await portable.notifications.getOrCreate(agentId);
            await portable.messages.append({
              conversationId,
              ...(opts.taskId ? { taskId: opts.taskId } : {}),
              role: 'assistant',
              origin: 'assistant',
              parts: [{ type: 'text', text }],
              text,
            });
          }
        : () => notifyOwnerInNotifications(db, agentId, text, opts.taskId);
      await notify().catch((err) => console.error('self-improve: owner notify failed', err));
    }

    return {
      patterns:
        topFailures.length +
        Number(stuckCount > 0) +
        outliers.length +
        responseSignals.length +
        graphSignals.length,
      proposalsDrafted,
      experienceSaved,
    };
  });
}

// ── Dashboard operations ─────────────────────────────────────────────────────

export async function listOpenProposals(
  db: Db,
  agentId: string,
): Promise<ImprovementProposalRow[]> {
  return db
    .select()
    .from(improvementProposals)
    .where(and(eq(improvementProposals.agentId, agentId), eq(improvementProposals.status, 'open')))
    .orderBy(desc(improvementProposals.createdAt))
    .limit(100);
}

/** Both decisions serialize with owner erasure and with each other. */
async function decideProposal(
  db: Db,
  id: string,
  agentId: string,
  action: 'apply' | 'dismiss',
): Promise<ImprovementActionResult> {
  if (!agentId) throw new Error('Improvement owner is required');
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .for('update');
    if (!owner) throw new Error('Improvement owner was not found');
    const [erasure] = await tx
      .select({ name: maintenanceCursors.name })
      .from(maintenanceCursors)
      .where(eq(maintenanceCursors.name, `privacy-erasure-result:${agentId}`));
    if (erasure) throw new Error('Privacy erasure is in progress');
    const [proposal] = await tx
      .select()
      .from(improvementProposals)
      .where(and(eq(improvementProposals.id, id), eq(improvementProposals.agentId, agentId)))
      .for('update');
    if (!proposal) throw new Error('Owned improvement proposal was not found');
    if (proposal.status !== 'open')
      return {
        outcome: 'already_decided',
        enacted: false,
        detail: 'This proposal already has a recorded decision. No change was made.',
      };

    let result: ImprovementActionResult = {
      outcome: action === 'dismiss' ? 'dismissed' : 'acknowledged',
      enacted: false,
      detail:
        action === 'dismiss'
          ? 'Proposal dismissed.'
          : 'Suggestion noted. No settings or code were changed.',
    };
    if (action === 'apply' && proposal.kind === 'model_role') {
      const change = improvementModelChange(
        (proposal.change ?? {}) as Record<string, unknown>,
        proposal.evidenceIds,
      );
      const wanted = [
        ...new Set(
          [change.primaryModel, change.fallbackModel].filter((id): id is string => Boolean(id)),
        ),
      ];
      const modelRows = await tx
        .select()
        .from(models)
        .where(inArray(models.id, wanted))
        .for('share');
      validateImprovementModels(change, modelRows);
      const [role] = await tx
        .select()
        .from(modelRoles)
        .where(eq(modelRoles.role, change.role))
        .for('update');
      if (!role)
        throw new Error('Proposed model role is not configured. Review or dismiss this proposal.');
      const changed =
        (change.primaryModel && change.primaryModel !== role.primaryModel) ||
        (change.fallbackModel && change.fallbackModel !== role.fallbackModel);
      if (changed) {
        const { role: _role, ...patch } = change;
        await tx
          .update(modelRoles)
          .set({ ...patch, updatedAt: sql`now()` })
          .where(eq(modelRoles.role, change.role));
        result = {
          outcome: 'applied',
          enacted: true,
          detail: `Updated ${change.role} model routing. Future calls will use this configuration.`,
        };
      } else {
        result = {
          outcome: 'already_current',
          enacted: false,
          detail: `The ${change.role} role already uses the proposed models. No routing change was needed.`,
        };
      }
    }
    await tx
      .update(improvementProposals)
      .set({ status: action === 'dismiss' ? 'dismissed' : 'applied', updatedAt: sql`now()` })
      .where(
        and(
          eq(improvementProposals.id, id),
          eq(improvementProposals.agentId, agentId),
          eq(improvementProposals.status, 'open'),
        ),
      );
    return result;
  });
}

export function dismissProposal(
  db: Db,
  id: string,
  agentId: string,
): Promise<ImprovementActionResult> {
  return decideProposal(db, id, agentId, 'dismiss');
}

/** Apply routing atomically; advisory approval is an explicit acknowledgment. */
export function applyProposal(
  db: Db,
  id: string,
  agentId: string,
): Promise<ImprovementActionResult> {
  return decideProposal(db, id, agentId, 'apply');
}
