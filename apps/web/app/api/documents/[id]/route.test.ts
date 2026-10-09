import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  readConfiguredDocument: vi.fn(),
  documentPageOptionsFromUrl: vi.fn(),
  documentDetailErrorResponse: vi.fn(),
}));

vi.mock('@assistant/config', () => ({
  isModuleEnabled: () => true,
  loadConfig: () => ({ PERSISTENCE_DRIVER: 'postgres' }),
}));
vi.mock('@/auth', () => ({ requireOwner: harness.requireOwner }));
vi.mock('@/lib/document-detail', () => ({
  readConfiguredDocument: harness.readConfiguredDocument,
  documentPageOptionsFromUrl: harness.documentPageOptionsFromUrl,
  documentDetailErrorResponse: harness.documentDetailErrorResponse,
}));

import { GET } from './route.js';

const documentId = '0f51ec6e-20e2-4ca4-8f47-41fd38ee9c6e';

describe('owner document detail route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.documentPageOptionsFromUrl.mockReturnValue({ cursor: 100, limit: 50 });
    harness.readConfiguredDocument.mockResolvedValue({
      document: { id: documentId, title: 'Owner document', chunkCount: 1_001 },
      chunks: [{ chunkIndex: 100, text: 'passage', charCount: 7 }],
      nextCursor: 101,
      totalChunks: 1_001,
    });
  });

  it('requires the owner and serves the requested passage page without caching', async () => {
    const response = await GET(
      new Request(`http://localhost/api/documents/${documentId}?cursor=100`),
      {
        params: Promise.resolve({ id: documentId }),
      },
    );
    expect(harness.requireOwner).toHaveBeenCalledOnce();
    expect(harness.documentPageOptionsFromUrl).toHaveBeenCalledOnce();
    expect(harness.readConfiguredDocument).toHaveBeenCalledWith(documentId, {
      cursor: 100,
      limit: 50,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      document: { id: documentId, chunkCount: 1_001 },
      chunks: [{ chunkIndex: 100 }],
      nextCursor: 101,
      totalChunks: 1_001,
    });
  });

  it('rejects an invalid document id before reading document data', async () => {
    const response = await GET(new Request('http://localhost/api/documents/not-a-uuid'), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    expect(response.status).toBe(400);
    expect(harness.readConfiguredDocument).not.toHaveBeenCalled();
  });
});
