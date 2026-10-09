import type { NotificationOutboxLeg, NotificationOutboxRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';

/**
 * D7 regression pin: approval parks and owner pings fire exactly when
 * something needs the owner — they must carry the same budget carve-out
 * (critical: true) as final replies, or a day at the cap silently swallows
 * the one out-of-band signal the owner was supposed to get.
 */
const reserved: Array<{
  source: string;
  critical?: boolean;
  description: string;
  estimatedUsd: number;
}> = [];

vi.mock('@assistant/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assistant/core')>();
  return {
    ...actual,
    getRate: async () => ({ source: 'twilio_sms', unit: 'message', unitPriceUsd: 0.0079 }),
    reserveCost: async (
      _db: unknown,
      input: { source: string; critical?: boolean; description: string; estimatedUsd: number },
    ) => {
      reserved.push({
        source: input.source,
        critical: input.critical,
        description: input.description,
        estimatedUsd: input.estimatedUsd,
      });
      return { ok: true as const, reservationId: '00000000-0000-0000-0000-000000000000' };
    },
    reconcileReservation: async () => {},
    releaseReservation: async () => {},
  };
});

import { notifyApprovalsBySms, notifyOwnerBySms, type SmsChannelDeps } from './channel.js';

function fakeDeps(): SmsChannelDeps {
  const rows = new Map<string, NotificationOutboxLeg>();
  let nextId = 0;
  const notificationOutbox: NotificationOutboxRepository = {
    kind: 'notification-outbox-repository',
    async prepare(input) {
      const existing = [...rows.values()].find(
        (row) =>
          row.agentId === input.agentId &&
          row.deliveryKey === input.deliveryKey &&
          row.legKey === input.legKey,
      );
      if (existing) return existing;
      const now = input.now;
      const row: NotificationOutboxLeg = {
        id: `notice-${++nextId}`,
        agentId: input.agentId,
        deliveryKey: input.deliveryKey,
        legKey: input.legKey,
        adapter: input.adapter,
        status: 'pending',
        destination: input.destination,
        payload: input.payload,
        attempts: 0,
        retryable: false,
        availableAt: now,
        leaseToken: null,
        leaseUntil: null,
        providerMessageId: null,
        result: null,
        finishedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.id, row);
      return row;
    },
    async claim(input) {
      const row = rows.get(input.legId);
      if (!row || row.agentId !== input.agentId || row.availableAt > input.now) return null;
      const claimed = {
        ...row,
        status: 'sending',
        attempts: row.attempts + 1,
        leaseToken: `lease-${row.attempts + 1}`,
        leaseUntil: new Date(input.now.getTime() + input.leaseMs),
        updatedAt: input.now,
      } satisfies NotificationOutboxLeg;
      rows.set(row.id, claimed);
      return claimed;
    },
    async complete(input) {
      const row = rows.get(input.legId);
      if (!row || row.agentId !== input.agentId || row.leaseToken !== input.leaseToken)
        return false;
      rows.set(row.id, {
        ...row,
        status: input.status,
        retryable: input.retryable ?? false,
        availableAt: input.retryAt ?? row.availableAt,
        providerMessageId: input.providerMessageId ?? null,
        result: input.result ?? null,
        finishedAt: input.now,
        leaseToken: null,
        leaseUntil: null,
        updatedAt: input.now,
      });
      return true;
    },
    async pending(agentId, limit = 100, now = new Date()) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.agentId === agentId &&
            (row.status === 'pending' || (row.status === 'failed' && row.retryable)) &&
            row.availableAt <= now,
        )
        .slice(0, limit);
    },
    async recoverExpired() {
      return 0;
    },
  };
  // The channel rate-limit check runs before every send; an open channel keeps
  // these tests about budgeting.
  return {
    config: { OWNER_PHONE: '+14155550100' } as SmsChannelDeps['config'],
    registry: { smsApprovable: () => false } as unknown as SmsChannelDeps['registry'],
    persistence: {
      smsChannel: {
        underChannelLimit: async () => true,
      } as unknown as SmsChannelDeps['persistence']['smsChannel'],
      notificationOutbox,
      costs: {} as SmsChannelDeps['persistence']['costs'],
      approvals: {} as SmsChannelDeps['persistence']['approvals'],
      messages: {} as SmsChannelDeps['persistence']['messages'],
      tasks: {} as SmsChannelDeps['persistence']['tasks'],
    },
    owner: async () => ({ id: 'owner' }),
    twilio: {
      configured: () => true,
      send: async () => ({ sid: 'SM-fake' }),
    } as unknown as SmsChannelDeps['twilio'],
  } as SmsChannelDeps;
}

describe('owner-facing SMS pings are budget-critical', () => {
  it('approval park notifications reserve with the critical carve-out', async () => {
    reserved.length = 0;
    const delivery = await notifyApprovalsBySms(fakeDeps(), [
      { taskId: '00000000-0000-0000-0000-000000000001', shortCode: 'A9', summary: 'Send email' },
    ]);
    expect(delivery.legs).toMatchObject([
      {
        channel: 'sms',
        status: 'delivered',
        smsAccounting: { submittedMessages: 1, estimatedSegments: 2, encoding: 'ucs2' },
      },
    ]);
    expect(reserved).toHaveLength(1);
    expect(reserved[0]?.critical).toBe(true);
    expect(reserved[0]?.estimatedUsd).toBeCloseTo(0.0158);
    expect(reserved[0]?.description).toContain('2 estimated segment(s)');
  });

  it('owner async updates reserve with the critical carve-out', async () => {
    reserved.length = 0;
    const delivery = await notifyOwnerBySms(fakeDeps(), { text: 'A task permanently failed.' });
    expect(delivery.legs).toMatchObject([
      {
        channel: 'sms',
        status: 'delivered',
        smsAccounting: { submittedMessages: 1, estimatedSegments: 1, encoding: 'gsm7' },
      },
    ]);
    expect(reserved).toHaveLength(1);
    expect(reserved[0]?.critical).toBe(true);
    expect(reserved[0]?.estimatedUsd).toBeCloseTo(0.0079);
    expect(reserved[0]?.description).toContain('1 estimated segment(s)');
  });

  it('reports unconfigured SMS as skipped without attempting a send', async () => {
    reserved.length = 0;
    const deps = fakeDeps();
    deps.twilio = { configured: () => false } as unknown as SmsChannelDeps['twilio'];
    const delivery = await notifyOwnerBySms(deps, { text: 'A task permanently failed.' });
    expect(delivery.legs).toEqual([
      { channel: 'sms', status: 'skipped', reason: 'not-configured' },
    ]);
    expect(reserved).toHaveLength(0);
  });
});
