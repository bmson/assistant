import { enqueueTask, InboundEventSchema } from '@assistant/core';
import type { WatchRow } from '@assistant/db';
import type {
  MessageRepository,
  TaskRepository,
  WatchFireEffect,
  WatchRepository,
} from '@assistant/persistence';
import { notificationDeliveryKey } from '@assistant/persistence';
import type { OwnerNotifier } from '../platform.js';

/** Durable watch work is recorded before any destination is touched. */
export interface WatchFireDeps {
  watches: WatchRepository;
  messages: MessageRepository;
  tasks?: TaskRepository;
  notifyOwner: OwnerNotifier['notifyOwner'];
}

const EFFECT_LEASE_MS = 60_000;

export interface WatchFireDeliveryResult {
  recorded: boolean;
  fireId: string | null;
  legs: Array<{ kind: string; status: string }>;
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function deliverEffect(
  deps: WatchFireDeps,
  effect: WatchFireEffect,
): Promise<'delivered' | 'failed' | 'unknown' | 'skipped' | void> {
  const payload = payloadRecord(effect.payload);
  const now = new Date();
  if (effect.kind === 'dashboard_notice') {
    if (
      typeof payload.conversationId !== 'string' ||
      typeof payload.text !== 'string' ||
      typeof payload.channelMessageId !== 'string'
    )
      throw new Error('watch notice effect is malformed');
    await deps.messages.append({
      conversationId: payload.conversationId,
      role: 'assistant',
      origin: 'assistant',
      parts: [{ type: 'text', text: payload.text }],
      text: payload.text,
      channelMessageId: payload.channelMessageId,
    });
    await deps.watches.finishFireEffect({
      agentId: effect.agentId,
      effectId: effect.id,
      status: 'delivered',
      result: { channelMessageId: payload.channelMessageId },
      now,
    });
    return 'delivered';
  }

  if (effect.kind === 'suggestion_enqueue') {
    if (
      typeof payload.watchId !== 'string' ||
      typeof payload.triggerRef !== 'string' ||
      typeof payload.externalEventId !== 'string'
    )
      throw new Error('watch suggest enqueue effect is malformed');
    if (!deps.tasks) throw new Error('watch suggest task repository is unavailable');
    const event = InboundEventSchema.parse({
      source: 'internal',
      externalEventId: payload.externalEventId,
      agentId: effect.agentId,
      trust: 'assistant',
      payload: { job: 'watch.suggest', watchId: payload.watchId, triggerRef: payload.triggerRef },
    });
    await enqueueTask(deps.tasks, { event, type: 'adhoc', budgetUsdLimit: '0.06', maxSteps: 2 });
    await deps.watches.finishFireEffect({
      agentId: effect.agentId,
      effectId: effect.id,
      status: 'delivered',
      result: { externalEventId: payload.externalEventId },
      now,
    });
    return 'delivered';
  }

  if (effect.kind === 'suggestion_message') {
    if (typeof payload.watchId !== 'string' || typeof payload.triggerRef !== 'string')
      throw new Error('watch suggestion message effect is malformed');
    const prepared = await deps.watches.getPreparedSuggestion({
      agentId: effect.agentId,
      watchId: payload.watchId,
      triggerRef: payload.triggerRef,
    });
    if (!prepared || prepared.suggestion.status !== 'pending') {
      await deps.watches.finishFireEffect({
        agentId: effect.agentId,
        effectId: effect.id,
        status: 'skipped',
        result: { reason: 'suggestion is no longer pending' },
        now,
      });
      return 'skipped';
    }
    const currentPayload = payloadRecord(prepared.effect.payload);
    if (
      typeof currentPayload.conversationId !== 'string' ||
      typeof currentPayload.text !== 'string' ||
      typeof currentPayload.channelMessageId !== 'string'
    )
      throw new Error('watch suggestion message payload is malformed');
    await deps.messages.append({
      conversationId: currentPayload.conversationId,
      role: 'assistant',
      origin: 'assistant',
      parts: [
        { type: 'text', text: currentPayload.text },
        {
          type: 'suggestion',
          suggestionId: prepared.suggestion.id,
          summary: prepared.suggestion.summary,
          proposedAction: prepared.suggestion.proposedAction,
        },
      ],
      text: currentPayload.text,
      channelMessageId: currentPayload.channelMessageId,
    });
    await deps.watches.finishFireEffect({
      agentId: effect.agentId,
      effectId: effect.id,
      status: 'delivered',
      result: { channelMessageId: currentPayload.channelMessageId },
      now,
    });
    return 'delivered';
  }

  if (effect.kind === 'owner_notification') {
    if (typeof payload.text !== 'string') throw new Error('watch notification effect is malformed');
    let delivery: Awaited<ReturnType<typeof deps.notifyOwner>>;
    try {
      delivery = await deps.notifyOwner({
        deliveryKey: notificationDeliveryKey('watch-owner-notice', effect.id),
        text: payload.text,
        urgency: payload.urgency === 'ambient' ? 'ambient' : undefined,
      });
    } catch (error) {
      // The provider may have accepted before a timeout. Never turn an
      // ambiguous send into an automatic duplicate.
      await deps.watches.finishFireEffect({
        agentId: effect.agentId,
        effectId: effect.id,
        status: 'unknown',
        result: { reason: 'notification outcome is unknown' },
        now: new Date(),
      });
      console.error('watch owner notification outcome unknown', error);
      throw error;
    }
    const legs = delivery && 'legs' in delivery ? delivery.legs : [];
    const status = !delivery
      ? 'unknown'
      : legs.some((leg) => leg.status === 'unknown')
        ? 'unknown'
        : legs.some((leg) => leg.status === 'delivered')
          ? 'delivered'
          : legs.some((leg) => leg.status === 'failed')
            ? 'failed'
            : legs.some((leg) => leg.status === 'held')
              ? 'failed'
              : 'skipped';
    await deps.watches.finishFireEffect({
      agentId: effect.agentId,
      effectId: effect.id,
      status,
      result: { legs },
      now: new Date(),
    });
    return status;
  }
}

/** Replay each fire's independent effects; each leg has its own persisted state. */
export async function drainWatchFireEffects(
  deps: WatchFireDeps,
  agentId: string,
  fireId?: string,
  now = new Date(),
): Promise<{ delivered: number; unknown: number; failed: number }> {
  await deps.watches.recoverExpiredFireEffectClaims(agentId, now);
  const effects = fireId
    ? await deps.watches.fireEffectsForFire(agentId, fireId)
    : await deps.watches.pendingFireEffects(agentId, 100);
  const result = { delivered: 0, unknown: 0, failed: 0 };
  for (const effect of effects) {
    if (effect.status !== 'pending' && effect.status !== 'failed') continue;
    const claimed = await deps.watches.claimFireEffect({
      agentId,
      effectId: effect.id,
      now,
      leaseMs: EFFECT_LEASE_MS,
    });
    if (!claimed) continue;
    try {
      const status = await deliverEffect(deps, effect);
      if (status === 'unknown') result.unknown += 1;
      else if (status === 'failed') result.failed += 1;
      else result.delivered += 1;
    } catch (error) {
      if (effect.kind === 'owner_notification') {
        // The request threw before a typed receipt was available.
        result.unknown += 1;
      } else {
        await deps.watches.finishFireEffect({
          agentId,
          effectId: effect.id,
          status: 'failed',
          result: {
            reason: error instanceof Error ? error.message.slice(0, 300) : 'delivery failed',
          },
          now: new Date(),
        });
        result.failed += 1;
      }
    }
  }
  return result;
}

/** Record one watch firing; durable effects are drained independently. */
export async function recordWatchFire(
  deps: WatchFireDeps,
  watch: WatchRow,
  fire: {
    triggerRef: string;
    text: string;
    channelMessageId: string;
    excerpt?: string;
    state?: unknown;
    expectedNextPollAt?: Date;
  },
  now: Date,
): Promise<WatchFireDeliveryResult> {
  const result = await deps.watches.recordFire({
    watchId: watch.id,
    agentId: watch.agentId,
    triggerRef: fire.triggerRef,
    summary: fire.text,
    excerpt: fire.excerpt ?? '',
    now,
    ...(fire.state !== undefined ? { state: fire.state } : {}),
    ...(fire.expectedNextPollAt ? { expectedNextPollAt: fire.expectedNextPollAt } : {}),
  });
  if (result.fireId) await drainWatchFireEffects(deps, watch.agentId, result.fireId, now);
  const effects = result.fireId
    ? await deps.watches.fireEffectsForFire(watch.agentId, result.fireId)
    : [];
  return {
    recorded: result.recorded,
    fireId: result.fireId ?? null,
    legs: effects.map((effect) => ({ kind: effect.kind, status: effect.status })),
  };
}
