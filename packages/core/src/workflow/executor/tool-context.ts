import type { Db } from '@assistant/db';
import { createPostgresExecutionJobRepository } from '@assistant/db';
import type { ExecutionJobRepository, ExecutionPersistence } from '@assistant/persistence';
import type { ModelMessage } from 'ai';
import { hashCallbackToken } from '../../browse.js';
import { isForwardedIngest } from '../../email-provenance.js';
import type { TaskState, Trust } from '../../events.js';
import type { TaskLease } from '../machine.js';
import { latestOwnerIntent } from '../owner-intent.js';
import type { ToolContextLike } from './types.js';
import { compact } from './util.js';

type BrowserStageSnapshots = Map<
  string,
  {
    contextWindow: TaskState['contextWindow'];
    pendingJob: TaskState['pendingJob'];
    pendingToolBatch: TaskState['pendingToolBatch'];
  }
>;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /\+\d[\d\s().-]{6,}\d/g;
// E.164 numbers carry 8-15 digits; anything outside that matched the regex by
// accident (an order id, a tracking code) and must not become send-approved.
const isPlausiblePhone = (normalized: string) => {
  const digits = normalized.replace(/\D/g, '').length;
  return digits >= 8 && digits <= 15;
};

/**
 * Harvest the recipient addresses the owner actually provided. Two sources:
 * the trigger payload's address headers (from/to/cc — routing metadata the
 * provider authenticated), and, for owner-trust tasks only, the text of the
 * owner's own messages. This is the provenance whitelist the dispatcher checks
 * a send against.
 *
 * Deliberately NOT scanned: tool results (a fetched page or resumed window
 * carries third-party text), assistant messages, and — for external-trust
 * tasks — the inbound message body. A stranger mentioning victim@example.com
 * in their email must not make sending to that address card-free.
 */
export function harvestKnownAddresses(
  state: TaskState,
  trigger: TaskLease['trigger'],
  trust: Trust,
): { emails: string[]; phones: string[] } {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const scan = (text: string) => {
    for (const m of text.match(EMAIL_RE) ?? []) emails.add(m.toLowerCase());
    for (const m of text.match(PHONE_RE) ?? []) {
      const normalized = m.replace(/[^\d+]/g, '');
      if (isPlausiblePhone(normalized)) phones.add(normalized);
    }
  };
  // Forwarded ingest is owner-TRUST but not owner-AUTHORED: the `role: 'user'`
  // message in the window is a third party's email body, arriving through the
  // owner's forwarding rule. Scanning it here would whitelist every address a
  // stranger chose to mention — the precise bypass the note above rules out for
  // external-trust tasks. The routing metadata below is still harvested, exactly
  // as it is for any other third-party mail.
  if ((trust === 'owner' || trust === 'assistant') && !isForwardedIngest({ trigger })) {
    for (const message of state.contextWindow ?? []) {
      if ((message as { role?: unknown }).role !== 'user') continue;
      const content = (message as { content?: unknown }).content;
      if (typeof content === 'string') scan(content);
    }
  }
  const payload = (trigger as { payload?: Record<string, unknown> } | null)?.payload ?? {};
  for (const key of ['from', 'to', 'cc', 'replyTo', 'sender']) {
    const value = payload[key];
    if (typeof value === 'string') scan(value);
    else if (Array.isArray(value)) for (const v of value) if (typeof v === 'string') scan(v);
  }
  return { emails: [...emails], phones: [...phones] };
}

/**
 * Build the tool-execution context handed to the dispatcher. The browser-job
 * staging closure reads the live step-loop window because it changes as the
 * batch settles.
 */
export function createToolContext(args: {
  db: Db;
  task: TaskLease;
  state: TaskState;
  signal: AbortSignal;
  getWindow: () => ModelMessage[];
  browserStageSnapshots: BrowserStageSnapshots;
  executionJobs?: ExecutionJobRepository;
  requestTimeZone?: string;
  persistence?: ExecutionPersistence;
}): ToolContextLike {
  const { db, task, state, browserStageSnapshots } = args;
  const executionJobs = args.executionJobs ?? createPostgresExecutionJobRepository(db);
  const triggerPayload =
    task.trigger && typeof task.trigger === 'object' && 'payload' in task.trigger
      ? (task.trigger as { payload?: Record<string, unknown> }).payload
      : undefined;
  const rawBookingOccurrence = triggerPayload?.bookingOccurrence;
  const bookingOccurrence =
    rawBookingOccurrence &&
    typeof rawBookingOccurrence === 'object' &&
    'agentId' in rawBookingOccurrence &&
    rawBookingOccurrence.agentId === task.agentId &&
    'bookingKey' in rawBookingOccurrence &&
    typeof rawBookingOccurrence.bookingKey === 'string' &&
    'version' in rawBookingOccurrence &&
    typeof rawBookingOccurrence.version === 'number' &&
    Number.isInteger(rawBookingOccurrence.version)
      ? {
          agentId: task.agentId,
          bookingKey: rawBookingOccurrence.bookingKey,
          version: rawBookingOccurrence.version,
          ...('operation' in rawBookingOccurrence &&
          rawBookingOccurrence.operation === 'cancel_existing' &&
          'calendarEventId' in rawBookingOccurrence &&
          typeof rawBookingOccurrence.calendarEventId === 'string' &&
          'bookingIdentity' in rawBookingOccurrence &&
          typeof rawBookingOccurrence.bookingIdentity === 'string'
            ? {
                operation: 'cancel_existing' as const,
                calendarEventId: rawBookingOccurrence.calendarEventId,
                bookingIdentity: rawBookingOccurrence.bookingIdentity,
              }
            : {}),
        }
      : undefined;
  return {
    taskId: task.id,
    agentId: task.agentId,
    conversationId: task.conversationId ?? undefined,
    trust: task.trust as Trust,
    tainted: state.untrustedContext,
    ownerIntent: latestOwnerIntent(
      (state.contextWindow ?? []) as unknown as Array<{ role: string; content: unknown }>,
      {
        trust: task.trust as Trust,
        trigger: task.trigger,
        clarificationContinuation: state.clarificationContinuation,
      },
    ),
    knownAddresses: harvestKnownAddresses(state, task.trigger, task.trust as Trust),
    db,
    now: () => new Date(),
    requestAt: task.createdAt,
    ...(bookingOccurrence
      ? {
          bookingOccurrence,
          assertBookingOccurrenceCurrent: async () =>
            (await args.persistence?.emailSync?.isBookingOccurrenceCurrent({
              agentId: bookingOccurrence.agentId,
              bookingKey: bookingOccurrence.bookingKey,
              expectedVersion: bookingOccurrence.version,
              allowedLifecycle:
                bookingOccurrence.operation === 'cancel_existing'
                  ? ['cancelled']
                  : ['confirmed', 'rescheduled'],
            })) ?? false,
        }
      : {}),
    ...((state.requestTimeZone ?? args.requestTimeZone)
      ? { requestTimeZone: state.requestTimeZone ?? args.requestTimeZone }
      : {}),
    signal: args.signal,
    log: async () => {},
    stageBrowserJob: async (job) => {
      // The raw callback token has already been handed to the job at launch;
      // only its hash is persisted anywhere (task checkpoint AND the tool_calls
      // sentinel), so a DB read never yields a usable callback credential.
      const callbackTokenHash = hashCallbackToken(job.pending.callbackToken);
      const stagedSentinel = { ...job.pending, callbackToken: callbackTokenHash };
      const pendingJob = {
        dbToolCallId: job.dbToolCallId,
        toolCallId: job.modelToolCallId,
        toolName: job.toolName,
        callbackTokenHash,
        timeoutAt: job.pending.timeoutAt,
      };
      const contextWindow = compact(args.getWindow()) as unknown as TaskState['contextWindow'];
      const snapshot = {
        contextWindow: state.contextWindow,
        pendingJob: state.pendingJob,
        pendingToolBatch: state.pendingToolBatch,
      };
      const pendingToolBatch = state.pendingToolBatch
        ? {
            ...state.pendingToolBatch,
            calls: state.pendingToolBatch.calls.map((call) => {
              if (call.toolCallId === job.modelToolCallId) {
                return { ...call, status: 'job' as const, dbToolCallId: job.dbToolCallId };
              }
              return call;
            }),
          }
        : null;
      // If this is an approved call, remove the approval from the DURABLE
      // recovery checkpoint before launch. Keep the in-memory list untouched so
      // the current loop can continue processing its remaining approvals.
      const checkpointState: TaskState = {
        ...state,
        pendingApprovals: state.pendingApprovals.filter(
          (approval) => approval.dbToolCallId !== job.dbToolCallId,
        ),
        pendingJob,
        contextWindow,
        pendingToolBatch,
      };
      await executionJobs.stage(
        { taskId: task.id, toolCallId: job.dbToolCallId, pending: stagedSentinel, checkpointState },
        task,
      );
      browserStageSnapshots.set(job.dbToolCallId, snapshot);
      state.pendingJob = pendingJob;
      state.contextWindow = contextWindow;
      state.pendingToolBatch = pendingToolBatch;
    },
    clearStagedBrowserJob: async (job) => {
      const snapshot = browserStageSnapshots.get(job.dbToolCallId);
      const checkpointState: TaskState = {
        ...state,
        pendingJob: snapshot?.pendingJob ?? null,
        contextWindow: snapshot?.contextWindow ?? state.contextWindow,
        pendingToolBatch: snapshot?.pendingToolBatch ?? state.pendingToolBatch,
      };
      await executionJobs.clear(
        {
          taskId: task.id,
          toolCallId: job.dbToolCallId,
          pending: {
            ...job.pending,
            callbackToken: hashCallbackToken(job.pending.callbackToken),
          },
          checkpointState,
        },
        task,
      );
      state.pendingJob = checkpointState.pendingJob;
      state.contextWindow = checkpointState.contextWindow;
      state.pendingToolBatch = checkpointState.pendingToolBatch;
      browserStageSnapshots.delete(job.dbToolCallId);
    },
  };
}
