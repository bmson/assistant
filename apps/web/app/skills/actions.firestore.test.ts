import { randomUUID } from 'node:crypto';
import { resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  embed: vi.fn(),
  getChatApplication: vi.fn(() => {
    throw new Error('PostgreSQL application must not be initialized in Firestore mode');
  }),
  revalidate: vi.fn(),
}));
vi.mock('@/auth', () => ({ requireOwner: mocks.owner }));
vi.mock('@/lib/server', () => ({
  getChatApplication: mocks.getChatApplication,
  embedFirestoreSkillText: mocks.embed,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));

import {
  addSkillAction,
  deleteSkillAction,
  editSkillAction,
  toggleSkillDeprecatedAction,
} from './actions.js';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const localEmulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(emulatorHost);

describe.skipIf(!localEmulator)('Firestore web Skills actions with PostgreSQL offline', () => {
  const installationId = `web-skill-actions-${randomUUID()}`;
  const agentId = randomUUID();
  const foreignSkillId = randomUUID();
  const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });
  let skillId: string;
  const input = {
    name: 'Owner travel procedure',
    preconditions: 'A trip is approved',
    steps: 'Compare options and book the selected route.',
    gotchas: 'Confirm baggage fees.',
  };
  const embedding = [1, ...new Array(1535).fill(0)];

  beforeAll(async () => {
    vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
    vi.stubEnv('DATABASE_URL', 'postgres://offline:offline@127.0.0.1:1/offline_test');
    vi.stubEnv('GCP_PROJECT', 'demo-assistant-test');
    vi.stubEnv('ASSISTANT_WORKSPACE_ID', installationId);
    vi.stubEnv('FIRESTORE_DATABASE_ID', '(default)');
    vi.stubEnv('FIRESTORE_AGENT_ID', agentId);
    vi.stubEnv(
      'FIRESTORE_EMBEDDING_SPACE',
      '{"provider":"vertex","model":"fixture","dimensions":1536,"revision":"1"}',
    );
    vi.stubEnv('LLM_PROVIDER', 'vertex');
    vi.stubEnv('ASSISTANT_MODULES', 'minimal');
    vi.stubEnv('QUEUE_DRIVER', 'local');
    vi.stubEnv('CANARY_ENABLED', 'false');
    vi.stubEnv('LOCATION_PING_SECRET', '');
    resetConfigForTest();
  });

  beforeEach(async () => {
    mocks.owner.mockResolvedValue(undefined);
    mocks.embed.mockReset().mockResolvedValue(embedding);
    mocks.getChatApplication.mockClear();
    mocks.revalidate.mockClear();
    await store.db.recursiveDelete(store.root);
    await Promise.all([
      store.doc('agents', agentId).set({ id: agentId }),
      store.doc('skills', foreignSkillId).set({
        id: foreignSkillId,
        agentId: randomUUID(),
        name: 'Foreign procedure',
        preconditions: '',
        steps: 'Private foreign steps',
        gotchas: '',
        embedding: null,
        sourceTaskId: null,
        originTrust: 'owner',
        ownerAuthored: true,
        useCount: 0,
        successCount: 0,
        failureCount: 0,
        lastVerifiedAt: null,
        deprecated: false,
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      }),
    ]);
  });

  afterAll(async () => {
    await store.db.recursiveDelete(store.root);
    await store.db.terminate();
    vi.unstubAllEnvs();
    resetConfigForTest();
  });

  it('creates, edits, retires, restores, and deletes through the Firestore repository', async () => {
    await expect(addSkillAction(input)).resolves.toEqual({});
    expect(mocks.embed).toHaveBeenCalledWith(
      'Owner travel procedure\nWhen: A trip is approved\nSteps: Compare options and book the selected route.\nGotchas: Confirm baggage fees.',
    );
    const found = await store.collection('skills').where('agentId', '==', agentId).get();
    const skill = found.docs.find((doc) => doc.get('name') === input.name);
    expect(skill).toBeDefined();
    skillId = (skill?.get('id') as string | undefined) ?? '';
    expect(skillId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    await expect(
      editSkillAction(skillId, { ...input, steps: 'Book the chosen route.' }),
    ).resolves.toEqual({});
    expect((await store.doc('skills', skillId).get()).get('steps')).toBe('Book the chosen route.');
    await toggleSkillDeprecatedAction(skillId, true);
    expect((await store.doc('skills', skillId).get()).get('deprecated')).toBe(true);
    await toggleSkillDeprecatedAction(skillId, false);
    expect((await store.doc('skills', skillId).get()).get('deprecated')).toBe(false);
    await deleteSkillAction(skillId);
    expect((await store.doc('skills', skillId).get()).exists).toBe(false);
    expect(mocks.getChatApplication).not.toHaveBeenCalled();
    expect(mocks.revalidate).toHaveBeenCalledTimes(5);
  });

  it('rejects malformed and foreign IDs without mutating another owner’s skill', async () => {
    await expect(editSkillAction('not-a-uuid', input)).resolves.toEqual({
      error: 'Invalid skill.',
    });
    await deleteSkillAction('not-a-uuid');
    await toggleSkillDeprecatedAction('not-a-uuid', true);
    await expect(editSkillAction(foreignSkillId, input)).resolves.toMatchObject({
      error: 'Skill not found',
    });
    // Ownership preflight now rejects a foreign skill before embedding it.
    expect(mocks.embed).not.toHaveBeenCalled();
    await expect(deleteSkillAction(foreignSkillId)).rejects.toThrow('Skill not found');
    await expect(toggleSkillDeprecatedAction(foreignSkillId, true)).rejects.toThrow(
      'Skill not found',
    );
    const foreign = await store.doc('skills', foreignSkillId).get();
    expect(foreign.exists).toBe(true);
    expect(foreign.get('steps')).toBe('Private foreign steps');
    expect(foreign.get('deprecated')).toBe(false);
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.getChatApplication).not.toHaveBeenCalled();
  });

  it('honors owner authentication and the privacy-erasure write fence', async () => {
    mocks.owner.mockRejectedValueOnce(new Error('Unauthorized'));
    await expect(addSkillAction(input)).rejects.toThrow('Unauthorized');
    expect(mocks.embed).not.toHaveBeenCalled();

    await store.doc('privacyErasureJobs', agentId).set({ agentId, status: 'active' });
    await expect(addSkillAction(input)).resolves.toMatchObject({
      error: 'Privacy erasure is in progress',
    });
    await expect(deleteSkillAction(foreignSkillId)).rejects.toThrow(
      'Privacy erasure is in progress',
    );
    expect((await store.doc('skills', foreignSkillId).get()).exists).toBe(true);
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.getChatApplication).not.toHaveBeenCalled();
  });
});
