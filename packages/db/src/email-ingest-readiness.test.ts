import { randomUUID } from 'node:crypto';
import { emailIngestReadable } from '@assistant/persistence';
import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import { emailIngestReadableSql } from './email-ingest-readiness.js';
import { agents, emailIngest } from './schema.js';

describe('PostgreSQL admitted email readiness parity', () => {
  it('agrees with the portable predicate for completed, admitted and incomplete sources', async () => {
    const db = createDb(
      process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:55432/assistant_test',
    );
    const ids: string[] = [];
    try {
      const [owner] = await db.select({ id: agents.id }).from(agents).limit(1);
      if (!owner) throw new Error('Missing test owner');
      const base = {
        agentId: owner.id,
        fromEmail: 'school@example.test',
        subject: 'School notice',
        contentTrust: 'known',
        category: 'commitment',
        importance: 4,
        actionable: true,
        authenticated: true,
        pipelineStage: 'message_persisted',
        ingestMode: 'direct',
        admittedSourceKind: 'automated_source',
        admittedSourceId: randomUUID(),
        scoreStatus: 'prepared',
      };
      const patches = [
        {},
        { pipelineStage: 'complete' },
        { pipelineStage: 'pending_score' },
        { authenticated: false },
        { ingestMode: 'forwarded' },
        { admittedSourceId: null, admittedSourceKind: null },
        { admittedSourceKind: 'message', messagePersisted: true },
        { admittedSourceKind: 'message', messagePersisted: false },
        { scoreStatus: 'unknown', scoreOutcome: 'fallback_committed_unknown' },
        { scoreStatus: 'unknown', scoreOutcome: 'provider_outcome_unknown' },
      ];
      for (const patch of patches) {
        const id = randomUUID();
        ids.push(id);
        await db
          .insert(emailIngest)
          .values({ ...base, ...patch, id, channelMessageId: `gmail:${id}` });
      }
      const rows = await db.select().from(emailIngest).where(inArray(emailIngest.id, ids));
      const readable = await db
        .select({ id: emailIngest.id })
        .from(emailIngest)
        .where(and(inArray(emailIngest.id, ids), emailIngestReadableSql()));
      expect(readable.map((r) => r.id).sort()).toEqual(
        rows
          .filter(emailIngestReadable)
          .map((r) => r.id)
          .sort(),
      );
    } finally {
      for (const id of ids) await db.delete(emailIngest).where(eq(emailIngest.id, id));
      await db.$client.end();
    }
  });
});
