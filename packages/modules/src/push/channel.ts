import { truncateAtBoundary } from '@assistant/core/owner-text';
import type {
  ActiveDeviceToken,
  DeviceTokenRepository,
  NotificationOutboxLeg,
  NotificationOutboxRepository,
  NotificationOutboxSendResult,
} from '@assistant/persistence';
import {
  drainNotificationOutbox,
  type NotificationDeliveryResult,
  type NotificationLegResult,
  notificationDeliveryKey,
  notificationLeg,
  pushDeviceKey,
  sendNotificationOutboxLeg,
} from '@assistant/persistence';
import type { ApnsClient } from '@assistant/tools/modules/push';
import { AmbiguousApnsDeliveryError } from '@assistant/tools/modules/push';

export interface PushChannelDeps {
  apns: ApnsClient;
  devices: Pick<DeviceTokenRepository, 'listActive' | 'invalidate'>;
  notificationOutbox: NotificationOutboxRepository;
  /** The owner the notices belong to: their id selects devices, their name titles the alert. */
  owner: () => Promise<{ id: string; name: string }>;
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

async function deliver(
  deps: PushChannelDeps,
  agentId: string,
  deliveryKey: string,
  alert: { title: string; body: string; category: string; data?: Record<string, string> },
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
        (row) => sendPushOutboxLeg(deps, row, device),
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

function retryAt(attempts: number): Date {
  return new Date(Date.now() + Math.min(60 * 60_000, 15_000 * 2 ** Math.max(0, attempts - 1)));
}

async function sendPushOutboxLeg(
  deps: PushChannelDeps,
  row: NotificationOutboxLeg,
  knownDevice?: ActiveDeviceToken,
): Promise<NotificationOutboxSendResult> {
  if (!deps.apns.configured()) return { status: 'skipped', reason: 'push-provider-unavailable' };
  const destination = row.destination as { deviceKey?: unknown; environment?: unknown } | null;
  const alert = row.payload as {
    title?: unknown;
    body?: unknown;
    category?: unknown;
    data?: unknown;
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
  try {
    const result = await deps.apns.send({
      token: device.token,
      environment: device.environment,
      title: alert.title,
      body: alert.body,
      category: alert.category,
      ...(alert.data && typeof alert.data === 'object'
        ? { data: alert.data as Record<string, string> }
        : {}),
    });
    if (result.ok) return { status: 'delivered', providerMessageId: result.apnsId };
    if (result.unregistered) {
      await deps.devices.invalidate(device.token).catch((err) => {
        console.error('push: could not invalidate an unregistered token', err);
      });
    }
    const retryable = !result.unregistered && (result.status === 429 || result.status >= 500);
    return {
      status: 'failed',
      retryable,
      ...(retryable ? { retryAt: retryAt(row.attempts) } : {}),
      reason: result.unregistered ? 'device-unregistered' : 'provider-rejected',
      result: { status: result.status },
    };
  } catch (error) {
    return error instanceof AmbiguousApnsDeliveryError
      ? { status: 'unknown', reason: 'provider-outcome-unknown' }
      : {
          status: 'failed',
          retryable: true,
          retryAt: retryAt(row.attempts),
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
    limit: 100,
    send: (row) => sendPushOutboxLeg(deps, row),
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
    taskId?: string;
    conversationId?: string | null;
    text: string;
    deliveryKey?: string;
    applicationConfirmationNoticeFence?: import('@assistant/persistence').ApplicationConfirmationNoticeFence;
  },
): Promise<NotificationDeliveryResult> {
  if (!deps.apns?.configured()) return notificationLeg('push', 'skipped', 'not-configured');
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
      title: agent.name,
      body: plain(input.text),
      category: UPDATE_CATEGORY,
      data: {
        route: 'chat',
        agentId: agent.id,
        ...(uuid(input.conversationId) ? { conversationId: input.conversationId as string } : {}),
        ...(uuid(input.taskId) ? { taskId: input.taskId as string } : {}),
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
