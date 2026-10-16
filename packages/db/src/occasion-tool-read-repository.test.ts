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
    try {
      const configured = await db.select({ id: agents.id }).from(agents).limit(2);
      if (configured.length !== 1 || !configured[0]) throw new Error('Test requires one agent');
      await db.insert(contacts).values({ id: contactId, name: 'Occasion birthday subject' });
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

      const repository = createPostgresOccasionToolReadRepository(db);
      expect(await repository.list(configured[0].id)).toEqual([
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
      ]);
      expect(await repository.list(randomUUID())).toEqual([]);
    } finally {
      await db.delete(occasions).where(eq(occasions.id, occasionId));
      await db.delete(contacts).where(eq(contacts.id, contactId));
      await db.$client.end();
    }
  });
});
