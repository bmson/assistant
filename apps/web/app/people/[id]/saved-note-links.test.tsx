import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductVisualData } from '../../product-visual-data';

const ports = vi.hoisted(() => ({
  driver: 'postgres',
  owner: vi.fn(),
  dossier: vi.fn(),
  pgBrowse: vi.fn(),
  pgEditor: vi.fn(),
  fsOwner: vi.fn(),
  fsFence: vi.fn(),
  fsAfter: vi.fn(),
  fsDossier: vi.fn(),
  terminate: vi.fn(),
}));

vi.mock('@/auth', () => ({ requireOwner: ports.owner }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@assistant/config', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadConfig: () => ({
    PERSISTENCE_DRIVER: ports.driver,
    FIRESTORE_AGENT_ID: '11111111-1111-4111-8111-111111111111',
    GCP_PROJECT: 'offline-test',
    ASSISTANT_WORKSPACE_ID: 'offline-test',
    FIRESTORE_DATABASE_ID: 'offline-test',
    AUTH_SECRET: 'offline-page-test-secret',
    ASSISTANT_RELEASE_WRITES_PAUSED: false,
    RESTORE_REHEARSAL: false,
    POSTGRES_SOURCE_WRITES_FENCED: false,
  }),
  validateAgentPersistenceConfig: () => [],
}));
vi.mock('@assistant/application/people', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getPersonDossier: ports.dossier,
}));
vi.mock('@/lib/server', () => ({
  withPostgresMemoryBrowseRead: ports.pgBrowse,
  readPostgresOwnerEditorViewInputs: ports.pgEditor,
}));
vi.mock('@/lib/firestore-people', () => ({ getFirestorePersonDossier: ports.fsDossier }));
vi.mock('@assistant/firestore', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createInstallationStore: () => ({
    fixture: 'database-free-store',
    db: { terminate: ports.terminate },
  }),
  assertFirestoreInstallationOwner: ports.fsOwner,
  readPrivacyErasureFence: ports.fsFence,
  assertPrivacyErasureFenceUnchanged: ports.fsAfter,
}));

import PersonPage from './page';

const synthetic = createProductVisualData(false).dossier;
const personId = synthetic.profile.contact.id;
const returnTo = `/people/${personId}`;
const noteId = synthetic.profile.facts[0]?.id;

beforeEach(() => {
  vi.resetAllMocks();
  ports.driver = 'postgres';
  ports.owner.mockResolvedValue({ user: { email: 'offline@example.test' } });
  ports.pgBrowse.mockImplementation(async (read) => read({ fixture: 'fake-postgres-reader' }));
  ports.dossier.mockResolvedValue(synthetic);
  ports.fsOwner.mockResolvedValue('11111111-1111-4111-8111-111111111111');
  ports.fsFence.mockResolvedValue({ fixture: 'privacy-fence' });
  ports.fsAfter.mockResolvedValue(undefined);
  ports.fsDossier.mockResolvedValue(synthetic);
});

describe('real PersonPage saved-note destinations with fake storage ports', () => {
  it.each(['postgres', 'firestore'])(
    'renders an exact saved-note link and remains read-only (%s)',
    async (driver) => {
      ports.driver = driver;
      const html = renderToStaticMarkup(
        await PersonPage({
          params: Promise.resolve({ id: personId }),
          searchParams: Promise.resolve({}),
        }),
      );

      expect(noteId).toBeTruthy();
      expect(html).toContain('Review / edit saved note');
      expect(html).toContain(
        `href="/profile/knowledge/notes/${noteId}?returnTo=${encodeURIComponent(returnTo)}"`,
      );
      expect(html).not.toMatch(/<form\b[^>]*\bmethod="post"/i);
      expect(html).not.toMatch(/Save changes|Forget source/);
      expect(html).not.toMatch(/name="(?:grant|operationId|formSessionScope)"/);

      if (driver === 'postgres') {
        expect(ports.dossier).toHaveBeenCalledOnce();
        expect(ports.pgBrowse).toHaveBeenCalledOnce();
        expect(ports.dossier.mock.calls[0]?.[0]).toMatchObject({
          fixture: 'fake-postgres-reader',
        });
        expect(ports.pgEditor).not.toHaveBeenCalled();
        expect(ports.fsDossier).not.toHaveBeenCalled();
      } else {
        expect(ports.fsDossier).toHaveBeenCalledOnce();
        expect(ports.fsOwner).toHaveBeenCalledTimes(2);
        expect(ports.fsFence).toHaveBeenCalledOnce();
        expect(ports.fsAfter).toHaveBeenCalledOnce();
        expect(ports.dossier).not.toHaveBeenCalled();
        expect(ports.terminate).toHaveBeenCalledOnce();
      }
    },
  );
});
