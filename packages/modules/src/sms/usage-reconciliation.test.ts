import type {
  SmsChannelRepository,
  SmsUsageReconciliationClaim,
  SmsUsageReconciliationOutcome,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { reconcilePendingSmsUsage, type SmsChannelDeps } from './channel.js';

function claim(attempts: number): SmsUsageReconciliationClaim {
  return {
    eventId: 'event-1',
    claimToken: `lease-${attempts}`,
    providerMessageId: 'SM1234567890abcdef',
    attempts,
    createdAt: new Date('2026-10-07T00:00:00.000Z'),
    taskId: null,
    reservationId: null,
    currentUsd: 0.0158,
    currentQuantity: 2,
    currentUnitPriceUsd: 0.0079,
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
      smsUsageReconciliation: { status: 'pending', attempts },
    },
  };
}

describe('durable SMS usage read repair', () => {
  it('retries provider lookup failure and later final usage without sending another message', async () => {
    const claims = [claim(1), claim(2)];
    const settled: Array<{
      claim: SmsUsageReconciliationClaim;
      outcome: SmsUsageReconciliationOutcome;
    }> = [];
    const smsChannel = {
      claimSmsUsageReconciliation: vi.fn(async () => {
        const next = claims.shift();
        return next ? [next] : [];
      }),
      settleSmsUsageReconciliation: vi.fn(async (item, outcome) => {
        settled.push({ claim: item, outcome });
        return true;
      }),
    } as unknown as SmsChannelRepository;
    const getMessageUsage = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary provider lookup error'))
      .mockResolvedValueOnce({ billedSegments: 3, priceUsd: 0.0237 });
    const send = vi.fn();
    const deps = {
      config: {},
      twilio: { configured: () => true, getMessageUsage, send },
      persistence: { smsChannel },
    } as unknown as SmsChannelDeps;
    const firstNow = new Date('2026-10-07T12:00:00.000Z');

    expect(await reconcilePendingSmsUsage(deps, firstNow)).toBe(1);
    expect(settled[0]?.outcome).toMatchObject({
      kind: 'retry',
      error: 'temporary provider lookup error',
    });
    if (settled[0]?.outcome.kind !== 'retry') throw new Error('Expected retry outcome');
    expect(settled[0].outcome.nextAttemptAt).toEqual(new Date(firstNow.getTime() + 60_000));

    expect(await reconcilePendingSmsUsage(deps, new Date(firstNow.getTime() + 60_000))).toBe(1);
    expect(settled[1]?.outcome).toEqual({ kind: 'complete', billedSegments: 3, priceUsd: 0.0237 });
    expect(getMessageUsage).toHaveBeenCalledTimes(2);
    expect(getMessageUsage).toHaveBeenNthCalledWith(1, 'SM1234567890abcdef');
    expect(send).not.toHaveBeenCalled();
  });

  it('retries partial usage rather than marking the original event complete', async () => {
    const outcome: SmsUsageReconciliationOutcome[] = [];
    const smsChannel = {
      claimSmsUsageReconciliation: async () => [claim(1)],
      settleSmsUsageReconciliation: async (
        _claim: SmsUsageReconciliationClaim,
        result: SmsUsageReconciliationOutcome,
      ) => {
        outcome.push(result);
        return true;
      },
    } as unknown as SmsChannelRepository;
    const deps = {
      config: {},
      twilio: {
        configured: () => true,
        getMessageUsage: async () => ({ billedSegments: 3 }),
      },
      persistence: { smsChannel },
    } as unknown as SmsChannelDeps;

    await reconcilePendingSmsUsage(deps, new Date('2026-10-07T12:00:00.000Z'));
    expect(outcome[0]).toMatchObject({
      kind: 'retry',
      error: 'Twilio usage fields are not final yet',
    });
  });

  it('exhausts bounded retries while retaining the original estimated ledger amount', async () => {
    const outcomes: SmsUsageReconciliationOutcome[] = [];
    const smsChannel = {
      claimSmsUsageReconciliation: async () => [claim(24)],
      settleSmsUsageReconciliation: async (
        _claim: SmsUsageReconciliationClaim,
        outcome: SmsUsageReconciliationOutcome,
      ) => {
        outcomes.push(outcome);
        return true;
      },
    } as unknown as SmsChannelRepository;
    const deps = {
      config: {},
      twilio: {
        configured: () => true,
        getMessageUsage: async () => {
          throw new Error('provider unavailable');
        },
      },
      persistence: { smsChannel },
    } as unknown as SmsChannelDeps;

    await reconcilePendingSmsUsage(deps, new Date('2026-10-07T12:00:00.000Z'));
    expect(outcomes).toEqual([{ kind: 'exhausted', error: 'provider unavailable' }]);
  });
});
