import type { Records } from './records.js';

type Goal = Records['goals'];
type Task = Records['tasks'];

export interface GoalReadRepository {
  /**
   * What the goals dashboard reads, and no more: the sessions bound to a goal and
   * the few fields of each that the dashboard shows, not every task in full.
   */
  list(agentId: string): Promise<{
    goals: Records['goals'][];
    conversations: Array<Pick<Records['conversations'], 'id' | 'updatedAt' | 'metadata'>>;
    tasks: Array<Pick<Records['tasks'], 'id' | 'goalId' | 'status' | 'updatedAt'>>;
    schedules: Array<Pick<Records['schedules'], 'name' | 'enabled' | 'nextRunAt'>>;
  }>;
  get(agentId: string, id: string): Promise<Records['goals'] | null>;
}

/** The bounded progress write used by a goal work session. Task binding is checked by the dispatcher. */
export interface GoalProgressRepository {
  updateProgress(input: {
    agentId: string;
    goalId: string;
    progress: string;
    nextAction: string;
  }): Promise<{ updated: string; title: string }>;
}

/** What the automatic-session gate reads before a goal's schedule may fire. */
export interface GoalSessionState {
  goal: Goal | null;
  /** Every non-terminal task bound to the goal. */
  openTasks: Array<Pick<Task, 'id' | 'type' | 'status' | 'updatedAt'>>;
  /** The newest three unattended sessions (neither chat nor SMS turns), newest first. */
  recentSessions: Array<Pick<Task, 'status' | 'progress' | 'createdAt'>>;
}

/** Goal state the executor, mission reports, and the goal schedule gate share. */
export interface GoalRuntimeRepository {
  readonly kind: 'goal-runtime-repository';
  get(agentId: string, goalId: string): Promise<Goal | null>;
  /**
   * Park the goal on an owner question by replacing its next action. A goal
   * deleted meanwhile is left alone, as there is nothing left to annotate.
   */
  recordBlocked(input: { agentId: string; goalId: string; nextAction: string }): Promise<void>;
  sessionState(agentId: string, goalId: string): Promise<GoalSessionState>;
  /** Any owner-authored message in the conversation after `since`? */
  ownerRepliedSince(input: {
    agentId: string;
    conversationId: string;
    since: Date;
  }): Promise<boolean>;
}

export interface GoalToolCreateInput {
  agentId: string;
  title: string;
  description: string;
  priority: number;
  targetDate: Date | null;
  /** A goal proposed from a tainted session runs its automation taint-gated. */
  taintedOrigin: boolean;
}

/** The goals.list and goals.create tools. */
export interface GoalToolRepository {
  /** Unarchived goals: active, then paused, then done, then the rest, each by priority. */
  listStanding(agentId: string): Promise<Goal[]>;
  create(input: GoalToolCreateInput): Promise<{ goalId: string }>;
}
