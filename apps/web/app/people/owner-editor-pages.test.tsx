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
  pgOwner: vi.fn(),
  pgEditor: vi.fn(),
  recoveryPartition: vi.fn(),
  fsPeople: vi.fn(),
  fsPerson: vi.fn(),
  fsContext: vi.fn(),
  fsSnapshot: vi.fn(),
  fsOwner: vi.fn(),
  fsFence: vi.fn(),
  fsAfter: vi.fn(),
  getStore: vi.fn(),
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
    DATABASE_URL: 'postgres://offline:offline@db.example.test:5432/assistant',
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
  assertPostgresInstallationOwner: ports.pgOwner,
  getFirestoreInstallationStore: ports.getStore,
  withPostgresMemoryBrowseRead: ports.pgRead,
  readPostgresOwnerEditorViewInputs: ports.pgEditor,
}));
vi.mock('@/app/people/person-note-recovery-scope', () => ({
  personNoteRecoveryPartition: ports.recoveryPartition,
}));
vi.mock('@/lib/firestore-people', () => ({
  listFirestorePeopleDirectory: ports.fsPeople,
  getFirestorePersonDossier: ports.fsPerson,
}));
vi.mock('@assistant/firestore', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  assertFirestoreInstallationOwner: ports.fsOwner,
  readPrivacyErasureFence: ports.fsFence,
  assertPrivacyErasureFenceUnchanged: ports.fsAfter,
  readFirestoreOwnerEditorIssuanceContext: ports.fsContext,
  firestoreOwnerEditorViewSnapshot: ports.fsSnapshot,
}));

import Person from './[id]/page';
import People from './page';

const ownerId = '11111111-1111-4111-8111-111111111111';
const firestoreStore = Object.freeze({
  fixture: 'configured-firestore-transport',
  db: Object.freeze({ terminate: ports.terminate }),
});
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
const noteReturnContext =
  '/profile/knowledge?view=library&q=family&state=review&filter=verified&page=3&source=email';
const noteIntentDirectory = () =>
  People({
    searchParams: Promise.resolve({
      q: 'Sam Rivera',
      addNote: '1',
      returnTo: noteReturnContext,
    }),
  });
const noteIntentDossier = () =>
  Person({
    params: Promise.resolve({ id: contact.id }),
    searchParams: Promise.resolve({
      q: 'retained search',
      addNote: '1',
      returnTo: noteReturnContext,
    }),
  });
beforeEach(() => {
  vi.resetAllMocks();
  ports.driver = 'postgres';
  ports.enabled = true;
  ports.trace = [];
  ports.getStore.mockReturnValue(firestoreStore);
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
  ports.pgOwner.mockResolvedValue(ownerId);
  ports.recoveryPartition.mockReturnValue('offline-recovery-partition');
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
      ownerId,
      context,
      snapshot: input.contactId
        ? snapshot
        : { ownerId, people: [], identity: null, corrections: [] },
    };
  });
  ports.fsOwner.mockImplementation(async (store, configuredOwnerId) => {
    expect(store).toBe(firestoreStore);
    expect(configuredOwnerId).toBe(ownerId);
    ports.trace.push('fs-owner');
    return ownerId;
  });
  ports.fsFence.mockImplementation(async (store, configuredOwnerId) => {
    expect(store).toBe(firestoreStore);
    expect(configuredOwnerId).toBe(ownerId);
    ports.trace.push('fs-before');
    return fence;
  });
  ports.fsAfter.mockImplementation(async (store, configuredOwnerId, observed) => {
    expect(store).toBe(firestoreStore);
    expect(configuredOwnerId).toBe(ownerId);
    expect(observed).toBe(fence);
    ports.trace.push('fs-after');
  });
  ports.fsPeople.mockImplementation(async (store, configuredOwnerId) => {
    expect(store).toBe(firestoreStore);
    expect(configuredOwnerId).toBe(ownerId);
    ports.trace.push('browse');
    return data.people;
  });
  ports.fsPerson.mockImplementation(async (store, configuredOwnerId) => {
    expect(store).toBe(firestoreStore);
    expect(configuredOwnerId).toBe(ownerId);
    ports.trace.push('browse');
    return data.dossier;
  });
  ports.fsContext.mockImplementation(async (store, configuredOwnerId) => {
    expect(store).toBe(firestoreStore);
    expect(configuredOwnerId).toBe(ownerId);
    ports.trace.push('context');
    return context;
  });
  ports.fsSnapshot.mockImplementation(async (store, configuredOwnerId) => {
    expect(store).toBe(firestoreStore);
    expect(configuredOwnerId).toBe(ownerId);
    ports.trace.push('snapshot');
    return snapshot;
  });
});
describe('actual page + real issuance builder composition, named reader/fence ports only', () => {
  it.each([
    ['postgres', 'directory', directory],
    ['postgres', 'dossier', dossier],
    ['firestore', 'directory', directory],
    ['firestore', 'dossier', dossier],
  ] as const)(
    '%s %s propagates the owner guard before any protected read',
    async (driver, _page, render) => {
      ports.driver = driver;
      // This is a page-composition ordering proof. Auth.js decoding and Next's
      // streamed HTTP status behavior are outside these mocked owner-guard ports.
      const denied = new Error('offline owner guard interruption');
      ports.owner.mockRejectedValueOnce(denied);

      await expect(render()).rejects.toBe(denied);

      expect(ports.owner).toHaveBeenCalledOnce();
      expect(ports.trace).toEqual([]);
      for (const backend of [
        ports.people,
        ports.person,
        ports.pgRead,
        ports.pgEditor,
        ports.getStore,
        ports.fsPeople,
        ports.fsPerson,
        ports.fsContext,
        ports.fsSnapshot,
        ports.fsOwner,
        ports.fsFence,
        ports.fsAfter,
        ports.terminate,
      ])
        expect(backend).not.toHaveBeenCalled();
    },
  );
  it('returns to the filtered Connections list by name and places connections before saved dates', async () => {
    const context = '/profile/knowledge?view=connections&q=Alex';
    const html = renderToStaticMarkup(
      await Person({
        params: Promise.resolve({ id: contact.id }),
        searchParams: Promise.resolve({ returnTo: context }),
      }),
    );
    const back = html.match(
      /href="\/profile\/knowledge\?view=connections&amp;q=Alex"[\s\S]*?<\/a>/,
    )?.[0];
    expect(back).toContain('Connections');
    expect(back).not.toContain('Memory map');
    expect(html).toContain('id="important-dates"');
    expect(html.indexOf('id="person-connections"')).toBeLessThan(
      html.indexOf('id="important-dates"'),
    );
  });
  it.each(['postgres', 'firestore'] as const)(
    '%s person dossier renders malformed saved-note dates as unknown without changing browse authority',
    async (driver) => {
      ports.driver = driver;
      const createdAt = new Date(Number.NaN);
      const validFrom = new Date(Number.NaN);
      const validUntil = new Date('2024-03-01T23:00:00.000Z');
      const source = data.dossier.profile.facts[0];
      if (!source) throw Error('Expected an existing synthetic person fact');
      const malformedFact = Object.freeze({ ...source, createdAt, validFrom, validUntil });
      const openEndedFact = Object.freeze({
        ...source,
        id: '99999999-9999-4999-8999-999999999999',
        content: 'A note with no recorded validity bounds.',
        createdAt: new Date('2024-03-01T12:00:00.000Z'),
        validFrom: null,
        validUntil: null,
      });
      const dossierWithMalformedDate = {
        ...data.dossier,
        profile: { ...data.dossier.profile, facts: [malformedFact, openEndedFact], totalFacts: 2 },
      };
      const read = driver === 'postgres' ? ports.person : ports.fsPerson;
      read.mockResolvedValueOnce(dossierWithMalformedDate);

      const html = renderToStaticMarkup(await dossier());

      expect(html).toContain('Date unavailable');
      expect(html).toContain('Saved facts');
      expect(html).toContain('date unavailable–2024-03-01');
      expect(html).toContain('A note with no recorded validity bounds.');
      expect(html.match(/date unavailable–/g)).toHaveLength(1);
      expect(html).toContain('Edit details');
      expect(html).toContain('Add person');
      expect(html).not.toContain('NaN');
      expect(Number.isNaN(createdAt.getTime())).toBe(true);
      expect(Number.isNaN(validFrom.getTime())).toBe(true);
      expect(validUntil.getTime()).toBe(new Date('2024-03-01T23:00:00.000Z').getTime());
      expect(read).toHaveBeenCalledOnce();
      if (driver === 'postgres') {
        expect(ports.pgEditor).toHaveBeenCalledOnce();
        expect(ports.fsSnapshot).not.toHaveBeenCalled();
      } else {
        expect(ports.fsSnapshot).toHaveBeenCalledOnce();
        expect(ports.pgEditor).not.toHaveBeenCalled();
        expect(ports.terminate).not.toHaveBeenCalled();
      }
    },
  );
  it('PG directory issues only create scope inside same read lease and preserves GET q links', async () => {
    const html = renderToStaticMarkup(await directory());
    expect(ports.owner).toHaveBeenCalledOnce();
    expect(ports.owner.mock.invocationCallOrder[0]).toBeLessThan(
      ports.pgRead.mock.invocationCallOrder[0] ?? 0,
    );
    expect(ports.trace).toEqual(['pg-before', 'browse', 'editor', 'pg-after']);
    expect(ports.pgEditor).toHaveBeenCalledExactlyOnceWith(leased, {});
    expect(html).toContain('Add person');
    expect(html).toContain('open a person to connect them with someone else');
    expect(html).toContain('method="get"');
    expect(html).toContain(`?q=${encodeURIComponent(contact.name)}`);
    expect(html).not.toContain('Edit details');
    expect(html).not.toContain('method="post"');
  });
  it('Saved-notes entry carries person-note intent through People search and the exact person dossier', async () => {
    const directoryHtml = renderToStaticMarkup(await noteIntentDirectory());
    expect(directoryHtml).toContain(
      'Choose an existing person. The note will be saved about that person.',
    );
    expect(directoryHtml).toContain(
      `href="/people/${contact.id}?q=Sam%20Rivera&amp;addNote=1&amp;returnTo=${encodeURIComponent(noteReturnContext)}"`,
    );
    ports.owner.mockResolvedValueOnce({
      user: { email: 'offline-owner@example.test' },
      formSessionScope: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    const personHtml = renderToStaticMarkup(await noteIntentDossier());
    expect(personHtml).toContain(`Add a saved note about ${contact.name}`);
    expect(personHtml).not.toContain('Adding a note is unavailable');
    expect(personHtml).toContain(
      `href="/people?q=retained%20search&amp;addNote=1&amp;returnTo=${encodeURIComponent(noteReturnContext)}"`,
    );
  });
  it('shows an explicit choose-another-person outcome when the owner is not note-eligible', async () => {
    ports.person.mockResolvedValueOnce({
      ...data.dossier,
      profile: {
        ...data.dossier.profile,
        contact: { ...contact, trust: 'owner' },
      },
    });
    ports.pgEditor.mockResolvedValueOnce({
      ownerId,
      context,
      snapshot: { ...snapshot, identity: { ...snapshot.identity, trust: 'owner' } },
    });
    ports.owner.mockResolvedValueOnce({
      user: { email: 'offline-owner@example.test' },
      formSessionScope: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    const html = renderToStaticMarkup(await noteIntentDossier());
    expect(html).toContain('Adding a note is unavailable for this person view.');
    expect(html).toContain('Choose another existing person');
    expect(html).toContain(
      `href="/people?q=retained%20search&amp;addNote=1&amp;returnTo=${encodeURIComponent(noteReturnContext)}"`,
    );
  });
  it('keeps the person-note host visible with a choose-another outcome when issuance is missing', async () => {
    ports.pgEditor.mockResolvedValueOnce({
      ownerId,
      context: null,
      snapshot: { ownerId, identity: null, people: [], corrections: [] },
    });
    ports.owner.mockResolvedValueOnce({
      user: { email: 'offline-owner@example.test' },
      formSessionScope: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    const html = renderToStaticMarkup(await noteIntentDossier());
    expect(html).toContain(`Add a saved note about ${contact.name}`);
    expect(html).toContain('Adding a note is unavailable for this person view.');
    expect(html).toContain('Choose another existing person');
    expect(html).not.toContain('Your sign-in changed');
  });
  it('retains only the independently verified owner partition when optional issuance read throws', async () => {
    ports.pgEditor.mockRejectedValueOnce(Error('bounded editor snapshot read failed'));
    const html = renderToStaticMarkup(await noteIntentDossier());
    expect(ports.pgOwner).toHaveBeenCalledExactlyOnceWith(leased);
    expect(ports.recoveryPartition).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId, formSessionScope: 'offline_page_form_session' }),
    );
    expect(ports.trace.at(-1)).toBe('pg-after');
    expect(html).toContain(`Add a saved note about ${contact.name}`);
    expect(html).toContain('Adding a note is unavailable for this person view.');
    expect(html).not.toContain('Could not load this view');
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
    expect(ports.owner).toHaveBeenCalledOnce();
    expect(ports.owner.mock.invocationCallOrder[0]).toBeLessThan(
      ports.pgRead.mock.invocationCallOrder[0] ?? 0,
    );
    expect(ports.trace).toEqual(['pg-before', 'browse', 'editor', 'pg-after']);
    expect(ports.pgEditor.mock.calls[0]?.[1]).toMatchObject({ contactId: contact.id });
    expect(html).toContain('Edit details');
    expect(html).toContain('Add person');
    expect(html).toContain('Add family relationship');
    expect(html).toContain('/people?q=retained%20search');
    expect(html).toContain(contact.name);
    expect(html).toContain('view=map');
  });
  it('null epoch and capped metadata remain browse results with no fake grants', async () => {
    ports.pgEditor.mockResolvedValue(null);
    let html = renderToStaticMarkup(await dossier());
    expect(html).toContain(contact.name);
    expect(html).not.toContain('Edit details');
    expect(html).toContain('Editing is temporarily unavailable.');
    expect(html).not.toContain('Sign in again');
    ports.pgEditor.mockRejectedValue(Error('bounded editor contact cap'));
    html = renderToStaticMarkup(await dossier());
    expect(html).toContain(contact.name);
    expect(html).not.toContain('Could not load this view');
    expect(html).not.toContain('Sign in again');
    expect(ports.trace.at(-1)).toBe('pg-after');
  });
  it('mismatched native/displayed identity never publishes edit grants', async () => {
    ports.pgEditor.mockResolvedValue({
      context,
      snapshot: { ...snapshot, identity: { ...snapshot.identity, name: 'Newer name' } },
    });
    const html = renderToStaticMarkup(await dossier());
    expect(html).toContain(contact.name);
    expect(html).not.toContain('Edit details');
  });
  it.each(['postgres', 'firestore'] as const)(
    '%s explains unavailable detail editing when the bounded snapshot only permits person creation',
    async (driver) => {
      ports.driver = driver;
      const createOnlySnapshot = { ...snapshot, identity: null, people: [] };
      ports.pgEditor.mockResolvedValue({ context, snapshot: createOnlySnapshot });
      ports.fsSnapshot.mockResolvedValue(createOnlySnapshot);
      const html = renderToStaticMarkup(await dossier());
      expect(html).toContain(contact.name);
      expect(html).toContain('Add person');
      expect(html).not.toContain('Edit details');
      expect(html).not.toContain('Add family relationship');
      expect(html).toContain(
        'Editing is temporarily unavailable. You can still browse this saved information.',
      );
    },
  );
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
  it('old owner cookie without a form scope gets a visible sign-in recovery link, with no grant read', async () => {
    ports.owner.mockResolvedValue({ user: { email: 'offline-owner@example.test' } });
    const html = renderToStaticMarkup(await directory());
    expect(ports.pgEditor).not.toHaveBeenCalled();
    expect(html).not.toContain('Add person');
    expect(html).toContain('Your sign-in needs refreshing');
    expect(html).toContain('Open Account, choose Sign out of this browser, then sign in again.');
    expect(html).not.toContain('href="/signin"');
    expect(html).not.toContain('Sign in again</a>');
    expect(html).toContain('method="get"');
  });
  it('valid form scope with release writes paused keeps the generic unavailable reason', async () => {
    ports.enabled = false;
    const html = renderToStaticMarkup(await directory());
    expect(ports.pgEditor).not.toHaveBeenCalled();
    expect(html).not.toContain('Add person');
    expect(html).toContain('Changes are unavailable in this view.');
    expect(html).not.toContain('Sign in again');
    expect(html).toContain('method="get"');
  });
  it('failure after the combined PG read discards both browse and prepared grants', async () => {
    ports.pgRead.mockImplementation(async (read) => {
      await read(leased);
      throw Error('owner/erasure changed after read');
    });
    const html = renderToStaticMarkup(await dossier());
    expect(html).toContain('Could not load this view');
    expect(html).not.toContain('Edit details');
    expect(html).toContain('q=retained%20search');
  });
  it('FS directory uses same outer owner/fence/store and context only, zero option scan/PG fallback', async () => {
    ports.driver = 'firestore';
    const html = renderToStaticMarkup(await directory());
    expect(ports.owner).toHaveBeenCalledOnce();
    expect(ports.owner.mock.invocationCallOrder[0]).toBeLessThan(
      ports.getStore.mock.invocationCallOrder[0] ?? 0,
    );
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
    expect(ports.getStore).toHaveBeenCalledOnce();
    expect(ports.terminate).not.toHaveBeenCalled();
    expect(ports.fsContext.mock.calls[0]?.[0]).toBe(ports.fsPeople.mock.calls[0]?.[0]);
  });
  it('FS dossier native editor snapshots stay inside the same owner/privacy read window', async () => {
    ports.driver = 'firestore';
    const html = renderToStaticMarkup(await dossier());
    expect(ports.owner).toHaveBeenCalledOnce();
    expect(ports.owner.mock.invocationCallOrder[0]).toBeLessThan(
      ports.getStore.mock.invocationCallOrder[0] ?? 0,
    );
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
    expect(html).toContain('Edit details');
    expect(ports.pgRead).not.toHaveBeenCalled();
    expect(ports.getStore).toHaveBeenCalledOnce();
    expect(ports.terminate).not.toHaveBeenCalled();
  });
  it('FS missing epoch skips optional native options and retains browse', async () => {
    ports.driver = 'firestore';
    ports.fsContext.mockResolvedValue(null);
    const html = renderToStaticMarkup(await dossier());
    expect(ports.fsSnapshot).not.toHaveBeenCalled();
    expect(html).toContain(contact.name);
    expect(html).not.toContain('Edit details');
    expect(ports.fsAfter).toHaveBeenCalledOnce();
  });
  it('FS bounded editor snapshot failure leaves the fenced dossier readable with no PG fallback', async () => {
    ports.driver = 'firestore';
    ports.fsSnapshot.mockRejectedValue(Error('raw contact/proof budget exceeded'));
    const html = renderToStaticMarkup(await dossier());
    expect(html).toContain(contact.name);
    expect(html).not.toContain('Could not load this view');
    expect(html).not.toContain('Edit details');
    expect(ports.fsOwner).toHaveBeenCalledTimes(2);
    expect(ports.fsAfter).toHaveBeenCalledOnce();
    expect(ports.pgRead).not.toHaveBeenCalled();
    expect(ports.terminate).not.toHaveBeenCalled();
  });
  it('reuses only the configured transport while every sequential and overlapping page read stays fresh', async () => {
    ports.driver = 'firestore';
    await directory();
    await dossier();
    await Promise.all([directory(), dossier()]);

    expect(ports.getStore).toHaveBeenCalledTimes(4);
    expect(ports.getStore.mock.results.map((result) => result.value)).toEqual(
      Array(4).fill(firestoreStore),
    );
    expect(ports.fsPeople).toHaveBeenCalledTimes(2);
    expect(ports.fsPerson).toHaveBeenCalledTimes(2);
    expect(ports.fsOwner).toHaveBeenCalledTimes(8);
    expect(ports.fsFence).toHaveBeenCalledTimes(4);
    expect(ports.fsAfter).toHaveBeenCalledTimes(4);
    expect(ports.fsContext).toHaveBeenCalledTimes(4);
    expect(ports.fsSnapshot).toHaveBeenCalledTimes(2);
    expect(ports.terminate).not.toHaveBeenCalled();
  });
  it('does not terminate the shared Firestore client when a page read fails', async () => {
    ports.driver = 'firestore';
    ports.fsPerson.mockRejectedValueOnce(Error('person read unavailable'));
    const html = renderToStaticMarkup(await dossier());

    expect(html).toContain('Could not load this view');
    expect(ports.getStore).toHaveBeenCalledOnce();
    expect(ports.fsOwner).toHaveBeenCalledOnce();
    expect(ports.fsFence).toHaveBeenCalledOnce();
    expect(ports.terminate).not.toHaveBeenCalled();
  });
  it('FS changed erasure after optional issuance discards prepared grants rather than return success', async () => {
    ports.driver = 'firestore';
    ports.fsAfter.mockRejectedValue(Error('erasure generation changed'));
    const html = renderToStaticMarkup(await dossier());
    expect(html).toContain('Could not load this view');
    expect(html).not.toContain('Edit details');
    expect(ports.pgRead).not.toHaveBeenCalled();
    expect(ports.terminate).not.toHaveBeenCalled();
  });
});

it('actual dossier returns to the selected Memory map with filters and anchor retained', async () => {
  const returnTo =
    '/profile/knowledge?view=map&entity=selected&memory=source&q=retained#knowledge-item';
  const html = renderToStaticMarkup(
    await Person({
      params: Promise.resolve({ id: contact.id }),
      searchParams: Promise.resolve({ returnTo }),
    }),
  );
  expect(html).toContain('Memory map');
  expect(html).toContain(
    'view=map&amp;entity=selected&amp;memory=source&amp;q=retained#knowledge-item',
  );
  expect(html).toContain('Edit details');
});

it('selects only the exact loaded connection without adding an edit or removal grant', async () => {
  const relationId = '33333333-3333-4333-8333-333333333333';
  const relation = {
    id: relationId,
    sentence: 'Sam Rivera is Alex’s friend.',
    label: 'Friend',
    otherLabel: 'Alex',
    otherContactId: ownerId,
    otherEntityId: ownerId,
    validFrom: null,
    validUntil: null,
    reviewStatus: 'confirmed' as const,
  };
  ports.person.mockImplementationOnce(async () => ({
    ...data.dossier,
    relations: [relation],
  }));
  const html = renderToStaticMarkup(
    await Person({
      params: Promise.resolve({ id: contact.id }),
      searchParams: Promise.resolve({
        returnTo: '/profile/knowledge?view=connections&q=Alex',
        connectionId: relationId,
      }),
    }),
  );
  expect(html).toContain(`id="person-connection-${relationId}"`);
  expect(html).toContain('aria-current="location"');
  expect(html).toContain('Sam Rivera is Alex’s friend.');
  expect(html).toContain(
    `href="/people/${ownerId}?returnTo=${encodeURIComponent('/profile/knowledge?view=connections&q=Alex')}&amp;connectionId=${relationId}#person-connection-${relationId}"`,
  );
  expect(html).not.toContain('Remove connection');
  expect(html).not.toContain('Edit relationship');
  expect(ports.pgEditor.mock.calls[0]?.[1]).toMatchObject({
    contactId: contact.id,
    relationIds: [relationId],
  });
  expect(ports.pgEditor).toHaveBeenCalledOnce();
});

it('selects a loaded non-person connection without adding it to family editor authority', async () => {
  const connectionId = '66666666-6666-4666-8666-666666666666';
  const sourceMemoryId = '88888888-8888-4888-8888-888888888888';
  const relationIds = data.dossier.relations.map((relation) => relation.id);
  ports.person.mockImplementationOnce(async () => ({
    ...data.dossier,
    connections: [
      {
        id: connectionId,
        sentence: 'Sam Rivera worked at Praça Studio.',
        label: 'Worked at',
        otherLabel: 'Praça Studio',
        otherKind: 'organization',
        validFrom: '2018',
        validUntil: null,
        sourceMemoryId,
      },
    ],
  }));
  const html = renderToStaticMarkup(
    await Person({
      params: Promise.resolve({ id: contact.id }),
      searchParams: Promise.resolve({ connectionId }),
    }),
  );
  expect(html).toContain(`id="person-connection-${connectionId}"`);
  expect(html).toContain('aria-current="location"');
  expect(html).toContain('Sam Rivera worked at Praça Studio.');
  expect(html).toContain('not a relationship between people');
  expect(html).toContain(`/profile/knowledge/notes/${sourceMemoryId}`);
  expect(html).not.toContain('Edit relationship');
  expect(html).not.toContain('Remove connection');
  expect(ports.pgEditor.mock.calls[0]?.[1]).toMatchObject({
    contactId: contact.id,
    relationIds,
  });
  expect(ports.pgEditor.mock.calls[0]?.[1].relationIds).not.toContain(connectionId);
});

it.each([
  ['stale or foreign connection', '55555555-5555-4555-8555-555555555555'],
  ['invalid connection identifier', '../private-note'],
])('%s is reported without revealing or loading a selected row', async (_label, connectionId) => {
  const html = renderToStaticMarkup(
    await Person({
      params: Promise.resolve({ id: contact.id }),
      searchParams: Promise.resolve({
        returnTo: '/profile/knowledge?view=connections&q=Alex',
        connectionId,
      }),
    }),
  );
  expect(html).toContain('The selected connection is unavailable in this view.');
  expect(html).not.toContain(connectionId);
  expect(html).not.toContain('aria-current="location"');
  expect(ports.pgEditor.mock.calls[0]?.[1]).toMatchObject({
    contactId: contact.id,
    relationIds: [],
  });
  expect(html).not.toContain('Remove connection');
});

it('retains a validated selected connection and return context when a dossier read must be retried', async () => {
  ports.pgRead.mockRejectedValue(Error('bounded read unavailable'));
  const selected = '33333333-3333-4333-8333-333333333333';
  const returnTo = '/profile/knowledge?view=connections&q=Alex';
  const html = renderToStaticMarkup(
    await Person({
      params: Promise.resolve({ id: contact.id }),
      searchParams: Promise.resolve({ connectionId: selected, returnTo }),
    }),
  );
  expect(html).toContain('Could not load this view');
  expect(html).toContain(`connectionId=${selected}#person-connection-${selected}`);
  expect(html).toContain(`returnTo=${encodeURIComponent(returnTo)}`);
  expect(html).not.toContain('Edit relationship');
  expect(ports.pgEditor).not.toHaveBeenCalled();
});
