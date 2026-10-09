import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreLocationPingRepository } from './location-pings.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore location pings', () => {
  let store: InstallationStore;
  let repository: FirestoreLocationPingRepository;
  const agentId = randomUUID();
  const at = (iso: string) => new Date(iso);

  beforeEach(async () => {
    store = emulatorStore(() => at('2026-09-24T12:00:00.000Z'));
    repository = new FirestoreLocationPingRepository(store);
    await store.doc('agents', agentId).set({ id: agentId });
  });

  afterEach(async () => disposeStore(store));

  const ping = (capturedAt: string, lat = 64.14) => ({
    lat,
    lng: -21.94,
    label: 'Reykjavik',
    accuracyM: 25,
    source: 'app',
    timeZone: 'Atlantic/Reykjavik',
    capturedAt: at(capturedAt),
  });

  it('records pings in the imported shape and reads a half-open window newest first', async () => {
    await repository.record(agentId, ping('2026-09-24T10:00:00.000Z'));
    await repository.record(agentId, ping('2026-09-24T11:00:00.000Z', 64.15));
    await repository.record(agentId, ping('2026-09-24T11:59:00.000Z'));
    await store
      .collection('locationPings')
      .doc('foreign')
      .set({
        id: 'foreign',
        agentId: randomUUID(),
        lat: '1',
        lng: '1',
        capturedAt: at('2026-09-24T11:30:00.000Z'),
      });

    const stored = (
      await store.collection('locationPings').where('agentId', '==', agentId).get()
    ).docs[0]?.data();
    expect(stored).toMatchObject({ lat: expect.any(String), lng: '-21.94', source: 'app' });

    const recent = await repository.recent(agentId, {
      from: at('2026-09-24T10:30:00.000Z'),
      before: at('2026-09-24T11:59:00.000Z'),
    });
    expect(recent).toEqual([
      { lat: 64.15, lng: -21.94, accuracyM: 25, capturedAt: at('2026-09-24T11:00:00.000Z') },
    ]);
  });

  it('activates only explicitly opted-in arrival references for five minutes and only for their owner', async () => {
    const capturedAt = at('2026-09-24T11:59:00.000Z');
    const observation = await repository.record(agentId, {
      ...ping(capturedAt.toISOString()),
      arrivalOptIn: true,
    });
    expect(observation.arrivalExpiresAt).toEqual(at('2026-09-24T12:04:00.000Z'));
    expect(
      await repository.isArrivalObservationActive(
        agentId,
        observation.id,
        at('2026-09-24T12:00:00Z'),
      ),
    ).toBe(true);
    expect(
      await repository.isArrivalObservationActive(
        randomUUID(),
        observation.id,
        at('2026-09-24T12:00:00Z'),
      ),
    ).toBe(false);
    expect(
      await repository.isArrivalObservationActive(
        agentId,
        observation.id,
        at('2026-09-24T12:04:00Z'),
      ),
    ).toBe(false);

    const ordinary = await repository.record(agentId, ping(capturedAt.toISOString()));
    expect(ordinary.arrivalExpiresAt).toBeNull();
    expect(
      await repository.isArrivalObservationActive(agentId, ordinary.id, at('2026-09-24T12:00:00Z')),
    ).toBe(false);
  });

  it('finds only this agent’s arrival tasks inside the cooldown', async () => {
    const task = (id: string, owner: string, eventId: string, createdAt: string) =>
      store
        .doc('tasks', id)
        .set({ id, agentId: owner, externalEventId: eventId, createdAt: at(createdAt) });
    await task('old', agentId, `arrival:${agentId}:2026-09-23`, '2026-09-23T08:00:00Z');
    await task('other', agentId, `reminder:${agentId}:x`, '2026-09-24T11:00:00Z');
    const foreign = randomUUID();
    await task('foreign', foreign, `arrival:${foreign}:2026-09-24`, '2026-09-24T11:00:00Z');

    const since = at('2026-09-24T00:00:00Z');
    expect(await repository.hasArrivalTaskSince(agentId, since)).toBe(false);
    await task('new', agentId, `arrival:${agentId}:2026-09-24`, '2026-09-24T09:00:00Z');
    expect(await repository.hasArrivalTaskSince(agentId, since)).toBe(true);
  });

  it('refuses pings for an unconfigured owner and during privacy erasure', async () => {
    await expect(repository.record(randomUUID(), ping('2026-09-24T11:00:00Z'))).rejects.toThrow(
      'Location ping requires one matching configured agent',
    );
    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'running' });
    await expect(repository.record(agentId, ping('2026-09-24T11:00:00Z'))).rejects.toThrow(
      'Privacy erasure is in progress',
    );
    expect((await store.collection('locationPings').get()).size).toBe(0);
  });
});
