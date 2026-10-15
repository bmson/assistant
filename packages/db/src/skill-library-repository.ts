import type { SkillLibraryRepository, WorkspaceSkillRecord } from '@assistant/persistence';
import { asc, desc, eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { skills } from './schema.js';

const MAX_SKILL_LIBRARY_SIZE = 500;

/** Read the bounded saved-skill library without loading vectors or changing counters. */
export function createPostgresSkillLibraryRepository(db: Db): SkillLibraryRepository {
  return {
    kind: 'skill-library-repository',
    async list(agentId): Promise<WorkspaceSkillRecord[]> {
      if (!agentId) throw new Error('An agent is required to list learned skills');
      const rows = await db
        .select({
          id: skills.id,
          name: skills.name,
          preconditions: skills.preconditions,
          steps: skills.steps,
          gotchas: skills.gotchas,
          ownerAuthored: skills.ownerAuthored,
          deprecated: skills.deprecated,
          useCount: skills.useCount,
          successCount: skills.successCount,
          failureCount: skills.failureCount,
          updatedAt: skills.updatedAt,
        })
        .from(skills)
        .where(eq(skills.agentId, agentId))
        .orderBy(
          desc(skills.ownerAuthored),
          asc(skills.deprecated),
          desc(skills.updatedAt),
          asc(skills.id),
        )
        .limit(MAX_SKILL_LIBRARY_SIZE + 1);
      if (rows.length > MAX_SKILL_LIBRARY_SIZE)
        throw new Error('Learned-skill library exceeds the inventory limit');
      return rows;
    },
  };
}
