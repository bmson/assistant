import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductVisualData } from '../product-visual-data';

const ports = vi.hoisted(() => ({
  driver: 'postgres',
  enabled: true,
  legacy: false,
  trace: [] as string[],
  owner: vi.fn(),
  people: vi.fn(),
  person: vi.fn(),
  pgRead: vi.fn(),
  pgEditor: vi.fn(),
  fsPeople: vi.fn(),
  fsPerson: vi.fn(),
  fsContext: vi.fn(),
  fsSnapshot: vi.fn(),
  fsOwner: vi.fn(),
  fsFence: vi.fn(),
  fsAfter: vi.fn(),
  terminate: vi.fn(),
}));
vi.mock('@/auth', () => ({ requireOwner: ports.owner }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  notFound: () => {
    throw Error('NOT_FOUND');
  },
}));
vi.mock('@assistant/config', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadConfig: () => ({
    PERSISTENCE_DRIVER: ports.driver,
    FIRESTORE_AGENT_ID: '11111111-1111-4111-8111-111111111111',
    GCP_PROJECT: 'offline-fixture',
    ASSISTANT_WORKSPACE_ID: 'offline-fixture',
    FIRESTORE_DATABASE_ID: 'offline-fixture',
    AUTH_SECRET: 'offline-page-signing-secret',
    ASSISTANT_RELEASE_WRITES_PAUSED: !ports.enabled,
    RESTORE_REHEARSAL: false,
    POSTGRES_SOURCE_WRITES_FENCED: false,
  }),
  validateAgentPersistenceConfig: () => [],
}));
vi.mock('@assistant/application/people', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listPeopleDirectory: ports.people,
  getPersonDossier: ports.person,
}));
vi.mock('@/lib/server', () => ({
  withPostgresMemoryBrowseRead: ports.pgRead,
  readPostgresOwnerEditorViewInputs: ports.pgEditor,
}));
vi.mock('@/lib/firestore-people', () => ({
  listFirestorePeopleDirectory: ports.fsPeople,
  getFirestorePersonDossier: ports.fsPerson,
}));
vi.mock('@assistant/firestore', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createInstallationStore: () => ({ fixture: 'same-store', db: { terminate: ports.terminate } }),
  assertFirestoreInstallationOwner: ports.fsOwner,
  readPrivacyErasureFence: ports.fsFence,
  assertPrivacyErasureFenceUnchanged: ports.fsAfter,
  readFirestoreOwnerEditorIssuanceContext: ports.fsContext,
  firestoreOwnerEditorViewSnapshot: ports.fsSnapshot,
}));

import Person from './[id]/page';
import People from './page';

const ownerId = '11111111-1111-4111-8111-111111111111';
const context = {
  ownerId,
  epoch: '44444444-4444-4444-8444-444444444444',
  privacyGeneration: 'fixture-generation',
};
const leased = Object.freeze({ fixture: 'same-leased-db' });
const fence = Object.freeze({ fixture: 'same-fence-token' });
const visualData = createProductVisualData(false);
const displayedRevision = 'a'.repeat(64);
const data = {
  ...visualData,
  dossier: {
    ...visualData.dossier,
    profile: {
      ...visualData.dossier.profile,
      contact: { ...visualData.dossier.profile.contact, identityRevision: displayedRevision },
    },
  },
};
const contact = data.dossier.profile.contact;
const snapshot = {
  ownerId,
  identity: {
    contactId: contact.id,
    name: contact.name,
    aliases: contact.aliases,
    trust: contact.trust,
    revision: displayedRevision,
  },
  people: [{ contactId: contact.id, name: contact.name, revision: displayedRevision }],
  corrections: [],
};
const directory = () => People({ searchParams: Promise.resolve({ q: contact.name }) });
const dossier = () =>
  Person({
    params: Promise.resolve({ id: contact.id }),
    searchParams: Promise.resolve({ q: 'retained search' }),
  });
beforeEach(() => {
  vi.resetAllMocks();
  ports.driver = 'postgres';
  ports.enabled = true;
  ports.trace = [];
  ports.owner.mockResolvedValue({
    user: { email: 'offline-owner@example.test' },
    formSessionScope: 'offline_page_form_session',
  });
  ports.pgRead.mockImplementation(async (read) => {
    ports.trace.push('pg-before');
    const value = await read(leased);
    ports.trace.push('pg-after');
    return value;
  });
  ports.people.mockImplementation(async (db) => {
    expect(db).toBe(leased);
    ports.trace.push('browse');
    return data.people;
  });
  ports.person.mockImplementation(async (db) => {
    expect(db).toBe(leased);
    ports.trace.push('browse');
    return data.dossier;
  });
  ports.pgEditor.mockImplementation(async (db, input) => {
    expect(db).toBe(leased);
    ports.trace.push('editor');
    return {
      context,
      snapshot: input.contactId
        ? snapshot
        : { ownerId, people: [], identity: null, corrections: [] },
    };
  });
  ports.fsOwner.mockImplementation(async () => {
    ports.trace.push('fs-owner');
    return ownerId;
  });
  ports.fsFence.mockImplementation(async () => {
    ports.trace.push('fs-before');
    return fence;
  });
  ports.fsAfter.mockImplementation(async (_store, _owner, observed) => {
    expect(observed).toBe(fence);
    ports.trace.push('fs-after');
  });
  ports.fsPeople.mockImplementation(async () => {
    ports.trace.push('browse');
    return data.people;
  });
  ports.fsPerson.mockImplementation(async () => {
    ports.trace.push('browse');
    return data.dossier;
  });
  ports.fsContext.mockImplementation(async () => {
    ports.trace.push('context');
    return context;
  });
  ports.fsSnapshot.mockImplementation(async () => {
    ports.trace.push('snapshot');
    return snapshot;
  });
});
describe('actual page + real issuance builder composition, named reader/fence ports only', () => {
  it('PG directory issues only create scope inside same read lease and preserves GET q links', async () => {
    const html = renderToStaticMarkup(await directory());
    expect(ports.trace).toEqual(['pg-before', 'browse', 'editor', 'pg-after']);
    expect(ports.pgEditor).toHaveBeenCalledExactlyOnceWith(leased, {});
    expect(html).toContain('Add person');
    expect(html).toContain('method="get"');
    expect(html).toContain(`?q=${encodeURIComponent(contact.name)}`);
    expect(html).not.toContain('Edit name and aliases');
    expect(html).not.toContain('method="post"');
  });
  it('PG dossier binds same displayed/native identity/options and preserves q back/map context', async () => {
    const node = data.map.nodes.find((node) => node.contactId === contact.id);
    if (!node) throw Error('Expected existing synthetic person map node');
    ports.person.mockImplementationOnce(async (db) => {
      expect(db).toBe(leased);
      ports.trace.push('browse');
      return {
        ...data.dossier,
        entityId: node.id,
        entity: {
          id: node.id,
          label: node.label,
          kind: 'person',
          canonicalKey: `person:${contact.id}`,
        },
      };
    });
    const html = renderToStaticMarkup(await dossier());
    expect(ports.trace).toEqual(['pg-before', 'browse', 'editor', 'pg-after']);
    expect(ports.pgEditor.mock.calls[0]?.[1]).toMatchObject({ contactId: contact.id });
    expect(html).toContain('Edit name and aliases');
    expect(html).toContain('Add family relationship');
    expect(html).toContain('/people?q=retained%20search');
    expect(html).toContain(contact.name);
    expect(html).toContain('view=map');
  });
  it('null epoch and capped metadata remain browse results with no fake grants', async () => {
    ports.pgEditor.mockResolvedValue(null);
    let html = renderToStaticMarkup(await dossier());
    expect(html).toContain(contact.name);
    expect(html).not.toContain('Edit name and aliases');
    ports.pgEditor.mockRejectedValue(Error('bounded editor contact cap'));
    html = renderToStaticMarkup(await dossier());
    expect(html).toContain(contact.name);
    expect(html).not.toContain('Could not load this view');
    expect(ports.trace.at(-1)).toBe('pg-after');
  });
  it('mismatched native/displayed identity never publishes edit grants', async () => {
    ports.pgEditor.mockResolvedValue({
      context,
      snapshot: { ...snapshot, identity: { ...snapshot.identity, name: 'Newer name' } },
    });
    const html = renderToStaticMarkup(await dossier());
    expect(html).toContain(contact.name);
    expect(html).not.toContain('Edit name and aliases');
  });
  it.each(['postgres', 'firestore'] as const)(
    '%s does not adopt a newer native revision when the displayed values are identical',
    async (driver) => {
      ports.driver = driver;
      const newerSnapshot = {
        ...snapshot,
        identity: { ...snapshot.identity, revision: 'b'.repeat(64) },
        people: snapshot.people.map((person) => ({ ...person, revision: 'b'.repeat(64) })),
      };
      ports.pgEditor.mockResolvedValue({ context, snapshot: newerSnapshot });
      ports.fsSnapshot.mockResolvedValue(newerSnapshot);
      const html = renderToStaticMarkup(await dossier());
      expect(html).toContain(contact.name);
      expect(html).not.toContain('Edit name and aliases');
      expect(contact.identityRevision).toBe(displayedRevision);
      if (driver === 'firestore') expect(ports.pgRead).not.toHaveBeenCalled();
    },
  );
  it.each(['disabled', 'legacy'] as const)(
    '%s skips optional PG editor reads and keeps browse',
    async (mode) => {
      if (mode === 'disabled') ports.enabled = false;
      else ports.owner.mockResolvedValue({ user: { email: 'offline-owner@example.test' } });
      const html = renderToStaticMarkup(await directory());
      expect(ports.pgEditor).not.toHaveBeenCalled();
      expect(html).not.toContain('Add person');
      expect(html).toContain('method="get"');
    },
  );
  it('failure after the combined PG read discards both browse and prepared grants', async () => {
    ports.pgRead.mockImplementation(async (read) => {
      await read(leased);
      throw Error('owner/erasure changed after read');
    });
    const html = renderToStaticMarkup(await dossier());
    expect(html).toContain('Could not load this view');
    expect(html).not.toContain('Edit name and aliases');
    expect(html).toContain('q=retained%20search');
  });
  it('FS directory uses same outer owner/fence/store and context only, zero option scan/PG fallback', async () => {
    ports.driver = 'firestore';
    const html = renderToStaticMarkup(await directory());
    expect(ports.trace).toEqual([
      'fs-owner',
      'fs-before',
      'browse',
      'context',
      'fs-owner',
      'fs-after',
    ]);
    expect(ports.fsSnapshot).not.toHaveBeenCalled();
    expect(ports.pgRead).not.toHaveBeenCalled();
    expect(html).toContain('Add person');
    expect(ports.terminate).toHaveBeenCalledOnce();
    expect(ports.fsContext.mock.calls[0]?.[0]).toBe(ports.fsPeople.mock.calls[0]?.[0]);
  });
  it('FS dossier native editor snapshots stay inside the same owner/privacy read window', async () => {
    ports.driver = 'firestore';
    const html = renderToStaticMarkup(await dossier());
    expect(ports.trace).toEqual([
      'fs-owner',
      'fs-before',
      'browse',
      'context',
      'snapshot',
      'fs-owner',
      'fs-after',
    ]);
    expect(ports.fsSnapshot).toHaveBeenCalledTimes(1);
    expect(ports.fsSnapshot.mock.calls[0]?.[0]).toBe(ports.fsPerson.mock.calls[0]?.[0]);
    expect(html).toContain('Edit name and aliases');
    expect(ports.pgRead).not.toHaveBeenCalled();
  });
  it('FS missing epoch skips optional native options and retains browse', async () => {
    ports.driver = 'firestore';
    ports.fsContext.mockResolvedValue(null);
    const html = renderToStaticMarkup(await dossier());
    expect(ports.fsSnapshot).not.toHaveBeenCalled();
    expect(html).toContain(contact.name);
    expect(html).not.toContain('Edit name and aliases');
    expect(ports.fsAfter).toHaveBeenCalledOnce();
  });
  it('FS bounded editor snapshot failure leaves the fenced dossier readable with no PG fallback', async () => {
    ports.driver = 'firestore';
    ports.fsSnapshot.mockRejectedValue(Error('raw contact/proof budget exceeded'));
    const html = renderToStaticMarkup(await dossier());
    expect(html).toContain(contact.name);
    expect(html).not.toContain('Could not load this view');
    expect(html).not.toContain('Edit name and aliases');
    expect(ports.fsOwner).toHaveBeenCalledTimes(2);
    expect(ports.fsAfter).toHaveBeenCalledOnce();
    expect(ports.pgRead).not.toHaveBeenCalled();
    expect(ports.terminate).toHaveBeenCalledOnce();
  });
  it('FS changed erasure after optional issuance discards prepared grants rather than return success', async () => {
    ports.driver = 'firestore';
    ports.fsAfter.mockRejectedValue(Error('erasure generation changed'));
    const html = renderToStaticMarkup(await dossier());
    expect(html).toContain('Could not load this view');
    expect(html).not.toContain('Edit name and aliases');
    expect(ports.pgRead).not.toHaveBeenCalled();
    expect(ports.terminate).toHaveBeenCalledOnce();
  });
});
