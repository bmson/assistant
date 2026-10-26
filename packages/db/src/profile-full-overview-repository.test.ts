import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresProfileOverviewRepository } from './profile-full-overview-repository.js';
import { createPostgresProfilePeopleReadRepository } from './profile-people-read-repository.js';
import { agents, contacts, memories, ownerCard } from './schema.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:55432/assistant_test';

describe('PostgreSQL full Profile overview', () => {
  it('projects active owner facts and exact people counts through the shared read', async () => {
    const db = createDb(DATABASE_URL);
    const rollback = new Error('test rollback');
    try {
      await expect(
        db.transaction(async (tx) => {
          const repository = createPostgresProfileOverviewRepository(tx as unknown as Db);
          const before = await repository.load();
          const configured = await tx.select({ id: agents.id }).from(agents).limit(2);
          if (!configured[0] || !before.owner) throw new Error('Test seed is incomplete');
          const agentId = configured[0].id;
          const personId = randomUUID();
          await tx.insert(contacts).values({
            id: personId,
            name: 'Profile test person',
            trust: 'known',
            relationship: 'friend',
          });
          const ownerFactId = randomUUID();
          await tx.insert(memories).values([
            {
              id: ownerFactId,
              agentId,
              category: 'knowledge',
              kind: 'fact',
              content: 'Owner fact',
              contentHash: randomUUID(),
              subjectContactId: before.owner.id,
              pinned: true,
              importance: 5,
            },
            {
              id: randomUUID(),
              agentId,
              category: 'knowledge',
              kind: 'fact',
              content: 'Person fact',
              contentHash: randomUUID(),
              subjectContactId: personId,
            },
            {
              id: randomUUID(),
              agentId,
              category: 'knowledge',
              kind: 'fact',
              content: 'Expired person fact',
              contentHash: randomUUID(),
              subjectContactId: personId,
              expiresAt: new Date('2020-01-01T00:00:00Z'),
            },
          ]);
          const compiledAt = new Date('2026-09-22T12:00:00Z');
          await tx
            .insert(ownerCard)
            .values({ id: 1, content: 'Compiled owner card', compiledAt })
            .onConflictDoUpdate({
              target: ownerCard.id,
              set: { content: 'Compiled owner card', compiledAt },
            });
          const after = await repository.load();
          const projectedPerson = after.people.find((row) => row.contact.id === personId);
          expect(projectedPerson).toMatchObject({
            factCount: 1,
          });
          expect(projectedPerson?.contact.identityRevision).toMatch(/^[0-9a-f]{64}$/);
          const dossier = await createPostgresProfilePeopleReadRepository(
            tx as unknown as Db,
            agentId,
          ).getContact(personId);
          expect(dossier?.identityRevision).toBe(projectedPerson?.contact.identityRevision);
          expect(after.ownerFacts.some((fact) => fact.id === ownerFactId)).toBe(true);
          expect(after.memoryHealth.totalUsable).toBe(before.memoryHealth.totalUsable + 2);
          expect(after.card).toEqual({ content: 'Compiled owner card', compiledAt });
          expect(after.voiceStats).toEqual(before.voiceStats);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await db.$client.end();
    }
  });

  /**
   * The mobile workspace endpoint (Memory and All chats on iOS) reads this
   * overview. A real owner has thousands of facts about themselves, so the
   * view must show the highest-priority slice rather than reject the read —
   * throwing here turned the whole endpoint into a 500.
   */
  it('returns the highest-priority owner facts and people when counts exceed the view limits', async () => {
    const db = createDb(DATABASE_URL);
    const rollback = new Error('test rollback');
    try {
      await expect(
        db.transaction(async (tx) => {
          const repository = createPostgresProfileOverviewRepository(tx as unknown as Db);
          const before = await repository.load();
          const configured = await tx.select({ id: agents.id }).from(agents).limit(2);
          if (!configured[0] || !before.owner) throw new Error('Test seed is incomplete');
          const agentId = configured[0].id;
          const ownerId = before.owner.id;
          const pinnedId = randomUUID();
          const lowestId = randomUUID();
          await tx.insert(memories).values(
            Array.from({ length: 300 }, (_, index) => ({
              id: index === 0 ? pinnedId : index === 1 ? lowestId : randomUUID(),
              agentId,
              category: 'knowledge' as const,
              kind: 'fact',
              content: `Owner fact ${index}`,
              contentHash: randomUUID(),
              subjectContactId: ownerId,
              pinned: index === 0,
              importance: index === 1 ? 0 : 3,
            })),
          );
          // Sorts ahead of any seeded name so the owner falls outside the page.
          await tx.insert(contacts).values(
            Array.from({ length: 501 }, (_, index) => ({
              id: randomUUID(),
              name: `  Profile limit person ${String(index).padStart(3, '0')}`,
              trust: 'known' as const,
              relationship: 'friend',
            })),
          );

          const after = await repository.load();
          expect(after.owner?.id).toBe(ownerId);
          expect(after.owner?.identityRevision).toMatch(/^[0-9a-f]{64}$/);
          expect(after.ownerFacts).toHaveLength(250);
          expect(after.ownerFacts[0]?.id).toBe(pinnedId);
          expect(after.ownerFacts.map((fact) => fact.id)).not.toContain(lowestId);
          expect(after.people.length).toBeLessThanOrEqual(500);
          expect(after.people.some((row) => row.contact.id === ownerId)).toBe(false);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await db.$client.end();
    }
  });
});
