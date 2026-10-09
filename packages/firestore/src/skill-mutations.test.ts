import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { embeddingSpaceKey } from './memory.js';
import { FirestoreSkillMutationRepository } from './skill-mutations.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore skill mutations', () => {
  let store: InstallationStore;
  let repository: FirestoreSkillMutationRepository;
  const agentId = randomUUID();
  const space = {
    provider: 'vertex',
    model: 'fixture-embedding',
    dimensions: 1536,
    revision: 'skill-mutation-test-v1',
  };
  const embedding = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
  const embedding768 = Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0));
  const input = {
    name: 'Flight booking',
    preconditions: '',
    steps: 'Compare fares and book the selected flight.',
    gotchas: '',
  };

  beforeEach(async () => {
    store = emulatorStore();
    repository = new FirestoreSkillMutationRepository(store, space);
    await store.doc('agents', agentId).set({ id: agentId });
  });

  afterEach(async () => disposeStore(store));

  it('accepts the 500th skill and refuses a 501st new skill', async () => {
    const batch = store.db.batch();
    for (let index = 0; index < 499; index++) {
      const id = randomUUID();
      batch.set(store.doc('skills', id), {
        id,
        agentId,
        name: `Existing ${index}`,
        preconditions: '',
        steps: 'Existing steps',
        gotchas: '',
        embedding: null,
        sourceTaskId: null,
        originTrust: 'assistant',
        ownerAuthored: false,
        useCount: 0,
        successCount: 0,
        failureCount: 0,
        lastVerifiedAt: null,
        deprecated: false,
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      });
    }
    await batch.commit();

    await repository.saveOwner(agentId, input, embedding);
    const afterInsert = await store.collection('skills').where('agentId', '==', agentId).get();
    expect(afterInsert.size).toBe(500);
    expect(afterInsert.docs.some((doc) => doc.get('name') === input.name)).toBe(true);
    await expect(
      repository.saveOwner(agentId, { ...input, name: 'One too many' }, embedding),
    ).rejects.toThrow('Learned-skill library exceeds the mobile workspace limit');
  });

  it('writes and mutates skills in a captured 768-dimensional space', async () => {
    const configuredSpace = { ...space, dimensions: 768 };
    const capturedKey = embeddingSpaceKey(configuredSpace);
    const smallRepository = new FirestoreSkillMutationRepository(store, configuredSpace);
    configuredSpace.provider = 'changed-provider';
    configuredSpace.model = 'changed-model';
    configuredSpace.dimensions = 1536;
    configuredSpace.revision = 'changed-revision';

    await smallRepository.saveOwner(agentId, input, embedding768);
    const saved = await store.collection('skills').where('agentId', '==', agentId).get();
    expect(saved.size).toBe(1);
    expect(saved.docs[0]?.get('embeddingSpaceKey')).toBe(capturedKey);
    expect(saved.docs[0]?.get('embeddingSpace')).toBe(capturedKey);

    const skillId = saved.docs[0]?.get('id');
    if (typeof skillId !== 'string') throw new Error('Expected saved skill ID');
    await smallRepository.setDeprecated(agentId, skillId, true);
    expect((await store.doc('skills', skillId).get()).get('deprecated')).toBe(true);
  });

  it('fails closed when a same-name document stores a different skill ID', async () => {
    const mismatchedId = randomUUID();
    await store.doc('skills', 'malformed-skill-document').set({
      id: mismatchedId,
      agentId,
      name: input.name,
      preconditions: '',
      steps: 'Existing steps',
      gotchas: '',
      embedding: null,
      sourceTaskId: null,
      originTrust: 'assistant',
      ownerAuthored: false,
      useCount: 0,
      successCount: 0,
      failureCount: 0,
      lastVerifiedAt: null,
      deprecated: false,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    });

    await expect(repository.saveOwner(agentId, input, embedding)).rejects.toThrow(
      'Invalid learned-skill document',
    );
    const skills = await store.collection('skills').where('agentId', '==', agentId).get();
    expect(skills.size).toBe(1);
    expect(skills.docs[0]?.get('id')).toBe(mismatchedId);
  });

  it('fences a stale reflection after an owner create and checkpoints the source task', async () => {
    const taskId = randomUUID();
    await store.doc('tasks', taskId).set({
      id: taskId,
      agentId,
      status: 'done',
      trust: 'assistant',
      trigger: { source: 'internal', payload: {} },
      state: {},
    });
    const expectedLibraryRevision = await repository.libraryRevisionForReflection(agentId);
    await repository.saveOwner(agentId, input, embedding);

    const result = await repository.commitReflection({
      agentId,
      taskId,
      expectedLibraryRevision,
      skill: {
        ...input,
        sourceTaskId: taskId,
        originTrust: 'assistant',
      },
      embedding,
      embeddingSpaceKey: embeddingSpaceKey(space),
    });
    expect(result).toEqual({ status: 'superseded' });
    const skill = await store.collection('skills').where('agentId', '==', agentId).get();
    expect(skill.size).toBe(1);
    expect(skill.docs[0]?.get('steps')).toBe(input.steps);
    expect(skill.docs[0]?.get('ownerAuthored')).toBe(true);
    expect(
      (await store.doc('tasks', taskId).get()).get('state.skillReflectionReceipt.status'),
    ).toBe('superseded');
  });

  it('preflights target ownership before embedding and rechecks ownership at edit commit', async () => {
    await repository.saveOwner(agentId, input, embedding);
    const ownerRows = await store.collection('skills').where('agentId', '==', agentId).get();
    const owned = ownerRows.docs.find((doc) => doc.get('name') === input.name);
    if (!owned) throw new Error('Expected the saved owner skill');
    const ownedSkillId = owned.get('id');
    if (typeof ownedSkillId !== 'string' || !ownedSkillId)
      throw new Error('Expected the raw owner skill identity');
    await expect(repository.assertOwnerCanEdit(agentId, ownedSkillId)).resolves.toBeUndefined();
    await expect(repository.assertOwnerCanEdit(agentId, randomUUID())).rejects.toThrow(
      'Skill not found',
    );

    const otherAgentId = randomUUID();
    await store.doc('skills', 'foreign-owner-skill').set({
      id: 'foreign-owner-skill',
      agentId: otherAgentId,
      name: 'Foreign skill',
      preconditions: '',
      steps: 'Foreign steps',
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
    });
    await expect(repository.assertOwnerCanEdit(agentId, 'foreign-owner-skill')).rejects.toThrow(
      'Skill not found',
    );

    // Ownership can change after preflight; the authoritative transaction must reject it.
    await owned.ref.update({ agentId: otherAgentId });
    const beforeFailedEdit = (await owned.ref.get()).data();
    await expect(
      repository.editOwner(agentId, ownedSkillId, { ...input, name: 'Changed' }, embedding),
    ).rejects.toThrow('Skill not found');
    expect((await owned.ref.get()).data()).toEqual(beforeFailedEdit);
  });
});
