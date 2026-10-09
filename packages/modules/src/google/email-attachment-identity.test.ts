import { createHash, randomUUID } from 'node:crypto';
import { agents, createDb, documentChunks, documents, files, tasks } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { type EmailSyncDeps, fileMessageAttachments } from './email-sync.js';

it('preserves catalog bytes for same-named, sanitized-colliding, identical and replayed email attachments', async () => {
  const url = process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  const db = createDb(url),
    agentId = randomUUID();
  const objects = new Map<string, Buffer>();
  const data: Record<string, string> = {
    first: `First ${agentId}`,
    second: `Second ${agentId}`,
    identical: `First ${agentId}`,
  };
  const remove = vi.fn(async (key: string) => {
    objects.delete(key);
  });
  const deps = {
    db,
    persistence: {},
    config: { ASSISTANT_MODULES: ['documents', 'google'], GMAIL_SYNC_ENABLED: 'true' },
    googleClient: {
      api: async (url: string) => ({
        data: Buffer.from(data[url.split('/').at(-1) ?? ''] ?? '').toString('base64url'),
      }),
    },
    workspace: {
      writeBytes: async (key: string, bytes: Buffer) => {
        objects.set(key, bytes);
        return { bytes: bytes.length };
      },
      delete: remove,
    },
  } as unknown as EmailSyncDeps;
  const message = {
    id: `same-mail-${agentId}`,
    threadId: 'thread',
    payload: {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'text/plain',
          filename: 'same ?.txt',
          body: { attachmentId: 'first', size: 20 },
        },
        {
          mimeType: 'text/plain',
          filename: 'same !.txt',
          body: { attachmentId: 'second', size: 20 },
        },
        {
          mimeType: 'text/plain',
          filename: 'same ?.txt',
          body: { attachmentId: 'identical', size: 20 },
        },
      ],
    },
  };
  try {
    await db.insert(agents).values({
      id: agentId,
      name: 'Attachment identity',
      email: `${agentId}@example.test`,
      workspacePrefix: `attachments-${agentId}`,
    });
    await fileMessageAttachments(deps, { agentId, message, trust: 'known' });
    await Promise.all(
      Array.from({ length: 4 }, () =>
        fileMessageAttachments(deps, { agentId, message, trust: 'known' }),
      ),
    );
    const catalog = await db.select().from(documents).where(eq(documents.agentId, agentId));
    expect(catalog).toHaveLength(2);
    const storedFiles = await db.select().from(files).where(eq(files.agentId, agentId));
    expect(storedFiles).toHaveLength(2);
    for (const file of storedFiles) {
      const bytes = objects.get(file.workspacePath);
      expect(bytes).toBeDefined();
      expect(
        createHash('sha256')
          .update(bytes ?? Buffer.alloc(0))
          .digest('hex'),
      ).toBe(file.sha256);
      expect(catalog.find((document) => document.fileId === file.id)?.sha256).toBe(file.sha256);
    }
    expect(new Set(storedFiles.map((file) => file.workspacePath)).size).toBe(2);
    expect(remove).not.toHaveBeenCalled();
  } finally {
    const rows = await db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.agentId, agentId));
    for (const row of rows)
      await db.delete(documentChunks).where(eq(documentChunks.documentId, row.id));
    await db.delete(tasks).where(eq(tasks.agentId, agentId));
    await db.delete(documents).where(eq(documents.agentId, agentId));
    await db.delete(files).where(eq(files.agentId, agentId));
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.$client.end();
  }
});
