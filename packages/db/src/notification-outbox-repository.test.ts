import { randomUUID } from 'node:crypto';
import { notificationDashboardMessageId } from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDb } from './client.js';
import { createPostgresEmailSyncRepository } from './email-sync-repository.js';
import { createPostgresMessageRepository } from './message-repository.js';
import { createPostgresNotificationOutboxRepository } from './notification-outbox-repository.js';
import {
  agents,
  conversations,
  emailObserverWork,
  messages,
  notificationOutbox,
} from './schema.js';

it('leases each owner delivery leg once and never retries an ambiguous expired send', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const ownerId = randomUUID();
  const now = new Date();
  let currentTime = now;
  const repository = createPostgresNotificationOutboxRepository(db, () => currentTime);
  try {
    await db.insert(agents).values({
      id: ownerId,
      name: 'Outbox test',
      email: `${ownerId}@example.test`,
      workspacePrefix: `outbox-${ownerId}`,
    });
    const preparation = {
      agentId: ownerId,
      deliveryKey: 'producer:stable-key',
      legKey: 'push:device-a',
      adapter: 'push',
      destination: { deviceKey: 'opaque-device-key' },
      payload: { body: 'Frozen owner message' },
      now,
    };
    const [prepared, replay] = await Promise.all([
      repository.prepare(preparation),
      repository.prepare(preparation),
    ]);
    expect(prepared.id).toBe(replay.id);
    const claims = await Promise.all([
      repository.claim({ agentId: ownerId, legId: prepared.id, now, leaseMs: 30_000 }),
      repository.claim({ agentId: ownerId, legId: prepared.id, now, leaseMs: 30_000 }),
    ]);
    const claimed = claims.filter((value) => value !== null);
    expect(claimed).toHaveLength(1);
    const claim = claimed[0];
    if (!claim?.leaseToken) throw new Error('Outbox claim omitted its lease token');
    expect(
      await repository.complete({
        agentId: ownerId,
        legId: claim.id,
        leaseToken: claim.leaseToken,
        status: 'failed',
        retryable: true,
        retryAt: new Date(now.getTime() + 5_000),
        now,
      }),
    ).toBe(true);
    expect(
      await repository.claim({
        agentId: ownerId,
        legId: claim.id,
        now: new Date(now.getTime() + 4_999),
        leaseMs: 30_000,
      }),
    ).toBeNull();
    currentTime = new Date(now.getTime() + 5_000);
    const retried = await repository.claim({
      agentId: ownerId,
      legId: claim.id,
      now: new Date(now.getTime() + 5_000),
      leaseMs: 30_000,
    });
    if (!retried?.leaseToken) throw new Error('Retryable delivery did not become claimable');
    expect(retried.attempts).toBe(2);
    expect(
      await repository.complete({
        agentId: ownerId,
        legId: retried.id,
        leaseToken: retried.leaseToken,
        status: 'unknown',
        now: new Date(now.getTime() + 5_000),
      }),
    ).toBe(true);
    expect(
      await repository.claim({ agentId: ownerId, legId: prepared.id, now, leaseMs: 30_000 }),
    ).toBeNull();

    currentTime = now;
    const abandoned = await repository.prepare({
      ...preparation,
      deliveryKey: 'producer:abandoned',
      legKey: 'dashboard',
    });
    const abandonedClaim = await repository.claim({
      agentId: ownerId,
      legId: abandoned.id,
      now,
      leaseMs: 1_000,
    });
    expect(abandonedClaim).not.toBeNull();
    currentTime = new Date(now.getTime() + 1_001);
    expect(await repository.recoverExpired(ownerId, currentTime)).toBe(1);
    expect(
      await repository.claim({ agentId: ownerId, legId: abandoned.id, now, leaseMs: 10_000 }),
    ).toBeNull();
    const rows = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.agentId, ownerId));
    expect(rows.map((row) => row.status).sort()).toEqual(['unknown', 'unknown']);
  } finally {
    await db.delete(agents).where(eq(agents.id, ownerId));
    await db.$client.end();
  }
});

it('fences observer notice prepare and permits later claim only under the original privacy generation', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const ownerId = randomUUID();
  const now = new Date();
  const currentTime = now;
  const repository = createPostgresNotificationOutboxRepository(db, () => currentTime);
  const makeFence = (id: string) => ({
    id,
    agentId: ownerId,
    claimToken: `token-${id}`,
    claimGeneration: 1,
    expectedPrivacyGeneration: null,
  });
  try {
    await db.insert(agents).values({
      id: ownerId,
      name: 'Observer fence test',
      email: `${ownerId}@example.test`,
      workspacePrefix: `observer-fence-${ownerId}`,
    });
    for (const id of [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]) {
      const fence = makeFence(id);
      await db.insert(emailObserverWork).values({
        id,
        agentId: ownerId,
        sourceKey: `source-${id}`,
        channelMessageId: `gmail:${id}`,
        sourceKind: 'message',
        observerKey: 'google.email-card',
        observerVersion: 1,
        workClass: 'paid_ambiguous',
        status: 'prepared',
        claimToken: fence.claimToken,
        claimGeneration: 1,
        privacyGeneration: null,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
      });
      await repository.prepare({
        agentId: ownerId,
        deliveryKey: `delivery-${id}`,
        legKey: 'dashboard',
        adapter: 'dashboard',
        destination: { conversationId: 'conversation-1' },
        payload: { text: 'Saved card', extraParts: [] },
        now,
        emailObserverEffectFence: fence,
      });
      if (id.startsWith('111')) {
        await db
          .update(emailObserverWork)
          .set({ status: 'complete', claimToken: null, leaseExpiresAt: null })
          .where(eq(emailObserverWork.id, id));
        const claimed = await repository.claim({
          agentId: ownerId,
          legId: (await repository.pending(ownerId, 10, now))[0]!.id,
          now: new Date(now.getTime() + 120_000),
          leaseMs: 30_000,
        });
        expect(claimed?.status).toBe('sending');
        expect(claimed?.producerWorkId).toBe(id);
      } else {
        await db
          .update(emailObserverWork)
          .set({
            status: 'skipped_erased',
            claimToken: null,
            leaseExpiresAt: null,
            privacyGeneration: 'privacy-next',
          })
          .where(eq(emailObserverWork.id, id));
        const [leg] = await db
          .select()
          .from(notificationOutbox)
          .where(eq(notificationOutbox.deliveryKey, `delivery-${id}`));
        const rejected = await repository.claim({
          agentId: ownerId,
          legId: leg!.id,
          now: new Date(now.getTime() + 1),
          leaseMs: 30_000,
        });
        expect(rejected?.status).toBe('skipped');
        expect(rejected?.destination).toBeNull();
        expect(rejected?.payload).toBeNull();
        expect(rejected?.attempts).toBe(0);
      }
    }
  } finally {
    await db.delete(agents).where(eq(agents.id, ownerId));
    await db.$client.end();
  }
});

it('uses fresh time after lock waits and safely replays dashboard append after a crash', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const ownerId = randomUUID();
  const conversationId = randomUUID();
  let currentTime = new Date();
  const repository = createPostgresNotificationOutboxRepository(db, () => currentTime);
  let releaseWorkLock!: () => void;
  let markWorkLocked!: () => void;
  const workLocked = new Promise<void>((resolve) => {
    markWorkLocked = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseWorkLock = resolve;
  });
  let blocker: Promise<unknown> | undefined;
  try {
    await db.insert(agents).values({
      id: ownerId,
      name: 'Notice append owner',
      email: `${ownerId}@example.test`,
      workspacePrefix: `notice-append-${ownerId}`,
    });
    await db.insert(conversations).values({
      id: conversationId,
      agentId: ownerId,
      channel: 'chat',
      trust: 'assistant',
      title: 'Primary',
    });
    const staleWorkId = randomUUID();
    const staleFence = {
      id: staleWorkId,
      agentId: ownerId,
      claimToken: 'stale-claim',
      claimGeneration: 2,
      expectedPrivacyGeneration: null,
    };
    await db.insert(emailObserverWork).values({
      id: staleWorkId,
      agentId: ownerId,
      sourceKey: `source-${staleWorkId}`,
      channelMessageId: `gmail:${staleWorkId}`,
      sourceKind: 'message',
      observerKey: 'google.email-card',
      observerVersion: 1,
      workClass: 'paid_ambiguous',
      status: 'prepared',
      claimToken: staleFence.claimToken,
      claimGeneration: staleFence.claimGeneration,
      privacyGeneration: null,
      leaseExpiresAt: new Date(currentTime.getTime() + 500),
    });
    blocker = db.transaction(async (tx) => {
      await tx
        .select({ id: emailObserverWork.id })
        .from(emailObserverWork)
        .where(eq(emailObserverWork.id, staleWorkId))
        .for('update')
        .limit(1);
      markWorkLocked();
      await blocked;
    });
    await workLocked;
    const stalePrepare = repository.prepare({
      agentId: ownerId,
      deliveryKey: 'stale-claim',
      legKey: 'dashboard',
      adapter: 'dashboard',
      destination: { conversationId },
      payload: { text: 'Saved card', extraParts: [] },
      now: currentTime,
      emailObserverEffectFence: staleFence,
    });
    currentTime = new Date(currentTime.getTime() + 600);
    releaseWorkLock();
    await expect(stalePrepare).rejects.toThrow('fence is stale');
    await blocker;
    blocker = undefined;

    const workId = randomUUID();
    const fence = {
      id: workId,
      agentId: ownerId,
      claimToken: 'claim-live',
      claimGeneration: 2,
      expectedPrivacyGeneration: null,
    };
    await db.insert(emailObserverWork).values({
      id: workId,
      agentId: ownerId,
      sourceKey: `source-${workId}`,
      channelMessageId: `gmail:${workId}`,
      sourceKind: 'message',
      observerKey: 'google.email-card',
      observerVersion: 1,
      workClass: 'paid_ambiguous',
      status: 'prepared',
      claimToken: fence.claimToken,
      claimGeneration: fence.claimGeneration,
      privacyGeneration: null,
      leaseExpiresAt: new Date(currentTime.getTime() + 60_000),
    });
    const availableAt = new Date(currentTime.getTime() + 500);
    const prepared = await repository.prepare({
      agentId: ownerId,
      deliveryKey: 'dashboard-crash-replay',
      legKey: 'dashboard',
      adapter: 'dashboard',
      destination: { conversationId },
      payload: { text: 'Saved card', extraParts: [] },
      now: availableAt,
      emailObserverEffectFence: fence,
    });
    let releaseOutboxLock!: () => void;
    let markOutboxLocked!: () => void;
    const outboxLocked = new Promise<void>((resolve) => {
      markOutboxLocked = resolve;
    });
    const outboxBlocked = new Promise<void>((resolve) => {
      releaseOutboxLock = resolve;
    });
    const outboxBlocker = db.transaction(async (tx) => {
      await tx
        .select({ id: notificationOutbox.id })
        .from(notificationOutbox)
        .where(eq(notificationOutbox.id, prepared.id))
        .for('update')
        .limit(1);
      markOutboxLocked();
      await outboxBlocked;
    });
    await outboxLocked;
    const delayedClaim = repository.claim({
      agentId: ownerId,
      legId: prepared.id,
      now: currentTime,
      leaseMs: 1_000,
    });
    currentTime = new Date(availableAt.getTime() + 1);
    releaseOutboxLock();
    const firstClaim = await delayedClaim;
    await outboxBlocker;
    expect(firstClaim?.status).toBe('sending');
    if (!firstClaim?.leaseToken) throw new Error('Dashboard claim omitted lease token');

    const channelMessageId = notificationDashboardMessageId(
      ownerId,
      prepared.deliveryKey,
      prepared.legKey,
    );
    const append = createPostgresMessageRepository(db);
    const fencedInput = {
      conversationId,
      role: 'assistant' as const,
      origin: 'assistant' as const,
      parts: [{ type: 'text', text: 'Saved card' }],
      text: 'Saved card',
      channelMessageId,
      notificationOutboxFence: {
        agentId: ownerId,
        legId: prepared.id,
        leaseToken: firstClaim.leaseToken,
        producerWorkId: workId,
        producerPrivacyGeneration: null,
      },
    };
    await expect(
      append.append({
        ...fencedInput,
        text: 'Tampered',
        parts: [{ type: 'text', text: 'Tampered' }],
      }),
    ).rejects.toThrow('fence');
    expect(await append.append(fencedInput)).toBeDefined();
    expect(await append.append(fencedInput)).toBeUndefined();

    // Simulate process death after the append committed but before the outbox receipt.
    currentTime = new Date(firstClaim.leaseUntil!.getTime() + 1);
    expect(await repository.recoverExpired(ownerId, currentTime)).toBe(1);
    const replayClaim = await repository.claim({
      agentId: ownerId,
      legId: prepared.id,
      now: new Date(0),
      leaseMs: 60_000,
    });
    if (!replayClaim?.leaseToken)
      throw new Error('Expired dashboard append did not become safely replayable');
    const replayInput = {
      ...fencedInput,
      notificationOutboxFence: {
        ...fencedInput.notificationOutboxFence,
        leaseToken: replayClaim.leaseToken,
      },
    };
    expect(await append.append(replayInput)).toBeUndefined();
    expect(
      await repository.complete({
        agentId: ownerId,
        legId: prepared.id,
        leaseToken: firstClaim.leaseToken,
        status: 'delivered',
        now: currentTime,
      }),
    ).toBe(false);
    expect(
      await repository.complete({
        agentId: ownerId,
        legId: replayClaim.id,
        leaseToken: replayClaim.leaseToken,
        status: 'delivered',
        now: currentTime,
      }),
    ).toBe(true);
    expect(
      await db.select().from(messages).where(eq(messages.channelMessageId, channelMessageId)),
    ).toHaveLength(1);

    await createPostgresEmailSyncRepository(db, ownerId).eraseEmailObserverData(
      ownerId,
      'privacy-next',
      currentTime,
    );
    expect(
      await db.select().from(messages).where(eq(messages.channelMessageId, channelMessageId)),
    ).toHaveLength(0);
    const [scrubbed] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, prepared.id));
    expect(scrubbed?.payload).toBeNull();
    expect(scrubbed?.destination).toBeNull();
  } finally {
    if (blocker) releaseWorkLock();
    if (blocker) await blocker.catch(() => undefined);
    await db.delete(messages).where(eq(messages.conversationId, conversationId));
    await db.delete(conversations).where(eq(conversations.id, conversationId));
    await db.delete(agents).where(eq(agents.id, ownerId));
    await db.$client.end();
  }
});

it('keeps a proven provider receipt recordable after wall-clock expiry until recovery supersedes its claim', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url);
  const ownerId = randomUUID();
  let currentTime = new Date();
  const repository = createPostgresNotificationOutboxRepository(db, () => currentTime);
  try {
    await db.insert(agents).values({
      id: ownerId,
      name: 'Receipt owner',
      email: `${ownerId}@example.test`,
      workspacePrefix: `receipt-${ownerId}`,
    });
    const prepared = await repository.prepare({
      agentId: ownerId,
      deliveryKey: 'known-provider-receipt',
      legKey: 'sms:device-a',
      adapter: 'sms',
      destination: { numberKey: 'opaque' },
      payload: { body: 'Hello' },
      now: currentTime,
    });
    const claim = await repository.claim({
      agentId: ownerId,
      legId: prepared.id,
      now: currentTime,
      leaseMs: 1_000,
    });
    if (!claim?.leaseToken) throw new Error('Provider claim omitted lease token');
    currentTime = new Date(currentTime.getTime() + 1_001);
    expect(
      await repository.complete({
        agentId: ownerId,
        legId: claim.id,
        leaseToken: claim.leaseToken,
        status: 'delivered',
        providerMessageId: 'provider-accepted',
        now: currentTime,
      }),
    ).toBe(true);
    const second = await repository.prepare({
      agentId: ownerId,
      deliveryKey: 'recovered-provider-receipt',
      legKey: 'sms:device-a',
      adapter: 'sms',
      destination: { numberKey: 'opaque' },
      payload: { body: 'Hello' },
      now: currentTime,
    });
    const secondClaim = await repository.claim({
      agentId: ownerId,
      legId: second.id,
      now: currentTime,
      leaseMs: 1_000,
    });
    if (!secondClaim?.leaseToken) throw new Error('Second provider claim omitted lease token');
    currentTime = new Date(currentTime.getTime() + 1_001);
    expect(await repository.recoverExpired(ownerId, currentTime)).toBe(1);
    expect(
      await repository.complete({
        agentId: ownerId,
        legId: second.id,
        leaseToken: secondClaim.leaseToken,
        status: 'delivered',
        providerMessageId: 'late-provider-accepted',
        now: currentTime,
      }),
    ).toBe(false);
  } finally {
    await db.delete(agents).where(eq(agents.id, ownerId));
    await db.$client.end();
  }
});
