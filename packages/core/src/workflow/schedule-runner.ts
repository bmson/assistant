import {
  type GoalOccurrenceGuard,
  type ScheduleRecord,
  type ScheduleRepository,
  scheduleBatch,
  scheduleCanRun,
} from '@assistant/persistence';
import { InboundEventSchema } from '../events.js';
import { isCodeJobEnabled } from '../memory/jobs.js';
import type { AutonomyGrant } from './autonomy.js';
import { deriveTaskTitle, type TaskType } from './machine.js';
import { nextRun } from './schedule-time.js';

export interface ScheduledTaskTemplate {
  type?: TaskType;
  instruction?: string;
  job?: string;
  reminderText?: string;
  reminderKind?: 'once' | 'recurring' | 'event_completion';
  reminderEventDependency?: unknown;
  budgetUsdLimit?: string;
  maxSteps?: number;
  goalId?: string;
  conversationId?: string;
  taintedOrigin?: boolean;
}
export interface SchedulePreparation {
  action: 'fire' | 'skip' | 'disable';
  goalGuard?: GoalOccurrenceGuard;
  autonomyGrant?: AutonomyGrant;
  /** Replaces the template's standing instruction for this firing, e.g. with a goal's latest progress. */
  instruction?: string;
}
export interface ScheduleRunnerOptions {
  batch?: number;
  now?: Date;
  isJobEnabled?: (job: string) => boolean;
  /** Goal state remains a separate domain dependency; absent adapters reject the sweep before firing that goal. */
  prepareGoal?: (
    row: ScheduleRecord,
    template: ScheduledTaskTemplate,
  ) => Promise<SchedulePreparation>;
  onCreated?: (taskId: string, generation: number) => void;
}

/** Bounded provider-neutral tick. Persistence rechecks snapshots at every mutation. */
export async function runScheduleBatch(
  repository: ScheduleRepository,
  timezone: string,
  options: ScheduleRunnerOptions = {},
): Promise<Array<{ schedule: string; taskId: string }>> {
  const now = options.now ?? new Date();
  const batch = scheduleBatch(options.batch);
  for (const row of await repository.listUninitialized(batch)) {
    if (scheduleCanRun(row))
      await repository.initialize(row, nextRun(row.cron, timezone, now), now);
  }
  const fired: Array<{ schedule: string; taskId: string }> = [];
  for (const row of await repository.listDue(now, batch)) {
    if (!scheduleCanRun(row) || !row.nextRunAt) continue;
    const template = (row.taskTemplate ?? {}) as ScheduledTaskTemplate;
    let preparation: SchedulePreparation = { action: 'fire' };
    if (template.job && !(options.isJobEnabled ?? isCodeJobEnabled)(template.job)) {
      preparation = { action: 'skip' };
    } else if (template.goalId) {
      if (!options.prepareGoal)
        throw new Error('Goal schedule requires a goal preparation adapter');
      preparation = await options.prepareGoal(row, template);
    }
    const create = preparation.action === 'fire';
    const enabled =
      preparation.action !== 'disable' && !(create && template.reminderKind === 'once');
    const event = create
      ? InboundEventSchema.parse({
          source: 'schedule',
          externalEventId: `schedule:${row.id}:${row.nextRunAt.toISOString()}`,
          agentId: row.agentId,
          conversationId: template.conversationId,
          trust: 'assistant',
          payload: {
            schedule: row.name,
            instruction: preparation.instruction ?? template.instruction ?? row.name,
            ...(template.goalId ? { goalId: template.goalId } : {}),
            ...(template.job ? { job: template.job } : {}),
            ...(template.reminderText ? { reminderText: template.reminderText } : {}),
            ...(template.reminderKind ? { reminderKind: template.reminderKind } : {}),
            ...(template.reminderEventDependency
              ? { reminderEventDependency: template.reminderEventDependency }
              : {}),
            scheduleId: row.id,
            occurrenceId: `schedule:${row.id}:${row.nextRunAt.toISOString()}`,
            ...(template.taintedOrigin ? { taintedOrigin: true } : {}),
          },
        })
      : null;
    const committed = await repository.commitOccurrence({
      expected: row,
      ...(create && preparation.goalGuard ? { goalGuard: preparation.goalGuard } : {}),
      now,
      mode: 'due',
      enabled,
      nextRunAt: enabled ? nextRun(row.cron, timezone, now) : null,
      task: event
        ? {
            agentId: row.agentId,
            conversationId: template.conversationId,
            type: template.type ?? 'scheduled',
            trust: 'assistant',
            trigger: event,
            externalEventId: event.externalEventId,
            title: deriveTaskTitle(event),
            goalId: template.goalId,
            budgetUsdLimit: template.budgetUsdLimit,
            maxSteps: template.maxSteps,
            ...(preparation.autonomyGrant ? { autonomyGrant: preparation.autonomyGrant } : {}),
          }
        : null,
    });
    if (committed?.task?.created) {
      const task = committed.task.task;
      fired.push({ schedule: row.name, taskId: task.id });
      options.onCreated?.(task.id, task.queueGeneration);
    }
  }
  return fired;
}
