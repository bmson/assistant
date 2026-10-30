import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import type { OwnerEditorReply } from '@assistant/persistence/owner-editor';
import {
  type OwnerEditorStorage,
  readOwnerEditorPendingMarker,
  writeOwnerEditorPendingMarker,
} from '@/lib/owner-editor-client';
import {
  OwnerEditorOperation,
  type OwnerEditorOperationState,
  ownerEditorOutcomeMessage,
} from '@/lib/owner-editor-operation';
import {
  checkSavedNotePendingResult,
  ownerMemoryRecoveryPresentation,
  SavedNoteActions,
  SavedNoteRecovery,
  savedNoteHasConflict,
} from './owner-memory-editor';

const props = {
  state: {
    message: 'Save result unknown. Check result before saving again.',
    phase: 'pending' as const,
    busy: false,
  },
  hasDraft: true,
  editorOpen: true,
  awaitingReadback: false,
  sessionMatches: true,
  otherNote: null,
  reload: vi.fn(),
  checkResult: vi.fn(),
};
describe('saved note dialog recovery content', () => {
  it('keeps one pending result action and open-draft guidance in the dialog', () => {
    const html = renderToStaticMarkup(
      <div role="dialog">
        <SavedNoteRecovery {...props} />
        <SavedNoteActions
          state={{ phase: 'pending' }}
          pending
          savedThisDraft={false}
          review={false}
          changed={false}
          hasGrant
          sessionMatches
          draft=""
          onSave={vi.fn()}
          onClose={vi.fn()}
        />
      </div>,
    );
    expect(html).toContain(props.state.message);
    expect(html).toContain(
      'Closing keeps this draft on this page and does not cancel the save. Reloading loses the draft text.',
    );
    const checkButtons = html.match(/<button[^>]*>Check result<\/button>/g) ?? [];
    expect(checkButtons).toHaveLength(1);
    expect(checkButtons[0]).not.toMatch(/\sdisabled(?:=|\s|>)/);
    expect(html).not.toContain('The original save is being tracked. Close does not cancel it.');
    expect(html).not.toContain('Save correction');
    expect(html).toContain('>Close</button>');

    const readyActions = renderToStaticMarkup(
      <SavedNoteActions
        state={{ phase: 'ready' }}
        pending={false}
        savedThisDraft={false}
        review={false}
        changed={false}
        hasGrant
        sessionMatches
        draft="An edited saved note."
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(readyActions).toContain('Save correction');
  });
  it('uses distinct truthful copy for a closed draft and for reload without a draft', () => {
    const closedDraft = renderToStaticMarkup(<SavedNoteRecovery {...props} editorOpen={false} />);
    expect(closedDraft).toContain(
      'Your draft is kept on this page. Check result before saving again. Reloading loses the draft text.',
    );
    expect(closedDraft).not.toContain('Closing keeps this draft on this page');

    const afterReload = renderToStaticMarkup(
      <SavedNoteRecovery {...props} hasDraft={false} editorOpen={false} />,
    );
    expect(afterReload).toContain(
      'Check the earlier save before making another change. Draft text is not restored after reloading.',
    );
    expect(afterReload).not.toContain('Your draft is kept on this page');
  });
  it('selects local copy only for normal unresolved states and the matching own saved refresh receipt', () => {
    const memoryId = '22222222-2222-4222-8222-222222222222';
    const otherMemoryId = '44444444-4444-4444-8444-444444444444';
    const savedReply = {
      version: 1,
      authority: 'operation_receipt',
      command: 'correct_owner_memory',
      operationId: '11111111-1111-4111-8111-111111111111',
      requestHash: 'a'.repeat(64),
      statusVersion: 1,
      outcome: 'saved',
      ids: { memoryId },
      revision: 'b'.repeat(64),
      refreshPending: true,
    } satisfies OwnerEditorReply;
    const baseState = {
      phase: 'resolved',
      reviewRequired: false,
      reviewTargetId: memoryId,
      marker: null,
      busy: false,
      reply: savedReply,
      fieldErrors: {},
      message: ownerEditorOutcomeMessage(savedReply),
    } satisfies OwnerEditorOperationState;
    const retainedEmptyDraft = {
      snapshot: { content: 'Earlier saved text.' },
      grant: {},
    } as NonNullable<Parameters<typeof ownerMemoryRecoveryPresentation>[1]>;
    const select = (
      overrides: Partial<OwnerEditorOperationState> = {},
      capture: Parameters<typeof ownerMemoryRecoveryPresentation>[1] = retainedEmptyDraft,
    ) => ownerMemoryRecoveryPresentation({ ...baseState, ...overrides }, capture, memoryId);

    const pendingInitial = select({
      phase: 'pending',
      reply: null,
      message: 'An earlier save could not be confirmed. Check its result before saving again.',
    });
    expect(pendingInitial.hasDraft).toBe(true);
    expect(pendingInitial.message).toBe('Save result unknown. Check result before saving again.');
    const pendingUnresolved = select(
      {
        phase: 'pending',
        reply: {
          version: 1,
          authority: 'unresolved',
          command: 'correct_owner_memory',
          operationId: savedReply.operationId,
          outcome: 'outcome_unknown',
          reason: 'preparing',
        },
        message: 'Save could not be confirmed. Check its result before saving again.',
      },
      null,
    );
    expect(pendingUnresolved.message).toBe(
      'The result of an earlier save is still unknown. Check result to confirm it.',
    );

    const requestRejected = {
      version: 1,
      authority: 'request_rejection',
      command: 'correct_owner_memory',
      operationId: savedReply.operationId,
      outcome: 'unavailable',
      originalOperationTerminal: false,
      reason: 'receipt_service_unavailable',
    } satisfies OwnerEditorReply;
    const rejectionMessage =
      'This request was not accepted. The earlier save is still unresolved; check its result.';
    expect(
      select({ phase: 'pending', reply: requestRejected, message: rejectionMessage }).message,
    ).toBe(rejectionMessage);
    const markerChangedMessage =
      'The tracked save changed. Check its result or reload the saved details.';
    expect(select({ phase: 'pending', reply: null, message: markerChangedMessage }).message).toBe(
      markerChangedMessage,
    );

    const savedMessage = ownerMemoryRecoveryPresentation(baseState, retainedEmptyDraft, memoryId);
    expect(savedMessage.ownReply).toBe(true);
    expect(savedMessage.message).toBe('Saved. Related information may still show older details.');
    const actualSelection = renderToStaticMarkup(
      <SavedNoteRecovery
        {...props}
        state={{ ...baseState, message: savedMessage.message }}
        awaitingReadback
      />,
    );
    expect(actualSelection).toContain('Saved. Related information may still show older details.');

    const blockedMessage =
      'This browser cannot safely track saves. No further save will be sent. Keep your draft and check the saved details.';
    expect(select({ phase: 'blocked', message: blockedMessage }).message).toBe(blockedMessage);
    const unrelatedReceipt = {
      ...savedReply,
      ids: { memoryId: otherMemoryId },
    } satisfies OwnerEditorReply;
    const unrelatedMessage = ownerEditorOutcomeMessage(unrelatedReceipt);
    const unrelated = select({ reply: unrelatedReceipt, message: unrelatedMessage });
    expect(unrelated.ownReply).toBe(false);
    expect(unrelated.message).toBe(unrelatedMessage);
    const unchangedReply = {
      version: 1,
      authority: 'operation_receipt',
      command: 'correct_owner_memory',
      operationId: savedReply.operationId,
      requestHash: savedReply.requestHash,
      statusVersion: 2,
      outcome: 'unchanged',
      ids: { memoryId },
      revision: 'c'.repeat(64),
    } satisfies OwnerEditorReply;
    const unchangedMessage = ownerEditorOutcomeMessage(unchangedReply);
    expect(select({ reply: unchangedReply, message: unchangedMessage }).message).toBe(
      unchangedMessage,
    );
    const conflictReply = {
      version: 1,
      authority: 'operation_receipt',
      command: 'correct_owner_memory',
      operationId: savedReply.operationId,
      requestHash: savedReply.requestHash,
      statusVersion: 2,
      outcome: 'conflict',
      reason: 'memory_snapshot_changed',
    } satisfies OwnerEditorReply;
    const conflictMessage = ownerEditorOutcomeMessage(conflictReply);
    expect(select({ reply: conflictReply, message: conflictMessage }).message).toBe(
      conflictMessage,
    );
    const nonstandardMessage = 'A browser storage warning is active.';
    expect(select({ message: nonstandardMessage }).message).toBe(nonstandardMessage);
    expect(select({ busy: true, message: 'Saving…' }).message).toBe('Saving…');
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
          message: 'Saved. Related information may still show older details.',
          phase: 'resolved',
          busy: false,
        }}
      />,
    );
    expect(ownerEditorOutcomeMessage(reply('saved', true))).toBe(
      'Saved. Some derived details still need to refresh.',
    );
    expect(refreshing).toContain('Saved. Related information may still show older details.');
    expect(refreshing).toContain('Loading the saved note…');
    expect(refreshing).toContain('Refresh saved note');
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
