import { randomUUID } from 'node:crypto';
import { getAgent } from '@assistant/core/chat';
import { agents, createDb, documentChunks, documents, files } from '@assistant/db';
import { DocumentChunkCursorStaleError } from '@assistant/persistence';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDocument } from './documents.js';

const databaseUrl = process.env.DATABASE_URL;
function testUrl() {
  if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return databaseUrl;
}

describe('PostgreSQL document detail pagination', () => {
  const db = createDb(testUrl());
  const documentIds: string[] = [];
  const fileIds: string[] = [];
  const chunkIds: string[] = [];
  const foreignAgentId = randomUUID();
  let agentId = '';

  beforeAll(async () => {
    agentId = (await getAgent(db)).id;
    await db.insert(agents).values({
      id: foreignAgentId,
      name: 'Foreign document owner',
      email: `${foreignAgentId}@documents.invalid`,
      workspacePrefix: `documents/${foreignAgentId}`,
    });
  });

  afterAll(async () => {
    if (chunkIds.length)
      await db.delete(documentChunks).where(inArray(documentChunks.id, chunkIds));
    if (documentIds.length) await db.delete(documents).where(inArray(documents.id, documentIds));
    if (fileIds.length) await db.delete(files).where(inArray(files.id, fileIds));
    await db.delete(agents).where(eq(agents.id, foreignAgentId));
    await db.$client.end();
  });

  async function makeDocument(ownerId: string, count: number, title: string, textSize = 80) {
    const fileId = randomUUID();
    const documentId = randomUUID();
    fileIds.push(fileId);
    documentIds.push(documentId);
    await db.insert(files).values({
      id: fileId,
      agentId: ownerId,
      workspacePath: `documents/${documentId}.txt`,
      mime: 'text/plain',
      bytes: count * textSize,
    });
    await db.insert(documents).values({
      id: documentId,
      agentId: ownerId,
      fileId,
      title,
      mime: 'text/plain',
      source: 'upload',
      trust: 'owner',
      sha256: randomUUID().replaceAll('-', '').padEnd(64, 'a'),
      status: 'ready',
      extractor: 'test',
      chunkCount: count,
      charCount: count * textSize,
    });
    const values = Array.from({ length: count }, (_, chunkIndex) => {
      const id = randomUUID();
      chunkIds.push(id);
      return {
        id,
        agentId: ownerId,
        documentId,
        chunkIndex,
        text: `${String(chunkIndex).padStart(5, '0')}:${'x'.repeat(Math.max(0, textSize - 6))}`,
        charCount: textSize,
      };
    });
    for (let index = 0; index < values.length; index += 500) {
      await db.insert(documentChunks).values(values.slice(index, index + 500));
    }
    return documentId;
  }

  it.each([1_000, 1_001, 4_000])('reads %i chunks in stable bounded pages', async (count) => {
    const documentId = await makeDocument(agentId, count, `Large ${count}`);
    let cursor: number | import('@assistant/persistence').DocumentChunkPageCursor | undefined;
    const seen: number[] = [];
    let pages = 0;
    do {
      const page = await getDocument(db, documentId, { cursor, limit: 100 });
      expect(page?.document.chunkCount).toBe(count);
      expect(page?.totalChunks).toBe(count);
      expect(page?.chunks.length).toBeLessThanOrEqual(100);
      expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(
        128 * 1024,
      );
      seen.push(...(page?.chunks.map((chunk) => chunk.chunkIndex) ?? []));
      cursor = page?.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined);

    expect(seen).toEqual(Array.from({ length: count }, (_, index) => index));
    expect(pages).toBe(Math.ceil(count / 100));
  });

  it('keeps metadata available and fragments passages to the response byte budget', async () => {
    const documentId = await makeDocument(agentId, 20, 'Bounded page', 700);
    const page = await getDocument(db, documentId, {
      cursor: 0,
      limit: 100,
      maxResponseBytes: 4_096,
    });
    expect(page?.document.title).toBe('Bounded page');
    expect(page?.chunks.length).toBeGreaterThan(0);
    expect(page?.chunks.length).toBeLessThan(20);
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(4_096);
    expect(page?.nextCursor).toBe(page?.chunks.length);

    const largeDocumentId = await makeDocument(agentId, 1, 'One large passage', 5_000);
    const largePage = await getDocument(db, largeDocumentId, { maxResponseBytes: 1_024 });
    expect(largePage?.document.title).toBe('One large passage');
    expect(largePage?.chunks[0]?.fragment?.complete).toBe(false);
    expect(new TextEncoder().encode(JSON.stringify(largePage)).byteLength).toBeLessThanOrEqual(
      1_024,
    );
  });

  it('continues oversized Unicode passages exactly within the response byte cap', async () => {
    const source = 'é 🧭 "quoted" \\\n'.repeat(1_500);
    const documentId = await makeDocument(
      agentId,
      2,
      'Unicode passage continuation',
      source.length,
    );
    await db
      .update(documentChunks)
      .set({ text: source, charCount: source.length })
      .where(and(eq(documentChunks.documentId, documentId), eq(documentChunks.chunkIndex, 0)));

    let cursor: import('@assistant/persistence').DocumentChunkPageCursor | undefined = 0;
    let assembled = '';
    const seenIndexes: number[] = [];
    let pages = 0;
    do {
      const page = await getDocument(db, documentId, {
        cursor,
        limit: 10,
        maxResponseBytes: 4_096,
      });
      expect(page).not.toBeNull();
      expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(4_096);
      for (const chunk of page?.chunks ?? []) {
        seenIndexes.push(chunk.chunkIndex);
        expect(chunk.text).not.toMatch(/[\uD800-\uDBFF]$/);
        expect(chunk.text).not.toMatch(/^[\uDC00-\uDFFF]/);
        if (chunk.chunkIndex === 0) assembled += chunk.text;
      }
      cursor = page?.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThan(100);
    } while (cursor !== undefined);

    expect(assembled).toBe(source);
    expect(seenIndexes).toContain(1);
    expect(pages).toBeGreaterThan(2);
    expect((await getDocument(db, documentId))?.document.chunkCount).toBe(2);
  });

  it('rejects a continuation after its passage changes and binds it to the document', async () => {
    const source = 'é🧭'.repeat(2_000);
    const documentId = await makeDocument(agentId, 1, 'Changing passage', source.length);
    await db
      .update(documentChunks)
      .set({ text: source, charCount: source.length })
      .where(eq(documentChunks.documentId, documentId));
    const first = await getDocument(db, documentId, { maxResponseBytes: 2_048 });
    expect(first?.nextCursor).not.toBeNull();
    if (!first?.nextCursor || typeof first.nextCursor === 'number')
      throw new Error('expected an offset continuation cursor');

    const otherDocumentId = await makeDocument(agentId, 1, 'Other passage');
    await expect(getDocument(db, otherDocumentId, { cursor: first.nextCursor })).rejects.toThrow(
      'belongs to another document',
    );

    await db
      .update(documentChunks)
      .set({ text: `${source}!`, charCount: source.length + 1 })
      .where(eq(documentChunks.documentId, documentId));
    await expect(getDocument(db, documentId, { cursor: first.nextCursor })).rejects.toBeInstanceOf(
      DocumentChunkCursorStaleError,
    );
  });

  it('exposes processor structure coverage with the original document metadata', async () => {
    const documentId = await makeDocument(agentId, 1, 'Structural document');
    const metadata = {
      version: 1 as const,
      source: 'processor' as const,
      chars: 18,
      structure: { complete: true as const, representation: 'cell-addresses' as const },
    };
    await db
      .update(documents)
      .set({ extractionMetadata: metadata })
      .where(eq(documents.id, documentId));
    expect((await getDocument(db, documentId))?.document.extractionMetadata).toEqual(metadata);
  });

  it('keeps document detail scoped to the configured owner', async () => {
    const foreignDocumentId = await makeDocument(foreignAgentId, 1, 'Foreign details');
    await expect(getDocument(db, foreignDocumentId)).resolves.toBeNull();
  });
});
