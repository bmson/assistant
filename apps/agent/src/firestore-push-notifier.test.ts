import { randomUUID } from 'node:crypto';
import { loadConfig, resetConfigForTest } from '@assistant/config';
import {
  FirestoreDeviceTokenRepository,
  FirestoreNotificationOutboxRepository,
} from '@assistant/firestore';
import { notificationDeliveryKey } from '@assistant/persistence';
import type { ApnsClient } from '@assistant/tools/modules/push';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import {
  notifyApprovalsByPush,
  notifyOwnerByPush,
} from '../../../packages/modules/src/push/channel.js';

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore push notifier', () => {
  const agentId = randomUUID();
  let store: InstallationStore;
  let devices: FirestoreDeviceTokenRepository;
  let notificationOutbox: FirestoreNotificationOutboxRepository;

  beforeEach(async () => {
    store = emulatorStore();
    devices = new FirestoreDeviceTokenRepository(store);
    notificationOutbox = new FirestoreNotificationOutboxRepository(store, agentId);
    await store.doc('agents', agentId).set({ id: agentId, name: 'Ada', timezone: 'UTC' });
  });

  afterEach(async () => {
    await disposeStore(store);
    resetConfigForTest();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('lists deliverable tokens oldest first and invalidates without deleting', async () => {
    await devices.register(agentId, { token: TOKEN_A, platform: 'ios', environment: 'sandbox' });
    await devices.register(agentId, {
      token: TOKEN_B,
      platform: 'ios',
      environment: 'production',
    });
    expect(await devices.listActive(agentId)).toEqual([
      { token: TOKEN_A, environment: 'sandbox' },
      { token: TOKEN_B, environment: 'production' },
    ]);
    await devices.invalidate(TOKEN_A);
    expect(await devices.listActive(agentId)).toEqual([
      { token: TOKEN_B, environment: 'production' },
    ]);
    expect(await devices.listActive(randomUUID())).toEqual([]);
    // Registering again revives the token.
    await devices.register(agentId, { token: TOKEN_A, platform: 'ios', environment: 'sandbox' });
    expect((await devices.listActive(agentId)).map((row) => row.token)).toContain(TOKEN_A);
  });

  it('pushes to every active device and drops a token APNs no longer knows', async () => {
    await devices.register(agentId, { token: TOKEN_A, platform: 'ios', environment: 'sandbox' });
    await devices.register(agentId, {
      token: TOKEN_B,
      platform: 'ios',
      environment: 'production',
    });
    const sent: Array<{ token: string; title: string; body: string; category: string }> = [];
    const apns = {
      configured: () => true,
      send: vi.fn(
        async (alert: { token: string; title: string; body: string; category: string }) => {
          sent.push(alert);
          return alert.token === TOKEN_A
            ? { ok: false, unregistered: true, status: 410, reason: 'Unregistered' }
            : { ok: true };
        },
      ),
    } as unknown as ApnsClient;
    const deps = {
      apns,
      devices,
      notificationOutbox,
      owner: async () => ({ id: agentId, name: 'Ada' }),
    };

    await notifyOwnerByPush(deps, { text: 'The **flight** moved to 9:40.' });
    expect(sent.map((alert) => [alert.token, alert.title, alert.body])).toEqual([
      [TOKEN_A, 'Ada', 'The flight moved to 9:40.'],
      [TOKEN_B, 'Ada', 'The flight moved to 9:40.'],
    ]);

    sent.length = 0;
    await notifyApprovalsByPush(deps, [{ taskId: 't', shortCode: 'A7', summary: 'Send the RSVP' }]);
    expect(sent.map((alert) => [alert.token, alert.body, alert.category])).toEqual([
      [TOKEN_B, 'Needs your approval: Send the RSVP', 'ASSISTANT_ATTENTION'],
    ]);
  });

  it('gates the Firestore composition phone legs through quiet hours, without SQL', async () => {
    vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
    const { composeFirestoreAgent } = await import('./deps.js');
    const deps = composeFirestoreAgent(
      loadConfig({
        PERSISTENCE_DRIVER: 'firestore',
        ASSISTANT_MODULES: 'push',
        ASSISTANT_WORKSPACE_ID: store.installationId,
        FIRESTORE_AGENT_ID: agentId,
        FIRESTORE_EMBEDDING_SPACE:
          '{"provider":"openai","model":"text-embedding-3-small","dimensions":1536,"revision":"1"}',
        GCP_PROJECT: 'demo-assistant-test',
        QUEUE_DRIVER: 'local',
        OPENROUTER_API_KEY: 'test-key',
      }),
    );
    const pings = async () =>
      (await store.collection('proactivePings').get()).docs.map((doc) => [
        doc.get('delivered'),
        doc.get('reason'),
      ]);

    // Quiet all day: an ambient notice is held and recorded as held.
    await store
      .doc('notificationPrefs', agentId)
      .set({ agentId, quietStartMin: 0, quietEndMin: 1439, ambientDailyCap: null });
    await deps.outOfBandNotifier.notifyOwner({ text: 'Ambient', urgency: 'ambient' });
    expect(await pings()).toEqual([[false, 'quiet-hours']]);

    // Outside quiet hours it is delivered (the unconfigured APNs leg then no-ops).
    await store.doc('notificationPrefs', agentId).delete();
    await deps.outOfBandNotifier.notifyOwner({ text: 'Ambient again', urgency: 'ambient' });
    expect((await pings()).sort()).toEqual([
      [false, 'quiet-hours'],
      [true, null],
    ]);
  });

  it('persists a dashboard leg and replays it without duplicating its chat message', async () => {
    vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
    const { agentServices, composeFirestoreAgent } = await import('./deps.js');
    const deps = composeFirestoreAgent(
      loadConfig({
        PERSISTENCE_DRIVER: 'firestore',
        ASSISTANT_MODULES: '',
        ASSISTANT_WORKSPACE_ID: store.installationId,
        FIRESTORE_AGENT_ID: agentId,
        FIRESTORE_EMBEDDING_SPACE:
          '{"provider":"openai","model":"text-embedding-3-small","dimensions":1536,"revision":"1"}',
        GCP_PROJECT: 'demo-assistant-test',
        QUEUE_DRIVER: 'local',
        OPENROUTER_API_KEY: 'test-key',
      }),
    );
    const notices = agentServices(deps).ownerNotifier;
    const input = {
      deliveryKey: 'test:dashboard-stable-identity',
      text: 'The report is ready.',
    };
    const first = await notices.notifyOwner(input);
    const replay = await notices.notifyOwner(input);
    expect(
      first?.legs.some((leg) => leg.channel === 'dashboard' && leg.status === 'delivered'),
    ).toBe(true);
    expect(
      replay?.legs.some((leg) => leg.channel === 'dashboard' && leg.status === 'delivered'),
    ).toBe(true);
    expect(
      (await store.collection('messages').get()).docs.filter(
        (doc) => doc.get('text') === 'The report is ready.',
      ),
    ).toHaveLength(1);
    const outbox = (await store.collection('notificationOutbox').get()).docs.filter(
      (doc) =>
        doc.get('agentId') === agentId &&
        doc.get('deliveryKey') === notificationDeliveryKey('outbox', agentId, input.deliveryKey),
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.get('status')).toBe('delivered');
    expect(outbox[0]?.get('providerMessageId')).toMatch(/^notification:[a-f0-9]{64}$/);
  });
});
