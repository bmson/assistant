import { randomUUID } from 'node:crypto';
import { agents, createDb, type Db, emailIngest } from '@assistant/db';
import { assertAllocatedTestTarget } from '@assistant/db/test-target';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { assessProactiveHealth } from './pipeline-health.js';

it('counts only the owner’s admitted mail, completed processing and six-hour backlog', async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Allocated test database required');
  assertAllocatedTestTarget({
    databaseUrl,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    token: process.env.ASSISTANT_TEST_TARGET_TOKEN,
  });
  const db = createDb(databaseUrl);
  const ownerId = randomUUID();
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const rows = ids.map((id, i) => ({
    id,
    agentId: ownerId,
    channelMessageId: id,
    category: 'event',
    importance: 4,
    fromEmail: 'school@example.test',
    subject: 'Private fixture subject',
    createdAt: new Date(Date.now() - 8 * 3600_000),
    extractedAt: i === 1 ? new Date() : null,
    pipelineStage: i === 2 ? 'pending_score' : 'complete',
  }));
  // Keep the synthetic owner invisible to other installation-level suites.
  try {
    await db.transaction(async (tx) => {
      await tx.insert(agents).values({
        id: ownerId,
        name: 'Test',
        email: `${ownerId}@example.test`,
        workspacePrefix: ownerId,
      });

      await tx.insert(emailIngest).values(rows);
      const health = await assessProactiveHealth(tx as unknown as Db, ownerId, {
        ingestMode: 'direct',
        googleEnabled: true,
      });
      expect(health).toMatchObject({
        mailReceived7d: 3,
        mailScored7d: 2,
        mailProcessed7d: 1,
        mailAwaitingAdmissionOver6h7d: 1,
        mailPendingOver6h7d: 1,
      });
      expect(JSON.stringify(health)).not.toContain(rows[0]?.subject);
      // Remove the fixture within the same transaction.
      await tx.delete(emailIngest).where(eq(emailIngest.agentId, ownerId));
      await tx.delete(agents).where(eq(agents.id, ownerId));
    });
  } finally {
    await db.$client.end();
  }
});
