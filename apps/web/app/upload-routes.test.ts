import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authed: vi.fn(),
  document: vi.fn(),
  archive: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock('@/auth', () => ({ isAuthed: mocks.authed }));
vi.mock('@assistant/config', () => ({
  loadConfig: () => ({ PERSISTENCE_DRIVER: 'postgres' }),
  isModuleEnabled: () => true,
}));
vi.mock('@/lib/server', () => ({
  getApplication: () => ({ uploadDocument: mocks.document }),
  getImportCommands: () => ({ uploadImport: mocks.archive }),
  getWorkspace: vi.fn(),
}));
vi.mock('@/lib/firestore-documents', () => ({ getFirestoreDocumentStores: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { POST as documentPost } from './api/documents/upload/route';
import { POST as importPost } from './api/import/upload/route';

function request(kind: string, accept: string, invalid = false) {
  const form = new FormData();
  form.set('file', new File(['Synthetic fixture'], 'review.txt', { type: 'text/plain' }));
  form.set(kind === 'documents' ? 'title' : 'source', 'Kept label');
  if (invalid) form.set('unexpected', 'invalid');
  return new Request(`https://assistant.test/api/${kind}/upload`, {
    method: 'POST',
    headers: { accept },
    body: form,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authed.mockResolvedValue(true);
  mocks.archive.mockResolvedValue({ destination: '/import?source=review' });
  mocks.redirect.mockImplementation(() => {
    throw new Error('native redirect');
  });
});

describe.each([
  ['documents', documentPost, '/documents'],
  ['import', importPost, '/import?source=review'],
] as const)('%s upload transport', (kind, post, destination) => {
  it('returns the existing destination only after an accepted enhanced upload', async () => {
    const response = await post(request(kind, 'application/json'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirectTo: destination });
    expect(kind === 'documents' ? mocks.document : mocks.archive).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
  it('preserves native form redirect behavior', async () => {
    await expect(post(request(kind, 'text/html'))).rejects.toThrow('native redirect');
    expect(mocks.redirect).toHaveBeenCalledWith(destination);
  });
  it.each(['application/json', 'text/html'])(
    'still rejects invalid fields (%s) before any storage command',
    async (accept) => {
      expect((await post(request(kind, accept, true))).status).toBe(400);
      expect(mocks.document).not.toHaveBeenCalled();
      expect(mocks.archive).not.toHaveBeenCalled();
    },
  );
  it.each(['application/json', 'text/html'])(
    'still rejects signed-out requests (%s) before any storage command',
    async (accept) => {
      mocks.authed.mockResolvedValue(false);
      expect((await post(request(kind, accept))).status).toBe(401);
      expect(mocks.document).not.toHaveBeenCalled();
      expect(mocks.archive).not.toHaveBeenCalled();
    },
  );
});
