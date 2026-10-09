import { randomUUID } from 'node:crypto';
import { createDb, createPostgresProfilePeopleReadRepository } from '@assistant/db';
import { agents, contacts, memories, occasions } from '@assistant/db/schema';
import { FirestoreProfilePeopleReadRepository } from '@assistant/firestore';
import type { ProfileContact, ProfileFact } from '@assistant/persistence';
import { Timestamp } from '@google-cloud/firestore';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getOwnerFactsView,
  getPersonProfile,
} from '../packages/application/src/profile/queries.js';
import { encodeRecord, type InstallationStore } from '../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../packages/firestore/src/test-store.js';
import { firestoreProfilePeopleSmoke } from './firestore-profile-people-smoke.js';

const now = new Date('2026-09-22T12:00:00.000Z');
const rolledBack = Symbol('transaction rolled back');

function contact(id: string, name: string, trust = 'known'): ProfileContact {
  return {
    id,
    name,
    trust,
    aliases: [],
    emails: [],
    phones: [],
    relationship: '',
    notes: '',
    createdAt: new Date('2026-09-20T09:08:07.123Z'),
    updatedAt: new Date('2026-09-20T09:08:07.123Z'),
  };
}

function fact(
  id: string,
  agentId: string,
  contactId: string,
  patch: Partial<ProfileFact> = {},
): ProfileFact {
  return {
    id,
    agentId,
    category: 'knowledge',
    kind: 'fact',
    content: `Fact ${id}`,
    contentHash: randomUUID(),
    embedding: null,
    importance: 3,
    confidence: '0.70',
    originTrust: 'owner',
    quarantined: false,
    subjectContactId: contactId,
    domain: null,
    validFrom: new Date('2026-01-02T03:04:05.678Z'),
    validUntil: null,
    supersededById: null,
    ownerConfirmed: false,
    pinned: false,
    source: null,
    sourceTaskId: null,
    goalId: null,
    lastAccessedAt: null,
    lastConsolidatedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-09-21T10:11:12.345Z'),
    ...patch,
    embeddingSpaceKey: patch.embeddingSpaceKey ?? null,
  };
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('profile people read parity', () => {
  let store: InstallationStore | undefined;

  afterEach(async () => {
    if (store) await disposeStore(store);
    store = undefined;
  });

  it('exercises the real-cloud profile index workload on the emulator', async () => {
    store = emulatorStore(() => now);
    await expect(firestoreProfilePeopleSmoke(store)).resolves.toEqual({ facts: 1, occasions: 1 });
  });

  it('matches PostgreSQL for ordered facts, exact totals, all contacts, and occasion dates', async () => {
    const db = createDb(
      process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant_test',
    );
    store = emulatorStore(() => now);
    const installation = store;
    const personId = randomUUID();
    const foreignAgentId = randomUUID();
    try {
      const [agent] = await db.select().from(agents).orderBy(agents.createdAt).limit(1);
      if (!agent) throw new Error('The PostgreSQL test database needs a seeded agent');
      const [owner] = await db.select().from(contacts).where(eq(contacts.trust, 'owner')).limit(1);
      if (!owner) throw new Error('The PostgreSQL test database needs a seeded owner');
      const existing = await db.select().from(contacts);
      const extras = Array.from({ length: 505 }, (_, index) =>
        contact(randomUUID(), `Parity person ${String(index).padStart(3, '0')}`),
      );
      const person = contact(personId, 'Parity target');
      const owned = [
        fact(randomUUID(), agent.id, personId, { pinned: true, importance: 5, confidence: '0.91' }),
        fact(randomUUID(), agent.id, personId, { importance: 4, confidence: '0.82' }),
        fact(randomUUID(), agent.id, personId, { importance: 2, confidence: '0.73' }),
      ];
      const preciseEarly = fact('00000000-0000-4000-8000-000000000222', agent.id, personId, {
        importance: 1,
      });
      const preciseLate = fact('00000000-0000-4000-8000-000000000111', agent.id, personId, {
        importance: 1,
      });
      const overflowFacts = [
        preciseEarly,
        preciseLate,
        ...Array.from({ length: 203 }, () =>
          fact(randomUUID(), agent.id, personId, { importance: 1 }),
        ),
      ];
      const excluded = [
        fact(randomUUID(), foreignAgentId, personId),
        fact(randomUUID(), agent.id, personId, { quarantined: true }),
        fact(randomUUID(), agent.id, personId, { expiresAt: now }),
        fact(randomUUID(), agent.id, personId, { category: 'experience' }),
      ];
      const ownerFact = fact(randomUUID(), agent.id, owner.id, { pinned: true });
      const foreignOwnerFact = fact(randomUUID(), foreignAgentId, owner.id);
      const occasion = {
        id: randomUUID(),
        agentId: agent.id,
        contactId: personId,
        kind: 'birthday',
        label: '',
        month: 3,
        day: 14,
        year: 1992,
        recurrence: 'annual',
        leadDays: 7,
        notes: 'Cake',
        originTrust: 'owner',
        quarantined: false,
        ownerConfirmed: true,
        source: null,
        createdAt: new Date('2026-09-21T01:02:03.456Z'),
        updatedAt: new Date('2026-09-21T01:02:03.456Z'),
      };

      const allContacts = [...existing, ...extras, person];
      for (let offset = 0; offset < allContacts.length; offset += 200) {
        const batch = installation.db.batch();
        for (const row of allContacts.slice(offset, offset + 200))
          batch.set(installation.doc('contacts', row.id), encodeRecord(row));
        await batch.commit();
      }
      const batch = installation.db.batch();
      for (const row of [...owned, ...overflowFacts, ...excluded, ownerFact, foreignOwnerFact]) {
        const value = encodeRecord(row);
        const timestamp =
          row.id === preciseEarly.id
            ? new Timestamp(Math.floor(row.createdAt.getTime() / 1000), 345_456_000)
            : row.id === preciseLate.id
              ? new Timestamp(Math.floor(row.createdAt.getTime() / 1000), 345_789_000)
              : row.createdAt;
        batch.set(installation.doc('memories', row.id), { ...value, createdAt: timestamp });
      }
      batch.set(installation.doc('occasions', occasion.id), encodeRecord(occasion));
      await batch.commit();

      try {
        await db.transaction(async (tx) => {
          await tx.insert(agents).values({
            id: foreignAgentId,
            name: 'Parity foreign agent',
            email: `${foreignAgentId}@example.test`,
            workspacePrefix: `test/${foreignAgentId}`,
          });
          await tx.insert(contacts).values([...extras, person]);
          await tx
            .insert(memories)
            .values([...owned, ...overflowFacts, ...excluded, ownerFact, foreignOwnerFact]);
          await tx.execute(
            sql`update memories set created_at = '2026-09-21T10:11:12.345456Z'::timestamptz where id = ${preciseEarly.id}`,
          );
          await tx.execute(
            sql`update memories set created_at = '2026-09-21T10:11:12.345789Z'::timestamptz where id = ${preciseLate.id}`,
          );
          await tx.insert(occasions).values(occasion);

          const pg = createPostgresProfilePeopleReadRepository(tx as never, agent.id, () => now);
          const fs = new FirestoreProfilePeopleReadRepository(installation, agent.id);
          const [pgPerson, fsPerson, pgOwner, fsOwner] = await Promise.all([
            getPersonProfile(pg, personId, 2),
            getPersonProfile(fs, personId, 2),
            getOwnerFactsView(pg),
            getOwnerFactsView(fs),
          ]);
          expect(fsPerson).toEqual(pgPerson);
          expect(await getPersonProfile(tx as never, personId, 2)).toEqual(pgPerson);
          expect(fsPerson?.totalFacts).toBe(208);
          const [allPgFacts, allFsFacts] = await Promise.all([
            pg.getFacts(personId, 210),
            fs.getFacts(personId, 210),
          ]);
          expect(allFsFacts.rows.map((row) => row.id)).toEqual(
            allPgFacts.rows.map((row) => row.id),
          );
          expect(allFsFacts.rows).toHaveLength(208);
          expect(allFsFacts.rows.slice(3, 5).map((row) => row.id)).toEqual([
            preciseLate.id,
            preciseEarly.id,
          ]);
          expect(fsPerson?.facts.map((row) => row.id)).toEqual(
            owned.slice(0, 2).map((row) => row.id),
          );
          expect(fsPerson?.mergeOptions.length).toBeGreaterThan(500);
          expect(fsPerson?.facts[0]?.validFrom).toEqual(owned[0]?.validFrom);
          expect(fsPerson?.facts[0]?.createdAt).toEqual(owned[0]?.createdAt);
          expect(fsPerson?.occasions[0]?.year).toBe(1992);
          expect(fsOwner.ownerFacts.map((row) => row.id)).toEqual(
            pgOwner.ownerFacts.map((row) => row.id),
          );
          expect(await getOwnerFactsView(tx as never)).toEqual(pgOwner);
          expect(fsOwner.ownerFacts.map((row) => row.id)).toContain(ownerFact.id);
          expect(fsOwner.ownerFacts.map((row) => row.id)).not.toContain(foreignOwnerFact.id);
          expect(await fs.getOwnerCard()).toBeNull();
          const compiledAt = new Date('2026-09-21T23:59:58.321Z');
          await installation.doc('ownerCards', agent.id).set({
            agentId: agent.id,
            content: 'Exact owner card',
            compiledAt,
          });
          expect((await getOwnerFactsView(fs)).card).toEqual({
            content: 'Exact owner card',
            compiledAt,
          });
          expect((await fs.listOccasions(personId))[0]?.createdAt).toEqual(occasion.createdAt);
          throw rolledBack;
        });
      } catch (error) {
        if (error !== rolledBack) throw error;
      }
    } finally {
      await db.$client.end();
    }
  }, 120_000);
});
