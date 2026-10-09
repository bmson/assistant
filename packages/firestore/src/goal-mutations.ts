import { createHash, randomUUID } from 'node:crypto';
import { newTaskRecord, type Records, type TaskCreateInput } from '@assistant/persistence';
import type {
  DocumentSnapshot,
  QueryDocumentSnapshot,
  QuerySnapshot,
  Transaction,
} from '@google-cloud/firestore';
import { conversationDocument } from './conversation-document.js';
import { messageRecord } from './messages.js';
import { createWakeIntent } from './outbox.js';
import { privacyErasureIsActive, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Goal = Records['goals'];
type Schedule = Records['schedules'];
type GoalSettings = Pick<
  Goal,
  | 'title'
  | 'description'
  | 'priority'
  | 'targetDate'
  | 'progress'
  | 'nextAction'
  | 'mirrorToPrimary'
>;
const TERMINAL_TASKS = new Set(['done', 'failed', 'cancelled']);
const LIVE_TASK_STATUSES = [
  'pending',
  'running',
  'waiting_approval',
  'waiting_event',
  'sleeping',
  'waiting_budget',
  'needs_attention',
];
const AUTOMATION_WELCOME =
  'Automatic goal work is enabled. Use this chat to refine what I should prioritize.';
const MAX_GOAL_TASKS = 200;

function goalName(id: string) {
  return `goal:${id}`;
}

function scheduleNameKey(agentId: string, name: string) {
  return createHash('sha256')
    .update(JSON.stringify([agentId, name]))
    .digest('hex');
}

function openingWorkMessage(goal: Pick<Goal, 'title' | 'description' | 'targetDate'>) {
  return [
    `Start working on my goal: ${goal.title}`,
    goal.description ? `Context: ${goal.description}` : '',
    goal.targetDate ? `Target date: ${goal.targetDate.toISOString().slice(0, 10)}` : '',
    'Take one useful, concrete step now. This goal will keep running on its automation cadence; use this chat to guide the work. If you need information or approval, say exactly what you need. Do not create an additional mission or schedule.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function conciseTaskTitle(value: string) {
  const title = value.replace(/\s+/g, ' ').trim();
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

function identity<T extends { id: string; agentId: string }>(
  doc: DocumentSnapshot,
  row: T,
  id: string,
  agentId: string,
) {
  if (row.id !== id || documentKey(row.id) !== doc.id || row.agentId !== agentId)
    throw new Error('Goal record identity mismatch');
}

function ownerScheduleQuery(store: InstallationStore, agentId: string, name: string) {
  return store
    .collection('schedules')
    .where('agentId', '==', agentId)
    .where('name', '==', name)
    .limit(2);
}

function decodeGoal(doc: DocumentSnapshot, id: string, agentId: string): Goal {
  const goal = decodeRecord<Goal>(doc.data());
  identity(doc, goal, id, agentId);
  return goal;
}

function decodeGoalSchedules(
  snapshot: QuerySnapshot,
  agentId: string,
  name: string,
): Array<{ doc: QueryDocumentSnapshot; row: Schedule }> {
  return snapshot.docs.map((doc) => {
    const row = decodeRecord<Schedule>(doc.data());
    if (documentKey(row.id) !== doc.id || row.agentId !== agentId || row.name !== name)
      throw new Error('Goal automation record is malformed');
    return { doc, row };
  });
}

/** Owner-scoped transactional mutations for existing mobile Goals. */
export class FirestoreGoalMutationRepository {
  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  private async createWork(
    goalId: string,
    input: (GoalSettings & { taintedOrigin?: boolean }) | null,
    automationFor: (goal: Goal) => {
      cron: string;
      instruction: string;
      nextRunAt: (timezone: string) => Date;
    },
    options: { openingTask: boolean } = { openingTask: true },
  ) {
    if (!this.configuredAgentId) throw new Error('Goal mutation requires the configured owner');
    const fence = await readPrivacyErasureFence(this.store, this.configuredAgentId);
    const conversationId = randomUUID();
    const taskId = randomUUID();
    const scheduleId = randomUUID();
    return this.store.db.runTransaction(async (tx) => {
      const owners = await tx.get(this.store.collection('agents').limit(2));
      const owner = owners.docs[0];
      if (
        owners.size !== 1 ||
        !owner ||
        owner.get('id') !== this.configuredAgentId ||
        documentKey(this.configuredAgentId) !== owner.id
      )
        throw new Error('Goals require exactly one configured owner');
      const now = this.store.now();
      const goalRef = this.store.doc('goals', goalId);
      const erasureRef = this.store.doc('privacyErasureJobs', this.configuredAgentId);
      const [goalDoc, erasure] = await tx.getAll(goalRef, erasureRef);
      if (!goalDoc || !erasure) throw new Error('Goal creation state is unavailable');
      if (erasure?.exists) {
        if (
          erasure.get('agentId') !== this.configuredAgentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime ||
          (fence && !erasure.updateTime.isEqual(fence)) ||
          (!fence && erasure.exists)
        )
          throw new Error('Privacy erasure is in progress');
      } else if (fence) {
        throw new Error('Privacy erasure changed during goal mutation');
      }

      let goal: Goal;
      if (input) {
        if (goalDoc.exists) throw new Error('goal ID collision');
        if (
          !input.title.trim() ||
          !Number.isInteger(input.priority) ||
          input.priority < 1 ||
          input.priority > 5
        )
          throw new Error('invalid goal input');
        goal = {
          id: goalId,
          agentId: this.configuredAgentId,
          createdAt: now,
          updatedAt: now,
          title: input.title,
          description: input.description,
          status: 'active',
          priority: input.priority,
          progress: options.openingTask ? 'First task queued.' : input.progress,
          nextAction: options.openingTask
            ? 'Check the work chat for the first update.'
            : input.nextAction,
          targetDate: input.targetDate,
          mirrorToPrimary: input.mirrorToPrimary,
          taintedOrigin: input.taintedOrigin ?? false,
          autonomy: false,
          archivedAt: null,
        };
      } else {
        if (!goalDoc.exists) throw new Error('goal not found');
        goal = decodeGoal(goalDoc, goalId, this.configuredAgentId);
        if (goal.archivedAt) throw new Error('goal not found or is archived');
      }
      const active = goal.status === 'active' && !goal.archivedAt;
      const automation = active ? automationFor(goal) : null;

      const name = goalName(goalId);
      const nameKey = scheduleNameKey(this.configuredAgentId, name);
      const keyRef = this.store.doc('scheduleNames', nameKey);
      const matches = await tx.get(ownerScheduleQuery(this.store, this.configuredAgentId, name));
      if (matches.size > 1) throw new Error('Ambiguous goal automation');
      const existing = decodeGoalSchedules(matches, this.configuredAgentId, name)[0];
      const key = await tx.get(keyRef);
      if (
        key.exists &&
        (key.get('agentId') !== this.configuredAgentId ||
          key.get('name') !== name ||
          typeof key.get('scheduleId') !== 'string' ||
          (existing && key.get('scheduleId') !== existing.row.id))
      )
        throw new Error('Goal automation name key is malformed');
      if (key.exists && !existing) {
        const pointed = await tx.get(this.store.doc('schedules', String(key.get('scheduleId'))));
        if (pointed.exists) throw new Error('Goal automation name key points outside its query');
      }
      const message = openingWorkMessage(goal);
      const event = {
        source: 'chat',
        agentId: this.configuredAgentId,
        conversationId,
        trust: 'owner',
        payload: { text: message, goalId, createdFrom: 'goal' },
      } satisfies TaskCreateInput['trigger'];
      const task = newTaskRecord(
        {
          agentId: this.configuredAgentId,
          conversationId,
          type: 'chat_turn',
          trust: 'owner',
          trigger: event,
          title: conciseTaskTitle(message),
          goalId,
          budgetUsdLimit: '0.50',
        },
        taskId,
        now,
      );
      let scheduleRow: Schedule | null = null;
      if (automation) {
        const timezone = owner.get('timezone');
        if (typeof timezone !== 'string' || !timezone.trim())
          throw new Error('Configured owner timezone is unavailable');
        scheduleRow = {
          ...(existing?.row ?? {
            id: scheduleId,
            name,
            createdAt: now,
            agentId: this.configuredAgentId,
            seedTemplateKey: null,
            seedTemplateRevision: null,
            seedDefinition: null,
            seedReviewRequired: false,
            lastRunAt: null,
          }),
          cron: automation.cron,
          taskTemplate: {
            type: 'scheduled',
            goalId,
            conversationId,
            budgetUsdLimit: '0.75',
            maxSteps: 16,
            instruction: automation.instruction,
            ...(goal.taintedOrigin ? { taintedOrigin: true } : {}),
          },
          enabled: true,
          nextRunAt: automation.nextRunAt(timezone),
          updatedAt: now,
        };
      }
      tx.create(
        this.store.doc('conversations', conversationId),
        conversationDocument({
          id: conversationId,
          agentId: this.configuredAgentId,
          createdAt: now,
          updatedAt: now,
          channel: 'chat',
          trust: 'owner',
          title: `Work: ${goal.title}`.slice(0, 120),
          metadata: { goalId },
          archivedAt: null,
          modelOverride: null,
          isPrimary: false,
          lastReadAt: null,
        }),
      );
      if (input) tx.create(goalRef, encodeRecord(goal));
      if (options.openingTask) {
        tx.create(this.store.doc('tasks', taskId), encodeRecord(task));
        createWakeIntent(tx, this.store, { taskId, generation: 0, availableAt: now });
      } else {
        const welcome = messageRecord(
          {
            conversationId,
            role: 'assistant',
            origin: 'assistant',
            parts: [{ type: 'text', text: AUTOMATION_WELCOME }],
            text: AUTOMATION_WELCOME,
          },
          randomUUID(),
          now,
        );
        tx.create(this.store.doc('messages', welcome.id), encodeRecord(welcome));
      }
      if (scheduleRow) {
        if (existing) tx.update(existing.doc.ref, encodeRecord(scheduleRow));
        else tx.create(this.store.doc('schedules', scheduleId), encodeRecord(scheduleRow));
        tx.set(keyRef, {
          agentId: this.configuredAgentId,
          name,
          scheduleId: scheduleRow.id,
          createdAt: key.exists ? (key.get('createdAt') ?? now) : now,
        });
      } else if (existing?.row.enabled) {
        tx.update(existing.doc.ref, { enabled: false, updatedAt: now });
      }
      return {
        goalId,
        conversationId,
        taskId,
        taskGeneration: task.queueGeneration,
        taskCreatedAt: task.createdAt,
      };
    });
  }

  createWithWork(
    input: GoalSettings,
    automationFor: (goal: Goal) => {
      cron: string;
      instruction: string;
      nextRunAt: (timezone: string) => Date;
    },
  ) {
    return this.createWork(randomUUID(), input, automationFor);
  }

  /**
   * The goals.create tool: the goal, its work chat, and its automation, as
   * the PostgreSQL sweep's goal sync would create them. Work starts on the
   * automation's cadence rather than with an opening task.
   */
  async createFromTool(
    input: GoalSettings & { taintedOrigin: boolean },
    automationFor: (goal: Goal) => {
      cron: string;
      instruction: string;
      nextRunAt: (timezone: string) => Date;
    },
  ): Promise<{ goalId: string; conversationId: string }> {
    const work = await this.createWork(randomUUID(), input, automationFor, {
      openingTask: false,
    });
    return { goalId: work.goalId, conversationId: work.conversationId };
  }

  startWork(
    id: string,
    automationFor: (goal: Goal) => {
      cron: string;
      instruction: string;
      nextRunAt: (timezone: string) => Date;
    },
  ) {
    return this.createWork(id, null, automationFor);
  }

  private async mutate<T>(
    id: string,
    apply: (input: {
      tx: Transaction;
      goalDoc: DocumentSnapshot;
      goal: Goal;
      schedule?: { doc: QueryDocumentSnapshot; row: Schedule };
      schedules: Array<{ doc: QueryDocumentSnapshot; row: Schedule }>;
      now: Date;
    }) => Promise<T>,
  ): Promise<T> {
    if (!id || !this.configuredAgentId)
      throw new Error('Goal mutation requires the configured owner');
    const fence = await readPrivacyErasureFence(this.store, this.configuredAgentId);
    const result = await this.store.db.runTransaction(async (tx) => {
      const ownerQuery = await tx.get(this.store.collection('agents').limit(2));
      const owner = ownerQuery.docs[0];
      if (
        ownerQuery.size !== 1 ||
        !owner ||
        owner.get('id') !== this.configuredAgentId ||
        documentKey(this.configuredAgentId) !== owner.id
      )
        throw new Error('Goals require exactly one configured owner');
      const goalRef = this.store.doc('goals', id);
      const erasureRef = this.store.doc('privacyErasureJobs', this.configuredAgentId);
      const [goalDoc, erasure] = await tx.getAll(goalRef, erasureRef);
      if (!goalDoc?.exists) throw new Error('goal not found');
      if (erasure?.exists) {
        if (
          erasure.get('agentId') !== this.configuredAgentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime ||
          (fence && !erasure.updateTime.isEqual(fence)) ||
          (!fence && erasure.exists)
        )
          throw new Error('Privacy erasure is in progress');
      } else if (fence) {
        throw new Error('Privacy erasure changed during goal mutation');
      }
      const goal = decodeGoal(goalDoc, id, this.configuredAgentId);
      const snapshots = await tx.get(
        ownerScheduleQuery(this.store, this.configuredAgentId, goalName(id)),
      );
      const schedules = decodeGoalSchedules(snapshots, this.configuredAgentId, goalName(id));
      if (schedules.length > 1) throw new Error('Ambiguous goal automation');
      const schedule = schedules[0];
      const value = await apply({ tx, goalDoc, goal, schedule, schedules, now: this.store.now() });
      return value;
    });
    return result;
  }

  async updateSettings(
    id: string,
    input: GoalSettings,
    scheduleUpdate: { cron: string; instruction: string },
  ): Promise<void> {
    await this.mutate(id, async ({ tx, goalDoc, schedule, now }) => {
      if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 5)
        throw new Error('invalid goal priority');
      tx.update(goalDoc.ref, encodeRecord({ ...input, updatedAt: now }));
      if (schedule) {
        const current = schedule.row.taskTemplate;
        if (!current || typeof current !== 'object' || Array.isArray(current))
          throw new Error('Goal automation template is malformed');
        const template = current as Record<string, unknown>;
        if (template.goalId !== id) throw new Error('Goal automation belongs to another goal');
        tx.update(schedule.doc.ref, {
          cron: scheduleUpdate.cron,
          taskTemplate: encodeRecord({ ...template, instruction: scheduleUpdate.instruction }),
          nextRunAt: null,
          updatedAt: now,
        });
      }
    });
  }

  async setStatus(id: string, status: 'active' | 'paused' | 'done' | 'abandoned'): Promise<void> {
    await this.mutate(id, async ({ tx, goalDoc, goal, schedule, now }) => {
      if (!['active', 'paused', 'done', 'abandoned'].includes(status))
        throw new Error('invalid goal status');
      const activeStatus = status === 'active' && !goal.archivedAt;
      if (activeStatus && !schedule)
        throw new Error('Goal automation is unavailable for this goal');
      const taskPage =
        status === 'abandoned'
          ? await tx.get(
              this.store
                .collection('tasks')
                .where('goalId', '==', id)
                .where('agentId', '==', this.configuredAgentId)
                .where('status', 'in', LIVE_TASK_STATUSES)
                .limit(MAX_GOAL_TASKS + 1),
            )
          : null;
      if (taskPage && taskPage.size > MAX_GOAL_TASKS)
        throw new Error('Too much goal work to update safely');
      const tasks =
        taskPage?.docs.flatMap((doc) => {
          const row = decodeRecord<Records['tasks']>(doc.data());
          if (!row.id || documentKey(row.id) !== doc.id)
            throw new Error('Goal task identity mismatch');
          return row.agentId === this.configuredAgentId &&
            row.goalId === id &&
            !TERMINAL_TASKS.has(row.status) &&
            row.status !== 'running'
            ? [doc]
            : [];
        }) ?? [];
      tx.update(goalDoc.ref, encodeRecord({ status, updatedAt: now }));
      if (schedule)
        tx.update(schedule.doc.ref, {
          enabled: activeStatus,
          nextRunAt: activeStatus ? null : schedule.row.nextRunAt,
          updatedAt: now,
        });
      for (const task of tasks)
        tx.update(task.ref, {
          status: 'cancelled',
          progress: 'stopped because its goal was stopped',
          runAfter: null,
          lockedUntil: null,
          updatedAt: now,
        });
    });
  }

  async archive(id: string): Promise<void> {
    await this.mutate(id, async ({ tx, goalDoc, goal, schedule, now }) => {
      const taskPage = await tx.get(
        this.store
          .collection('tasks')
          .where('goalId', '==', id)
          .where('agentId', '==', this.configuredAgentId)
          .where('status', 'in', LIVE_TASK_STATUSES)
          .limit(MAX_GOAL_TASKS + 1),
      );
      if (taskPage.size > MAX_GOAL_TASKS) throw new Error('Too much goal work to archive safely');
      const active = taskPage.docs.some((doc) => {
        const row = decodeRecord<Records['tasks']>(doc.data());
        if (!row.id || documentKey(row.id) !== doc.id)
          throw new Error('Goal task identity mismatch');
        return (
          row.agentId === this.configuredAgentId &&
          row.goalId === id &&
          !TERMINAL_TASKS.has(row.status)
        );
      });
      if (active)
        throw new Error('finish, cancel, or pause active work before archiving this goal');
      if (goal.archivedAt) return;
      tx.update(goalDoc.ref, encodeRecord({ archivedAt: now, updatedAt: now }));
      if (schedule) tx.update(schedule.doc.ref, { enabled: false, updatedAt: now });
    });
  }

  async restore(id: string): Promise<void> {
    await this.mutate(id, async ({ tx, goalDoc, goal, schedule, now }) => {
      if (goal.status === 'active' && !schedule)
        throw new Error('Goal automation is unavailable for this goal');
      if (!goal.archivedAt) return;
      tx.update(goalDoc.ref, encodeRecord({ archivedAt: null, updatedAt: now }));
      if (schedule && goal.status === 'active')
        tx.update(schedule.doc.ref, { enabled: true, nextRunAt: null, updatedAt: now });
    });
  }

  async setAutonomy(id: string, enabled: boolean): Promise<void> {
    await this.mutate(id, async ({ tx, goalDoc, goal, now }) => {
      if (enabled && goal.taintedOrigin)
        throw new Error('a goal created from external content cannot be given free-range autonomy');
      tx.update(goalDoc.ref, encodeRecord({ autonomy: enabled, updatedAt: now }));
    });
  }

  async archiveInactive(olderThanDays = 30): Promise<void> {
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0 || olderThanDays > 3650)
      throw new Error('Invalid goal archive age');
    const cutoff = new Date(this.store.now().getTime() - olderThanDays * 24 * 60 * 60 * 1000);
    const candidates = await this.store
      .collection('goals')
      .where('agentId', '==', this.configuredAgentId)
      .where('status', 'in', ['done', 'abandoned'])
      .where('archivedAt', '==', null)
      .where('updatedAt', '<', cutoff)
      .orderBy('updatedAt')
      .limit(100)
      .get();
    for (const candidate of candidates.docs) {
      const row = decodeRecord<Goal>(candidate.data());
      identity(candidate, row, row.id, this.configuredAgentId);
      await this.mutate(row.id, async ({ tx, goalDoc, goal, schedule, now }) => {
        if (
          goal.archivedAt ||
          !['done', 'abandoned'].includes(goal.status) ||
          goal.updatedAt >= cutoff
        )
          return;
        const tasks = await tx.get(
          this.store
            .collection('tasks')
            .where('goalId', '==', goal.id)
            .limit(MAX_GOAL_TASKS + 1),
        );
        if (tasks.size > MAX_GOAL_TASKS) return;
        for (const task of tasks.docs) {
          const taskRow = decodeRecord<Records['tasks']>(task.data());
          if (!taskRow.id || documentKey(taskRow.id) !== task.id)
            throw new Error('Goal task identity mismatch');
          if (
            taskRow.agentId === this.configuredAgentId &&
            taskRow.goalId === goal.id &&
            !TERMINAL_TASKS.has(taskRow.status)
          )
            return;
        }
        tx.update(goalDoc.ref, encodeRecord({ archivedAt: now, updatedAt: now }));
        if (schedule) tx.update(schedule.doc.ref, { enabled: false, updatedAt: now });
      });
    }
  }
}
