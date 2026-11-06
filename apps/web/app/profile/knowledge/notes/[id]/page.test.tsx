import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { OwnerMemoryEditorView } from '@/lib/owner-memory-editor-view';

const auth = vi.hoisted(() => ({ requireOwner: vi.fn() }));
const loader = vi.hoisted(() => ({ load: vi.fn(), recoverySession: vi.fn() }));
vi.mock('@/auth', () => ({ requireOwner: auth.requireOwner }));
vi.mock('@/lib/owner-memory-editor-server', () => ({
  loadOwnerMemoryEditorView: loader.load,
  loadOwnerMemoryEditorRecoverySession: loader.recoverySession,
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));

import {
  MissingSavedNoteRecovery,
  missingSavedNoteRecoveryPresentation,
  ownerMemoryRemovalReceiptConfirmed,
} from './owner-memory-editor';
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
  removalGrant: null,
  removalImpact: null,
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
    expect(html).toContain('aria-label="Memory"');
    expect([...html.matchAll(/aria-label="Memory"/g)]).toHaveLength(1);
    const memoryNavigation = /<nav\b[^>]*aria-label="Memory"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
    expect(memoryNavigation).toMatch(/<a\b[^>]*aria-current="page"[^>]*>Saved notes<\/a>/);
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

  it('renders a missing-note recovery shell instead of returning 404 after removal', async () => {
    auth.requireOwner.mockResolvedValue({ formSessionScope: view.session?.formSessionScope });
    loader.load.mockResolvedValue(null);
    loader.recoverySession.mockResolvedValue(view.session);
    const html = renderToStaticMarkup(
      await SavedNotePage({
        params: Promise.resolve({ id }),
        searchParams: Promise.resolve({ returnTo: '/profile/knowledge?view=library' }),
      }),
    );
    expect(html).toContain('Saved note unavailable');
    expect(html).toContain('This saved note could not be found.');
    expect(html).toContain('Checking this browser for the original operation…');
    expect(html).toContain('Return to Memory');
    expect(html).toContain('href="/profile/knowledge?view=library"');
    expect(html).not.toContain('NOT_FOUND');
    expect(html).not.toContain('Edit saved note');
    expect(html).not.toContain('Forget saved note');
  });

  it('does not pretend to check a result when this session cannot create a recovery controller', () => {
    const html = renderToStaticMarkup(
      <MissingSavedNoteRecovery
        memoryId={id}
        session={null}
        returnHref="/profile/knowledge?view=library"
      />,
    );
    expect(html).toContain('Result checking is unavailable in this session');
    expect(html).not.toContain('Checking this browser');
    expect(html).not.toContain('Check original result');
  });

  it('checks only the same note removal marker and distinguishes its receipt from a missing row', () => {
    const checking = {
      phase: 'checking' as const,
      reviewRequired: false,
      reviewTargetId: null,
      marker: null,
      busy: false,
      reply: null,
      fieldErrors: {},
      message: '',
    };
    expect(missingSavedNoteRecoveryPresentation(checking, id)).toMatchObject({
      kind: 'checking',
      message: 'Checking this browser for the original operation…',
    });

    expect(
      missingSavedNoteRecoveryPresentation({ ...checking, phase: 'blocked' }, id),
    ).toMatchObject({
      kind: 'not_confirmed',
      message:
        'This browser could not safely check the original operation. A missing note alone does not confirm removal.',
    });
    const ready = { ...checking, phase: 'ready' as const };
    expect(missingSavedNoteRecoveryPresentation(ready, id)).toMatchObject({
      kind: 'missing',
      message:
        'No matching pending removal in this browser. A missing note alone does not confirm removal.',
    });

    const marker = {
      id: 'opaque-issued-handle',
      command: 'remove_owner_memory' as const,
      targetId: id,
    };
    const pending = {
      phase: 'pending' as const,
      reviewRequired: false,
      reviewTargetId: id,
      marker,
      busy: false,
      reply: null,
      fieldErrors: {},
      message: 'Saved note removal could not be confirmed. Check its result before removing again.',
    };
    expect(missingSavedNoteRecoveryPresentation(pending, id).kind).toBe('pending');
    const unresolved = {
      ...pending,
      reply: {
        version: 1 as const,
        authority: 'unresolved' as const,
        command: 'remove_owner_memory' as const,
        operationId: '22222222-2222-4222-8222-222222222222',
        outcome: 'outcome_unknown' as const,
        reason: 'receipt_missing' as const,
      },
    };
    expect(missingSavedNoteRecoveryPresentation(unresolved, id).kind).toBe('pending');

    expect(
      missingSavedNoteRecoveryPresentation(pending, '55555555-5555-4555-8555-555555555555'),
    ).toMatchObject({ kind: 'missing' });

    const savedReply = {
      version: 1 as const,
      authority: 'operation_receipt',
      command: 'remove_owner_memory',
      operationId: '22222222-2222-4222-8222-222222222222',
      requestHash: 'a'.repeat(64),
      statusVersion: 2,
      outcome: 'saved',
      ids: { memoryId: id },
      revision: 'b'.repeat(64),
      refreshPending: true,
    } as const;
    const confirmed = {
      ...pending,
      phase: 'resolved' as const,
      marker: null,
      reply: savedReply,
      message: 'Saved note removed. Some map details may take a moment to update.',
    };
    expect(missingSavedNoteRecoveryPresentation(confirmed, id)).toMatchObject({
      kind: 'removed',
      message: 'The receipt confirms this saved note was removed.',
    });
    expect(ownerMemoryRemovalReceiptConfirmed(savedReply, id)).toBe(true);
    const otherNoteReply = {
      ...savedReply,
      ids: { memoryId: '55555555-5555-4555-8555-555555555555' },
    };
    expect(ownerMemoryRemovalReceiptConfirmed(otherNoteReply, id)).toBe(false);
    expect(
      missingSavedNoteRecoveryPresentation({ ...confirmed, reply: otherNoteReply }, id).kind,
    ).toBe('not_confirmed');
    expect(
      ownerMemoryRemovalReceiptConfirmed(
        { ...savedReply, command: 'correct_owner_memory' as const },
        id,
      ),
    ).toBe(false);

    const retired = {
      version: 1 as const,
      authority: 'scope_retirement' as const,
      command: 'remove_owner_memory' as const,
      operationId: savedReply.operationId,
      outcome: 'voided' as const,
      reason: 'replay_window_retired' as const,
    };
    expect(
      missingSavedNoteRecoveryPresentation({ ...confirmed, reply: retired }, id),
    ).toMatchObject({ kind: 'not_confirmed' });
  });
});
