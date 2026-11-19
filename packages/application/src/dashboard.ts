import { approvals, countPostgresNeedsYouTasks, type Db, tasks } from '@assistant/db';
import { and, count, eq, gt, sql } from 'drizzle-orm';

export type AssistantPresence = 'idle' | 'working' | 'attention';

export interface DashboardPresence {
  pendingApprovals: number;
  needsAttention: number;
  presence: AssistantPresence;
}

/** Query the small status projection needed by the global dashboard shell. */
export async function getDashboardPresence(db: Db, agentId: string): Promise<DashboardPresence> {
  const [pendingRows, runningRows, needsAttention] = await Promise.all([
    db
      .select({ value: count() })
      .from(approvals)
      .innerJoin(tasks, eq(approvals.taskId, tasks.id))
      .where(
        and(
          eq(tasks.agentId, agentId),
          eq(approvals.status, 'pending'),
          gt(approvals.expiresAt, sql`now()`),
        ),
      ),
    db
      .select({ value: count() })
      .from(tasks)
      .where(and(eq(tasks.agentId, agentId), eq(tasks.status, 'running'))),
    countPostgresNeedsYouTasks(db, agentId),
  ]);

  const pendingApprovals = Number(pendingRows[0]?.value ?? 0);
  const running = Number(runningRows[0]?.value ?? 0);
  return {
    pendingApprovals,
    needsAttention,
    presence:
      pendingApprovals > 0 || needsAttention > 0 ? 'attention' : running > 0 ? 'working' : 'idle',
  };
}
