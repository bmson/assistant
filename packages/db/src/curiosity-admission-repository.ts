import {
  agents,
  conversations,
  type Db,
  deviceTokens,
  lockPostgresPrivacyObservationFence,
  messages,
  notificationOutbox,
  notificationPrefs,
  proactivePings,
  suggestions,
  tasks,
} from '@assistant/db';
import type { CuriosityQuestionInput, CuriosityQuestionOutcome } from '@assistant/persistence';
import {
  curiosityDeliveryKey,
  curiosityMessageId,
  curiosityNudgeChannel,
  curiosityNudgePingId,
  insideQuietHours,
  notificationDeliveryKey,
  ownerLocalMidnightUtc,
  ownerLocalMinutes,
  pushDeviceKey,
} from '@assistant/persistence';
import { and, asc, count, eq, gte, isNull, sql } from 'drizzle-orm';
import { createPostgresNotificationsConversationRepository } from './notifications-conversation-repository.js';

const MAX_PUSH_DESTINATIONS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** One atomic owner admission; a failed message write leaves the gap unasked. */
export async function admitPostgresCuriosityQuestion(
  db: Db,
  input: CuriosityQuestionInput,
): Promise<CuriosityQuestionOutcome> {
  return db.transaction(async (tx) => {
    if ((await lockPostgresPrivacyObservationFence(tx, input.agentId)) !== input.observationFence)
      throw new Error('Privacy erasure changed during curiosity observation');
    if (input.taskId) {
      const [task] = await tx
        .select({ agentId: tasks.agentId })
        .from(tasks)
        .where(eq(tasks.id, input.taskId));
      if (task?.agentId !== input.agentId) throw new Error('Curiosity task is outside the owner');
    }
    const [owner] = await tx
      .select({ id: agents.id, name: agents.name, timezone: agents.timezone })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .limit(1);
    if (!owner) throw new Error('Curiosity owner is unavailable');
    const midnight = ownerLocalMidnightUtc(owner.timezone, input.now);
    // Serialize before checking the gap marker. Otherwise two workers can both
    // observe it absent, queue two sets of destination legs, then race to insert
    // the unique suggestion after one has already committed.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`assistant:ambient-ping:${owner.id}:${midnight.toISOString()}`}))`,
    );
    const id = curiosityMessageId(input.agentId, input.key);
    const [prior] = await tx
      .select({ id: suggestions.id })
      .from(suggestions)
      .where(and(eq(suggestions.agentId, input.agentId), eq(suggestions.sourceRef, input.key)))
      .limit(1);
    if (prior) {
      const [message] = await tx
        .select({ conversationId: messages.conversationId })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(eq(messages.id, id), eq(conversations.agentId, input.agentId)))
        .limit(1);
      return message
        ? { status: 'already-posted', messageId: id, conversationId: message.conversationId }
        : { status: 'legacy-unknown' };
    }
    // Capture and lock the exact registered destinations in this admission
    // transaction. A bounded overflow leaves the dashboard question intact
    // but abstains from creating an incomplete phone fan-out.
    const devices = await tx
      .select({ token: deviceTokens.token, environment: deviceTokens.environment })
      .from(deviceTokens)
      .where(and(eq(deviceTokens.agentId, input.agentId), isNull(deviceTokens.invalidatedAt)))
      .orderBy(asc(deviceTokens.lastSeenAt), asc(deviceTokens.id))
      .limit(MAX_PUSH_DESTINATIONS + 1)
      .for('update');
    const deviceOverflow = devices.length > MAX_PUSH_DESTINATIONS;
    const malformedDevices = devices.some(
      (device) =>
        !device.token || (device.environment !== 'sandbox' && device.environment !== 'production'),
    );
    const noticeKey = curiosityDeliveryKey(input.key);
    const policyChannel = curiosityNudgeChannel(noticeKey);
    const policyId = curiosityNudgePingId(input.agentId, policyChannel);
    const [priorPolicy] = await tx
      .select()
      .from(proactivePings)
      .where(eq(proactivePings.id, policyId))
      .limit(1);
    if (
      priorPolicy &&
      (priorPolicy.agentId !== input.agentId || priorPolicy.channel !== policyChannel)
    )
      throw new Error('Curiosity nudge reservation ownership mismatch');
    const [prefs] = await tx
      .select()
      .from(notificationPrefs)
      .where(eq(notificationPrefs.agentId, input.agentId))
      .limit(1)
      .for('update');
    let decision: { deliver: boolean; reason?: 'quiet-hours' | 'daily-cap' } = priorPolicy
      ? {
          deliver: priorPolicy.delivered,
          ...(!priorPolicy.delivered &&
          (priorPolicy.reason === 'quiet-hours' || priorPolicy.reason === 'daily-cap')
            ? { reason: priorPolicy.reason }
            : {}),
        }
      : { deliver: true };
    if (
      !priorPolicy &&
      prefs &&
      insideQuietHours(prefs, ownerLocalMinutes(owner.timezone, input.now))
    ) {
      decision = { deliver: false, reason: 'quiet-hours' };
    } else if (!priorPolicy && prefs?.ambientDailyCap != null) {
      const [used] = await tx
        .select({ value: count() })
        .from(proactivePings)
        .where(
          and(
            eq(proactivePings.agentId, input.agentId),
            eq(proactivePings.urgency, 'ambient'),
            eq(proactivePings.delivered, true),
            gte(proactivePings.createdAt, midnight),
          ),
        );
      if (Number(used?.value ?? 0) >= prefs.ambientDailyCap)
        decision = { deliver: false, reason: 'daily-cap' };
    }
    // The existing chat helpers run nested transactions on this same connection;
    // none can commit independently of this admission transaction.
    const scoped = tx as unknown as Db;
    const conversationId =
      (
        await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.agentId, input.agentId),
              eq(conversations.isPrimary, true),
              isNull(conversations.archivedAt),
            ),
          )
          .limit(1)
      )[0]?.id ??
      (await createPostgresNotificationsConversationRepository(scoped).getOrCreate(input.agentId));
    if (!priorPolicy)
      await tx.insert(proactivePings).values({
        id: policyId,
        agentId: input.agentId,
        urgency: 'ambient',
        channel: policyChannel,
        delivered: decision.deliver,
        reason: decision.reason ?? null,
        createdAt: input.now,
      });

    let pushAdmission: Extract<CuriosityQuestionOutcome, { status: 'posted' }>['pushAdmission'];
    if (deviceOverflow) {
      pushAdmission = { status: 'unknown', reason: 'device-list-overflow' };
    } else if (malformedDevices) {
      pushAdmission = { status: 'unknown', reason: 'malformed-device-registry' };
    } else if (!decision.deliver) {
      pushAdmission = { status: 'held', reason: decision.reason ?? 'daily-cap' };
    } else if (devices.length === 0) {
      pushAdmission = { status: 'skipped', reason: 'no-active-devices' };
    } else {
      const deliveryKey = notificationDeliveryKey('outbox', input.agentId, noticeKey);
      const payload = {
        title: owner.name,
        body: input.question.slice(0, 200),
        category: 'ASSISTANT_UPDATE',
        data: {
          route: 'chat',
          agentId: owner.id,
          ...(UUID.test(conversationId) ? { conversationId } : {}),
          ...(input.taskId && UUID.test(input.taskId) ? { taskId: input.taskId } : {}),
        },
      };
      const outboxRows = devices.map((device) => {
        const target = {
          deviceKey: pushDeviceKey(device.token),
          environment: device.environment,
        };
        const legKey = `push:${target.deviceKey}`;
        return {
          agentId: input.agentId,
          deliveryKey,
          legKey,
          adapter: 'push',
          status: 'pending',
          destination: target,
          payload,
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
      });
      await tx
        .insert(notificationOutbox)
        .values(outboxRows)
        .onConflictDoNothing({
          target: [
            notificationOutbox.agentId,
            notificationOutbox.deliveryKey,
            notificationOutbox.legKey,
          ],
        });
      const savedRows = await tx
        .select()
        .from(notificationOutbox)
        .where(
          and(
            eq(notificationOutbox.agentId, input.agentId),
            eq(notificationOutbox.deliveryKey, deliveryKey),
          ),
        );
      for (const expected of outboxRows) {
        const existing = savedRows.find((row) => row.legKey === expected.legKey);
        if (
          !existing ||
          existing.adapter !== 'push' ||
          canonical(existing.destination) !== canonical(expected.destination) ||
          canonical(existing.payload) !== canonical(expected.payload)
        )
          throw new Error('Curiosity push intent conflicts with a different frozen delivery');
      }
      pushAdmission = { status: 'queued', destinations: outboxRows.length };
    }
    await tx.insert(suggestions).values({
      agentId: input.agentId,
      sourceRef: input.key,
      summary: input.question.slice(0, 500),
      proposedAction: 'Answered in conversation; nothing to run.',
      origin: 'curiosity',
      status: 'dismissed',
      expiresAt: new Date(input.now.getTime() + 3650 * 86_400_000),
    });
    await tx.insert(messages).values({
      id,
      conversationId,
      taskId: input.taskId,
      role: 'assistant',
      origin: 'assistant',
      channelMessageId: `curiosity:${input.agentId}:${input.key}`,
      text: input.question,
      parts: [{ type: 'text', text: input.question }],
      createdAt: input.now,
    });
    await tx
      .update(conversations)
      .set({ updatedAt: input.now })
      .where(eq(conversations.id, conversationId));
    return { status: 'posted', conversationId, messageId: id, pushAdmission };
  });
}
