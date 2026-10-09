import { createHash, randomUUID } from 'node:crypto';
import {
  cancelNamedReminder,
  getAgent,
  listReminderSchedules,
  nextRun,
  reminderScheduleIsActive,
  reminderScheduleTemplate,
  scheduleRepository,
  upsertSchedule,
} from '@assistant/core';
import type {
  ReminderRepository,
  ScheduleRecord,
  ScheduleRepository,
} from '@assistant/persistence';
import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { AssistantTool, ToolFlags } from './types.js';

const REMINDER_PREFIX = 'reminder:';
function intentHash(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, row) =>
    row && typeof row === 'object' && !Array.isArray(row)
      ? Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))
      : row,
  );
  return createHash('sha256').update(canonical).digest('hex');
}
function reminderReceipt(row: ScheduleRecord, expectedIntent: string) {
  const template = reminderScheduleTemplate(row.taskTemplate);
  if (template.reminderIntentHash !== expectedIntent)
    throw new Error('Reminder operation already has different input');
  const active = reminderScheduleIsActive(row);
  return {
    reminderId: row.id,
    created: true,
    enabled: active,
    kind: template.reminderKind,
    ...(template.reminderKind === 'recurring' || template.reminderKind === 'event_completion'
      ? { cron: row.cron }
      : {}),
    nextFires: active ? (row.nextRunAt?.toISOString() ?? null) : null,
    firstFires: template.reminderFirstFiresAt,
    timezone: template.timezone,
    text: template.reminderText,
  };
}

/** A valid placeholder cron for a one-time row; nextRunAt remains authoritative. */
function cronForInstant(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  return `${part('minute')} ${part('hour')} ${part('day')} ${part('month')} *`;
}

function register<S extends z.ZodType, Out>(
  registry: ToolRegistry,
  tool: AssistantTool<S, Out>,
  flags: ToolFlags = {},
) {
  registry.register(tool as unknown as AssistantTool, flags);
}

/** Build a 5-field cron from a HH:MM time and optional weekday list (0=Sun). */
function cronFromTime(time: string, weekdays?: number[]): string {
  const [hour, minute] = time.split(':').map((n) => Number.parseInt(n, 10));
  const dow = weekdays && weekdays.length > 0 ? [...new Set(weekdays)].sort().join(',') : '*';
  return `${minute} ${hour} * * ${dow}`;
}

/**
 * Recurring reminders. Distinct from goals (open-ended work) and watches
 * (sender-triggered): a reminder is a cron that fires a tiny scheduled task
 * which just calls owner.notify with the reminder text. When created from a
 * chat, it fires back into that conversation; otherwise into the Notifications
 * thread (owner.notify's default sink). Registered unconditionally — no provider
 * needed.
 */
export interface PortableReminderTools {
  schedules: ScheduleRepository;
  reminders: ReminderRepository;
  getTimezone(agentId: string): Promise<string>;
}

export function registerReminderTools(
  registry: ToolRegistry,
  portable?: PortableReminderTools,
): ToolRegistry {
  const createSchema = z
    .object({
      text: z.string().min(1).max(500),
      /** A raw 5-field cron, OR the time+weekdays convenience below. */
      cron: z.string().min(9).max(100).optional(),
      time: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM 24-hour')
        .optional(),
      weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
      /** Exact instant for a reminder that fires once. */
      at: z.string().datetime({ offset: true }).optional(),
      /** Relative one-time delay, resolved by the server clock. */
      inMinutes: z
        .number()
        .int()
        .min(1)
        .max(7 * 24 * 60)
        .optional(),
      /** Exact fixture ID copied from a successful current-task sports.scores result. */
      afterEventId: z.string().min(1).max(40).optional(),
    })
    .superRefine((args, refinement) => {
      const oneTimeInputs = Number(Boolean(args.at)) + Number(Boolean(args.inMinutes));
      const recurringInputs = Number(Boolean(args.cron)) + Number(Boolean(args.time));
      if (args.afterEventId) {
        if (oneTimeInputs + recurringInputs > 0)
          refinement.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'event-completion reminders cannot also set a fixed or recurring schedule',
          });
        return;
      }
      if (oneTimeInputs + recurringInputs > 1) {
        refinement.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'provide exactly one reminder schedule: at/inMinutes, cron, or time',
        });
      } else if (oneTimeInputs + recurringInputs !== 1) {
        refinement.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'provide exactly one of at, inMinutes, cron, or time',
        });
      }
    });

  register(
    registry,
    {
      name: 'reminder.create',
      description:
        'Create a reminder. Ordinary requests such as "remind me tomorrow at 9" fire ONCE: pass an ISO 8601 instant with offset in at, or inMinutes for "in 10 minutes" so the server resolves the delay against the original owner request clock. Only when the owner explicitly asks to repeat should you pass a 5-field cron, or time ("HH:MM", owner timezone) with optional weekdays (0=Sun..6=Sat; omit only for explicitly daily reminders). Do not also call task.schedule for an ordinary reminder. If a reminder depends on an event actually finishing, do not guess its scheduled end; ask whether that fixed time is acceptable. Open-ended work is a goal, not a reminder.',
      inputSchema: createSchema,
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (args, ctx) => {
        const hash = intentHash(args);
        const identity = ctx.execution
          ? intentHash([ctx.agentId, ctx.taskId, ctx.execution.dbToolCallId, 'reminder.create'])
          : randomUUID();
        const name = `${REMINDER_PREFIX}${identity}`;
        const existing = await scheduleRepository(portable?.schedules ?? ctx.db).getByName(
          ctx.agentId,
          name,
        );
        if (existing) return reminderReceipt(existing, hash);
        const timezone =
          ctx.requestTimeZone ??
          (portable ? await portable.getTimezone(ctx.agentId) : (await getAgent(ctx.db)).timezone);
        if (args.afterEventId) {
          const dependency = ctx.verifiedReminderEvent;
          if (!dependency || dependency.eventId !== args.afterEventId)
            throw new Error(
              'The requested fixture is not bound to a successful current-task sports result.',
            );
          const startsAt = Date.parse(dependency.startsAt);
          if (!Number.isFinite(startsAt)) throw new Error('The fixture start time is invalid.');
          const firstCheck = new Date(Math.max(ctx.now().getTime(), startsAt));
          const cron = '*/15 * * * *';
          const row = await upsertSchedule(portable?.schedules ?? ctx.db, {
            agentId: ctx.agentId,
            name,
            cron,
            timezone,
            nextRunAt: firstCheck,
            taskTemplate: {
              type: 'scheduled',
              job: 'reminder.notify',
              maxSteps: 3,
              budgetUsdLimit: '0.05',
              reminderIntentHash: hash,
              reminderFirstFiresAt: firstCheck.toISOString(),
              reminderKind: 'event_completion',
              reminderText: args.text,
              reminderEventDependency: dependency,
              timezone,
              instruction: `Wait for the verified game ${dependency.homeTeam} vs ${dependency.awayTeam} to finish, then notify the owner: ${args.text}`,
              ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
            },
          });
          return reminderReceipt(row, hash);
        }
        const relativeFiresAt = args.inMinutes
          ? new Date((ctx.requestAt ?? ctx.now()).getTime() + args.inMinutes * 60 * 1000)
          : undefined;
        const oneTimeAt = args.at ? new Date(args.at) : relativeFiresAt;
        if (oneTimeAt) {
          const firesAt = oneTimeAt;
          if (firesAt.getTime() <= ctx.now().getTime()) {
            throw new Error(
              args.inMinutes
                ? 'request-relative reminder time has already passed; ask the owner to confirm a new time'
                : 'one-time reminder must be in the future',
            );
          }
          const cron = cronForInstant(firesAt, timezone);
          const row = await upsertSchedule(portable?.schedules ?? ctx.db, {
            agentId: ctx.agentId,
            name,
            cron,
            timezone,
            nextRunAt: firesAt,
            taskTemplate: {
              type: 'scheduled',
              job: 'reminder.notify',
              maxSteps: 3,
              budgetUsdLimit: '0.05',
              reminderIntentHash: hash,
              reminderFirstFiresAt: firesAt.toISOString(),
              reminderKind: 'once',
              reminderText: args.text,
              timezone,
              instruction: `Reminder for the owner: ${args.text}\n\nCall owner.notify once with exactly this reminder text, then finish. Do nothing else.`,
              ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
            },
          });
          return reminderReceipt(row, hash);
        }
        const cron = args.cron ?? cronFromTime(args.time as string, args.weekdays);
        // Validate the cron by computing its next run; nextRun throws if invalid.
        const next = nextRun(cron, timezone);
        const row = await upsertSchedule(portable?.schedules ?? ctx.db, {
          agentId: ctx.agentId,
          name,
          cron,
          timezone,
          taskTemplate: {
            type: 'scheduled',
            job: 'reminder.notify',
            maxSteps: 3,
            budgetUsdLimit: '0.05',
            reminderIntentHash: hash,
            reminderFirstFiresAt: next.toISOString(),
            reminderKind: 'recurring',
            timezone,
            reminderText: args.text,
            instruction: `Reminder for the owner: ${args.text}\n\nCall owner.notify once with exactly this reminder text, then finish. Do nothing else.`,
            // Fire back into the originating chat when there is one.
            ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
          },
        });
        return reminderReceipt(row, hash);
      },
    },
    { privateWrite: true },
  );

  register(
    registry,
    {
      name: 'reminder.list',
      description: "List the owner's active one-time and recurring reminders and when each fires.",
      inputSchema: z.object({}),
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (_args, ctx) => {
        const timezone = portable
          ? await portable.getTimezone(ctx.agentId)
          : (await getAgent(ctx.db)).timezone;
        const rows = await listReminderSchedules(portable?.schedules ?? ctx.db, ctx.agentId);
        rows.sort(
          (a, b) =>
            Number(b.enabled) - Number(a.enabled) ||
            (a.nextRunAt?.getTime() ?? Number.POSITIVE_INFINITY) -
              (b.nextRunAt?.getTime() ?? Number.POSITIVE_INFINITY) ||
            a.id.localeCompare(b.id),
        );
        return {
          reminders: rows.filter(reminderScheduleIsActive).map((r) => ({
            reminderId: r.id,
            text: reminderScheduleTemplate(r.taskTemplate).reminderText ?? '',
            kind: reminderScheduleTemplate(r.taskTemplate).reminderKind ?? 'recurring',
            cron: r.cron,
            timezone,
            enabled: r.enabled,
            nextFires: r.enabled ? (r.nextRunAt?.toISOString() ?? null) : null,
          })),
        };
      },
    },
    { confidentialRead: true },
  );

  register(
    registry,
    {
      name: 'reminder.cancel',
      description:
        'Remove a reminder by id or by the owner\'s words, such as "the sunglasses reminder". Prefer query when the owner names the reminder naturally. A unique exact or partial text match is cancelled; ambiguous matches are returned so you can ask which one. Never say it was removed unless cancelled is true.',
      inputSchema: z
        .object({
          reminderId: z.string().uuid().optional(),
          query: z.string().min(1).max(500).optional(),
        })
        .refine((args) => Boolean(args.reminderId) !== Boolean(args.query), {
          message: 'provide exactly one of reminderId or query',
        }),
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (args, ctx) => {
        return cancelNamedReminder(portable ?? ctx.db, ctx.agentId, args, ctx.now());
      },
    },
    { privateWrite: true },
  );

  return registry;
}
