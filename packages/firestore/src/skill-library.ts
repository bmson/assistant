import type { SkillLibraryRepository, WorkspaceSkillRecord } from '@assistant/persistence';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const MAX_WORKSPACE_SKILLS = 500;
const FIELDS = [
  'id',
  'agentId',
  'name',
  'preconditions',
  'steps',
  'gotchas',
  'ownerAuthored',
  'deprecated',
  'useCount',
  'successCount',
  'failureCount',
  'updatedAt',
] as const;

export function skillFromDocument(
  value: unknown,
  documentId: string,
  agentId: string,
): WorkspaceSkillRecord {
  const row = decodeRecord<Record<string, unknown>>(value);
  if (
    row.agentId !== agentId ||
    typeof row.id !== 'string' ||
    documentKey(row.id) !== documentId ||
    typeof row.name !== 'string' ||
    typeof row.preconditions !== 'string' ||
    typeof row.steps !== 'string' ||
    typeof row.gotchas !== 'string' ||
    typeof row.ownerAuthored !== 'boolean' ||
    typeof row.deprecated !== 'boolean' ||
    !(row.updatedAt instanceof Date) ||
    !Number.isFinite(row.updatedAt.getTime()) ||
    ![row.useCount, row.successCount, row.failureCount].every(
      (count) => Number.isSafeInteger(count) && Number(count) >= 0,
    )
  )
    throw new Error('Invalid learned-skill document');

  return {
    id: row.id,
    name: row.name,
    preconditions: row.preconditions,
    steps: row.steps,
    gotchas: row.gotchas,
    ownerAuthored: row.ownerAuthored,
    deprecated: row.deprecated,
    useCount: row.useCount as number,
    successCount: row.successCount as number,
    failureCount: row.failureCount as number,
    updatedAt: row.updatedAt,
  };
}

/** Lists one owner's complete mobile skill library without loading vector data. */
export class FirestoreSkillLibraryRepository implements SkillLibraryRepository {
  readonly kind = 'skill-library-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async listPage(agentId: string, input: { afterId?: string; limit: number }) {
    const limit = boundedPageSize(input.limit);
    if (!agentId) throw new Error('An agent is required to list learned skills');
    if (input.afterId !== undefined && !/^[0-9a-f-]{36}$/i.test(input.afterId))
      throw new Error('Invalid learned-skill continuation');
    const agent = await this.store.doc('agents', agentId).get();
    if (!agent.exists || agent.get('id') !== agentId || documentKey(agentId) !== agent.id)
      throw new Error('Configured learned-skill agent is missing or malformed');
    const fence = await readPrivacyErasureFence(this.store, agentId);
    let query = this.store
      .collection('skills')
      .where('agentId', '==', agentId)
      .orderBy('id', 'asc')
      .select(...FIELDS);
    if (input.afterId) query = query.startAfter(input.afterId);
    const snapshot = await query.limit(limit + 1).get();
    const page = snapshot.docs
      .slice(0, limit)
      .map((doc) => skillFromDocument(doc.data(), doc.id, agentId));
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return {
      items: page,
      hasMore: snapshot.size > limit,
      nextCursor: snapshot.size > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async list(agentId: string): Promise<WorkspaceSkillRecord[]> {
    if (!agentId) throw new Error('An agent is required to list learned skills');
    const agent = await this.store.doc('agents', agentId).get();
    if (!agent.exists || agent.get('id') !== agentId || documentKey(agentId) !== agent.id)
      throw new Error('Configured learned-skill agent is missing or malformed');
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const snapshot = await this.store
      .collection('skills')
      .where('agentId', '==', agentId)
      .select(...FIELDS)
      .limit(MAX_WORKSPACE_SKILLS + 1)
      .get();
    if (snapshot.size > MAX_WORKSPACE_SKILLS)
      throw new Error('Learned-skill library exceeds the mobile workspace limit');

    const skills = snapshot.docs
      .map((doc) => skillFromDocument(doc.data(), doc.id, agentId))
      .sort(
        (left, right) =>
          Number(right.ownerAuthored) - Number(left.ownerAuthored) ||
          Number(left.deprecated) - Number(right.deprecated) ||
          right.updatedAt.getTime() - left.updatedAt.getTime() ||
          left.id.localeCompare(right.id),
      );
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return skills;
  }
}

function boundedPageSize(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Workspace page size must be between 1 and 100');
  return limit;
}
