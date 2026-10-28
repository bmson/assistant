'use client';

import {
  PREDICATE_VOCABULARY,
  presentOwnerFamilyFact,
} from '@assistant/application/relationship-presentation';
import type {
  OwnerEditorCanonicalExpectation,
  OwnerEditorCorrectionEligibility,
  OwnerEditorFamilyFields,
  OwnerEditorFormGrant,
  OwnerEditorPersonOption,
  OwnerEditorReply,
  OwnerEditorSessionView,
} from '@assistant/persistence/owner-editor';
import { useRouter } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { OwnerEditorOperation } from '@/lib/owner-editor-operation';
import { btn, btnSm, inputClass, labelClass, selectClass, textareaClass } from '@/lib/ui';
import { Modal } from '@/lib/ui-client';

export interface OwnerEditorControlsProps {
  contextual?: boolean;
  children?: ReactNode;
  session: OwnerEditorSessionView;
  createGrant: OwnerEditorFormGrant | null;
  identity?: {
    grant: OwnerEditorFormGrant;
    contactId: string;
    name: string;
    aliases: string[];
    revision: string;
  };
  family?: {
    grant: OwnerEditorFormGrant;
    anchorContactId: string;
    people: OwnerEditorPersonOption[];
    expectedCanonicalState: OwnerEditorCanonicalExpectation;
    savedRelationships?: {
      relationId: string;
      sentence: string;
      validFrom: string | null;
      validUntil: string | null;
    }[];
  };
  corrections?: { grant: OwnerEditorFormGrant; eligibility: OwnerEditorCorrectionEligibility }[];
  readOnlyCorrections?: { relationId: string; sourceMemoryId: string; reason: string }[];
}
type Active = 'create' | 'identity' | 'family' | { correction: string } | null;
interface IdentityDraft {
  name: string;
  aliases: string;
}
interface FamilyDraft {
  subject: string;
  object: string;
  predicate: string;
  timing: OwnerEditorFamilyFields['timing'];
  from: string;
  until: string;
  note: string;
}
const familyPredicates = PREDICATE_VOCABULARY.filter(
  (p) =>
    p.group === 'family' && p.subjectKinds.includes('person') && p.objectKinds.includes('person'),
);
export const ownerEditorAliasesFromText = (value: string) =>
  value
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
export const ownerEditorAliasesToText = (values: readonly string[]) => values.join('\n');
const emptyPerson = { name: '', aliases: '' };
export const ownerEditorTimingHelpText =
  'Choose how this relationship is described. This choice is separate from the dates below.';

export function OwnerEditorTimingHelp() {
  return <p className="text-sm text-muted">{ownerEditorTimingHelpText}</p>;
}

/** Serializable owner-bound snapshot only. No grant/record authority is minted here. */
export function OwnerEditorControls(props: OwnerEditorControlsProps) {
  const { session, createGrant, identity, family, corrections = [] } = props;
  const router = useRouter();
  const { ownerId, formSessionScope } = session;
  const controller = useMemo(
    () => new OwnerEditorOperation({ ownerId, formSessionScope }, () => window.sessionStorage),
    [ownerId, formSessionScope],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getServerSnapshot,
  );
  const [active, setActive] = useState<Active>(null);
  const [person, setPerson] = useState<IdentityDraft>(emptyPerson);
  const [identityDraft, setIdentityDraftState] = useState<IdentityDraft | null>(null);
  const [familyDraft, setFamilyDraftState] = useState<FamilyDraft | null>(null);
  const familyDrafts = useRef(new OwnerEditorDraftCache());
  const activeDraftKey = useRef('family');
  const [anchorPosition, setAnchorPosition] = useState<'subject' | 'object'>('subject');
  const lastActive = useRef<Active>(null);
  const setFamilyDraft = useCallback((update: SetStateAction<FamilyDraft | null>) => {
    const key = activeDraftKey.current;
    setFamilyDraftState((current) => {
      const next = typeof update === 'function' ? update(current) : update;
      if (next) familyDrafts.current.setFamily(key, next);
      return next;
    });
  }, []);
  const setIdentityDraft = useCallback((update: SetStateAction<IdentityDraft | null>) => {
    setIdentityDraftState((current) => {
      const next = typeof update === 'function' ? update(current) : update;
      if (next) familyDrafts.current.setIdentity(next);
      return next;
    });
  }, []);
  const [finished, setFinished] = useState(false);
  const [displayedGrant, setDisplayedGrant] = useState<OwnerEditorFormGrant | null>(null);
  const [displayedIdentity, setDisplayedIdentity] = useState(identity);
  const [displayedFamily, setDisplayedFamily] = useState(family);
  const [returnToFamily, setReturnToFamily] = useState(false);
  const [selectCreatedId, setSelectCreatedId] = useState<string | null>(null);
  const [correctionSnapshot, setCorrectionSnapshot] =
    useState<OwnerEditorCorrectionEligibility | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const refreshed = useRef<unknown>(null);
  const uid = useId();
  useEffect(() => {
    controller.initialize();
    if (controller.getSnapshot().phase === 'pending') void controller.check();
  }, [controller]);
  useEffect(() => {
    controller.acceptFreshSnapshot(
      [createGrant, identity?.grant, family?.grant, ...corrections.map((c) => c.grant)].filter(
        (g): g is OwnerEditorFormGrant => !!g,
      ),
    );
  }, [controller, createGrant, identity, family, corrections]);
  useEffect(() => {
    if (state.phase !== 'resolved' || !state.reply || refreshed.current === state.reply) return;
    refreshed.current = state.reply;
    setFinished(true);
    const reply = state.reply;
    const completed = familyDrafts.current.complete(reply, state.reviewTargetId);
    if (completed === 'update_person_identity') setIdentityDraftState(null);
    if (completed === 'create_person') setPerson(emptyPerson);
    if (completed === 'add_family_relationship' && activeDraftKey.current === 'family')
      setFamilyDraftState(null);
    if (
      completed === 'correct_owner_family_relationship' &&
      activeDraftKey.current === `correction:${state.reviewTargetId}`
    )
      setFamilyDraftState(null);
    if (
      returnToFamily &&
      reply.authority === 'operation_receipt' &&
      (reply.outcome === 'saved' || reply.outcome === 'unchanged') &&
      reply.ids.contactId
    )
      setSelectCreatedId(reply.ids.contactId);
    router.refresh(); // Read fresh native record CAS; receipt.revision is NOT CAS.
  }, [state.phase, state.reply, state.reviewTargetId, router, returnToFamily]);
  useEffect(() => {
    if (!selectCreatedId || !family?.people.some((p) => p.contactId === selectCreatedId)) return;
    setFamilyDraft((d) => (d ? { ...d, object: selectCreatedId } : d));
  }, [selectCreatedId, family, setFamilyDraft]);
  useEffect(() => {
    if (Object.keys(state.fieldErrors).length)
      form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state.fieldErrors]);
  const locked = state.phase !== 'ready';
  const open = (next: Active, element: HTMLElement) => {
    const nextGrant =
      next === 'create'
        ? createGrant
        : next === 'identity'
          ? identity?.grant
          : next === 'family'
            ? family?.grant
            : next
              ? corrections.find((c) => c.eligibility.relationId === next.correction)?.grant
              : null;
    if (!state.reviewRequired) {
      setDisplayedGrant(nextGrant ?? null);
      setDisplayedIdentity(identity);
      setDisplayedFamily(family);
    }
    lastActive.current = next;
    trigger.current = element;
    setActive(next);
    setFinished(false);
  };
  const close = () => {
    setActive(null);
    queueMicrotask(() => trigger.current?.focus());
  };
  const beginFamily = (element: HTMLElement) => {
    if (!family) return;
    setCorrectionSnapshot(null);
    activeDraftKey.current = 'family';
    const cached = familyDrafts.current.family('family');
    setAnchorPosition(cached?.object === family.anchorContactId ? 'object' : 'subject');
    setFamilyDraft(
      cached ?? {
        subject: family.anchorContactId,
        object: '',
        predicate: '',
        timing: 'unspecified',
        from: '',
        until: '',
        note: '',
      },
    );
    open('family', element);
  };
  const grant = displayedGrant;
  const familyMode = active === 'family' || (active !== null && typeof active === 'object');
  const draft = active === 'create' ? person : (identityDraft ?? emptyPerson);
  const setDraft = active === 'create' ? setPerson : setIdentityDraft;
  const error = (name: string) =>
    state.fieldErrors[name] ?? state.fieldErrors[`replacement.${name}`];
  const id = (name: string) => `${uid}-${name}`;
  const fieldProps = (name: string) => ({
    id: id(name),
    'aria-invalid': error(name) ? (true as const) : undefined,
    'aria-describedby': error(name) ? id(`${name}-error`) : undefined,
  });
  const fieldError = (name: string) =>
    error(name) ? (
      <span id={id(`${name}-error`)} className="text-xs text-red-600 dark:text-red-400">
        {error(name)}
      </span>
    ) : null;
  let preview = 'Choose two named people and a relationship to preview the statement.';
  if (familyDraft && displayedFamily) {
    const subject = displayedFamily.people.find((p) => p.contactId === familyDraft.subject);
    const object = displayedFamily.people.find((p) => p.contactId === familyDraft.object);
    if (subject && object && familyDraft.predicate) {
      try {
        preview = presentOwnerFamilyFact({
          subjectLabel: subject.name,
          objectLabel: object.name,
          predicate: familyDraft.predicate,
          timing: familyDraft.timing,
          validity: { validFrom: familyDraft.from || null, validUntil: familyDraft.until || null },
          note: familyDraft.note,
        });
      } catch {
        preview = 'Check the relationship timing and recorded dates to preview this statement.';
      }
    }
  }
  const submit = async () => {
    if (!grant || locked || finished) return;
    const envelope = {
      version: 1,
      intent: 'apply',
      command: grant.command,
      operationId: grant.operationId,
    };
    if (active === 'create') {
      await controller.apply(
        { ...envelope, name: person.name, aliases: ownerEditorAliasesFromText(person.aliases) },
        grant,
        null,
      );
    } else if (active === 'identity' && displayedIdentity) {
      await controller.apply(
        {
          ...envelope,
          contactId: displayedIdentity.contactId,
          expectedContactRevision: displayedIdentity.revision,
          name: draft.name,
          aliases: ownerEditorAliasesFromText(draft.aliases),
        },
        grant,
        displayedIdentity.contactId,
      );
    } else if (familyDraft && displayedFamily) {
      const subject = displayedFamily.people.find((p) => p.contactId === familyDraft.subject);
      const object = displayedFamily.people.find((p) => p.contactId === familyDraft.object);
      const replacement: OwnerEditorFamilyFields = {
        subjectContactId: familyDraft.subject,
        objectContactId: familyDraft.object,
        expectedSubjectRevision: subject?.revision ?? '',
        expectedObjectRevision: object?.revision ?? '',
        predicate: familyDraft.predicate,
        timing: familyDraft.timing,
        validity: { validFrom: familyDraft.from || null, validUntil: familyDraft.until || null },
        note: familyDraft.note,
        expectedCanonicalState: displayedFamily.expectedCanonicalState,
      };
      if (active === 'family')
        await controller.apply(
          { ...envelope, ...replacement },
          grant,
          displayedFamily.anchorContactId,
        );
      else if (correctionSnapshot)
        await controller.apply(
          {
            ...envelope,
            targetRelationId: correctionSnapshot.relationId,
            expectedTargetRevision: correctionSnapshot.revision,
            replacement,
          },
          grant,
          correctionSnapshot.relationId,
        );
    }
  };
  const reviewCommand = state.reply?.command;
  const latestCorrection = corrections.find(
    (c) => c.eligibility.relationId === state.reviewTargetId,
  );
  const latestGrant =
    reviewCommand === 'create_person'
      ? createGrant
      : reviewCommand === 'update_person_identity' && identity?.contactId === state.reviewTargetId
        ? identity.grant
        : reviewCommand === 'add_family_relationship' &&
            family?.anchorContactId === state.reviewTargetId
          ? family.grant
          : reviewCommand === 'correct_owner_family_relationship'
            ? latestCorrection?.grant
            : null;
  const reviewMissing = reviewCommand === 'correct_owner_family_relationship' && !latestCorrection;
  const review = () => {
    if (!latestGrant || reviewMissing || !controller.reviewFreshSnapshot([latestGrant])) return;
    setDisplayedGrant(latestGrant);
    setDisplayedIdentity(identity);
    setDisplayedFamily(family);
    if (latestCorrection) setCorrectionSnapshot(latestCorrection.eligibility);
    setFinished(false);
  };
  const conflictReview = state.reviewRequired ? (
    <OwnerEditorConflictReview
      latestIdentity={reviewCommand === 'update_person_identity' ? identity : undefined}
      {...ownerEditorConflictIntent({
        command: reviewCommand ?? null,
        identityDraft,
        createDraft: lastActive.current === 'create' ? person : null,
        familyDraft,
        familyPreview: preview,
      })}
      relationships={family?.savedRelationships ?? []}
      latestCorrection={latestCorrection?.eligibility}
      missing={reviewMissing}
      canReview={
        !!latestGrant && latestGrant.operationId !== state.reply?.operationId && !reviewMissing
      }
      onReview={review}
    />
  ) : null;
  const title =
    active === 'create'
      ? 'Add person'
      : active === 'identity'
        ? 'Edit name and aliases'
        : active === 'family'
          ? 'Add family relationship'
          : 'Correct family relationship';
  const openContextual = (entry: OwnerEditorEntryPoint, element: HTMLElement) => {
    if (locked || state.busy) return;
    if (entry === 'identity') {
      if (!identity) return;
      setIdentityDraft(
        (d) =>
          d ??
          familyDrafts.current.identity({
            name: identity.name,
            aliases: ownerEditorAliasesToText(identity.aliases),
          }),
      );
      open('identity', element);
    } else if (entry === 'family') {
      if (family) beginFamily(element);
    } else {
      const c = corrections.find(
        (candidate) => candidate.eligibility.relationId === entry.correction,
      );
      if (!c || !family) return;
      const original = c.eligibility.original;
      setCorrectionSnapshot(c.eligibility);
      activeDraftKey.current = `correction:${c.eligibility.relationId}`;
      setFamilyDraft(
        familyDrafts.current.family(activeDraftKey.current) ?? {
          subject: original.subjectContactId,
          object: original.objectContactId,
          predicate: original.predicate,
          timing: original.timing,
          from: original.validity.validFrom ?? '',
          until: original.validity.validUntil ?? '',
          note: original.note,
        },
      );
      open({ correction: c.eligibility.relationId }, element);
    }
  };
  return (
    <OwnerEditorEntryContext.Provider
      value={{
        locked: locked || state.busy,
        identity: !!identity,
        family: !!family,
        correctionIds: corrections.map((c) => c.eligibility.relationId),
        open: openContextual,
      }}
    >
      <div className="flex flex-col gap-3">
        {props.children}
        {!props.contextual ? (
          <>
            <div className="flex flex-wrap gap-2">
              {createGrant ? (
                <button
                  type="button"
                  className={btnSm.outline}
                  disabled={locked}
                  onClick={(e) => {
                    setReturnToFamily(false);
                    open('create', e.currentTarget);
                  }}
                >
                  Add person
                </button>
              ) : null}
              {identity ? (
                <button
                  type="button"
                  className={btnSm.outline}
                  disabled={locked}
                  onClick={(e) => {
                    setIdentityDraft(
                      (d) =>
                        d ??
                        familyDrafts.current.identity({
                          name: identity.name,
                          aliases: ownerEditorAliasesToText(identity.aliases),
                        }),
                    );
                    open('identity', e.currentTarget);
                  }}
                >
                  Edit name and aliases
                </button>
              ) : null}
              {family ? (
                <button
                  type="button"
                  className={btnSm.outline}
                  disabled={locked}
                  onClick={(e) => beginFamily(e.currentTarget)}
                >
                  Add family relationship
                </button>
              ) : null}
            </div>
            {corrections.map((c) => (
              <div key={c.eligibility.relationId} className="rounded-xl bg-raised p-3">
                <p className="text-sm">{c.eligibility.sourceText}</p>
                <button
                  type="button"
                  className={btnSm.outline}
                  disabled={locked || !family}
                  onClick={(e) => {
                    const original = c.eligibility.original;
                    setCorrectionSnapshot(c.eligibility);
                    activeDraftKey.current = `correction:${c.eligibility.relationId}`;
                    setFamilyDraft(
                      familyDrafts.current.family(activeDraftKey.current) ?? {
                        subject: original.subjectContactId,
                        object: original.objectContactId,
                        predicate: original.predicate,
                        timing: original.timing,
                        from: original.validity.validFrom ?? '',
                        until: original.validity.validUntil ?? '',
                        note: original.note,
                      },
                    );
                    open({ correction: c.eligibility.relationId }, e.currentTarget);
                  }}
                >
                  Correct this owner-authored relationship
                </button>
              </div>
            ))}
          </>
        ) : null}
        {state.message && !active ? (
          <p role="status" className="text-sm text-muted">
            {state.message}
          </p>
        ) : null}
        {state.reviewRequired && !active ? (
          <div className="flex flex-col gap-2">
            {lastActive.current ? (
              <button
                type="button"
                className={btn.outline}
                onClick={(event) => open(lastActive.current, event.currentTarget)}
              >
                Review latest saved values and my draft
              </button>
            ) : (
              conflictReview
            )}
          </div>
        ) : null}
        {state.phase === 'pending' && !active ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={btn.primary}
              disabled={state.busy}
              onClick={() => void controller.checkPendingResult()}
            >
              Check result
            </button>
          </div>
        ) : null}
        {state.phase === 'resolved' ? (
          <button type="button" className={btnSm.outline} onClick={() => router.refresh()}>
            Refresh saved details
          </button>
        ) : null}
        {active ? (
          <Modal label={title} onClose={close} dismissible={!state.busy}>
            <h2 className="text-lg font-semibold text-strong">{title}</h2>
            <p className="text-sm text-muted">
              Closing does not cancel a save. Reloading may lose this draft; if the result is
              unknown, reopen this page to check that same save.
            </p>
            {conflictReview}
            <form
              ref={form}
              className="flex flex-col gap-3"
              aria-busy={state.busy}
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <fieldset disabled={locked || finished} className="flex min-w-0 flex-col gap-3">
                {!familyMode ? (
                  <>
                    {active === 'create' ? (
                      <p className="text-sm text-muted">
                        Adding a person marks them as a known contact.
                      </p>
                    ) : (
                      <p className="text-sm text-muted">
                        When editing began: {displayedIdentity?.name}. Aliases:{' '}
                        {displayedIdentity?.aliases.join(', ') || 'None'}. Editing name and aliases
                        does not change trust.
                      </p>
                    )}
                    <label className={labelClass} htmlFor={id('name')}>
                      Name
                    </label>
                    <input
                      {...fieldProps('name')}
                      className={inputClass}
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    />
                    {fieldError('name')}
                    <label className={labelClass} htmlFor={id('aliases')}>
                      Also known as (one alias per line, optional)
                    </label>
                    <textarea
                      {...fieldProps('aliases')}
                      className={textareaClass}
                      value={draft.aliases}
                      onChange={(e) => setDraft({ ...draft, aliases: e.target.value })}
                    />
                    {fieldError('aliases')}
                  </>
                ) : familyDraft && displayedFamily ? (
                  <>
                    {correctionSnapshot ? (
                      <div className="rounded-xl bg-sunken p-3 text-sm">
                        <p>Original owner-authored statement: {correctionSnapshot.sourceText}</p>
                        <p>
                          Relationship dates:{' '}
                          {correctionSnapshot.original.validity.validFrom ?? 'Start not recorded'} —{' '}
                          {correctionSnapshot.original.validity.validUntil ?? 'End not recorded'}{' '}
                          (end inclusive when recorded).
                        </p>
                        <p>
                          Saving replaces this statement in saved memory and records its correction
                          history.
                        </p>
                      </div>
                    ) : null}
                    <OwnerEditorPeopleSelectors
                      idPrefix={uid}
                      draft={familyDraft}
                      people={displayedFamily.people}
                      anchorPosition={active === 'family' ? anchorPosition : undefined}
                      errors={{
                        subject: error('subjectContactId'),
                        object: error('objectContactId'),
                      }}
                      onChange={(endpoint, contactId) =>
                        setFamilyDraft({ ...familyDraft, [endpoint]: contactId })
                      }
                    />
                    <button
                      type="button"
                      className={btn.outline}
                      onClick={() => {
                        setFamilyDraft({
                          ...familyDraft,
                          subject: familyDraft.object,
                          object: familyDraft.subject,
                        });
                        setAnchorPosition((position) =>
                          position === 'subject' ? 'object' : 'subject',
                        );
                      }}
                    >
                      Swap people
                    </button>
                    <label className={labelClass} htmlFor={id('predicate')}>
                      Relationship of the first person to the second
                    </label>
                    <select
                      {...fieldProps('predicate')}
                      className={selectClass}
                      value={familyDraft.predicate}
                      onChange={(e) =>
                        setFamilyDraft({ ...familyDraft, predicate: e.target.value })
                      }
                    >
                      <option value="">Choose a family relationship</option>
                      {familyPredicates.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.id.replaceAll('_', ' ')}
                        </option>
                      ))}
                    </select>
                    {fieldError('predicate')}
                    <label className={labelClass} htmlFor={id('timing')}>
                      How this relationship is described
                    </label>
                    <select
                      {...fieldProps('timing')}
                      className={selectClass}
                      value={familyDraft.timing}
                      onChange={(e) =>
                        setFamilyDraft({
                          ...familyDraft,
                          timing: e.target.value as FamilyDraft['timing'],
                        })
                      }
                    >
                      <option value="unspecified">Not specified</option>
                      <option value="present">Present</option>
                      <option value="past">Past</option>
                    </select>
                    <OwnerEditorTimingHelp />
                    {fieldError('timing')}
                    <p className="text-sm font-medium">Relationship dates (optional)</p>
                    <p className="text-sm text-muted">
                      Dates when this relationship applies, as you know them—not when you saved it.
                      Leave unknown dates blank.
                    </p>
                    {(['from', 'until'] as const).map((part) => (
                      <div key={part} className="flex flex-col gap-1">
                        <label className={labelClass} htmlFor={id(part)}>
                          {part === 'from' ? 'From' : 'Through (inclusive)'}
                        </label>
                        <input
                          {...fieldProps(
                            `validity.${part === 'from' ? 'validFrom' : 'validUntil'}`,
                          )}
                          id={id(part)}
                          type="date"
                          className={inputClass}
                          value={familyDraft[part]}
                          onChange={(e) =>
                            setFamilyDraft({ ...familyDraft, [part]: e.target.value })
                          }
                        />
                        {fieldError(`validity.${part === 'from' ? 'validFrom' : 'validUntil'}`)}
                      </div>
                    ))}
                    <label className={labelClass} htmlFor={id('note')}>
                      Owner note (optional)
                    </label>
                    <textarea
                      {...fieldProps('note')}
                      className={textareaClass}
                      value={familyDraft.note}
                      onChange={(e) => setFamilyDraft({ ...familyDraft, note: e.target.value })}
                    />
                    {fieldError('note')}
                    <p className="rounded-xl bg-sunken p-3 text-sm" aria-live="polite">
                      {preview}
                    </p>
                  </>
                ) : null}
              </fieldset>
              {active === 'family' && createGrant ? (
                <button
                  type="button"
                  className={btn.outline}
                  disabled={locked}
                  onClick={() => {
                    setReturnToFamily(true);
                    setDisplayedGrant(createGrant);
                    setActive('create');
                    setFinished(false);
                  }}
                >
                  Create a person separately
                </button>
              ) : null}
              {Object.entries(state.fieldErrors)
                .filter(([key]) => key === 'request' || key.startsWith('expected'))
                .map(([key, value]) => (
                  <p key={key} role="alert" className="text-sm text-red-600">
                    {value}
                  </p>
                ))}
              {state.message ? (
                <p role="status" className="text-sm">
                  {state.message}
                </p>
              ) : null}
              {state.phase === 'pending' ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={btn.primary}
                    disabled={state.busy}
                    onClick={() => void controller.checkPendingResult()}
                  >
                    Check result
                  </button>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {!finished && state.phase !== 'pending' ? (
                  <button type="submit" className={btn.primary} disabled={locked || !grant}>
                    {state.busy
                      ? 'Saving…'
                      : active === 'create'
                        ? 'Add person'
                        : correctionSnapshot && familyMode
                          ? 'Save correction'
                          : 'Save'}
                  </button>
                ) : null}
                {returnToFamily &&
                selectCreatedId &&
                family?.people.some((p) => p.contactId === selectCreatedId) ? (
                  <button
                    type="button"
                    className={btn.outline}
                    onClick={() => {
                      setDisplayedFamily(family);
                      setDisplayedGrant(family.grant);
                      setActive('family');
                      setFinished(false);
                      setReturnToFamily(false);
                    }}
                  >
                    Return to family relationship
                  </button>
                ) : null}
                <button type="button" className={btn.outline} disabled={state.busy} onClick={close}>
                  Close
                </button>
              </div>
            </form>
          </Modal>
        ) : null}
      </div>
    </OwnerEditorEntryContext.Provider>
  );
}

export function OwnerEditorPeopleSelectors(props: {
  idPrefix: string;
  draft: { subject: string; object: string };
  people: OwnerEditorPersonOption[];
  anchorPosition?: 'subject' | 'object';
  errors?: { subject?: string; object?: string };
  onChange(endpoint: 'subject' | 'object', contactId: string): void;
}) {
  const nameCounts = new Map<string, number>();
  for (const person of props.people) {
    nameCounts.set(person.name, (nameCounts.get(person.name) ?? 0) + 1);
  }
  return (
    <>
      {(['subject', 'object'] as const).map((endpoint, index) => {
        const id = `${props.idPrefix}-${endpoint}`;
        const error = props.errors?.[endpoint];
        const opposite = props.draft[endpoint === 'subject' ? 'object' : 'subject'];
        return (
          <div key={endpoint} className="flex flex-col gap-1">
            <label className={labelClass} htmlFor={id}>
              {index === 0 ? 'First person' : 'Second person'}
            </label>
            <select
              id={id}
              className={selectClass}
              disabled={props.anchorPosition === endpoint}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              value={props.draft[endpoint]}
              onChange={(event) => props.onChange(endpoint, event.target.value)}
            >
              <option value="">Choose an existing named person</option>
              {props.people
                .filter((person) => person.contactId !== opposite)
                .map((person) => (
                  <option key={person.contactId} value={person.contactId}>
                    {nameCounts.get(person.name) === 1
                      ? person.name
                      : `${person.name} · ${person.contactId.slice(0, 8)}`}
                  </option>
                ))}
            </select>
            {error ? (
              <span id={`${id}-error`} className="text-xs text-red-600 dark:text-red-400">
                {error}
              </span>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

export function OwnerEditorConflictReview(props: {
  latestIdentity?: { name: string; aliases: string[] };
  intendedIdentity?: { name: string; aliases: string };
  relationships: {
    relationId: string;
    sentence: string;
    validFrom: string | null;
    validUntil: string | null;
  }[];
  latestCorrection?: OwnerEditorCorrectionEligibility;
  intendedFamily?: string;
  missing: boolean;
  canReview: boolean;
  onReview(): void;
}) {
  return (
    <section
      aria-label="Review changed saved details"
      className="flex flex-col gap-2 rounded-xl bg-sunken p-3 text-sm"
    >
      <h3 className="font-semibold">Latest</h3>
      {props.latestIdentity ? (
        <p>
          Saved name: {props.latestIdentity.name}. All saved aliases:{' '}
          {props.latestIdentity.aliases.join(', ') || 'None'}.
        </p>
      ) : null}
      {props.relationships.map((relationship) => (
        <p key={relationship.relationId}>
          {relationship.sentence} Relationship dates:{' '}
          {relationship.validFrom ?? 'Start not recorded'} —{' '}
          {relationship.validUntil ?? 'End not recorded'} (inclusive when recorded).
        </p>
      ))}
      {props.latestCorrection ? (
        <p>
          Latest owner-authored statement: {props.latestCorrection.sourceText}. Relationship dates:{' '}
          {props.latestCorrection.original.validity.validFrom ?? 'Start not recorded'} —{' '}
          {props.latestCorrection.original.validity.validUntil ?? 'End not recorded'} (inclusive
          when recorded).
        </p>
      ) : null}
      <h3 className="font-semibold">Your draft</h3>
      {props.intendedIdentity ? (
        <p>
          Name: {props.intendedIdentity.name}. Aliases: {props.intendedIdentity.aliases || 'None'}.
        </p>
      ) : null}
      {props.intendedFamily ? <p>{props.intendedFamily}</p> : null}
      {!props.intendedIdentity && !props.intendedFamily ? (
        <p>No draft is available to compare.</p>
      ) : null}
      {props.missing ? (
        <p role="alert">
          This relationship is no longer editable here.{' '}
          {props.intendedIdentity || props.intendedFamily
            ? 'Your intended edit stays on this open page. '
            : null}
          No different relationship will be substituted.
        </p>
      ) : (
        <button
          type="button"
          className={btn.outline}
          disabled={!props.canReview}
          onClick={props.onReview}
        >
          I reviewed the latest values —{' '}
          {props.intendedIdentity || props.intendedFamily
            ? 'keep my draft for editing'
            : 'start a new edit'}
        </button>
      )}
    </section>
  );
}

/** Memory-only draft lifecycle shared by the actual controls and source tests. */
export class OwnerEditorDraftCache {
  private identityValue: IdentityDraft | null = null;
  private families = new Map<string, FamilyDraft>();
  identity(latest: IdentityDraft): IdentityDraft {
    if (!this.identityValue) this.identityValue = { ...latest };
    return this.identityValue;
  }
  setIdentity(value: IdentityDraft) {
    this.identityValue = { ...value };
  }
  family(key: string) {
    return this.families.get(key);
  }
  setFamily(key: string, value: FamilyDraft) {
    this.families.set(key, { ...value });
  }
  complete(reply: OwnerEditorReply, targetId: string | null): OwnerEditorReply['command'] | null {
    if (
      reply.authority !== 'operation_receipt' ||
      (reply.outcome !== 'saved' && reply.outcome !== 'unchanged')
    )
      return null;
    if (reply.command === 'update_person_identity') this.identityValue = null;
    if (reply.command === 'add_family_relationship') this.families.delete('family');
    if (reply.command === 'correct_owner_family_relationship' && targetId)
      this.families.delete(`correction:${targetId}`);
    return reply.command;
  }
}

/** The actual caller uses draft presence independently of preview placeholder text. */
export function ownerEditorConflictIntent(input: {
  command: OwnerEditorReply['command'];
  identityDraft: IdentityDraft | null;
  createDraft: IdentityDraft | null;
  familyDraft: FamilyDraft | null;
  familyPreview: string;
}): { intendedIdentity?: IdentityDraft; intendedFamily?: string } {
  if (input.command === 'create_person')
    return { intendedIdentity: input.createDraft ?? undefined };
  if (input.command === 'update_person_identity')
    return { intendedIdentity: input.identityDraft ?? undefined };
  return { intendedFamily: input.familyDraft ? input.familyPreview : undefined };
}
type OwnerEditorEntryPoint = 'identity' | 'family' | { correction: string };
const OwnerEditorEntryContext = createContext<{
  locked: boolean;
  identity: boolean;
  family: boolean;
  correctionIds: string[];
  open(entry: OwnerEditorEntryPoint, element: HTMLElement): void;
} | null>(null);

/** Contextual triggers reuse one controller and the same server-issued capabilities. */
export function OwnerEditorContextTrigger({ entry }: { entry: OwnerEditorEntryPoint }) {
  const context = useContext(OwnerEditorEntryContext);
  const eligible =
    !!context &&
    (entry === 'identity'
      ? context.identity
      : entry === 'family'
        ? context.family
        : context.family && context.correctionIds.includes(entry.correction));
  if (!eligible || !context) return null;
  return (
    <button
      type="button"
      className={btnSm.outline}
      disabled={context.locked}
      onClick={(event) => context.open(entry, event.currentTarget)}
    >
      {entry === 'identity'
        ? 'Edit details'
        : entry === 'family'
          ? 'Add family relationship'
          : 'Edit relationship'}
    </button>
  );
}

export function OwnerEditorContextualHost({
  editor,
  children,
}: {
  editor: OwnerEditorControlsProps | null;
  children: ReactNode;
}) {
  return editor ? (
    <OwnerEditorControls {...editor} contextual>
      {children}
    </OwnerEditorControls>
  ) : (
    children
  );
}
