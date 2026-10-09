import { createHash } from 'node:crypto';
import {
  type ApplicationConfirmationRepository,
  applicationExternalEffectArgsDigest,
  applicationExternalEffectToolIdentity,
  type TaskRepository,
} from '@assistant/persistence';
import { z } from 'zod';
import type { GoogleClient } from './google/client.js';
import { buildContentRequests, type DocsDocument, endInsertIndex } from './google/docs.js';
import { a1Range } from './google/sheets.js';
import type { ToolRegistry } from './registry.js';
import type { AssistantTool, ToolFlags } from './types.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DOCS = 'https://docs.googleapis.com/v1/documents';
const MAX_WATCH_DAYS = 90;

const spreadsheetId = z.string().regex(/^[a-zA-Z0-9_-]{10,200}$/, 'not a Google spreadsheet id');
const sheetName = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => !/[[\]:*?/\\]/.test(value), 'sheet name contains a reserved character');
const startCell = z
  .string()
  .regex(/^[A-Z]{1,3}[1-9]\d{0,6}$/, 'startCell must be an A1 cell such as A2');
const cell = z.union([z.string().max(10_000), z.number().finite(), z.boolean(), z.null()]);

/** A fixed, deliberately small Sheet mutation approved before external mail arrives. */
export const ApplicationTrackerUpdateSchema = z.object({
  spreadsheetId,
  sheetName,
  startCell,
  rows: z.array(z.array(cell).min(1).max(50)).min(1).max(10),
});

export type ApplicationTrackerUpdate = z.infer<typeof ApplicationTrackerUpdateSchema>;

const documentId = z.string().regex(/^[a-zA-Z0-9_-]{10,200}$/, 'not a Google document id');

/** Fixed Google Doc append approved before external mail arrives. */
export const ApplicationDocumentUpdateSchema = z.object({
  documentId,
  content: z.string().trim().min(1).max(20_000),
});

export type ApplicationDocumentUpdate = z.infer<typeof ApplicationDocumentUpdateSchema>;

const ApplicationActionEffectReceiptSchema = z.object({
  claimToken: z.string().uuid(),
  producerPrivacyGeneration: z.string().nullable(),
  argsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  taskId: z.string().uuid(),
  toolCallId: z.string().uuid(),
  toolName: z.string().max(100),
  idempotencyKey: z.string().max(300),
});

export const ApplicationActionOutcomeSchema = z.object({
  status: z.enum(['pending', 'succeeded', 'failed', 'unknown']),
  error: z.string().max(2_000).optional(),
  effectReceipt: ApplicationActionEffectReceiptSchema.optional(),
});

export const ApplicationActionStateSchema = z.object({
  sheet: ApplicationActionOutcomeSchema.optional(),
  document: ApplicationActionOutcomeSchema.optional(),
});

export type ApplicationActionState = z.infer<typeof ApplicationActionStateSchema>;

export function parseApplicationActionState(value: unknown): ApplicationActionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const action = (key: 'sheet' | 'document') => {
    const raw = input[key];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const outcome = raw as Record<string, unknown>;
    const status = z.enum(['pending', 'succeeded', 'failed', 'unknown']).safeParse(outcome.status);
    if (!status.success) {
      return {
        status: 'unknown' as const,
        error: 'Stored action state is malformed; automatic retry is suppressed.',
      };
    }
    const receipt = ApplicationActionEffectReceiptSchema.safeParse(outcome.effectReceipt);
    if (outcome.effectReceipt !== undefined && !receipt.success) {
      return {
        status: status.data === 'pending' ? ('unknown' as const) : status.data,
        error: 'Stored effect receipt is malformed; automatic retry is suppressed.',
      };
    }
    return {
      status: status.data,
      ...(typeof outcome.error === 'string' ? { error: outcome.error.slice(0, 2_000) } : {}),
      ...(receipt.success ? { effectReceipt: receipt.data } : {}),
    };
  };
  const sheet = action('sheet');
  const document = action('document');
  return {
    ...(sheet ? { sheet } : {}),
    ...(document ? { document } : {}),
  };
}

function publicActionState(value: unknown): ApplicationActionState {
  const state = parseApplicationActionState(value);
  const project = (action: ApplicationActionState['sheet']) =>
    action
      ? { status: action.status, ...(action.error ? { error: action.error } : {}) }
      : undefined;
  return {
    ...(state.sheet ? { sheet: project(state.sheet) } : {}),
    ...(state.document ? { document: project(state.document) } : {}),
  };
}

const confirmationToken = z
  .string()
  .trim()
  .min(6)
  .max(100)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]+$/,
    'confirmationToken must be an opaque receipt or requisition id using letters, numbers, _ or -',
  )
  .transform((value) => value.toUpperCase());

const watchSchema = z
  .object({
    company: z.string().trim().min(1).max(200),
    role: z.string().trim().min(1).max(200),
    expectedSenderEmails: z
      .array(z.string().trim().toLowerCase().email())
      .min(1)
      .max(5)
      .transform((values) => [...new Set(values)]),
    confirmationToken,
    expiresAt: z.string().datetime({ offset: true }),
    trackerUpdate: ApplicationTrackerUpdateSchema.optional(),
    documentUpdate: ApplicationDocumentUpdateSchema.optional(),
  })
  .refine((value) => value.trackerUpdate || value.documentUpdate, {
    message: 'at least one trackerUpdate or documentUpdate is required',
  });

const applySchema = z.object({ applicationId: z.string().uuid() });
const listSchema = z.object({
  status: z
    .enum([
      'awaiting_confirmation',
      'confirmation_received',
      'updated',
      'partially_updated',
      'update_unknown',
      'update_failed',
      'cancelled',
      'expired',
    ])
    .optional(),
});

export function hashConfirmationToken(token: string): string {
  return createHash('sha256').update(token.trim().toUpperCase()).digest('hex');
}

function literalRows(rows: ApplicationTrackerUpdate['rows']) {
  // Google RAW input prevents confirmation text beginning with '=' from
  // becoming a formula in the owner's tracker.
  return rows.map((row) => row.map((value) => value ?? ''));
}

function approvedActionSummary(input: z.infer<typeof watchSchema>): string {
  const actions = [
    input.trackerUpdate
      ? `update ${input.trackerUpdate.sheetName}!${input.trackerUpdate.startCell}`
      : undefined,
    input.documentUpdate
      ? `append to Google Doc ${input.documentUpdate.documentId.slice(0, 8)}…`
      : undefined,
  ].filter((value): value is string => Boolean(value));
  return actions.join(' and ');
}

function register<S extends z.ZodType, Out>(
  registry: ToolRegistry,
  tool: AssistantTool<S, Out>,
  flags: ToolFlags = {},
) {
  registry.register(tool as unknown as AssistantTool, flags);
}

export interface ApplicationToolDeps {
  client: GoogleClient;
  applications: ApplicationConfirmationRepository;
  tasks: Pick<TaskRepository, 'getTask'>;
}

/**
 * Register the two halves of the confirmation bridge:
 * 1. an owner-approved watch containing every future side-effect argument;
 * 2. an internal-only execution guarded by the exact deterministic event.
 */
export function registerApplicationTools(
  registry: ToolRegistry,
  deps: ApplicationToolDeps,
): ToolRegistry {
  register(
    registry,
    {
      name: 'applications.watch_confirmation',
      description:
        'After a portal has verifiably accepted a job application, watch for one later confirmation email and perform exact pre-authorized Google Sheet and/or Google Doc updates automatically. Requires the authenticated sender email, an opaque receipt or requisition token, an expiry, and every literal destination/value/content. Always requires owner approval.',
      inputSchema: watchSchema,
      risk: 'approval',
      acceptsUntrustedInput: true,
      approvalSummary: (args) => {
        const input = args as z.infer<typeof watchSchema>;
        return `Watch ${input.expectedSenderEmails.join(', ')} for ${input.company} — ${input.role}, then ${approvedActionSummary(input)}`;
      },
      idempotencyKey: (args, ctx) => {
        const input = args as z.infer<typeof watchSchema>;
        return `application-watch-${ctx.taskId}-${hashConfirmationToken(input.confirmationToken)}`;
      },
      execute: async (args, ctx) => {
        const expiresAt = new Date(args.expiresAt);
        const remainingMs = expiresAt.getTime() - ctx.now().getTime();
        if (remainingMs < 5 * 60_000) {
          throw new Error('application confirmation watch must remain open for at least 5 minutes');
        }
        if (remainingMs > MAX_WATCH_DAYS * 24 * 60 * 60_000) {
          throw new Error(`application confirmation watch cannot exceed ${MAX_WATCH_DAYS} days`);
        }

        const record = await deps.applications.createWatch({
          agentId: ctx.agentId,
          sourceTaskId: ctx.taskId,
          conversationId: ctx.conversationId ?? null,
          newConversationTitle: `${args.company} — ${args.role}`.slice(0, 80),
          company: args.company,
          role: args.role,
          expectedSenderEmails: args.expectedSenderEmails,
          confirmationTokenHash: hashConfirmationToken(args.confirmationToken),
          confirmationTokenHint: args.confirmationToken.slice(-4),
          trackerUpdate: args.trackerUpdate,
          documentUpdate: args.documentUpdate,
          actionState: {
            ...(args.trackerUpdate ? { sheet: { status: 'pending' as const } } : {}),
            ...(args.documentUpdate ? { document: { status: 'pending' as const } } : {}),
          },
          expiresAt,
        });
        return {
          applicationId: record.id,
          company: record.company,
          role: record.role,
          expectedSenderEmails: record.expectedSenderEmails,
          tokenHint: record.confirmationTokenHint,
          expiresAt: record.expiresAt.toISOString(),
          trackerUpdate: record.trackerUpdate,
          documentUpdate: record.documentUpdate,
          actionState: record.actionState,
          conversationId: record.conversationId,
          status: record.status,
        };
      },
    },
    { privateWrite: true, blanketAllowIneligible: true },
  );

  register(
    registry,
    {
      name: 'applications.list_confirmations',
      description:
        'List owner-approved application confirmation watches, their per-action status, expiry, sender, masked token, and Sheet/Doc targets. Use this before cancelling or explaining an automated follow-up.',
      inputSchema: listSchema,
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (args, ctx) => {
        const rows = await deps.applications.list(ctx.agentId, args.status);
        return {
          confirmations: rows.map((row) => {
            const tracker = row.trackerUpdate
              ? ApplicationTrackerUpdateSchema.parse(row.trackerUpdate)
              : undefined;
            const document = row.documentUpdate
              ? ApplicationDocumentUpdateSchema.parse(row.documentUpdate)
              : undefined;
            return {
              applicationId: row.id,
              company: row.company,
              role: row.role,
              status: row.status,
              expectedSenderEmails: row.expectedSenderEmails,
              tokenHint: row.confirmationTokenHint,
              expiresAt: row.expiresAt.toISOString(),
              trackerTarget: tracker ? `${tracker.sheetName}!${tracker.startCell}` : undefined,
              documentTarget: document?.documentId,
              actionState: publicActionState(row.actionState),
              confirmedAt: row.confirmedAt?.toISOString(),
              lastError: row.lastError,
            };
          }),
        };
      },
    },
    { confidentialRead: true },
  );

  register(
    registry,
    {
      name: 'applications.cancel_confirmation',
      description:
        'Cancel one pending application confirmation watch by id. Cancellation succeeds only before a matching email has been claimed; it never races or reverses an already-started Sheet or Doc action.',
      inputSchema: applySchema,
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      execute: async (args, ctx) => {
        const result = await deps.applications.cancel(ctx.agentId, args.applicationId, ctx.now());
        if (!result) throw new Error('application confirmation watch not found');
        if (result.cancelled)
          return { applicationId: result.id, status: 'cancelled', cancelled: true };
        return {
          applicationId: result.id,
          status: result.status,
          cancelled: false,
          reason: 'the email was already claimed or the watch is no longer active',
        };
      },
    },
    { privateWrite: true },
  );

  register(
    registry,
    {
      name: 'applications.apply_confirmation',
      description:
        'Internal Sheet confirmation worker. It can execute only the exact pre-authorized application record carried by a verified internal event.',
      inputSchema: applySchema,
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      idempotencyKey: (args) => {
        const input = args as z.infer<typeof applySchema>;
        return `application-confirmation-apply-${input.applicationId}`;
      },
      execute: async (args, ctx) => {
        const task = await deps.tasks.getTask(ctx.taskId);
        const trigger = task?.trigger as
          | { source?: unknown; payload?: Record<string, unknown> }
          | undefined;
        if (
          task?.agentId !== ctx.agentId ||
          trigger?.source !== 'internal' ||
          trigger.payload?.kind !== 'application_confirmation' ||
          trigger.payload.applicationId !== args.applicationId
        ) {
          throw new Error(
            'application confirmation tool requires its exact verified internal event',
          );
        }

        const record = await deps.applications.get(args.applicationId);
        if (!record || record.agentId !== ctx.agentId || record.status !== 'confirmation_received')
          throw new Error('application confirmation is not ready to apply');
        const update = ApplicationTrackerUpdateSchema.parse(record.trackerUpdate);
        const actionState = parseApplicationActionState(record.actionState);
        if (actionState.sheet?.status === 'succeeded') {
          return {
            applicationId: record.id,
            action: 'sheet',
            status: 'succeeded',
            alreadyApplied: true,
          };
        }
        if (actionState.sheet?.status === 'failed' || actionState.sheet?.status === 'unknown') {
          throw new Error(
            `Sheet confirmation action is ${actionState.sheet.status}; automatic retry is forbidden`,
          );
        }

        const identity = applicationExternalEffectToolIdentity('sheet', record.id);
        if (
          !ctx.execution ||
          ctx.execution.toolName !== identity.toolName ||
          !ctx.execution.dbToolCallId ||
          !ctx.taskLeaseToken
        )
          throw new Error('Sheet confirmation requires a persisted executing tool call');
        const claim = await deps.applications.claimExternalEffect({
          agentId: ctx.agentId,
          applicationId: record.id,
          action: 'sheet',
          expectedProducerPrivacyGeneration: record.producerPrivacyGeneration ?? null,
          taskId: ctx.taskId,
          taskLeaseToken: ctx.taskLeaseToken,
          toolCallId: ctx.execution.dbToolCallId,
          toolName: identity.toolName,
          idempotencyKey: identity.idempotencyKey,
          argsDigest: applicationExternalEffectArgsDigest('sheet', update),
          now: ctx.now(),
        });
        if (claim.status !== 'claimed')
          throw new Error('Sheet confirmation was blocked before provider dispatch');
        const claimedUpdate = ApplicationTrackerUpdateSchema.parse(claim.record.trackerUpdate);

        try {
          await deps.client.api(
            `${SHEETS}/${encodeURIComponent(claimedUpdate.spreadsheetId)}/values/${encodeURIComponent(a1Range(claimedUpdate.sheetName, claimedUpdate.startCell))}?valueInputOption=RAW`,
            {
              method: 'PUT',
              body: JSON.stringify({
                majorDimension: 'ROWS',
                values: literalRows(claimedUpdate.rows),
              }),
            },
          );
        } catch {
          return {
            applicationId: record.id,
            action: 'sheet',
            status: 'unknown',
            effectStatus: 'unknown',
            retrySuppressed: true,
            error: 'Google may have accepted the Sheet update; automatic retry is suppressed.',
          };
        }

        const settled = await deps.applications.settleExternalEffect({
          agentId: ctx.agentId,
          applicationId: record.id,
          action: 'sheet',
          claimToken: claim.claimToken,
          status: 'succeeded',
          now: ctx.now(),
        });
        if (!settled)
          return {
            applicationId: record.id,
            action: 'sheet',
            status: 'unknown',
            effectStatus: 'unknown',
            retrySuppressed: true,
            error: 'Google accepted the Sheet update, but its receipt could not be settled.',
          };

        return {
          applicationId: record.id,
          action: 'sheet',
          status: 'succeeded',
        };
      },
    },
    {
      internalEventKind: 'application_confirmation',
      internalEventArgument: 'applicationId',
      privateWrite: true,
      blanketAllowIneligible: true,
    },
  );

  register(
    registry,
    {
      name: 'applications.append_confirmation_doc',
      description:
        'Internal Google Doc confirmation worker. It can append only the exact pre-authorized content carried by a verified internal application event.',
      inputSchema: applySchema,
      risk: 'autonomous',
      acceptsUntrustedInput: false,
      idempotencyKey: (args) => {
        const input = args as z.infer<typeof applySchema>;
        return `application-confirmation-doc-${input.applicationId}`;
      },
      execute: async (args, ctx) => {
        const task = await deps.tasks.getTask(ctx.taskId);
        const trigger = task?.trigger as
          | { source?: unknown; payload?: Record<string, unknown> }
          | undefined;
        if (
          task?.agentId !== ctx.agentId ||
          trigger?.source !== 'internal' ||
          trigger.payload?.kind !== 'application_confirmation' ||
          trigger.payload.applicationId !== args.applicationId
        ) {
          throw new Error(
            'application confirmation tool requires its exact verified internal event',
          );
        }

        const record = await deps.applications.get(args.applicationId);
        if (!record || record.agentId !== ctx.agentId || record.status !== 'confirmation_received')
          throw new Error('application confirmation is not ready to apply');
        const update = ApplicationDocumentUpdateSchema.parse(record.documentUpdate);
        const actionState = parseApplicationActionState(record.actionState);
        if (actionState.document?.status === 'succeeded') {
          return {
            applicationId: record.id,
            action: 'document',
            status: 'succeeded',
            alreadyApplied: true,
          };
        }
        if (
          actionState.document?.status === 'failed' ||
          actionState.document?.status === 'unknown'
        ) {
          throw new Error(
            `Google Doc confirmation action is ${actionState.document.status}; automatic retry is forbidden`,
          );
        }

        const document = await deps.client.api<DocsDocument>(
          `${DOCS}/${encodeURIComponent(update.documentId)}`,
        );
        const { requests } = buildContentRequests(update.content, endInsertIndex(document), {
          leadingNewline: true,
        });
        if (requests.length === 0) throw new Error('approved Google Doc append was empty');
        const identity = applicationExternalEffectToolIdentity('document', record.id);
        if (
          !ctx.execution ||
          ctx.execution.toolName !== identity.toolName ||
          !ctx.execution.dbToolCallId ||
          !ctx.taskLeaseToken
        )
          throw new Error('Doc confirmation requires a persisted executing tool call');
        const claim = await deps.applications.claimExternalEffect({
          agentId: ctx.agentId,
          applicationId: record.id,
          action: 'document',
          expectedProducerPrivacyGeneration: record.producerPrivacyGeneration ?? null,
          taskId: ctx.taskId,
          taskLeaseToken: ctx.taskLeaseToken,
          toolCallId: ctx.execution.dbToolCallId,
          toolName: identity.toolName,
          idempotencyKey: identity.idempotencyKey,
          argsDigest: applicationExternalEffectArgsDigest('document', update),
          now: ctx.now(),
        });
        if (claim.status !== 'claimed')
          throw new Error('Doc confirmation was blocked before provider dispatch');
        const claimedUpdate = ApplicationDocumentUpdateSchema.parse(claim.record.documentUpdate);
        const { requests: claimedRequests } = buildContentRequests(
          claimedUpdate.content,
          endInsertIndex(document),
          { leadingNewline: true },
        );
        if (claimedRequests.length === 0) throw new Error('approved Google Doc append was empty');

        try {
          await deps.client.api(
            `${DOCS}/${encodeURIComponent(claimedUpdate.documentId)}:batchUpdate`,
            {
              method: 'POST',
              body: JSON.stringify({ requests: claimedRequests }),
            },
          );
        } catch {
          return {
            applicationId: record.id,
            action: 'document',
            status: 'unknown',
            effectStatus: 'unknown',
            retrySuppressed: true,
            error: 'Google may have accepted the Doc update; automatic retry is suppressed.',
          };
        }

        const settled = await deps.applications.settleExternalEffect({
          agentId: ctx.agentId,
          applicationId: record.id,
          action: 'document',
          claimToken: claim.claimToken,
          status: 'succeeded',
          now: ctx.now(),
        });
        if (!settled)
          return {
            applicationId: record.id,
            action: 'document',
            status: 'unknown',
            effectStatus: 'unknown',
            retrySuppressed: true,
            error: 'Google accepted the Doc update, but its receipt could not be settled.',
          };

        return {
          applicationId: record.id,
          action: 'document',
          status: 'succeeded',
        };
      },
    },
    {
      internalEventKind: 'application_confirmation',
      internalEventArgument: 'applicationId',
      privateWrite: true,
      blanketAllowIneligible: true,
    },
  );

  return registry;
}
