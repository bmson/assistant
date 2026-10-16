import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FirestoreOccasionToolRepository } from './occasion-tools.js';
import { documentKey, type InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

type Row = Record<string, unknown>;

function birthdayRow(id: string, contactId: string, overrides: Row = {}): Row {
  return {
    id,
    agentId: 'owner-a',
    contactId,
    kind: 'birthday',
    label: '',
    month: 3,
    day: 4,
    year: null,
    recurrence: 'annual',
    leadDays: 7,
    notes: 'private notes must not be read',
    originTrust: 'owner',
    quarantined: false,
    ownerConfirmed: true,
    ...overrides,
  };
}

function fakeStore(occasionRows: Row[], contacts: Row[]) {
  const conditions: Array<[string, string, unknown]> = [];
  const selected: string[][] = [];
  const contactReads: string[] = [];
  let queryCount = 0;
  let requestedLimit = 0;
  const matching = () =>
    occasionRows.filter((row) =>
      conditions.every(([field, operator, value]) =>
        operator === 'in'
          ? Array.isArray(value) && value.includes(row[field])
          : row[field] === value,
      ),
    );
  const query = {
    where(field: string, operator: string, value: unknown) {
      conditions.push([field, operator, value]);
      return this;
    },
    select(...fields: string[]) {
      selected.push(fields);
      return this;
    },
    limit(value: number) {
      requestedLimit = value;
      return this;
    },
    async get() {
      queryCount += 1;
      return {
        size: Math.min(matching().length, requestedLimit),
        docs: matching()
          .slice(0, requestedLimit)
          .map((row) => ({ id: documentKey(String(row.id)), data: () => row })),
      };
    },
  };
  const store = {
    collection: vi.fn(() => query),
    doc: vi.fn((collection: string, id: string) => ({ collection, id })),
    db: {
      getAll: vi.fn(async (...refs: Array<{ collection: string; id: string }>) => {
        if (refs.length === 0) throw new Error('getAll requires at least one document reference');
        contactReads.push(...refs.map((ref) => ref.id));
        return refs.map((ref) => {
          const contact = contacts.find((row) => row.id === ref.id);
          return {
            id: documentKey(ref.id),
            exists: Boolean(contact),
            data: () => contact,
          };
        });
      }),
    },
  } as unknown as InstallationStore;
  return {
    store,
    contactReads,
    queryCount: () => queryCount,
    requestedLimit: () => requestedLimit,
    selected,
    conditions,
  };
}

describe('Firestore bounded birthday occasion reads', () => {
  it('filters by owner, requested IDs, confirmed annual birthdays and resolves only matched names', async () => {
    const storeFixture = fakeStore(
      [
        birthdayRow('occasion-a', 'contact-a'),
        birthdayRow('occasion-unrelated', 'contact-b'),
        birthdayRow('occasion-unconfirmed', 'contact-a', { ownerConfirmed: false }),
        birthdayRow('occasion-anniversary', 'contact-a', { kind: 'anniversary' }),
      ],
      [
        { id: 'contact-a', name: 'Alex', agentId: 'owner-a' },
        { id: 'contact-b', name: 'Unrelated private name', agentId: 'owner-a' },
      ],
    );
    const repository = new FirestoreOccasionToolRepository(storeFixture.store, 'owner-a');

    const result = await repository.listBirthdays({
      agentId: 'owner-a',
      contactIds: ['contact-a'],
      limit: 40,
    });

    expect(result).toMatchObject({
      overflow: false,
      rows: [
        {
          id: 'occasion-a',
          contactId: 'contact-a',
          contactName: 'Alex',
          kind: 'birthday',
          ownerConfirmed: true,
          notes: '',
        },
      ],
    });
    expect(storeFixture.conditions).toEqual(
      expect.arrayContaining([
        ['agentId', '==', 'owner-a'],
        ['contactId', 'in', ['contact-a']],
        ['kind', '==', 'birthday'],
        ['recurrence', '==', 'annual'],
        ['ownerConfirmed', '==', true],
        ['quarantined', '==', false],
      ]),
    );
    expect(storeFixture.requestedLimit()).toBe(41);
    expect(storeFixture.contactReads).toEqual(['contact-a']);
    expect(storeFixture.selected[0]).not.toContain('notes');
    expect(JSON.stringify(result)).not.toContain('Unrelated private name');
  });

  it('bounds results and reports overflow', async () => {
    const rows = Array.from({ length: 4 }, (_, index) =>
      birthdayRow(`occasion-${index}`, 'contact-a'),
    );
    const storeFixture = fakeStore(rows, [{ id: 'contact-a', name: 'Alex', agentId: 'owner-a' }]);
    const repository = new FirestoreOccasionToolRepository(storeFixture.store, 'owner-a');

    const result = await repository.listBirthdays({
      agentId: 'owner-a',
      contactIds: ['contact-a'],
      limit: 3,
    });

    expect(result.rows).toHaveLength(3);
    expect(result.overflow).toBe(true);
    expect(storeFixture.requestedLimit()).toBe(4);
  });

  it('performs no Firestore query or contact read when the identity set is empty', async () => {
    const storeFixture = fakeStore([], []);
    const repository = new FirestoreOccasionToolRepository(storeFixture.store, 'owner-a');

    await expect(
      repository.listBirthdays({ agentId: 'owner-a', contactIds: [], limit: 40 }),
    ).resolves.toEqual({ rows: [], overflow: false });
    expect(storeFixture.queryCount()).toBe(0);
    expect(storeFixture.store.db.getAll).not.toHaveBeenCalled();
  });

  it('does not call getAll with zero references when a nonempty identity has no birthdays', async () => {
    const storeFixture = fakeStore([], []);
    const repository = new FirestoreOccasionToolRepository(storeFixture.store, 'owner-a');

    await expect(
      repository.listBirthdays({ agentId: 'owner-a', contactIds: ['contact-a'], limit: 40 }),
    ).resolves.toEqual({ rows: [], overflow: false });
    expect(storeFixture.queryCount()).toBe(1);
    expect(storeFixture.store.db.getAll).not.toHaveBeenCalled();
  });
});

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore birthday occasion query against the SDK',
  () => {
    it('executes the indexed query and returns empty for a nonempty unmatched identity', async () => {
      const store = emulatorStore();
      const agentId = randomUUID();
      const contactId = randomUUID();
      const occasionId = randomUUID();
      await store.doc('contacts', contactId).set({ id: contactId, agentId, name: 'SDK birthday' });
      await store.doc('occasions', occasionId).set({
        id: occasionId,
        agentId,
        contactId,
        kind: 'birthday',
        label: '',
        month: 5,
        day: 6,
        year: null,
        recurrence: 'annual',
        leadDays: 7,
        notes: 'not selected by the query',
        originTrust: 'owner',
        quarantined: false,
        ownerConfirmed: true,
      });

      try {
        const repository = new FirestoreOccasionToolRepository(store, agentId);
        await expect(
          repository.listBirthdays({ agentId, contactIds: [contactId], limit: 40 }),
        ).resolves.toMatchObject({
          overflow: false,
          rows: [
            {
              id: occasionId,
              contactId,
              contactName: 'SDK birthday',
              kind: 'birthday',
              month: 5,
              day: 6,
              notes: '',
            },
          ],
        });
        await expect(
          repository.listBirthdays({ agentId, contactIds: [randomUUID()], limit: 40 }),
        ).resolves.toEqual({ rows: [], overflow: false });
      } finally {
        await disposeStore(store);
      }
    });
  },
);
