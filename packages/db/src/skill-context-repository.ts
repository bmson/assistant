import {
  type SkillContextRepository,
  skillRecallBounds,
  validateSkillEmbedding,
} from '@assistant/persistence';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { skills } from './schema.js';

export function createPostgresSkillContextRepository(db: Db): SkillContextRepository {
  return {
    kind: 'skill-context-repository',

    async recall(input) {
      validateSkillEmbedding(input.embedding);
      const { limit, minSimilarity } = skillRecallBounds(input);
      const vector = JSON.stringify(input.embedding);
      const rows = await db
        .select({
          skill: skills,
          similarity: sql<number>`1 - (${skills.embedding} <=> ${vector}::vector)`,
        })
        .from(skills)
        .where(
          and(
            eq(skills.agentId, input.agentId),
            eq(skills.embeddingSpaceKey, input.embeddingSpaceKey),
            eq(skills.deprecated, false),
            isNotNull(skills.embedding),
            sql`1 - (${skills.embedding} <=> ${vector}::vector) >= ${minSimilarity}`,
          ),
        )
        .orderBy(sql`${skills.embedding} <=> ${vector}::vector`, asc(skills.id))
        .limit(limit);

      return rows.map(({ skill, similarity }) => {
        const { embedding: _embedding, ...safe } = skill;
        return { skill: safe, similarity };
      });
    },

    async bumpUse(input) {
      const ids = [...new Set(input.ids)];
      if (ids.length === 0) return;
      await db
        .update(skills)
        .set({ useCount: sql`${skills.useCount} + 1` })
        .where(and(eq(skills.agentId, input.agentId), inArray(skills.id, ids)));
    },

    async recordOutcome(input) {
      await db
        .update(skills)
        .set(
          input.success
            ? { successCount: sql`${skills.successCount} + 1`, lastVerifiedAt: sql`now()` }
            : {
                failureCount: sql`${skills.failureCount} + 1`,
                deprecated: sql`(${skills.failureCount} + 1) >= 3`,
              },
        )
        .where(and(eq(skills.agentId, input.agentId), eq(skills.id, input.id)));
    },
  };
}
