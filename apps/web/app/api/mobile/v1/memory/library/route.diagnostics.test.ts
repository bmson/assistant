import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getDb: vi.fn(),
  getStore: vi.fn(),
  authenticated: vi.fn(),
  loadLibrary: vi.fn(),
  listMemoryLibrary: vi.fn(),
  listMemoryLibraryFilters: vi.fn(),
}));

vi.mock('@assistant/config', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('@assistant/application/profile', () => ({
  listMemoryLibrary: mocks.listMemoryLibrary,
  listMemoryLibraryFilters: mocks.listMemoryLibraryFilters,
}));
vi.mock('@/lib/server', () => ({
  getDb: mocks.getDb,
  getFirestoreInstallationStore: mocks.getStore,
}));
vi.mock('@/lib/firestore-knowledge', () => ({
  loadFirestoreMemoryLibrary: mocks.loadLibrary,
}));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.authenticated,
  mobileJson: (value: unknown, init?: ResponseInit) =>
    Response.json(value, { ...init, headers: { ...init?.headers, 'cache-control': 'no-store' } }),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

import { GET } from './route.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function result() {
  return [
    {
      rows: [
        {
          memory: {
            id: 'synthetic-memory-id',
            content: 'synthetic private row sentinel',
            domain: 'general',
            ownerConfirmed: true,
            pinned: false,
            importance: 1,
            lastConsolidatedAt: null,
            originTrust: 'owner',
            createdAt: new Date('2026-10-01T00:00:00.000Z'),
          },
          subjectId: null,
          subjectLabel: '',
          connectionCount: 0,
          projectionStatus: 'mapping',
        },
      ],
      total: 1,
      page: 1,
      totalPages: 1,
    },
    { subjects: [], sources: [] },
  ];
}

describe('mobile memory library diagnostic integration (synthetic, database-free)', () => {
  it('returns the original row while phase records omit query, owner data, and client request IDs', async () => {
    vi.stubEnv('K_REVISION', 'assistant-web-diagnostic-test');
    mocks.authenticated.mockResolvedValue(true);
    mocks.loadConfig.mockReturnValue({ PERSISTENCE_DRIVER: 'firestore' });
    mocks.loadLibrary.mockImplementation(async (_input, context) => {
      expect(context.requestId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(context.requestId).not.toBe('client-supplied-id');
      return result();
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const response = await GET(
      new Request(
        'https://example.invalid/api/mobile/v1/memory/library?q=synthetic-query-sentinel',
        { headers: { 'x-request-id': 'client-supplied-id' } },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      rows: [{ id: 'synthetic-memory-id', content: 'synthetic private row sentinel' }],
      total: 1,
    });

    const lines = info.mock.calls.map(([line]) => String(line));
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event.phase)).toEqual(['auth', 'config', 'serialize', 'overall']);
    expect(lines.join('\n')).not.toContain('synthetic-query-sentinel');
    expect(lines.join('\n')).not.toContain('synthetic private row sentinel');
    expect(lines.join('\n')).not.toContain('synthetic-memory-id');
    expect(lines.join('\n')).not.toContain('client-supplied-id');
    expect(lines.join('\n')).toContain('assistant-web-diagnostic-test');
  });

  it('rethrows the original library failure rather than converting it to an empty success', async () => {
    const failure = Object.assign(new Error('private query and owner content'), { code: 8 });
    mocks.authenticated.mockResolvedValue(true);
    mocks.loadConfig.mockReturnValue({ PERSISTENCE_DRIVER: 'firestore' });
    mocks.loadLibrary.mockRejectedValue(failure);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    await expect(
      GET(new Request('https://example.invalid/api/mobile/v1/memory/library')),
    ).rejects.toBe(failure);
    const lines = info.mock.calls.map(([line]) => String(line));
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event.phase)).toEqual(['auth', 'config', 'overall']);
    expect(events.at(-1)).toMatchObject({ outcome: 'error', errorCode: 'RESOURCE_EXHAUSTED' });
    expect(lines.join('\n')).not.toContain('private query and owner content');
  });

  it('keeps authentication failures on the existing 401 response path', async () => {
    mocks.authenticated.mockResolvedValue(false);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const response = await GET(new Request('https://example.invalid/api/mobile/v1/memory/library'));

    expect(response.status).toBe(401);
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(
      info.mock.calls.map(([line]) => (JSON.parse(String(line)) as { phase: string }).phase),
    ).toEqual(['auth', 'overall']);
  });
});
