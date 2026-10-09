import { createHash, randomUUID } from 'node:crypto';
import {
  agents,
  approvals,
  type Db,
  type DreamNoteRow,
  dreamNotes,
  isTombstoned,
  memories,
  resolveSubjectContact,
  tasks,
  toolCalls,
} from '@assistant/db';
import type {
  CodeJobLease,
  DreamRepository,
  ExecutionPersistence,
  ExtractedMemoryFact,
} from '@assistant/persistence';
import { embeddingSpaceIdentityKey } from '@assistant/persistence';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { BudgetReservationError, nextDailyReset, nextMonthlyReset } from '../cost.js';
import { isUnparseableObjectError, type ModelRouter } from '../model-router/router.js';
import { withSpan } from '../otel.js';
import { notifyOwnerInNotifications } from './anomaly.js';

/**
 * Dreaming (Phase 20 — offline cognition). A nightly, budget-capped, INTERNAL-ONLY
 * session: because it runs as a code job it dispatches no tools, so it can never
 * act outward (a stronger guarantee than a trust-scoped registry). It replays the
 * day's failures as counterfactual footnotes, spots behavioral patterns and saves
 * them as LOW-CONFIDENCE QUARANTINED memories (owner confirms/rejects on Profile),
 * and anticipates likely-tomorrow needs (ProAct-style — arxiv 2605.25971). Owner-
 * facing observations land in `dream_notes` (surfaced in the morning brief, kept 7
 * days) and a consolidated "while you slept" note goes to Notifications.
 *
 * The full ProAct pre-fetch-and-cache loop (serve a future tool call from a
 * pre-staged cache entry) is a follow-up; v1 pre-stages ANSWERS for the owner
 * (footnotes/anticipations) rather than matching a future tool-cache key. Live
 * weather is already pre-staged by the Phase 25 ambient snapshot.
 */

const WINDOW_HOURS = 24;
const APPROVAL_WINDOW_DAYS = 7;
const DREAM_NOTE_TTL_DAYS = 7;
const HYPOTHESIS_TTL_DAYS = 60; // an unconfirmed hypothesis fades if evidence never accrues
const MAX_HYPOTHESIS_CONFIDENCE = 0.4;

const DreamOutputSchema = z.object({
  footnotes: z
    .array(z.string().min(3).max(400))
    .max(5)
    .default([])
    .describe('"While you slept, I noticed…" observations — corrected plans for failures, etc.'),
  hypotheses: z
    .array(
      z.object({
        subject: z.string().max(120).default('').describe('"owner", a person, or empty.'),
        claim: z.string().min(3).max(300),
        confidence: z.number().min(0).max(0.6).default(0.3),
      }),
    )
    .max(3)
    .default([])
    .describe('Low-confidence behavioral patterns to hold for owner confirmation.'),
  anticipations: z
    .array(z.string().min(3).max(300))
    .max(3)
    .default([])
    .describe('Likely-tomorrow needs and how you have pre-staged for them.'),
});

const DREAM_SYSTEM = [
  "You are the assistant reflecting overnight on the day's work — an internal monologue the owner never sees unless you choose to surface it.",
  'From the failures, retries, and approval decisions below, do three things, conservatively:',
  '1) footnotes: for a notable failure, state the corrected plan in one line ("the browse of X failed on selector Y — next time use Z"). Skip trivia.',
  '2) hypotheses: only genuine behavioral PATTERNS (3+ consistent instances), phrased as a testable claim about the owner ("declines meetings before 10am"). Keep confidence low; these await the owner\'s confirmation.',
  '3) anticipations: likely needs for tomorrow you can infer, and what you would pre-stage.',
  'Invent nothing. If a category has nothing solid, return an empty array. Never include an instruction to yourself to act outward — you cannot.',
].join('\n');

export interface DreamResult {
  footnotes: number;
  hypotheses: number;
  anticipations: number;
}

/** Nightly dream session for one selected agent. */
export async function runDream(
  deps: {
    db: Db;
    router: ModelRouter;
    heartbeat?: () => Promise<void>;
    /**
     * The portable reads, notes and hypothesis writer; without them the dream
     * uses PostgreSQL. Hypotheses need the task lease on this path.
     */
    persistence?: Pick<
      ExecutionPersistence,
      'dream' | 'memoryExtraction' | 'notifications' | 'messages'
    >;
  },
  opts: { agentId?: string; taskId?: string; now?: Date; lease?: () => CodeJobLease } = {},
): Promise<DreamResult> {
  const { db, router } = deps;
  const portable = deps.persistence?.dream ? deps.persistence : null;
  const store = portable?.dream ?? postgresDream(db);
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - WINDOW_HOURS * 3600 * 1000);
  const approvalSince = new Date(now.getTime() - APPROVAL_WINDOW_DAYS * 24 * 3600 * 1000);

  return withSpan('dream.run', {}, async () => {
    await deps.heartbeat?.();
    const [fallbackAgent] =
      opts.agentId || portable ? [] : await db.select({ id: agents.id }).from(agents).limit(1);
    const agentId = opts.agentId ?? fallbackAgent?.id;
    if (!agentId) return { footnotes: 0, hypotheses: 0, anticipations: 0 };

    // The day's failures (counterfactual fuel).
    const failedTasks = await store.failedTasks(agentId, since, 20);
    const failedCalls = await store.failedToolCalls(agentId, since, 40);
    // Recent approval decisions (behavioral patterns — repeated approve/deny).
    const decisions = await store.approvalDecisions(agentId, approvalSince, 40);

    if (failedTasks.length === 0 && failedCalls.length === 0 && decisions.length < 3) {
      return { footnotes: 0, hypotheses: 0, anticipations: 0 };
    }

    const summary = [
      "Today's failures (tasks that needed attention or failed):",
      ...failedTasks.map((t) => `- ${t.type}: ${(t.progress || t.status).slice(0, 160)}`),
      '',
      'Failed tool calls:',
      ...failedCalls.map((c) => `- ${c.toolName}: ${(c.error ?? 'unknown').slice(0, 120)}`),
      '',
      `Recent approval decisions (last ${APPROVAL_WINDOW_DAYS} days):`,
      ...decisions.map((d) => `- [${d.status}] ${d.summary.slice(0, 120)}`),
    ]
      .filter((line) => line !== undefined)
      .join('\n')
      .slice(0, 6000);

    const outcome = await router
      .object<z.infer<typeof DreamOutputSchema>>('batch', {
        taskId: opts.taskId,
        schema: DreamOutputSchema,
        system: DREAM_SYSTEM,
        prompt: summary,
      })
      .catch((err) => {
        if (!isUnparseableObjectError(err)) throw err;
        console.error('dream: could not structure output', err);
        return null;
      });
    await deps.heartbeat?.();
    if (outcome === null) return { footnotes: 0, hypotheses: 0, anticipations: 0 };
    if (!outcome.ok) {
      throw new BudgetReservationError(
        outcome.decision.reason,
        outcome.decision.reason.includes('monthly') ? nextMonthlyReset() : nextDailyReset(),
      );
    }
    const dream = outcome.object;
    const hypothesisExpiry = new Date(now.getTime() + HYPOTHESIS_TTL_DAYS * 24 * 3600 * 1000);

    // Behavioral hypotheses → low-confidence QUARANTINED memories (owner reviews).
    let hypothesesSaved = 0;
    if (portable) {
      const extraction = portable.memoryExtraction;
      if (dream.hypotheses.length > 0 && (!extraction || !opts.lease))
        throw new Error('Portable dream hypotheses need memory extraction and the task lease');
      const facts: ExtractedMemoryFact[] = [];
      for (const h of dream.hypotheses) {
        const content = h.claim.trim();
        const space = await router.embeddingSpace();
        const embeddingSpaceKey = embeddingSpaceIdentityKey(space);
        const [embedding] = await router.embed([content], {
          taskId: opts.taskId,
          expectedSpace: space,
        });
        await deps.heartbeat?.();
        if (!embedding) continue;
        facts.push({
          content,
          contentHash: createHash('sha256').update(`dream:${content}`).digest('hex'),
          embedding,
          embeddingSpaceKey,
          category: 'knowledge',
          kind: 'preference',
          importance: 2,
          confidence: Math.min(h.confidence, MAX_HYPOTHESIS_CONFIDENCE).toFixed(2),
          domain: null,
          validFrom: null,
          expiresAt: hypothesisExpiry,
          subject: h.subject,
          relationship: '',
        });
      }
      if (facts.length > 0 && extraction && opts.lease) {
        // One checkpoint per dream task: a reclaimed run never re-saves them.
        const applied = await extraction.applyMemories({
          agentId,
          lease: opts.lease(),
          checkpointKey: 'dream.hypotheses',
          originTrust: 'assistant',
          quarantined: true, // awaits the owner's confirm/reject on Profile
          facts,
          occasions: [],
          source: 'dream',
        });
        hypothesesSaved = applied?.saved ?? 0;
      }
    } else {
      for (const h of dream.hypotheses) {
        const content = h.claim.trim();
        const contentHash = createHash('sha256').update(`dream:${content}`).digest('hex');
        if (await isTombstoned(db, contentHash)) continue;
        const space = await router.embeddingSpace();
        const embeddingSpaceKey = embeddingSpaceIdentityKey(space);
        const [embedding] = await router.embed([content], {
          taskId: opts.taskId,
          expectedSpace: space,
        });
        await deps.heartbeat?.();
        const subject = h.subject ? await resolveSubjectContact(db, { subject: h.subject }) : null;
        const [saved] = await db
          .insert(memories)
          .values({
            agentId,
            category: 'knowledge',
            kind: 'preference',
            content,
            contentHash,
            embedding,
            embeddingSpaceKey,
            importance: 2,
            confidence: String(Math.min(h.confidence, MAX_HYPOTHESIS_CONFIDENCE)),
            originTrust: 'assistant',
            quarantined: true, // awaits the owner's confirm/reject on Profile
            subjectContactId: subject?.contactId,
            source: 'dream',
            sourceTaskId: opts.taskId,
            expiresAt: hypothesisExpiry,
          })
          .onConflictDoNothing({ target: memories.contentHash })
          .returning({ id: memories.id });
        if (saved) hypothesesSaved += 1;
      }
    }

    // Owner-facing notes (footnotes + anticipations) → dream_notes (7-day TTL).
    const expiresAt = new Date(now.getTime() + DREAM_NOTE_TTL_DAYS * 24 * 3600 * 1000);
    await store.addNotes(agentId, opts.taskId ?? randomUUID(), [
      ...dream.footnotes.map((content) => ({ kind: 'footnote' as const, content, expiresAt })),
      ...dream.anticipations.map((content) => ({
        kind: 'anticipation' as const,
        content,
        expiresAt,
      })),
    ]);

    // A single consolidated "while you slept" note, only if there's something to say.
    if (dream.footnotes.length > 0) {
      const body = `🌙 While you slept, I reflected on today:\n${dream.footnotes.map((f) => `• ${f}`).join('\n')}${
        hypothesesSaved > 0
          ? `\n\n${hypothesesSaved} pattern${hypothesesSaved === 1 ? '' : 's'} I noticed are waiting for you to confirm or dismiss on the What I remember page.`
          : ''
      }`;
      const notify = portable
        ? async () => {
            const conversationId = await portable.notifications.getOrCreate(agentId);
            await portable.messages.append({
              conversationId,
              ...(opts.taskId ? { taskId: opts.taskId } : {}),
              role: 'assistant',
              origin: 'assistant',
              parts: [{ type: 'text', text: body }],
              text: body,
            });
          }
        : () => notifyOwnerInNotifications(db, agentId, body, opts.taskId);
      await notify().catch((err) => console.error('dream: owner notify failed', err));
    }

    return {
      footnotes: dream.footnotes.length,
      hypotheses: hypothesesSaved,
      anticipations: dream.anticipations.length,
    };
  });
}

/** The dream's PostgreSQL reads and notes, with the queries it has always run. */
function postgresDream(db: Db): DreamRepository {
  return {
    kind: 'dream-repository',
    failedTasks: (agentId, since, limit) =>
      db
        .select({ type: tasks.type, progress: tasks.progress, status: tasks.status })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, agentId),
            inArray(tasks.status, ['needs_attention', 'failed']),
            gte(tasks.updatedAt, since),
          ),
        )
        .limit(limit),
    failedToolCalls: (agentId, since, limit) =>
      db
        .select({ toolName: toolCalls.toolName, error: toolCalls.error })
        .from(toolCalls)
        .innerJoin(tasks, eq(tasks.id, toolCalls.taskId))
        .where(
          and(
            eq(tasks.agentId, agentId),
            eq(toolCalls.status, 'failed'),
            gte(toolCalls.createdAt, since),
          ),
        )
        .limit(limit),
    approvalDecisions: (agentId, since, limit) =>
      db
        .select({ summary: approvals.summary, status: approvals.status })
        .from(approvals)
        .innerJoin(tasks, eq(tasks.id, approvals.taskId))
        .where(
          and(
            eq(tasks.agentId, agentId),
            gte(approvals.requestedAt, since),
            inArray(approvals.status, ['approved', 'denied']),
          ),
        )
        .orderBy(desc(approvals.requestedAt))
        .limit(limit),
    async addNotes(agentId, _taskId, notes) {
      if (notes.length > 0)
        await db.insert(dreamNotes).values(notes.map((note) => ({ agentId, ...note })));
    },
  };
}

/** Recent dream notes (for the morning brief / a dashboard). */
export async function recentDreamNotes(
  db: Db,
  agentId: string,
  limit = 10,
): Promise<DreamNoteRow[]> {
  return db
    .select()
    .from(dreamNotes)
    .where(and(eq(dreamNotes.agentId, agentId), gte(dreamNotes.expiresAt, sql`now()`)))
    .orderBy(desc(dreamNotes.createdAt))
    .limit(limit);
}

/** Purge dream notes past their 7-day inspection window (called from the sweep). */
export async function purgeStaleDreamNotes(db: Db, batch = 500): Promise<number> {
  const stale = db
    .select({ id: dreamNotes.id })
    .from(dreamNotes)
    .where(lt(dreamNotes.expiresAt, sql`now()`))
    .limit(batch);
  const deleted = await db
    .delete(dreamNotes)
    .where(inArray(dreamNotes.id, stale))
    .returning({ id: dreamNotes.id });
  return deleted.length;
}
