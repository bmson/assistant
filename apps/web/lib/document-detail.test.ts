import {
  DocumentChunkCursorStaleError,
  encodeDocumentChunkOffsetCursor,
} from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { documentDetailErrorResponse, documentPageOptionsFromUrl } from './document-detail.js';

const documentId = 'dbb46239-9e5b-40e8-a0f8-1915e3973c40';
const revision = 'a'.repeat(64);

describe('document detail continuation contract', () => {
  it('keeps numeric chunk cursors compatible and validates document-bound offset cursors', () => {
    expect(
      documentPageOptionsFromUrl('https://assistant.invalid/docs?cursor=12&limit=10', documentId),
    ).toMatchObject({ cursor: 12, limit: 10 });
    const token = encodeDocumentChunkOffsetCursor({
      documentId,
      chunkIndex: 12,
      offset: 4096,
      revision,
    });
    expect(
      documentPageOptionsFromUrl(
        `https://assistant.invalid/docs?cursor=${encodeURIComponent(token)}&limit=10`,
        documentId,
      ),
    ).toMatchObject({ cursor: { documentId, chunkIndex: 12, offset: 4096, revision } });
    expect(() =>
      documentPageOptionsFromUrl(
        `https://assistant.invalid/docs?cursor=${encodeURIComponent(token)}`,
        '00000000-0000-4000-8000-000000000001',
      ),
    ).toThrow(/another document/);
    expect(() =>
      documentPageOptionsFromUrl(
        'https://assistant.invalid/docs?cursor=v1~bad~NaN~1~oops',
        documentId,
      ),
    ).toThrow(/Invalid document passage continuation cursor/);
  });

  it('returns a refreshable conflict when passage content changed mid-read', async () => {
    const response = documentDetailErrorResponse(new DocumentChunkCursorStaleError(12));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'document_chunk_changed', chunkIndex: 12 },
      restartCursor: 12,
    });
  });
});
