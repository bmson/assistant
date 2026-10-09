import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore, type InstallationStore } from '@assistant/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  application: vi.fn(),
  store: vi.fn(),
  workspaceDelete: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock('@/auth', () => ({ requireOwner: mocks.owner }));
vi.mock('@/lib/server', () => ({
  getApplication: mocks.application,
  getFirestoreInstallationStore: mocks.store,
  getWorkspace: () => ({ delete: mocks.workspaceDelete }),
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore web memory erasure with PostgreSQL offline', () => {
  let store: InstallationStore;
  let agentId: string;
  let action: typeof import('./actions.js');

  beforeEach(async () => {
    agentId = randomUUID();
    const installationId = `web-erasure-${randomUUID()}`;
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"example-embedding","dimensions":768,"revision":"fixture-v1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
    store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
    mocks.owner.mockReset().mockResolvedValue({ user: { email: 'owner@example.test' } });
    mocks.application.mockReset().mockImplementation(() => {
      throw new Error('PostgreSQL application is unreachable');
    });
    mocks.store.mockReset().mockReturnValue(store);
    mocks.workspaceDelete.mockReset().mockResolvedValue(undefined);
    mocks.revalidate.mockReset();
    action = await import('./actions.js');
    await store.doc('agents', agentId).set({ id: agentId, name: 'Assistant' });
    await store.doc('memories', 'owner-memory').set({
      id: 'owner-memory',
      agentId,
      contentHash: `hash-${agentId}`,
      content: 'Private fact',
    });
  });

  afterEach(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('requires owner authentication before starting a durable erasure job', async () => {
    mocks.owner.mockRejectedValueOnce(new Error('owner authentication required'));
    await expect(action.forgetLongTermMemoryAction()).rejects.toThrow(
      'owner authentication required',
    );
    expect(mocks.store).not.toHaveBeenCalled();
    expect((await store.doc('memories', 'owner-memory').get()).exists).toBe(true);
  });

  it('rejects a configured agent mismatch before deleting owner data', async () => {
    vi.stubEnv('FIRESTORE_AGENT_ID', randomUUID());
    resetConfigForTest();
    await expect(action.forgetLongTermMemoryAction()).rejects.toThrow(
      'exactly one configured owner',
    );
    expect((await store.doc('memories', 'owner-memory').get()).exists).toBe(true);
    expect((await store.collection('privacyErasureJobs').get()).empty).toBe(true);
    expect(mocks.workspaceDelete).not.toHaveBeenCalled();
    expect(mocks.application).not.toHaveBeenCalled();
  });

  it('keeps asset cleanup durable and resumes after a failed delete', async () => {
    await store.doc('importSources', 'voice-import').set({
      id: 'voice-import',
      agentId,
      source: 'voice-samples-upload',
      workspacePath: 'import/voice/private.wav',
      taskId: null,
    });
    mocks.workspaceDelete.mockRejectedValueOnce(new Error('asset temporarily unavailable'));
    await expect(action.forgetLongTermMemoryAction()).rejects.toThrow(
      'asset temporarily unavailable',
    );
    expect((await store.doc('memories', 'owner-memory').get()).exists).toBe(false);
    expect((await store.doc('privacyErasureJobs', agentId).get()).get('status')).toBe(
      'content-erased',
    );
    const pendingAssets = await store
      .collection('privacyErasureAssets')
      .where('agentId', '==', agentId)
      .get();
    expect(pendingAssets.size).toBe(1);
    expect(pendingAssets.docs[0]?.get('workspacePath')).toBe('import/voice/private.wav');

    await expect(action.forgetLongTermMemoryAction()).resolves.toBeUndefined();
    expect(mocks.workspaceDelete).toHaveBeenCalledTimes(2);
    expect(mocks.workspaceDelete).toHaveBeenCalledWith('import/voice/private.wav');
    expect(
      (await store.collection('privacyErasureAssets').where('agentId', '==', agentId).get()).empty,
    ).toBe(true);
    expect((await store.doc('privacyErasureJobs', agentId).get()).get('status')).toBe('complete');
    expect((await store.doc('memoryTombstones', `hash-${agentId}`).get()).exists).toBe(true);
    expect(mocks.application).not.toHaveBeenCalled();
  }, 30_000);
});
