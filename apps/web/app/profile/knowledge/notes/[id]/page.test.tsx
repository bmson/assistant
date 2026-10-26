import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { OwnerMemoryEditorView } from '@/lib/owner-memory-editor-view';

const auth = vi.hoisted(() => ({ requireOwner: vi.fn() }));
const loader = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: auth.requireOwner }));
vi.mock('@/lib/owner-memory-editor-server', () => ({ loadOwnerMemoryEditorView: loader.load }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));

import SavedNotePage from './page';

const id = '11111111-1111-4111-8111-111111111111';
const snapshot = {
  memoryId: id,
  ownerId: '33333333-3333-4333-8333-333333333333',
  content: 'Synthetic private note payload with distinct wording.',
  contentHash: 'a'.repeat(64),
  revision: 'b'.repeat(64),
  ownerCorrection: null,
  sourceLabel: 'Synthetic source label',
  eligible: true,
};
const grant = {
  command: 'correct_owner_memory' as const,
  operationId: '22222222-2222-4222-8222-222222222222',
  issuedOperationHandle: 'oe1.synthetic-issued-capability',
};
const view: OwnerMemoryEditorView = {
  snapshot,
  session: { ownerId: snapshot.ownerId, formSessionScope: 'a-valid-owner-session-scope' },
  grant,
  unavailableReason: null,
};

describe('saved note page and actual editor controls', () => {
  it('renders exact note/source and direct edit controls while keeping capability and draft out of page markup', async () => {
    auth.requireOwner.mockResolvedValue({ formSessionScope: view.session?.formSessionScope });
    loader.load.mockResolvedValue(view);
    const html = renderToStaticMarkup(
      await SavedNotePage({
        params: Promise.resolve({ id }),
        searchParams: Promise.resolve({ returnTo: '/profile/knowledge?view=library&query=family' }),
      }),
    );
    expect(html).toContain(snapshot.content);
    expect(html).toContain('A direct source link is unavailable for this saved note.');
    expect(html).not.toContain('Open source');
    expect(html).toContain('Edit saved note');
    expect(html).toContain('href="/profile/knowledge?view=library&amp;query=family"');
    expect(html).not.toContain(grant.issuedOperationHandle);
    expect(html).not.toContain(grant.operationId);
    expect(html).not.toContain('AUTH_SECRET');
    expect(html).not.toContain('value="Synthetic private note payload');
    expect(html).not.toContain('method="post"');
  });

  it('renders clear read-only reason and no enabled edit control when grant is absent', async () => {
    auth.requireOwner.mockResolvedValue({ formSessionScope: view.session?.formSessionScope });
    loader.load.mockResolvedValue({
      ...view,
      grant: null,
      session: null,
      unavailableReason: 'maintenance',
    });
    const html = renderToStaticMarkup(
      await SavedNotePage({
        params: Promise.resolve({ id }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('Editing is temporarily paused for maintenance.');
    expect(html).not.toContain('Edit saved note');
  });

  it('does not promise a source destination for aggregate read-only notes', async () => {
    auth.requireOwner.mockResolvedValue({ formSessionScope: view.session?.formSessionScope });
    loader.load.mockResolvedValue({
      ...view,
      session: null,
      grant: null,
      unavailableReason: 'aggregate_source',
      snapshot: { ...snapshot, eligible: false },
    });
    const html = renderToStaticMarkup(
      await SavedNotePage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain('This note combines source evidence and cannot be changed here.');
    expect(html).toContain('A direct source link is unavailable');
    expect(html).not.toContain('Open its source');
    expect(html).not.toContain('Open source');
  });

  it('rejects unsafe source links and falls back from an unsafe return destination', async () => {
    auth.requireOwner.mockResolvedValue({ formSessionScope: view.session?.formSessionScope });
    loader.load.mockResolvedValue({
      ...view,
      snapshot: { ...snapshot, sourceHref: '//attacker.test/path' },
    });
    const html = renderToStaticMarkup(
      await SavedNotePage({
        params: Promise.resolve({ id }),
        searchParams: Promise.resolve({ returnTo: '//attacker.test' }),
      }),
    );
    expect(html).not.toContain('attacker.test');
    expect(html).toContain('href="/profile/knowledge?view=library"');
  });
});
