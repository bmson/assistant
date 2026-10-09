import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDb } from './client.js';
import { agents, channelBindings, conversations, costEvents, tasks, toolCalls } from './schema.js';
import { createPostgresSmsChannelRepository } from './sms-channel-repository.js';
import { assertAllocatedTestTarget } from './test-target.js';

function allocatedTestDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  assertAllocatedTestTarget({
    databaseUrl: url,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
    kind: 'standard',
  });
  if (!url) throw new Error('Missing allocated test database URL');
  return url;
}

it('converges concurrent first SMS peers on one owner conversation and a return route', async () => {
  const db = createDb(allocatedTestDatabaseUrl());
  const ownerId = randomUUID(),
    foreignId = randomUUID();
  const peer = `+sms-${randomUUID()}`;
  try {
    await db.insert(agents).values(
      [ownerId, foreignId].map((id) => ({
        id,
        name: 'SMS race',
        email: `${id}@example.test`,
        workspacePrefix: `sms-${id}`,
      })),
    );
    const repository = createPostgresSmsChannelRepository(db);
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => repository.conversationForPeer(ownerId, peer, 'owner')),
    );
    expect(new Set(ids).size).toBe(1);
    const id = ids[0];
    if (!id) throw new Error('SMS conversation was not created');
    expect(
      await db.select().from(conversations).where(eq(conversations.agentId, ownerId)),
    ).toHaveLength(1);
    expect(
      await db.select().from(channelBindings).where(eq(channelBindings.externalId, peer)),
    ).toEqual([expect.objectContaining({ conversationId: id })]);
    expect(await repository.finalDestination(id)).toEqual({
      channel: 'sms',
      trust: 'owner',
      externalId: peer,
    });
    await expect(repository.conversationForPeer(foreignId, peer, 'unknown')).rejects.toThrow(
      'owner scope',
    );
    expect(
      await db.select().from(conversations).where(eq(conversations.agentId, foreignId)),
    ).toEqual([]);
  } finally {
    try {
      await db.delete(channelBindings).where(eq(channelBindings.externalId, peer));
      await db.delete(conversations).where(inArray(conversations.agentId, [ownerId, foreignId]));
      await db.delete(agents).where(inArray(agents.id, [ownerId, foreignId]));
    } finally {
      await db.$client.end();
    }
  }
});

it('read-repairs delayed Twilio usage on the same cost event with a lease and replay fence', async () => {
  const db = createDb(allocatedTestDatabaseUrl());
  const eventId = randomUUID();
  const taskId = randomUUID();
  const toolCallId = randomUUID();
  const now = new Date('2026-10-07T12:00:00.000Z');
  const repository = createPostgresSmsChannelRepository(db);
  try {
    const [owner] = await db.select({ id: agents.id }).from(agents).limit(1);
    if (!owner) throw new Error('Seed the test database');
    await db.insert(tasks).values({
      id: taskId,
      agentId: owner.id,
      type: 'chat_turn',
      trust: 'owner',
      spentUsd: '0.015800',
    });
    await db.insert(toolCalls).values({
      id: toolCallId,
      taskId,
      step: 1,
      toolName: 'sms.send',
      risk: 'autonomous',
      status: 'succeeded',
      result: { sid: 'SM1234567890abcdef', smsAccounting: { estimatedSegments: 2 } },
    });
    await db.insert(costEvents).values({
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
      taskId,
      toolCallId,
      quantity: '2',
      unit: 'segment',
      unitPriceUsd: '0.00790000',
      usd: '0.015800',
      description: 'test SMS',
    });

    const concurrent = await Promise.all([
      repository.claimSmsUsageReconciliation(now, 10),
      repository.claimSmsUsageReconciliation(now, 10),
    ]);
    const claims = concurrent.flat();
    expect(claims).toHaveLength(1);
    const first = claims[0];
    if (!first) throw new Error('SMS usage claim was not created');
    expect(first.providerMessageId).toBe('SM1234567890abcdef');
    expect(
      await repository.settleSmsUsageReconciliation(first, {
        kind: 'retry',
        nextAttemptAt: new Date(now.getTime() + 60_000),
        error: 'usage fields not populated yet',
      }),
    ).toBe(true);
    expect(await repository.claimSmsUsageReconciliation(now, 10)).toEqual([]);

    const retryAt = new Date(now.getTime() + 60_001);
    const [second] = await repository.claimSmsUsageReconciliation(retryAt, 10);
    if (!second) throw new Error('SMS usage retry claim was not created');
    expect(second?.attempts).toBe(2);
    expect(second?.eventId).toBe(eventId);
    const beforeInvalidReplacement = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.id, eventId));
    const [beforeInvalidTask] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    await expect(
      repository.settleSmsUsageReconciliation(second, {
        kind: 'complete',
        billedSegments: 3,
        priceUsd: 10_000,
      }),
    ).rejects.toThrow('numeric(10,6)');
    const [afterInvalidReplacement] = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.id, eventId));
    const [afterInvalidTask] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(afterInvalidReplacement?.usd).toBe(beforeInvalidReplacement[0]?.usd);
    expect(afterInvalidReplacement?.evidence).toEqual(beforeInvalidReplacement[0]?.evidence);
    expect(afterInvalidTask?.spentUsd).toBe(beforeInvalidTask?.spentUsd);
    expect(afterInvalidReplacement?.evidence.smsUsageReconciliation?.claimToken).toBe(
      second.claimToken,
    );

    // A negative correction may not be clamped to zero or partially settle the event.
    const [claimedEvent] = await db.select().from(costEvents).where(eq(costEvents.id, eventId));
    const [claimedCall] = await db.select().from(toolCalls).where(eq(toolCalls.id, toolCallId));
    await db.update(tasks).set({ spentUsd: '0.000000' }).where(eq(tasks.id, taskId));
    const underflowTask = await db.select().from(tasks).where(eq(tasks.id, taskId));
    await expect(
      repository.settleSmsUsageReconciliation(second, {
        kind: 'complete',
        billedSegments: 1,
        priceUsd: 0,
      }),
    ).rejects.toThrow();
    expect(await db.select().from(costEvents).where(eq(costEvents.id, eventId))).toEqual([
      claimedEvent,
    ]);
    expect(await db.select().from(toolCalls).where(eq(toolCalls.id, toolCallId))).toEqual([
      claimedCall,
    ]);
    expect(await db.select().from(tasks).where(eq(tasks.id, taskId))).toEqual(underflowTask);

    // A positive correction beyond the task row's numeric(10,6) ceiling must
    // also fail before event/evidence/accounting changes and leave the claim usable.
    await db.update(tasks).set({ spentUsd: '9999.999999' }).where(eq(tasks.id, taskId));
    const overflowTask = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const [overflowEvent] = await db.select().from(costEvents).where(eq(costEvents.id, eventId));
    const [overflowCall] = await db.select().from(toolCalls).where(eq(toolCalls.id, toolCallId));
    await expect(
      repository.settleSmsUsageReconciliation(second, {
        kind: 'complete',
        billedSegments: 3,
        priceUsd: 0.0237,
      }),
    ).rejects.toThrow();
    expect(await db.select().from(costEvents).where(eq(costEvents.id, eventId))).toEqual([
      overflowEvent,
    ]);
    expect(await db.select().from(toolCalls).where(eq(toolCalls.id, toolCallId))).toEqual([
      overflowCall,
    ]);
    expect(await db.select().from(tasks).where(eq(tasks.id, taskId))).toEqual(overflowTask);
    await db.update(tasks).set({ spentUsd: '0.015800' }).where(eq(tasks.id, taskId));

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

    const [updated] = await db.select().from(costEvents).where(eq(costEvents.id, eventId));
    expect(updated).toMatchObject({
      id: eventId,
      quantity: '3.0000',
      unit: 'segment',
      usd: '0.023700',
      evidence: {
        basis: 'provider_reported',
        sms: { billedSegments: 3, providerPriceUsd: 0.0237 },
        smsUsageReconciliation: { status: 'complete', attempts: 2 },
      },
    });
    const [updatedTask] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const [updatedCall] = await db.select().from(toolCalls).where(eq(toolCalls.id, toolCallId));
    expect(updatedTask?.spentUsd).toBe('0.023700');
    expect(updatedCall?.result).toMatchObject({
      sid: 'SM1234567890abcdef',
      smsAccounting: { billedSegments: 3, providerPriceUsd: 0.0237 },
    });
  } finally {
    try {
      await db.delete(costEvents).where(eq(costEvents.id, eventId));
      await db.delete(toolCalls).where(eq(toolCalls.id, toolCallId));
      await db.delete(tasks).where(eq(tasks.id, taskId));
    } finally {
      await db.$client.end();
    }
  }
});
