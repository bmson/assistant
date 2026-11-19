import type { ToolExecutionRepository } from '@assistant/persistence';
import { z } from 'zod';
import { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../types.js';
import {
  type CalendarToolDeps,
  registerCalendarReadTools,
  registerCalendarTools,
} from './calendar.js';
import { registerPersonalCalendarCreation } from './calendar-create.js';

export interface PersonalCalendarReadAccount {
  client: CalendarToolDeps['client'];
  subject: string;
  email: string;
  connectionId?: string;
  calendarWrite?: boolean;
}

export interface AccountAwareCalendarDeps extends CalendarToolDeps {
  /** Null means never connected. Disconnected/revoked accounts must reject. */
  personalAccount(agentId: string): Promise<PersonalCalendarReadAccount | null>;
  creationExecution?: ToolExecutionRepository;
}

const readTools = new Set([
  'calendar.availability',
  'calendar.list_calendars',
  'calendar.list_events',
  'calendar.search_events',
]);

function rosterToken(token: unknown, client: CalendarToolDeps['client']): string {
  if (typeof token !== 'string') throw new Error('Invalid calendar roster cursor.');
  const decoded = client.verifyOpaqueToken(token);
  if (decoded) {
    try {
      const data = JSON.parse(decoded) as { kind?: unknown; token?: unknown };
      if (data.kind === 'calendar-roster' && typeof data.token === 'string') return data.token;
    } catch {
      /* A different or malformed cursor is never sent to Google. */
    }
  }
  throw new Error(
    'This calendar list belongs to a different account or connection. List calendars again.',
  );
}

function bindRosterTokens(result: unknown, name: string, client: CalendarToolDeps['client']) {
  const output = { ...(result as Record<string, unknown>) };
  const fields =
    name === 'calendar.list_calendars'
      ? ['nextPageToken', 'calendarRosterNextPageToken']
      : ['calendarRosterNextPageToken'];
  for (const field of fields) {
    if (typeof output[field] === 'string') {
      output[field] = client.signOpaqueToken(
        JSON.stringify({ kind: 'calendar-roster', token: output[field] }),
      );
    }
  }
  return output;
}

/** Keep the established tool names and mutation authority while resolving reads per call. */
export function registerAccountAwareCalendarTools(
  registry: ToolRegistry,
  deps: AccountAwareCalendarDeps,
  options: { readOnly?: boolean; personalCreate?: boolean } = {},
): ToolRegistry {
  const definitions = new ToolRegistry();
  registerCalendarTools(definitions, deps, options.personalCreate ? { readOnly: false } : options);
  for (const { tool, flags } of definitions.all()) {
    if (!readTools.has(tool.name)) {
      if (tool.name === 'calendar.create_event') {
        registerPersonalCalendarCreation(
          registry,
          deps,
          { tool, flags },
          { personalOnly: options.readOnly },
        );
      } else if (!options.readOnly) {
        // Personal move/update/cancel follow in later slices. Never strip an
        // explicit personal selector and accidentally use assistant credentials.
        registry.register(
          {
            ...tool,
            inputSchema: (tool.inputSchema as z.ZodObject).safeExtend({
              account: z
                .literal('assistant')
                .optional()
                .describe('This action currently supports only the assistant account.'),
            }),
          },
          flags,
        );
      }
      continue;
    }
    const inputSchema = (tool.inputSchema as z.ZodObject).extend({
      ...(tool.name === 'calendar.list_calendars'
        ? { pageToken: z.string().max(8192).optional() }
        : {}),
      account: z
        .enum(['personal', 'assistant'])
        .optional()
        .describe(
          'Use personal for the connected personal Google account or assistant for the existing assistant account. Omit to use personal once connected, otherwise the existing source. A personal access failure never falls back.',
        ),
    });
    registry.register(
      {
        ...tool,
        inputSchema,
        description: `${tool.description} Personal Google Calendar reads remain independently available. Results identify the Google account used; select account explicitly when needed.`,
        execute: async (input: unknown, ctx: ToolContext) => {
          const { account, ...args } = inputSchema.parse(input);
          const personal = account === 'assistant' ? null : await deps.personalAccount(ctx.agentId);
          if (account === 'personal' && !personal) {
            throw new Error(
              'Connect your personal Google Calendar in Settings to read this account.',
            );
          }
          const selectedClient = personal?.client ?? deps.client;
          if (tool.name === 'calendar.list_calendars' && args.pageToken !== undefined) {
            args.pageToken = rosterToken(args.pageToken, selectedClient);
          }
          if (!personal) {
            const result = await tool.execute(args, ctx);
            return {
              ...bindRosterTokens(result, tool.name, selectedClient),
              calendarAccount: {
                kind: deps.googleAvailable === false ? 'iphone_only' : 'assistant',
                email: deps.botEmail || null,
              },
            };
          }
          const selected = new ToolRegistry();
          registerCalendarReadTools(selected, {
            ...deps,
            client: personal.client,
            googleAvailable: true,
            botEmail: '',
            ownerEmail: personal.email,
            phoneOwnerEmail: deps.phoneOwnerEmail ?? deps.ownerEmail,
          });
          const selectedTool = selected.get(tool.name);
          if (!selectedTool) throw new Error('Calendar read tool unavailable');
          const result = await selectedTool.tool.execute(args, ctx);
          return {
            ...bindRosterTokens(result, tool.name, selectedClient),
            calendarAccount: { kind: 'personal', subject: personal.subject, email: personal.email },
          };
        },
      },
      flags,
    );
  }
  return registry;
}
