import type {
  EmbeddingSpace,
  ReflectionTask,
  ReflectionToolCall,
  SkillReflectionCommit,
  SkillReflectionCommitResult,
  SkillReflectionRepository,
} from '@assistant/persistence';
import { FirestoreSkillMutationRepository } from './skill-mutations.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

/** Firestore `in` filters take at most 30 values. */
const IN_LIMIT = 30;
/** Steps read per reflected task; a task's tool loop is bounded far below this. */
const STEP_LIMIT = 500;

/**
 * The nightly skill reflection on Firestore. Candidates and their tool calls
 * are read for the configured owner; skills are written through the same
 * owner and privacy-erasure fence as the owner's own edits.
 */
export class FirestoreSkillReflectionRepository implements SkillReflectionRepository {
  readonly kind = 'skill-reflection-repository' as const;
  private readonly writes: FirestoreSkillMutationRepository;

  constructor(
    readonly store: InstallationStore,
    readonly agentId: string,
    space: EmbeddingSpace,
  ) {
    this.writes = new FirestoreSkillMutationRepository(store, space);
  }

  private owned(agentId: string): void {
    if (agentId !== this.agentId)
      throw new Error('Skill reflection is outside the configured owner');
  }

  async candidates(since: Date, limit: number): Promise<ReflectionTask[]> {
    const agentId = this.agentId;
    const snapshot = await this.store
      .collection('tasks')
      .where('agentId', '==', agentId)
      .where('status', '==', 'done')
      .where('trust', 'in', ['owner', 'assistant'])
      .where('createdAt', '>=', since)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs.flatMap((doc) => {
      const row = decodeRecord<Record<string, unknown>>(doc.data());
      if (typeof row.id !== 'string' || documentKey(row.id) !== doc.id) return [];
      return [
        {
          id: row.id,
          agentId,
          trust: String(row.trust),
          trigger: row.trigger ?? null,
          state: row.state ?? null,
          plan: row.plan ?? null,
          progress: typeof row.progress === 'string' ? row.progress : null,
        },
      ];
    });
  }

  async sourcedTaskIds(taskIds: string[]): Promise<string[]> {
    const agentId = this.agentId;
    const sourced: string[] = [];
    for (let i = 0; i < taskIds.length; i += IN_LIMIT) {
      const snapshot = await this.store
        .collection('skills')
        .where('agentId', '==', agentId)
        .where('sourceTaskId', 'in', taskIds.slice(i, i + IN_LIMIT))
        .select('sourceTaskId')
        .get();
      for (const doc of snapshot.docs) {
        const id = doc.get('sourceTaskId');
        if (typeof id === 'string') sourced.push(id);
      }
    }
    const tasks = await Promise.all(
      taskIds.map(async (taskId) => ({
        taskId,
        snapshot: await this.store.doc('tasks', taskId).get(),
      })),
    );
    for (const { taskId, snapshot } of tasks) {
      if (!snapshot.exists) continue;
      const row = decodeRecord<Record<string, unknown>>(snapshot.data());
      const state = row.state as Record<string, unknown> | null;
      if (state?.skillReflectionReceipt) sourced.push(taskId);
    }
    return sourced;
  }

  async toolCalls(taskId: string): Promise<ReflectionToolCall[]> {
    const snapshot = await this.store
      .collection('toolCalls')
      .where('taskId', '==', taskId)
      .select('toolName', 'status', 'error', 'args', 'step', 'id')
      .orderBy('step', 'asc')
      .orderBy('id', 'asc')
      .limit(STEP_LIMIT)
      .get();
    return snapshot.docs.map((doc) => {
      const row = decodeRecord<Record<string, unknown>>(doc.data());
      return {
        toolName: String(row.toolName),
        status: String(row.status),
        error: typeof row.error === 'string' ? row.error : null,
        args: row.args ?? null,
      };
    });
  }

  libraryRevision(agentId: string): Promise<string> {
    this.owned(agentId);
    return this.writes.libraryRevisionForReflection(agentId);
  }

  commitReflection(input: SkillReflectionCommit): Promise<SkillReflectionCommitResult> {
    this.owned(input.agentId);
    return this.writes.commitReflection(input);
  }
}
