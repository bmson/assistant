import type {
  OwnerAmbientSnapshot,
  OwnerCommitment,
  OwnerContextRepository,
  OwnerLocationPing,
} from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { getAmbientBlock } from './ambient.js';
import { listOpenCommitments } from './commitments.js';
import { getOwnerCard } from './consolidation.js';
import { latestLocation } from './location.js';

const NOW = new Date('2026-09-12T12:00:00.000Z');

function ping(input: Partial<OwnerLocationPing> = {}): OwnerLocationPing {
  return {
    id: 'ping',
    agentId: 'owner-agent',
    lat: '64.146600',
    lng: '-21.942600',
    label: 'Reykjavík',
    accuracyM: 20,
    source: 'ios-app',
    timeZone: 'Atlantic/Reykjavik',
    capturedAt: new Date(NOW.getTime() - 5 * 60_000),
    createdAt: NOW,
    arrivalExpiresAt: null,
    ...input,
  };
}

function commitment(input: Partial<OwnerCommitment> & Pick<OwnerCommitment, 'id' | 'title'>) {
  const { id, title, ...fields } = input;
  return {
    id,
    agentId: 'owner-agent',
    conversationId: 'conversation',
    sourceMessageId: null,
    sourceTaskId: null,
    sourceOccurrenceKey: null,
    kind: 'promise',
    title,
    details: '',
    nextAction: '',
    status: 'open',
    dueAt: null,
    snoozedUntil: null,
    resolvedAt: null,
    resolution: null,
    confidence: '0.90',
    contentHash: input.id,
    reopenedFromId: null,
    reopenOperationId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...fields,
  } satisfies OwnerCommitment;
}

function repository(input: {
  card?: { agentId: string; content: string; compiledAt: Date };
  ambient?: OwnerAmbientSnapshot;
  locations?: OwnerLocationPing[];
  commitments?: OwnerCommitment[];
}): OwnerContextRepository {
  return {
    kind: 'owner-context-repository',
    async getOwnerCard(agentId) {
      return input.card?.agentId === agentId
        ? { content: input.card.content, compiledAt: input.card.compiledAt }
        : null;
    },
    async getAmbientSnapshot(agentId) {
      return input.ambient?.agentId === agentId ? input.ambient : null;
    },
    async getLatestLocation({ agentId, notBefore, notAfter, source }) {
      return (
        (input.locations ?? [])
          .filter(
            (row) =>
              row.agentId === agentId &&
              row.capturedAt >= notBefore &&
              row.capturedAt <= notAfter &&
              (source === undefined || row.source === source),
          )
          .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime())[0] ?? null
      );
    },
    async listOpenCommitments({ agentId, now, limit }) {
      return (input.commitments ?? [])
        .filter(
          (row) =>
            row.agentId === agentId &&
            (row.status === 'open' ||
              (row.status === 'snoozed' && row.snoozedUntil !== null && row.snoozedUntil < now)),
        )
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, limit);
    },
  };
}

describe('portable owner chat context', () => {
  it('reads owner cards only through the explicit agent scope', async () => {
    const repo = repository({
      card: { agentId: 'owner-agent', content: 'Private owner card', compiledAt: NOW },
    });
    await expect(getOwnerCard(repo, 'owner-agent')).resolves.toBe('Private owner card');
    await expect(getOwnerCard(repo, 'foreign-agent')).resolves.toBe('');
  });

  it('uses a fresh matching ambient snapshot and drops stale weather', async () => {
    const current = ping();
    const fresh = repository({
      locations: [current],
      ambient: {
        agentId: 'owner-agent',
        block:
          "Right now (ambient context — transient, not a stored fact):\nOwner's current location: cached.\nWeather there: clear, 12°C.",
        flags: { has_weather: true },
        sources: { location: { capturedAt: current.capturedAt.toISOString() } },
        computedAt: new Date(NOW.getTime() - 30 * 60_000),
      },
    });
    expect(await getAmbientBlock(fresh, 'owner-agent', { now: NOW })).toContain(
      'Weather there: clear',
    );
    expect(await getAmbientBlock(fresh, 'owner-agent', { now: NOW })).toContain('5 min ago');

    const freshSnapshot = await fresh.getAmbientSnapshot('owner-agent');
    if (!freshSnapshot) throw new Error('Fresh ambient fixture missing');
    const stale = repository({
      locations: [current],
      ambient: {
        ...freshSnapshot,
        computedAt: new Date(NOW.getTime() - 91 * 60_000),
      },
    });
    const fallback = await getAmbientBlock(stale, 'owner-agent', { now: NOW });
    expect(fallback).toContain('near Reykjavík');
    expect(fallback).not.toContain('Weather there');
  });

  it('enforces retention and never falls back past a newer unusable observation', async () => {
    const old = ping({ id: 'old', capturedAt: new Date(NOW.getTime() - 20 * 60_000) });
    const uncertain = ping({ id: 'new', accuracyM: 5000 });
    const repo = repository({ locations: [old, uncertain] });
    await expect(latestLocation(repo, 'owner-agent', 0.001, undefined, NOW)).resolves.toBeNull();
    await expect(latestLocation(repo, 'owner-agent', 1, undefined, NOW)).resolves.toBeNull();
    await expect(getAmbientBlock(repo, 'foreign-agent', { now: NOW })).resolves.toBeUndefined();
  });

  it('filters commitment state and snoozes, then preserves relevance ranking', async () => {
    const rows = [
      commitment({
        id: 'weak',
        title: 'Send vendor update',
        updatedAt: new Date('2026-09-12T11:59:00Z'),
      }),
      commitment({
        id: 'strong',
        title: 'Book Iceland flights',
        details: 'Compare Iceland airline points options',
        updatedAt: new Date('2026-09-12T11:00:00Z'),
      }),
      commitment({
        id: 'expired-snooze',
        title: 'Review Iceland hotel',
        status: 'snoozed',
        snoozedUntil: new Date('2026-09-12T10:00:00Z'),
        updatedAt: new Date('2026-09-12T10:00:00Z'),
      }),
      commitment({
        id: 'future-snooze',
        title: 'Iceland packing list',
        status: 'snoozed',
        snoozedUntil: new Date('2026-09-13T10:00:00Z'),
      }),
      commitment({ id: 'resolved', title: 'Iceland insurance', status: 'resolved' }),
      commitment({ id: 'foreign', agentId: 'foreign-agent', title: 'Iceland passport' }),
    ];
    const ranked = await listOpenCommitments(repository({ commitments: rows }), {
      agentId: 'owner-agent',
      query: 'Iceland airline',
      limit: 3,
      now: NOW,
    });
    expect(ranked.map((row) => row.id)).toEqual(['strong', 'expired-snooze']);
  });
});
