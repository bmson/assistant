import { truncateAtBoundary } from '@assistant/core/owner-text';
import type {
  ActiveDeviceToken,
  DeviceTokenRepository,
  ExecutionContextRepository,
  NotificationOutboxLeg,
  NotificationOutboxRepository,
  NotificationOutboxSendResult,
  NudgePolicyRepository,
  OwnerNoticePurpose,
  PingDecision,
  ProactiveCanaryRepository,
} from '@assistant/persistence';
import {
  drainNotificationOutbox,
  HEALTH_CANARY_PUSH_TEXT,
  healthCanaryDeliveryDay,
  isWatchdogOutageDeliveryKey,
  type NotificationDeliveryResult,
  type NotificationLegResult,
  notificationDeliveryKey,
  notificationLeg,
  ownerLocalDay,
  ownerLocalMidnightUtc,
  pushDeviceKey,
  sendNotificationOutboxLeg,
  WATCHDOG_OUTAGE_TEXT,
} from '@assistant/persistence';
import type { ApnsClient } from '@assistant/tools/modules/push';
import { AmbiguousApnsDeliveryError } from '@assistant/tools/modules/push';

export interface PushChannelDeps {
  apns: ApnsClient;
  devices: Pick<DeviceTokenRepository, 'listActive' | 'invalidate'>;
  notificationOutbox: NotificationOutboxRepository;
  /** The owner the notices belong to: their id selects devices, their name titles the alert. */
  owner: () => Promise<{ id: string; name: string }>;
  loadTask?: ExecutionContextRepository['getTask'];
  admitAnswerReady?: (deliveryKey: string, now: Date) => Promise<PingDecision>;
  admitHealthCanary?: (deliveryKey: string, day: string, now: Date) => Promise<PingDecision | null>;
  admitWatchdog?: (deliveryKey: string, now: Date) => Promise<PingDecision>;
}

function privatePushRoute(agentId: string, healthCanary: boolean): Record<string, string> {
  return healthCanary
    ? { route: 'settings', section: 'noticing', agentId }
    : { route: 'chat', agentId };
}

export function healthCanaryAdmission(
  owner: () => Promise<{ id: string; timezone: string }>,
  policy: NudgePolicyRepository,
  canaries?: ProactiveCanaryRepository,
): NonNullable<PushChannelDeps['admitHealthCanary']> {
  return async (deliveryKey, day, now) => {
    const agent = await owner();
    if (
      ownerLocalDay(agent.timezone, now) !== day ||
      !canaries ||
      !(await canaries.hasOpenAlert(agent.id, ownerLocalMidnightUtc(agent.timezone, now)))
    )
      return null;
    return policy.evaluate(agent, {
      urgency: 'ambient',
      channel: notificationDeliveryKey('health-canary', deliveryKey),
      now,
    });
  };
}

/**
 * Push bodies are glanceable plain text: markdown stays on the dashboard.
 *
 * The final cut is word-aware. A notification is the whole message on a lock
 * screen — there is no "tap to see the rest of the sentence" — so a body that
 * stopped mid-word read as a truncated bug rather than as a summary, and gave
 * no sign that anything had been dropped.
 */
function plain(text: string, max = 220): string {
  return truncateAtBoundary(text.replace(/\*\*(.+?)\*\*/g, '$1'), max);
}

/** The app's UNNotificationCategory identifiers (NotificationManager.swift). */
const ATTENTION_CATEGORY = 'ASSISTANT_ATTENTION';
const UPDATE_CATEGORY = 'ASSISTANT_UPDATE';
const WATCHDOG_BODY = 'Scheduled checks need attention. Open Assistant for details.';
const ANSWER_READY_TTL_MS = 15 * 60_000;
const ANSWER_READY_MAX_ATTEMPTS = 3;

async function deliver(
  deps: PushChannelDeps,
  agentId: string,
  deliveryKey: string,
  alert: {
    title: string;
    body: string;
    category: string;
    data?: Record<string, string>;
    purpose?: 'answer-ready' | 'watchdog-outage' | 'health-canary';
    healthCanaryDay?: string;
  },
  applicationConfirmationNoticeFence?: import('@assistant/persistence').ApplicationConfirmationNoticeFence,
): Promise<NotificationDeliveryResult> {
  if (!deps.apns?.configured()) return notificationLeg('push', 'skipped', 'not-configured');
  const devices = await deps.devices.listActive(agentId);
  if (devices.length === 0) return notificationLeg('push', 'skipped', 'no-active-devices');
  const legs: NotificationLegResult[] = [];
  for (const device of devices) {
    const target = pushTarget(device);
    legs.push(
      await sendNotificationOutboxLeg(
        deps.notificationOutbox,
        {
          agentId,
          deliveryKey,
          legKey: `push:${target.deviceKey}`,
          adapter: 'push',
          destination: target,
          payload: alert,
          ...(applicationConfirmationNoticeFence ? { applicationConfirmationNoticeFence } : {}),
          now: new Date(),
        },
        (row) => sendPushOutboxLeg(deps, row, new Date(), device),
      ),
    );
  }
  return { legs };
}

function pushTarget(device: ActiveDeviceToken): { deviceKey: string; environment: string } {
  return {
    deviceKey: pushDeviceKey(device.token),
    environment: device.environment,
  };
}

function retryAt(now: Date, attempts: number): Date {
  return new Date(now.getTime() + Math.min(60 * 60_000, 15_000 * 2 ** Math.max(0, attempts - 1)));
}

async function sendPushOutboxLeg(
  deps: PushChannelDeps,
  row: NotificationOutboxLeg,
  now: Date,
  knownDevice?: ActiveDeviceToken,
): Promise<NotificationOutboxSendResult> {
  if (!deps.apns.configured()) return { status: 'skipped', reason: 'push-provider-unavailable' };
  const destination = row.destination as { deviceKey?: unknown; environment?: unknown } | null;
  const alert = row.payload as {
    title?: unknown;
    body?: unknown;
    category?: unknown;
    data?: unknown;
    purpose?: unknown;
    healthCanaryDay?: unknown;
  } | null;
  if (
    !destination ||
    typeof destination.deviceKey !== 'string' ||
    (destination.environment !== 'sandbox' && destination.environment !== 'production') ||
    !alert ||
    typeof alert.title !== 'string' ||
    typeof alert.body !== 'string' ||
    typeof alert.category !== 'string'
  )
    return { status: 'skipped', reason: 'push-payload-erased-or-invalid' };
  const devices = knownDevice ? [knownDevice] : await deps.devices.listActive(row.agentId);
  const device = devices.find(
    (candidate) =>
      pushTarget(candidate).deviceKey === destination.deviceKey &&
      candidate.environment === destination.environment,
  );
  if (!device) return { status: 'skipped', reason: 'push-device-no-longer-active' };

  // The outbox hashes the episode identity. Older rows without a purpose
  // can only be recognized by their fixed text and main-chat destination.
  const data = alert.data as Record<string, unknown> | undefined;
  const legacyWatchdog =
    alert.purpose === undefined &&
    alert.category === UPDATE_CATEGORY &&
    Object.values(WATCHDOG_OUTAGE_TEXT).includes(alert.body) &&
    data?.route === 'chat' &&
    data.agentId === row.agentId &&
    data.conversationId === undefined &&
    data.taskId === undefined;
  const watchdog = alert.purpose === 'watchdog-outage' || legacyWatchdog;
  if (watchdog) {
    if (!deps.admitWatchdog) return { status: 'skipped', reason: 'watchdog-policy-unavailable' };
    const decision = await deps.admitWatchdog(row.deliveryKey, now);
    if (!decision.deliver) return { status: 'skipped', reason: decision.reason ?? 'watchdog-held' };
  }
  const healthCanary = alert.purpose === 'health-canary';
  if (healthCanary) {
    if (!deps.admitHealthCanary || typeof alert.healthCanaryDay !== 'string')
      return { status: 'skipped', reason: 'health-canary-policy-unavailable' };
    try {
      const decision = await deps.admitHealthCanary(row.deliveryKey, alert.healthCanaryDay, now);
      if (!decision?.deliver)
        return { status: 'skipped', reason: decision?.reason ?? 'health-canary-closed-or-expired' };
    } catch {
      // Policy failed before a provider submission, so the outbox can safely retry.
      return {
        status: 'failed',
        retryable: true,
        retryAt: retryAt(now, row.attempts),
        reason: 'health-canary-policy-read-failed',
      };
    }
  }
  const privateNotice = watchdog || healthCanary;
  const answerReady = alert.purpose === 'answer-ready';
  const expiresAt = answerReady ? row.createdAt.getTime() + ANSWER_READY_TTL_MS : undefined;
  if (expiresAt !== undefined && now.getTime() >= expiresAt)
    return { status: 'skipped', reason: 'answer-ready-expired' };
  if (answerReady) {
    if (!deps.admitAnswerReady)
      return { status: 'skipped', reason: 'answer-ready-policy-unavailable' };
    const decision = await deps.admitAnswerReady(row.deliveryKey, now);
    if (!decision.deliver)
      return { status: 'skipped', reason: decision.reason ?? 'answer-ready-held' };
  }
  const attemptsRemain = !answerReady || row.attempts < ANSWER_READY_MAX_ATTEMPTS;
  try {
    const result = await deps.apns.send({
      token: device.token,
      environment: device.environment,
      title: privateNotice ? 'Assistant' : alert.title,
      body: healthCanary ? HEALTH_CANARY_PUSH_TEXT : watchdog ? WATCHDOG_BODY : alert.body,
      category: privateNotice ? UPDATE_CATEGORY : alert.category,
      // The outbox owns retries so each attempt uses a fresh policy decision.
      ...(privateNotice ? { expiresAt: 0 } : expiresAt !== undefined ? { expiresAt } : {}),
      ...(privateNotice
        ? { data: privatePushRoute(row.agentId, healthCanary) }
        : alert.data && typeof alert.data === 'object'
          ? { data: alert.data as Record<string, string> }
          : {}),
    });
    if (result.ok) return { status: 'delivered', providerMessageId: result.apnsId };
    if (result.unregistered) {
      await deps.devices.invalidate(device.token).catch((err) => {
        console.error('push: could not invalidate an unregistered token', err);
      });
    }
    const retryable =
      attemptsRemain && !result.unregistered && (result.status === 429 || result.status >= 500);
    return {
      status: 'failed',
      retryable,
      ...(retryable ? { retryAt: retryAt(now, row.attempts) } : {}),
      reason: result.unregistered ? 'device-unregistered' : 'provider-rejected',
      result: { status: result.status },
    };
  } catch (error) {
    return error instanceof AmbiguousApnsDeliveryError
      ? { status: 'unknown', reason: 'provider-outcome-unknown' }
      : {
          status: 'failed',
          retryable: attemptsRemain,
          ...(attemptsRemain ? { retryAt: retryAt(now, row.attempts) } : {}),
          reason: 'send-rejected',
        };
  }
}

export async function drainPushNotificationOutbox(
  deps: PushChannelDeps,
  now = new Date(),
): Promise<number> {
  if (!deps.apns?.configured()) return 0;
  const owner = await deps.owner();
  return drainNotificationOutbox(deps.notificationOutbox, {
    agentId: owner.id,
    adapter: 'push',
    now,
    loadTask: deps.loadTask,
    limit: 100,
    send: (row) => sendPushOutboxLeg(deps, row, new Date(Math.max(now.getTime(), Date.now()))),
  });
}

/**
 * Owner-notifier leg: push the same notice the dashboard leg posts, so an
 * owner away from the thread hears about failures, stalls, and proactive
 * nudges. Best-effort like every notifier leg — a push outage must never
 * swallow the dashboard copy (the fan-out in the composition root isolates
 * legs from one another anyway).
 */
export async function notifyOwnerByPush(
  deps: PushChannelDeps,
  input: {
    purpose?: OwnerNoticePurpose;
    taskId?: string;
    conversationId?: string | null;
    text: string;
    deliveryKey?: string;
    applicationConfirmationNoticeFence?: import('@assistant/persistence').ApplicationConfirmationNoticeFence;
  },
): Promise<NotificationDeliveryResult> {
  if (!deps.apns?.configured()) return notificationLeg('push', 'skipped', 'not-configured');
  const watchdog = input.purpose === 'watchdog-outage';
  if (watchdog && (!input.deliveryKey || !isWatchdogOutageDeliveryKey(input.deliveryKey)))
    return notificationLeg('push', 'skipped', 'watchdog-destination-invalid');
  const healthCanary = input.purpose === 'health-canary';
  const healthCanaryDay = healthCanary ? healthCanaryDeliveryDay(input.deliveryKey ?? '') : null;
  if (healthCanary && !healthCanaryDay)
    return notificationLeg('push', 'skipped', 'health-canary-day-invalid');
  const privateNotice = watchdog || healthCanary;
  const answerReady = input.purpose === 'answer-ready';
  if (answerReady && (!uuid(input.conversationId) || !input.deliveryKey))
    return notificationLeg('push', 'skipped', 'answer-ready-destination-invalid');
  const agent = await deps.owner();
  return deliver(
    deps,
    agent.id,
    input.deliveryKey ??
      notificationDeliveryKey(
        'push-owner-notice',
        input.taskId ?? agent.id,
        input.conversationId ?? 'no-conversation',
        input.text,
      ),
    {
      title: answerReady || privateNotice ? 'Assistant' : agent.name,
      body: healthCanary
        ? HEALTH_CANARY_PUSH_TEXT
        : watchdog
          ? WATCHDOG_BODY
          : answerReady
            ? 'Your reply is ready.'
            : plain(input.text),
      ...(healthCanaryDay ? { purpose: 'health-canary' as const, healthCanaryDay } : {}),
      ...(watchdog ? { purpose: 'watchdog-outage' as const } : {}),
      ...(answerReady ? { purpose: 'answer-ready' as const } : {}),
      category: UPDATE_CATEGORY,
      data: {
        ...privatePushRoute(agent.id, healthCanary),
        ...(!privateNotice && uuid(input.conversationId)
          ? { conversationId: input.conversationId as string }
          : {}),
        ...(!privateNotice && !answerReady && uuid(input.taskId)
          ? { taskId: input.taskId as string }
          : {}),
      },
    },
    input.applicationConfirmationNoticeFence,
  );
}

/** Approval park ping: one tap lands the owner on the Approvals sheet. */
export async function notifyApprovalsByPush(
  deps: PushChannelDeps,
  approvals: ReadonlyArray<{
    taskId: string;
    shortCode: string;
    summary: string;
    deliveryKey?: string;
  }>,
): Promise<NotificationDeliveryResult> {
  if (approvals.length === 0) return notificationLeg('push', 'skipped', 'empty-batch');
  if (!deps.apns?.configured()) return notificationLeg('push', 'skipped', 'not-configured');
  const agent = await deps.owner();
  const single = approvals.length === 1 ? approvals[0] : undefined;
  // No approvalId in the payload: the notifier port only carries the short
  // code, and a wrong id would mis-resolve the notification's Approve/Deny
  // action — the tap routes to the Approvals sheet instead.
  const deliveryKey =
    approvals.length === 1 && approvals[0]?.deliveryKey
      ? approvals[0].deliveryKey
      : notificationDeliveryKey(
          'push-approval-batch',
          ...approvals.map((approval) => `${approval.taskId}:${approval.shortCode}`).sort(),
        );
  return deliver(deps, agent.id, deliveryKey, {
    title: agent.name,
    body:
      single !== undefined
        ? `Needs your approval: ${plain(single.summary, 160)}`
        : `${approvals.length} things need your approval`,
    category: ATTENTION_CATEGORY,
    data: { route: 'approvals', agentId: agent.id },
  });
}

/** Destinations are identifiers, never paths or URLs supplied by notice text. */
function uuid(value: string | null | undefined): boolean {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
