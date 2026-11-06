import { createHash, randomUUID } from 'node:crypto';
import { ownerEditorCanonicalApply } from '@assistant/application/owner-editor-wire';
import type { OwnerEditorApply, OwnerEditorScope } from '@assistant/persistence';
import { FieldValue } from '@google-cloud/firestore';
import { describe, expect, it } from 'vitest';
import { buildFirestoreOwnerEditorEpochRecord } from './owner-editor-epoch-record.js';
import {
  firestoreOwnerEditorViewSnapshot,
  readFirestoreOwnerEditorContact,
} from './owner-editor-graph.js';
import { createFirestoreOwnerEditorOperationRepository } from './owner-editor-repository.js';
import { FirestoreProfilePeopleCommandRepository } from './profile-people-command.js';
import { FirestoreProfilePeopleReadRepository } from './profile-people-read.js';
import { disposeStore, emulatorStore } from './test-store.js';

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (host && !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw Error('Loopback emulator required');
describe.skipIf(!host)('owner relationship label on actual Firestore SDK', () => {
  it('preserves omitted values, updates and clears explicitly, replays the receipt and rejects a stale native revision', async () => {
    const store = emulatorStore();
    try {
      const ownerId = randomUUID(),
        contactId = randomUUID(),
        epoch = randomUUID(),
        now = new Date();
      await store.doc('agents', ownerId).set({ id: ownerId });
      await store.doc('maintenanceCursors', `owner-editor-epoch:${ownerId}`).set(
        buildFirestoreOwnerEditorEpochRecord({
          ownerId,
          epoch,
          ready: true,
          privacyGeneration: null,
          updatedAt: now,
        }),
      );
      await store.doc('contacts', contactId).set({
        id: contactId,
        agentId: ownerId,
        name: 'Synthetic person',
        emails: [],
        phones: [],
        notes: '',
        aliases: [],
        trust: 'known',
        relationship: 'sister',
        createdAt: now,
        updatedAt: now,
      });
      const people = new FirestoreProfilePeopleCommandRepository(store, ownerId);
      const operations = createFirestoreOwnerEditorOperationRepository(store, ownerId);
      const run = async (
        request: Extract<OwnerEditorApply, { command: 'update_person_identity' }>,
      ) => {
        const scope: OwnerEditorScope = {
          ownerId,
          epoch,
          privacyGeneration: null,
          command: request.command,
          operationId: request.operationId,
          targetId: contactId,
          sessionDigest: 'a'.repeat(64),
          nonce: randomUUID(),
          issuedAt: now.getTime(),
          expiresAt: now.getTime() + 600000,
        };
        const reservation = await operations.reserve(
          scope,
          createHash('sha256').update(ownerEditorCanonicalApply(request)).digest('hex'),
          new Date(),
        );
        if (reservation.kind !== 'claimed') throw Error('Expected unique synthetic claim');
        const reply = await people.commitEditor(
          reservation.claim,
          { request, name: request.name, aliases: request.aliases },
          new Date(),
        );
        const readback = await operations.lookup(scope, new Date());
        expect(readback.reply).toEqual(reply);
        return reply;
      };
      const snapshot = async () => {
        const current = await readFirestoreOwnerEditorContact(store, ownerId, contactId);
        if (!current) throw Error('Missing synthetic person');
        return current;
      };
      const initial = await snapshot();
      const legacy: Extract<OwnerEditorApply, { command: 'update_person_identity' }> = {
        version: 1,
        intent: 'apply',
        command: 'update_person_identity',
        operationId: randomUUID(),
        contactId,
        expectedContactRevision: initial.revision,
        name: 'Synthetic renamed',
        aliases: [],
      };
      expect(await run(legacy)).toMatchObject({ authority: 'operation_receipt', outcome: 'saved' });
      expect((await store.doc('contacts', contactId).get()).get('relationship')).toBe('sister');
      const renamed = await snapshot();
      expect(
        await run({
          ...legacy,
          operationId: randomUUID(),
          expectedContactRevision: renamed.revision,
          name: renamed.name,
          aliases: renamed.aliases,
          relationship: 'friend',
        }),
      ).toMatchObject({ outcome: 'saved' });
      expect((await store.doc('contacts', contactId).get()).get('relationship')).toBe('friend');
      expect(
        await run({
          ...legacy,
          operationId: randomUUID(),
          expectedContactRevision: initial.revision,
          relationship: 'wrong stale label',
        }),
      ).toMatchObject({ outcome: 'conflict' });
      expect((await store.doc('contacts', contactId).get()).get('relationship')).toBe('friend');
      const current = await snapshot();
      expect(
        await run({
          ...legacy,
          operationId: randomUUID(),
          expectedContactRevision: current.revision,
          name: current.name,
          aliases: current.aliases,
          relationship: '',
        }),
      ).toMatchObject({ outcome: 'saved' });
      expect((await store.doc('contacts', contactId).get()).get('relationship')).toBe('');
      expect((await store.doc('contacts', contactId).get()).get('trust')).toBe('known');
      // Legacy absence stays absent in storage. An unrelated legacy row must
      // not disable the whole directory's editor snapshot.
      await store.doc('contacts', contactId).update({ relationship: FieldValue.delete() });
      const unrelatedId = randomUUID();
      await store.doc('contacts', unrelatedId).set({
        id: unrelatedId,
        agentId: ownerId,
        name: 'Unrelated legacy person',
        aliases: [],
        trust: 'known',
        emails: [],
        phones: [],
        notes: '',
        createdAt: now,
        updatedAt: now,
      });
      const legacyView = await firestoreOwnerEditorViewSnapshot(store, ownerId, { contactId });
      expect(legacyView.identity).toMatchObject({ contactId, relationship: '' });
      expect(legacyView.people).toHaveLength(2);
      const absent = await snapshot();
      const profileContact = await new FirestoreProfilePeopleReadRepository(
        store,
        ownerId,
      ).getContact(contactId);
      expect(profileContact).toMatchObject({
        id: contactId,
        relationship: '',
        identityRevision: absent.revision,
      });
      expect(
        await run({
          ...legacy,
          operationId: randomUUID(),
          expectedContactRevision: absent.revision,
          name: 'Legacy renamed',
          aliases: [],
        }),
      ).toMatchObject({ outcome: 'saved' });
      expect((await store.doc('contacts', contactId).get()).get('relationship')).toBeUndefined();
      expect((await store.doc('contacts', unrelatedId).get()).get('relationship')).toBeUndefined();
      const beforeConcurrentChange = await snapshot();
      await store.doc('contacts', contactId).update({ notes: 'Concurrent source change' });
      expect(
        await run({
          ...legacy,
          operationId: randomUUID(),
          expectedContactRevision: beforeConcurrentChange.revision,
          relationship: 'stale attempted label',
        }),
      ).toMatchObject({ outcome: 'conflict' });
      expect((await store.doc('contacts', contactId).get()).get('relationship')).toBeUndefined();
      await store.doc('contacts', unrelatedId).update({ relationship: null });
      await expect(firestoreOwnerEditorViewSnapshot(store, ownerId, { contactId })).rejects.toThrow(
        'Malformed editor contact',
      );
    } finally {
      await disposeStore(store);
    }
  });
});
