import type { NotificationOutboxLeg, NotificationOutboxRepository } from '@assistant/persistence';
import { AmbiguousApnsDeliveryError, type ApnsClient } from '@assistant/tools/modules/push';
import { describe, expect, it, vi } from 'vitest';
import {
  drainPushNotificationOutbox,
  notifyApprovalsByPush,
  notifyOwnerByPush,
} from './channel.js';

const conversationId = '00000000-0000-4000-8000-000000000001';
const taskId = '00000000-0000-4000-8000-000000000002';

function channel() {
  const send = vi.fn(async () => ({ ok: true }));
  const rows = new Map<string, NotificationOutboxLeg>();
  let next = 0;
  const notificationOutbox: NotificationOutboxRepository = {
    kind: 'notification-outbox-repository',
    async prepare(input) {
      const key = `${input.deliveryKey}:${input.legKey}`;
      const current = [...rows.values()].find(
        (row) => row.deliveryKey === input.deliveryKey && row.legKey === input.legKey,
      );
      if (current) return current;
      const row: NotificationOutboxLeg = {
        id: `outbox-${++next}`,
        agentId: input.agentId,
        deliveryKey: input.deliveryKey,
        legKey: input.legKey,
        adapter: input.adapter,
        status: 'pending',
        destination: input.destination,
        payload: input.payload,
        attempts: 0,
        retryable: false,
        availableAt: input.now,
        leaseToken: null,
        leaseUntil: null,
        providerMessageId: null,
        result: null,
        finishedAt: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      rows.set(key, row);
      return row;
    },
    async claim(input) {
      const row = [...rows.values()].find((candidate) => candidate.id === input.legId);
      if (!row || (row.status !== 'pending' && !(row.status === 'failed' && row.retryable)))
        return null;
      const claimed = {
        ...row,
        status: 'sending' as const,
        attempts: row.attempts + 1,
        leaseToken: `lease-${row.id}-${row.attempts + 1}`,
        leaseUntil: new Date(input.now.getTime() + input.leaseMs),
      };
      for (const [key, value] of rows) if (value.id === row.id) rows.set(key, claimed);
      return claimed;
    },
    async complete(input) {
      for (const [key, row] of rows) {
        if (row.id !== input.legId || row.leaseToken !== input.leaseToken) continue;
        rows.set(key, {
          ...row,
          status: input.status,
          retryable: input.status === 'failed' && input.retryable === true,
          availableAt: input.retryAt ?? input.now,
          leaseToken: null,
          leaseUntil: null,
          providerMessageId: input.providerMessageId ?? null,
          result: input.result ?? null,
          finishedAt: input.now,
        });
        return true;
      }
      return false;
    },
    async pending() {
      return [...rows.values()].filter((row) => row.status === 'pending' || row.retryable);
    },
    async recoverExpired() {
      return 0;
    },
  };
  return {
    send,
    rows,
    deps: {
      apns: { configured: () => true, send } as unknown as ApnsClient,
      devices: {
        listActive: async () => [{ token: 'synthetic', environment: 'sandbox' as const }],
        invalidate: async () => {},
      },
      notificationOutbox,
      owner: async () => ({ id: 'owner', name: 'Ada' }),
    },
  };
}

describe('push navigation identity', () => {
  it('retains the owner and actual conversation without changing the notification category', async () => {
    const { deps, send } = channel();
    const delivery = await notifyOwnerByPush(deps, {
      text: 'Your flight changed.',
      conversationId,
      taskId,
    });
    expect(delivery.legs).toEqual([{ channel: 'push', status: 'delivered' }]);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'ASSISTANT_UPDATE',
        data: { route: 'chat', agentId: 'owner', conversationId, taskId },
      }),
    );
  });

  it('drops paths, URLs and malformed destinations while keeping the legacy main-chat route', async () => {
    for (const invalid of ['../other-owner', 'https://other.example', 'not-an-id', null]) {
      const { deps, send } = channel();
      await notifyOwnerByPush(deps, {
        text: 'Update',
        conversationId: invalid,
        taskId: invalid ?? undefined,
      });
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { route: 'chat', agentId: 'owner' },
        }),
      );
    }
  });

  it('scopes approval navigation to the owner without inventing an actionable approval ID', async () => {
    const { deps, send } = channel();
    const delivery = await notifyApprovalsByPush(deps, [
      { taskId, shortCode: 'A7', summary: 'Send the RSVP' },
    ]);
    expect(delivery.legs).toEqual([{ channel: 'push', status: 'delivered' }]);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'ASSISTANT_ATTENTION',
        data: { route: 'approvals', agentId: 'owner' },
      }),
    );
  });

  it('reports unavailable push as skipped and provider rejection as failed', async () => {
    const unavailable = channel();
    unavailable.deps.apns = { configured: () => false } as unknown as ApnsClient;
    await expect(notifyOwnerByPush(unavailable.deps, { text: 'Update' })).resolves.toEqual({
      legs: [{ channel: 'push', status: 'skipped', reason: 'not-configured' }],
    });

    const rejected = channel();
    rejected.deps.apns = {
      configured: () => true,
      send: async () => ({ ok: false, status: 503, reason: 'unavailable' }),
    } as unknown as ApnsClient;
    await expect(notifyOwnerByPush(rejected.deps, { text: 'Update' })).resolves.toEqual({
      legs: [{ channel: 'push', status: 'failed', reason: 'provider-rejected' }],
    });

    const ambiguous = channel();
    ambiguous.deps.apns = {
      configured: () => true,
      send: async () => {
        throw new AmbiguousApnsDeliveryError('request outcome is unknown');
      },
    } as unknown as ApnsClient;
    await expect(notifyOwnerByPush(ambiguous.deps, { text: 'Update' })).resolves.toEqual({
      legs: [{ channel: 'push', status: 'unknown', reason: 'provider-outcome-unknown' }],
    });
  });

  it('retries only a definitively failed device leg and preserves its accepted sibling', async () => {
    const { deps, rows } = channel();
    const devices = [
      { token: 'device-a', environment: 'sandbox' as const },
      { token: 'device-b', environment: 'sandbox' as const },
    ];
    deps.devices.listActive = async () => devices;
    const attempts = new Map<string, number>();
    deps.apns = {
      configured: () => true,
      send: async ({ token }: { token: string }) => {
        const next = (attempts.get(token) ?? 0) + 1;
        attempts.set(token, next);
        return token === 'device-b' && next === 1
          ? { ok: false, status: 503, reason: 'synthetic rejection' }
          : { ok: true };
      },
    } as unknown as ApnsClient;
    const input = { deliveryKey: 'test:two-device-notice', text: 'Synthetic notice' };
    const first = await notifyOwnerByPush(deps, input);
    expect(first.legs.map((leg) => leg.status)).toEqual(['delivered', 'failed']);
    expect(attempts).toEqual(
      new Map([
        ['device-a', 1],
        ['device-b', 1],
      ]),
    );
    expect([...rows.values()].map((row) => row.status).sort()).toEqual(['delivered', 'failed']);

    await drainPushNotificationOutbox(deps, new Date(Date.now() + 60_000));
    expect(attempts).toEqual(
      new Map([
        ['device-a', 1],
        ['device-b', 2],
      ]),
    );
    expect([...rows.values()].map((row) => row.status).sort()).toEqual(['delivered', 'delivered']);
  });
});
