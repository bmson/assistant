import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import type { OwnerEditorReply } from '@assistant/persistence/owner-editor';
import {
  type OwnerEditorStorage,
  readOwnerEditorPendingMarker,
  writeOwnerEditorPendingMarker,
} from '@/lib/owner-editor-client';
import { OwnerEditorOperation, ownerEditorOutcomeMessage } from '@/lib/owner-editor-operation';
import {
  checkSavedNotePendingResult,
  SavedNoteRecovery,
  savedNoteHasConflict,
} from './owner-memory-editor';

const props = {
  state: {
    message: 'The earlier save has no confirmed result yet.',
    phase: 'pending' as const,
    busy: false,
  },
  awaitingReadback: false,
  sessionMatches: true,
  otherNote: null,
  reload: vi.fn(),
  checkResult: vi.fn(),
};
describe('saved note dialog recovery content', () => {
  it('keeps one pending result action and the close/draft guidance in the dialog', () => {
    const html = renderToStaticMarkup(
      <div role="dialog">
        <SavedNoteRecovery {...props} />
      </div>,
    );
    expect(html).toContain(props.state.message);
    const checkButtons = html.match(/<button[^>]*>Check result<\/button>/g) ?? [];
    expect(checkButtons).toHaveLength(1);
    expect(checkButtons[0]).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(html).not.toContain('Check earlier save');
    expect(html).not.toContain('Resolve earlier save');
    expect(html).toContain('Closing this editor does not cancel a save.');
  });
  it('disables the single check action while an operation is busy', () => {
    const busy = renderToStaticMarkup(
      <SavedNoteRecovery {...props} state={{ ...props.state, busy: true }} />,
    );
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*>Check result<\/button>/);
    expect(busy).not.toContain('Resolve earlier save');
  });
  it('resolves a reloaded note after its original proof-backed reconciliation', async () => {
    const ownerId = '33333333-3333-4333-8333-333333333333';
    const formSessionScope = 'saved-note-check-result-fixture';
    const operationId = '11111111-1111-4111-8111-111111111111';
    const memoryId = '22222222-2222-4222-8222-222222222222';
    const marker = {
      id: 'old-issued-handle',
      command: 'correct_owner_memory' as const,
      targetId: memoryId,
    };
    class Storage implements OwnerEditorStorage {
      private values = new Map<string, string>();
      getItem(key: string) {
        return this.values.get(key) ?? null;
      }
      setItem(key: string, value: string) {
        this.values.set(key, value);
      }
      removeItem(key: string) {
        this.values.delete(key);
      }
    }
    const requestHash = 'a'.repeat(64);
    const terminal = {
      version: 1,
      authority: 'operation_receipt',
      command: 'correct_owner_memory',
      operationId,
      requestHash,
      statusVersion: 1,
      outcome: 'saved',
      ids: { memoryId },
      revision: 'b'.repeat(64),
    } satisfies OwnerEditorReply;
    const storage = new Storage();
    writeOwnerEditorPendingMarker(storage, ownerId, formSessionScope, marker);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          authority: 'unresolved',
          command: marker.command,
          operationId,
          outcome: 'outcome_unknown',
          reason: 'preparing',
          receiptBindingToken: 'original-proof',
        }),
      )
      .mockResolvedValueOnce(Response.json(terminal));
    const controller = new OwnerEditorOperation(
      { ownerId, formSessionScope },
      () => storage,
      fetcher,
    );
    controller.initialize();

    await checkSavedNotePendingResult(controller);
    expect(controller.getSnapshot().phase).toBe('pending');
    expect(readOwnerEditorPendingMarker(storage, ownerId, formSessionScope)).toEqual(marker);

    await checkSavedNotePendingResult(controller);
    expect(controller.getSnapshot().phase).toBe('resolved');
    expect(readOwnerEditorPendingMarker(storage, ownerId, formSessionScope)).toBeNull();

    // A terminal original-operation receipt is authoritative after its GET-issued proof.
    // Further clicks do not replay the mutation or look up a retired pending marker.
    await checkSavedNotePendingResult(controller);
    expect(controller.getSnapshot().phase).toBe('resolved');
    expect(readOwnerEditorPendingMarker(storage, ownerId, formSessionScope)).toBeNull();
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/profile/knowledge/memory?operation=old-issued-handle',
      '/api/profile/knowledge/memory',
    ]);
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST']);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      version: 1,
      intent: 'reconcile',
      command: marker.command,
      operationId,
      receiptBindingToken: 'original-proof',
    });

    const unresolvedReplies: OwnerEditorReply[] = [
      {
        version: 1,
        authority: 'request_rejection',
        command: marker.command,
        operationId,
        outcome: 'unavailable',
        originalOperationTerminal: false,
        reason: 'receipt_service_unavailable',
      },
      {
        version: 1,
        authority: 'unresolved',
        command: marker.command,
        operationId,
        outcome: 'outcome_unknown',
        reason: 'receipt_unavailable',
      },
    ];
    for (const reply of unresolvedReplies) {
      const pendingStorage = new Storage();
      writeOwnerEditorPendingMarker(pendingStorage, ownerId, formSessionScope, marker);
      const pendingFetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(reply));
      const pendingController = new OwnerEditorOperation(
        { ownerId, formSessionScope },
        () => pendingStorage,
        pendingFetcher,
      );
      pendingController.initialize();
      await checkSavedNotePendingResult(pendingController);
      expect(pendingController.getSnapshot().phase).toBe('pending');
      expect(readOwnerEditorPendingMarker(pendingStorage, ownerId, formSessionScope)).toEqual(
        marker,
      );
      expect(
        pendingController.acceptFreshSnapshot([
          {
            command: marker.command,
            operationId: '44444444-4444-4444-8444-444444444444',
            issuedOperationHandle: 'new-issued-handle',
          },
        ]),
      ).toBe(false);
      expect(pendingController.getSnapshot().phase).toBe('pending');
      expect(readOwnerEditorPendingMarker(pendingStorage, ownerId, formSessionScope)).toEqual(
        marker,
      );
      expect(pendingFetcher.mock.calls).toHaveLength(1);
      expect(pendingFetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['GET']);
    }
  });
  it('renders the authoritative conditional saved and unchanged messages once', () => {
    const reply = (outcome: 'saved' | 'unchanged', refreshPending?: boolean) =>
      ({
        version: 1,
        authority: 'operation_receipt',
        command: 'correct_owner_memory',
        operationId: '11111111-1111-4111-8111-111111111111',
        requestHash: 'a'.repeat(64),
        statusVersion: 1,
        outcome,
        ids: { memoryId: '22222222-2222-4222-8222-222222222222' },
        revision: 'b'.repeat(64),
        ...(refreshPending === undefined ? {} : { refreshPending }),
      }) satisfies OwnerEditorReply;
    const renderMessage = (message: string) =>
      renderToStaticMarkup(
        <SavedNoteRecovery {...props} state={{ message, phase: 'resolved', busy: false }} />,
      );
    const saved = renderMessage(ownerEditorOutcomeMessage(reply('saved', false)));
    expect(saved).toContain('Saved.');
    expect(saved).not.toContain('refresh');
    expect(saved.match(/role="status"/g) ?? []).toHaveLength(1);
    const refreshing = renderToStaticMarkup(
      <SavedNoteRecovery
        {...props}
        awaitingReadback
        state={{
          message: ownerEditorOutcomeMessage(reply('saved', true)),
          phase: 'resolved',
          busy: false,
        }}
      />,
    );
    expect(refreshing).toContain('Saved. Some derived details still need to refresh.');
    expect(refreshing).toContain('Reload saved note');
    expect(refreshing.match(/role="status"/g) ?? []).toHaveLength(1);
    const unchanged = renderMessage(ownerEditorOutcomeMessage(reply('unchanged')));
    expect(unchanged).toContain('Already saved. No additional change was needed.');
    expect(unchanged).not.toContain('Your correction is saved.');
    expect(unchanged).not.toContain('refresh');
    expect(unchanged.match(/role="status"/g) ?? []).toHaveLength(1);
    expect(savedNoteHasConflict('before', 'after', true)).toBe(false);
    expect(savedNoteHasConflict('before', 'after', false)).toBe(true);
    expect(savedNoteHasConflict('before', 'before', false)).toBe(false);
  });
});
