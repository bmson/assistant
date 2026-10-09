import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FirestoreProfileOccasionCommandRepository } from './profile-occasion-command.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore profile occasion command', () => {
  it('creates atomically, deduplicates by owner/person/date, and enriches a matching occasion', async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const contactId = randomUUID();
    await store.doc('agents', agentId).set({ id: agentId });
    await store.doc('contacts', contactId).set({ id: contactId, name: 'Rae' });
    const repository = new FirestoreProfileOccasionCommandRepository(store, agentId);
    const input = {
      contactId,
      kind: 'birthday' as const,
      label: 'Birthday',
      month: 4,
      day: 12,
      year: null,
      leadDays: 7,
      notes: 'Ask about a cake',
    };

    try {
      await Promise.all([repository.create(input), repository.create(input)]);
      const first = await store.collection('occasions').get();
      expect(first.size).toBe(1);
      expect(first.docs[0]?.data()).toMatchObject({
        id: expect.any(String),
        agentId,
        contactId,
        kind: 'birthday',
        label: 'Birthday',
        month: 4,
        day: 12,
        year: null,
        recurrence: 'annual',
        leadDays: 7,
        notes: 'Ask about a cake',
        originTrust: 'owner',
        ownerConfirmed: true,
        quarantined: false,
        source: 'profile',
      });

      await repository.create({ ...input, year: 1987, notes: 'Bring candles' });
      const after = await store.collection('occasions').get();
      expect(after.size).toBe(1);
      expect(after.docs[0]?.data()).toMatchObject({
        year: 1987,
        notes: 'Ask about a cake; Bring candles',
      });
    } finally {
      await disposeStore(store);
    }
  });

  it('enriches an imported occasion with a random record id instead of creating a duplicate', async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const contactId = randomUUID();
    const importedId = randomUUID();
    const now = new Date('2025-01-02T03:04:05.000Z');
    await store.doc('agents', agentId).set({ id: agentId });
    await store.doc('contacts', contactId).set({ id: contactId, name: 'Rae' });
    await store.doc('occasions', importedId).set({
      id: importedId,
      agentId,
      contactId,
      kind: 'birthday' as const,
      label: 'Imported birthday label',
      month: 4,
      day: 12,
      year: null,
      recurrence: 'annual',
      leadDays: 10,
      notes: 'Imported note',
      originTrust: 'owner',
      quarantined: false,
      ownerConfirmed: true,
      source: 'profile',
      createdAt: now,
      updatedAt: now,
    });

    try {
      await new FirestoreProfileOccasionCommandRepository(store, agentId).create({
        contactId,
        kind: 'birthday',
        label: 'New label is ignored on conflict, like PostgreSQL',
        month: 4,
        day: 12,
        year: 1987,
        leadDays: 7,
        notes: 'New note',
      });
      const rows = await store.collection('occasions').get();
      expect(rows.size).toBe(1);
      expect(rows.docs[0]?.id).toBe(store.doc('occasions', importedId).id);
      expect(rows.docs[0]?.data()).toMatchObject({
        id: importedId,
        label: 'Imported birthday label',
        year: 1987,
        leadDays: 10,
        notes: 'Imported note; New note',
      });
    } finally {
      await disposeStore(store);
    }
  });

  it('fails closed for a missing person, a foreign owner, or active privacy erasure', async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const foreignAgentId = randomUUID();
    const contactId = randomUUID();
    const foreignContactId = randomUUID();
    await store.doc('agents', agentId).set({ id: agentId });
    await store.doc('contacts', contactId).set({ id: contactId, name: 'Rae' });
    await store.doc('contacts', foreignContactId).set({
      id: foreignContactId,
      name: 'Foreign person',
      agentId: foreignAgentId,
    });
    const repository = new FirestoreProfileOccasionCommandRepository(store, agentId);
    const input = {
      contactId,
      kind: 'birthday' as const,
      label: 'Birthday',
      month: 4,
      day: 12,
      year: null,
      leadDays: 7,
      notes: '',
    };

    try {
      await expect(repository.create({ ...input, contactId: randomUUID() })).rejects.toThrow(
        'Person not found.',
      );
      await expect(repository.create({ ...input, contactId: foreignContactId })).rejects.toThrow(
        'Person not found.',
      );
      await expect(
        new FirestoreProfileOccasionCommandRepository(store, foreignAgentId).create(input),
      ).rejects.toThrow('exactly one configured owner');
      await store.doc('privacyErasureJobs', agentId).set({
        agentId,
        generation: randomUUID(),
        status: 'active',
        counts: { memories: 0, graphRelations: 0, writingSamples: 0 },
      });
      await expect(repository.create(input)).rejects.toThrow('Privacy erasure is in progress');
      expect((await store.collection('occasions').get()).empty).toBe(true);
    } finally {
      await disposeStore(store);
    }
  });

  it('updates, reviews, and forgets only matching-owner occasions', async () => {
    const store = emulatorStore();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const contactId = randomUUID();
    const foreignOccasionId = randomUUID();
    await store.doc('agents', agentId).set({ id: agentId });
    await store.doc('contacts', contactId).set({ id: contactId, name: 'Rae' });
    const repository = new FirestoreProfileOccasionCommandRepository(store, agentId);
    const input = {
      contactId,
      kind: 'birthday' as const,
      label: 'Birthday',
      month: 4,
      day: 12,
      year: null,
      leadDays: 7,
      notes: '',
    };

    try {
      await repository.create(input);
      const created = (await store.collection('occasions').get()).docs[0];
      expect(created).toBeDefined();
      if (!created) throw new Error('Expected the owner occasion to be created');
      const createdId = created.get('id') as string;
      await store.doc('occasions', foreignOccasionId).set({
        ...created.data(),
        id: foreignOccasionId,
        agentId: otherAgentId,
      });

      await repository.update(createdId, {
        kind: 'birthday',
        label: 'Celebration day',
        month: 4,
        day: 13,
        year: 1987,
        leadDays: 14,
        notes: 'Call beforehand',
      });
      expect((await store.doc('occasions', createdId).get()).data()).toMatchObject({
        agentId,
        contactId,
        label: 'Celebration day',
        month: 4,
        day: 13,
        year: 1987,
        leadDays: 14,
        notes: 'Call beforehand',
        ownerConfirmed: true,
        quarantined: false,
      });
      const oldDate = { ...input, year: 2020, notes: 'Old date observation' };
      await expect(
        repository.record(oldDate, {
          originTrust: 'assistant',
          quarantined: true,
          ownerConfirmed: false,
          source: 'extraction',
        }),
      ).rejects.toThrow('explicitly corrected by the owner');
      const correctedResult = await repository.record(
        { ...input, month: 4, day: 13, notes: 'New date observation' },
        {
          originTrust: 'assistant',
          quarantined: true,
          ownerConfirmed: false,
          source: 'extraction',
        },
      );
      expect(correctedResult.created).toBe(false);
      const rowsAfterReingestion = await store
        .collection('occasions')
        .where('agentId', '==', agentId)
        .get();
      expect(rowsAfterReingestion.size).toBe(1);
      expect(
        rowsAfterReingestion.docs.find((row) => row.get('id') === createdId)?.data(),
      ).toMatchObject({
        day: 13,
        notes: 'Call beforehand; New date observation',
        ownerConfirmed: true,
        quarantined: false,
      });
      expect(rowsAfterReingestion.docs.find((row) => row.get('day') === 12)).toBeUndefined();
      await repository.review(foreignOccasionId, 'approve');
      await repository.forget(foreignOccasionId);
      expect((await store.doc('occasions', foreignOccasionId).get()).exists).toBe(true);

      await repository.review(createdId, 'reject');
      expect((await store.doc('occasions', createdId).get()).exists).toBe(false);
    } finally {
      await disposeStore(store);
    }
  });
});
