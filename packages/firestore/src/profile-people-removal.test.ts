import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FirestoreProfileOccasionCommandRepository } from './profile-occasion-command.js';
import { FirestoreProfilePeopleRemovalRepository } from './profile-people-removal.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore profile people removal occasions',
  () => {
    it('moves the date marker atomically during person merge and preserves corrected identity', async () => {
      const store = emulatorStore();
      const agentId = randomUUID();
      const sourceId = randomUUID();
      const targetId = randomUUID();
      await store.doc('agents', agentId).set({ id: agentId });
      const now = new Date();
      const person = (id: string, name: string) => ({
        id,
        agentId,
        name,
        aliases: [],
        emails: [],
        phones: [],
        relationship: 'friend',
        notes: '',
        trust: 'unknown',
        createdAt: now,
        updatedAt: now,
      });
      await Promise.all([
        store.doc('contacts', sourceId).set(person(sourceId, 'Source')),
        store.doc('contacts', targetId).set(person(targetId, 'Target')),
      ]);
      const commands = new FirestoreProfileOccasionCommandRepository(store, agentId);
      try {
        await commands.create({
          contactId: sourceId,
          kind: 'birthday',
          label: 'Birthday',
          month: 4,
          day: 12,
          year: 1980,
          leadDays: 7,
          notes: 'Owner date correction',
        });
        const sourceRow = (
          await store.collection('occasions').where('contactId', '==', sourceId).get()
        ).docs[0];
        if (!sourceRow) throw new Error('Expected source occasion');
        const sourceOccasionId = String(sourceRow.get('id'));
        await commands.update(sourceOccasionId, {
          kind: 'birthday',
          label: 'Birthday',
          month: 4,
          day: 13,
          year: 1980,
          leadDays: 7,
          notes: 'Explicit corrected date',
        });

        const moved = await new FirestoreProfilePeopleRemovalRepository(store, agentId).finishMerge(
          sourceId,
          targetId,
        );
        expect(moved.movedOccasions).toBe(1);
        const existing = await store.doc('occasions', sourceOccasionId).get();
        expect(existing.data()).toMatchObject({
          id: sourceOccasionId,
          contactId: targetId,
          day: 13,
          notes: 'Explicit corrected date',
          ownerConfirmed: true,
        });
        const reingested = await commands.record(
          {
            contactId: targetId,
            kind: 'birthday',
            label: 'Birthday',
            month: 4,
            day: 12,
            year: null,
            leadDays: 7,
            notes: 'Old source date',
          },
          {
            originTrust: 'assistant',
            quarantined: true,
            ownerConfirmed: false,
            source: 'extraction',
          },
        );
        expect(reingested.created).toBe(true);
        const rows = await store.collection('occasions').where('contactId', '==', targetId).get();
        expect(rows.size).toBe(2);
        expect(rows.docs.find((row) => row.get('id') === sourceOccasionId)?.get('day')).toBe(13);
        expect(rows.docs.find((row) => row.get('day') === 12)?.get('notes')).toBe(
          'Old source date',
        );
      } finally {
        await disposeStore(store);
      }
    });
  },
);
