import { getAgent } from '@assistant/core';
import { createDb, type Db, documentChunks, documents, files, tasks } from '@assistant/db';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { AssistantTool, ToolContext } from '../types.js';
import { registerDriveTools, safeAttachmentName } from './drive.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

function tool(registry: ToolRegistry, name: string): AssistantTool {
  const registered = registry.get(name);
  if (!registered) throw new Error(`missing ${name}`);
  return registered.tool;
}

const context = {
  taskId: 'task-1',
  agentId: 'agent-1',
  trust: 'owner',
  tainted: false,
  db: {},
  now: () => new Date(),
  signal: new AbortController().signal,
  log: async () => {},
} as unknown as ToolContext;

describe('Drive attachment tools', () => {
  it('stages a Google Doc as a Workspace PDF without uploading it anywhere', async () => {
    const api = vi.fn(async () => ({
      id: 'doc_1234567890',
      name: 'Baldvin résumé',
      mimeType: 'application/vnd.google-apps.document',
      webViewLink: 'https://docs.google.com/document/d/doc_1234567890/edit',
    }));
    const apiBytes = vi.fn(async () => ({
      body: Buffer.from('%PDF'),
      contentType: 'application/pdf',
    }));
    const writeBytes = vi.fn(async () => ({ bytes: 4 }));
    const registry = registerDriveTools(new ToolRegistry(), {
      client: { api, apiBytes } as never,
      workspace: { writeBytes } as never,
    });

    const result = await tool(registry, 'drive.download').execute(
      { fileId: 'doc_1234567890' },
      context,
    );

    expect(apiBytes).toHaveBeenCalledWith(
      'https://www.googleapis.com/drive/v3/files/doc_1234567890/export?mimeType=application%2Fpdf',
    );
    expect(writeBytes).toHaveBeenCalledWith(
      expect.stringMatching(
        /^browser\/attachments\/[a-f0-9]{64}\/[a-f0-9]{64}\/Baldvin_r_sum_\.pdf$/,
      ),
      Buffer.from('%PDF'),
      'application/pdf',
    );
    expect(result).toMatchObject({
      workspacePath: expect.stringMatching(
        /^browser\/attachments\/[a-f0-9]{64}\/[a-f0-9]{64}\/Baldvin_r_sum_\.pdf$/,
      ),
      exportedAsPdf: true,
      bytes: 4,
    });
  });

  it('preserves immutable staging receipts for changed bytes, colliding names and replays', async () => {
    let body = Buffer.from('first');
    const stored = new Map<string, Buffer>();
    const registry = registerDriveTools(new ToolRegistry(), {
      client: {
        api: vi.fn(async () => ({
          id: 'file_1234567890',
          name: 'same.pdf',
          mimeType: 'application/pdf',
        })),
        apiBytes: vi.fn(async () => ({ body, contentType: 'application/pdf' })),
      } as never,
      workspace: {
        writeBytes: async (key: string, bytes: Buffer) => {
          stored.set(key, bytes);
          return { bytes: bytes.length };
        },
      } as never,
    });
    const execute = () =>
      tool(registry, 'drive.download').execute(
        { fileId: 'file_1234567890', workspacePath: 'browser/attachments/requested.pdf' },
        context,
      ) as Promise<{ workspacePath: string; sha256: string }>;
    const first = await execute();
    body = Buffer.from('second');
    const second = await execute();
    expect(first.workspacePath).not.toBe(second.workspacePath);
    expect(stored.get(first.workspacePath)?.toString()).toBe('first');
    expect(stored.get(second.workspacePath)?.toString()).toBe('second');
    expect(await execute()).toEqual(second);
    expect(stored.size).toBe(2);
  });

  it('sanitizes generated attachment names and preserves safe extensions', () => {
    expect(safeAttachmentName('../../Baldvin résumé.pdf')).toBe('Baldvin_r_sum_.pdf');
    expect(safeAttachmentName('   ')).toBe('attachment');
  });

  it('rejects staging paths outside the browser attachment area', async () => {
    const registry = registerDriveTools(new ToolRegistry(), {
      client: { api: vi.fn(), apiBytes: vi.fn() } as never,
      workspace: { writeBytes: vi.fn() } as never,
    });

    await expect(
      tool(registry, 'drive.download').execute(
        { fileId: 'doc_1234567890', workspacePath: 'browser/profile.tar.enc' },
        context,
      ),
    ).rejects.toThrow(/browser\/attachments/);
  });

  it('rejects an oversized attachment before writing it to Workspace storage', async () => {
    const writeBytes = vi.fn();
    const registry = registerDriveTools(new ToolRegistry(), {
      client: {
        api: vi.fn(async () => ({
          id: 'file_1234567890',
          name: 'oversized.pdf',
          mimeType: 'application/pdf',
        })),
        apiBytes: vi.fn(async () => ({
          body: Buffer.alloc(8 * 1024 * 1024 + 1),
          contentType: 'application/pdf',
        })),
      } as never,
      workspace: { writeBytes } as never,
    });

    await expect(
      tool(registry, 'drive.download').execute({ fileId: 'file_1234567890' }, context),
    ).rejects.toThrow(/exceeds 8 MB/);
    expect(writeBytes).not.toHaveBeenCalled();
  });
});

describe('Drive read + ingest (Phase 24)', () => {
  it('drive.read exports a Google Doc to text and refuses binary types', async () => {
    const registry = registerDriveTools(new ToolRegistry(), {
      client: {
        api: vi.fn(async () => ({
          id: 'doc_1234567890',
          name: 'Project brief',
          mimeType: 'application/vnd.google-apps.document',
        })),
        apiBytes: vi.fn(async () => ({
          body: Buffer.from('The Reykjavik launch is set for March.', 'utf8'),
          contentType: 'text/plain',
        })),
      } as never,
      workspace: { writeBytes: vi.fn() } as never,
    });
    const out = (await tool(registry, 'drive.read').execute(
      { fileId: 'doc_1234567890', maxChars: 20000 },
      context,
    )) as { text: string; mimeType: string };
    expect(out.text).toContain('Reykjavik launch');
    expect(out.mimeType).toBe('application/vnd.google-apps.document');

    const binaryRegistry = registerDriveTools(new ToolRegistry(), {
      client: {
        api: vi.fn(async () => ({ id: 'img_1234567890', name: 'scan.png', mimeType: 'image/png' })),
        apiBytes: vi.fn(),
      } as never,
      workspace: { writeBytes: vi.fn() } as never,
    });
    await expect(
      tool(binaryRegistry, 'drive.read').execute({ fileId: 'img_1234567890' }, context),
    ).rejects.toThrow(/not readable as text/);
  });

  it('continues text exports at their exact UTF-16 boundary and reports the revision', async () => {
    const text = `${'a'.repeat(100)}DECISIVE text tail`;
    const registry = registerDriveTools(new ToolRegistry(), {
      client: {
        api: vi.fn(async () => ({
          id: 'doc_1234567890',
          name: 'Project brief',
          mimeType: 'application/vnd.google-apps.document',
          headRevisionId: 'revision-9',
        })),
        apiBytes: vi.fn(async () => ({ body: Buffer.from(text), contentType: 'text/plain' })),
      } as never,
      workspace: { writeBytes: vi.fn() } as never,
    });
    const first = (await tool(registry, 'drive.read').execute(
      { fileId: 'doc_1234567890', maxChars: 100 },
      context,
    )) as {
      text: string;
      complete: boolean;
      receipt: {
        source: { revision: string };
        continuation: { input: Record<string, unknown> } | null;
      };
    };
    expect(first.text).toHaveLength(100);
    expect(first.complete).toBe(false);
    expect(first.receipt.source.revision).toBe('revision-9');
    const second = (await tool(registry, 'drive.read').execute(
      first.receipt.continuation?.input as never,
      context,
    )) as { text: string; complete: boolean };
    expect(second.text).toBe('DECISIVE text tail');
    expect(second.complete).toBe(true);
  });

  it('registers drive.ingest only when a db is provided', () => {
    const withoutDb = registerDriveTools(new ToolRegistry(), {
      client: { api: vi.fn(), apiBytes: vi.fn() } as never,
      workspace: { writeBytes: vi.fn() } as never,
    });
    expect(withoutDb.get('drive.ingest')).toBeUndefined();
    const withDb = registerDriveTools(new ToolRegistry(), {
      client: { api: vi.fn(), apiBytes: vi.fn() } as never,
      workspace: { writeBytes: vi.fn() } as never,
      catalog: {} as never,
    });
    expect(withDb.get('drive.ingest')).toBeDefined();
  });
});

describe('drive.ingest → document library (integration)', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;

  async function cleanup() {
    const docs = await db
      .select({ id: documents.id })
      .from(documents)
      .where(like(documents.title, 'XTESTDRIVE%'));
    for (const d of docs)
      await db.delete(documentChunks).where(eq(documentChunks.documentId, d.id));
    if (docs.length) {
      await db.delete(documents).where(like(documents.title, 'XTESTDRIVE%'));
      await db.delete(files).where(like(files.workspacePath, 'documents/drive/xtestdrive%'));
      await db.delete(tasks).where(like(tasks.progress, 'extract XTESTDRIVE%'));
    }
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
      await cleanup();
    } catch {
      console.warn('drive.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (dbUp) await cleanup();
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
  });

  it('files a Drive text file as a searchable document with source=drive', async (ctx2) => {
    if (!dbUp) return ctx2.skip();
    const store = new Map<string, Buffer>();
    const registry = registerDriveTools(new ToolRegistry(), {
      client: {
        api: vi.fn(async () => ({
          id: 'xtestdrive0000',
          name: 'XTESTDRIVE notes.txt',
          mimeType: 'text/plain',
          webViewLink: 'https://drive.google.com/file/d/xtestdrive0000',
        })),
        apiBytes: vi.fn(async () => ({
          body: Buffer.from('Quarterly revenue was 4.2 million.', 'utf8'),
          contentType: 'text/plain',
        })),
      } as never,
      workspace: {
        writeBytes: async (p: string, b: Buffer) => {
          store.set(p, b);
          return { bytes: b.length };
        },
        delete: async (p: string) => {
          store.delete(p);
        },
      } as never,
      catalog: db,
    });
    const out = (await tool(registry, 'drive.ingest').execute(
      { fileId: 'xtestdrive0000', title: 'XTESTDRIVE notes' },
      { ...context, agentId } as unknown as ToolContext,
    )) as { documentId: string; duplicate: boolean };
    expect(out.duplicate).toBe(false);

    const [doc] = await db.select().from(documents).where(eq(documents.id, out.documentId));
    expect(doc?.source).toBe('drive');
    expect(doc?.trust).toBe('known');
    expect(doc?.extractor).toBe('text');
    expect(store.size).toBe(1);
  });
  it('exports a native spreadsheet as an immutable all-tab workbook for processing', async (test) => {
    if (!dbUp) return test.skip();
    const bytes = Buffer.from('workbook fixture bytes');
    const apiBytes = vi.fn(async () => ({
      body: bytes,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }));
    const writeBytes = vi.fn(async () => ({ bytes: bytes.length }));
    const registry = registerDriveTools(new ToolRegistry(), {
      client: {
        api: vi.fn(async () => ({
          id: 'xtestdrive0001',
          name: 'XTESTDRIVE multi tab',
          mimeType: 'application/vnd.google-apps.spreadsheet',
        })),
        apiBytes,
      } as never,
      workspace: { writeBytes } as never,
      catalog: db,
    });
    const result = (await tool(registry, 'drive.ingest').execute(
      { fileId: 'xtestdrive0001' },
      { ...context, agentId },
    )) as { documentId: string; stagedWorkspacePath: string };
    expect(apiBytes).toHaveBeenCalledWith(
      'https://www.googleapis.com/drive/v3/files/xtestdrive0001/export?mimeType=application%2Fvnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(result.stagedWorkspacePath).toMatch(
      /documents\/drive\/[a-f0-9]{64}\/[a-f0-9]{64}\/.*\.xlsx$/,
    );
    expect(writeBytes).toHaveBeenCalledWith(
      result.stagedWorkspacePath,
      bytes,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    const [document] = await db.select().from(documents).where(eq(documents.id, result.documentId));
    expect(document).toMatchObject({
      source: 'drive',
      sourceRef: 'xtestdrive0001',
      trust: 'known',
      extractor: 'pending_processor',
      status: 'pending',
    });
  });
});
