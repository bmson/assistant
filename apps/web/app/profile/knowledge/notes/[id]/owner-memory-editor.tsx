'use client';

import type {
  OwnerEditorFormGrant,
  OwnerEditorSessionView,
} from '@assistant/persistence/owner-editor';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { memoryNoteHref } from '@/lib/memory-note-context';
import {
  OwnerEditorOperation,
  type OwnerEditorOperationState,
  ownerEditorOutcomeMessage,
} from '@/lib/owner-editor-operation';
import type { OwnerMemoryEditorView } from '@/lib/owner-memory-editor-view';
import { btn, textareaClass } from '@/lib/ui';
import { Modal } from '@/lib/ui-client';

type Capture = { snapshot: OwnerMemoryEditorView['snapshot']; grant: OwnerEditorFormGrant };

export function ownerMemoryRecoveryPresentation(
  state: OwnerEditorOperationState,
  capture: Capture | null,
  memoryId: string,
): { hasDraft: boolean; ownReply: boolean; message: string } {
  const hasDraft = capture !== null;
  const reply = state.reply;
  const ownReply =
    reply?.authority === 'operation_receipt' &&
    reply.command === 'correct_owner_memory' &&
    state.reviewTargetId === memoryId &&
    ((reply.outcome !== 'saved' && reply.outcome !== 'unchanged') ||
      reply.ids.memoryId === memoryId);
  const ordinaryPendingMessages = [
    'An earlier save could not be confirmed. Check its result before saving again.',
    'Save could not be confirmed. Check its result before saving again.',
  ];
  const canUsePendingCopy =
    state.phase === 'pending' &&
    !state.busy &&
    ordinaryPendingMessages.includes(state.message) &&
    (reply === null || reply.authority === 'unresolved');
  if (canUsePendingCopy) {
    return {
      hasDraft,
      ownReply,
      message: hasDraft
        ? 'Save result unknown. Check result before saving again.'
        : 'The result of an earlier save is still unknown. Check result to confirm it.',
    };
  }
  const isOwnSavedRefreshReceipt =
    state.phase === 'resolved' &&
    !state.busy &&
    reply?.authority === 'operation_receipt' &&
    ownReply &&
    reply.outcome === 'saved' &&
    reply.refreshPending === true &&
    state.message === ownerEditorOutcomeMessage(reply);
  return {
    hasDraft,
    ownReply,
    message: isOwnSavedRefreshReceipt
      ? 'Saved. Related information may still show older details.'
      : state.message,
  };
}

/** Keeps the original operation and draft mounted even if a refreshed capability disappears. */
export function OwnerMemoryEditor({ view }: { view: OwnerMemoryEditorView }) {
  const [session, setSession] = useState(view.session);
  useEffect(() => {
    // There is no draft/controller to preserve before first admission. Once
    // admitted, a session change cannot silently replace an in-flight edit.
    if (!session && view.session) setSession(view.session);
  }, [session, view.session]);
  return session ? <EditableSavedNote view={view} session={session} /> : null;
}

function EditableSavedNote({
  view,
  session,
}: {
  view: OwnerMemoryEditorView;
  session: OwnerEditorSessionView;
}) {
  const router = useRouter();
  const fieldId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const controller = useMemo(
    () => new OwnerEditorOperation(session, () => window.sessionStorage),
    [session],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getServerSnapshot,
  );
  const [open, setOpen] = useState(false);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [draft, setDraft] = useState('');
  const [localReview, setLocalReview] = useState(false);
  const refreshed = useRef<unknown>(null);
  const resolvedView = useRef<OwnerMemoryEditorView | null>(null);
  const [awaitingReadback, setAwaitingReadback] = useState(false);
  const recoveryPresentation = ownerMemoryRecoveryPresentation(
    state,
    capture,
    view.snapshot.memoryId,
  );
  const { hasDraft, ownReply } = recoveryPresentation;
  const saved =
    ownReply &&
    state.reply?.authority === 'operation_receipt' &&
    (state.reply.outcome === 'saved' || state.reply.outcome === 'unchanged');
  const savedThisDraft = saved && capture?.grant.operationId === state.reply?.operationId;
  const sessionMatches =
    view.session?.ownerId === session.ownerId &&
    view.session.formSessionScope === session.formSessionScope;
  const freshGrant = view.grant && view.grant.operationId !== capture?.grant.operationId;
  const changed = savedNoteHasConflict(
    capture?.snapshot.revision,
    view.snapshot.revision,
    savedThisDraft,
  );
  const review = state.reviewRequired || localReview;
  useEffect(() => {
    controller.initialize();
  }, [controller]);
  useEffect(() => {
    if (state.phase !== 'resolved' || !state.reply || refreshed.current === state.reply) return;
    refreshed.current = state.reply;
    resolvedView.current = view;
    setAwaitingReadback(true);
    router.refresh();
  }, [state.phase, state.reply, router, view]);
  useEffect(() => {
    if (state.phase !== 'resolved') return;
    // A grant already on a reloaded page is not readback of its earlier save.
    if (
      !resolvedView.current ||
      view === resolvedView.current ||
      (view.grant && view.grant.operationId === resolvedView.current.grant?.operationId)
    )
      return;
    setAwaitingReadback(false);
    if (state.reviewRequired || !view.grant || !freshGrant || !sessionMatches) return;
    if (!controller.acceptFreshSnapshot([view.grant])) return;
    if (capture && changed && !savedThisDraft) setLocalReview(true);
    else if (capture && !savedThisDraft) setCapture({ snapshot: view.snapshot, grant: view.grant });
  }, [
    controller,
    state.phase,
    state.reviewRequired,
    view.grant,
    view.snapshot,
    freshGrant,
    sessionMatches,
    capture,
    changed,
    savedThisDraft,
    view,
  ]);
  const close = () => {
    setOpen(false);
    queueMicrotask(() => trigger.current?.focus());
  };
  const start = () => {
    if (
      capture &&
      (state.phase === 'pending' ||
        state.phase === 'blocked' ||
        state.busy ||
        review ||
        !view.grant ||
        !sessionMatches)
    ) {
      setOpen(true);
      return;
    }
    if (!view.grant || !sessionMatches || state.phase === 'pending' || state.busy) return;
    if (!capture || savedThisDraft) {
      setCapture({ snapshot: view.snapshot, grant: view.grant });
      setDraft(view.snapshot.content);
      setLocalReview(false);
    }
    setOpen(true);
  };
  const acknowledgeCurrent = () => {
    if (
      awaitingReadback ||
      !view.grant ||
      !freshGrant ||
      !view.snapshot.eligible ||
      !sessionMatches
    )
      return;
    if (state.reviewRequired && !controller.reviewFreshSnapshot([view.grant])) return;
    setCapture({ snapshot: view.snapshot, grant: view.grant });
    setLocalReview(false);
  };
  const save = async () => {
    if (!capture || review || changed || !view.grant || !sessionMatches || !view.snapshot.eligible)
      return;
    await controller.apply(
      {
        version: 1,
        intent: 'apply',
        command: 'correct_owner_memory',
        operationId: capture.grant.operationId,
        memoryId: capture.snapshot.memoryId,
        expectedContentHash: capture.snapshot.contentHash,
        expectedMemoryRevision: capture.snapshot.revision,
        content: draft,
      },
      capture.grant,
      capture.snapshot.memoryId,
    );
  };
  const pending = state.phase === 'pending' || state.busy;
  const keptDraft =
    hasDraft && (pending || state.phase === 'blocked' || review || !view.grant || !sessionMatches);
  const recoveryMessage = recoveryPresentation.message;
  const otherNote =
    state.reviewTargetId &&
    state.reviewTargetId !== view.snapshot.memoryId &&
    state.reply?.command === 'correct_owner_memory'
      ? memoryNoteHref(state.reviewTargetId, '/profile/knowledge?view=library')
      : null;
  const recoveryProps = {
    state: { ...state, message: recoveryMessage },
    hasDraft,
    editorOpen: open,
    awaitingReadback,
    sessionMatches,
    otherNote,
    reload: () => router.refresh(),
    checkResult: () => void checkSavedNotePendingResult(controller),
  };
  return (
    <div className="mt-4 grid gap-3">
      <button
        ref={trigger}
        type="button"
        className={`${btn.outline} w-fit`}
        disabled={
          !keptDraft &&
          (!view.grant ||
            !sessionMatches ||
            pending ||
            review ||
            state.phase === 'blocked' ||
            state.phase === 'checking' ||
            awaitingReadback)
        }
        onClick={start}
      >
        {keptDraft ? 'View kept draft' : 'Edit saved note'}
      </button>
      {!open ? <SavedNoteRecovery {...recoveryProps} /> : null}
      {review && ownReply && !open ? (
        <button
          type="button"
          className={`${btn.outline} w-fit`}
          disabled={!capture && (awaitingReadback || !view.grant || !sessionMatches)}
          onClick={() => {
            if (capture) {
              setOpen(true);
              return;
            }
            if (
              awaitingReadback ||
              !view.grant ||
              !sessionMatches ||
              !controller.reviewFreshSnapshot([view.grant])
            )
              return;
            setCapture({ snapshot: view.snapshot, grant: view.grant });
            setDraft(view.snapshot.content);
            setLocalReview(false);
            setOpen(true);
          }}
        >
          {capture ? 'Review current note and kept draft' : 'Review current saved note'}
        </button>
      ) : null}
      {open && capture ? (
        <Modal label="Edit saved note" onClose={close}>
          <h2 className="font-display text-xl font-semibold">Edit saved note</h2>
          <SavedNoteRecovery {...recoveryProps} />
          <p className="text-sm text-muted">
            Your correction changes this saved note. It does not change the original email or
            document.
          </p>
          <div>
            <h3 className="text-sm font-semibold">Note when you opened this editor</h3>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {capture.snapshot.content}
            </p>
          </div>
          {review || changed ? (
            <div className="rounded-xl border border-edge p-3">
              <h3 className="text-sm font-semibold">Current saved note</h3>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                {view.snapshot.content}
              </p>
              <p className="mt-2 text-sm text-muted">
                Review the saved note before saving your draft. Refresh saved note checks for newer
                saved text and keeps your draft.
              </p>
              <button
                type="button"
                className={`${btn.outline} mt-3`}
                disabled={
                  !freshGrant ||
                  !view.grant ||
                  !view.snapshot.eligible ||
                  !sessionMatches ||
                  pending ||
                  awaitingReadback
                }
                onClick={acknowledgeCurrent}
              >
                I reviewed the saved note — keep my draft
              </button>
              <button
                type="button"
                className={`${btn.outline} mt-2`}
                disabled={pending}
                onClick={() => router.refresh()}
              >
                Refresh saved note
              </button>
            </div>
          ) : null}
          <label htmlFor={fieldId} className="text-sm font-semibold">
            Your corrected note
          </label>
          <textarea
            id={fieldId}
            className={`${textareaClass} min-h-36`}
            value={draft}
            maxLength={4000}
            readOnly={pending}
            onChange={(event) => setDraft(event.target.value)}
            aria-describedby={`${fieldId}-help`}
          />
          <p id={`${fieldId}-help`} className="text-sm text-muted">
            3–4,000 characters. Review the complete note, including any relationship direction or
            dates.
          </p>
          {Object.entries(state.fieldErrors).map(([field, message]) => (
            <p key={field} role="alert" className="text-sm text-danger">
              {message}
            </p>
          ))}
          {!view.grant || !sessionMatches ? (
            <p role="status" className="text-sm text-muted">
              Editing is no longer available for this view. Your draft is kept here.
            </p>
          ) : null}
          <SavedNoteActions
            state={state}
            pending={pending}
            savedThisDraft={savedThisDraft}
            review={review}
            changed={changed}
            hasGrant={!!view.grant}
            sessionMatches={sessionMatches}
            draft={draft}
            onSave={() => void save()}
            onClose={close}
          />
        </Modal>
      ) : null}
    </div>
  );
}

/** Dispatches the existing pending-result path using proof held at click time. */
export function checkSavedNotePendingResult(
  controller: Pick<OwnerEditorOperation, 'canReconcile' | 'check' | 'reconcile'>,
): Promise<void> {
  return controller.canReconcile() ? controller.reconcile() : controller.check();
}

export function SavedNoteActions({
  state,
  pending,
  savedThisDraft,
  review,
  changed,
  hasGrant,
  sessionMatches,
  draft,
  onSave,
  onClose,
}: {
  state: Pick<OwnerEditorOperationState, 'phase'>;
  pending: boolean;
  savedThisDraft: boolean;
  review: boolean;
  changed: boolean;
  hasGrant: boolean;
  sessionMatches: boolean;
  draft: string;
  onSave: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {state.phase !== 'pending' ? (
        <button
          type="button"
          className={btn.primary}
          disabled={
            savedThisDraft ||
            state.phase !== 'ready' ||
            pending ||
            review ||
            changed ||
            !hasGrant ||
            !sessionMatches ||
            draft.trim().length < 3 ||
            draft.trim().length > 4000
          }
          onClick={onSave}
        >
          Save correction
        </button>
      ) : null}
      <button type="button" className={btn.outline} onClick={onClose}>
        Close
      </button>
    </div>
  );
}

/** Rendered inside the dialog while it owns focus, or on the page after Close. */
export function SavedNoteRecovery({
  state,
  hasDraft,
  editorOpen,
  awaitingReadback,
  sessionMatches,
  otherNote,
  reload,
  checkResult,
}: {
  state: Pick<OwnerEditorOperationState, 'message' | 'phase' | 'busy'>;
  hasDraft: boolean;
  editorOpen: boolean;
  awaitingReadback: boolean;
  sessionMatches: boolean;
  otherNote: string | null;
  reload: () => void;
  checkResult: () => void;
}) {
  return (
    <div className="grid gap-3">
      {state.message ? (
        <p role="status" className="text-sm text-muted">
          {state.message}
        </p>
      ) : null}
      {awaitingReadback ? (
        <div className="text-sm text-muted">
          <p>Loading the saved note…</p>
          <button type="button" className={`${btn.outline} mt-2`} onClick={reload}>
            Refresh saved note
          </button>
        </div>
      ) : null}
      {!sessionMatches ? (
        <p role="status" className="text-sm text-muted">
          Your session changed. Copy any kept draft before reloading this page to start another
          edit.
        </p>
      ) : null}
      {otherNote ? (
        <a href={otherNote} className="text-sm text-accent underline">
          Review the earlier saved note
        </a>
      ) : null}
      {state.phase === 'pending' ? (
        <div className="flex flex-wrap items-start gap-2">
          <button type="button" className={btn.primary} disabled={state.busy} onClick={checkResult}>
            Check result
          </button>
          {sessionMatches ? (
            <p className="w-full text-sm text-muted">
              {hasDraft
                ? editorOpen
                  ? 'Closing keeps this draft on this page and does not cancel the save. Reloading loses the draft text.'
                  : 'Your draft is kept on this page. Check result before saving again. Reloading loses the draft text.'
                : 'Check the earlier save before making another change. Draft text is not restored after reloading.'}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function savedNoteHasConflict(
  capturedRevision: string | undefined,
  currentRevision: string,
  savedThisDraft: boolean,
): boolean {
  return !savedThisDraft && capturedRevision !== undefined && capturedRevision !== currentRevision;
}
