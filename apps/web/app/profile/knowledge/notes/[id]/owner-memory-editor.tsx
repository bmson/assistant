'use client';

import type {
  OwnerEditorFormGrant,
  OwnerEditorMemoryRemovalImpact,
  OwnerEditorReply,
  OwnerEditorSessionView,
} from '@assistant/persistence/owner-editor';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { memoryNoteHref } from '@/lib/memory-note-context';
import {
  OwnerEditorOperation,
  type OwnerEditorOperationState,
  ownerEditorOutcomeMessage,
} from '@/lib/owner-editor-operation';
import type { OwnerMemoryEditorView } from '@/lib/owner-memory-editor-view';
import { Badge, btn, cardShellClass, textareaClass } from '@/lib/ui';
import { Modal } from '@/lib/ui-client';

type Capture = { snapshot: OwnerMemoryEditorView['snapshot']; grant: OwnerEditorFormGrant };
type RemovalCapture = {
  snapshot: OwnerMemoryEditorView['snapshot'];
  impact: OwnerEditorMemoryRemovalImpact;
  grant: OwnerEditorFormGrant;
};

export function ownerMemoryRecoveryPresentation(
  state: OwnerEditorOperationState,
  capture: Capture | null,
  memoryId: string,
): { hasDraft: boolean; ownReply: boolean; message: string } {
  const hasDraft = capture !== null;
  const reply = state.reply;
  const ownReply =
    reply?.authority === 'operation_receipt' &&
    (reply.command === 'correct_owner_memory' || reply.command === 'remove_owner_memory') &&
    state.reviewTargetId === memoryId &&
    ((reply.outcome !== 'saved' && reply.outcome !== 'unchanged') ||
      reply.ids.memoryId === memoryId);
  const ordinaryPendingMessages = [
    'An earlier save could not be confirmed. Check its result before saving again.',
    'Save could not be confirmed. Check its result before saving again.',
    'An earlier saved note removal could not be confirmed. Check its result before removing again.',
    'Saved note removal could not be confirmed. Check its result before removing again.',
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
      ? reply?.command === 'remove_owner_memory'
        ? 'Saved note removed. Some map details may take a moment to update.'
        : 'Saved. Related information may still show older details.'
      : state.message,
  };
}

export function ownerMemoryRemovalReceiptConfirmed(
  reply: OwnerEditorReply | null,
  memoryId: string,
) {
  return (
    reply !== null &&
    reply.authority === 'operation_receipt' &&
    reply.command === 'remove_owner_memory' &&
    reply.outcome === 'saved' &&
    reply.ids.memoryId === memoryId
  );
}

export function missingSavedNoteRecoveryPresentation(
  state: OwnerEditorOperationState,
  memoryId: string,
): { kind: 'checking' | 'missing' | 'pending' | 'removed' | 'not_confirmed'; message: string } {
  const reply = state.reply;
  const matchingRemoval =
    (state.marker?.command === 'remove_owner_memory' && state.marker.targetId === memoryId) ||
    (reply?.command === 'remove_owner_memory' && state.reviewTargetId === memoryId);
  if (
    matchingRemoval &&
    reply?.authority === 'operation_receipt' &&
    reply.command === 'remove_owner_memory' &&
    reply.outcome === 'saved' &&
    reply.ids.memoryId === memoryId
  )
    return { kind: 'removed', message: 'The receipt confirms this saved note was removed.' };
  if (
    matchingRemoval &&
    reply &&
    (reply.authority === 'operation_receipt' || reply.authority === 'scope_retirement')
  )
    return {
      kind: 'not_confirmed',
      message: 'The original result did not confirm removal. This saved note is unavailable here.',
    };
  if (matchingRemoval && state.phase === 'pending')
    return {
      kind: 'pending',
      message: 'Removal is not confirmed yet. Check the original operation before continuing.',
    };
  if (state.phase === 'blocked')
    return {
      kind: 'not_confirmed',
      message:
        'This browser could not safely check the original operation. A missing note alone does not confirm removal.',
    };
  if (matchingRemoval && reply)
    return {
      kind: 'not_confirmed',
      message: 'The original removal result is not confirmed. This saved note is unavailable here.',
    };
  if (state.phase === 'checking')
    return { kind: 'checking', message: 'Checking this browser for the original operation…' };
  return {
    kind: 'missing',
    message:
      'No matching pending removal in this browser. A missing note alone does not confirm removal.',
  };
}

/** Keeps the original operation and draft mounted even if a refreshed capability disappears. */
export function OwnerMemoryEditor({
  view,
  returnHref,
  sourceHref,
  readOnlyMessage,
}: {
  view: OwnerMemoryEditorView;
  returnHref: string;
  sourceHref: string | null;
  readOnlyMessage: string;
}) {
  const [session, setSession] = useState(view.session);
  const controller = useMemo(
    () => (session ? new OwnerEditorOperation(session, () => window.sessionStorage) : null),
    [session],
  );
  const state = useSyncExternalStore(
    controller?.subscribe ?? NOOP_SUBSCRIBE,
    controller?.getSnapshot ?? EMPTY_MISSING_RECOVERY_STATE,
    controller?.getServerSnapshot ?? EMPTY_MISSING_RECOVERY_STATE,
  );
  useEffect(() => {
    // There is no draft/controller to preserve before first admission. Once
    // admitted, a session change cannot silently replace an in-flight edit.
    if (!session && view.session) setSession(view.session);
  }, [session, view.session]);
  useEffect(() => {
    controller?.initialize();
  }, [controller]);
  if (ownerMemoryRemovalReceiptConfirmed(state.reply, view.snapshot.memoryId))
    return (
      <article className={`${cardShellClass} mt-5 grid gap-3 p-4 sm:p-5`}>
        <p role="status" className="text-sm text-muted">
          The receipt confirms this saved note was removed.
        </p>
        <Link href={returnHref} className={`${btn.outline} w-fit`}>
          Back to Memory
        </Link>
      </article>
    );
  return (
    <article className={`${cardShellClass} mt-5 p-4 sm:p-5`}>
      {view.snapshot.ownerCorrection ? (
        <Badge tone="accent" size="xs">
          Owner-corrected saved note
        </Badge>
      ) : null}
      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-strong">
        {view.snapshot.content}
      </p>
      <p className="mt-3 text-sm text-muted">{view.snapshot.sourceLabel}</p>
      {view.snapshot.ownerCorrection ? (
        <p className="mt-2 text-sm text-muted">
          The saved provenance records where this note came from. It does not mean the original
          source contains your corrected wording.
        </p>
      ) : null}
      {sourceHref ? (
        <Link href={sourceHref} className="mt-3 inline-block text-sm text-accent underline">
          Open source
        </Link>
      ) : (
        <p className="mt-3 text-sm text-muted">
          A direct source link is unavailable for this saved note.
        </p>
      )}
      {!view.grant ? (
        <p role="status" className="mt-4 text-sm text-muted">
          {readOnlyMessage}
        </p>
      ) : null}
      {session && controller ? (
        <EditableSavedNote view={view} session={session} controller={controller} state={state} />
      ) : null}
    </article>
  );
}

function EditableSavedNote({
  view,
  session,
  controller,
  state,
}: {
  view: OwnerMemoryEditorView;
  session: OwnerEditorSessionView;
  controller: OwnerEditorOperation;
  state: OwnerEditorOperationState;
}) {
  const router = useRouter();
  const fieldId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [removalCapture, setRemovalCapture] = useState<RemovalCapture | null>(null);
  const [removalOpen, setRemovalOpen] = useState(false);
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
    (state.reply?.command === 'correct_owner_memory' ||
      state.reply?.command === 'remove_owner_memory')
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
  const startRemoval = () => {
    if (
      !view.removalGrant ||
      !view.removalImpact ||
      !view.snapshot.eligible ||
      !sessionMatches ||
      pending ||
      review ||
      awaitingReadback ||
      state.phase !== 'ready'
    )
      return;
    setRemovalCapture({
      snapshot: view.snapshot,
      impact: view.removalImpact,
      grant: view.removalGrant,
    });
    setRemovalOpen(true);
  };
  const remove = async () => {
    const captured = removalCapture;
    if (
      !captured ||
      !view.removalGrant ||
      !view.removalImpact ||
      !view.snapshot.eligible ||
      !sessionMatches ||
      pending ||
      review ||
      awaitingReadback ||
      captured.snapshot.revision !== view.snapshot.revision ||
      captured.snapshot.contentHash !== view.snapshot.contentHash ||
      captured.impact.revision !== view.removalImpact.revision ||
      captured.grant.operationId !== view.removalGrant.operationId
    )
      return;
    await controller.apply(
      {
        version: 1,
        intent: 'apply',
        command: 'remove_owner_memory',
        operationId: captured.grant.operationId,
        memoryId: captured.snapshot.memoryId,
        expectedContentHash: captured.snapshot.contentHash,
        expectedMemoryRevision: captured.snapshot.revision,
        expectedImpactRevision: captured.impact.revision,
      },
      captured.grant,
      captured.snapshot.memoryId,
    );
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
      {view.removalGrant && view.removalImpact ? (
        <button
          type="button"
          className={`${btn.outline} w-fit`}
          disabled={
            !sessionMatches || pending || review || awaitingReadback || state.phase !== 'ready'
          }
          onClick={startRemoval}
        >
          Forget saved note
        </button>
      ) : null}
      {removalOpen && removalCapture ? (
        <Modal label="Forget saved note" onClose={() => setRemovalOpen(false)}>
          <h2 className="font-display text-xl font-semibold">Forget this saved note?</h2>
          <p className="whitespace-pre-wrap break-words rounded-lg bg-sunken/35 p-3 text-sm">
            {removalCapture.snapshot.content}
          </p>
          <p className="text-sm text-muted">
            This removes this exact saved note and {removalCapture.impact.connectionCount} map
            connections linked to it. The original source, the person, and your other saved notes
            stay.
          </p>
          {removalCapture.impact.orphanedItems.length ? (
            <div className="rounded-lg border border-edge p-3">
              <h3 className="text-sm font-semibold">Map items with no other connections</h3>
              <ul className="mt-2 list-disc pl-5 text-sm text-muted">
                {removalCapture.impact.orphanedItems.map((item) => (
                  <li key={item.id}>{item.label}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-sm text-muted">
            If this note or its connections changed since you opened this review, removal stops and
            asks you to review it again.
          </p>
          <SavedNoteRecovery {...recoveryProps} />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={btn.danger}
              disabled={pending || state.phase !== 'ready' || review}
              onClick={() => void remove()}
            >
              {pending ? 'Removing…' : 'Forget saved note'}
            </button>
            <button
              type="button"
              className={btn.outline}
              disabled={pending}
              onClick={() => setRemovalOpen(false)}
            >
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}
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

export function MissingSavedNoteRecovery({
  memoryId,
  session,
  returnHref,
}: {
  memoryId: string;
  session: OwnerEditorSessionView | null;
  returnHref: string;
}) {
  const controller = useMemo(
    () => (session ? new OwnerEditorOperation(session, () => window.sessionStorage) : null),
    [session],
  );
  const state = useSyncExternalStore(
    controller?.subscribe ?? NOOP_SUBSCRIBE,
    controller?.getSnapshot ?? EMPTY_MISSING_RECOVERY_STATE,
    controller?.getServerSnapshot ?? EMPTY_MISSING_RECOVERY_STATE,
  );
  useEffect(() => {
    controller?.initialize();
  }, [controller]);
  const recovery = session
    ? missingSavedNoteRecoveryPresentation(state, memoryId)
    : {
        kind: 'not_confirmed' as const,
        message:
          'Result checking is unavailable in this session. A missing note alone does not confirm removal.',
      };
  return (
    <div className="grid gap-3">
      <p role="status" className="text-sm text-muted">
        {recovery.message}
      </p>
      {(recovery.kind === 'pending' || recovery.kind === 'not_confirmed') &&
      state.phase === 'pending' &&
      controller ? (
        <button
          type="button"
          className={btn.primary}
          disabled={state.busy}
          onClick={() => void checkSavedNotePendingResult(controller)}
        >
          Check original result
        </button>
      ) : null}
      <Link href={returnHref} className={`${btn.outline} w-fit`}>
        Return to Memory
      </Link>
    </div>
  );
}

const INITIAL_MISSING_RECOVERY_STATE: OwnerEditorOperationState = {
  phase: 'checking',
  reviewRequired: false,
  reviewTargetId: null,
  marker: null,
  busy: false,
  reply: null,
  fieldErrors: {},
  message: '',
};
const NOOP_SUBSCRIBE = () => () => {};
const EMPTY_MISSING_RECOVERY_STATE = () => INITIAL_MISSING_RECOVERY_STATE;

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
