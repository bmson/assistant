import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import { createPostgresOccasionToolReadRepository } from './occasion-tool-read-repository.js';
import { agents, contacts, occasions } from './schema.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:55432/assistant_test';

describe('PostgreSQL occasion tool read repository', () => {
  it('joins birthday identity and trust state within the requested owner scope', async () => {
    const db = createDb(DATABASE_URL);
    const contactId = randomUUID();
    const occasionId = randomUUID();
    const unrelatedContactId = randomUUID();
    const unrelatedOccasionId = randomUUID();
    try {
      const configured = await db.select({ id: agents.id }).from(agents).limit(2);
      if (configured.length !== 1 || !configured[0]) throw new Error('Test requires one agent');
      await db.insert(contacts).values({ id: contactId, name: 'Occasion birthday subject' });
      await db
        .insert(contacts)
        .values({ id: unrelatedContactId, name: 'Unrelated private contact' });
      await db.insert(occasions).values({
        id: occasionId,
        agentId: configured[0].id,
        contactId,
        kind: 'birthday',
        month: 3,
        day: 4,
        year: 2001,
        recurrence: 'annual',
        notes: 'must not be exposed by the private fact tool',
        ownerConfirmed: true,
      });
      await db.insert(occasions).values({
        id: unrelatedOccasionId,
        agentId: configured[0].id,
        contactId: unrelatedContactId,
        kind: 'birthday',
        month: 8,
        day: 9,
        year: null,
        recurrence: 'annual',
        ownerConfirmed: true,
      });

      const repository = createPostgresOccasionToolReadRepository(db);
      expect(await repository.list(configured[0].id)).toEqual(
        expect.arrayContaining([
          {
            id: unrelatedOccasionId,
            contactId: unrelatedContactId,
            contactName: 'Unrelated private contact',
            kind: 'birthday',
            label: '',
            month: 8,
            day: 9,
            year: null,
            recurrence: 'annual',
            leadDays: 7,
            notes: '',
            originTrust: 'owner',
            quarantined: false,
            ownerConfirmed: true,
          },
          {
            id: occasionId,
            contactId,
            contactName: 'Occasion birthday subject',
            kind: 'birthday',
            label: '',
            month: 3,
            day: 4,
            year: 2001,
            recurrence: 'annual',
            leadDays: 7,
            notes: '',
            originTrust: 'owner',
            quarantined: false,
            ownerConfirmed: true,
          },
        ]),
      );
      const scoped = await repository.listBirthdays({
        agentId: configured[0].id,
        contactIds: [contactId],
        limit: 40,
      });
      expect(scoped).toEqual({
        rows: [
          expect.objectContaining({
            id: occasionId,
            contactId,
            contactName: 'Occasion birthday subject',
            kind: 'birthday',
            ownerConfirmed: true,
            quarantined: false,
            notes: '',
          }),
        ],
        overflow: false,
      });
      expect(JSON.stringify(scoped)).not.toContain('Unrelated private contact');
      expect(await repository.list(randomUUID())).toEqual([]);
      expect(
        await repository.listBirthdays({ agentId: configured[0].id, contactIds: [], limit: 40 }),
      ).toEqual({ rows: [], overflow: false });
    } finally {
      await db.delete(occasions).where(eq(occasions.id, occasionId));
      await db.delete(occasions).where(eq(occasions.id, unrelatedOccasionId));
      await db.delete(contacts).where(eq(contacts.id, contactId));
      await db.delete(contacts).where(eq(contacts.id, unrelatedContactId));
      await db.$client.end();
    }
  });

  it('reports a bounded overflow for birthday rows matching the requested identities', async () => {
    const db = createDb(DATABASE_URL);
    const contactId = randomUUID();
    const ids = Array.from({ length: 41 }, () => randomUUID());
    try {
      const configured = await db.select({ id: agents.id }).from(agents).limit(2);
      if (configured.length !== 1 || !configured[0]) throw new Error('Test requires one agent');
      const agentId = configured[0].id;
      await db.insert(contacts).values({ id: contactId, name: 'Overflow birthday subject' });
      await db.insert(occasions).values(
        ids.map((id, index) => ({
          id,
          agentId,
          contactId,
          kind: 'birthday' as const,
          month: (index % 12) + 1,
          day: (index % 27) + 1,
          recurrence: 'annual' as const,
          ownerConfirmed: true,
        })),
      );

      const result = await createPostgresOccasionToolReadRepository(db).listBirthdays({
        agentId,
        contactIds: [contactId],
        limit: 40,
      });
      expect(result.rows).toHaveLength(40);
      expect(result.overflow).toBe(true);
      expect(result.rows.every((row) => row.contactId === contactId)).toBe(true);
    } finally {
      await db.delete(occasions).where(eq(occasions.contactId, contactId));
      await db.delete(contacts).where(eq(contacts.id, contactId));
      await db.$client.end();
    }
  });
});
