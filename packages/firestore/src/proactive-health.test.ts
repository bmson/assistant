import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreProactiveHealthRepository } from './proactive-health.js';
import { encodeRecord, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const HOUR = 3_600_000;

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore proactive health counts', () => {
  const agentId = randomUUID();
  const now = Date.now();
  const ago = (hours: number) => new Date(now - hours * HOUR);
  let store: InstallationStore;

  beforeEach(() => {
    store = emulatorStore();
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  async function put(collection: string, row: Record<string, unknown>) {
    const id = randomUUID();
    await store.doc(collection, id).set(encodeRecord({ id, ...row }));
  }

  it("counts only the owner's recent pipeline activity", async () => {
    for (const hours of [2, 30, 200]) await put('emailIngest', { agentId, createdAt: ago(hours) });
    await put('emailIngest', { agentId: randomUUID(), createdAt: ago(1) });
    await put('proactiveMoments', { agentId, deliveredAt: ago(3) });
    await put('proactiveMoments', { agentId, deliveredAt: ago(48) });
    await put('proactivePings', { agentId, delivered: true, createdAt: ago(1) });
    await put('proactivePings', { agentId, delivered: false, createdAt: ago(1) });
    await put('proactivePings', { agentId, delivered: true, createdAt: ago(30) });
    for (const invalidatedAt of [null, ago(5)])
      await put('deviceTokens', {
        agentId,
        token: randomUUID(),
        environment: 'production',
        invalidatedAt,
        lastSeenAt: ago(1),
        createdAt: ago(10),
        updatedAt: ago(1),
      });

    const counts = await new FirestoreProactiveHealthRepository(store).counts(agentId, {
      since24h: ago(24),
      since7d: ago(24 * 7),
    });
    expect(counts).toEqual({
      mailScored24h: 1,
      mailScored7d: 2,
      lastMailAt: ago(2),
      momentsDelivered24h: 1,
      pingsDelivered24h: 1,
      pingsHeld24h: 1,
      pushDevices: 1,
    });
  });

  it('counts admitted automated mail even when no conversation message was needed', async () => {
    await put('emailIngest', {
      agentId,
      createdAt: ago(1),
      pipelineStage: 'message_persisted',
      ingestMode: 'direct',
      authenticated: true,
      scoreStatus: 'prepared',
      admittedSourceKind: 'automated_source',
      admittedSourceId: 'source',
      messagePersisted: false,
    });
    const counts = await new FirestoreProactiveHealthRepository(store).counts(agentId, {
      since24h: ago(24),
      since7d: ago(168),
    });
    expect(counts).toMatchObject({ mailScored24h: 1, mailScored7d: 1 });
  });
});
