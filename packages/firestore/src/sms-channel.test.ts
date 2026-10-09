import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreSmsChannelRepository } from './sms-channel.js';
import { encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore SMS binding ownership', () => {
  let store: InstallationStore;
  beforeEach(async () => {
    store = emulatorStore();
    await store.doc('agents', 'owner').set({ id: 'owner' });
  });
  afterEach(async () => disposeStore(store));
  it('converges first concurrent messages and rejects an imported foreign binding', async () => {
    const repository = new FirestoreSmsChannelRepository(store, 'owner');
    const ids = await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.conversationForPeer('owner', '+15550101', 'owner'),
      ),
    );
    expect(new Set(ids).size).toBe(1);
    const conversationId = ids[0];
    if (!conversationId) throw new Error('SMS conversation was not created');
    expect((await store.collection('conversations').get()).size).toBe(1);
    expect(await repository.finalDestination(conversationId)).toEqual({
      channel: 'sms',
      trust: 'owner',
      externalId: '+15550101',
    });
    await store
      .doc('conversations', 'foreign')
      .set({ id: 'foreign', agentId: 'other', channel: 'sms' });
    await store.doc('channelBindings', 'imported').set(
      encodeRecord({
        id: 'imported',
        conversationId: 'foreign',
        channel: 'sms',
        externalId: '+15550102',
      }),
    );
    await expect(repository.conversationForPeer('owner', '+15550102', 'unknown')).rejects.toThrow(
      'owner scope',
    );
    expect((await store.collection('conversations').get()).size).toBe(2);
  });

  it('retries delayed usage and updates the original ledger event once', async () => {
    const repository = new FirestoreSmsChannelRepository(store, 'owner');
    const eventId = randomUUID();
    const now = store.now();
    const day = now.toISOString().slice(0, 10);
    const month = now.toISOString().slice(0, 7);
    await store.doc('tasks', 'sms-task').set({
      id: 'sms-task',
      agentId: 'owner',
      type: 'adhoc',
      spentUsd: '0.015800',
      budgetUsdLimit: '1.0000',
    });
    await store.doc('toolCalls', 'tool-call-1').set({
      id: 'tool-call-1',
      taskId: 'sms-task',
      result: {
        sid: 'SM1234567890abcdef',
        smsAccounting: { estimatedSegments: 2, submittedMessages: 1 },
      },
    });
    await store.doc('budgetPeriods', `day:${day}`).set({ spentMicros: 15_800 });
    await store.doc('budgetPeriods', `month:${month}`).set({ spentMicros: 15_800 });
    await store.doc('costEvents', eventId).set(
      encodeRecord({
        id: eventId,
        source: 'twilio_sms',
        evidence: {
          basis: 'preflight_estimate',
          provider: 'twilio',
          requestId: 'SM1234567890abcdef',
          sms: {
            encoding: 'ucs2',
            encodedUnits: 72,
            estimatedSegments: 2,
            submittedMessages: 1,
            providerMessageId: 'SM1234567890abcdef',
          },
          smsUsageReconciliation: {
            status: 'pending',
            attempts: 0,
            nextAttemptAt: now.toISOString(),
          },
        },
        taskId: 'sms-task',
        toolCallId: 'tool-call-1',
        reservationId: null,
        quantity: '2.0000',
        unit: 'segment',
        unitPriceUsd: '0.00790000',
        usd: '0.015800',
        description: 'test SMS',
        idempotencyKey: null,
        createdAt: now,
      }),
    );
    expect((await store.doc('costEvents', eventId).get()).get('evidence')).toMatchObject({
      provider: 'twilio',
      smsUsageReconciliation: { status: 'pending', nextAttemptAt: now.toISOString() },
    });
    const candidates = await Promise.all([
      repository.claimSmsUsageReconciliation(now, 10),
      repository.claimSmsUsageReconciliation(now, 10),
    ]);
    const claims = candidates.flat();
    expect(claims).toHaveLength(1);
    const first = claims[0];
    if (!first) throw new Error('SMS usage claim was not created');
    expect(
      await repository.settleSmsUsageReconciliation(first, {
        kind: 'retry',
        nextAttemptAt: new Date(now.getTime() + 60_000),
        error: 'usage fields not populated yet',
      }),
    ).toBe(true);
    expect(await repository.claimSmsUsageReconciliation(now, 10)).toEqual([]);

    const [second] = await repository.claimSmsUsageReconciliation(
      new Date(now.getTime() + 60_001),
      10,
    );
    if (!second) throw new Error('SMS usage retry claim was not created');
    expect(second?.eventId).toBe(eventId);
    expect(second?.attempts).toBe(2);
    const beforeInvalidReplacement = await store.doc('costEvents', eventId).get();
    await expect(
      repository.settleSmsUsageReconciliation(second, {
        kind: 'complete',
        billedSegments: 3,
        priceUsd: 10_000,
      }),
    ).rejects.toThrow('numeric(10,6)');
    const afterInvalidReplacement = await store.doc('costEvents', eventId).get();
    expect(afterInvalidReplacement.get('usd')).toBe(beforeInvalidReplacement.get('usd'));
    expect(afterInvalidReplacement.get('evidence')).toMatchObject({
      smsUsageReconciliation: { status: 'pending', claimToken: second.claimToken },
    });

    // Reconciliation must reject an inconsistent task counter without partial writes.
    await store.doc('tasks', 'sms-task').update({ spentUsd: '0.000000' });
    const underflowBefore = {
      event: (await store.doc('costEvents', eventId).get()).data(),
      task: (await store.doc('tasks', 'sms-task').get()).data(),
      day: (await store.doc('budgetPeriods', `day:${day}`).get()).data(),
      month: (await store.doc('budgetPeriods', `month:${month}`).get()).data(),
      call: (await store.doc('toolCalls', 'tool-call-1').get()).data(),
    };
    await expect(
      repository.settleSmsUsageReconciliation(second, {
        kind: 'complete',
        billedSegments: 1,
        priceUsd: 0,
      }),
    ).rejects.toThrow();
    expect((await store.doc('costEvents', eventId).get()).data()).toEqual(underflowBefore.event);
    expect((await store.doc('tasks', 'sms-task').get()).data()).toEqual(underflowBefore.task);
    expect((await store.doc('budgetPeriods', `day:${day}`).get()).data()).toEqual(
      underflowBefore.day,
    );
    expect((await store.doc('budgetPeriods', `month:${month}`).get()).data()).toEqual(
      underflowBefore.month,
    );
    expect((await store.doc('toolCalls', 'tool-call-1').get()).data()).toEqual(
      underflowBefore.call,
    );

    // The same all-or-nothing guarantee applies when the positive aggregate overflows.
    await store.doc('tasks', 'sms-task').update({ spentUsd: '9999.999999' });
    const overflowBefore = {
      event: (await store.doc('costEvents', eventId).get()).data(),
      task: (await store.doc('tasks', 'sms-task').get()).data(),
      day: (await store.doc('budgetPeriods', `day:${day}`).get()).data(),
      month: (await store.doc('budgetPeriods', `month:${month}`).get()).data(),
      call: (await store.doc('toolCalls', 'tool-call-1').get()).data(),
    };
    await expect(
      repository.settleSmsUsageReconciliation(second, {
        kind: 'complete',
        billedSegments: 3,
        priceUsd: 0.0237,
      }),
    ).rejects.toThrow();
    expect((await store.doc('costEvents', eventId).get()).data()).toEqual(overflowBefore.event);
    expect((await store.doc('tasks', 'sms-task').get()).data()).toEqual(overflowBefore.task);
    expect((await store.doc('budgetPeriods', `day:${day}`).get()).data()).toEqual(
      overflowBefore.day,
    );
    expect((await store.doc('budgetPeriods', `month:${month}`).get()).data()).toEqual(
      overflowBefore.month,
    );
    expect((await store.doc('toolCalls', 'tool-call-1').get()).data()).toEqual(overflowBefore.call);
    await store.doc('tasks', 'sms-task').update({ spentUsd: '0.015800' });

    expect(
      await repository.settleSmsUsageReconciliation(second, {
        kind: 'complete',
        billedSegments: 3,
        priceUsd: 0.0237,
      }),
    ).toBe(true);
    expect(
      await repository.settleSmsUsageReconciliation(second, {
        kind: 'complete',
        billedSegments: 3,
        priceUsd: 0.0237,
      }),
    ).toBe(false);

    const updated = await store.doc('costEvents', eventId).get();
    expect(updated.get('usd')).toBe('0.023700');
    expect(updated.get('quantity')).toBe('3.0000');
    expect(updated.get('evidence')).toMatchObject({
      basis: 'provider_reported',
      sms: { billedSegments: 3, providerPriceUsd: 0.0237 },
      smsUsageReconciliation: { status: 'complete', attempts: 2 },
    });
    expect((await store.doc('budgetPeriods', `day:${day}`).get()).get('spentMicros')).toBe(23_700);
    expect((await store.doc('budgetPeriods', `month:${month}`).get()).get('spentMicros')).toBe(
      23_700,
    );
    expect((await store.collection('costEvents').get()).size).toBe(1);
    expect((await store.doc('toolCalls', 'tool-call-1').get()).get('result')).toMatchObject({
      sid: 'SM1234567890abcdef',
      smsAccounting: { billedSegments: 3, providerPriceUsd: 0.0237 },
    });
  });
});
