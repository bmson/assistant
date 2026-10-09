import type {
  EmailObserverClaim,
  EmailObserverIdentity,
  EmailObserverWorkRecord,
} from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { drainEmailObservers, validateEmailObserverRegistry } from './email-observers.js';
import type { InboundEmailObserver, ModuleServices } from './platform.js';

const identity: EmailObserverIdentity = {
  key: 'google.test-paid',
  version: 1,
  workClass: 'paid_ambiguous',
};
const now = new Date('2026-10-08T23:30:00.000Z');
const work = {
  id: '6d09b73f-a329-4ed7-862a-f5320d354ef4',
  agentId: 'owner-1',
  sourceKey: 'gmail:event-1',
  channelMessageId: 'gmail:event-1',
  sourceKind: 'message',
  observerKey: identity.key,
  observerVersion: identity.version,
  workClass: identity.workClass,
  status: 'pending',
} as EmailObserverWorkRecord;
const claim = {
  ...work,
  status: 'claimed',
  claimToken: 'claim-1',
  claimGeneration: 2,
  leaseExpiresAt: new Date(now.getTime() + 60_000),
  privacyGeneration: 'privacy-7',
  preparedResult: null,
} as EmailObserverClaim;

function fixture(handler: InboundEmailObserver, claimValue = claim) {
  const methods = {
    privacyObservationFence: vi.fn().mockResolvedValue('privacy-7'),
    listDueEmailObservers: vi
      .fn()
      .mockResolvedValue([{ ...work, workClass: handler.identity.workClass }]),
    claimEmailObserver: vi.fn().mockResolvedValue({
      kind: 'claimed',
      claim: { ...claimValue, workClass: handler.identity.workClass },
    }),
    loadEmailObserverSource: vi.fn().mockResolvedValue({
      agentId: 'owner-1',
      messageId: 'event-1',
      sourceId: 'gmail:event-1',
      from: 'owner@example.test',
      subject: 'A short test message',
      body: 'A bounded synthetic owner-authored test message.',
      authenticated: true,
      origin: 'owner',
      contentTrust: 'owner',
      ingestMode: 'direct',
      sourceVerification: 'authenticated',
      hasExternalOrUnknown: false,
    }),
    prepareEmailObserver: vi.fn().mockResolvedValue(true),
    completeEmailObserver: vi.fn().mockResolvedValue(true),
    failEmailObserver: vi.fn().mockResolvedValue(true),
  };
  const services = {
    config: { EMAIL_OBSERVER_MAX_PAID_PER_DAY: 20 },
    persistence: { emailSync: methods },
    emailObservers: [],
    durableEmailObservers: [handler],
  } as unknown as ModuleServices;
  return { methods, services };
}

describe('durable email observer module runner', () => {
  it('filters disabled paid handlers before the normal twenty-row page and drains direct work', async () => {
    const directIdentity: EmailObserverIdentity = {
      key: 'google.direct-email-routing',
      version: 1,
      workClass: 'idempotent_db',
    };
    const directWork = {
      ...work,
      id: 'direct-work-id',
      sourceKey: 'gmail:direct-fresh',
      channelMessageId: 'gmail:direct-fresh',
      observerKey: directIdentity.key,
      observerVersion: directIdentity.version,
      workClass: directIdentity.workClass,
    } as EmailObserverWorkRecord;
    const disabledPrepare = vi.fn();
    const disabledApply = vi.fn();
    const disabledHandler: InboundEmailObserver = {
      identity,
      shouldRun: vi.fn().mockReturnValue(false),
      prepare: disabledPrepare,
      apply: disabledApply,
    };
    const directHandler: InboundEmailObserver = {
      identity: directIdentity,
      prepare: vi.fn().mockResolvedValue({ kind: 'no_op' }),
      apply: vi.fn(),
    };
    const methods = {
      privacyObservationFence: vi.fn().mockResolvedValue('privacy-7'),
      listDueEmailObservers: vi.fn(
        async (_agentId: string, _now: Date, limit: number, excluded: EmailObserverIdentity[]) => {
          expect(limit).toBe(20);
          expect(excluded).toEqual([identity]);
          // Model the adapter's pre-limit filter over a backlog large enough
          // that an unfiltered page would contain only disabled card work.
          const rows = [
            ...Array.from({ length: 25 }, (_, index) => ({
              ...work,
              id: `disabled-card-${index}`,
            })),
            directWork,
          ];
          return rows
            .filter(
              (row) =>
                !excluded.some(
                  (item) =>
                    item.key === row.observerKey &&
                    item.version === row.observerVersion &&
                    item.workClass === row.workClass,
                ),
            )
            .slice(0, limit);
        },
      ),
      claimEmailObserver: vi.fn().mockResolvedValue({
        kind: 'claimed',
        claim: { ...claim, ...directWork, status: 'claimed' },
      }),
      loadEmailObserverSource: vi.fn().mockResolvedValue({
        agentId: 'owner-1',
        messageId: 'direct-fresh',
        sourceId: 'gmail:direct-fresh',
        from: 'owner@example.test',
        subject: 'Direct request',
        body: 'Owner-authenticated direct email.',
        authenticated: true,
        origin: 'owner',
        contentTrust: 'owner',
        directRouting: 'email_triage',
        ingestMode: 'direct',
        sourceVerification: 'authenticated',
        hasExternalOrUnknown: false,
      }),
      prepareEmailObserver: vi.fn().mockResolvedValue(true),
      completeEmailObserver: vi.fn().mockResolvedValue(true),
      failEmailObserver: vi.fn().mockResolvedValue(true),
    };
    const services = {
      config: { EMAIL_OBSERVER_MAX_PAID_PER_DAY: 20, GENERATIVE_CARDS_ENABLED: false },
      persistence: { emailSync: methods },
      emailObservers: [],
      durableEmailObservers: [disabledHandler, directHandler],
    } as unknown as ModuleServices;

    const result = await drainEmailObservers(services, 'owner-1', { now, limit: 20 });

    expect(result.claimed).toBe(1);
    expect(result.noOp).toBe(1);
    expect(methods.claimEmailObserver).toHaveBeenCalledOnce();
    expect(methods.claimEmailObserver).toHaveBeenCalledWith(
      expect.not.objectContaining({ paidBudget: expect.anything() }),
    );
    expect(directHandler.prepare).toHaveBeenCalledOnce();
    expect(disabledPrepare).not.toHaveBeenCalled();
    expect(disabledApply).not.toHaveBeenCalled();
  });

  it('still terminalizes due work whose registered handler is missing', async () => {
    const missingIdentity: EmailObserverIdentity = {
      key: 'google.removed-observer',
      version: 1,
      workClass: 'idempotent_db',
    };
    const missingWork = {
      ...work,
      observerKey: missingIdentity.key,
      observerVersion: missingIdentity.version,
      workClass: missingIdentity.workClass,
    } as EmailObserverWorkRecord;
    const methods = {
      privacyObservationFence: vi.fn().mockResolvedValue('privacy-7'),
      listDueEmailObservers: vi.fn().mockResolvedValue([missingWork]),
      claimEmailObserver: vi.fn().mockResolvedValue({
        kind: 'claimed',
        claim: { ...claim, ...missingWork, status: 'claimed' },
      }),
      loadEmailObserverSource: vi.fn(),
      prepareEmailObserver: vi.fn(),
      completeEmailObserver: vi.fn(),
      failEmailObserver: vi.fn().mockResolvedValue(true),
    };
    const services = {
      config: { EMAIL_OBSERVER_MAX_PAID_PER_DAY: 20 },
      persistence: { emailSync: methods },
      emailObservers: [],
      durableEmailObservers: [],
    } as unknown as ModuleServices;

    const result = await drainEmailObservers(services, 'owner-1', { now, limit: 20 });

    expect(methods.listDueEmailObservers).toHaveBeenCalledWith('owner-1', now, 20, []);
    expect(methods.failEmailObserver).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'unknown', errorCode: 'observer_handler_missing' }),
    );
    expect(result.unknown).toBe(1);
  });

  it('reserves the independent UTC-day budget, persists paid output, then applies it', async () => {
    const handler: InboundEmailObserver = {
      identity,
      prepare: vi.fn().mockResolvedValue({ kind: 'prepared', result: { safe: true } }),
      apply: vi.fn().mockResolvedValue({ kind: 'complete' }),
    };
    const { methods, services } = fixture(handler);
    const result = await drainEmailObservers(services, 'owner-1', { now });

    expect(methods.claimEmailObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'owner-1',
        id: work.id,
        expectedPrivacyGeneration: 'privacy-7',
        paidBudget: {
          budgetKey: identity.key,
          observerKey: identity.key,
          limit: 20,
          windowStart: new Date('2026-10-08T00:00:00.000Z'),
          windowEnd: new Date('2026-10-09T00:00:00.000Z'),
        },
      }),
    );
    expect(methods.prepareEmailObserver).toHaveBeenCalledWith(
      expect.objectContaining({ result: { safe: true }, claimGeneration: 2 }),
    );
    expect(handler.apply).toHaveBeenCalledOnce();
    expect(methods.completeEmailObserver).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ claimed: 1, completed: 1, unknown: 0 });
  });

  it('replays a prepared result without paying or preparing again', async () => {
    const preparedClaim = {
      ...claim,
      status: 'prepared',
      preparedResult: { safe: true },
    } as EmailObserverClaim;
    const handler: InboundEmailObserver = {
      identity,
      prepare: vi.fn(),
      apply: vi.fn().mockResolvedValue({ kind: 'complete' }),
    };
    const { methods, services } = fixture(handler, preparedClaim);
    await drainEmailObservers(services, 'owner-1', { now });
    expect(handler.prepare).not.toHaveBeenCalled();
    expect(handler.apply).toHaveBeenCalledWith(services, expect.anything(), preparedClaim, {
      safe: true,
    });
    expect(methods.prepareEmailObserver).not.toHaveBeenCalled();
    expect(methods.claimEmailObserver).toHaveBeenCalledWith(
      expect.objectContaining({ paidBudget: expect.objectContaining({ budgetKey: identity.key }) }),
    );
  });

  it('leaves a feature-disabled paid row due without claiming its budget', async () => {
    const handler: InboundEmailObserver = {
      identity,
      shouldRun: () => false,
      prepare: vi.fn(),
      apply: vi.fn(),
    };
    const { methods, services } = fixture(handler);
    const result = await drainEmailObservers(services, 'owner-1', { now });

    expect(methods.claimEmailObserver).not.toHaveBeenCalled();
    expect(handler.prepare).not.toHaveBeenCalled();
    expect(handler.apply).not.toHaveBeenCalled();
    expect(result.claimed).toBe(0);
  });

  it('stops before claiming the next row when a feature is disabled by the first handler', async () => {
    let enabled = true;
    const handler: InboundEmailObserver = {
      identity,
      shouldRun: () => enabled,
      prepare: vi.fn().mockResolvedValue({ kind: 'prepared', result: { safe: true } }),
      apply: vi.fn(async () => {
        enabled = false;
        return { kind: 'complete' as const };
      }),
    };
    const { methods, services } = fixture(handler);
    methods.listDueEmailObservers.mockResolvedValue([
      work,
      {
        ...work,
        id: 'second-observer-work',
        sourceKey: 'gmail:event-2',
        channelMessageId: 'gmail:event-2',
      },
    ]);
    methods.claimEmailObserver.mockImplementation(async ({ id }) => ({
      kind: 'claimed',
      claim: {
        ...claim,
        id,
        sourceKey: id === 'second-observer-work' ? 'gmail:event-2' : work.sourceKey,
        channelMessageId: id === 'second-observer-work' ? 'gmail:event-2' : work.channelMessageId,
      } as EmailObserverClaim,
    }));

    const result = await drainEmailObservers(services, 'owner-1', { now });

    expect(result.claimed).toBe(1);
    expect(methods.claimEmailObserver).toHaveBeenCalledOnce();
    expect(handler.prepare).toHaveBeenCalledOnce();
    expect(handler.apply).toHaveBeenCalledOnce();
  });

  it('releases an unused paid reservation when readiness changes after claim', async () => {
    const handler: InboundEmailObserver = {
      identity,
      prepare: vi.fn(),
      apply: vi.fn(),
    };
    const { methods, services } = fixture(handler);
    let readinessChecks = 0;
    services.operationalReady = vi.fn(async () => ++readinessChecks < 3);

    const result = await drainEmailObservers(services, 'owner-1', { now });

    expect(result.claimed).toBe(1);
    expect(handler.prepare).not.toHaveBeenCalled();
    expect(methods.failEmailObserver).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'budget_blocked', errorCode: 'observer_paused' }),
    );
  });

  it('holds a thrown effect as unknown and never logs its source-bearing error', async () => {
    const handler: InboundEmailObserver = {
      identity: { ...identity, workClass: 'idempotent_db' },
      prepare: vi.fn().mockResolvedValue({ kind: 'prepared', result: {} }),
      apply: vi.fn().mockRejectedValue(new Error('body must not enter observer logs')),
    };
    const { methods, services } = fixture(handler);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await drainEmailObservers(services, 'owner-1', { now });
      expect(methods.failEmailObserver).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'unknown', errorCode: 'observer_threw' }),
      );
      expect(log).not.toHaveBeenCalled();
      expect(result.unknown).toBe(1);
    } finally {
      log.mockRestore();
    }
  });

  it('returns a proven no-provider budget block without preparing an undefined result', async () => {
    const handler: InboundEmailObserver = {
      identity,
      prepare: vi.fn().mockResolvedValue({ kind: 'budget_blocked', mode: 'block' }),
      apply: vi.fn(),
    };
    const { methods, services } = fixture(handler);
    const result = await drainEmailObservers(services, 'owner-1', { now });

    expect(methods.failEmailObserver).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'budget_blocked', errorCode: 'observer_budget_blocked' }),
    );
    expect(methods.prepareEmailObserver).not.toHaveBeenCalled();
    expect(handler.apply).not.toHaveBeenCalled();
    expect(result).toMatchObject({ claimed: 1, skippedBudget: 1, completed: 0 });
  });

  it('uses a fresh UTC budget window for each claim across midnight', async () => {
    vi.useFakeTimers();
    const dayOne = new Date('2026-10-08T23:59:59.000Z');
    const dayTwo = new Date('2026-10-09T00:00:01.000Z');
    vi.setSystemTime(dayOne);
    try {
      let preparations = 0;
      const handler: InboundEmailObserver = {
        identity,
        prepare: vi.fn(async () => {
          preparations += 1;
          if (preparations === 1) vi.setSystemTime(dayTwo);
          return { kind: 'prepared' as const, result: {} };
        }),
        apply: vi.fn().mockResolvedValue({ kind: 'complete' }),
      };
      const { methods, services } = fixture(handler);
      methods.listDueEmailObservers.mockResolvedValue([
        work,
        {
          ...work,
          id: 'second-observer-work',
          sourceKey: 'gmail:event-2',
          channelMessageId: 'gmail:event-2',
        },
      ]);
      methods.claimEmailObserver.mockImplementation(async ({ id }) => ({
        kind: 'claimed',
        claim: {
          ...claim,
          id,
          sourceKey: id === 'second-observer-work' ? 'gmail:event-2' : work.sourceKey,
          channelMessageId: id === 'second-observer-work' ? 'gmail:event-2' : work.channelMessageId,
        } as EmailObserverClaim,
      }));

      await drainEmailObservers(services, 'owner-1');

      expect(methods.claimEmailObserver).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          now: dayOne,
          paidBudget: expect.objectContaining({
            windowStart: new Date('2026-10-08T00:00:00.000Z'),
          }),
        }),
      );
      expect(methods.claimEmailObserver).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          now: dayTwo,
          paidBudget: expect.objectContaining({
            windowStart: new Date('2026-10-09T00:00:00.000Z'),
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects duplicate stable registrations before source admission', () => {
    expect(() => validateEmailObserverRegistry([{ identity }, { identity }])).toThrow(
      'duplicate inbound email observer google.test-paid@1',
    );
  });
});
