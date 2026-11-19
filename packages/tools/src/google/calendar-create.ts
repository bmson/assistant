import { createHash, randomUUID } from 'node:crypto';
import type { ExternalEffectProgress, ToolExecutionRepository } from '@assistant/persistence';
import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import type { AssistantTool, RegisteredTool } from '../types.js';
import { assertBookingCurrent } from './calendar.js';
import type {
  AccountAwareCalendarDeps,
  PersonalCalendarReadAccount,
} from './calendar-connection.js';
import { GoogleApiError, isAmbiguousGoogleMutationError } from './client.js';
import { type GoogleEffectReceipt, PartialGoogleArtifactError } from './effect-progress.js';

const CAL = 'https://www.googleapis.com/calendar/v3';
const scopeSchema = z
  .object({
    version: z.literal(1),
    ownerId: z.string(),
    taskId: z.string(),
    connectionId: z.string().uuid(),
    subject: z.string().min(1),
    email: z.string().email(),
    calendarId: z.string().min(1),
    calendarName: z.string(),
    eventId: z.string().regex(/^[a-v0-9]{5,1024}$/),
    payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type Scope = z.infer<typeof scopeSchema>;
type Args = {
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  description: string;
  location: string;
  attendees: string[];
  account?: 'personal' | 'assistant';
  calendarId?: string;
  _approvalCalendarScope?: { seal: string; accountEmail: string; calendarName: string };
};
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function approvedDetails(a: Args) {
  return {
    account: a.account,
    calendarId: a.calendarId,
    summary: a.summary,
    start: a.start,
    end: a.end,
    allDay: a.allDay,
    description: a.description,
    location: a.location,
    attendees: a.attendees,
  };
}
function eventBody(a: Args, scope: Scope) {
  return {
    id: scope.eventId,
    summary: a.summary,
    description: a.description || undefined,
    location: a.location || undefined,
    start: a.allDay ? { date: a.start } : { dateTime: a.start },
    end: a.allDay ? { date: a.end } : { dateTime: a.end },
    attendees: a.attendees.map((email) => ({ email })),
    extendedProperties: {
      private: { assistantOperation: scope.eventId, assistantPayload: scope.payloadDigest },
    },
  };
}
function accountMatches(
  account: PersonalCalendarReadAccount | null,
  scope?: Scope,
): account is PersonalCalendarReadAccount & { connectionId: string } {
  return (
    !!account?.connectionId &&
    (!scope ||
      (account.connectionId === scope.connectionId &&
        account.subject === scope.subject &&
        account.email === scope.email))
  );
}
function boundScope(
  a: Args,
  account: PersonalCalendarReadAccount,
  ownerId: string,
  taskId: string,
): Scope {
  const encoded = a._approvalCalendarScope?.seal;
  const plaintext = encoded ? account.client.verifyOpaqueToken(encoded) : null;
  if (!plaintext)
    throw new Error(
      'Personal Calendar approval binding is missing or changed. Request fresh approval.',
    );
  const scope = scopeSchema.parse(JSON.parse(plaintext));
  if (
    !accountMatches(account, scope) ||
    scope.ownerId !== ownerId ||
    scope.taskId !== taskId ||
    scope.calendarId !== a.calendarId ||
    scope.payloadDigest !== digest(approvedDetails(a)) ||
    a._approvalCalendarScope?.accountEmail !== scope.email ||
    a._approvalCalendarScope.calendarName !== scope.calendarName
  )
    throw new Error(
      'The approved account, calendar or event details changed. Request fresh approval.',
    );
  return scope;
}
function canonicalResult(
  event: Record<string, unknown>,
  a: Args,
  scope: Scope,
  toolCallId?: string,
) {
  const start = event.start as { date?: string; dateTime?: string } | undefined;
  const end = event.end as { date?: string; dateTime?: string } | undefined;
  const props = (event.extendedProperties as { private?: Record<string, string> } | undefined)
    ?.private;
  const attendees = event.attendees as Array<{ email?: string }> | undefined;
  const emails = (attendees ?? []).map((x) => String(x.email ?? '').toLowerCase()).sort();
  const expected = a.attendees.map((x) => x.toLowerCase()).sort();
  const sameTime = a.allDay
    ? start?.date === a.start && end?.date === a.end && !start?.dateTime && !end?.dateTime
    : !!start?.dateTime &&
      !!end?.dateTime &&
      !start.date &&
      !end.date &&
      Date.parse(start.dateTime) === Date.parse(a.start) &&
      Date.parse(end.dateTime) === Date.parse(a.end);
  const link = typeof event.htmlLink === 'string' ? new URL(event.htmlLink) : null;
  if (
    event.id !== scope.eventId ||
    !['confirmed', 'tentative'].includes(String(event.status)) ||
    event.summary !== a.summary ||
    (event.description ?? '') !== a.description ||
    (event.location ?? '') !== a.location ||
    !sameTime ||
    event.attendeesOmitted === true ||
    JSON.stringify(emails) !== JSON.stringify(expected) ||
    props?.assistantOperation !== scope.eventId ||
    props?.assistantPayload !== scope.payloadDigest ||
    !link ||
    link.protocol !== 'https:' ||
    !['www.google.com', 'calendar.google.com'].includes(link.hostname)
  )
    throw new Error('Canonical Calendar event does not match the approved operation.');
  return {
    effectStatus: 'completed',
    eventId: scope.eventId,
    calendarId: scope.calendarId,
    calendarAccount: {
      kind: 'personal',
      connectionId: scope.connectionId,
      subject: scope.subject,
      email: scope.email,
    },
    summary: a.summary,
    start: event.start,
    end: event.end,
    invited: a.attendees,
    link: link.href,
    sameOperationReadback: true,
    ...(toolCallId ? { toolCallId } : {}),
  };
}
async function readCanonical(
  account: PersonalCalendarReadAccount,
  a: Args,
  scope: Scope,
  callId?: string,
) {
  const event = await account.client.api<Record<string, unknown>>(
    `${CAL}/calendars/${encodeURIComponent(scope.calendarId)}/events/${scope.eventId}`,
  );
  return canonicalResult(event, a, scope, callId);
}

/** Extends the existing mutation; default assistant behavior remains unchanged. */
export function registerPersonalCalendarCreation(
  registry: ToolRegistry,
  deps: AccountAwareCalendarDeps,
  original: RegisteredTool,
  options: { personalOnly?: boolean } = {},
): void {
  const inputSchema = (original.tool.inputSchema as z.ZodObject).safeExtend({
    account: z
      .enum(['assistant', 'personal'])
      .default(options.personalOnly ? 'personal' : 'assistant'),
    calendarId: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe(
        'For personal creation, select an explicit ID returned by calendar.list_calendars. primary resolves to its stable ID before approval.',
      ),
  });
  const tool: AssistantTool = {
    ...original.tool,
    inputSchema,
    description: `${original.tool.description} To create on your connected personal account, explicitly set account=personal and calendarId from its roster. Optional event-write access and an approval of these exact details are required. An uncertain outcome must be reconciled, never blindly recreated.`,
    risk: (input, ctx) => {
      const args = input as Args;
      return args.account === 'personal'
        ? 'approval'
        : typeof original.tool.risk === 'function'
          ? original.tool.risk(input, ctx)
          : original.tool.risk;
    },
    prepareSecurity: async (input, ctx, phase) => {
      const a = input as Args;
      if (a.account !== 'personal') {
        if (options.personalOnly)
          throw new Error('Assistant Calendar credentials are unavailable.');
        if (a.calendarId && a.calendarId !== 'primary')
          throw new Error('Assistant creation uses only its existing primary calendar.');
        return input;
      }
      const account = await deps.personalAccount(ctx.agentId);
      if (!accountMatches(account) || account.calendarWrite !== true)
        throw new Error(
          'Enable optional Calendar event-write access for your personal account first.',
        );
      if (phase === 'approved') {
        boundScope(a, account, ctx.agentId, ctx.taskId);
        return input;
      }
      if (!a.calendarId) throw new Error('Select a personal destination calendar before approval.');
      if (
        Date.parse(a.end) <= Date.parse(a.start) ||
        !Number.isFinite(Date.parse(a.start)) ||
        !Number.isFinite(Date.parse(a.end))
      )
        throw new Error('Event end must be after its start.');
      if (
        a.allDay &&
        (new Date(a.start).toISOString().slice(0, 10) !== a.start ||
          new Date(a.end).toISOString().slice(0, 10) !== a.end)
      )
        throw new Error('All-day events require real calendar dates.');
      if (new Set(a.attendees.map((x) => x.toLowerCase())).size !== a.attendees.length)
        throw new Error('Event attendees must be unique.');
      const calendar = await account.client.api<{
        id?: string;
        summary?: string;
        accessRole?: string;
      }>(`${CAL}/users/me/calendarList/${encodeURIComponent(a.calendarId)}`);
      if (
        !calendar.id ||
        !['owner', 'writer'].includes(calendar.accessRole ?? '') ||
        (a.calendarId !== 'primary' && calendar.id !== a.calendarId)
      )
        throw new Error('The selected personal calendar is not writable.');
      a.calendarId = calendar.id;
      // UUID identity is allocated once before approval and then retained in the call.
      // Google accepts base32hex; lowercase UUID hex is a subset of that alphabet.
      const eventId = `ac${randomUUID().replaceAll('-', '')}`;
      const scope: Scope = {
        version: 1,
        ownerId: ctx.agentId,
        taskId: ctx.taskId,
        connectionId: account.connectionId,
        subject: account.subject,
        email: account.email,
        calendarId: calendar.id,
        calendarName: calendar.summary || calendar.id,
        eventId,
        payloadDigest: digest(approvedDetails(a)),
      };
      a._approvalCalendarScope = {
        seal: account.client.signOpaqueToken(JSON.stringify(scope)),
        accountEmail: scope.email,
        calendarName: scope.calendarName,
      };
      return input;
    },
    approvalSummary: (input) => {
      const a = input as Args;
      return a.account === 'personal'
        ? `Create "${a.summary}" on ${a._approvalCalendarScope?.calendarName} (${a.calendarId}), personal account ${a._approvalCalendarScope?.accountEmail}; ${a.start} to ${a.end}; attendees: ${a.attendees.join(', ') || 'none'}`
        : (original.tool.approvalSummary?.(input) ?? 'Create assistant Calendar event');
    },
    idempotencyKey: (input, ctx) => {
      const a = input as Args;
      return a.account === 'personal'
        ? `personal-cal-create-${digest([ctx.agentId, ctx.taskId, a._approvalCalendarScope])}`
        : (original.tool.idempotencyKey?.(input, ctx) ?? '');
    },
    execute: async (input, ctx) => {
      const a = input as Args;
      if (a.account !== 'personal') {
        if (options.personalOnly || (a.calendarId && a.calendarId !== 'primary'))
          throw new Error('Assistant Calendar destination is unavailable.');
        return original.tool.execute(input, ctx);
      }
      if (!ctx.execution || !ctx.checkpointExternalEffect)
        throw new Error('Personal Calendar creation requires a durable approved execution.');
      const account = await deps.personalAccount(ctx.agentId);
      if (!accountMatches(account) || account.calendarWrite !== true)
        throw new Error('Personal Calendar write access is unavailable.');
      const scope = boundScope(a, account, ctx.agentId, ctx.taskId);
      await assertBookingCurrent(ctx);
      const progress: GoogleEffectReceipt = {
        provider: 'google',
        kind: 'calendar_event',
        objectId: scope.eventId,
        stage: 'prepared',
      };
      await ctx.checkpointExternalEffect(progress);
      await assertBookingCurrent(ctx);
      try {
        await account.client.api(
          `${CAL}/calendars/${encodeURIComponent(scope.calendarId)}/events?sendUpdates=all`,
          { method: 'POST', body: JSON.stringify(eventBody(a, scope)), signal: ctx.signal },
        );
        progress.stage = 'created';
        await ctx.checkpointExternalEffect(progress);
      } catch (error) {
        // A transport/5xx loss or an existing fixed ID is reconciled by GET only.
        // No error path issues another POST. Definitive provider rejection stays failed.
        if (
          !(
            isAmbiguousGoogleMutationError(error) ||
            (error instanceof GoogleApiError && error.status === 409)
          ) &&
          progress.stage !== 'created'
        )
          throw error;
      }
      try {
        const result = await readCanonical(account, a, scope, ctx.execution.dbToolCallId);
        if (progress.stage === 'prepared') {
          progress.stage = 'created';
          await ctx.checkpointExternalEffect(progress);
        }
        progress.stage = 'verified';
        await ctx.checkpointExternalEffect(progress);
        return { ...result, originalTaskId: ctx.taskId };
      } catch (error) {
        throw new PartialGoogleArtifactError(progress, error);
      }
    },
  };
  registry.register(tool, {
    ...original.flags,
    ownerVisibleOnly: (args) =>
      (args as Args).account !== 'personal' &&
      (typeof original.flags.ownerVisibleOnly === 'function'
        ? original.flags.ownerVisibleOnly(args)
        : original.flags.ownerVisibleOnly === true),
  });
  if (deps.creationExecution)
    registerReconciliation(registry, deps, deps.creationExecution, inputSchema);
}

function registerReconciliation(
  registry: ToolRegistry,
  deps: AccountAwareCalendarDeps,
  execution: ToolExecutionRepository,
  createSchema: z.ZodType,
) {
  registry.register(
    {
      name: 'calendar.reconcile_event_creation',
      description:
        'Read back one original approved personal Calendar creation after interruption or an uncertain result. Use its original taskId and toolCallId. This never creates, retries or changes an event; a missing event remains uncertain.',
      inputSchema: z.object({ taskId: z.string().uuid(), toolCallId: z.string().uuid() }),
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (input, ctx) => {
        const args = input as { taskId: string; toolCallId: string };
        const loaded = await execution.load(ctx.agentId, args.taskId, args.toolCallId);
        if (
          loaded?.toolCall.toolName !== 'calendar.create_event' ||
          loaded.approval?.status !== 'approved' ||
          !['executing', 'succeeded', 'failed'].includes(loaded.toolCall.status)
        )
          throw new Error('Original approved personal Calendar operation not found.');
        const stored = loaded.toolCall.args as Record<string, unknown>;
        const original = {
          ...(createSchema.parse(stored) as Args),
          _approvalCalendarScope: stored._approvalCalendarScope as Args['_approvalCalendarScope'],
        };
        if (original.account !== 'personal')
          throw new Error('This is not a personal Calendar operation.');
        const account = await deps.personalAccount(ctx.agentId);
        if (!accountMatches(account))
          throw new Error('Original personal account is unavailable; no fallback or retry.');
        const scope = boundScope(original, account, ctx.agentId, args.taskId);
        const progress = (
          loaded.toolCall.decision as { externalEffect?: ExternalEffectProgress } | null
        )?.externalEffect;
        if (
          progress?.kind !== 'calendar_event' ||
          progress.provider !== 'google' ||
          !['prepared', 'created', 'verified'].includes(progress.stage) ||
          progress.payloadDigest !== digest(stored) ||
          progress.objectId !== scope.eventId
        )
          throw new Error(
            'Original provider operation was not checkpointed. No create was attempted by reconciliation.',
          );
        try {
          return {
            ...(await readCanonical(account, original, scope, args.toolCallId)),
            originalTaskId: args.taskId,
          };
        } catch {
          return {
            effectStatus: 'unknown',
            retrySuppressed: true,
            eventId: scope.eventId,
            calendarId: scope.calendarId,
            originalTaskId: args.taskId,
            toolCallId: args.toolCallId,
            note: 'Completion of the original Calendar operation could not be confirmed. No event was created or retried.',
          };
        }
      },
    },
    { confidentialRead: true, returnsUntrustedContent: true },
  );
}
