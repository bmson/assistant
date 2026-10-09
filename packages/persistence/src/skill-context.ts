import { type EmbeddingSpace, validateEmbeddingSpace } from './embedding.js';
import type { Records } from './records.js';

/** PostgreSQL's learned-skill vector column is physically fixed at 1536 dimensions. */
export const SKILL_EMBEDDING_DIMENSIONS = 1536;
export const DEFAULT_SKILL_RECALL_LIMIT = 4;
export const MAX_SKILL_RECALL_LIMIT = 100;
export const MIN_SKILL_RECALL_SIMILARITY = 0.72;

/** Canonical procedure text used by both SQL and Firestore skill vectors. */
export function skillEmbeddingText(skill: {
  name: string;
  preconditions: string;
  steps: string;
  gotchas: string;
}): string {
  return [
    skill.name,
    skill.preconditions && `When: ${skill.preconditions}`,
    skill.steps && `Steps: ${skill.steps}`,
    skill.gotchas && `Gotchas: ${skill.gotchas}`,
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);
}

export type LearnedSkill = Omit<Records['skills'], 'embedding'>;

export interface SkillContextMatch {
  skill: LearnedSkill;
  similarity: number;
}

export interface SkillRecallInput {
  agentId: string;
  embedding: number[];
  embeddingSpaceKey: string;
  limit?: number;
  minSimilarity?: number;
}

export interface SkillUseInput {
  agentId: string;
  ids: string[];
}

export interface SkillOutcomeInput {
  agentId: string;
  id: string;
  success: boolean;
}

/** Atomic learned-skill operations needed on the normal executor chat path. */
export interface SkillContextRepository {
  readonly kind: 'skill-context-repository';
  recall(input: SkillRecallInput): Promise<SkillContextMatch[]>;
  bumpUse(input: SkillUseInput): Promise<void>;
  recordOutcome(input: SkillOutcomeInput): Promise<void>;
}

export function skillRecallBounds(input: Pick<SkillRecallInput, 'limit' | 'minSimilarity'>): {
  limit: number;
  minSimilarity: number;
} {
  const limit = input.limit ?? DEFAULT_SKILL_RECALL_LIMIT;
  const minSimilarity = input.minSimilarity ?? MIN_SKILL_RECALL_SIMILARITY;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SKILL_RECALL_LIMIT)
    throw new Error('Invalid skill recall limit');
  if (!Number.isFinite(minSimilarity) || minSimilarity < -1 || minSimilarity > 1)
    throw new Error('Invalid skill similarity threshold');
  return { limit, minSimilarity };
}

export function validateSkillEmbedding(
  embedding: number[],
  dimensions = SKILL_EMBEDDING_DIMENSIONS,
): void {
  if (
    !Number.isInteger(dimensions) ||
    dimensions < 1 ||
    dimensions > 2048 ||
    !Array.isArray(embedding) ||
    embedding.length !== dimensions ||
    !Array.from(embedding).every(Number.isFinite) ||
    !embedding.some((value) => value !== 0)
  )
    throw new Error('Invalid learned-skill embedding');
}

/** Firestore learned-skill vectors follow any valid configured space width. */
export function validateSkillEmbeddingSpace(space: EmbeddingSpace): void {
  try {
    validateEmbeddingSpace(space);
  } catch {
    throw new Error('Invalid learned-skill embedding space');
  }
}
