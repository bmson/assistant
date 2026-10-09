import { describe, expect, it } from 'vitest';
import { notificationDeliveryKey } from './notification-delivery.js';
import {
  type NotificationOutboxLeg,
  type NotificationOutboxPreparation,
  type NotificationOutboxRepository,
  sendNotificationOutboxLeg,
} from './notification-outbox.js';

class MemoryOutbox implements NotificationOutboxRepository {
  readonly kind = 'notification-outbox-repository' as const;
  readonly rows = new Map<string, NotificationOutboxLeg>();
  private counter = 0;

  private key(input: Pick<NotificationOutboxPreparation, 'agentId' | 'deliveryKey' | 'legKey'>) {
    return `${input.agentId}:${input.deliveryKey}:${input.legKey}`;
  }

  async prepare(input: NotificationOutboxPreparation) {
    const key = this.key(input);
    const current = this.rows.get(key);
    if (current) {
      if (
        current.adapter !== input.adapter ||
        JSON.stringify(current.destination) !== JSON.stringify(input.destination) ||
        JSON.stringify(current.payload) !== JSON.stringify(input.payload)
      )
        throw new Error('notification delivery identity reused with a different frozen intent');
      return current;
    }
    const row: NotificationOutboxLeg = {
      id: `leg-${++this.counter}`,
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
    this.rows.set(key, row);
    return row;
  }

  async claim(input: Parameters<NotificationOutboxRepository['claim']>[0]) {
    const row = [...this.rows.values()].find(
      (candidate) => candidate.id === input.legId && candidate.agentId === input.agentId,
    );
    if (
      !row ||
      row.availableAt > input.now ||
      !(row.status === 'pending' || (row.status === 'failed' && row.retryable))
    )
      return null;
    const claimed = {
      ...row,
      status: 'sending',
      attempts: row.attempts + 1,
      retryable: false,
      leaseToken: `lease-${input.now.getTime()}-${row.attempts}`,
      leaseUntil: new Date(input.now.getTime() + input.leaseMs),
      updatedAt: input.now,
    } as NotificationOutboxLeg;
    const key = this.key(row);
    this.rows.set(key, claimed);
    return claimed;
  }

  async complete(input: Parameters<NotificationOutboxRepository['complete']>[0]) {
    const row = [...this.rows.values()].find(
      (candidate) => candidate.id === input.legId && candidate.agentId === input.agentId,
    );
    if (row?.status !== 'sending' || row.leaseToken !== input.leaseToken) return false;
    const retryable = input.status === 'failed' && input.retryable === true;
    this.rows.set(this.key(row), {
      ...row,
      status: input.status,
      retryable,
      availableAt: input.retryAt ?? input.now,
      leaseToken: null,
      leaseUntil: null,
      providerMessageId: input.providerMessageId ?? null,
      result: input.result ?? null,
      finishedAt: retryable ? null : input.now,
      updatedAt: input.now,
    });
    return true;
  }

  async pending(agentId: string) {
    return [...this.rows.values()].filter(
      (row) =>
        row.agentId === agentId &&
        row.availableAt <= new Date() &&
        (row.status === 'pending' || (row.status === 'failed' && row.retryable)),
    );
  }

  async recoverExpired(agentId: string, now: Date) {
    let count = 0;
    for (const [key, row] of this.rows) {
      if (
        row.agentId === agentId &&
        row.status === 'sending' &&
        row.leaseUntil !== null &&
        row.leaseUntil <= now
      ) {
        this.rows.set(key, {
          ...row,
          status: 'unknown',
          retryable: false,
          result: { reason: 'send lease expired' },
          leaseToken: null,
          leaseUntil: null,
          finishedAt: now,
          updatedAt: now,
        });
        count += 1;
      }
    }
    return count;
  }
}

const now = new Date('2026-10-07T12:00:00.000Z');
const preparation = (legKey: string, adapter = 'push'): NotificationOutboxPreparation => ({
  agentId: 'owner-1',
  deliveryKey: 'delivery-1',
  legKey,
  adapter,
  destination: { device: legKey },
  payload: { body: 'The work finished.' },
  now,
});

describe('durable notification outbox helper', () => {
  it('retries only a definitively failed destination and preserves a successful sibling', async () => {
    const outbox = new MemoryOutbox();
    const sends = new Map<string, number>();
    const send = async (row: NotificationOutboxLeg) => {
      sends.set(row.legKey, (sends.get(row.legKey) ?? 0) + 1);
      return row.legKey === 'device-b' && sends.get(row.legKey) === 1
        ? { status: 'failed' as const, retryable: true, reason: 'provider-rejected' }
        : { status: 'delivered' as const };
    };

    expect(await sendNotificationOutboxLeg(outbox, preparation('device-a'), send)).toMatchObject({
      status: 'delivered',
    });
    expect(await sendNotificationOutboxLeg(outbox, preparation('device-b'), send)).toMatchObject({
      status: 'failed',
    });
    expect(await sendNotificationOutboxLeg(outbox, preparation('device-a'), send)).toMatchObject({
      status: 'delivered',
    });
    expect(await sendNotificationOutboxLeg(outbox, preparation('device-b'), send)).toMatchObject({
      status: 'delivered',
    });
    expect(sends.get('device-a')).toBe(1);
    expect(sends.get('device-b')).toBe(2);
  });

  it('never retries an ambiguous attempt, including a sender throw', async () => {
    const outbox = new MemoryOutbox();
    const send = async () => {
      throw new Error('connection closed after write');
    };
    expect(await sendNotificationOutboxLeg(outbox, preparation('device-a'), send)).toMatchObject({
      status: 'unknown',
    });
    expect(await sendNotificationOutboxLeg(outbox, preparation('device-a'), send)).toMatchObject({
      status: 'unknown',
    });
  });

  it('refuses to reuse one logical leg identity for different frozen content', async () => {
    const outbox = new MemoryOutbox();
    await sendNotificationOutboxLeg(outbox, preparation('device-a'), async () => ({
      status: 'delivered',
    }));
    await expect(
      sendNotificationOutboxLeg(
        outbox,
        { ...preparation('device-a'), payload: { body: 'Changed body' } },
        async () => ({ status: 'delivered' }),
      ),
    ).rejects.toThrow('different frozen intent');
  });

  it('does not resend an attempt after its lease expires before receipt', async () => {
    const outbox = new MemoryOutbox();
    const input = preparation('device-a');
    const row = await outbox.prepare({
      ...input,
      deliveryKey: notificationDeliveryKey('outbox', input.agentId, input.deliveryKey),
    });
    await outbox.claim({ agentId: row.agentId, legId: row.id, now, leaseMs: 1000 });
    expect(await outbox.recoverExpired(row.agentId, new Date(now.getTime() + 1001))).toBe(1);
    const result = await sendNotificationOutboxLeg(
      outbox,
      { ...preparation('device-a'), now: new Date(now.getTime() + 1002) },
      async () => ({ status: 'delivered' }),
    );
    expect(result).toMatchObject({ status: 'unknown' });
  });
});
