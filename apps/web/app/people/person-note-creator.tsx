'use client';

import { parseOwnerEditorRequest } from '@assistant/application/owner-editor-wire';
import type {
  OwnerEditorApply,
  OwnerEditorFormGrant,
  OwnerEditorSessionView,
} from '@assistant/persistence/owner-editor';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { isValidFormSessionScope } from '@/app/auth-form-session-scope';
import { memoryNoteHref } from '@/lib/memory-note-context';
import { OwnerEditorOperation } from '@/lib/owner-editor-operation';
import { OwnerEditorDialogStatus, type OwnerEditorDisplayScope } from '@/lib/owner-editor-status';
import { btn, labelClass, selectClass, textareaClass } from '@/lib/ui';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION = /^[a-f0-9]{64}$/;
const PERSON_NOTE_DOMAINS = [
  'identity',
  'work',
  'home',
  'relationships',
  'preferences',
  'health',
  'other',
] as const;
type PersonNoteDomain = (typeof PERSON_NOTE_DOMAINS)[number];

export interface PersonNoteCreateSnapshot {
  contactId: string;
  name: string;
  trust: string;
  revision: string;
}

export interface PersonNoteCreatorProps {
  /** Kept when current issuance disappears so the original operation can be checked. */
  session: OwnerEditorSessionView | null;
  /** Parent-provided, already verified display snapshot; null keeps recovery visible. */
  snapshot: PersonNoteCreateSnapshot | null;
  /** Opaque signed grant; the browser does not decode its target binding. */
  grant: OwnerEditorFormGrant | null;
}

export function PersonNoteResultStatus({
  state,
  displayed,
  noteHref,
}: {
  state: ReturnType<OwnerEditorOperation['getSnapshot']>;
  displayed: OwnerEditorDisplayScope | null;
  noteHref: string | null;
}) {
  const duplicateMessage = personNoteCreateConflictMessage(state);
  if (duplicateMessage)
    return (
      <p role="status" className="text-sm text-muted">
        {duplicateMessage}
      </p>
    );
  if (
    state.phase === 'resolved' &&
    state.reply?.authority === 'operation_receipt' &&
    state.reply.command === 'create_owner_memory' &&
    state.reply.outcome === 'saved'
  ) {
    return noteHref ? (
      <p role="status" className="text-sm text-muted">
        Saved. Open the note to review it.
        {state.reply.refreshPending ? ' Related information may still show older details.' : ''}{' '}
        <Link className="text-accent underline" href={noteHref}>
          Review saved note
        </Link>
      </p>
    ) : (
      <p role="status" className="text-sm text-muted">
        A save result was received, but the note identity could not be verified. Refresh person
        details before continuing.
      </p>
    );
  }
  return <OwnerEditorDialogStatus state={state} displayed={displayed} />;
}

export function PersonNoteRecovery({
  state,
  checkResult,
  draftPresent,
}: {
  state: ReturnType<OwnerEditorOperation['getSnapshot']>;
  checkResult: () => void;
  draftPresent: boolean;
}) {
  if (state.phase !== 'pending') return null;
  return (
    <div className="grid gap-2">
      <button type="button" className={btn.primary} disabled={state.busy} onClick={checkResult}>
        Check result
      </button>
      <p className="text-sm text-muted">
        {state.busy ? 'Saving…' : 'Save result unknown. Check result before adding another note.'}{' '}
        {draftPresent ? 'Your draft is kept on this page. ' : ''}
        Reloading loses the note text.
      </p>
    </div>
  );
}

function validSnapshot(
  session: OwnerEditorSessionView | null,
  snapshot: PersonNoteCreateSnapshot | null,
): snapshot is PersonNoteCreateSnapshot {
  return Boolean(
    session &&
      UUID.test(session.ownerId) &&
      isValidFormSessionScope(session.formSessionScope) &&
      snapshot &&
      UUID.test(snapshot.contactId) &&
      snapshot.contactId.toLowerCase() !== session.ownerId.toLowerCase() &&
      snapshot.trust !== 'owner' &&
      snapshot.trust.trim().length > 0 &&
      snapshot.name.trim().length > 0 &&
      REVISION.test(snapshot.revision),
  );
}

function validGrant(grant: OwnerEditorFormGrant | null): grant is OwnerEditorFormGrant {
  return Boolean(
    grant &&
      grant.command === 'create_owner_memory' &&
      UUID.test(grant.operationId) &&
      grant.issuedOperationHandle.length > 0 &&
      grant.issuedOperationHandle.length <= 8192,
  );
}

/** Build only the exact existing person-note apply contract. */
export function buildPersonNoteCreateRequest(input: {
  session: OwnerEditorSessionView;
  snapshot: PersonNoteCreateSnapshot;
  grant: OwnerEditorFormGrant;
  content: string;
  domain: PersonNoteDomain;
  importance: number;
  pinned: boolean;
}): OwnerEditorApply | null {
  if (!validSnapshot(input.session, input.snapshot) || !validGrant(input.grant)) return null;

  const parsed = parseOwnerEditorRequest(
    {
      version: 1,
      intent: 'apply',
      command: 'create_owner_memory',
      operationId: input.grant.operationId,
      subjectContactId: input.snapshot.contactId,
      expectedSubjectRevision: input.snapshot.revision,
      content: input.content.trim(),
      domain: input.domain,
      importance: input.importance,
      pinned: input.pinned,
    },
    '/api/profile/knowledge/memory',
  );
  return parsed.ok && parsed.request.intent === 'apply' ? parsed.request : null;
}

/**
 * Presentation helper for controller-validated state only. The controller has
 * already checked the original request hash and operation binding.
 */
export function personNoteCreatedMemoryId(
  state: ReturnType<OwnerEditorOperation['getSnapshot']>,
  capturedGrant: OwnerEditorFormGrant | null,
): string | null {
  const reply = state.reply;
  if (
    state.phase !== 'resolved' ||
    state.busy ||
    reply?.authority !== 'operation_receipt' ||
    reply.command !== 'create_owner_memory' ||
    reply.outcome !== 'saved' ||
    !UUID.test(state.reviewTargetId ?? '') ||
    (capturedGrant !== null && reply.operationId !== capturedGrant.operationId)
  )
    return null;
  const memoryId = reply.ids.memoryId;
  return typeof memoryId === 'string' &&
    UUID.test(memoryId) &&
    memoryId.toLowerCase() !== state.reviewTargetId?.toLowerCase()
    ? memoryId
    : null;
}

export function personNoteCreateConflictMessage(
  state: ReturnType<OwnerEditorOperation['getSnapshot']>,
): string | null {
  const reply = state.reply;
  return state.phase === 'resolved' &&
    reply?.authority === 'operation_receipt' &&
    reply.command === 'create_owner_memory' &&
    reply.outcome === 'conflict' &&
    (reply.reason === 'memory_duplicate' || reply.reason === 'memory_content_duplicate')
    ? 'A note with this text already exists. This attempt did not add another note.'
    : null;
}

export function personNoteDraftAfterFreshReview(
  state: ReturnType<OwnerEditorOperation['getSnapshot']>,
  capturedGrant: OwnerEditorFormGrant | null,
  draft: string,
): string {
  return personNoteCreatedMemoryId(state, capturedGrant) ? '' : draft;
}

/** A terminal original operation must be checked against a new person-bound grant. */
export function hasFreshPersonNoteGrant(input: {
  state: ReturnType<OwnerEditorOperation['getSnapshot']>;
  previousOperationId: string | null;
  session: OwnerEditorSessionView | null;
  snapshot: PersonNoteCreateSnapshot | null;
  grant: OwnerEditorFormGrant | null;
}): boolean {
  const { state, previousOperationId, session, snapshot, grant } = input;
  return Boolean(
    state.phase === 'resolved' &&
      !state.busy &&
      state.reply?.command === 'create_owner_memory' &&
      state.reply.operationId !== grant?.operationId &&
      previousOperationId !== grant?.operationId &&
      state.reviewTargetId === snapshot?.contactId &&
      validSnapshot(session, snapshot) &&
      validGrant(grant),
  );
}

export function canReviewPersonNoteDraft(input: {
  capture: {
    session: OwnerEditorSessionView;
    snapshot: PersonNoteCreateSnapshot;
    grant: OwnerEditorFormGrant;
  } | null;
  session: OwnerEditorSessionView | null;
  snapshot: PersonNoteCreateSnapshot | null;
  grant: OwnerEditorFormGrant | null;
  phase: ReturnType<OwnerEditorOperation['getSnapshot']>['phase'];
}): boolean {
  const { capture, session, snapshot, grant, phase } = input;
  return Boolean(
    capture &&
      session &&
      snapshot &&
      grant &&
      phase === 'ready' &&
      validSnapshot(session, snapshot) &&
      validGrant(grant) &&
      capture.session.ownerId === session.ownerId &&
      capture.session.formSessionScope === session.formSessionScope &&
      capture.snapshot.contactId.toLowerCase() === snapshot.contactId.toLowerCase() &&
      grant.operationId !== capture.grant.operationId,
  );
}

export function personNoteDraftFreshnessAction(input: {
  capture: {
    session: OwnerEditorSessionView;
    snapshot: PersonNoteCreateSnapshot;
    grant: OwnerEditorFormGrant;
  } | null;
  session: OwnerEditorSessionView | null;
  snapshot: PersonNoteCreateSnapshot | null;
  grant: OwnerEditorFormGrant | null;
  phase: ReturnType<OwnerEditorOperation['getSnapshot']>['phase'];
}): 'review' | 'refresh' | null {
  const { capture, session, snapshot, grant, phase } = input;
  if (
    !capture ||
    !session ||
    !snapshot ||
    !grant ||
    phase !== 'ready' ||
    !validSnapshot(session, snapshot) ||
    !validGrant(grant) ||
    capture.session.ownerId !== session.ownerId ||
    capture.session.formSessionScope !== session.formSessionScope ||
    capture.snapshot.contactId.toLowerCase() !== snapshot.contactId.toLowerCase() ||
    (capture.snapshot.revision === snapshot.revision &&
      capture.grant.operationId === grant.operationId)
  )
    return null;
  return canReviewPersonNoteDraft(input) ? 'review' : 'refresh';
}

const noSubscribe = () => () => {};
const EMPTY_STATE = Object.freeze({
  phase: 'checking' as const,
  reviewRequired: false,
  reviewTargetId: null,
  marker: null,
  busy: false,
  reply: null,
  fieldErrors: Object.freeze({}),
  message: '',
});
const noSnapshot = () => EMPTY_STATE;

/** Creates a plain-text note about one currently verified, non-owner person. */
export function PersonNoteCreator({ session, snapshot, grant }: PersonNoteCreatorProps) {
  const router = useRouter();
  const [operationSession, setOperationSession] = useState(session);
  useEffect(() => {
    if (!operationSession && session) setOperationSession(session);
  }, [operationSession, session]);
  const controller = useMemo(
    () =>
      operationSession
        ? new OwnerEditorOperation(operationSession, () => window.sessionStorage)
        : null,
    [operationSession],
  );
  const state = useSyncExternalStore(
    controller?.subscribe ?? noSubscribe,
    controller?.getSnapshot ?? noSnapshot,
    controller?.getServerSnapshot ?? noSnapshot,
  );
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [domain, setDomain] = useState<PersonNoteDomain>('relationships');
  const [importance, setImportance] = useState(3);
  const [pinned, setPinned] = useState(false);
  const [capture, setCapture] = useState<{
    session: OwnerEditorSessionView;
    snapshot: PersonNoteCreateSnapshot;
    grant: OwnerEditorFormGrant;
  } | null>(null);
  const fieldId = useId();

  useEffect(() => controller?.initialize(), [controller]);

  const currentEligible = validSnapshot(session, snapshot) && validGrant(grant);
  const sessionMatches = Boolean(
    operationSession &&
      session &&
      operationSession.ownerId === session.ownerId &&
      operationSession.formSessionScope === session.formSessionScope,
  );
  const captureMatches = Boolean(
    capture &&
      currentEligible &&
      sessionMatches &&
      capture.session.ownerId === session?.ownerId &&
      capture.session.formSessionScope === session?.formSessionScope &&
      capture.snapshot.contactId === snapshot.contactId &&
      capture.snapshot.revision === snapshot.revision &&
      capture.grant.operationId === grant.operationId,
  );
  const pending = state.phase === 'pending' || state.busy;
  const createdMemoryId = personNoteCreatedMemoryId(state, capture?.grant ?? null);
  const noteHref = createdMemoryId
    ? memoryNoteHref(
        createdMemoryId,
        `/people/${state.reviewTargetId ?? snapshot?.contactId ?? ''}`,
      )
    : null;
  const displayed: OwnerEditorDisplayScope | null = capture
    ? {
        command: capture.grant.command,
        operationId: capture.grant.operationId,
        targetId: capture.snapshot.contactId,
      }
    : null;

  const start = () => {
    if (
      !controller ||
      !session ||
      !snapshot ||
      !grant ||
      !validSnapshot(session, snapshot) ||
      !validGrant(grant) ||
      !sessionMatches ||
      state.phase !== 'ready'
    )
      return;
    if (!capture) setCapture({ session, snapshot, grant });
    setOpen(true);
  };
  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!controller || !capture || !captureMatches || state.phase !== 'ready' || state.busy) return;
    const request = buildPersonNoteCreateRequest({
      ...capture,
      content: draft,
      domain,
      importance,
      pinned,
    });
    if (!request) return;
    await controller.apply(request, capture.grant, capture.snapshot.contactId);
  };
  const reviewFreshPerson = () => {
    if (
      !controller ||
      !session ||
      !snapshot ||
      !grant ||
      !validSnapshot(session, snapshot) ||
      !validGrant(grant) ||
      !sessionMatches ||
      pending ||
      !state.reply
    )
      return;
    const accepted = state.reviewRequired
      ? controller.reviewFreshSnapshot([grant])
      : controller.acceptFreshSnapshot([grant]);
    if (!accepted) return;
    const newlySaved = personNoteCreatedMemoryId(state, capture?.grant ?? null) !== null;
    setDraft(personNoteDraftAfterFreshReview(state, capture?.grant ?? null, draft));
    if (newlySaved) {
      setDomain('relationships');
      setImportance(3);
      setPinned(false);
    }
    setCapture({ session, snapshot, grant });
    setOpen(true);
  };
  const reviewUnsentDraftWithFreshPerson = () => {
    if (
      !session ||
      !snapshot ||
      !grant ||
      !canReviewPersonNoteDraft({ capture, session, snapshot, grant, phase: state.phase })
    )
      return;
    setCapture({ session, snapshot, grant });
    setOpen(true);
  };
  const previousOperationId = capture?.grant.operationId ?? state.reply?.operationId ?? null;
  const hasNewGrant = hasFreshPersonNoteGrant({
    state,
    previousOperationId,
    session,
    snapshot,
    grant,
  });
  const unsentDraftAction = personNoteDraftFreshnessAction({
    capture,
    session,
    snapshot,
    grant,
    phase: state.phase,
  });

  return (
    <section className="mt-5 rounded-xl border border-edge bg-raised p-4">
      <h2 className="text-base font-semibold text-strong">
        Add a saved note about {snapshot?.name ?? 'this person'}
      </h2>
      {currentEligible && sessionMatches && !open && state.phase === 'ready' ? (
        <button type="button" className={`${btn.outline} mt-3`} onClick={start}>
          {capture ? 'Continue this note' : 'Add a note'}
        </button>
      ) : null}
      {!currentEligible ? (
        <p role="status" className="mt-2 text-sm text-muted">
          Adding a note is unavailable for this person view.
        </p>
      ) : null}
      {!sessionMatches ? (
        <p role="status" className="mt-2 text-sm text-muted">
          Your sign-in changed. Check any earlier save before starting another.
        </p>
      ) : null}
      {open && capture ? (
        <form className="mt-3 grid gap-3" onSubmit={(event) => void create(event)}>
          <p className="text-sm text-muted">
            This note will be saved about {capture.snapshot.name}.
          </p>
          {snapshot &&
          capture.snapshot.contactId.toLowerCase() !== snapshot.contactId.toLowerCase() ? (
            <p role="status" className="text-sm text-muted">
              This draft belongs to {capture.snapshot.name} and cannot be moved to another person.
              Reload the person page to start a note for {snapshot.name}; reloading loses this
              draft.
            </p>
          ) : null}
          {!captureMatches &&
          !pending &&
          capture.snapshot.contactId.toLowerCase() === snapshot?.contactId.toLowerCase() ? (
            <p role="status" className="text-sm text-muted">
              The saved person details changed. Review the latest details before saving.
            </p>
          ) : null}
          <label htmlFor={`${fieldId}-content`} className={labelClass}>
            Note
          </label>
          <textarea
            id={`${fieldId}-content`}
            className={`${textareaClass} min-h-28`}
            value={draft}
            maxLength={4000}
            readOnly={pending || state.phase !== 'ready'}
            onChange={(event) => setDraft(event.target.value)}
            aria-describedby={`${fieldId}-help`}
          />
          <p id={`${fieldId}-help`} className="text-xs text-muted">
            Enter 3–4,000 characters. This is saved as your note about this person.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className={labelClass}>
              About
              <select
                className={`${selectClass} mt-1 w-full`}
                value={domain}
                disabled={pending || state.phase !== 'ready'}
                onChange={(event) => setDomain(event.target.value as PersonNoteDomain)}
              >
                {PERSON_NOTE_DOMAINS.map((value) => (
                  <option key={value} value={value}>
                    {value[0]?.toUpperCase()}
                    {value.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className={labelClass}>
              Importance
              <select
                className={`${selectClass} mt-1 w-full`}
                value={importance}
                disabled={pending || state.phase !== 'ready'}
                onChange={(event) => setImportance(Number(event.target.value))}
              >
                {[1, 2, 3, 4, 5].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-strong">
              <input
                type="checkbox"
                checked={pinned}
                disabled={pending || state.phase !== 'ready'}
                onChange={(event) => setPinned(event.target.checked)}
              />
              Pin this note
            </label>
          </div>
          {Object.entries(state.fieldErrors).map(([name, message]) => (
            <p key={name} role="alert" className="text-sm text-danger">
              {message}
            </p>
          ))}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className={btn.primary}
              disabled={
                !captureMatches ||
                state.phase !== 'ready' ||
                state.busy ||
                draft.trim().length < 3 ||
                draft.trim().length > 4000
              }
            >
              Add saved note
            </button>
            <button
              type="button"
              className={btn.outline}
              disabled={state.busy}
              onClick={() => setOpen(false)}
            >
              Close and keep this draft on the page
            </button>
            {unsentDraftAction ? (
              <button
                type="button"
                className={btn.outline}
                onClick={
                  unsentDraftAction === 'review'
                    ? reviewUnsentDraftWithFreshPerson
                    : () => router.refresh()
                }
              >
                {unsentDraftAction === 'review'
                  ? 'I reviewed the latest person details; keep my note'
                  : 'Refresh saved person details'}
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
      <div className="mt-3 grid gap-2">
        <PersonNoteResultStatus
          state={state}
          displayed={createdMemoryId ? null : displayed}
          noteHref={noteHref}
        />
        <PersonNoteRecovery
          state={state}
          checkResult={() => void controller?.checkPendingResult()}
          draftPresent={draft.length > 0}
        />
        {state.phase === 'resolved' && !state.reviewRequired && hasNewGrant ? (
          <button type="button" className={btn.outline} onClick={reviewFreshPerson}>
            I reviewed the latest person details
          </button>
        ) : null}
        {state.reviewRequired && hasNewGrant ? (
          <button type="button" className={btn.outline} onClick={reviewFreshPerson}>
            Review the latest saved person details
          </button>
        ) : null}
        {state.phase === 'resolved' &&
        state.reply?.command === 'create_owner_memory' &&
        !hasNewGrant ? (
          <button type="button" className={btn.outline} onClick={() => router.refresh()}>
            Refresh person details
          </button>
        ) : null}
        {state.phase === 'resolved' &&
        state.reply &&
        state.reply.command !== 'create_owner_memory' ? (
          <div className="grid gap-2">
            <p className="text-sm text-muted">
              An earlier form was checked. Reloading loses any note text on this page.
            </p>
            <button type="button" className={btn.outline} onClick={() => window.location.reload()}>
              Reload person page before adding a note
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
