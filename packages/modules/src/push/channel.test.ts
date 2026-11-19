import type { NotificationOutboxLeg, NotificationOutboxRepository } from '@assistant/persistence';
import { AmbiguousApnsDeliveryError, type ApnsClient } from '@assistant/tools/modules/push';
import { describe, expect, it, vi } from 'vitest';
import {
  drainPushNotificationOutbox,
  notifyApprovalsByPush,
  notifyOwnerByPush,
  type PushChannelDeps,
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
      if (
        !row ||
        row.availableAt > input.now ||
        (row.status !== 'pending' && !(row.status === 'failed' && row.retryable))
      )
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
      admitAnswerReady: vi
        .fn<NonNullable<PushChannelDeps['admitAnswerReady']>>()
        .mockResolvedValue({ deliver: true }),
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

const answer = {
  purpose: 'answer-ready' as const,
  deliveryKey: 'task-answer:synthetic',
  conversationId,
  taskId,
  text: 'Private medical information',
};

describe('answer-ready push delivery', () => {
  it('sends generic copy once per device and opens only the source conversation', async () => {
    const { deps, send, rows } = channel();
    await notifyOwnerByPush(deps, answer);
    await notifyOwnerByPush(deps, { ...answer, text: 'Another private answer' });
    expect(send).toHaveBeenCalledExactlyOnceWith({
      token: 'synthetic',
      environment: 'sandbox',
      title: 'Assistant',
      body: 'Your reply is ready.',
      category: 'ASSISTANT_UPDATE',
      expiresAt: expect.any(Number),
      data: { route: 'chat', agentId: 'owner', conversationId },
    });
    expect(JSON.stringify([...rows.values()])).not.toContain(answer.text);
  });

  it('holds replay after quiet hours and never sends an expired queued answer', async () => {
    for (const delayedMinutes of [1, 15]) {
      const { deps, rows } = channel();
      const reject = vi.fn(async () => ({ ok: false, status: 503 }));
      deps.apns = { configured: () => true, send: reject } as unknown as ApnsClient;
      deps.admitAnswerReady = vi
        .fn<NonNullable<PushChannelDeps['admitAnswerReady']>>()
        .mockResolvedValueOnce({ deliver: true })
        .mockResolvedValue({ deliver: false, reason: 'quiet-hours' });
      await notifyOwnerByPush(deps, answer);
      const [first] = rows.values();
      if (!first) throw new Error('missing outbox leg');
      await drainPushNotificationOutbox(
        deps,
        new Date(first.createdAt.getTime() + delayedMinutes * 60_000),
      );
      expect(reject).toHaveBeenCalledOnce();
      expect([...rows.values()][0]).toMatchObject({
        status: 'skipped',
        result: { reason: delayedMinutes === 15 ? 'answer-ready-expired' : 'quiet-hours' },
      });
    }
  });

  it('ends a definitive retry sequence after three provider attempts', async () => {
    const { deps, rows } = channel();
    const reject = vi.fn(async () => ({ ok: false, status: 503 }));
    deps.apns = { configured: () => true, send: reject } as unknown as ApnsClient;
    await notifyOwnerByPush(deps, answer);
    const [first] = rows.values();
    if (!first) throw new Error('missing outbox leg');
    for (const minutes of [1, 2, 3]) {
      await drainPushNotificationOutbox(
        deps,
        new Date(first.createdAt.getTime() + minutes * 60_000),
      );
    }
    expect(reject).toHaveBeenCalledTimes(3);
    expect([...rows.values()][0]).toMatchObject({ status: 'failed', retryable: false });
  });
});
