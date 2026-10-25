import { NextRequest } from 'next/server';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  driver: 'postgres',
  people: vi.fn(),
  person: vi.fn(),
  library: vi.fn(),
  filters: vi.fn(),
  map: vi.fn(),
  graph: vi.fn(),
  pgRead: vi.fn(),
  fsPeople: vi.fn(),
  fsPerson: vi.fn(),
  fsLibrary: vi.fn(),
  fsLoad: vi.fn(),
  fsFocus: vi.fn(),
  fsMap: vi.fn(),
  terminate: vi.fn(),
}));
vi.mock('@/auth', () => ({ requireOwner: mocks.owner }));
vi.mock('@assistant/config', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadConfig: () => ({
    PERSISTENCE_DRIVER: mocks.driver,
    FIRESTORE_AGENT_ID: 'owner',
    GCP_PROJECT: 'synthetic',
    ASSISTANT_WORKSPACE_ID: 'synthetic',
    ASSISTANT_RELEASE_WRITES_PAUSED: false,
    RESTORE_REHEARSAL: false,
    WEB_APP_PREVIEW_ENABLED: false,
    AUTH_URL: '',
  }),
  validateAgentPersistenceConfig: () => [],
}));
vi.mock('@assistant/application/people', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listPeopleDirectory: mocks.people,
  getPersonDossier: mocks.person,
}));
vi.mock('@assistant/application/profile', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listMemoryLibrary: mocks.library,
  listMemoryLibraryFilters: mocks.filters,
}));
vi.mock('@assistant/application', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getKnowledgeMapSnapshot: mocks.map,
  getKnowledgeGraphOverview: mocks.graph,
}));
vi.mock('@/lib/server', () => ({ withPostgresMemoryBrowseRead: mocks.pgRead }));
vi.mock('@assistant/firestore', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createInstallationStore: () => ({ db: { terminate: mocks.terminate } }),
}));
vi.mock('@/lib/firestore-people', () => ({
  listFirestorePeopleDirectory: mocks.fsPeople,
  getFirestorePersonDossier: mocks.fsPerson,
}));
vi.mock('@/lib/firestore-knowledge', () => ({
  loadFirestoreMemoryLibrary: mocks.fsLibrary,
  getFirestoreKnowledgeWorkspace: () => ({ load: mocks.fsLoad }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));

import { proxy } from '@/proxy';
import Person from '../people/[id]/page';
import People from '../people/page';
import { createProductVisualData } from '../product-visual-data';
import Knowledge from './knowledge/page';
import Hub from './page';

const personId = '00000000-0000-4000-8000-000000000001';
const emptyMap = {
  nodes: [],
  edges: [],
  components: [],
  totalEdges: 0,
  truncated: false,
  filters: { query: '', kind: '', predicates: [], review: 'all', sourceMemoryId: '' },
};
const emptyLibrary = { rows: [], total: 0, page: 1, totalPages: 0 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.driver = 'postgres';
  mocks.owner.mockResolvedValue({ user: { email: 'owner@example.test' } });
  mocks.pgRead.mockImplementation(async (read) => read({}));
  mocks.people.mockResolvedValue([]);
  mocks.fsPeople.mockResolvedValue([]);
  mocks.person.mockResolvedValue(null);
  mocks.fsPerson.mockResolvedValue(null);
  mocks.library.mockResolvedValue(emptyLibrary);
  mocks.filters.mockResolvedValue({ subjects: [], sources: [] });
  mocks.map.mockResolvedValue(emptyMap);
  mocks.graph.mockResolvedValue({ selected: null });
  mocks.fsLibrary.mockResolvedValue([emptyLibrary, { subjects: [], sources: [] }]);
  mocks.fsFocus.mockResolvedValue(null);
  mocks.fsMap.mockResolvedValue(emptyMap);
  mocks.fsLoad.mockResolvedValue({ focus: mocks.fsFocus, map: mocks.fsMap });
});
function noWrites(html: string) {
  expect(html).not.toMatch(
    /method="post"|Add connection|Save changes|Delete person|Cleanup<|Forget source|Add person/i,
  );
}
describe('Memory browse server composition', () => {
  it('authenticates a static two-tile hub without reading omitted private panels', async () => {
    const html = renderToStaticMarkup(await Hub());
    expect(html).toContain('What I remember');
    expect(html).toContain('href="/people"');
    expect(html).toContain('/profile/knowledge?view=library');
    expect(mocks.owner).toHaveBeenCalledOnce();
    expect(mocks.pgRead).not.toHaveBeenCalled();
    expect(mocks.fsLoad).not.toHaveBeenCalled();
    expect(mocks.library).not.toHaveBeenCalled();
    noWrites(html);
  });
  it('rejects unauthenticated browse before any data callback', async () => {
    mocks.owner.mockRejectedValueOnce(new Error('unauthorized'));
    await expect(People({ searchParams: Promise.resolve({}) })).rejects.toThrow('unauthorized');
    expect(mocks.pgRead).not.toHaveBeenCalled();
    expect(mocks.people).not.toHaveBeenCalled();
  });
  it.each(['postgres', 'firestore'])(
    'renders bounded directory GET search with q return context (%s)',
    async (driver) => {
      mocks.driver = driver;
      const rows = [
        {
          id: personId,
          name: 'Ada Example',
          relationship: 'friend',
          location: 'Rome',
          group: 'friends',
          trust: 'known',
          birthday: null,
          lastContactAt: null,
        },
      ];
      mocks.people.mockResolvedValue(rows);
      mocks.fsPeople.mockResolvedValue(rows);
      const html = renderToStaticMarkup(
        await People({ searchParams: Promise.resolve({ q: 'Ada' }) }),
      );
      expect(html).toContain(`href="/people/${personId}?q=Ada"`);
      expect(html).toContain('shown in this view');
      expect(html).toContain('method="get"');
      noWrites(html);
      if (driver === 'firestore') {
        expect(mocks.pgRead).not.toHaveBeenCalled();
        expect(mocks.terminate).toHaveBeenCalledOnce();
      }
    },
  );
  it.each(['wrong-owner', 'erasure', 'unavailable'])(
    'never turns PG %s failure into empty directory',
    async (reason) => {
      mocks.pgRead.mockRejectedValueOnce(new Error(reason));
      const html = renderToStaticMarkup(
        await People({ searchParams: Promise.resolve({ q: 'retained' }) }),
      );
      expect(html).toContain('Could not load this view');
      expect(html).toContain('/people?q=retained');
      expect(mocks.people).not.toHaveBeenCalled();
      expect(html).not.toContain('No people are available');
    },
  );
  it('distinguishes invalid and missing person from read failure', async () => {
    await expect(Person({ params: Promise.resolve({ id: 'invalid' }) })).rejects.toThrow(
      'NOT_FOUND',
    );
    expect(mocks.person).not.toHaveBeenCalled();
    await expect(Person({ params: Promise.resolve({ id: personId }) })).rejects.toThrow(
      'NOT_FOUND',
    );
    mocks.pgRead.mockRejectedValueOnce(new Error('erasure'));
    const html = renderToStaticMarkup(
      await Person({
        params: Promise.resolve({ id: personId }),
        searchParams: Promise.resolve({ q: 'Ada' }),
      }),
    );
    expect(html).toContain('Person unavailable');
    expect(html).toContain('/people?q=Ada');
  });
  it.each(['postgres', 'firestore'])(
    'only loads library/filter reads for safe cleanup fallback (%s)',
    async (driver) => {
      mocks.driver = driver;
      const html = renderToStaticMarkup(
        await Knowledge({
          searchParams: Promise.resolve({ view: 'cleanup', q: 'held', state: 'review' }),
        }),
      );
      noWrites(html);
      expect(html).toContain('Editing and cleanup are unavailable');
      expect(html).toContain('method="get"');
      expect(mocks.graph).not.toHaveBeenCalled();
      expect(mocks.map).not.toHaveBeenCalled();
      expect(mocks.fsLoad).not.toHaveBeenCalled();
    },
  );
  it.each(['postgres', 'firestore'])(
    'keeps source-scoped map GET inputs and no library reads (%s)',
    async (driver) => {
      mocks.driver = driver;
      const html = renderToStaticMarkup(
        await Knowledge({
          searchParams: Promise.resolve({
            view: 'map',
            memory: personId,
            family: 'family',
            kind: 'person',
            review: 'unreviewed',
          }),
        }),
      );
      noWrites(html);
      expect(html).toContain('Source note filter');
      expect(html).toContain('Remove source filter');
      expect(html).not.toContain('Start with the memory desk');
      expect(mocks.library).not.toHaveBeenCalled();
      expect(mocks.fsLibrary).not.toHaveBeenCalled();
      const call = (driver === 'postgres' ? mocks.map : mocks.fsMap).mock.calls[0];
      expect(JSON.stringify(call)).toContain(personId);
      expect(JSON.stringify(call)).toContain('unreviewed');
    },
  );
});

function savedHref(html: string, matches: (url: URL) => boolean): string {
  const paths = [...html.matchAll(/href="([^"]+)"/g)].map((match) =>
    (match[1] ?? '').replaceAll('&amp;', '&'),
  );
  const path = paths.find((value) => matches(new URL(value, 'https://assistant.test')));
  if (!path) throw new Error('Expected retained GET link was not rendered');
  return path;
}

// This composes actual proxy ingress and actual server page components with
// named synthetic I/O. HEAD is ingress-only; this is not a browser/HTTP journey.
describe.each(['postgres', 'firestore'])('synthetic retained page journey (%s)', (driver) => {
  it('follows hub, searched directory, positive dossier, return context, library filters and source map', async () => {
    mocks.driver = driver;
    const data = createProductVisualData(false);
    const person = data.dossier.profile.contact;
    const memory = data.library.rows[0]?.memory;
    if (!memory) throw new Error('Expected synthetic source note');
    const filters = {
      subjects: [{ id: person.id, label: person.name, trust: person.trust }],
      sources: ['manual'],
    };
    mocks.people.mockResolvedValue(data.people);
    mocks.fsPeople.mockResolvedValue(data.people);
    mocks.person.mockResolvedValue(data.dossier);
    mocks.fsPerson.mockResolvedValue(data.dossier);
    mocks.library.mockResolvedValue(data.library);
    mocks.filters.mockResolvedValue(filters);
    mocks.fsLibrary.mockResolvedValue([data.library, filters]);
    mocks.map.mockResolvedValue(data.map);
    mocks.fsMap.mockResolvedValue(data.map);
    const trace: string[] = [];
    const visited: string[] = [];
    const get = async (path: string, page: (url: URL) => Promise<ReactNode>) => {
      const url = new URL(path, 'https://assistant.test');
      const exact = `${url.pathname}${url.search}`;
      visited.push(exact);
      for (const method of ['GET', 'HEAD']) {
        const response = proxy(new NextRequest(url, { method }));
        trace.push(`${method} ${exact}`);
        expect(response.headers.get('x-middleware-next')).toBe('1');
        expect(response.headers.get('location')).toBeNull();
      }
      const html = renderToStaticMarkup(await page(url));
      noWrites(html);
      return html;
    };
    const hub = await get('/profile', () => Hub());
    const directoryPath = savedHref(hub, (url) => url.pathname === '/people');
    const directory = await get(`${directoryPath}?q=Sam`, (url) =>
      People({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) }),
    );
    const dossierPath = savedHref(directory, (url) => url.pathname === `/people/${person.id}`);
    const dossier = await get(dossierPath, (url) =>
      Person({
        params: Promise.resolve({ id: person.id }),
        searchParams: Promise.resolve({ q: url.searchParams.get('q') ?? undefined }),
      }),
    );
    expect(dossier).toContain(person.name);
    expect(dossier).toContain(data.dossier.profile.facts[0]?.content ?? 'missing synthetic fact');
    expect(dossier).toContain(data.dossier.events[0]?.content ?? 'missing synthetic event');
    const back = savedHref(
      dossier,
      (url) => url.pathname === '/people' && url.searchParams.get('q') === 'Sam',
    );
    const returned = await get(back, (url) =>
      People({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) }),
    );
    expect(returned).toContain(person.name);
    const libraryURL = new URL(
      savedHref(hub, (url) => url.searchParams.get('view') === 'library'),
      'https://assistant.test',
    );
    libraryURL.searchParams.set('q', 'Alex');
    libraryURL.searchParams.set('filter', 'verified');
    libraryURL.searchParams.set('domain', 'home');
    libraryURL.searchParams.set('source', 'manual');
    libraryURL.searchParams.set('connectivity', 'connected');
    const libraryPath = `${libraryURL.pathname}${libraryURL.search}`;
    const library = await get(libraryPath, (url) =>
      Knowledge({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) }),
    );
    expect(library).toContain('method="get"');
    for (const field of ['q', 'filter', 'subject', 'domain', 'source', 'connectivity'])
      expect(library).toContain(`name="${field}"`);
    expect(library).toContain(memory.content);
    const libraryInput =
      driver === 'postgres' ? mocks.library.mock.calls[0]?.[1] : mocks.fsLibrary.mock.calls[0]?.[0];
    expect(libraryInput).toMatchObject({
      query: 'Alex',
      filter: 'verified',
      domain: 'home',
      source: 'manual',
      connectivity: 'connected',
    });
    const sourceMapPath = savedHref(
      library,
      (url) =>
        url.searchParams.get('view') === 'map' && url.searchParams.get('memory') === memory.id,
    );
    const map = await get(sourceMapPath, (url) =>
      Knowledge({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) }),
    );
    expect(map).toContain('Source note filter');
    const mapInput =
      driver === 'postgres' ? mocks.map.mock.calls[0]?.[1] : mocks.fsMap.mock.calls[0]?.[0];
    expect(mapInput).toMatchObject({
      sourceMemoryId: memory.id,
      completeOverview: driver === 'firestore',
    });
    expect(trace).toEqual([
      'GET /profile',
      'HEAD /profile',
      'GET /people?q=Sam',
      'HEAD /people?q=Sam',
      `GET /people/${person.id}?q=Sam`,
      `HEAD /people/${person.id}?q=Sam`,
      'GET /people?q=Sam',
      'HEAD /people?q=Sam',
      `GET ${libraryPath}`,
      `HEAD ${libraryPath}`,
      `GET ${sourceMapPath}`,
      `HEAD ${sourceMapPath}`,
    ]);
    const writeHandler = vi.fn();
    for (const path of new Set(visited)) {
      const response = proxy(
        new NextRequest(`https://assistant.test${path}`, {
          method: 'POST',
          headers: { 'next-action': 'synthetic-write-action' },
        }),
      );
      if (response.headers.get('x-middleware-next') === '1') writeHandler();
      expect(response.status).toBe(405);
      expect(response.headers.get('x-middleware-next')).toBeNull();
    }
    expect(writeHandler).not.toHaveBeenCalled();
    expect(mocks.owner).toHaveBeenCalledTimes(6);
    if (driver === 'firestore') {
      expect(mocks.pgRead).not.toHaveBeenCalled();
      expect(mocks.people).not.toHaveBeenCalled();
      expect(mocks.person).not.toHaveBeenCalled();
      expect(mocks.library).not.toHaveBeenCalled();
      expect(mocks.map).not.toHaveBeenCalled();
    }
  });
});

const firestoreFailureCases = (['directory', 'dossier', 'library'] as const).flatMap((surface) =>
  ['wrong-owner', 'active-erasure', 'bounded-scan-limit', 'transport'].map((failure) => ({
    surface,
    failure,
  })),
);

it.each(firestoreFailureCases)(
  'keeps Firestore $surface $failure unavailable with a query-preserving retry',
  async ({ surface, failure }) => {
    mocks.driver = 'firestore';
    const error = new Error(`Synthetic ${failure}`);
    let html: string;
    let retryPath: string;
    if (surface === 'directory') {
      mocks.fsPeople.mockRejectedValueOnce(error);
      html = renderToStaticMarkup(
        await People({ searchParams: Promise.resolve({ q: 'retained' }) }),
      );
      retryPath = '/people?q=retained';
      expect(mocks.terminate).toHaveBeenCalledTimes(1);
    } else if (surface === 'dossier') {
      mocks.fsPerson.mockRejectedValueOnce(error);
      html = renderToStaticMarkup(
        await Person({
          params: Promise.resolve({ id: personId }),
          searchParams: Promise.resolve({ q: 'retained' }),
        }),
      );
      retryPath = `/people/${personId}?q=retained`;
      expect(html).toContain('Person unavailable');
      expect(mocks.terminate).toHaveBeenCalledTimes(1);
    } else {
      mocks.fsLibrary.mockRejectedValueOnce(error);
      html = renderToStaticMarkup(
        await Knowledge({
          searchParams: Promise.resolve({
            view: 'library',
            q: 'retained',
            filter: 'verified',
            source: 'manual',
          }),
        }),
      );
      retryPath = savedHref(
        html,
        (url) => url.pathname === '/profile/knowledge' && url.searchParams.get('q') === 'retained',
      );
      const retry = new URL(retryPath, 'https://assistant.test');
      expect(retry.searchParams.get('filter')).toBe('verified');
      expect(retry.searchParams.get('source')).toBe('manual');
    }
    expect(html).toContain('Could not load this view');
    expect(savedHref(html, (url) => `${url.pathname}${url.search}` === retryPath)).toBe(retryPath);
    expect(html).toContain('Try again');
    expect(html).not.toMatch(
      /No people are available|No people match|No matching notes|No connected knowledge/,
    );
    expect(mocks.pgRead).not.toHaveBeenCalled();
    expect(mocks.people).not.toHaveBeenCalled();
    expect(mocks.person).not.toHaveBeenCalled();
    expect(mocks.library).not.toHaveBeenCalled();
    expect(mocks.filters).not.toHaveBeenCalled();
    expect(mocks.map).not.toHaveBeenCalled();
    expect(mocks.graph).not.toHaveBeenCalled();
    for (const method of ['GET', 'HEAD']) {
      const response = proxy(new NextRequest(`https://assistant.test${retryPath}`, { method }));
      expect(response.headers.get('x-middleware-next')).toBe('1');
    }
    noWrites(html);
  },
);

function activeKnowledgeTab(html: string): string[] {
  const nav = /<nav\b[^>]*aria-label="Knowledge views"[\s\S]*?<\/nav>/.exec(html)?.[0];
  if (!nav) throw new Error('Expected actual knowledge-view tabs');
  return [...nav.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
    .filter((match) => match[1]?.includes('aria-current="page"'))
    .map((match) => (match[2] ?? '').replace(/<[^>]*>/g, '').trim());
}

it.each(['postgres', 'firestore'])(
  'switches focused legacy Map to explicit Library and back through actual tab hrefs (%s)',
  async (driver) => {
    mocks.driver = driver;
    const data = createProductVisualData(false);
    const selected = data.map.nodes[0];
    const source = data.library.rows[0]?.memory;
    if (!selected || !source) throw new Error('Expected synthetic focused source fixture');
    mocks.map.mockResolvedValue(data.map);
    mocks.fsMap.mockResolvedValue(data.map);
    mocks.graph.mockResolvedValue({ selected });
    mocks.fsFocus.mockResolvedValue({ selected });
    mocks.library.mockResolvedValue(data.library);
    mocks.filters.mockResolvedValue({ subjects: [], sources: [] });
    mocks.fsLibrary.mockResolvedValue([data.library, { subjects: [], sources: [] }]);
    const context = {
      entity: selected.id,
      memory: source.id,
      q: 'Alex',
      family: 'family',
      kind: 'person',
      review: 'unreviewed',
    };
    const mapRead = driver === 'postgres' ? mocks.map : mocks.fsMap;
    const libraryRead = driver === 'postgres' ? mocks.library : mocks.fsLibrary;
    const mapInput = () =>
      driver === 'postgres' ? mapRead.mock.lastCall?.[1] : mapRead.mock.lastCall?.[0];
    const renderTab = async (path: string) => {
      const url = new URL(path, 'https://assistant.test');
      for (const method of ['GET', 'HEAD']) {
        expect(proxy(new NextRequest(url, { method })).headers.get('x-middleware-next')).toBe('1');
      }
      return renderToStaticMarkup(
        await Knowledge({ searchParams: Promise.resolve(Object.fromEntries(url.searchParams)) }),
      );
    };
    // Compatibility: an entity with no explicit view still opens the Map.
    const focused = renderToStaticMarkup(
      await Knowledge({ searchParams: Promise.resolve(context) }),
    );
    expect(activeKnowledgeTab(focused)).toEqual(['Map']);
    expect(mapRead).toHaveBeenCalledTimes(1);
    expect(libraryRead).not.toHaveBeenCalled();
    expect(mapInput()).toMatchObject({ entityId: selected.id, sourceMemoryId: source.id });
    const libraryHref = savedHref(
      focused,
      (url) => url.pathname === '/profile/knowledge' && url.searchParams.get('view') === 'library',
    );
    const libraryURL = new URL(libraryHref, 'https://assistant.test');
    for (const [key, value] of Object.entries(context))
      expect(libraryURL.searchParams.get(key)).toBe(value);
    const library = await renderTab(libraryHref);
    expect(activeKnowledgeTab(library)).toEqual(['Library']);
    expect(libraryRead).toHaveBeenCalledTimes(1);
    expect(mapRead).toHaveBeenCalledTimes(1);
    const libraryInput =
      driver === 'postgres' ? libraryRead.mock.lastCall?.[1] : libraryRead.mock.lastCall?.[0];
    expect(libraryInput).not.toHaveProperty('entityId');
    expect(libraryInput).not.toHaveProperty('sourceMemoryId');
    expect(library).toContain(source.content);
    expect(library).toContain(
      'Map filters are retained for the Map view; they do not filter these notes.',
    );
    expect(library).toContain('Map source note filter retained (not applied to the Library)');
    expect(library).not.toContain('aria-label="Selected knowledge item"');
    const mapHref = savedHref(
      library,
      (url) => url.pathname === '/profile/knowledge' && url.searchParams.get('view') === 'map',
    );
    const mapURL = new URL(mapHref, 'https://assistant.test');
    for (const [key, value] of Object.entries(context))
      expect(mapURL.searchParams.get(key)).toBe(value);
    const restored = await renderTab(mapHref);
    expect(activeKnowledgeTab(restored)).toEqual(['Map']);
    expect(mapRead).toHaveBeenCalledTimes(2);
    expect(libraryRead).toHaveBeenCalledTimes(1);
    expect(mapInput()).toMatchObject({ entityId: selected.id, sourceMemoryId: source.id });
    expect(restored).toContain('aria-label="Selected knowledge item"');
    noWrites(library);
    noWrites(restored);
    if (driver === 'firestore') expect(mocks.pgRead).not.toHaveBeenCalled();
  },
);
