import {
  claimTask,
  completeTask,
  enqueueTask,
  markTaskNeedsAttention,
  notifyTaskEnqueued,
  persistMessage,
} from '@assistant/core';
import type { Db } from '@assistant/db';
import type {
  ApplicationConfirmationNoticeFence,
  ApplicationConfirmationRepository,
  ApplicationConfirmationRecord as ApplicationConfirmationRow,
  EmailContentProvenanceSnapshot,
  EmailObserverEffectFence,
  ExecutionPersistence,
} from '@assistant/persistence';
import {
  applicationConfirmationSourceDigest,
  applicationConfirmationTokenInSource,
  notificationDeliveryKey,
} from '@assistant/persistence';
import {
  type ApplicationActionState,
  ApplicationDocumentUpdateSchema,
  ApplicationTrackerUpdateSchema,
  hashConfirmationToken,
  parseApplicationActionState,
} from '@assistant/tools';
import type { ToolDispatcher } from '@assistant/tools/dispatcher';
import type { ModuleTaskHandler, OwnerNotifier } from '../platform.js';

/** What confirmation matching consumes: the watch records, tasks, messages, and the owner-notifier port. */
export interface ApplicationConfirmationDeps {
  persistence: Pick<ExecutionPersistence, 'tasks' | 'messages'> & {
    applications: ApplicationConfirmationRepository;
  };
  notifyOwner: OwnerNotifier['notifyOwner'];
}

/** The deterministic task executors additionally dispatch the google tools. */
export interface ApplicationConfirmationTaskDeps extends ApplicationConfirmationDeps {
  dispatcher: ToolDispatcher;
  /** Only for the tool context the dispatcher hands to tools; they read persistence instead. */
  db: Db;
}

const MAX_TOKEN_CANDIDATES = 1_000;
const TOKEN_PATTERN = /[a-zA-Z0-9][a-zA-Z0-9_-]{5,99}/g;
// Invisible word-break characters and their HTML entity forms. HTML-only mail
// frequently renders a reference like REQ-12345 as REQ-&shy;12345 or with a
// zero-width space, and the crude HTML→text extractor neither decodes entities
// nor removes these characters — so the token fragments below the 6-char
// minimum and never matches. Stripping them yields a second candidate variant.
const INVISIBLE_TOKEN_BREAK =
  /\u00AD|\u200B|\u200C|\u200D|\u2060|\uFEFF|&(?:shy|zwnj|zwj|#0*(?:173|8203|8204|8205|8288|65279)|#x0*(?:ad|200b|200c|200d|2060|feff));?/gi;

export type ApplicationConfirmationResult =
  | { kind: 'ignored' }
  | { kind: 'ambiguous'; applicationIds: string[] }
  | { kind: 'in_progress'; applicationId: string }
  | { kind: 'replay'; applicationId: string; status: string };

export interface ApplicationConfirmationInput {
  agentId: string;
  messageId: string;
  from: string;
  subject: string;
  body: string;
  /** True only for Gmail receiver-authenticated, From-aligned SPF/DKIM/DMARC. */
  authenticated: boolean;
  now?: Date;
  /** Optional atomic source/observer fence for durable email-observer callers. */
  emailObserverEffectFence?: EmailObserverEffectFence;
  /** Authored-span provenance captured with the canonical direct-email source. */
  emailContentProvenance?: EmailContentProvenanceSnapshot | null;
}

export type ApplicationConfirmationRoute = 'application_confirmation' | 'email_triage';

/**
 * Resolve the one durable direct-mail route without claiming a watch, expiring
 * rows, creating tasks, or notifying anyone. The result is frozen with the
 * atomic email admission; a later worker applies exactly that branch. A match
 * that becomes stale after this read stays on the application path and is
 * surfaced for review rather than falling through to generic triage.
 */
export async function routeApplicationConfirmation(
  deps: ApplicationConfirmationDeps,
  input: ApplicationConfirmationInput,
): Promise<ApplicationConfirmationRoute> {
  if (!input.authenticated) return 'email_triage';
  const from = input.from.trim().toLowerCase();
  if (!from || !input.messageId) return 'email_triage';

  const applications = deps.persistence.applications;
  const confirmationMessageId = `gmail:${input.messageId}`;
  if (await applications.byConfirmationMessage(input.agentId, confirmationMessageId))
    return 'application_confirmation';

  const candidates = await applications.awaitingFrom(input.agentId, from, input.now ?? new Date());
  if (candidates.length === 0) return 'email_triage';
  return candidates.some((candidate) =>
    applicationConfirmationTokenInSource({
      tokenHash: candidate.confirmationTokenHash,
      subject: input.subject,
      body: input.body,
      provenance: input.emailContentProvenance,
    }),
  )
    ? 'application_confirmation'
    : 'email_triage';
}

/** Hash bounded opaque-token candidates without exposing raw email to a privileged task. */
export function confirmationTokenHashes(text: string): Set<string> {
  const result = new Set<string>();
  const addFrom = (source: string) => {
    for (const match of source.matchAll(TOKEN_PATTERN)) {
      if (result.size >= MAX_TOKEN_CANDIDATES) return;
      result.add(hashConfirmationToken(match[0]));
    }
  };
  addFrom(text);
  // Also try a variant with invisible word-break characters/entities removed,
  // so a reference token split by soft hyphens or zero-width spaces (common in
  // HTML-only mail) still reproduces the stored token.
  const dejoined = text.replace(INVISIBLE_TOKEN_BREAK, '');
  if (dejoined !== text) addFrom(dejoined);
  return result;
}

function eventId(messageId: string): string {
  return `application-confirmation:gmail:${messageId}`;
}

async function postNotice(
  deps: ApplicationConfirmationDeps,
  record: ApplicationConfirmationRow,
  taskId: string,
  text: string,
  suffix: string,
  applicationConfirmationNoticeFence?: ApplicationConfirmationNoticeFence,
): Promise<void> {
  if (!record.conversationId) return;
  await persistMessage(deps.persistence.messages, {
    conversationId: record.conversationId,
    taskId,
    role: 'assistant',
    origin: 'assistant',
    parts: [{ type: 'text', text }],
    text,
    channelMessageId: `application-confirmation-notice:${taskId}:${suffix}`,
    ...(applicationConfirmationNoticeFence ? { applicationConfirmationNoticeFence } : {}),
  });
}

async function reportAmbiguous(
  deps: ApplicationConfirmationDeps,
  input: ApplicationConfirmationInput,
  matches: ApplicationConfirmationRow[],
): Promise<{ recorded: boolean; applicationIds: string[] }> {
  if (input.emailObserverEffectFence) {
    const committed = await deps.persistence.applications.recordAmbiguousObserver({
      emailObserverEffectFence: input.emailObserverEffectFence,
    });
    if (committed.kind === 'not_ambiguous') return { recorded: false, applicationIds: [] };
    const delivery = await deps.notifyOwner({
      taskId: committed.taskId,
      text: `An authenticated confirmation from ${committed.from} matched ${committed.applicationIds.length} application watches; I changed nothing and it needs your review.`,
      deliveryKey: notificationDeliveryKey(
        'email-observer',
        input.agentId,
        `gmail:${input.messageId}`,
        'google.application-confirmation',
        '1',
        'ambiguous',
      ),
      emailObserverEffectFence: input.emailObserverEffectFence,
    });
    if (
      !delivery ||
      delivery.legs.some((leg) => leg.status === 'unknown' || leg.status === 'failed')
    )
      throw new Error('application_confirmation_notice_unknown');
    return { recorded: true, applicationIds: committed.applicationIds };
  }

  const { task, created } = await enqueueTask(deps.persistence.tasks, {
    type: 'adhoc',
    event: {
      source: 'internal',
      externalEventId: `${eventId(input.messageId)}:ambiguous`,
      agentId: input.agentId,
      conversationId: matches.find((record) => record.conversationId)?.conversationId ?? undefined,
      trust: 'assistant',
      payload: {
        kind: 'application_confirmation_ambiguous',
        applicationIds: matches.map((record) => record.id),
        from: input.from.toLowerCase(),
        matchCount: matches.length,
      },
    },
    deferNotification: true,
  });
  if (created) {
    const claimed = await claimTask(deps.persistence.tasks, task.id);
    if (claimed) {
      await markTaskNeedsAttention(
        deps.persistence.tasks,
        claimed,
        `Authenticated confirmation from ${input.from.toLowerCase()} matched ${matches.length} active applications; no Sheet or Doc was changed.`,
      );
    }
  }

  for (const record of matches) {
    await postNotice(
      deps,
      record,
      task.id,
      `I received an authenticated email from ${input.from.toLowerCase()}, but it matched more than one active application watch. I did not update any Sheet or Doc. Review the application references ending in ${matches.map((candidate) => candidate.confirmationTokenHint).join(', ')}.`,
      `ambiguous:${record.id}`,
    );
  }
  const delivery = await deps.notifyOwner({
    taskId: task.id,
    text: `An authenticated confirmation from ${input.from.toLowerCase()} matched ${matches.length} application watches; I changed nothing and it needs your review.`,
    deliveryKey: notificationDeliveryKey(
      'email-observer',
      input.agentId,
      `gmail:${input.messageId}`,
      'google.application-confirmation',
      '1',
      'ambiguous',
    ),
    emailObserverEffectFence: input.emailObserverEffectFence,
  });
  if (!delivery || delivery.legs.some((leg) => leg.status === 'unknown' || leg.status === 'failed'))
    throw new Error('application_confirmation_notice_unknown');
  return { recorded: true, applicationIds: matches.map((record) => record.id) };
}

async function enqueueAuthorizedUpdate(
  deps: ApplicationConfirmationDeps,
  input: ApplicationConfirmationInput,
  record: ApplicationConfirmationRow,
): Promise<ApplicationConfirmationResult> {
  if (input.emailObserverEffectFence) {
    const confirmationMessageId = `gmail:${input.messageId}`;
    const handoff = await deps.persistence.applications.claimAndEnqueue(record.id, {
      confirmationMessageId,
      confirmationFrom: input.from.trim().toLowerCase(),
      now: input.now ?? new Date(),
      emailObserverEffectFence: input.emailObserverEffectFence,
      confirmationTokenHash: record.confirmationTokenHash,
      sourceDigest: applicationConfirmationSourceDigest({
        confirmationMessageId,
        confirmationFrom: input.from.trim().toLowerCase(),
        subject: input.subject,
        body: input.body,
      }),
    });
    if (!handoff) {
      const current = await deps.persistence.applications.get(record.id);
      if (current?.status === 'confirmation_received')
        throw new Error('application_confirmation_handoff_missing');
      return current
        ? { kind: 'replay', applicationId: current.id, status: current.status }
        : { kind: 'ignored' };
    }
    notifyTaskEnqueued(handoff.task, handoff.created);
    if (handoff.task.status === 'done') {
      return { kind: 'replay', applicationId: record.id, status: 'updated' };
    }
    if (handoff.task.status === 'needs_attention' || handoff.task.status === 'failed') {
      return { kind: 'replay', applicationId: record.id, status: handoff.record.status };
    }
    return { kind: 'in_progress', applicationId: record.id };
  }

  const { task } = await enqueueTask(deps.persistence.tasks, {
    type: 'adhoc',
    event: {
      source: 'internal',
      externalEventId: eventId(input.messageId),
      agentId: input.agentId,
      conversationId: record.conversationId ?? undefined,
      trust: 'assistant',
      payload: {
        kind: 'application_confirmation',
        applicationId: record.id,
        confirmationMessageId: `gmail:${input.messageId}`,
      },
    },
    maxSteps: 2,
  });

  if (task.status === 'done') {
    return { kind: 'replay', applicationId: record.id, status: 'updated' };
  }
  if (task.status === 'needs_attention' || task.status === 'failed') {
    return { kind: 'replay', applicationId: record.id, status: record.status };
  }

  return { kind: 'in_progress', applicationId: record.id };
}

export type ApplicationConfirmationTaskResult = {
  outcome: 'done' | 'needs_attention' | 'not_claimable';
  applicationId?: string;
};

/** Deterministic recovery route for an ambiguous multi-record match. */
async function executeAmbiguousApplicationConfirmationTask(
  deps: ApplicationConfirmationDeps,
  taskId: string,
  generation?: number,
): Promise<ApplicationConfirmationTaskResult> {
  const queued = await deps.persistence.tasks.getTask(taskId);
  const trigger = queued?.trigger as
    | { source?: unknown; payload?: Record<string, unknown> }
    | undefined;
  if (
    !queued ||
    trigger?.source !== 'internal' ||
    trigger.payload?.kind !== 'application_confirmation_ambiguous'
  ) {
    return { outcome: 'not_claimable' };
  }
  if (queued.status === 'needs_attention') return { outcome: 'needs_attention' };
  const claimed = await claimTask(deps.persistence.tasks, queued.id, generation);
  if (!claimed) return { outcome: 'not_claimable' };
  const count = Number(trigger.payload.matchCount);
  const from = typeof trigger.payload.from === 'string' ? trigger.payload.from : 'the sender';
  await markTaskNeedsAttention(
    deps.persistence.tasks,
    claimed,
    `Authenticated confirmation from ${from} matched ${Number.isInteger(count) ? count : 'multiple'} active applications; no Sheet or Doc was changed.`,
  );
  return { outcome: 'needs_attention' };
}

type ApplicationAction = 'sheet' | 'document';

const ACTION_TOOL: Record<ApplicationAction, { name: string; step: number }> = {
  sheet: { name: 'applications.apply_confirmation', step: 1 },
  document: { name: 'applications.append_confirmation_doc', step: 2 },
};

function plannedActions(record: ApplicationConfirmationRow): ApplicationAction[] {
  return [
    record.trackerUpdate ? 'sheet' : undefined,
    record.documentUpdate ? 'document' : undefined,
  ].filter((action): action is ApplicationAction => Boolean(action));
}

function normalizedActionState(record: ApplicationConfirmationRow): ApplicationActionState {
  const state = parseApplicationActionState(record.actionState);
  const fallback =
    record.status === 'updated'
      ? 'succeeded'
      : record.status === 'update_unknown'
        ? 'unknown'
        : record.status === 'update_failed'
          ? 'failed'
          : 'pending';
  return {
    ...(record.trackerUpdate ? { sheet: state.sheet ?? { status: fallback } } : {}),
    ...(record.documentUpdate ? { document: state.document ?? { status: fallback } } : {}),
  };
}

async function loadApplicationRecord(deps: ApplicationConfirmationDeps, id: string) {
  return deps.persistence.applications.get(id);
}

async function setActionOutcome(
  deps: ApplicationConfirmationDeps,
  id: string,
  action: ApplicationAction,
  status: 'failed' | 'unknown',
  error: string,
): Promise<ApplicationConfirmationRow> {
  const current = await loadApplicationRecord(deps, id);
  if (!current) throw new Error('application confirmation disappeared during execution');
  const state = normalizedActionState(current);
  const actionOutcome = {
    ...(state[action] ?? {}),
    status,
    error: error.slice(0, 2_000),
  };
  const updated = await deps.persistence.applications.updateActionState(id, {
    actionState: { ...state, [action]: actionOutcome },
    now: new Date(),
  });
  if (!updated) throw new Error('failed to checkpoint application action outcome');
  return updated;
}

async function rejectedOutcomeIsUnknown(
  deps: ApplicationConfirmationDeps,
  recordId: string,
  action: ApplicationAction,
  reason: string,
): Promise<boolean> {
  const idempotencyKey =
    action === 'sheet'
      ? `application-confirmation-apply-${recordId}`
      : `application-confirmation-doc-${recordId}`;
  const prior = await deps.persistence.applications.toolCallStatus(idempotencyKey);
  if (prior === 'failed') return false;
  if (prior === 'executing') return true;
  return /already executing|ambiguous side-effect retry/i.test(reason);
}

function finalRecordStatus(record: ApplicationConfirmationRow, state: ApplicationActionState) {
  const statuses = plannedActions(record).map((action) => state[action]?.status ?? 'failed');
  if (statuses.every((status) => status === 'succeeded')) return 'updated' as const;
  if (statuses.some((status) => status === 'succeeded')) return 'partially_updated' as const;
  if (statuses.some((status) => status === 'unknown')) return 'update_unknown' as const;
  return 'update_failed' as const;
}

function actionLabel(record: ApplicationConfirmationRow, action: ApplicationAction): string {
  if (action === 'sheet') {
    const tracker = ApplicationTrackerUpdateSchema.parse(record.trackerUpdate);
    return `Sheet ${tracker.sheetName}!${tracker.startCell}`;
  }
  return 'Google Doc append';
}

function resultCopy(record: ApplicationConfirmationRow, state: ApplicationActionState) {
  const grouped = { succeeded: [] as string[], failed: [] as string[], unknown: [] as string[] };
  for (const action of plannedActions(record)) {
    const status = state[action]?.status;
    if (status === 'succeeded' || status === 'failed' || status === 'unknown') {
      grouped[status].push(actionLabel(record, action));
    }
  }
  const details = [
    grouped.succeeded.length ? `${grouped.succeeded.join(' and ')} succeeded.` : '',
    grouped.failed.length
      ? `${grouped.failed.join(' and ')} failed. No success is being claimed for the failed action.`
      : '',
    grouped.unknown.length
      ? `${grouped.unknown.join(' and ')} may have succeeded; I suppressed automatic retry.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    notice: `I matched the authenticated confirmation for ${record.company} — ${record.role} (reference ending ${record.confirmationTokenHint}). ${details}`,
    progress: `Matched authenticated confirmation for ${record.company} — ${record.role}. ${details}`,
  };
}

async function reconcileSucceededLedger(
  deps: ApplicationConfirmationDeps,
  taskId: string,
  record: ApplicationConfirmationRow,
  state: ApplicationActionState,
): Promise<void> {
  for (const action of plannedActions(record)) {
    if (state[action]?.status !== 'succeeded') continue;
    const definition = ACTION_TOOL[action];
    const result =
      action === 'sheet'
        ? (() => {
            const update = ApplicationTrackerUpdateSchema.parse(record.trackerUpdate);
            return {
              applicationId: record.id,
              action,
              status: 'succeeded',
              spreadsheetId: update.spreadsheetId,
              sheetName: update.sheetName,
              startCell: update.startCell,
              writtenRows: update.rows.length,
              recoveredFromRecord: true,
            };
          })()
        : (() => {
            const update = ApplicationDocumentUpdateSchema.parse(record.documentUpdate);
            return {
              applicationId: record.id,
              action,
              status: 'succeeded',
              documentId: update.documentId,
              appendedCharacters: update.content.length,
              recoveredFromRecord: true,
            };
          })();
    await deps.persistence.applications.settleExecutingToolCall(
      taskId,
      definition.name,
      result,
      new Date(),
    );
  }
}

/** Durable queue handler: confirmation tasks never enter the model executor. */
export async function executeApplicationConfirmationTask(
  deps: ApplicationConfirmationTaskDeps,
  taskId: string,
  generation?: number,
): Promise<ApplicationConfirmationTaskResult> {
  const queued = await deps.persistence.tasks.getTask(taskId);
  const trigger = queued?.trigger as
    | { source?: unknown; payload?: Record<string, unknown> }
    | undefined;
  const applicationId = trigger?.payload?.applicationId;
  if (
    !queued ||
    trigger?.source !== 'internal' ||
    trigger.payload?.kind !== 'application_confirmation' ||
    typeof applicationId !== 'string'
  ) {
    return { outcome: 'not_claimable' };
  }
  let record = await loadApplicationRecord(deps, applicationId);
  if (!record || record.agentId !== queued.agentId) return { outcome: 'not_claimable' };
  if (queued.status === 'done') return { outcome: 'done', applicationId };
  if (queued.status === 'needs_attention' || queued.status === 'failed') {
    return { outcome: 'needs_attention', applicationId };
  }
  const tasks = deps.persistence.tasks;
  const claimed = await claimTask(tasks, queued.id, generation);
  if (!claimed) return { outcome: 'not_claimable', applicationId };

  const producerGenerationPresent = Object.hasOwn(trigger.payload, 'producerPrivacyGeneration');
  const producerGeneration = trigger.payload.producerPrivacyGeneration;
  if (
    !producerGenerationPresent ||
    (producerGenerationPresent &&
      typeof producerGeneration !== 'string' &&
      producerGeneration !== null) ||
    (producerGenerationPresent &&
      (record.producerPrivacyGeneration !== producerGeneration ||
        !(await deps.persistence.applications.isPrivacyGenerationCurrent(
          claimed.agentId,
          producerGeneration as string | null,
        ))))
  ) {
    await markTaskNeedsAttention(
      tasks,
      claimed,
      'The owner privacy generation changed after this confirmation was queued; no Google update was attempted.',
    );
    return { outcome: 'needs_attention', applicationId };
  }

  if (plannedActions(record).length === 0) {
    await markTaskNeedsAttention(tasks, claimed, 'No pre-authorized confirmation action exists.');
    return { outcome: 'needs_attention', applicationId };
  }
  if (
    ![
      'confirmation_received',
      'updated',
      'partially_updated',
      'update_unknown',
      'update_failed',
    ].includes(record.status)
  ) {
    await markTaskNeedsAttention(
      tasks,
      claimed,
      `Application confirmation record is ${record.status}; no update was attempted.`,
    );
    return { outcome: 'needs_attention', applicationId };
  }

  let state = normalizedActionState(record);
  await reconcileSucceededLedger(deps, claimed.id, record, state);

  if (record.status === 'confirmation_received') {
    for (const action of plannedActions(record)) {
      if (state[action]?.status !== 'pending') continue;
      if (
        producerGenerationPresent &&
        !(await deps.persistence.applications.isPrivacyGenerationCurrent(
          claimed.agentId,
          producerGeneration as string | null,
        ))
      ) {
        await markTaskNeedsAttention(
          tasks,
          claimed,
          'The owner privacy generation changed before the next Google update; no further action was attempted.',
        );
        return { outcome: 'needs_attention', applicationId };
      }
      const definition = ACTION_TOOL[action];
      const outcome = await deps.dispatcher.dispatch({
        task: claimed,
        step: definition.step,
        toolName: definition.name,
        args: { applicationId: record.id },
        ctx: {
          taskId: claimed.id,
          agentId: claimed.agentId,
          conversationId: claimed.conversationId ?? undefined,
          trust: 'assistant',
          tainted: false,
          db: deps.db,
          now: () => new Date(),
          signal: new AbortController().signal,
          log: async () => {},
        },
        provenance: { plannerVersion: 0, promptVersion: 0, model: 'deterministic/email-match' },
      });

      if (outcome.kind === 'executed') {
        const result = outcome.result as { deliveryStatus?: unknown } | null;
        if (result?.deliveryStatus === 'unknown') {
          record = await setActionOutcome(
            deps,
            record.id,
            action,
            'unknown',
            `Google may have accepted the ${action} update; automatic retry was suppressed.`,
          );
        } else {
          record = (await loadApplicationRecord(deps, record.id)) ?? record;
        }
      } else {
        const reason =
          outcome.kind === 'rejected'
            ? outcome.reason
            : outcome.kind === 'budget_blocked'
              ? outcome.reason
              : `the ${action} update unexpectedly requested approval`;
        const unknown =
          outcome.kind === 'rejected' &&
          (await rejectedOutcomeIsUnknown(deps, record.id, action, outcome.reason));
        record = await setActionOutcome(
          deps,
          record.id,
          action,
          unknown ? 'unknown' : 'failed',
          reason,
        );
      }
      state = normalizedActionState(record);
    }
  }

  record = (await loadApplicationRecord(deps, record.id)) ?? record;
  state = normalizedActionState(record);
  await reconcileSucceededLedger(deps, claimed.id, record, state);
  const status = finalRecordStatus(record, state);
  const errors = plannedActions(record)
    .flatMap((action) => (state[action]?.error ? [`${action}: ${state[action]?.error}`] : []))
    .join('; ')
    .slice(0, 2_000);
  const finalRecord = await deps.persistence.applications.updateActionState(record.id, {
    status,
    actionState: state,
    lastError: errors || null,
    now: new Date(),
  });
  if (finalRecord) record = finalRecord;

  const copy = resultCopy(record, state);
  const noticeFence = producerGenerationPresent
    ? {
        agentId: claimed.agentId,
        taskId: claimed.id,
        taskLeaseToken: claimed.leaseToken ?? '',
        taskQueueGeneration: claimed.queueGeneration,
        applicationId: record.id,
        confirmationMessageId: record.confirmationMessageId ?? '',
        producerPrivacyGeneration: producerGeneration as string | null,
      }
    : undefined;
  await postNotice(deps, record, claimed.id, copy.notice, status, noticeFence);
  // The confirmation-email -> Sheet/Doc update is the flagship "send me
  // updates" milestone and it completes long after the owner's original
  // message, on an internal task that never routes through the channel
  // deliverers. Push the outcome to the owner's channel so an SMS/email-
  // originated flow is not silently finished on the dashboard alone.
  await deps
    .notifyOwner({
      taskId: claimed.id,
      text: copy.notice,
      deliveryKey: notificationDeliveryKey('application-confirmation-result', claimed.id, status),
      ...(noticeFence ? { applicationConfirmationNoticeFence: noticeFence } : {}),
    })
    .catch((err) => console.error('application confirmation owner notification failed', err));
  if (status === 'updated') {
    await completeTask(tasks, claimed, { status: 'done', progress: copy.progress });
    return { outcome: 'done', applicationId };
  }
  await markTaskNeedsAttention(tasks, claimed, copy.progress);
  return { outcome: 'needs_attention', applicationId };
}

/**
 * Proactively expire application watches whose window has closed with no
 * matching confirmation, and tell the owner. Without this, a watch only expires
 * lazily when some other authenticated mail happens to arrive, and it does so
 * silently — the owner's owner-approved follow-up just ends with no signal.
 * Idempotent: the status-guarded UPDATE transitions each row once, and the
 * notice channelMessageId dedupes the dashboard message.
 */
export async function reapExpiredApplicationWatches(
  deps: ApplicationConfirmationDeps,
  now = new Date(),
): Promise<number> {
  const expired = await deps.persistence.applications.expireDue(now);

  for (const record of expired) {
    const text = `I watched ${record.expectedSenderEmails.join(', ')} for the ${record.company} — ${record.role} confirmation until ${record.expiresAt.toISOString().slice(0, 10)} and it never arrived. I made no Sheet or Doc update.`;
    if (record.conversationId) {
      await persistMessage(deps.persistence.messages, {
        conversationId: record.conversationId,
        role: 'assistant',
        origin: 'assistant',
        parts: [{ type: 'text', text }],
        text,
        channelMessageId: `application-watch-expired:${record.id}`,
      }).catch((err) => console.error('watch expiry notice failed', err));
    }
    await deps
      .notifyOwner({ text })
      .catch((err) => console.error('watch expiry owner notification failed', err));
  }
  return expired.length;
}

/**
 * Match one Gmail message to one pre-authorized application watch and execute
 * only its frozen Sheet and/or Doc actions. Raw subject/body never enters the
 * internal assistant task or model context.
 */
export async function processApplicationConfirmation(
  deps: ApplicationConfirmationDeps,
  input: ApplicationConfirmationInput,
): Promise<ApplicationConfirmationResult> {
  if (!input.authenticated) return { kind: 'ignored' };
  const now = input.now ?? new Date();
  const from = input.from.trim().toLowerCase();
  if (!from || !input.messageId) return { kind: 'ignored' };

  const applications = deps.persistence.applications;
  // A durable observer claim fences its own atomic watch transition below.
  // Do not mutate unrelated expired watches from this still-unfenced path.
  if (!input.emailObserverEffectFence) await applications.expireDue(now, input.agentId);

  const confirmationMessageId = `gmail:${input.messageId}`;
  const alreadyClaimed = await applications.byConfirmationMessage(
    input.agentId,
    confirmationMessageId,
  );
  if (alreadyClaimed) {
    if (alreadyClaimed.status === 'confirmation_received') {
      return enqueueAuthorizedUpdate(deps, input, alreadyClaimed);
    }
    return {
      kind: 'replay',
      applicationId: alreadyClaimed.id,
      status: alreadyClaimed.status,
    };
  }

  const candidates = await applications.awaitingFrom(input.agentId, from, now);
  if (candidates.length === 0) return { kind: 'ignored' };

  const hashes = confirmationTokenHashes(`${input.subject}\n${input.body}`);
  const matches = input.emailObserverEffectFence
    ? candidates.filter((candidate) =>
        applicationConfirmationTokenInSource({
          tokenHash: candidate.confirmationTokenHash,
          subject: input.subject,
          body: input.body,
          provenance: input.emailContentProvenance,
        }),
      )
    : candidates.filter((candidate) => hashes.has(candidate.confirmationTokenHash));
  if (matches.length === 0) return { kind: 'ignored' };
  if (matches.length > 1) {
    const ambiguous = await reportAmbiguous(deps, input, matches);
    if (!ambiguous.recorded) return { kind: 'ignored' };
    return { kind: 'ambiguous', applicationIds: ambiguous.applicationIds };
  }

  const match = matches[0] as ApplicationConfirmationRow;
  const baseClaimInput = {
    confirmationMessageId,
    confirmationFrom: from,
    now,
  };
  const claimInput = input.emailObserverEffectFence
    ? {
        ...baseClaimInput,
        emailObserverEffectFence: input.emailObserverEffectFence,
        confirmationTokenHash: match.confirmationTokenHash,
        sourceDigest: applicationConfirmationSourceDigest({
          confirmationMessageId,
          confirmationFrom: from,
          subject: input.subject,
          body: input.body,
        }),
      }
    : baseClaimInput;
  if (input.emailObserverEffectFence) {
    const handoff = await applications.claimAndEnqueue(match.id, {
      ...claimInput,
      emailObserverEffectFence: input.emailObserverEffectFence,
      confirmationTokenHash: match.confirmationTokenHash,
      sourceDigest: applicationConfirmationSourceDigest({
        confirmationMessageId,
        confirmationFrom: from,
        subject: input.subject,
        body: input.body,
      }),
    });
    if (!handoff) {
      const current = await applications.get(match.id);
      if (current?.status === 'confirmation_received')
        throw new Error('application_confirmation_handoff_missing');
      if (current?.status === 'awaiting_confirmation')
        throw new Error('application_confirmation_claim_rejected');
      return current
        ? { kind: 'replay', applicationId: current.id, status: current.status }
        : { kind: 'ignored' };
    }
    notifyTaskEnqueued(handoff.task, handoff.created);
    if (handoff.task.status === 'done')
      return { kind: 'replay', applicationId: match.id, status: 'updated' };
    if (handoff.task.status === 'needs_attention' || handoff.task.status === 'failed')
      return { kind: 'replay', applicationId: match.id, status: handoff.record.status };
    return { kind: 'in_progress', applicationId: match.id };
  }

  const claimed = await applications.claim(match.id, claimInput);
  if (!claimed) {
    const current = await applications.get(match.id);
    return current
      ? { kind: 'replay', applicationId: current.id, status: current.status }
      : { kind: 'ignored' };
  }

  return enqueueAuthorizedUpdate(deps, input, claimed);
}

/** The persistence the confirmation flow needs, from either driver's bundle. */
export function applicationPersistence(
  persistence: ExecutionPersistence,
): ApplicationConfirmationDeps['persistence'] {
  const { applications } = persistence;
  if (!applications) throw new Error('application confirmations need a persistence repository');
  return { ...persistence, applications };
}

/**
 * The deterministic task handlers this module claims, exported as one list so
 * the module definition and test harnesses register the identical routing.
 */
export const applicationConfirmationTaskHandlers: readonly ModuleTaskHandler[] = [
  {
    kind: 'application_confirmation',
    run: (services, taskId, generation) =>
      executeApplicationConfirmationTask(
        {
          db: services.db,
          persistence: applicationPersistence(services.persistence),
          notifyOwner: services.ownerNotifier.notifyOwner,
          dispatcher: services.dispatcher,
        },
        taskId,
        generation,
      ),
  },
  {
    kind: 'application_confirmation_ambiguous',
    run: (services, taskId, generation) =>
      executeAmbiguousApplicationConfirmationTask(
        {
          persistence: applicationPersistence(services.persistence),
          notifyOwner: services.ownerNotifier.notifyOwner,
        },
        taskId,
        generation,
      ),
  },
];
