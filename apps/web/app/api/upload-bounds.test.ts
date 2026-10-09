import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isAuthed: vi.fn(),
  isMobileAuthed: vi.fn(),
  isModuleEnabled: vi.fn(),
  loadConfig: vi.fn(),
  uploadDocument: vi.fn(),
  getImportCommands: vi.fn(),
  getApplication: vi.fn(),
  getWorkspace: vi.fn(),
  getFirestoreDocumentStores: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('@/auth', () => ({ isAuthed: mocks.isAuthed }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.isMobileAuthed,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@assistant/config', () => ({
  isModuleEnabled: mocks.isModuleEnabled,
  loadConfig: mocks.loadConfig,
}));
vi.mock('@assistant/application/documents', () => ({ uploadDocument: mocks.uploadDocument }));
vi.mock('@/lib/server', () => ({
  getImportCommands: mocks.getImportCommands,
  getApplication: mocks.getApplication,
  getWorkspace: mocks.getWorkspace,
}));
vi.mock('@/lib/firestore-documents', () => ({
  getFirestoreDocumentStores: mocks.getFirestoreDocumentStores,
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { POST as uploadDocumentRoute } from '@/app/api/documents/upload/route';
import { POST as uploadArchive } from '@/app/api/import/upload/route';
import { POST as uploadMobileImport } from '@/app/api/mobile/v1/imports/route';

const routes = [
  ['web import', (request: Request) => uploadArchive(request)],
  ['web document', (request: Request) => uploadDocumentRoute(request)],
  ['mobile import', (request: Request) => uploadMobileImport(request)],
] as const;

function requestWithDeclaredLength(length: number): Request {
  return new Request('http://localhost/api/upload', {
    method: 'POST',
    headers: { 'content-length': String(length) },
  });
}

function requestWithExtraField(): Request {
  const form = new FormData();
  form.set('file', new File(['small fixture'], 'fixture.txt', { type: 'text/plain' }));
  form.set('unexpected', 'extra input');
  return new Request('http://localhost/api/upload', { method: 'POST', body: form });
}

describe('multipart upload route bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAuthed.mockResolvedValue(true);
    mocks.isMobileAuthed.mockResolvedValue(true);
    mocks.isModuleEnabled.mockReturnValue(true);
    mocks.loadConfig.mockReturnValue({ PERSISTENCE_DRIVER: 'postgres' });
  });

  it.each(routes)(
    '%s rejects an aggregate body above 26 MiB before side effects',
    async (_, post) => {
      const response = await post(requestWithDeclaredLength(26 * 1024 * 1024 + 1));
      expect(response.status).toBe(413);
      expect(mocks.uploadDocument).not.toHaveBeenCalled();
      expect(mocks.getImportCommands).not.toHaveBeenCalled();
      expect(mocks.getApplication).not.toHaveBeenCalled();
    },
  );

  it.each(routes)(
    '%s checks authentication before reading the request body',
    async (name, post) => {
      mocks.isAuthed.mockResolvedValue(false);
      mocks.isMobileAuthed.mockResolvedValue(false);
      const response = await post(requestWithDeclaredLength(26 * 1024 * 1024 + 1));
      expect(response.status).toBe(401);
      expect(mocks.uploadDocument).not.toHaveBeenCalled();
      expect(mocks.getImportCommands).not.toHaveBeenCalled();
      expect(mocks.getApplication).not.toHaveBeenCalled();
      expect(name).toBeTruthy();
    },
  );

  it.each(routes)(
    '%s rejects unknown multipart fields before upload side effects',
    async (_, post) => {
      const response = await post(requestWithExtraField());
      expect(response.status).toBe(400);
      expect(mocks.uploadDocument).not.toHaveBeenCalled();
      expect(mocks.getImportCommands).not.toHaveBeenCalled();
      expect(mocks.getApplication).not.toHaveBeenCalled();
    },
  );
});
