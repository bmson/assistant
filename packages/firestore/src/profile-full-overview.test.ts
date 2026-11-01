import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FirestoreProfileOverviewRepository } from './profile-full-overview.js';
import { FirestoreProfilePeopleReadRepository } from './profile-people-read.js';
import { disposeStore, emulatorStore } from './test-store.js';

const now = new Date('2026-09-22T12:00:00Z');

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore full Profile overview', () => {
  it('projects owner facts, people counts, review state, voice, and the compiled card', async () => {
    const store = emulatorStore(() => now);
    const agentId = randomUUID();
    const ownerId = randomUUID();
    const personId = randomUUID();
    const ownerFactId = randomUUID();
    try {
      await store.doc('agents', agentId).set({ id: agentId });
      const batch = store.db.batch();
      for (const [id, name, trust] of [
        [ownerId, 'Owner', 'owner'],
        [personId, 'Person', 'known'],
      ] as const)
        batch.set(store.doc('contacts', id), {
          id,
          name,
          trust,
          aliases: [],
          relationship: trust === 'owner' ? '' : 'friend',
        });
      for (const [id, subjectContactId, quarantined, expiresAt] of [
        [ownerFactId, ownerId, false, null],
        [randomUUID(), personId, false, null],
        [randomUUID(), personId, false, new Date('2020-01-01T00:00:00Z')],
        [randomUUID(), ownerId, true, null],
      ] as const)
        batch.set(store.doc('memories', id), {
          id,
          agentId,
          subjectContactId,
          category: 'knowledge',
          kind: 'fact',
          content: id,
          confidence: '0.90',
          importance: 5,
          domain: 'work',
          pinned: id === ownerFactId,
          ownerConfirmed: false,
          quarantined,
          expiresAt,
          originTrust: 'owner',
          sourceTaskId: null,
          lastConsolidatedAt: null,
          validFrom: null,
          validUntil: null,
          createdAt: now,
        });
      const foreignId = randomUUID();
      batch.set(store.doc('memories', foreignId), {
        id: foreignId,
        agentId: 'foreign',
        subjectContactId: personId,
        category: 'knowledge',
        quarantined: false,
        expiresAt: null,
      });
      const sampleId = randomUUID();
      batch.set(store.doc('writingSamples', sampleId), {
        id: sampleId,
        agentId,
        context: 'upload:test',
      });
      const importId = randomUUID();
      batch.set(store.doc('importSources', importId), {
        id: importId,
        agentId,
        source: 'voice-samples-test',
        updatedAt: now,
        status: 'done',
        itemsTotal: 4,
        itemsProcessed: 4,
        memoriesSaved: 0,
        taskId: null,
        error: null,
      });
      batch.set(store.doc('voiceProfile', '1'), {
        id: 1,
        description: 'Direct',
        dos: ['concise'],
        donts: [],
        signature: 'B',
      });
      batch.set(store.doc('ownerCards', agentId), {
        agentId,
        content: 'Compiled owner card',
        compiledAt: now,
      });
      await batch.commit();

      const collectionReads = vi.spyOn(store, 'collection');
      const result = await new FirestoreProfileOverviewRepository(store).load();
      expect(
        collectionReads.mock.calls.filter(([name]) => name === 'contacts').length,
      ).toBeGreaterThan(0);
      expect(
        collectionReads.mock.calls.filter(([name]) => name === 'memories').length,
      ).toBeGreaterThan(0);
      expect(result.owner?.id).toBe(ownerId);
      expect(result.owner?.identityRevision).toMatch(/^[0-9a-f]{64}$/);
      expect(result.people).toMatchObject([
        {
          contact: { id: personId, identityRevision: expect.stringMatching(/^[0-9a-f]{64}$/) },
          factCount: 1,
        },
      ]);
      const personRead = await new FirestoreProfilePeopleReadRepository(store, agentId).getContact(
        personId,
      );
      expect(personRead?.identityRevision).toBe(result.people[0]?.contact.identityRevision);
      expect(result.ownerFacts.map((row) => row.id)).toEqual([ownerFactId]);
      expect(result.quarantined).toHaveLength(1);
      expect(result.memoryHealth).toMatchObject({ totalUsable: 2, awaitingReview: 1 });
      expect(result.card).toEqual({ content: 'Compiled owner card', compiledAt: now });
      expect(result.voiceStats).toEqual({ total: 1, auto: 0, uploaded: 1 });
      expect(result.voiceProfile.description).toBe('Direct');
      expect(result.voiceImports).toMatchObject([{ source: 'voice-samples-test' }]);
    } finally {
      await disposeStore(store);
    }
  });

  it('fails closed if a selected memory changes before full content hydration', async () => {
    const store = emulatorStore(() => now);
    const agentId = randomUUID();
    const ownerId = randomUUID();
    const memoryId = randomUUID();
    try {
      await store.doc('agents', agentId).set({ id: agentId });
      await store.doc('contacts', ownerId).set({
        id: ownerId,
        name: 'Owner',
        trust: 'owner',
        aliases: [],
        relationship: '',
      });
      await store.doc('memories', memoryId).set({
        id: memoryId,
        agentId,
        subjectContactId: ownerId,
        category: 'knowledge',
        kind: 'fact',
        content: 'Before the concurrent update',
        confidence: '0.90',
        importance: 5,
        domain: 'work',
        pinned: true,
        ownerConfirmed: false,
        quarantined: false,
        expiresAt: null,
        originTrust: 'owner',
        sourceTaskId: null,
        lastConsolidatedAt: null,
        validFrom: null,
        validUntil: null,
        createdAt: now,
      });

      const getAll = store.db.getAll.bind(store.db);
      const getAllSpy = vi.spyOn(store.db, 'getAll').mockImplementation(async (...refs) => {
        if (refs.some((ref) => 'path' in ref && ref.path.includes('/memories/')))
          await store.doc('memories', memoryId).update({ category: 'episode' });
        return getAll(...refs);
      });
      const load = new FirestoreProfileOverviewRepository(store).load();
      let failure: unknown;
      try {
        await load;
      } catch (error) {
        failure = error;
      }
      expect(getAllSpy).toHaveBeenCalled();
      expect(failure).toMatchObject({ message: 'Profile memory changed during read' });
    } finally {
      await disposeStore(store);
    }
  });

  it('fails explicitly when the contact view limit would hide people', async () => {
    const store = emulatorStore(() => now);
    const agentId = randomUUID();
    try {
      await store.doc('agents', agentId).set({ id: agentId });
      let batch = store.db.batch();
      for (let index = 0; index < 501; index++) {
        if (index === 400) {
          await batch.commit();
          batch = store.db.batch();
        }
        const id = randomUUID();
        batch.set(store.doc('contacts', id), {
          id,
          name: `Person ${index}`,
          trust: 'known',
          aliases: [],
          relationship: '',
        });
      }
      await batch.commit();
      await expect(new FirestoreProfileOverviewRepository(store).load()).rejects.toThrow(
        'contact count exceeds the view limit',
      );
    } finally {
      await disposeStore(store);
    }
  });

  it('returns the highest-priority owner facts when the full count exceeds the view limit', async () => {
    const store = emulatorStore(() => now);
    const agentId = randomUUID();
    const ownerId = randomUUID();
    try {
      await store.doc('agents', agentId).set({ id: agentId });
      await store.doc('contacts', ownerId).set({
        id: ownerId,
        name: 'Owner',
        trust: 'owner',
        aliases: [],
        relationship: '',
      });
      const batch = store.db.batch();
      const ids: string[] = [];
      for (let index = 0; index < 251; index++) {
        const id = randomUUID();
        ids.push(id);
        batch.set(store.doc('memories', id), {
          id,
          agentId,
          subjectContactId: ownerId,
          category: 'knowledge',
          quarantined: false,
          expiresAt: null,
          createdAt: now,
          pinned: index === 250,
          importance: index === 0 ? 0 : 3,
          confidence: '0.70',
          content: `Fact ${index}`,
          kind: 'fact',
          domain: 'personal',
          ownerConfirmed: false,
          lastConsolidatedAt: null,
          originTrust: 'owner',
          sourceTaskId: null,
          validFrom: null,
          validUntil: null,
        });
      }
      await batch.commit();
      const profile = await new FirestoreProfileOverviewRepository(store).load();
      expect(profile.ownerFacts).toHaveLength(250);
      expect(profile.ownerFacts[0]?.id).toBe(ids[250]);
      expect(profile.ownerFacts.map((fact) => fact.id)).not.toContain(ids[0]);
      expect(profile.memoryHealth).toMatchObject({ totalUsable: 251 });
    } finally {
      await disposeStore(store);
    }
  });
});
