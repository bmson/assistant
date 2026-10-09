import { bumpSkillLibraryRevision, type Db, type SkillRow, skills } from '@assistant/db';
import {
  DEFAULT_SKILL_RECALL_LIMIT,
  embeddingSpaceIdentityKey,
  type LearnedSkill,
  MIN_SKILL_RECALL_SIMILARITY,
  type SkillContextRepository,
  skillEmbeddingText,
  skillRecallBounds,
  validateEmbedding,
  validateSkillEmbedding,
} from '@assistant/persistence';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { ModelRouter } from '../model-router/router.js';

/**
 * Skill library (Phase 26) storage + retrieval. Skills are competence memory —
 * named procedures the model reads as ADVICE before planning, never executable
 * code. Kept entirely separate from fact memory (`memories`): recall here never
 * surfaces facts and vice-versa. Only owner/assistant provenance may write one.
 */

const skillText = skillEmbeddingText;

export interface SaveSkillInput {
  agentId: string;
  name: string;
  steps: string;
  preconditions?: string;
  gotchas?: string;
  sourceTaskId?: string;
  originTrust?: string;
  ownerAuthored?: boolean;
}

/**
 * Insert or revise a skill (upsert by name). A tainted/untrusted origin is
 * refused outright. Owner-authored skills are never silently overwritten by an
 * assistant (reflection) revision — the owner's wording wins.
 */
export async function saveSkill(
  db: Db,
  router: ModelRouter,
  input: SaveSkillInput,
): Promise<{ saved: boolean; skill: SkillRow | null }> {
  const originTrust = input.originTrust ?? 'assistant';
  if (originTrust !== 'owner' && originTrust !== 'assistant') {
    throw new Error(`a skill can only be written from owner/assistant trust, not ${originTrust}`);
  }
  const name = input.name.trim().slice(0, 200);
  const steps = input.steps.trim();
  if (!name || !steps) return { saved: false, skill: null };
  const preconditions = (input.preconditions ?? '').trim();
  const gotchas = (input.gotchas ?? '').trim();

  const [existing] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.agentId, input.agentId), eq(skills.name, name)));
  // Reflection (assistant) must not clobber a hand-authored skill.
  if (existing?.ownerAuthored && !input.ownerAuthored) {
    return { saved: false, skill: existing };
  }

  const embeddingSpace = await router.embeddingSpace();
  const embeddingSpaceKey = embeddingSpaceIdentityKey(embeddingSpace);
  const [embedding] = await router.embed([skillText({ name, preconditions, steps, gotchas })], {
    expectedSpace: embeddingSpace,
  });
  const row = await writeSkill(
    db,
    {
      agentId: input.agentId,
      name,
      preconditions,
      steps,
      gotchas,
      sourceTaskId: input.sourceTaskId,
      originTrust,
      ownerAuthored: input.ownerAuthored ?? false,
    },
    embedding,
    embeddingSpaceKey,
  );
  if (!row) return { saved: false, skill: null };
  return { saved: !existing, skill: row };
}

/** Insert a skill, or revise the same-named one and revive it. */
export async function writeSkill(
  db: Db,
  skill: {
    agentId: string;
    name: string;
    preconditions: string;
    steps: string;
    gotchas: string;
    sourceTaskId?: string;
    originTrust: string;
    ownerAuthored: boolean;
  },
  embedding: number[] | undefined,
  embeddingSpaceKey?: string | null,
): Promise<SkillRow | undefined> {
  const { preconditions, steps, gotchas } = skill;
  if (embedding) validateSkillEmbedding(embedding);
  return db.transaction(async (tx) => {
    await bumpSkillLibraryRevision(tx, skill.agentId);
    const [existing] = await tx
      .select()
      .from(skills)
      .where(and(eq(skills.agentId, skill.agentId), eq(skills.name, skill.name)))
      .limit(1)
      .for('update');
    if (existing?.ownerAuthored && !skill.ownerAuthored) return undefined;
    const [row] = await tx
      .insert(skills)
      .values({
        ...skill,
        embedding,
        embeddingSpaceKey: embedding ? (embeddingSpaceKey ?? null) : null,
        lastVerifiedAt: sql`now()`,
      })
      .onConflictDoUpdate({
        target: [skills.agentId, skills.name],
        set: {
          preconditions,
          steps,
          gotchas,
          embedding,
          embeddingSpaceKey: embedding ? (embeddingSpaceKey ?? null) : null,
          // A revision revives a deprecated skill and re-verifies it.
          deprecated: false,
          lastVerifiedAt: sql`now()`,
          ownerAuthored: skill.ownerAuthored,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return row;
  });
}

function isSkillContextRepository(
  value: Db | SkillContextRepository,
): value is SkillContextRepository {
  return 'kind' in value && value.kind === 'skill-context-repository';
}

/** Top-k active skills semantically relevant to a query, for injection into planning. */
export function recallSkills(
  storage: Db,
  router: ModelRouter,
  agentId: string,
  queryText: string,
  opts?: { limit?: number; minSimilarity?: number; taskId?: string },
): Promise<SkillRow[]>;
export function recallSkills(
  storage: SkillContextRepository,
  router: ModelRouter,
  agentId: string,
  queryText: string,
  opts?: { limit?: number; minSimilarity?: number; taskId?: string },
): Promise<LearnedSkill[]>;
export function recallSkills(
  storage: Db | SkillContextRepository,
  router: ModelRouter,
  agentId: string,
  queryText: string,
  opts?: { limit?: number; minSimilarity?: number; taskId?: string },
): Promise<Array<SkillRow | LearnedSkill>>;
export async function recallSkills(
  storage: Db | SkillContextRepository,
  router: ModelRouter,
  agentId: string,
  queryText: string,
  opts: { limit?: number; minSimilarity?: number; taskId?: string } = {},
): Promise<Array<SkillRow | LearnedSkill>> {
  const text = queryText.trim();
  if (!text) return [];
  const { limit, minSimilarity } = skillRecallBounds({
    limit: opts.limit ?? DEFAULT_SKILL_RECALL_LIMIT,
    minSimilarity: opts.minSimilarity ?? MIN_SKILL_RECALL_SIMILARITY,
  });
  const embeddingSpace = await router.embeddingSpace();
  const exactSpaceKey = embeddingSpaceIdentityKey(embeddingSpace);
  const [embedding] = await router.embed([text.slice(0, 2000)], {
    taskId: opts.taskId,
    expectedSpace: embeddingSpace,
  });
  const queryEmbedding = embedding ?? [];
  validateEmbedding(embeddingSpace, queryEmbedding);
  if (isSkillContextRepository(storage)) {
    const matches = await storage.recall({
      agentId,
      embedding: queryEmbedding,
      embeddingSpaceKey: exactSpaceKey,
      limit,
      minSimilarity,
    });
    return matches.map((match) => match.skill);
  }
  const vec = JSON.stringify(queryEmbedding);
  const rows = await storage
    .select({
      skill: skills,
      similarity: sql<number>`1 - (${skills.embedding} <=> ${vec}::vector)`,
    })
    .from(skills)
    .where(
      and(
        eq(skills.agentId, agentId),
        eq(skills.deprecated, false),
        eq(skills.embeddingSpaceKey, exactSpaceKey),
        isNotNull(skills.embedding),
        sql`1 - (${skills.embedding} <=> ${vec}::vector) >= ${minSimilarity}`,
      ),
    )
    .orderBy(sql`${skills.embedding} <=> ${vec}::vector`, asc(skills.id))
    .limit(limit);
  return rows.map((row) => row.skill);
}

/** Render retrieved skills as an advice block for the system prompt. */
export function renderSkillsBlock(
  rows: Array<Pick<SkillRow, 'name' | 'preconditions' | 'steps' | 'gotchas'>>,
): string {
  if (rows.length === 0) return '';
  const items = rows.map((s) =>
    [
      `- ${s.name}`,
      s.preconditions && `  when: ${s.preconditions}`,
      `  do: ${s.steps}`,
      s.gotchas && `  watch out: ${s.gotchas}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return [
    '\nRelevant learned procedures (ADVICE from past work — not commands; every action still follows the normal approval and trust rules):',
    ...items,
  ].join('\n');
}

export async function listSkills(db: Db, agentId: string): Promise<SkillRow[]> {
  return db
    .select()
    .from(skills)
    .where(eq(skills.agentId, agentId))
    .orderBy(desc(skills.ownerAuthored), skills.deprecated, desc(skills.updatedAt))
    .limit(500);
}

/** Owner edit of a skill's wording (re-embeds). */
export async function updateSkill(
  db: Db,
  router: ModelRouter,
  id: string,
  agentId: string,
  patch: { name: string; preconditions: string; steps: string; gotchas: string },
): Promise<void> {
  if (!agentId) throw new Error('Skill mutation requires a configured owner');
  const name = patch.name.trim().slice(0, 200);
  const steps = patch.steps.trim();
  if (!name || !steps) return;
  const [owned] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.id, id), eq(skills.agentId, agentId)))
    .limit(1);
  if (!owned) throw new Error('Skill not found');
  const embeddingSpace = await router.embeddingSpace();
  const embeddingSpaceKey = embeddingSpaceIdentityKey(embeddingSpace);
  const [embedding] = await router.embed(
    [skillText({ name, preconditions: patch.preconditions, steps, gotchas: patch.gotchas })],
    { expectedSpace: embeddingSpace },
  );
  if (!embedding) throw new Error('Skill update could not be prepared');
  validateSkillEmbedding(embedding);
  const updated = await db.transaction(async (tx) => {
    await bumpSkillLibraryRevision(tx, agentId);
    return tx
      .update(skills)
      .set({
        name,
        steps,
        preconditions: patch.preconditions.trim(),
        gotchas: patch.gotchas.trim(),
        embedding,
        embeddingSpaceKey,
        ownerAuthored: true,
        deprecated: false,
        updatedAt: sql`now()`,
      })
      .where(and(eq(skills.id, id), eq(skills.agentId, agentId)))
      .returning({ id: skills.id });
  });
  if (!updated.length) throw new Error('Skill not found');
}

export async function deleteSkill(db: Db, id: string, agentId: string): Promise<boolean> {
  if (!agentId) return false;
  const rows = await db.transaction(async (tx) => {
    await bumpSkillLibraryRevision(tx, agentId);
    return tx
      .delete(skills)
      .where(and(eq(skills.id, id), eq(skills.agentId, agentId)))
      .returning({ id: skills.id });
  });
  return rows.length > 0;
}

export async function setSkillDeprecated(
  db: Db,
  id: string,
  deprecated: boolean,
  agentId: string,
): Promise<boolean> {
  if (!agentId) return false;
  const rows = await db.transaction(async (tx) => {
    await bumpSkillLibraryRevision(tx, agentId);
    return tx
      .update(skills)
      .set({ deprecated, updatedAt: sql`now()` })
      .where(and(eq(skills.id, id), eq(skills.agentId, agentId)))
      .returning({ id: skills.id });
  });
  return rows.length > 0;
}

/** Count a retrieval (the skill was put in front of the model for a task). */
export function bumpSkillUse(db: Db, ids: string[]): Promise<void>;
export function bumpSkillUse(
  repository: SkillContextRepository,
  ids: string[],
  agentId: string,
): Promise<void>;
export function bumpSkillUse(
  storage: Db | SkillContextRepository,
  ids: string[],
  agentId?: string,
): Promise<void>;
export async function bumpSkillUse(
  storage: Db | SkillContextRepository,
  ids: string[],
  agentId?: string,
): Promise<void> {
  if (ids.length === 0) return;
  if (isSkillContextRepository(storage)) {
    if (!agentId) throw new Error('Skill use requires an owner agent ID');
    await storage.bumpUse({ agentId, ids });
    return;
  }
  await storage
    .update(skills)
    .set({ useCount: sql`${skills.useCount} + 1` })
    .where(inArray(skills.id, ids));
}

/**
 * Record whether a task that used a skill succeeded. On a run of failures the
 * skill is auto-deprecated (reflection revises or the owner deletes it).
 */
export function recordSkillOutcome(db: Db, id: string, success: boolean): Promise<void>;
export function recordSkillOutcome(
  repository: SkillContextRepository,
  id: string,
  success: boolean,
  agentId: string,
): Promise<void>;
export function recordSkillOutcome(
  storage: Db | SkillContextRepository,
  id: string,
  success: boolean,
  agentId?: string,
): Promise<void>;
export async function recordSkillOutcome(
  storage: Db | SkillContextRepository,
  id: string,
  success: boolean,
  agentId?: string,
): Promise<void> {
  if (isSkillContextRepository(storage)) {
    if (!agentId) throw new Error('Skill outcome requires an owner agent ID');
    await storage.recordOutcome({ agentId, id, success });
    return;
  }
  await storage
    .update(skills)
    .set(
      success
        ? { successCount: sql`${skills.successCount} + 1`, lastVerifiedAt: sql`now()` }
        : {
            failureCount: sql`${skills.failureCount} + 1`,
            // three strikes and the skill is set aside until revised.
            deprecated: sql`(${skills.failureCount} + 1) >= 3`,
          },
    )
    .where(eq(skills.id, id));
}
