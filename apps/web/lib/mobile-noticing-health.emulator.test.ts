import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { getFirestoreInstallationStore, getMobileNoticingHealth } from './server';

const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(
  process.env.FIRESTORE_EMULATOR_HOST ?? '',
);
const owner = randomUUID();
let store: ReturnType<typeof getFirestoreInstallationStore> | undefined;

beforeAll(async () => {
  if (!localEmulator) return;
  vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
  vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
  vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
  vi.stubEnv('FIRESTORE_DATABASE_ID', '(default)');
  vi.stubEnv('ASSISTANT_WORKSPACE_ID', `noticing-${randomUUID()}`);
  vi.stubEnv('FIRESTORE_AGENT_ID', owner);
  resetConfigForTest();
  store = getFirestoreInstallationStore();
  await store.doc('agents', owner).set({ id: owner });
  await store.doc('coordination', 'budget-policy').set({
    dailyLimitMicros: 4_000_000,
    monthlyLimitMicros: 50_000_000,
    softPct: 80,
  });
  await store.doc('coordination', 'budget-holds').set({ heldMicros: 1_100_000 });
});

afterAll(async () => {
  if (store) {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
  }
  vi.unstubAllEnvs();
  resetConfigForTest();
});

it.skipIf(!localEmulator)(
  'combines budget, mail and missing briefing evidence for one owner',
  async () => {
    const result = await getMobileNoticingHealth(owner);
    expect(result).toMatchObject({
      briefing: { state: 'missing', ok: false },
      dailyBudgetHolds: 'above_threshold',
      canaries: {
        pulse: { state: 'missing' },
        phoneCalendar: { state: 'not_configured' },
        weather: { state: 'not_configured' },
      },
      mailReceived7d: 0,
      healthy: false,
    });
    expect(result.warnings.join(' ')).toContain('25%');
    expect(result.warnings).toContain('Pulse schedule is missing.');
    await expect(getMobileNoticingHealth(randomUUID())).rejects.toThrow('one owner');
  },
);
