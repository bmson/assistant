import { getAgent } from '@assistant/core/chat';
import {
  GOAL_BLOCKED_PREFIX,
  goalAutomationCadence,
  goalScheduleName,
} from '@assistant/core/workflow/schedules';
import { conversations, type Db, goals, schedules, tasks } from '@assistant/db';
import type { GoalReadRepository, ResearchAssignmentState } from '@assistant/persistence';
import { and, asc, count, desc, eq, isNotNull, isNull, notInArray } from 'drizzle-orm';

export const goalStatuses = ['active', 'paused', 'done', 'abandoned'] as const;
export type GoalStatus = (typeof goalStatuses)[number];
export const goalTerminalTaskStatuses = ['done', 'failed', 'cancelled'];

export interface GoalSnapshot {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  progress: string;
  nextAction: string;
  targetDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  mirrorToPrimary: boolean;
  autonomy: boolean;
  taintedOrigin: boolean;
  researchAssignment: ResearchAssignmentState | null;
}

export interface GoalDashboardItem {
  goal: GoalSnapshot;
  conversationId?: string;
  workActive: boolean;
  automation?: { enabled: boolean; nextRunAt: Date | null };
  cadenceLabel: string;
  blockedQuestion: string;
  stalled: boolean;
  lastSession?: { id: string; status: string; updatedAt: Date };
}

export interface GoalsDashboard {
  items: GoalDashboardItem[];
  archivedCount: number;
}

/** Project the shared portable goal read seam into the mobile dashboard shape. */
export async function listGoalsDashboardWithRepository(
  repository: GoalReadRepository,
  agentId: string,
  archived: boolean,
  now = new Date(),
): Promise<GoalsDashboard> {
  const {
    goals: allGoals,
    conversations: chatRows,
    tasks,
    schedules,
  } = await repository.list(agentId);
  const archivedCount = allGoals.filter((goal) => goal.archivedAt != null).length;
  const rows = allGoals
    .filter((goal) => (archived ? goal.archivedAt != null : goal.archivedAt == null))
    .sort((a, b) => a.priority - b.priority || b.updatedAt.getTime() - a.updatedAt.getTime());
  const chatByGoalId = new Map<string, string>();
  for (const chat of chatRows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())) {
    const goalId = goalIdFromMetadata(chat.metadata);
    if (goalId && !chatByGoalId.has(goalId)) chatByGoalId.set(goalId, chat.id);
  }
  const activeGoalIds = new Set(
    tasks.flatMap((task) =>
      task.goalId && !['done', 'failed', 'cancelled'].includes(task.status) ? [task.goalId] : [],
    ),
  );
  const stalledGoalIds = new Set(
    tasks.flatMap((task) =>
      task.goalId && task.status === 'needs_attention' ? [task.goalId] : [],
    ),
  );
  const lastSessionByGoalId = new Map<string, { id: string; status: string; updatedAt: Date }>();
  for (const task of [...tasks].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())) {
    if (task.goalId && !lastSessionByGoalId.has(task.goalId))
      lastSessionByGoalId.set(task.goalId, {
        id: task.id,
        status: task.status,
        updatedAt: task.updatedAt,
      });
  }
  return {
    items: rows.map((goal) => {
      const automation = schedules.find((schedule) => schedule.name === goalScheduleName(goal.id));
      return {
        goal: { ...goal, researchAssignment: goal.researchAssignment ?? null },
        conversationId: chatByGoalId.get(goal.id),
        workActive: activeGoalIds.has(goal.id),
        ...(automation
          ? { automation: { enabled: automation.enabled, nextRunAt: automation.nextRunAt } }
          : {}),
        cadenceLabel: goalAutomationCadence(goal, now).label,
        blockedQuestion: goal.nextAction.startsWith(GOAL_BLOCKED_PREFIX)
          ? goal.nextAction.slice(GOAL_BLOCKED_PREFIX.length).trim()
          : '',
        stalled: stalledGoalIds.has(goal.id),
        lastSession: lastSessionByGoalId.get(goal.id),
      };
    }),
    archivedCount,
  };
}

export async function getGoalRecord(db: Db, goalId: string) {
  const agent = await getAgent(db);
  const [goal] = await db
    .select()
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.agentId, agent.id)))
    .limit(1);
  return goal ?? null;
}

function goalIdFromMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const goalId = (metadata as Record<string, unknown>).goalId;
  return typeof goalId === 'string' ? goalId : undefined;
}

/** Load goal records and their linked automation/work state as one use case. */
export async function listGoalsDashboard(
  db: Db,
  archived: boolean,
  now = new Date(),
): Promise<GoalsDashboard> {
  const agent = await getAgent(db);
  const [
    rows,
    chatRows,
    archivedCountRows,
    activeTaskRows,
    automationRows,
    stalledTaskRows,
    sessionRows,
  ] = await Promise.all([
    db
      .select()
      .from(goals)
      .where(
        and(
          eq(goals.agentId, agent.id),
          archived ? isNotNull(goals.archivedAt) : isNull(goals.archivedAt),
        ),
      )
      .orderBy(asc(goals.priority), desc(goals.updatedAt)),
    db
      .select({ id: conversations.id, metadata: conversations.metadata })
      .from(conversations)
      .where(and(eq(conversations.agentId, agent.id), eq(conversations.channel, 'chat')))
      .orderBy(desc(conversations.updatedAt)),
    db
      .select({ value: count() })
      .from(goals)
      .where(and(eq(goals.agentId, agent.id), isNotNull(goals.archivedAt))),
    db
      .selectDistinct({ goalId: tasks.goalId })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agent.id),
          isNotNull(tasks.goalId),
          notInArray(tasks.status, goalTerminalTaskStatuses),
        ),
      ),
    db
      .select({ name: schedules.name, enabled: schedules.enabled, nextRunAt: schedules.nextRunAt })
      .from(schedules)
      .where(eq(schedules.agentId, agent.id)),
    db
      .selectDistinct({ goalId: tasks.goalId })
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, agent.id),
          isNotNull(tasks.goalId),
          eq(tasks.status, 'needs_attention'),
        ),
      ),
    db
      .select({
        goalId: tasks.goalId,
        id: tasks.id,
        status: tasks.status,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .where(and(eq(tasks.agentId, agent.id), isNotNull(tasks.goalId)))
      .orderBy(desc(tasks.updatedAt)),
  ]);

  const chatByGoalId = new Map<string, string>();
  for (const chat of chatRows) {
    const goalId = goalIdFromMetadata(chat.metadata);
    if (goalId && !chatByGoalId.has(goalId)) chatByGoalId.set(goalId, chat.id);
  }
  const activeGoalIds = new Set(
    activeTaskRows.map((task) => task.goalId).filter((goalId): goalId is string => goalId !== null),
  );
  const stalledGoalIds = new Set(
    stalledTaskRows
      .map((task) => task.goalId)
      .filter((goalId): goalId is string => goalId !== null),
  );
  const lastSessionByGoalId = new Map<string, { id: string; status: string; updatedAt: Date }>();
  for (const session of sessionRows) {
    if (session.goalId && !lastSessionByGoalId.has(session.goalId)) {
      lastSessionByGoalId.set(session.goalId, {
        id: session.id,
        status: session.status,
        updatedAt: session.updatedAt,
      });
    }
  }

  return {
    items: rows.map((goal) => {
      const automation = automationRows.find(
        (schedule) => schedule.name === goalScheduleName(goal.id),
      );
      return {
        goal,
        conversationId: chatByGoalId.get(goal.id),
        workActive: activeGoalIds.has(goal.id),
        ...(automation
          ? { automation: { enabled: automation.enabled, nextRunAt: automation.nextRunAt } }
          : {}),
        cadenceLabel: goalAutomationCadence(goal, now).label,
        blockedQuestion: goal.nextAction.startsWith(GOAL_BLOCKED_PREFIX)
          ? goal.nextAction.slice(GOAL_BLOCKED_PREFIX.length).trim()
          : '',
        stalled: stalledGoalIds.has(goal.id),
        lastSession: lastSessionByGoalId.get(goal.id),
      };
    }),
    archivedCount: Number(archivedCountRows[0]?.value ?? 0),
  };
}
