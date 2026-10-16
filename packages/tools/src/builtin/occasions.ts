import { selectUpcomingOccasions } from '@assistant/core/memory/occasions';
import type { OccasionToolRepository } from '@assistant/persistence';
import { z } from 'zod';
import { register } from '../register.js';
import type { ToolRegistry } from '../registry.js';

const MAX_BIRTHDAY_OCCASION_RESULTS = 40;

/** `occasions.save` and `occasions.list` over an occasion repository instead of SQL. */
export function registerPortableOccasionTools(
  registry: ToolRegistry,
  occasions: OccasionToolRepository,
): ToolRegistry {
  register(
    registry,
    {
      name: 'occasions.save',
      description:
        "Record a recurring date for one of the owner's people — a birthday, anniversary, or custom occasion — so it can be surfaced at lead time. Give the person by name (subject), the month and day; year and gift-idea notes are optional. Re-saving the same date merges new notes and fills in a missing year.",
      inputSchema: z.object({
        subject: z.string().min(1).max(120).describe("The person's name this occasion is about."),
        kind: z.enum(['birthday', 'anniversary', 'custom']),
        label: z
          .string()
          .max(120)
          .default('')
          .describe('For a custom occasion, what it is (e.g. "graduation").'),
        month: z.number().int().min(1).max(12),
        day: z.number().int().min(1).max(31),
        year: z.number().int().min(1900).max(2200).optional(),
        leadDays: z.number().int().min(0).max(60).default(7),
        notes: z
          .string()
          .max(2000)
          .default('')
          .describe('Gift ideas or context for this occasion.'),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      approvalSummary: (args) =>
        `Remember ${args.subject}'s ${
          args.kind === 'custom' ? args.label || 'occasion' : args.kind
        } on ${args.month}/${args.day}`,
      execute: async (args, ctx) => {
        // Untrusted sessions store the occasion quarantined, exactly like memory.save.
        const quarantined = ctx.trust !== 'owner' && ctx.trust !== 'assistant';
        const result = await occasions.save({
          agentId: ctx.agentId,
          subject: args.subject,
          kind: args.kind,
          label: args.label,
          month: args.month,
          day: args.day,
          year: args.year ?? null,
          leadDays: args.leadDays,
          notes: args.notes,
          originTrust: ctx.trust,
          quarantined,
          source: 'occasions.save',
        });
        if (!result) {
          return { saved: false, note: 'could not resolve who this occasion is about' };
        }
        return { saved: result.saved, updated: !result.saved, quarantined, person: args.subject };
      },
    },
    { writesMemory: true },
  );

  register(
    registry,
    {
      name: 'occasions.list',
      description:
        "List the owner's people's upcoming occasions (birthdays, anniversaries, custom dates), soonest first. Use this to answer 'whose birthday is coming up?' or, together with memory.recall, 'what should I get them?'.",
      inputSchema: z.object({
        withinDays: z
          .number()
          .int()
          .min(1)
          .max(366)
          .default(30)
          .describe('How far ahead to look, in days.'),
      }),
      risk: 'autonomous',
      // Owner/assistant-authored reference data (quarantined occasions never
      // surface): a confidential read, but NOT untrusted content.
      acceptsUntrustedInput: true,
      execute: async (args, ctx) => {
        const upcoming = selectUpcomingOccasions(await occasions.list(ctx.agentId), {
          withinDays: args.withinDays,
          now: ctx.now(),
        });
        return {
          occasions: upcoming.map((o) => ({
            person: o.contactName,
            kind: o.kind === 'custom' ? o.label || 'occasion' : o.kind,
            date: o.nextDate,
            daysUntil: o.daysUntil,
            notes: o.notes || undefined,
          })),
        };
      },
    },
    { confidentialRead: true },
  );
  return registry;
}

/** A bounded, notes-free read used only by identity-checked family birthday recall. */
export function registerPortableBirthdayOccasionTool(
  registry: ToolRegistry,
  occasions: Pick<OccasionToolRepository, 'list'>,
): ToolRegistry {
  register(
    registry,
    {
      name: 'occasions.list_birthdays',
      description:
        'Read confirmed, recurring birthday dates only for the supplied contact IDs. This is a private fact lookup, not an upcoming-date list. Do not infer relationships from contact names.',
      inputSchema: z.object({
        contactIds: z.array(z.string().min(1).max(200)).max(20),
      }),
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      execute: async (args, ctx) => {
        const requested = new Set(args.contactIds);
        if (requested.size !== args.contactIds.length) return { birthdays: [], complete: false };
        const birthdays = (await occasions.list(ctx.agentId))
          .filter(
            (row) =>
              requested.has(row.contactId) &&
              row.kind === 'birthday' &&
              row.recurrence === 'annual' &&
              row.ownerConfirmed === true &&
              row.quarantined === false &&
              Number.isInteger(row.month) &&
              row.month >= 1 &&
              row.month <= 12 &&
              Number.isInteger(row.day) &&
              row.day >= 1 &&
              row.day <= 31 &&
              (row.year === null ||
                (Number.isInteger(row.year) && row.year >= 1000 && row.year <= 9999)),
          )
          .filter((row) => {
            const date = new Date(Date.UTC(row.year ?? 2000, row.month - 1, row.day));
            return date.getUTCMonth() === row.month - 1 && date.getUTCDate() === row.day;
          })
          .sort(
            (left, right) =>
              left.contactId.localeCompare(right.contactId) ||
              left.month - right.month ||
              left.day - right.day ||
              left.id.localeCompare(right.id),
          )
          .map((row) => ({
            id: row.id,
            contactId: row.contactId,
            person: row.contactName,
            kind: row.kind,
            month: row.month,
            day: row.day,
            year: row.year,
            recurrence: row.recurrence,
            originTrust: row.originTrust,
            ownerConfirmed: row.ownerConfirmed,
            quarantined: row.quarantined,
          }));
        const complete = birthdays.length <= MAX_BIRTHDAY_OCCASION_RESULTS;
        return {
          birthdays: birthdays.slice(0, MAX_BIRTHDAY_OCCASION_RESULTS),
          complete,
          ...(complete ? {} : { truncated: true }),
        };
      },
    },
    { confidentialRead: true },
  );
  return registry;
}
