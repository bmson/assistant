/** Read-only inventory of manifest-attributed records in a disposable QA installation. */
import { contacts, conversations, memories } from '@assistant/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { listVisualQaManifests } from './fixture-runs.js';
import { openQaInstallation } from './qa-installation.js';

if (process.argv.length !== 2) throw new Error('The QA inventory takes no arguments.');
const { db, target } = await openQaInstallation().catch(() => {
  throw new Error('Could not open a verified disposable QA installation.');
});
try {
  const manifests = (await listVisualQaManifests()).filter(
    (manifest) =>
      manifest.schemaVersion === 1 &&
      manifest.targetDatabaseName === target.databaseName &&
      manifest.targetToken === target.token &&
      manifest.status !== 'cleaned',
  );
  const counts = await db.transaction(
    async (tx) => {
      const chats = new Set<string>();
      const notes = new Set<string>();
      const people = new Set<string>();
      for (const { ids, agentId, provenance, runId } of manifests) {
        if (ids.conversationCreated && ids.conversationId) {
          const rows = await tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(
                eq(conversations.id, ids.conversationId),
                eq(conversations.agentId, agentId),
                eq(conversations.isPrimary, false),
                sql`${conversations.metadata} ->> 'visualQaRunId' = ${runId}`,
                sql`${conversations.metadata} ->> 'targetDatabaseName' = ${target.databaseName}`,
              ),
            );
          for (const row of rows) chats.add(row.id);
        }
        if (ids.memoryIds?.length) {
          const rows = await tx
            .select({ id: memories.id, contentHash: memories.contentHash })
            .from(memories)
            .where(and(inArray(memories.id, ids.memoryIds), eq(memories.agentId, agentId)));
          for (const row of rows) {
            if (
              row.contentHash &&
              row.contentHash === ids.memoryContentHashes?.[ids.memoryIds.indexOf(row.id)]
            )
              notes.add(row.id);
          }
        }
        if (ids.contactIds?.length && provenance.contactNotes) {
          const rows = await tx
            .select({ id: contacts.id })
            .from(contacts)
            .where(
              and(
                inArray(contacts.id, ids.contactIds),
                eq(contacts.notes, provenance.contactNotes),
              ),
            );
          for (const row of rows) people.add(row.id);
        }
      }
      return { chats: chats.size, memories: notes.size, people: people.size };
    },
    { accessMode: 'read only', isolationLevel: 'repeatable read' },
  );
  console.log(JSON.stringify({ mode: 'dry-run', ...counts, documents: 'untracked' }));
} catch {
  // Database or manifest errors can contain data values. Keep the report redacted.
  console.error('Could not inventory the dedicated QA installation.');
  process.exitCode = 1;
} finally {
  await db.$client.end({ timeout: 5 });
}
