import { randomUUID } from 'node:crypto';
import { DocumentChunkCursorStaleError } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreDocumentReadRepository } from './documents.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

const emulator = /^(?:127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '');

describe.skipIf(!emulator)('Firestore document detail pagination', () => {
  let store: InstallationStore;
  const agentId = randomUUID();
  let repository: FirestoreDocumentReadRepository;

  beforeEach(async () => {
    store = emulatorStore();
    repository = new FirestoreDocumentReadRepository(store, agentId);
    await store.doc('agents', agentId).set({ id: agentId });
  });

  afterEach(async () => disposeStore(store));

  async function makeDocument(count: number, title: string, textSize = 80) {
    const id = randomUUID();
    const fileId = randomUUID();
    await Promise.all([
      store.doc('files', fileId).set({ id: fileId, agentId, bytes: count * textSize }),
      store.doc('documents', id).set({
        id,
        agentId,
        fileId,
        title,
        mime: 'text/plain',
        source: 'upload',
        trust: 'owner',
        status: 'ready',
        extractor: 'test',
        chunkCount: count,
        charCount: count * textSize,
        error: null,
        createdAt: new Date('2026-10-01T12:00:00.000Z'),
      }),
    ]);
    for (let start = 0; start < count; start += 400) {
      const batch = store.db.batch();
      const stop = Math.min(start + 400, count);
      for (let index = start; index < stop; index += 1) {
        const chunkId = `${id}:${index}`;
        const text = `${String(index).padStart(5, '0')}:${'x'.repeat(Math.max(0, textSize - 6))}`;
        batch.set(store.doc('documentChunks', chunkId), {
          id: chunkId,
          agentId,
          documentId: id,
          chunkIndex: index,
          text,
          charCount: text.length,
        });
      }
      await batch.commit();
    }
    return id;
  }

  it.each([1_000, 1_001, 4_000])('reads %i chunks in stable bounded pages', async (count) => {
    const documentId = await makeDocument(count, `Large ${count}`);
    let cursor: number | import('@assistant/persistence').DocumentChunkPageCursor | undefined;
    const seen: number[] = [];
    let pages = 0;
    do {
      const page = await repository.get(agentId, documentId, { cursor, limit: 100 });
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

  it('returns metadata on byte-bounded pages and fragments oversized passages', async () => {
    const documentId = await makeDocument(20, 'Small byte budget', 700);
    const page = await repository.get(agentId, documentId, {
      cursor: 0,
      limit: 100,
      maxResponseBytes: 4_096,
    });
    expect(page?.document.title).toBe('Small byte budget');
    expect(page?.chunks.length).toBeGreaterThan(0);
    expect(page?.chunks.length).toBeLessThan(20);
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(4_096);
    expect(page?.nextCursor).toBe(page?.chunks.length);

    const oversized = await makeDocument(1, 'Oversized passage', 5_000);
    const fragment = await repository.get(agentId, oversized, { maxResponseBytes: 1_024 });
    expect(fragment?.document.title).toBe('Oversized passage');
    expect(fragment?.chunks[0]?.fragment?.complete).toBe(false);
    expect(new TextEncoder().encode(JSON.stringify(fragment)).byteLength).toBeLessThanOrEqual(
      1_024,
    );
  });

  it('continues an oversized Unicode passage exactly and rejects changed content', async () => {
    const source = 'é 🧭 "quoted" \\\n'.repeat(1_500);
    const id = await makeDocument(2, 'Unicode passage continuation', source.length);
    await store.doc('documentChunks', `${id}:0`).set({
      id: `${id}:0`,
      agentId,
      documentId: id,
      chunkIndex: 0,
      text: source,
      charCount: source.length,
    });

    let cursor: import('@assistant/persistence').DocumentChunkPageCursor | undefined = 0;
    let assembled = '';
    const seenIndexes: number[] = [];
    let pages = 0;
    do {
      const page = await repository.get(agentId, id, {
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

    const first = await repository.get(agentId, id, { maxResponseBytes: 2_048 });
    if (!first?.nextCursor || typeof first.nextCursor === 'number')
      throw new Error('expected an offset continuation cursor');
    await store
      .doc('documentChunks', `${id}:0`)
      .update({ text: `${source}!`, charCount: source.length + 1 });
    await expect(
      repository.get(agentId, id, { cursor: first.nextCursor, maxResponseBytes: 2_048 }),
    ).rejects.toBeInstanceOf(DocumentChunkCursorStaleError);
  });

  it('enforces configured-owner identity and returns null for a foreign document', async () => {
    const foreignAgentId = randomUUID();
    const id = randomUUID();
    const fileId = randomUUID();
    await Promise.all([
      store.doc('files', fileId).set({ id: fileId, agentId: foreignAgentId, bytes: 1 }),
      store.doc('documents', id).set({
        id,
        agentId: foreignAgentId,
        fileId,
        title: 'Foreign document',
        mime: 'text/plain',
        source: 'upload',
        trust: 'owner',
        status: 'ready',
        extractor: 'test',
        chunkCount: 0,
        charCount: 0,
        createdAt: new Date(),
      }),
    ]);
    await expect(repository.get(agentId, id)).resolves.toBeNull();
    await expect(repository.get(foreignAgentId, id)).rejects.toThrow(
      'Document read is outside the configured installation',
    );
  });
});
