import { truncateAtBoundary } from '@assistant/core/owner-text';
import type { DeviceTokenRepository } from '@assistant/persistence';
import type { ApnsClient } from '@assistant/tools/modules/push';

export interface PushChannelDeps {
  apns: ApnsClient;
  devices: Pick<DeviceTokenRepository, 'listActive' | 'invalidate'>;
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
  alert: { title: string; body: string; category: string; data?: Record<string, string> },
): Promise<void> {
  if (!deps.apns?.configured()) return;
  const agent = await deps.owner();
  const devices = await deps.devices.listActive(agent.id);
  for (const device of devices) {
    const result = await deps.apns
      .send({
        token: device.token,
        environment: device.environment,
        ...alert,
      })
      .catch((err) => {
        console.error('push: send failed', err);
        return undefined;
      });
    if (result && !result.ok) {
      if (result.unregistered) await deps.devices.invalidate(device.token);
      else console.error('push: APNs rejected a send', result.status, result.reason);
    }
  }
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
  input: { taskId?: string; conversationId?: string | null; text: string },
): Promise<void> {
  if (!deps.apns?.configured()) return;
  const agent = await deps.owner();
  await deliver(deps, {
    title: agent.name,
    body: plain(input.text),
    category: UPDATE_CATEGORY,
    data: {
      route: 'chat',
      agentId: agent.id,
      ...(uuid(input.conversationId) ? { conversationId: input.conversationId as string } : {}),
      ...(uuid(input.taskId) ? { taskId: input.taskId as string } : {}),
    },
  });
}

/** Approval park ping: one tap lands the owner on the Approvals sheet. */
export async function notifyApprovalsByPush(
  deps: PushChannelDeps,
  approvals: ReadonlyArray<{ taskId: string; shortCode: string; summary: string }>,
): Promise<void> {
  if (!deps.apns?.configured() || approvals.length === 0) return;
  const agent = await deps.owner();
  const single = approvals.length === 1 ? approvals[0] : undefined;
  // No approvalId in the payload: the notifier port only carries the short
  // code, and a wrong id would mis-resolve the notification's Approve/Deny
  // action — the tap routes to the Approvals sheet instead.
  await deliver(deps, {
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
