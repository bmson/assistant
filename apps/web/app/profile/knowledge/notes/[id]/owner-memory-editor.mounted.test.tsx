// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeOwnerEditorPendingMarker } from '@/lib/owner-editor-client';
import type { OwnerMemoryEditorView } from '@/lib/owner-memory-editor-view';

const navigation = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { OwnerMemoryEditor } from './owner-memory-editor';

const memoryId = '11111111-1111-4111-8111-111111111111';
const ownerId = '33333333-3333-4333-8333-333333333333';
const formSessionScope = 'owner-session-mounted-fixture';
const operationId = '22222222-2222-4222-8222-222222222222';
const markerId = 'oe1.synthetic-removal-handle';
const returnHref = '/profile/knowledge?view=library';
const noteBody = 'Synthetic note body should disappear after the receipt confirms removal.';
let container: HTMLDivElement;
let root: Root;

const view: OwnerMemoryEditorView = {
  snapshot: {
    memoryId,
    ownerId,
    content: noteBody,
    contentHash: 'a'.repeat(64),
    revision: 'b'.repeat(64),
    ownerCorrection: null,
    sourceLabel: 'Synthetic source label',
    eligible: true,
  },
  session: { ownerId, formSessionScope },
  grant: {
    command: 'correct_owner_memory',
    operationId: '44444444-4444-4444-8444-444444444444',
    issuedOperationHandle: 'oe1.synthetic-correction-handle',
  },
  removalGrant: {
    command: 'remove_owner_memory',
    operationId,
    issuedOperationHandle: markerId,
  },
  removalImpact: {
    memoryId,
    revision: 'c'.repeat(64),
    connectionCount: 1,
    sourceEvidenceCount: 0,
    orphanedItems: [],
  },
  unavailableReason: null,
};

const receipt = {
  version: 1,
  authority: 'operation_receipt',
  command: 'remove_owner_memory',
  operationId,
  requestHash: 'd'.repeat(64),
  statusVersion: 1,
  outcome: 'saved',
  ids: { memoryId },
  revision: 'e'.repeat(64),
  refreshPending: true,
};

beforeEach(() => {
  navigation.refresh.mockReset();
  navigation.replace.mockReset();
  window.sessionStorage.clear();
  writeOwnerEditorPendingMarker(window.sessionStorage, ownerId, formSessionScope, {
    id: markerId,
    command: 'remove_owner_memory',
    targetId: memoryId,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(receipt)),
  );
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('mounted saved-note removal receipt', () => {
  it('keeps the receipt visible, hides stale page content, and waits for explicit Back navigation', async () => {
    await act(async () =>
      root.render(
        <OwnerMemoryEditor
          view={view}
          returnHref={returnHref}
          sourceHref={null}
          readOnlyMessage=""
        />,
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(container.textContent).toContain(noteBody);
    expect(container.textContent).toContain('Synthetic source label');
    expect(container.textContent).not.toContain(
      'The receipt confirms this saved note was removed.',
    );

    const check = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Check result',
    );
    expect(check).toBeDefined();
    await act(async () => {
      check?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('The receipt confirms this saved note was removed.');
    expect(container.textContent).not.toContain(noteBody);
    expect(container.textContent).not.toContain('Synthetic source label');
    expect(container.textContent).not.toContain('Edit saved note');
    expect(container.querySelector('a')?.getAttribute('href')).toBe(returnHref);
    expect(container.querySelector('a')?.textContent).toBe('Back to Memory');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/profile/knowledge/memory?operation='),
      expect.objectContaining({ method: 'GET' }),
    );
    expect(navigation.refresh).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(window.sessionStorage.length).toBe(0);

    await act(async () =>
      root.render(
        <OwnerMemoryEditor
          view={view}
          returnHref={returnHref}
          sourceHref={null}
          readOnlyMessage=""
        />,
      ),
    );
    expect(container.textContent).toContain('The receipt confirms this saved note was removed.');
    expect(container.textContent).not.toContain(noteBody);
    expect(container.textContent).not.toContain('Synthetic source label');
    expect(navigation.refresh).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});
