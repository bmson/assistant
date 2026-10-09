import { createHash } from 'node:crypto';
import type { Config } from '@assistant/config';
import {
  BudgetReservationError,
  enqueueTask,
  getRate,
  persistMessage,
  reconcileReservation,
  releaseReservation,
  reserveCost,
  resolveApproval,
} from '@assistant/core';
import { truncateAtBoundary } from '@assistant/core/owner-text';
import {
  drainNotificationOutbox,
  type ExecutionPersistence,
  estimateSmsSegments,
  type FinalChannelDeliveryResult,
  finalChannelDelivery,
  type NotificationDeliveryResult,
  type NotificationLegResult,
  type NotificationOutboxLeg,
  type NotificationOutboxSendResult,
  notificationDeliveryKey,
  notificationLeg,
  notificationLegEntry,
  type Records,
  type SmsChannelRepository,
  type SmsDeliveryAccounting,
  type SmsUsageReconciliationOutcome,
  sendNotificationOutboxLeg,
  smsUsageReconciliationState,
} from '@assistant/persistence';
import { isAmbiguousTwilioDeliveryError, parseApprovalReply } from '@assistant/tools';
import { submitSms, type TwilioClient } from '@assistant/tools/modules/sms';
import type { ToolRegistry } from '@assistant/tools/registry';

/**
 * What the SMS channel actually consumes — the module builds this from its
 * own client plus the platform context, so nothing here depends on the agent
 * app's dependency graph.
 */
export interface SmsChannelDeps {
  config: Config;
  registry: ToolRegistry;
  twilio: TwilioClient;
  /** Metering, approvals, messages, and tasks, plus the channel's own state. */
  persistence: Pick<
    ExecutionPersistence,
    'costs' | 'approvals' | 'messages' | 'tasks' | 'notificationOutbox'
  > & {
    smsChannel: SmsChannelRepository;
  };
  /** The owner an inbound SMS belongs to. */
  owner: () => Promise<{ id: string }>;
}

const SMS_USAGE_RECONCILIATION_BATCH = 20;
const SMS_USAGE_RECONCILIATION_MAX_ATTEMPTS = 24;
const SMS_USAGE_RECONCILIATION_MAX_AGE_MS = 14 * 24 * 60 * 60_000;

/** Retry delayed Twilio Message usage reads without ever resubmitting a message. */
export async function reconcilePendingSmsUsage(
  deps: SmsChannelDeps,
  now = new Date(),
): Promise<number> {
  if (!deps.twilio.configured() || !deps.twilio.getMessageUsage) return 0;
  const claims = await deps.persistence.smsChannel.claimSmsUsageReconciliation(
    now,
    SMS_USAGE_RECONCILIATION_BATCH,
  );
  let settled = 0;
  for (const claim of claims) {
    let outcome: SmsUsageReconciliationOutcome;
    try {
      const usage = await deps.twilio.getMessageUsage(claim.providerMessageId);
      if (usage.billedSegments !== undefined && usage.priceUsd !== undefined) {
        outcome = {
          kind: 'complete',
          billedSegments: usage.billedSegments,
          priceUsd: usage.priceUsd,
        };
      } else {
        outcome = smsUsageRetry(claim, now, 'Twilio usage fields are not final yet');
      }
    } catch (error) {
      outcome = smsUsageRetry(claim, now, error instanceof Error ? error.message : String(error));
    }
    try {
      if (await deps.persistence.smsChannel.settleSmsUsageReconciliation(claim, outcome)) settled++;
    } catch (error) {
      // The claim lease expires and the same known SID is safe to query again.
      console.error('SMS usage reconciliation persistence failed', error);
    }
  }
  return settled;
}

function smsUsageRetry(
  claim: import('@assistant/persistence').SmsUsageReconciliationClaim,
  now: Date,
  error: string,
): SmsUsageReconciliationOutcome {
  const expired = now.getTime() - claim.createdAt.getTime() >= SMS_USAGE_RECONCILIATION_MAX_AGE_MS;
  if (claim.attempts >= SMS_USAGE_RECONCILIATION_MAX_ATTEMPTS || expired)
    return { kind: 'exhausted', error };
  const delayMs = Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.min(8, claim.attempts - 1));
  return { kind: 'retry', nextAttemptAt: new Date(now.getTime() + delayMs), error };
}

export interface InboundSms {
  messageSid: string;
  from: string;
  to: string;
  body: string;
}

export type SmsHandled =
  | { kind: 'approval'; resolved: boolean; shortCode: string; decision: string }
  | { kind: 'task'; taskId: string; created: boolean }
  | { kind: 'ignored'; reason: string };

/**
 * The `channel:sms` rate limit covers every outbound SMS regardless of origin
 * — tool sends, final-answer delivery, approval pings, owner notifications —
 * counted against the cost events each reconciled send records. The per-tool
 * `tool:sms.send` limit alone misses the channel deliverers, which is how a
 * notification loop could otherwise spend without a ceiling.
 */
function underSmsChannelLimit(deps: SmsChannelDeps): Promise<boolean> {
  return deps.persistence.smsChannel.underChannelLimit(new Date());
}

class SmsChannelRateLimitError extends Error {
  constructor() {
    super('SMS channel rate limit exceeded');
    this.name = 'SmsChannelRateLimitError';
  }
}

async function sendMeteredSms(
  deps: SmsChannelDeps,
  input: {
    to: string;
    text: string;
    taskId?: string;
    description: string;
    critical?: boolean;
  },
): Promise<{
  deliveryStatus: 'accepted' | 'unknown';
  sid?: string;
  smsAccounting: SmsDeliveryAccounting;
}> {
  const estimate = estimateSmsSegments(input.text);
  if (!(await underSmsChannelLimit(deps))) {
    // Callers already treat delivery errors as retryable-later without
    // re-running the model, so failing here is safe and visible.
    throw new SmsChannelRateLimitError();
  }
  const costs = deps.persistence.costs;
  const rate = await getRate(costs, 'twilio_sms');
  const reservation = await reserveCost(costs, {
    source: 'twilio_sms',
    estimatedUsd: estimate.estimatedSegments * rate.unitPriceUsd,
    taskId: input.taskId,
    description: `${input.description} (${estimate.estimatedSegments} estimated segment(s))`,
    critical: input.critical,
  });
  if (!reservation.ok) {
    throw new BudgetReservationError(reservation.reason, reservation.resumeAt);
  }
  const reconcileAttempt = (receipt?: SmsDeliveryAccounting, providerPriceUsd?: number) => {
    const quantity = receipt?.billedSegments ?? estimate.estimatedSegments;
    const usd = providerPriceUsd ?? quantity * rate.unitPriceUsd;
    return reconcileReservation(costs, reservation.reservationId, {
      evidence: {
        basis: providerPriceUsd !== undefined ? 'provider_reported' : 'preflight_estimate',
        provider: 'twilio',
        ...(receipt?.providerMessageId ? { requestId: receipt.providerMessageId } : {}),
        sms: receipt ?? estimate,
        ...(receipt?.providerMessageId
          ? { smsUsageReconciliation: smsUsageReconciliationState(receipt) }
          : {}),
      },
      usd,
      quantity,
      unit: 'segment',
      unitPriceUsd: quantity > 0 ? usd / quantity : rate.unitPriceUsd,
      description: input.description,
    });
  };
  let result: { sid: string };
  let sent: Awaited<ReturnType<typeof submitSms>>;
  try {
    sent = await submitSms(deps.twilio, input.to, input.text);
    result = { sid: sent.sid };
  } catch (error) {
    if (isAmbiguousTwilioDeliveryError(error)) {
      // The provider may already have accepted and billed this message. Count
      // the attempt, then treat it as delivered so the durable final-response
      // retry loop cannot send a duplicate merely because the response was lost.
      const ambiguousAccounting: SmsDeliveryAccounting = estimate;
      await reconcileAttempt(ambiguousAccounting).catch((reconcileError) =>
        console.error('ambiguous SMS cost reconciliation failed', reconcileError),
      );
      console.error('SMS delivery outcome is unknown; automatic retry suppressed', error);
      return { deliveryStatus: 'unknown', smsAccounting: ambiguousAccounting };
    }
    await releaseReservation(costs, reservation.reservationId).catch(() => {});
    throw error;
  }

  const smsAccounting = sent.accounting;
  // The provider side effect already happened. Never throw from metering and
  // cause a duplicate SMS; keep the hold conservative if reconciliation fails.
  await reconcileAttempt(smsAccounting, sent.providerUsage?.priceUsd).catch((error) =>
    console.error('SMS cost reconciliation failed', error),
  );
  return { deliveryStatus: 'accepted', sid: result.sid, smsAccounting };
}

/** One short, metered owner-only SMS for the deployed integration canary. */
export async function sendCanarySms(
  deps: SmsChannelDeps,
  marker: string,
): Promise<{
  deliveryStatus: 'accepted' | 'unknown';
  sid?: string;
  smsAccounting: SmsDeliveryAccounting;
}> {
  if (!deps.twilio.configured() || !deps.config.OWNER_PHONE) {
    throw new Error('Twilio or OWNER_PHONE is not configured');
  }
  const text = `[assistant canary ${marker.slice(0, 8)}] SMS delivery check. No reply needed.`;
  if (text.length > 160 || /[^\x20-\x7E]/.test(text)) {
    throw new Error('canary SMS must remain one GSM-compatible segment');
  }
  return sendMeteredSms(deps, {
    to: deps.config.OWNER_PHONE,
    text,
    description: `canary SMS ${marker}`,
  });
}

/**
 * Inbound SMS → approval resolution ("YES A7", owner only) or an sms_turn
 * workflow. Idempotent on MessageSid.
 */
export async function handleInboundSms(deps: SmsChannelDeps, sms: InboundSms): Promise<SmsHandled> {
  const isOwner = sms.from === deps.config.OWNER_PHONE;

  // SMS is a private owner channel, not a public chatbot. Fail closed before
  // touching the database so an unpaired number cannot create a conversation,
  // enqueue model work, or obtain an automated response.
  if (!isOwner) return { kind: 'ignored', reason: 'sms sender is not paired owner' };

  const agent = await deps.owner();

  const approvalReply = parseApprovalReply(sms.body);
  if (approvalReply) {
    // The inbound From is spoofable, so a one-tap SMS may resolve only
    // low-consequence approvals. Anything that sends, spends, egresses, or
    // writes durable memory must be reviewed on the authenticated dashboard,
    // where the exact arguments are visible. Enforced server-side here, not
    // just in the notification copy.
    const pendingTool = await deps.persistence.smsChannel.pendingApprovalTool(
      approvalReply.shortCode,
    );
    if (pendingTool && !deps.registry.smsApprovable(pendingTool)) {
      await notifyOwnerBySms(deps, {
        text: `Approval ${approvalReply.shortCode} can only be confirmed on the dashboard — it sends, spends, or stores something, so I need you to review the exact details on the Approvals page.`,
      }).catch((err) => console.error('sms restricted-approval notice failed', err));
      return {
        kind: 'approval',
        resolved: false,
        shortCode: approvalReply.shortCode,
        decision: approvalReply.decision,
      };
    }
    const result = await resolveApproval(deps.persistence.approvals, {
      shortCode: approvalReply.shortCode,
      decision: approvalReply.decision,
      via: 'sms',
    });
    return {
      kind: 'approval',
      resolved: result.ok,
      shortCode: approvalReply.shortCode,
      decision: approvalReply.decision,
    };
  }

  const trust = 'owner' as const;
  const conversationId = await deps.persistence.smsChannel.conversationForPeer(
    agent.id,
    sms.from,
    trust,
  );
  await persistMessage(deps.persistence.messages, {
    conversationId,
    role: 'user',
    origin: 'owner',
    parts: [{ type: 'text', text: sms.body }],
    text: sms.body,
    channelMessageId: `sms:${sms.messageSid}`,
  });

  const { task, created } = await enqueueTask(deps.persistence.tasks, {
    type: 'sms_turn',
    event: {
      source: 'sms',
      externalEventId: `sms:${sms.messageSid}`,
      agentId: agent.id,
      conversationId,
      trust,
      payload: { from: sms.from, body: sms.body },
    },
  });
  return { kind: 'task', taskId: task.id, created };
}

/** Executor hook: deliver a finished sms_turn's final text back to the peer. */
export async function deliverSmsFinal(
  deps: SmsChannelDeps,
  task: Pick<Records['tasks'], 'id' | 'conversationId' | 'trust' | 'type'>,
  text: string,
  attemptId = `sms-final:${task.id}`,
): Promise<FinalChannelDeliveryResult> {
  if (task.trust !== 'owner')
    return finalChannelDelivery('sms', 'not_applicable', attemptId, 'non-owner-task');
  const requiredByType = task.type === 'sms_turn';
  if (!task.conversationId) {
    return requiredByType
      ? finalChannelDelivery('sms', 'rejected', attemptId, 'missing-conversation')
      : finalChannelDelivery('sms', 'not_applicable', attemptId, 'no-conversation');
  }
  const destination = await deps.persistence.smsChannel.finalDestination(task.conversationId);
  if (!requiredByType && destination?.channel !== 'sms')
    return finalChannelDelivery('sms', 'not_applicable', attemptId, 'not-sms-conversation');
  if (destination?.channel !== 'sms')
    return finalChannelDelivery('sms', 'rejected', attemptId, 'sms-conversation-unavailable');
  if (!deps.twilio.configured() || !deps.config.OWNER_PHONE)
    return finalChannelDelivery('sms', 'rejected', attemptId, 'provider-not-configured');
  if (destination.trust !== 'owner')
    return finalChannelDelivery('sms', 'rejected', attemptId, 'conversation-not-owner');
  if (!destination.externalId || destination.externalId !== deps.config.OWNER_PHONE)
    return finalChannelDelivery('sms', 'rejected', attemptId, 'owner-phone-binding-changed');
  try {
    const result = await sendMeteredSms(deps, {
      to: destination.externalId,
      text: truncateAtBoundary(text, 1500),
      taskId: task.id,
      description: 'owner SMS task reply',
      critical: true,
    });
    return finalChannelDelivery(
      'sms',
      result.deliveryStatus === 'accepted' ? 'accepted' : 'unknown',
      attemptId,
      result.deliveryStatus === 'unknown' ? 'provider-outcome-unknown' : undefined,
      result.smsAccounting,
    );
  } catch (error) {
    console.error('SMS final delivery was rejected before acceptance', error);
    return finalChannelDelivery('sms', 'rejected', attemptId, 'provider-or-budget-rejected');
  }
}

/**
 * Executor/mission hook: push a one-off owner update to OWNER_PHONE for async
 * events the owner would otherwise only see on the dashboard (a task that
 * permanently failed, a budget stall, a mission escalation/deadline, or a
 * completed application-confirmation follow-up). Mirrors notifyApprovalsBySms:
 * always to the owner's own number, metered, and best-effort at the call site.
 */
export async function notifyOwnerBySms(
  deps: SmsChannelDeps,
  input: {
    taskId?: string;
    text: string;
    deliveryKey?: string;
    applicationConfirmationNoticeFence?: import('@assistant/persistence').ApplicationConfirmationNoticeFence;
  },
): Promise<NotificationDeliveryResult> {
  // Optional chaining: some internal/test call paths build a partial deps
  // without a Twilio client or config. A missing notifier is a silent no-op,
  // never an error — owner pings are best-effort.
  if (!deps.twilio?.configured() || !deps.config?.OWNER_PHONE)
    return notificationLeg('sms', 'skipped', 'not-configured');
  // critical: these pings fire exactly when something needs the owner (failure,
  // stall, escalation) — a budget cap must degrade them last, like final replies.
  const owner = await deps.owner();
  const text = truncateAtBoundary(input.text, 480);
  const recipientHash = smsRecipientKey(deps.config.OWNER_PHONE);
  return {
    legs: [
      await sendNotificationOutboxLeg(
        deps.persistence.notificationOutbox,
        {
          agentId: owner.id,
          deliveryKey:
            input.deliveryKey ??
            notificationDeliveryKey('sms-owner-notice', input.taskId ?? owner.id, text),
          legKey: `sms:${recipientHash}`,
          adapter: 'sms',
          destination: { recipientHash },
          payload: {
            text,
            ...(input.taskId ? { taskId: input.taskId } : {}),
            description: 'owner async update',
            critical: true,
          },
          ...(input.applicationConfirmationNoticeFence
            ? { applicationConfirmationNoticeFence: input.applicationConfirmationNoticeFence }
            : {}),
          now: new Date(),
        },
        (leg) => sendSmsOutboxLeg(deps, leg),
      ),
    ],
  };
}

function smsRecipientKey(phone: string): string {
  return createHash('sha256').update(phone).digest('hex');
}

function retryDelay(attempts: number): number {
  return Math.min(60 * 60_000, 15_000 * 2 ** Math.max(0, attempts - 1));
}

async function sendSmsOutboxLeg(
  deps: SmsChannelDeps,
  leg: NotificationOutboxLeg,
): Promise<NotificationOutboxSendResult> {
  const destination = leg.destination as { recipientHash?: unknown } | null;
  const payload = leg.payload as {
    text?: unknown;
    taskId?: unknown;
    description?: unknown;
    critical?: unknown;
  } | null;
  if (
    !payload ||
    typeof payload.text !== 'string' ||
    !destination ||
    destination.recipientHash !== smsRecipientKey(deps.config.OWNER_PHONE ?? '')
  )
    return { status: 'skipped', reason: 'owner-sms-destination-changed-or-erased' };
  if (!deps.twilio?.configured() || !deps.config.OWNER_PHONE)
    return { status: 'skipped', reason: 'sms-provider-unavailable' };
  try {
    const result = await sendMeteredSms(deps, {
      to: deps.config.OWNER_PHONE,
      text: payload.text,
      ...(typeof payload.taskId === 'string' ? { taskId: payload.taskId } : {}),
      description: typeof payload.description === 'string' ? payload.description : 'owner notice',
      critical: payload.critical === true,
    });
    return result.deliveryStatus === 'accepted'
      ? {
          status: 'delivered',
          providerMessageId: result.sid,
          smsAccounting: result.smsAccounting,
        }
      : {
          status: 'unknown',
          reason: 'provider-outcome-unknown',
          smsAccounting: result.smsAccounting,
        };
  } catch (error) {
    const retryAt =
      error instanceof BudgetReservationError
        ? error.resumeAt
        : new Date(Date.now() + retryDelay(leg.attempts));
    return {
      status: 'failed',
      retryable: true,
      retryAt,
      reason:
        error instanceof BudgetReservationError
          ? 'budget-reservation-deferred'
          : error instanceof SmsChannelRateLimitError
            ? 'channel-rate-limit'
            : 'definitive-send-rejection',
    };
  }
}

export async function drainSmsNotificationOutbox(
  deps: SmsChannelDeps,
  now = new Date(),
): Promise<number> {
  if (!deps.twilio?.configured() || !deps.config.OWNER_PHONE) return 0;
  const owner = await deps.owner();
  return drainNotificationOutbox(deps.persistence.notificationOutbox, {
    agentId: owner.id,
    adapter: 'sms',
    now,
    limit: 100,
    send: (leg) => sendSmsOutboxLeg(deps, leg),
  });
}

/** Executor hook: SMS the owner when approvals park a task. */
export async function notifyApprovalsBySms(
  deps: SmsChannelDeps,
  approvals: Array<{
    taskId: string;
    shortCode: string;
    summary: string;
    toolName?: string;
    deliveryKey?: string;
  }>,
): Promise<NotificationDeliveryResult> {
  if (approvals.length === 0) return notificationLeg('sms', 'skipped', 'empty-batch');
  if (!deps.twilio.configured() || !deps.config.OWNER_PHONE)
    return notificationLeg('sms', 'skipped', 'not-configured');
  const owner = await deps.owner();
  const recipientHash = smsRecipientKey(deps.config.OWNER_PHONE);
  const legs: NotificationLegResult[] = [];
  for (const approval of approvals) {
    // One-tap SMS resolution is offered only for low-consequence tools (see
    // ToolRegistry.smsApprovable); anything that sends, spends, egresses, or
    // stores must be reviewed on the authenticated dashboard. The copy matches
    // the server-side enforcement so the owner is never told to reply YES to
    // something that would then be refused.
    const oneTap = approval.toolName ? deps.registry.smsApprovable(approval.toolName) : false;
    const action = oneTap
      ? `Reply YES ${approval.shortCode} or NO ${approval.shortCode} (or use the dashboard).`
      : 'Review and approve it on the Approvals page of the dashboard.';
    // critical: the out-of-band ping is the whole point of an approval park —
    // dropping it at a budget cap is exactly when the owner most needs it.
    // A hard slice here severed the last word and glued the instruction
    // straight onto the stump. Truncation now marks its own end, so a stop is
    // added only when the summary does not already carry one.
    const summary = truncateAtBoundary(approval.summary, 120);
    const stop = /[.!?…]$/u.test(summary) ? '' : '.';
    try {
      const text = `Approval ${approval.shortCode} — ${summary}${stop} ${action}`;
      legs.push(
        await sendNotificationOutboxLeg(
          deps.persistence.notificationOutbox,
          {
            agentId: owner.id,
            deliveryKey:
              approval.deliveryKey ??
              notificationDeliveryKey('sms-approval', approval.taskId, approval.shortCode),
            legKey: `sms:${recipientHash}`,
            adapter: 'sms',
            destination: { recipientHash },
            payload: {
              text,
              taskId: approval.taskId,
              description: `approval notification ${approval.shortCode}`,
              critical: true,
            },
            now: new Date(),
          },
          (leg) => sendSmsOutboxLeg(deps, leg),
        ),
      );
    } catch {
      // Preserve the outcome of earlier approvals and keep sending independent
      // approvals even if one budget/provider operation fails.
      legs.push(notificationLegEntry('sms', 'failed', 'provider-or-budget-failure'));
    }
  }
  return { legs };
}
