import { encodeMessageCursor, getAgent } from '@assistant/core/chat';
import { getQueueNotifier } from '@assistant/core/queue';
import { enqueueTask } from '@assistant/core/workflow/machine';
import { cancelQueuedGoalWork, ensureGoalAutomation } from '@assistant/core/workflow/schedules';
import { conversations, type Db, type GoalRow, goals, tasks } from '@assistant/db';
import { and, eq, inArray, isNotNull, isNull, lt, notInArray } from 'drizzle-orm';

import { type GoalStatus, goalStatuses, goalTerminalTaskStatuses } from './queries.js';

export interface GoalInput {
  title: string;
  description: string;
  priority: number;
  targetDate: Date | null;
  progress: string;
  nextAction: string;
  mirrorToPrimary: boolean;
}

export interface GoalWorkLink {
  conversationId: string;
  taskId: string;
  messageCursor: string;
}

type WorkGoal = Pick<
  GoalRow,
  'id' | 'title' | 'description' | 'targetDate' | 'researchAssignment'
>;

function assertOrdinaryGoal(goal: Pick<GoalRow, 'researchAssignment'>): void {
  if (goal.researchAssignment)
    throw new Error('Research assignments cannot use generic goal work or automation');
}

function openingWorkMessage(goal: WorkGoal): string {
  return [
    `Start working on my goal: ${goal.title}`,
    goal.description ? `Context: ${goal.description}` : '',
    goal.targetDate ? `Target date: ${goal.targetDate.toISOString().slice(0, 10)}` : '',
    'Take one useful, concrete step now. This goal will keep running on its automation cadence; use this chat to guide the work. If you need information or approval, say exactly what you need. Do not create an additional mission or schedule.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function createGoalWork(
  db: Db,
  agentId: string,
  goal: WorkGoal,
): Promise<GoalWorkLink & { taskGeneration: number }> {
  assertOrdinaryGoal(goal);
  const [conversation] = await db
    .insert(conversations)
    .values({
      agentId,
      channel: 'chat',
      trust: 'owner',
      title: `Work: ${goal.title}`.slice(0, 120),
      metadata: { goalId: goal.id },
    })
    .returning();
  if (!conversation) throw new Error('failed to create work chat');

  const { task } = await enqueueTask(db, {
    event: {
      source: 'chat',
      agentId,
      conversationId: conversation.id,
      trust: 'owner',
      payload: { text: openingWorkMessage(goal), goalId: goal.id, createdFrom: 'goal' },
    },
    type: 'chat_turn',
    goalId: goal.id,
    deferNotification: true,
  });
  return {
    conversationId: conversation.id,
    taskId: task.id,
    taskGeneration: task.queueGeneration,
    messageCursor: encodeMessageCursor({ createdAt: task.createdAt, id: task.id }),
  };
}

function notifyWorkTask(taskId: string, generation: number): void {
  try {
    getQueueNotifier().notify(taskId, generation);
  } catch (error) {
    console.error('goal work task queued without an immediate notification', error);
  }
}

export async function createGoalWithWork(db: Db, input: GoalInput): Promise<GoalWorkLink> {
  const agent = await getAgent(db);
  const work = await db.transaction(async (tx) => {
    const [goal] = await tx
      .insert(goals)
      .values({
        agentId: agent.id,
        ...input,
        progress: 'First task queued.',
        nextAction: 'Check the work chat for the first update.',
      })
      .returning();
    if (!goal) throw new Error('failed to create goal');
    const started = await createGoalWork(tx as unknown as Db, agent.id, goal);
    await ensureGoalAutomation(tx as unknown as Db, agent, goal, started.conversationId);
    return started;
  });
  notifyWorkTask(work.taskId, work.taskGeneration);
  return work;
}

export async function startExistingGoalWork(db: Db, goalId: string): Promise<GoalWorkLink> {
  const agent = await getAgent(db);
  const [goal] = await db
    .select()
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id), isNull(goals.archivedAt)));
  if (!goal) throw new Error('goal not found or is archived');
  assertOrdinaryGoal(goal);
  const work = await db.transaction(async (tx) => {
    const started = await createGoalWork(tx as unknown as Db, agent.id, goal);
    await ensureGoalAutomation(tx as unknown as Db, agent, goal, started.conversationId);
    return started;
  });
  notifyWorkTask(work.taskId, work.taskGeneration);
  return work;
}

export async function updateGoalSettings(db: Db, goalId: string, input: GoalInput): Promise<void> {
  const agent = await getAgent(db);
  const [existing] = await db
    .select()
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id)))
    .limit(1);
  if (!existing) return;
  assertOrdinaryGoal(existing);
  const [goal] = await db
    .update(goals)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id)))
    .returning();
  if (goal) await ensureGoalAutomation(db, agent, goal);
}

export async function changeGoalStatus(db: Db, goalId: string, status: GoalStatus): Promise<void> {
  if (!goalStatuses.includes(status)) throw new Error(`invalid goal status: ${String(status)}`);
  const agent = await getAgent(db);
  const [existing] = await db
    .select()
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id)))
    .limit(1);
  if (!existing) return;
  assertOrdinaryGoal(existing);
  const [goal] = await db
    .update(goals)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id)))
    .returning();
  if (!goal) return;
  await ensureGoalAutomation(db, agent, goal);
  if (status === 'abandoned') await cancelQueuedGoalWork(db, agent.id, goal.id);
}

export async function changeGoalAutonomy(db: Db, goalId: string, enabled: boolean): Promise<void> {
  const agent = await getAgent(db);
  const [goal] = await db
    .select({ taintedOrigin: goals.taintedOrigin, researchAssignment: goals.researchAssignment })
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id)))
    .limit(1);
  if (!goal) throw new Error('goal not found');
  assertOrdinaryGoal(goal);
  if (enabled && goal.taintedOrigin) {
    throw new Error('a goal created from external content cannot be given free-range autonomy');
  }
  await db
    .update(goals)
    .set({ autonomy: enabled, updatedAt: new Date() })
    .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id)));
}

async function requireArchivableGoal(db: Db, goalId: string) {
  const agent = await getAgent(db);
  const [row] = await db
    .select({ goal: goals })
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id)))
    .limit(1);
  if (!row) throw new Error('goal not found');
  const [activeTask] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.agentId, agent.id),
        eq(tasks.goalId, row.goal.id),
        notInArray(tasks.status, goalTerminalTaskStatuses),
      ),
    )
    .limit(1);
  if (activeTask)
    throw new Error('finish, cancel, or pause active work before archiving this goal');
  return { agent, goal: row.goal };
}

export async function archiveGoalRecord(db: Db, goalId: string): Promise<void> {
  const { agent, goal } = await requireArchivableGoal(db, goalId);
  const [archived] = await db
    .update(goals)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(goals.id, goal.id), isNull(goals.archivedAt)))
    .returning();
  if (archived) await ensureGoalAutomation(db, agent, archived);
}

export async function restoreGoalRecord(db: Db, goalId: string): Promise<void> {
  const agent = await getAgent(db);
  const [goal] = await db
    .select({ id: goals.id })
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id)))
    .limit(1);
  if (!goal) throw new Error('goal not found');
  const [restored] = await db
    .update(goals)
    .set({ archivedAt: null, updatedAt: new Date() })
    .where(and(eq(goals.id, goal.id), isNotNull(goals.archivedAt)))
    .returning();
  if (restored) await ensureGoalAutomation(db, agent, restored);
}

export async function archiveInactiveGoalRecords(db: Db, olderThanDays = 30): Promise<void> {
  const agent = await getAgent(db);
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const candidates = await db
    .select({ goal: goals })
    .from(goals)
    .where(
      and(
        eq(goals.agentId, agent.id),
        isNull(goals.archivedAt),
        inArray(goals.status, ['done', 'abandoned']),
        lt(goals.updatedAt, cutoff),
      ),
    )
    .limit(100);

  for (const candidate of candidates) {
    const [activeTask] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agent.id),
          eq(tasks.goalId, candidate.goal.id),
          notInArray(tasks.status, goalTerminalTaskStatuses),
        ),
      )
      .limit(1);
    if (activeTask) continue;
    const [archived] = await db
      .update(goals)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(goals.id, candidate.goal.id), isNull(goals.archivedAt)))
      .returning();
    if (archived) await ensureGoalAutomation(db, agent, archived);
  }
}
