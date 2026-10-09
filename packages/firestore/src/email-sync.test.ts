import {
  emailBookingKey,
  emailBookingOccurrenceId,
  emailObserverBudgetId,
  emailObserverSourceId,
  emailObserverWorkId,
} from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { FirestoreEmailSyncRepository } from './email-sync.js';
import { documentKey, encodeRecord } from './store.js';

function fixture(migrationStatus?: string) {
  const docs = new Map<string, Record<string, unknown>>([
    [`agents/${documentKey('agent-1')}`, { id: 'agent-1', email: 'owner@example.test' }],
    [
      `conversations/${documentKey('conversation-1')}`,
      { id: 'conversation-1', agentId: 'agent-1' },
    ],
  ]);
  if (migrationStatus)
    docs.set(`coordination/${documentKey('migration')}`, { status: migrationStatus });
  let currentTime = new Date('2026-10-06T00:00:00.000Z');
  let writes = 0;
  const store = {
    doc: (collection: string, id: string) => {
      const storedId = documentKey(id);
      const key = `${collection}/${storedId}`;
      return {
        key,
        id: storedId,
        get: async () => {
          const value = docs.get(key);
          return {
            id: storedId,
            exists: value !== undefined,
            updateTime: value?.updateTime,
            data: () => value,
          };
        },
      };
    },
    collection: (name: string) => {
      const makeQuery = (
        filters: Array<[string, string, unknown]> = [],
        max = Number.MAX_SAFE_INTEGER,
      ) => ({
        query: true,
        where: (field: string, op: string, value: unknown) =>
          makeQuery([...filters, [field, op, value]], max),
        limit: (count: number) => makeQuery(filters, count),
        orderBy: () => makeQuery(filters, max),
        get: async () => {
          const matches = [...docs.entries()]
            .filter(
              ([key, value]) =>
                key.startsWith(`${name}/`) &&
                filters.every(([field, op, expected]) => {
                  if (op === '==') return value[field] === expected;
                  if (op === '!=') return value[field] !== expected;
                  if (op === 'not-in' && Array.isArray(expected))
                    return !expected.includes(value[field]);
                  return false;
                }),
            )
            .slice(0, max);
          const resultDocs = matches.map(([key, value]) => ({
            id: key.slice(name.length + 1),
            exists: true,
            ref: { key },
            data: () => value,
            get: (field: string) => value[field],
          }));
          return { empty: resultDocs.length === 0, size: resultDocs.length, docs: resultDocs };
        },
      });
      return makeQuery();
    },
    now: () => currentTime,
    db: {
      runTransaction: async (run: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          get: async (ref: {
            key?: string;
            id?: string;
            query?: boolean;
            get?: () => Promise<{ empty: boolean; size: number; docs: unknown[] }>;
          }) => {
            if (ref.query && ref.get) return ref.get();
            if (!ref.key) return { empty: true, size: 0, docs: [] };
            const value = docs.get(ref.key);
            return {
              id: ref.id,
              exists: value !== undefined,
              updateTime: value?.updateTime,
              get: (field: string) => value?.[field],
              data: () => value,
            };
          },
          getAll: async (...refs: Array<{ key: string; id?: string }>) =>
            Promise.all(
              refs.map((ref) => {
                const value = docs.get(ref.key);
                return {
                  id: ref.id,
                  exists: value !== undefined,
                  updateTime: value?.updateTime,
                  get: (field: string) => value?.[field],
                  data: () => value,
                };
              }),
            ),
          set: (
            ref: { key: string },
            value: Record<string, unknown>,
            options?: { merge?: boolean },
          ) => {
            const next = options?.merge ? { ...docs.get(ref.key), ...value } : value;
            docs.set(ref.key, next);
            writes += 1;
          },
          update: (ref: { key: string }, value: Record<string, unknown>) => {
            docs.set(ref.key, { ...docs.get(ref.key), ...value });
            writes += 1;
          },
          create: (ref: { key: string }, value: Record<string, unknown>) => {
            if (docs.has(ref.key)) throw new Error('document already exists');
            docs.set(ref.key, value);
            writes += 1;
          },
          delete: (ref: { key: string }) => {
            docs.delete(ref.key);
          },
        };
        return run(tx);
      },
    },
  } as never;
  return {
    repository: new FirestoreEmailSyncRepository(store, 'agent-1'),
    writes: () => writes,
    docs,
    advance: (ms: number) => {
      currentTime = new Date(currentTime.getTime() + ms);
    },
  };
}

describe('Firestore direct recovery scan controls', () => {
  it('rejects oversized or duplicate disabled identity filters before querying', async () => {
    const f = fixture();
    const tooMany = Array.from({ length: 11 }, (_, index) => ({
      key: `google.disabled-${index}`,
      version: 1,
      workClass: 'paid_ambiguous' as const,
    }));
    const duplicate = {
      key: 'google.email-card',
      version: 1,
      workClass: 'paid_ambiguous' as const,
    };

    await expect(
      f.repository.listDueEmailObservers('agent-1', new Date(), 20, tooMany),
    ).rejects.toThrow('Email observer exclusions are invalid or exceed the registry bound');
    await expect(
      f.repository.listDueEmailObservers('agent-1', new Date(), 20, [duplicate, duplicate]),
    ).rejects.toThrow('Email observer exclusions are invalid or exceed the registry bound');
  });

  it('finds enabled direct work after more than one page of disabled paid observers', async () => {
    const f = fixture();
    const now = new Date('2026-10-06T00:00:00.000Z');
    const rows = [
      ...Array.from({ length: 25 }, (_, index) => ({
        id: `disabled-card-${index}`,
        agentId: 'agent-1',
        sourceKey: `disabled-card-${index}`,
        channelMessageId: `gmail:disabled-card-${index}`,
        sourceKind: 'automated_source' as const,
        observerKey: 'google.email-card',
        observerVersion: 1,
        workClass: 'paid_ambiguous' as const,
        status: 'pending' as const,
        attemptCount: 0,
        claimToken: null,
        claimGeneration: 0,
        leaseExpiresAt: null,
        privacyGeneration: null,
        budgetKey: null,
        budgetWindowStart: null,
        budgetReserved: false,
        preparedResult: null,
        deliveryKey: null,
        lastErrorCode: null,
        claimedAt: null,
        completedAt: null,
        createdAt: new Date(now.getTime() + index),
        updatedAt: now,
      })),
      {
        id: 'same-version-other-class',
        agentId: 'agent-1',
        sourceKey: 'same-version-other-class',
        channelMessageId: 'gmail:same-version-other-class',
        sourceKind: 'automated_source' as const,
        observerKey: 'google.email-card',
        observerVersion: 1,
        workClass: 'idempotent_db' as const,
        status: 'pending' as const,
        attemptCount: 0,
        claimToken: null,
        claimGeneration: 0,
        leaseExpiresAt: null,
        privacyGeneration: null,
        budgetKey: null,
        budgetWindowStart: null,
        budgetReserved: false,
        preparedResult: null,
        deliveryKey: null,
        lastErrorCode: null,
        claimedAt: null,
        completedAt: null,
        createdAt: new Date(now.getTime() + 80),
        updatedAt: now,
      },
      {
        id: 'newer-card-observer-version',
        agentId: 'agent-1',
        sourceKey: 'newer-card-observer-version',
        channelMessageId: 'gmail:newer-card-observer-version',
        sourceKind: 'automated_source' as const,
        observerKey: 'google.email-card',
        observerVersion: 2,
        workClass: 'paid_ambiguous' as const,
        status: 'pending' as const,
        attemptCount: 0,
        claimToken: null,
        claimGeneration: 0,
        leaseExpiresAt: null,
        privacyGeneration: null,
        budgetKey: null,
        budgetWindowStart: null,
        budgetReserved: false,
        preparedResult: null,
        deliveryKey: null,
        lastErrorCode: null,
        claimedAt: null,
        completedAt: null,
        createdAt: new Date(now.getTime() + 90),
        updatedAt: now,
      },
      {
        id: 'fresh-direct-route',
        agentId: 'agent-1',
        sourceKey: 'fresh-direct-route',
        channelMessageId: 'gmail:fresh-direct-route',
        sourceKind: 'automated_source' as const,
        observerKey: 'google.direct-email-routing',
        observerVersion: 1,
        workClass: 'idempotent_db' as const,
        status: 'pending' as const,
        attemptCount: 0,
        claimToken: null,
        claimGeneration: 0,
        leaseExpiresAt: null,
        privacyGeneration: null,
        budgetKey: null,
        budgetWindowStart: null,
        budgetReserved: false,
        preparedResult: null,
        deliveryKey: null,
        lastErrorCode: null,
        claimedAt: null,
        completedAt: null,
        createdAt: new Date(now.getTime() + 100),
        updatedAt: now,
      },
    ];
    for (const row of rows)
      f.docs.set(`emailObserverWork/${documentKey(row.id)}`, encodeRecord(row));

    const due = await f.repository.listDueEmailObservers('agent-1', now, 20, [
      { key: 'google.email-card', version: 1, workClass: 'paid_ambiguous' },
    ]);

    expect(due.map(({ observerKey, observerVersion }) => [observerKey, observerVersion])).toEqual(
      expect.arrayContaining([
        ['google.email-card', 2],
        ['google.email-card', 1],
        ['google.direct-email-routing', 1],
      ]),
    );
  });

  it('lists bounded owner-only unadmitted direct metadata and terminalizes unavailable source with a finite reason', async () => {
    const f = fixture('active');
    const result = await f.repository.withLock(async (lease) => {
      const row = await f.repository.beginDirectEmailIngest(
        {
          agentId: 'agent-1',
          mailbox: 'owner@example.test',
          providerMessageId: 'recover-1',
          providerThreadId: 'thread-1',
          sourceMessageId: '<source-1@example.test>',
          channelMessageId: 'gmail:recover-1',
          conversationId: 'conversation-1',
          fromEmail: 'sender@example.test',
          fromName: null,
          subject: 'Recover source',
          contentTrust: 'unknown',
          authenticated: true,
          ingestMode: 'direct',
          hasExternalOrUnknown: true,
          category: 'other',
          importance: 1,
          actionable: false,
          reason: '',
          dates: [],
        },
        { expectedPrivacyGeneration: null, lease },
      );
      const rows = await f.repository.listRecoverableDirectIngests({
        agentId: 'agent-1',
        mailbox: 'owner@example.test',
        expectedPrivacyGeneration: null,
        lease,
        limit: 99,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: row.id,
        authenticated: true,
        providerMessageId: 'recover-1',
        providerThreadId: 'thread-1',
        sourceMessageId: '<source-1@example.test>',
        admittedSourceKind: null,
        admittedSourceId: null,
        messagePersisted: false,
        classificationStatus: 'pending',
        scoreStatus: 'pending',
      });
      expect(rows[0]).not.toHaveProperty('body');
      expect(rows[0]).not.toHaveProperty('rawHeaders');
      expect(
        await f.repository.markDirectIngestRecoveryUnavailable({
          agentId: 'agent-1',
          mailbox: 'owner@example.test',
          ingestId: row.id,
          expectedPrivacyGeneration: null,
          lease,
          reason: 'provider_message_missing',
        }),
      ).toBe(true);
      expect(
        await f.repository.listRecoverableDirectIngests({
          agentId: 'agent-1',
          mailbox: 'owner@example.test',
          expectedPrivacyGeneration: null,
          lease,
          limit: 20,
        }),
      ).toEqual([]);
      expect(f.docs.get(`emailIngest/${documentKey(row.id)}`)).toMatchObject({
        pipelineStage: 'needs_attention',
        directRouting: 'needs_attention',
        directRecoveryReason: 'provider_message_missing',
      });
      return true;
    });
    expect(result?.value).toBe(true);
  });
});

describe('Firestore Gmail sync activation fence', () => {
  it('writes a versioned authenticated booking lifecycle and rejects stale revisions', async () => {
    const f = fixture('active');
    const bookingKey = emailBookingKey('agent-1', 'R-314');
    const prepare = async (messageId: string, receivedAt: string, lifecycle: string) => {
      const stage = await f.repository.beginForwardedIngest({
        agentId: 'agent-1',
        mailbox: 'owner@example.test',
        providerMessageId: messageId,
        providerThreadId: 'thread-314',
        providerReceivedAt: new Date(receivedAt),
        channelMessageId: `gmail:${messageId}`,
        conversationId: 'conversation-1',
        fromEmail: 'travel@example.test',
        fromName: 'Travel',
        subject: `Booking ${lifecycle}`,
        contentTrust: 'known',
        authenticated: true,
        category: 'travel',
        importance: 3,
        actionable: false,
        reason: '',
        dates: [],
      });
      const token = `score:${messageId}`;
      expect(await f.repository.claimIngestScore('agent-1', stage.id, token, null)).toBe(true);
      await f.repository.prepareIngestScore(
        'agent-1',
        stage.id,
        token,
        {
          category: 'travel',
          importance: 3,
          actionable: false,
          reason: 'Explicit booking update.',
          dates: [
            {
              iso: receivedAt,
              what: 'Berlin spa booking',
              dateRole: 'event_start',
              lifecycle,
              bookingIdentity: 'R-314',
            },
          ],
          cardCandidate: true,
          nextStep: null,
          securityEvidence: {
            providerIncidentRef: 'case-17',
            eventType: 'sign_in',
            evidenceQuote: 'A new sign-in was detected. Case case-17.',
          },
        },
        null,
      );
    };

    await prepare('confirmed-1', '2026-10-01T08:00:00.000Z', 'confirmed');
    const occurrenceId = emailBookingOccurrenceId('agent-1', bookingKey);
    expect(f.docs.get(`emailBookingOccurrences/${documentKey(occurrenceId)}`)).toMatchObject({
      lifecycle: 'confirmed',
      version: 1,
      sourceAuthenticated: true,
    });
    expect(await f.repository.ingestRecord('gmail:confirmed-1')).toMatchObject({
      securityEvidence: {
        providerIncidentRef: 'case-17',
        eventType: 'sign_in',
      },
    });
    expect(
      await f.repository.isBookingOccurrenceCurrent({
        agentId: 'agent-1',
        bookingKey,
        expectedVersion: 1,
        allowedLifecycle: ['confirmed', 'rescheduled'],
      }),
    ).toBe(true);

    await prepare('cancelled-2', '2026-10-02T08:00:00.000Z', 'cancelled');
    expect(f.docs.get(`emailBookingOccurrences/${documentKey(occurrenceId)}`)).toMatchObject({
      lifecycle: 'cancelled',
      version: 2,
    });
    expect(
      await f.repository.isBookingOccurrenceCurrent({
        agentId: 'agent-1',
        bookingKey,
        expectedVersion: 1,
        allowedLifecycle: ['confirmed', 'rescheduled'],
      }),
    ).toBe(false);
  });

  it('blocks a cursor commit in the same transaction while activation is pending', async () => {
    const f = fixture('pending_activation');

    await expect(
      f.repository.withLock((lease) =>
        f.repository.saveCursor('owner@example.com', { mode: 'inbox' }, lease),
      ),
    ).rejects.toThrow('not operationally ready');
    expect(f.writes()).toBe(0);
  });

  it('allows a cursor commit in the same transaction after activation', async () => {
    const f = fixture('active');

    await f.repository.withLock((lease) =>
      f.repository.saveCursor('owner@example.com', { mode: 'inbox' }, lease),
    );
    expect(f.writes()).toBe(3);
  });

  it('allows fresh installs without a migration marker', async () => {
    const f = fixture();

    await f.repository.withLock((lease) =>
      f.repository.saveCursor('owner@example.com', { mode: 'inbox' }, lease),
    );
    expect(f.writes()).toBe(3);
  });

  it('rejects a stale generation after takeover and preserves the newer cursor', async () => {
    const f = fixture('active');
    let staleLease: import('@assistant/persistence').EmailSyncLease | undefined;
    let finishFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => (firstStarted = resolve));
    const finish = new Promise<void>((resolve) => (finishFirst = resolve));
    const first = f.repository.withLock(async (lease) => {
      staleLease = lease;
      firstStarted();
      await finish;
    });
    await started;
    f.advance(10 * 60_000 + 1);

    let successorLease: import('@assistant/persistence').EmailSyncLease | undefined;
    let finishSecond!: () => void;
    let secondStarted!: () => void;
    const secondStartedPromise = new Promise<void>((resolve) => (secondStarted = resolve));
    const finishSecondPromise = new Promise<void>((resolve) => (finishSecond = resolve));
    const second = f.repository.withLock(async (lease) => {
      successorLease = lease;
      await f.repository.saveCursor('owner@example.com', { generation: 'current' }, lease);
      secondStarted();
      await finishSecondPromise;
    });
    await secondStartedPromise;
    if (!staleLease) throw new Error('expired worker did not capture its lease');
    expect(successorLease?.generation).toBeGreaterThan(staleLease?.generation ?? 0);
    await expect(
      f.repository.saveCursor('owner@example.com', { generation: 'stale' }, staleLease),
    ).rejects.toThrow('lease is no longer current');
    expect(await f.repository.syncState('owner@example.com')).toMatchObject({
      cursor: { generation: 'current' },
    });

    finishSecond();
    await second;
    finishFirst();
    await first;
  });

  it('renews only the current lease and rejects renewal after expiry', async () => {
    const f = fixture('active');
    let captured: import('@assistant/persistence').EmailSyncLease | undefined;
    await f.repository.withLock(async (lease) => {
      captured = lease;
      f.advance(9 * 60_000);
      await lease.renew();
      f.advance(9 * 60_000);
      await lease.assertCurrent();
    });
    await expect(captured?.assertCurrent()).rejects.toThrow('lease is no longer current');
  });

  it('claims scoring once and retains a below-threshold card candidate through completion', async () => {
    const f = fixture('active');
    const channelMessageId = 'gmail:provider-message-1';
    const stage = await f.repository.beginForwardedIngest({
      agentId: 'agent-1',
      mailbox: 'owner@example.test',
      providerMessageId: 'provider-message-1',
      channelMessageId,
      conversationId: 'conversation-1',
      fromEmail: 'sender@example.test',
      fromName: null,
      subject: 'Pass',
      contentTrust: 'unknown',
      authenticated: true,
      category: 'other',
      importance: 1,
      actionable: false,
      reason: '',
      dates: [],
    });
    const token = 'score-token';

    expect(await f.repository.claimIngestScore('agent-1', stage.id, token, null)).toBe(true);
    expect(await f.repository.claimIngestScore('agent-1', stage.id, 'second-token', null)).toBe(
      false,
    );
    await f.repository.prepareIngestScore(
      'agent-1',
      stage.id,
      token,
      {
        category: 'travel',
        importance: 2,
        actionable: false,
        reason: 'A pass worth keeping.',
        dates: [],
        cardCandidate: true,
        nextStep: null,
      },
      null,
    );
    await f.repository.markIngestMessagePersisted(stage.id, 'conversation-1');
    await f.repository.completeForwardedIngest(stage.id, {
      triaged: true,
      taskId: 'task-1',
      now: new Date(),
    });

    expect(await f.repository.ingestRecord(channelMessageId)).toMatchObject({
      pipelineStage: 'complete',
      scoreStatus: 'prepared',
      messagePersisted: true,
      importance: 2,
      cardCandidate: true,
      triaged: true,
      triageTaskId: 'task-1',
    });

    const uncertain = await f.repository.beginForwardedIngest({
      agentId: 'agent-1',
      mailbox: 'owner@example.test',
      providerMessageId: 'provider-message-2',
      channelMessageId: 'gmail:provider-message-2',
      conversationId: 'conversation-1',
      fromEmail: 'sender@example.test',
      fromName: null,
      subject: 'Unknown scorer result',
      contentTrust: 'unknown',
      authenticated: true,
      category: 'other',
      importance: 1,
      actionable: false,
      reason: '',
      dates: [],
    });
    expect(
      await f.repository.claimIngestScore('agent-1', uncertain.id, 'uncertain-token', null),
    ).toBe(true);
    await f.repository.markIngestScoreUnknown('agent-1', uncertain.id, 'uncertain-token', null);
    expect(
      await f.repository.claimIngestScore('agent-1', uncertain.id, 'repeat-charge-token', null),
    ).toBe(false);
    expect(await f.repository.ingestRecord('gmail:provider-message-2')).toMatchObject({
      pipelineStage: 'needs_attention',
      scoreStatus: 'unknown',
    });
  });
});

describe('Firestore atomic email observer admission', () => {
  async function preparedDirectFixture(
    channelMessageId = 'gmail:observer-message',
    automated = false,
  ) {
    const f = fixture('active');
    const messageId = channelMessageId.slice('gmail:'.length);
    const base = {
      agentId: 'agent-1',
      mailbox: 'owner@example.test',
      providerMessageId: messageId,
      channelMessageId,
      conversationId: 'conversation-1',
      fromEmail: 'sender@example.test',
      fromName: null,
      subject: 'Observer source',
      contentTrust: 'unknown',
      authenticated: true,
      ingestMode: 'direct' as const,
      hasExternalOrUnknown: false,
      category: 'other',
      importance: 1,
      actionable: false,
      reason: '',
      dates: [],
    };
    const stage = await f.repository.beginDirectEmailIngest(base, {
      expectedPrivacyGeneration: null,
    });
    expect(
      await f.repository.claimIngestClassification('agent-1', stage.id, 'classify-token', null),
    ).toBe(true);
    await f.repository.prepareIngestClassification(
      'agent-1',
      stage.id,
      'classify-token',
      { automated },
      null,
    );
    expect(await f.repository.claimIngestScore('agent-1', stage.id, 'score-token', null)).toBe(
      true,
    );
    await f.repository.prepareIngestScore(
      'agent-1',
      stage.id,
      'score-token',
      {
        category: 'travel',
        importance: 4,
        actionable: true,
        reason: 'Stored source verdict',
        dates: [],
        cardCandidate: false,
        nextStep: null,
      },
      null,
    );
    return { f, stage, base };
  }

  it('rejects forwarded ingest after an erase advanced the captured generation before writing metadata', async () => {
    const f = fixture('active');
    const capturedGeneration = await f.repository.privacyObservationFence('agent-1');
    expect(capturedGeneration).toBeNull();
    f.docs.set(`privacyErasureJobs/${documentKey('agent-1')}`, {
      id: 'agent-1',
      agentId: 'agent-1',
      status: 'complete',
      updateTime: { seconds: 7, nanoseconds: 0 },
    });
    const before = f.writes();
    await expect(
      f.repository.beginForwardedIngest(
        {
          agentId: 'agent-1',
          mailbox: 'owner@example.test',
          providerMessageId: 'erased-forwarded',
          channelMessageId: 'gmail:erased-forwarded',
          conversationId: 'conversation-1',
          fromEmail: 'private-sender@example.test',
          fromName: 'Private Sender',
          subject: 'Private subject',
          contentTrust: 'unknown',
          authenticated: true,
          category: 'other',
          importance: 1,
          actionable: false,
          reason: '',
          dates: [],
        },
        { expectedPrivacyGeneration: capturedGeneration },
      ),
    ).rejects.toThrow('Privacy erasure changed during memory source observation');
    expect(f.writes()).toBe(before);
    expect(f.docs.has(`emailIngest/${documentKey('gmail:erased-forwarded')}`)).toBe(false);
  });

  it('rejects stale forwarded conversation creation after erasure before writing conversation or binding', async () => {
    const f = fixture('active');
    const capturedGeneration = await f.repository.privacyObservationFence('agent-1');
    expect(capturedGeneration).toBeNull();
    f.docs.set(`privacyErasureJobs/${documentKey('agent-1')}`, {
      id: 'agent-1',
      agentId: 'agent-1',
      status: 'complete',
      generation: 'new-generation',
      updateTime: { seconds: 9, nanoseconds: 0 },
    });
    const beforeWrites = f.writes();
    const beforeDocs = f.docs.size;
    await expect(
      f.repository.conversationForThread('agent-1', 'erased-thread', 'unknown', 'Private subject', {
        expectedPrivacyGeneration: capturedGeneration,
      }),
    ).rejects.toThrow('Privacy erasure changed during email conversation admission');
    expect(f.writes()).toBe(beforeWrites);
    expect(f.docs.size).toBe(beforeDocs);
    expect([...f.docs.keys()].filter((key) => key.startsWith('channelBindings/'))).toEqual([]);
    expect([...f.docs.keys()].filter((key) => key.startsWith('conversations/'))).toEqual([
      `conversations/${documentKey('conversation-1')}`,
    ]);
  });

  it('freezes deterministic no-model claims separately and releases definite no-call budget blocks', async () => {
    const f = fixture('active');
    const base = {
      agentId: 'agent-1',
      mailbox: 'owner@example.test',
      providerMessageId: 'score-outcome-control',
      channelMessageId: 'gmail:score-outcome-control',
      conversationId: 'conversation-1',
      fromEmail: 'sender@example.test',
      fromName: null,
      subject: 'Outcome control',
      contentTrust: 'unknown',
      authenticated: true,
      ingestMode: 'direct' as const,
      hasExternalOrUnknown: false,
      category: 'other' as const,
      importance: 1,
      actionable: false,
      reason: '',
      dates: [],
    };
    const stage = await f.repository.beginDirectEmailIngest(base, {
      expectedPrivacyGeneration: null,
    });
    expect(
      await f.repository.claimIngestClassification(
        'agent-1',
        stage.id,
        'score-classifier-token',
        null,
      ),
    ).toBe(true);
    await f.repository.prepareIngestClassification(
      'agent-1',
      stage.id,
      'score-classifier-token',
      { automated: false },
      null,
    );
    expect(
      await f.repository.claimIngestScore(
        'agent-1',
        stage.id,
        'deterministic-score-token',
        null,
        undefined,
        'deterministic_no_model',
      ),
    ).toBe(true);
    const score = {
      category: 'bulk' as const,
      importance: 1,
      actionable: false,
      reason: 'Header-only rule',
      dates: [],
      cardCandidate: false,
      nextStep: null,
    };
    await expect(
      f.repository.prepareIngestScore(
        'agent-1',
        stage.id,
        'deterministic-score-token',
        score,
        null,
      ),
    ).rejects.toThrow('email scoring claim is no longer current');
    await f.repository.prepareIngestScoreDeterministic(
      'agent-1',
      stage.id,
      'deterministic-score-token',
      score,
      null,
    );
    expect(
      [...f.docs.values()].find((row) => row.channelMessageId === 'gmail:score-outcome-control'),
    ).toMatchObject({
      scoreStatus: 'prepared',
      scoreOutcome: 'deterministic_no_model',
      pipelineStage: 'score_prepared',
    });

    const second = await f.repository.beginDirectEmailIngest(
      {
        ...base,
        providerMessageId: 'score-budget-blocked',
        channelMessageId: 'gmail:score-budget-blocked',
      },
      { expectedPrivacyGeneration: null },
    );
    expect(
      await f.repository.claimIngestClassification(
        'agent-1',
        second.id,
        'budget-classifier-token',
        null,
      ),
    ).toBe(true);
    await f.repository.prepareIngestClassification(
      'agent-1',
      second.id,
      'budget-classifier-token',
      { automated: false },
      null,
    );
    expect(
      await f.repository.claimIngestScore('agent-1', second.id, 'budget-blocked-score-token', null),
    ).toBe(true);
    await f.repository.markIngestScoreBudgetBlocked(
      'agent-1',
      second.id,
      'budget-blocked-score-token',
      null,
    );
    expect(
      [...f.docs.values()].find((row) => row.channelMessageId === 'gmail:score-budget-blocked'),
    ).toMatchObject({
      scoreStatus: 'pending',
      scoreOutcome: 'budget_blocked',
      pipelineStage: 'pending_score',
      scoreClaimToken: null,
    });
    expect(
      await f.repository.claimIngestScore('agent-1', second.id, 'retry-score-token', null),
    ).toBe(true);
  });

  it('rejects a forwarded receiver-authenticated source as unverified and rejects unauthenticated direct admission', async () => {
    const f = fixture('active');
    const source = {
      agentId: 'agent-1',
      mailbox: 'owner@example.test',
      providerMessageId: 'forwarded-authenticated',
      channelMessageId: 'gmail:forwarded-authenticated',
      conversationId: 'conversation-1',
      fromEmail: 'external@example.test',
      fromName: null,
      subject: 'Forwarded message',
      contentTrust: 'unknown',
      authenticated: true,
      category: 'other',
      importance: 1,
      actionable: false,
      reason: '',
      dates: [],
    };
    const ingest = await f.repository.beginForwardedIngest(source, {
      expectedPrivacyGeneration: null,
    });
    expect(
      await f.repository.claimIngestScore('agent-1', ingest.id, 'forwarded-score-token', null),
    ).toBe(true);
    await f.repository.prepareIngestScore(
      'agent-1',
      ingest.id,
      'forwarded-score-token',
      {
        category: 'other',
        importance: 1,
        actionable: false,
        reason: 'Prepared',
        dates: [],
        cardCandidate: false,
        nextStep: null,
      },
      null,
    );
    const admitted = await f.repository.commitEmailAdmission({
      agentId: 'agent-1',
      ingestId: ingest.id,
      scoreClaimToken: 'forwarded-score-token',
      source: {
        kind: 'message',
        message: {
          conversationId: 'conversation-1',
          channelMessageId: source.channelMessageId,
          role: 'user',
          origin: 'unknown',
          parts: [{ type: 'text', text: 'Forwarded body' }],
          text: 'Forwarded body',
        },
      },
      finalizedIngest: source,
      observers: [{ key: 'google.email-card', version: 1, workClass: 'idempotent_db' }],
      expectedPrivacyGeneration: null,
    });
    const claim = await f.repository.claimEmailObserver({
      id: admitted.observerIds[0]!,
      agentId: 'agent-1',
      token: 'forwarded-source-claim',
      now: new Date('2026-10-06T00:00:00Z'),
      leaseMs: 60_000,
      expectedPrivacyGeneration: null,
    });
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') throw new Error('forwarded observer was not claimed');
    expect(f.docs.get(`emailIngest/${documentKey(ingest.id)}`)).toMatchObject({
      agentId: 'agent-1',
      ingestMode: 'forwarded',
      admittedSourceKind: 'message',
      admittedSourceId: admitted.messageId,
    });
    expect(f.docs.get(`emailObserverWork/${documentKey(claim.claim.id)}`)).toMatchObject({
      agentId: 'agent-1',
      sourceKind: 'message',
      claimToken: claim.claim.claimToken,
      status: 'claimed',
    });
    expect(await f.repository.loadEmailObserverSource(claim.claim)).toMatchObject({
      authenticated: true,
      ingestMode: 'forwarded',
      sourceVerification: 'forwarded_unverified',
    });
    const writesBeforeUnauthenticatedDirect = f.writes();
    await expect(
      f.repository.beginDirectEmailIngest(
        {
          ...source,
          providerMessageId: 'direct-untrusted',
          channelMessageId: 'gmail:direct-untrusted',
          ingestMode: 'direct',
          authenticated: false,
        },
        { expectedPrivacyGeneration: null },
      ),
    ).rejects.toThrow('Direct email ingest requires configured owner and receiver authentication');
    expect(f.writes()).toBe(writesBeforeUnauthenticatedDirect);
  });

  it('uses the stored checkpoint, source pointer, and original registry on duplicate delivery', async () => {
    const { f, stage, base } = await preparedDirectFixture();
    const first = await f.repository.commitEmailAdmission({
      agentId: 'agent-1',
      ingestId: stage.id,
      scoreClaimToken: 'score-token',
      source: {
        kind: 'message',
        message: {
          conversationId: 'conversation-1',
          channelMessageId: base.channelMessageId,
          role: 'assistant',
          origin: 'owner',
          parts: [],
          text: 'Mail body',
        },
      },
      finalizedIngest: base,
      observers: [{ key: 'google.email-card', version: 1, workClass: 'idempotent_db' }],
      expectedPrivacyGeneration: null,
    });
    const message = f.docs.get(`messages/${documentKey(first.messageId!)}`);
    expect(message).toMatchObject({ role: 'user', origin: 'unknown', text: 'Mail body' });

    const replay = await f.repository.commitEmailAdmission({
      agentId: 'agent-1',
      ingestId: stage.id,
      scoreClaimToken: 'score-token',
      source: {
        kind: 'message',
        message: {
          conversationId: 'different-conversation',
          channelMessageId: base.channelMessageId,
          role: 'assistant',
          origin: 'owner',
          parts: [],
          text: 'Changed caller payload',
        },
      },
      finalizedIngest: {
        ...base,
        authenticated: false,
        contentTrust: 'owner',
        hasExternalOrUnknown: true,
        preparedClassification: { automated: true },
        category: 'spam',
        importance: 9,
      },
      observers: [{ key: 'google.email-card', version: 2, workClass: 'paid_ambiguous' }],
      expectedPrivacyGeneration: null,
    });
    expect(replay).toMatchObject({
      messageId: first.messageId,
      sourceId: first.messageId,
      duplicate: true,
    });
    expect(replay.observerIds).toEqual([
      emailObserverWorkId('agent-1', base.channelMessageId, 'google.email-card', 1),
    ]);
    expect(f.docs.get(`emailIngest/${documentKey(stage.id)}`)).toMatchObject({
      contentTrust: 'unknown',
      authenticated: true,
      hasExternalOrUnknown: false,
      category: 'travel',
      importance: 4,
      preparedClassification: { automated: false },
      admittedSourceKind: 'message',
      admittedSourceId: first.messageId,
    });
  });

  it('freezes an empty registry and still resolves the original canonical source', async () => {
    const { f, stage, base } = await preparedDirectFixture('gmail:empty-registry', true);
    const first = await f.repository.commitEmailAdmission({
      agentId: 'agent-1',
      ingestId: stage.id,
      scoreClaimToken: 'score-token',
      source: { kind: 'automated_source', body: 'Automated mail' },
      finalizedIngest: base,
      observers: [],
      expectedPrivacyGeneration: null,
    });
    const replay = await f.repository.commitEmailAdmission({
      agentId: 'agent-1',
      ingestId: stage.id,
      scoreClaimToken: 'score-token',
      source: { kind: 'automated_source', body: 'wrong payload' },
      finalizedIngest: { ...base, subject: 'Changed caller metadata' },
      observers: [{ key: 'new.version', version: 2, workClass: 'paid_ambiguous' }],
      expectedPrivacyGeneration: null,
    });
    expect(first.observerIds).toEqual([]);
    expect(replay).toMatchObject({
      sourceId: first.sourceId,
      messageId: null,
      duplicate: true,
      observerIds: [],
    });
    expect(f.docs.get(`emailIngest/${documentKey(stage.id)}`)).toMatchObject({
      admittedSourceKind: 'automated_source',
      admittedSourceId: emailObserverSourceId('agent-1', base.channelMessageId),
      observerRegistrySnapshot: [],
    });
  });

  it('rejects a source present in both canonical stores before creating observer work', async () => {
    const { f, stage, base } = await preparedDirectFixture('gmail:dual-store');
    const before = f.writes();
    const automatedId = emailObserverSourceId('agent-1', base.channelMessageId);
    f.docs.set(`emailObserverSources/${documentKey(automatedId)}`, {
      id: automatedId,
      agentId: 'agent-1',
      sourceKey: base.channelMessageId,
      channelMessageId: base.channelMessageId,
      body: 'Other canonical copy',
      privacyGeneration: null,
    });
    await expect(
      f.repository.commitEmailAdmission({
        agentId: 'agent-1',
        ingestId: stage.id,
        scoreClaimToken: 'score-token',
        source: {
          kind: 'message',
          message: {
            conversationId: 'conversation-1',
            channelMessageId: base.channelMessageId,
            role: 'user',
            origin: 'unknown',
            parts: [],
            text: 'Mail body',
          },
        },
        finalizedIngest: base,
        observers: [{ key: 'google.email-card', version: 1, workClass: 'idempotent_db' }],
        expectedPrivacyGeneration: null,
      }),
    ).rejects.toThrow(/automated canonical store|both canonical body stores/);
    expect(f.writes()).toBe(before);
    expect(
      f.docs.has(
        `emailObserverWork/${documentKey(emailObserverWorkId('agent-1', base.channelMessageId, 'google.email-card', 1))}`,
      ),
    ).toBe(false);
  });

  it('rejects another owner canonical source before creating a visible message or observer jobs', async () => {
    const { f, stage, base } = await preparedDirectFixture('gmail:cross-owner-canonical-collision');
    const foreignAgentId = 'agent-2';
    const foreignSourceId = emailObserverSourceId(foreignAgentId, base.channelMessageId);
    f.docs.set(`agents/${documentKey(foreignAgentId)}`, { id: foreignAgentId });
    f.docs.set(`emailObserverSources/${documentKey(foreignSourceId)}`, {
      id: foreignSourceId,
      agentId: foreignAgentId,
      sourceKey: base.channelMessageId,
      channelMessageId: base.channelMessageId,
      body: 'foreign canonical body',
      privacyGeneration: null,
    });
    const before = f.writes();
    await expect(
      f.repository.commitEmailAdmission({
        agentId: 'agent-1',
        ingestId: stage.id,
        scoreClaimToken: 'score-token',
        source: {
          kind: 'message',
          message: {
            conversationId: 'conversation-1',
            channelMessageId: base.channelMessageId,
            role: 'user',
            origin: 'unknown',
            parts: [{ type: 'text', text: 'visible body' }],
            text: 'visible body',
          },
        },
        finalizedIngest: base,
        observers: [{ key: 'google.email-card', version: 1, workClass: 'idempotent_db' }],
        expectedPrivacyGeneration: null,
      }),
    ).rejects.toThrow('Email automated source identity is already bound to another owner');
    expect(f.writes()).toBe(before);
    expect(
      [...f.docs.entries()].filter(
        ([key, row]) =>
          key.startsWith('messages/') && row.channelMessageId === base.channelMessageId,
      ),
    ).toEqual([]);
    expect(
      f.docs.has(
        `emailObserverWork/${documentKey(emailObserverWorkId('agent-1', base.channelMessageId, 'google.email-card', 1))}`,
      ),
    ).toBe(false);
  });

  it('rejects a stale work privacy generation before claim or budget mutation', async () => {
    const f = fixture('active');
    const base = {
      agentId: 'agent-1',
      mailbox: 'owner@example.test',
      providerMessageId: 'stale-work-privacy',
      channelMessageId: 'gmail:stale-work-privacy',
      conversationId: 'conversation-1',
      fromEmail: 'sender@example.test',
      fromName: null,
      subject: 'Stale work privacy',
      contentTrust: 'unknown',
      authenticated: true,
      category: 'other' as const,
      importance: 1,
      actionable: false,
      reason: '',
      dates: [],
    };
    const stage = await f.repository.beginForwardedIngest(base, {
      expectedPrivacyGeneration: null,
    });
    expect(
      await f.repository.claimIngestScore('agent-1', stage.id, 'stale-score-token', null),
    ).toBe(true);
    await f.repository.prepareIngestScore(
      'agent-1',
      stage.id,
      'stale-score-token',
      {
        category: 'other',
        importance: 1,
        actionable: false,
        reason: 'Prepared',
        dates: [],
        cardCandidate: false,
        nextStep: null,
      },
      null,
    );
    const admitted = await f.repository.commitEmailAdmission({
      agentId: 'agent-1',
      ingestId: stage.id,
      scoreClaimToken: 'stale-score-token',
      source: {
        kind: 'message',
        message: {
          conversationId: 'conversation-1',
          channelMessageId: 'gmail:stale-work-privacy',
          role: 'user',
          origin: 'unknown',
          parts: [{ type: 'text', text: 'Mail body' }],
          text: 'Mail body',
        },
      },
      finalizedIngest: base,
      observers: [{ key: 'google.owner-voice-sample', version: 9, workClass: 'paid_ambiguous' }],
      expectedPrivacyGeneration: null,
    });
    const id = admitted.observerIds[0]!;
    const workKey = `emailObserverWork/${documentKey(id)}`;
    const before = f.docs.get(workKey)!;
    f.docs.set(workKey, { ...before, privacyGeneration: 'stale-generation' });
    const result = await f.repository.claimEmailObserver({
      id,
      agentId: 'agent-1',
      token: 'stale-work-claim',
      now: new Date(),
      leaseMs: 60_000,
      expectedPrivacyGeneration: null,
      paidBudget: {
        budgetKey: 'google.owner-voice-sample',
        observerKey: 'google.owner-voice-sample',
        limit: 1,
        windowStart: new Date('2026-10-09T00:00:00.000Z'),
        windowEnd: new Date('2026-10-10T00:00:00.000Z'),
      },
    });
    expect(result).toEqual({ kind: 'none' });
    expect(f.docs.get(workKey)).toMatchObject({ ...before, privacyGeneration: 'stale-generation' });
    expect([...f.docs.keys()].filter((key) => key.startsWith('emailObserverBudgets/'))).toEqual([]);
  });

  it('resumes a prepared paid observer without charging its daily reservation twice', async () => {
    const { f, stage, base } = await preparedDirectFixture('gmail:paid-observer');
    const admitted = await f.repository.commitEmailAdmission({
      agentId: 'agent-1',
      ingestId: stage.id,
      scoreClaimToken: 'score-token',
      source: {
        kind: 'message',
        message: {
          conversationId: 'conversation-1',
          channelMessageId: base.channelMessageId,
          role: 'user',
          origin: 'unknown',
          parts: [{ type: 'text', text: 'Mail body' }],
          text: 'Mail body',
        },
      },
      finalizedIngest: base,
      observers: [{ key: 'google.owner-voice-sample', version: 1, workClass: 'paid_ambiguous' }],
      expectedPrivacyGeneration: null,
    });
    f.advance(12 * 60 * 60 * 1000);
    const now = new Date('2026-10-06T12:00:00.000Z');
    const budget = {
      budgetKey: 'google.owner-voice-sample',
      observerKey: 'google.owner-voice-sample',
      limit: 1,
      windowStart: new Date('2026-10-06T00:00:00.000Z'),
      windowEnd: new Date('2026-10-07T00:00:00.000Z'),
    };
    const first = await f.repository.claimEmailObserver({
      id: admitted.observerIds[0]!,
      agentId: 'agent-1',
      token: 'paid-claim-1',
      now,
      leaseMs: 60_000,
      expectedPrivacyGeneration: null,
      paidBudget: budget,
    });
    expect(first.kind).toBe('claimed');
    if (first.kind !== 'claimed') throw new Error('paid observer was not claimed');
    expect(first.claim.budgetReserved).toBe(true);
    expect(
      await f.repository.prepareEmailObserver({
        id: first.claim.id,
        agentId: 'agent-1',
        claimToken: first.claim.claimToken,
        claimGeneration: first.claim.claimGeneration,
        expectedPrivacyGeneration: null,
        now: new Date(now.getTime() + 1000),
        result: {
          register: 'email_casual',
          context: 'inbound-email',
          observedGeneration: 'gen-1',
          embeddingSpaceKey: 'space:key',
          embedding: [0.1, -0.1],
        },
      }),
    ).toBe(true);
    const activeLeaseReplay = await f.repository.claimEmailObserver({
      id: admitted.observerIds[0]!,
      agentId: 'agent-1',
      token: 'paid-claim-2',
      now: new Date(now.getTime() + 2000),
      leaseMs: 60_000,
      expectedPrivacyGeneration: null,
      paidBudget: budget,
    });
    expect(activeLeaseReplay).toEqual({ kind: 'none' });
    f.advance(61_000);
    const resumed = await f.repository.claimEmailObserver({
      id: admitted.observerIds[0]!,
      agentId: 'agent-1',
      token: 'paid-claim-3',
      now: new Date(now.getTime() + 63_000),
      leaseMs: 60_000,
      expectedPrivacyGeneration: null,
      paidBudget: budget,
    });
    expect(resumed.kind).toBe('claimed');
    if (resumed.kind !== 'claimed') throw new Error('prepared paid observer was not resumed');
    expect(resumed.claim.status).toBe('prepared');
    expect(resumed.claim.preparedResult).toMatchObject({
      register: 'email_casual',
      observedGeneration: 'gen-1',
    });
    expect(resumed.claim.attemptCount).toBe(1);
    expect(
      f.docs.has(
        `emailObserverBudgets/${documentKey(emailObserverBudgetId('agent-1', 'google.owner-voice-sample', budget.windowStart))}`,
      ),
    ).toBe(true);
    const bucket = [...f.docs.entries()].find(([key]) =>
      key.startsWith('emailObserverBudgets/'),
    )?.[1];
    expect(bucket).toMatchObject({
      reservedCount: 1,
      limit: 1,
      observerKey: 'google.owner-voice-sample',
    });
    expect(
      await f.repository.loadEmailObserverSource({
        ...resumed.claim,
      }),
    ).toMatchObject({
      body: 'Mail body',
      contentTrust: 'unknown',
      authenticated: true,
    });
    f.advance(63_000);
    expect(await f.repository.loadEmailObserverSource(resumed.claim)).toBeNull();
  });

  it('marks an expired unprepared external effect unknown instead of allowing replay', async () => {
    const { f, stage, base } = await preparedDirectFixture('gmail:ambiguous-observer');
    const admitted = await f.repository.commitEmailAdmission({
      agentId: 'agent-1',
      ingestId: stage.id,
      scoreClaimToken: 'score-token',
      source: {
        kind: 'message',
        message: {
          conversationId: 'conversation-1',
          channelMessageId: base.channelMessageId,
          role: 'user',
          origin: 'unknown',
          parts: [],
          text: 'Mail body',
        },
      },
      finalizedIngest: base,
      observers: [{ key: 'google.owner-voice-sample', version: 2, workClass: 'external_provider' }],
      expectedPrivacyGeneration: null,
    });
    const now = new Date('2026-10-06T00:00:00.000Z');
    const first = await f.repository.claimEmailObserver({
      id: admitted.observerIds[0]!,
      agentId: 'agent-1',
      token: 'external-claim-1',
      now,
      leaseMs: 1000,
      expectedPrivacyGeneration: null,
    });
    expect(first.kind).toBe('claimed');
    f.advance(1001);
    const afterExpiry = await f.repository.claimEmailObserver({
      id: admitted.observerIds[0]!,
      agentId: 'agent-1',
      token: 'external-claim-2',
      now: new Date(now.getTime() + 1001),
      leaseMs: 1000,
      expectedPrivacyGeneration: null,
    });
    expect(afterExpiry).toEqual({ kind: 'none' });
    expect(f.docs.get(`emailObserverWork/${documentKey(admitted.observerIds[0]!)}`)).toMatchObject({
      status: 'unknown',
      claimToken: null,
      leaseExpiresAt: null,
    });
  });

  it('resumes an immutable prepared result after retryable apply failure without reserving paid budget twice', async () => {
    const { f, stage, base } = await preparedDirectFixture('gmail:retry-prepared');
    const admitted = await f.repository.commitEmailAdmission({
      agentId: 'agent-1',
      ingestId: stage.id,
      scoreClaimToken: 'score-token',
      source: {
        kind: 'message',
        message: {
          conversationId: 'conversation-1',
          channelMessageId: base.channelMessageId,
          role: 'user',
          origin: 'unknown',
          parts: [],
          text: 'Mail body',
        },
      },
      finalizedIngest: base,
      observers: [{ key: 'google.owner-voice-sample', version: 5, workClass: 'paid_ambiguous' }],
      expectedPrivacyGeneration: null,
    });
    const now = new Date('2026-10-06T00:00:00.000Z');
    const budget = {
      budgetKey: 'google.owner-voice-sample',
      observerKey: 'google.owner-voice-sample',
      limit: 1,
      windowStart: now,
      windowEnd: new Date(now.getTime() + 86_400_000),
    };
    const result = {
      register: 'email_casual',
      context: 'inbound-email',
      observedGeneration: 'gen-5',
      embeddingSpaceKey: 'space:key',
      embedding: [0.5, -0.5],
    };
    const first = await f.repository.claimEmailObserver({
      id: admitted.observerIds[0]!,
      agentId: 'agent-1',
      token: 'retry-claim-1',
      now,
      leaseMs: 60_000,
      expectedPrivacyGeneration: null,
      paidBudget: budget,
    });
    expect(first.kind).toBe('claimed');
    if (first.kind !== 'claimed') throw new Error('claim missing');
    expect(
      await f.repository.prepareEmailObserver({
        id: first.claim.id,
        agentId: 'agent-1',
        claimToken: first.claim.claimToken,
        claimGeneration: first.claim.claimGeneration,
        expectedPrivacyGeneration: null,
        now: new Date(now.getTime() + 1),
        result,
      }),
    ).toBe(true);
    expect(
      await f.repository.failEmailObserver({
        id: first.claim.id,
        agentId: 'agent-1',
        claimToken: first.claim.claimToken,
        claimGeneration: first.claim.claimGeneration,
        expectedPrivacyGeneration: null,
        now: new Date(now.getTime() + 2),
        outcome: 'retryable_failed',
        errorCode: 'email_card_effect_unknown',
      }),
    ).toBe(true);
    const resumed = await f.repository.claimEmailObserver({
      id: first.claim.id,
      agentId: 'agent-1',
      token: 'retry-claim-2',
      now: new Date(now.getTime() + 3),
      leaseMs: 60_000,
      expectedPrivacyGeneration: null,
      paidBudget: budget,
    });
    expect(resumed.kind).toBe('claimed');
    if (resumed.kind !== 'claimed') throw new Error('prepared retry missing');
    expect(resumed.claim.status).toBe('prepared');
    expect(resumed.claim.preparedResult).toEqual(result);
    expect(resumed.claim.attemptCount).toBe(1);
    expect(
      await f.repository.prepareEmailObserver({
        id: resumed.claim.id,
        agentId: 'agent-1',
        claimToken: resumed.claim.claimToken,
        claimGeneration: resumed.claim.claimGeneration,
        expectedPrivacyGeneration: null,
        now: new Date(now.getTime() + 4),
        result: { ...result, observedGeneration: 'different' },
      }),
    ).toBe(false);
    const bucket = [...f.docs.entries()].find(([key]) =>
      key.startsWith('emailObserverBudgets/'),
    )?.[1];
    expect(bucket).toMatchObject({
      reservedCount: 1,
      limit: 1,
      observerKey: 'google.owner-voice-sample',
    });
  });

  it('uses the transaction clock to reject stale future timestamps and budgets', async () => {
    const { f, stage, base } = await preparedDirectFixture('gmail:stale-budget');
    const admitted = await f.repository.commitEmailAdmission({
      agentId: 'agent-1',
      ingestId: stage.id,
      scoreClaimToken: 'score-token',
      source: {
        kind: 'message',
        message: {
          conversationId: 'conversation-1',
          channelMessageId: base.channelMessageId,
          role: 'user',
          origin: 'unknown',
          parts: [],
          text: 'Mail body',
        },
      },
      finalizedIngest: base,
      observers: [{ key: 'google.owner-voice-sample', version: 3, workClass: 'paid_ambiguous' }],
      expectedPrivacyGeneration: null,
    });
    f.advance(25 * 60 * 60 * 1000);
    await expect(
      f.repository.claimEmailObserver({
        id: admitted.observerIds[0]!,
        agentId: 'agent-1',
        token: 'stale-budget',
        now: new Date('2026-10-06T00:00:00.000Z'),
        leaseMs: 60_000,
        expectedPrivacyGeneration: null,
        paidBudget: {
          budgetKey: 'google.owner-voice-sample',
          observerKey: 'google.owner-voice-sample',
          limit: 1,
          windowStart: new Date('2026-10-06T00:00:00.000Z'),
          windowEnd: new Date('2026-10-07T00:00:00.000Z'),
        },
      }),
    ).rejects.toThrow('UTC-day budget');
    expect(
      f.docs.has(
        `emailObserverBudgets/${documentKey(emailObserverBudgetId('agent-1', 'google.owner-voice-sample', new Date('2026-10-06T00:00:00.000Z')))}`,
      ),
    ).toBe(false);
  });

  it('refunds a known no-provider budget block and reserves against the new UTC day on retry', async () => {
    const { f, stage, base } = await preparedDirectFixture('gmail:budget-blocked-day-boundary');
    const admitted = await f.repository.commitEmailAdmission({
      agentId: 'agent-1',
      ingestId: stage.id,
      scoreClaimToken: 'score-token',
      source: {
        kind: 'message',
        message: {
          conversationId: 'conversation-1',
          channelMessageId: base.channelMessageId,
          role: 'user',
          origin: 'unknown',
          parts: [],
          text: 'Mail body',
        },
      },
      finalizedIngest: base,
      observers: [{ key: 'google.owner-voice-sample', version: 6, workClass: 'paid_ambiguous' }],
      expectedPrivacyGeneration: null,
    });
    const dayOneStart = new Date('2026-10-06T00:00:00.000Z');
    const dayOneEnd = new Date('2026-10-07T00:00:00.000Z');
    const dayOneBudget = {
      budgetKey: 'google.owner-voice-sample',
      observerKey: 'google.owner-voice-sample',
      limit: 1,
      windowStart: dayOneStart,
      windowEnd: dayOneEnd,
    };
    const first = await f.repository.claimEmailObserver({
      id: admitted.observerIds[0]!,
      agentId: 'agent-1',
      token: 'budget-blocked-day-one',
      now: dayOneStart,
      leaseMs: 60_000,
      expectedPrivacyGeneration: null,
      paidBudget: dayOneBudget,
    });
    expect(first.kind).toBe('claimed');
    if (first.kind !== 'claimed') throw new Error('day one reservation missing');
    expect(first.claim.budgetReserved).toBe(true);
    expect(
      await f.repository.failEmailObserver({
        id: first.claim.id,
        agentId: 'agent-1',
        claimToken: first.claim.claimToken,
        claimGeneration: first.claim.claimGeneration,
        expectedPrivacyGeneration: null,
        now: new Date(dayOneStart.getTime() + 1000),
        outcome: 'budget_blocked',
        errorCode: 'email_observer_budget_blocked',
      }),
    ).toBe(true);
    const dayOneBucket = f.docs.get(
      `emailObserverBudgets/${documentKey(emailObserverBudgetId('agent-1', 'google.owner-voice-sample', dayOneStart))}`,
    );
    expect(dayOneBucket).toMatchObject({ reservedCount: 0 });
    expect(f.docs.get(`emailObserverWork/${documentKey(first.claim.id)}`)).toMatchObject({
      status: 'retryable_failed',
      budgetReserved: false,
      budgetWindowStart: null,
    });

    f.advance(24 * 60 * 60 * 1000);
    const dayTwoStart = new Date('2026-10-07T00:00:00.000Z');
    const dayTwoBudget = {
      budgetKey: 'google.owner-voice-sample',
      observerKey: 'google.owner-voice-sample',
      limit: 1,
      windowStart: dayTwoStart,
      windowEnd: new Date('2026-10-08T00:00:00.000Z'),
    };
    const retry = await f.repository.claimEmailObserver({
      id: first.claim.id,
      agentId: 'agent-1',
      token: 'budget-blocked-day-two',
      now: dayTwoStart,
      leaseMs: 60_000,
      expectedPrivacyGeneration: null,
      paidBudget: dayTwoBudget,
    });
    expect(retry.kind).toBe('claimed');
    if (retry.kind !== 'claimed') throw new Error('day two reservation was not created');
    expect(retry.claim).toMatchObject({
      budgetReserved: true,
      budgetKey: 'google.owner-voice-sample',
      attemptCount: 2,
    });
    expect(retry.claim.budgetWindowStart).toEqual(dayTwoStart);
    const dayTwoBucket = f.docs.get(
      `emailObserverBudgets/${documentKey(emailObserverBudgetId('agent-1', 'google.owner-voice-sample', dayTwoStart))}`,
    );
    expect(dayTwoBucket).toMatchObject({ reservedCount: 1 });
  });
});
