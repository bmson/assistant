import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { skillLibraryRevisions } from './schema.js';

type RevisionWriter = Pick<Db, 'insert' | 'update' | 'select'>;

/** Read an opaque, exact generation before starting model/embedding work. */
export async function readSkillLibraryRevision(db: Db, agentId: string): Promise<string> {
  await db
    .insert(skillLibraryRevisions)
    .values({ agentId })
    .onConflictDoNothing({ target: skillLibraryRevisions.agentId });
  const [row] = await db
    .select({ revision: skillLibraryRevisions.revision })
    .from(skillLibraryRevisions)
    .where(sql`${skillLibraryRevisions.agentId} = ${agentId}`)
    .limit(1);
  if (!row) throw new Error('Skill library revision is unavailable');
  return row.revision.toString();
}

/** Atomically increment after a committed skill mutation. */
export async function bumpSkillLibraryRevision(
  writer: RevisionWriter,
  agentId: string,
): Promise<string> {
  const [row] = await writer
    .insert(skillLibraryRevisions)
    .values({ agentId, revision: 1 })
    .onConflictDoUpdate({
      target: skillLibraryRevisions.agentId,
      set: {
        revision: sql`${skillLibraryRevisions.revision} + 1`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ revision: skillLibraryRevisions.revision });
  if (!row) throw new Error('Skill library revision could not be advanced');
  return row.revision.toString();
}
