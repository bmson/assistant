import {
  bumpSkillLibraryRevision,
  type Db,
  lockPostgresPrivacyObservationFence,
  postgresPrivacyObservationFence,
  readSkillLibraryRevision,
  skillLibraryRevisions,
  skills,
  tasks,
  toolCalls,
} from '@assistant/db';
import {
  type ExecutionPersistence,
  embeddingSpaceIdentityKey,
  type ReflectionTask,
  type SkillReflectionCommitResult,
  type SkillReflectionRepository,
  skillEmbeddingText,
} from '@assistant/persistence';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { BudgetReservationError, nextDailyReset, nextMonthlyReset } from '../cost.js';
import { isUnparseableObjectError, type ModelRouter } from '../model-router/router.js';
import { withSpan } from '../otel.js';

/**
 * Skill reflection (Phase 26): nightly, review recently completed tasks that did
 * real, multi-step tool work and decide whether any solved something non-obvious
 * worth distilling into a reusable procedure. A tainted task can NEVER produce a
 * skill — checked against both the trigger's provenance AND the persisted
 * `state.untrustedContext` (taint can be acquired mid-run).
 */

/**
 * A compact, redacted rendering of a tool call's arguments for the reflection
 * prompt. Keys always; values only when short and not secret-shaped. This is
 * what turns "gmail.search → succeeded" into something a procedure can be
 * learned from without copying message bodies into a skill.
 */
function sketchArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const SECRET_KEY = /token|secret|password|key|auth/i;
  return Object.entries(args as Record<string, unknown>)
    .slice(0, 6)
    .map(([key, value]) => {
      if (SECRET_KEY.test(key)) return `${key}: …`;
      if (typeof value === 'string' && value.length <= 60)
        return `${key}: ${JSON.stringify(value)}`;
      if (typeof value === 'number' || typeof value === 'boolean') return `${key}: ${value}`;
      return `${key}: …`;
    })
    .join(', ');
}

const WINDOW_HOURS = 26;
const MAX_TASKS = 8;
const MIN_SUCCEEDED_CALLS = 2;

const SkillDraftSchema = z.object({
  worthSkill: z
    .boolean()
    .describe('true ONLY if this task solved something non-obvious worth reusing as a procedure'),
  name: z.string().max(200).default(''),
  preconditions: z.string().max(500).default(''),
  steps: z.string().max(2000).default(''),
  gotchas: z.string().max(1000).default(''),
});

const REFLECT_SYSTEM = [
  'You review one task the assistant already completed and decide whether it taught a reusable PROCEDURE worth remembering (a Voyager-style skill).',
  'Say worthSkill=true ONLY when the successful path was non-obvious — a workaround, a specific sequence of tools, a constraint discovered, a gotcha avoided. Routine one-step tasks and ordinary replies are NOT skills.',
  'When worthSkill=true, draft: a short imperative name (e.g. "Booking flights"), when it applies (preconditions), the steps as plain-language ADVICE (not code), and any gotchas. Otherwise worthSkill=false and leave the fields empty.',
].join('\n');

/** Taint check inlined to avoid importing the executor (would cycle via jobs.ts). */
function taskIsTainted(task: Pick<ReflectionTask, 'trust' | 'trigger' | 'state'>): boolean {
  const state = (task.state ?? {}) as { untrustedContext?: unknown };
  if (state.untrustedContext === true) return true;
  if (task.trust === 'known' || task.trust === 'unknown') return true;
  const trigger = task.trigger as {
    source?: unknown;
    payload?: { quotesExternalContent?: unknown; taintedOrigin?: unknown };
  } | null;
  if (trigger?.payload?.taintedOrigin === true) return true;
  if (trigger?.source !== 'email') return false;
  return !(task.trust === 'owner' && trigger.payload?.quotesExternalContent === false);
}

function taskGoal(task: ReflectionTask): string {
  const payload = (task.trigger as { payload?: Record<string, unknown> } | null)?.payload ?? {};
  const instruction =
    (typeof payload.instruction === 'string' && payload.instruction) ||
    (typeof payload.text === 'string' && payload.text) ||
    '';
  const planReasoning = (task.plan as { reasoning?: unknown } | null)?.reasoning;
  return (
    instruction ||
    (typeof planReasoning === 'string' ? planReasoning : '') ||
    '(no explicit goal)'
  ).slice(0, 1000);
}

export interface SkillReflectionResult {
  tasksReviewed: number;
  skillsDrafted: number;
}

export async function runSkillReflection(
  deps: {
    db: Db;
    router: ModelRouter;
    heartbeat?: () => Promise<void>;
    /** The portable reflection store; without it the job reads and writes PostgreSQL. */
    persistence?: Pick<ExecutionPersistence, 'skillReflection'>;
  },
  opts: { taskId?: string; since?: Date } = {},
): Promise<SkillReflectionResult> {
  const { db, router } = deps;
  const store = deps.persistence?.skillReflection ?? postgresSkillReflection(db);
  const since = opts.since ?? new Date(Date.now() - WINDOW_HOURS * 3600 * 1000);

  return withSpan('skill.reflect', {}, async () => {
    const result: SkillReflectionResult = { tasksReviewed: 0, skillsDrafted: 0 };
    await deps.heartbeat?.();

    const candidates = await store.candidates(since, 40);
    if (candidates.length === 0) return result;

    // Skip tasks that already taught a skill (idempotent across nightly runs).
    const alreadyProcessed = new Set(await store.sourcedTaskIds(candidates.map((t) => t.id)));

    const eligible = candidates.filter((t) => !taskIsTainted(t) && !alreadyProcessed.has(t.id));

    for (const task of eligible) {
      if (result.tasksReviewed >= MAX_TASKS) break;
      await deps.heartbeat?.();

      // This generation is an optimistic snapshot of the entire skill library.
      // Any owner create/edit/rename/deprecate/delete while the model or embedder
      // is running makes this draft stale, including create-then-rename races.
      const expectedLibraryRevision = await store.libraryRevision(task.agentId);

      const calls = await store.toolCalls(task.id);
      const succeeded = calls.filter((c) => c.status === 'succeeded');
      if (succeeded.length < MIN_SUCCEEDED_CALLS) continue;
      result.tasksReviewed += 1;

      // A name-and-status list ("gmail.search → succeeded") gives the model
      // nothing to distill a procedure from. Include a redacted sketch of the
      // arguments (keys, and short values that are not obviously sensitive)
      // and the task's recorded outcome, which is what carries the "how".
      const transcript = [
        `Goal: ${taskGoal(task)}`,
        'Actions taken (in order):',
        ...calls.map(
          (c) =>
            `- ${c.toolName}(${sketchArgs(c.args)}) → ${c.status}${c.error ? ` (error: ${c.error.slice(0, 120)})` : ''}`,
        ),
        ...(task.progress ? ['', `Recorded outcome: ${task.progress.slice(0, 400)}`] : []),
      ].join('\n');

      const outcome = await router
        .object<z.infer<typeof SkillDraftSchema>>('batch', {
          taskId: task.id,
          schema: SkillDraftSchema,
          system: REFLECT_SYSTEM,
          prompt: transcript,
        })
        .catch((err) => {
          if (!isUnparseableObjectError(err)) throw err;
          console.error(`skill reflection: skipping unstructurable task ${task.id}`, err);
          return null;
        });
      await deps.heartbeat?.();
      if (outcome === null) continue;
      if (!outcome.ok) {
        throw new BudgetReservationError(
          outcome.decision.reason,
          outcome.decision.reason.includes('monthly') ? nextMonthlyReset() : nextDailyReset(),
        );
      }

      const draft = outcome.object;
      const name = draft.name.trim().slice(0, 200);
      const steps = draft.steps.trim();
      if (!draft.worthSkill || !name || !steps) {
        await store.commitReflection({
          agentId: task.agentId,
          taskId: task.id,
          expectedLibraryRevision,
        });
        continue;
      }
      const skill = {
        name,
        preconditions: draft.preconditions.trim(),
        steps,
        gotchas: draft.gotchas.trim(),
        sourceTaskId: task.id,
        // The task is owner/assistant-trust and passed the taint gate above.
        originTrust: task.trust === 'owner' ? ('owner' as const) : ('assistant' as const),
      };
      const embeddingSpace = await router.embeddingSpace();
      const embeddingSpaceKey = embeddingSpaceIdentityKey(embeddingSpace);
      const [embedding] = await router.embed([skillEmbeddingText(skill)], {
        expectedSpace: embeddingSpace,
      });
      if (!embedding) continue;
      const committed = await store.commitReflection({
        agentId: task.agentId,
        taskId: task.id,
        expectedLibraryRevision,
        skill,
        embedding,
        embeddingSpaceKey,
      });
      if (committed.status === 'created') result.skillsDrafted += 1;
    }

    return result;
  });
}

/** The reflection's PostgreSQL reads and upsert, with the queries it has always run. */
function postgresSkillReflection(db: Db): SkillReflectionRepository {
  return {
    kind: 'skill-reflection-repository',
    candidates: (since, limit) =>
      db
        .select({
          id: tasks.id,
          agentId: tasks.agentId,
          trust: tasks.trust,
          trigger: tasks.trigger,
          state: tasks.state,
          plan: tasks.plan,
          progress: tasks.progress,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.status, 'done'),
            inArray(tasks.trust, ['owner', 'assistant']),
            gte(tasks.createdAt, since),
          ),
        )
        .orderBy(desc(tasks.createdAt))
        .limit(limit),
    async sourcedTaskIds(taskIds) {
      if (taskIds.length === 0) return [];
      const [skillRows, taskRows] = await Promise.all([
        db
          .select({ sourceTaskId: skills.sourceTaskId })
          .from(skills)
          .where(inArray(skills.sourceTaskId, taskIds)),
        db
          .select({ id: tasks.id, state: tasks.state })
          .from(tasks)
          .where(inArray(tasks.id, taskIds)),
      ]);
      return [
        ...skillRows.map((row) => row.sourceTaskId).filter((id): id is string => Boolean(id)),
        ...taskRows
          .filter((row) => {
            const state = row.state as { skillReflectionReceipt?: unknown } | null;
            return Boolean(state?.skillReflectionReceipt);
          })
          .map((row) => row.id),
      ];
    },
    async libraryRevision(agentId) {
      const [library, privacy] = await Promise.all([
        readSkillLibraryRevision(db, agentId),
        postgresPrivacyObservationFence(db, agentId),
      ]);
      return JSON.stringify({ library, privacy });
    },
    toolCalls: (taskId) =>
      db
        .select({
          toolName: toolCalls.toolName,
          status: toolCalls.status,
          error: toolCalls.error,
          args: toolCalls.args,
        })
        .from(toolCalls)
        .where(eq(toolCalls.taskId, taskId))
        .orderBy(toolCalls.step),
    async commitReflection(input) {
      return db.transaction(async (tx): Promise<SkillReflectionCommitResult> => {
        const observedPrivacyFence = await lockPostgresPrivacyObservationFence(
          tx as unknown as Db,
          input.agentId,
        );
        let expectedFence: { library?: unknown; privacy?: unknown };
        try {
          expectedFence = JSON.parse(input.expectedLibraryRevision) as {
            library?: unknown;
            privacy?: unknown;
          };
        } catch {
          throw new Error('Skill reflection revision token is malformed');
        }
        if (expectedFence.privacy !== observedPrivacyFence) return { status: 'ineligible' };
        const [task] = await tx
          .select({
            id: tasks.id,
            agentId: tasks.agentId,
            status: tasks.status,
            trust: tasks.trust,
            trigger: tasks.trigger,
            state: tasks.state,
          })
          .from(tasks)
          .where(and(eq(tasks.id, input.taskId), eq(tasks.agentId, input.agentId)))
          .limit(1)
          .for('update');
        if (task?.status !== 'done' || taskIsTainted(task)) return { status: 'ineligible' };
        const state = (task.state ?? {}) as Record<string, unknown>;
        if (state.skillReflectionReceipt) return { status: 'already_processed' };

        await tx
          .insert(skillLibraryRevisions)
          .values({ agentId: input.agentId })
          .onConflictDoNothing({ target: skillLibraryRevisions.agentId });
        const [generation] = await tx
          .select({ revision: skillLibraryRevisions.revision })
          .from(skillLibraryRevisions)
          .where(eq(skillLibraryRevisions.agentId, input.agentId))
          .for('update');
        if (!generation) throw new Error('Skill library revision is unavailable');

        let status: SkillReflectionCommitResult['status'];
        let skillId: string | null = null;
        if (!input.skill) {
          status = 'no_skill';
        } else if (generation.revision.toString() !== expectedFence.library) {
          status = 'superseded';
        } else {
          const [existing] = await tx
            .select({ id: skills.id, ownerAuthored: skills.ownerAuthored })
            .from(skills)
            .where(and(eq(skills.agentId, input.agentId), eq(skills.name, input.skill.name)))
            .limit(1);
          if (existing?.ownerAuthored) {
            status = 'owner_authored';
            skillId = existing.id;
          } else if (existing) {
            const [updated] = await tx
              .update(skills)
              .set({
                preconditions: input.skill.preconditions,
                steps: input.skill.steps,
                gotchas: input.skill.gotchas,
                embedding: input.embedding,
                embeddingSpaceKey: input.embeddingSpaceKey ?? null,
                deprecated: false,
                lastVerifiedAt: sql`now()`,
                updatedAt: sql`now()`,
              })
              .where(
                and(
                  eq(skills.id, existing.id),
                  eq(skills.agentId, input.agentId),
                  eq(skills.ownerAuthored, false),
                ),
              )
              .returning({ id: skills.id });
            if (!updated) {
              status = 'superseded';
            } else {
              status = 'revised';
              skillId = updated.id;
              await bumpSkillLibraryRevision(tx, input.agentId);
            }
          } else {
            const [created] = await tx
              .insert(skills)
              .values({
                ...input.skill,
                agentId: input.agentId,
                embedding: input.embedding,
                embeddingSpaceKey: input.embeddingSpaceKey ?? null,
                ownerAuthored: false,
                lastVerifiedAt: sql`now()`,
              })
              .returning({ id: skills.id });
            status = 'created';
            skillId = created?.id ?? null;
            await bumpSkillLibraryRevision(tx, input.agentId);
          }
        }
        await tx
          .update(tasks)
          .set({
            state: {
              ...state,
              skillReflectionReceipt: {
                status,
                author: 'reflection',
                skillId,
                libraryRevision: generation.revision.toString(),
                recordedAt: new Date().toISOString(),
              },
            },
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(tasks.id, input.taskId),
              eq(tasks.agentId, input.agentId),
              eq(tasks.status, 'done'),
            ),
          );
        if ((status === 'created' || status === 'revised') && skillId) return { status, skillId };
        if (status === 'created' || status === 'revised')
          throw new Error('Committed skill reflection did not return a skill identity');
        return { status };
      });
    },
  };
}
