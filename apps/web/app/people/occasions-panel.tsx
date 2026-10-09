'use client';

import { useRef, useState, useTransition } from 'react';
import {
  addOccasionAction,
  forgetOccasionAction,
  reviewOccasionAction,
  updateOccasionAction,
} from '@/app/profile/actions';
import {
  Badge,
  btn,
  btnSm,
  EmptyState,
  inputClass,
  labelClass,
  SectionHeading,
  selectClass,
} from '@/lib/ui';
import { ActionButton, ConfirmButton } from '@/lib/ui-client';

/** Plain-serializable occasion view built in the page. */
export interface OccasionView {
  id: string;
  kind: string;
  label: string;
  month: number;
  day: number;
  year: number | null;
  leadDays?: number;
  notes: string;
  quarantined: boolean;
}

/** A date found in a saved fact that isn't yet an occasion (the chip source). */
export interface OccasionSuggestion {
  kind: 'birthday' | 'anniversary';
  month: number;
  day: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function dateLabel(o: OccasionView): string {
  const md = `${MONTHS[o.month - 1] ?? o.month} ${o.day}`;
  return o.year ? `${md}, ${o.year}` : md;
}

/**
 * Distinguishes one row's controls from another's for a screen reader: two
 * anniversaries on different dates, or two custom occasions sharing a label,
 * both announced identically when the name was the kind alone.
 */
function rowName(o: OccasionView): string {
  return `${kindLabel(o)} (${dateLabel(o)})`;
}

function kindLabel(o: OccasionView): string {
  if (o.kind === 'custom') return o.label || 'occasion';
  return o.kind;
}

export function OccasionsPanel({
  contactId,
  personName,
  occasions,
  suggestions = [],
}: {
  contactId: string;
  personName: string;
  occasions: OccasionView[];
  suggestions?: OccasionSuggestion[];
}) {
  const [pending, startTransition] = useTransition();
  /**
   * Which occasion an action is running against. `pending` alone is panel-wide,
   * so confirming one date disabled every other row's buttons — and the Add
   * button — for a round trip that only touched one record.
   */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'approve' | 'reject' | 'forget' | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<OccasionView | null>(null);
  const [draft, setDraft] = useState({
    kind: 'birthday',
    label: '',
    month: '',
    day: '',
    year: '',
    leadDays: '7',
    notes: '',
  });
  const saveInFlight = useRef(false);
  const editorGeneration = useRef(0);
  const currentContact = useRef(contactId);
  currentContact.current = contactId;
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const runForRow = (
    id: string,
    action: () => Promise<unknown>,
    name: 'approve' | 'reject' | 'forget',
  ) => {
    setBusyId(id);
    setBusyAction(name);
    startTransition(async () => {
      try {
        await action();
      } catch {
        setError('That change could not be saved. Try again.');
      } finally {
        setBusyId(null);
        setBusyAction(null);
      }
    });
  };

  const saveSuggestion = (suggestion: OccasionSuggestion) => {
    const key = `${suggestion.month}-${suggestion.day}`;
    startTransition(async () => {
      setError(null);
      try {
        const result = await addOccasionAction(contactId, {
          kind: suggestion.kind,
          label: '',
          month: String(suggestion.month),
          day: String(suggestion.day),
          year: '',
          leadDays: '7',
          notes: '',
        });
        if (result.error) setError(result.error);
        else setDismissed((prev) => new Set(prev).add(key));
      } catch {
        setError('The suggested occasion could not be saved. Try again.');
      }
    });
  };

  const visibleSuggestions = suggestions.filter((s) => !dismissed.has(`${s.month}-${s.day}`));

  return (
    <section id="important-dates" className="mt-6 scroll-mt-24">
      <SectionHeading title="Important dates" count={occasions.length} />
      <p className="mt-1 text-xs text-muted">
        Birthdays, anniversaries, and other recurring dates. The assistant reminds you at lead time
        in your morning brief.
      </p>

      {occasions.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2">
          {occasions.map((o) => (
            <div
              key={o.id}
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-3 ${
                o.quarantined
                  ? 'border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20'
                  : 'border-edge'
              }`}
            >
              {/* Owner-supplied text: a long unbroken custom label or note has
                  no wrap opportunity, and a flex child defaults to min-width
                  auto, so without these the row pushes past a 390px viewport. */}
              <span className="min-w-0 max-w-full text-sm font-medium break-words capitalize">
                {kindLabel(o)}
              </span>
              <span className="min-w-0 max-w-full text-sm break-words text-muted">
                {dateLabel(o)}
              </span>
              {o.notes ? (
                <span className="min-w-0 max-w-full text-xs break-words text-muted">
                  — {o.notes}
                </span>
              ) : null}
              {o.quarantined ? (
                <Badge tone="amber" size="xs">
                  Unverified
                </Badge>
              ) : null}
              <span className="ml-auto flex flex-wrap justify-end gap-2">
                {o.quarantined ? (
                  <>
                    <ActionButton
                      variant="primary"
                      size="sm"
                      disabled={pending || busyId === o.id}
                      pending={busyId === o.id && busyAction === 'approve'}
                      pendingLabel="Confirming…"
                      aria-label={`Confirm ${rowName(o)}`}
                      onClick={() =>
                        runForRow(o.id, () => reviewOccasionAction(o.id, 'approve'), 'approve')
                      }
                    >
                      Confirm
                    </ActionButton>
                    {/* Rejecting deletes the occasion outright, with no
                        tombstone and no undo, and sits one button away from
                        Confirm in a list the owner skims. It asks twice. */}
                    <ConfirmButton
                      size="sm"
                      confirmLabel="Reject?"
                      pendingLabel="Rejecting…"
                      disabled={pending || busyId === o.id}
                      pending={busyId === o.id && busyAction === 'reject'}
                      title={`Deletes this ${kindLabel(o)} permanently`}
                      onConfirm={() =>
                        runForRow(o.id, () => reviewOccasionAction(o.id, 'reject'), 'reject')
                      }
                    >
                      Reject
                    </ConfirmButton>
                  </>
                ) : null}
                <button
                  type="button"
                  disabled={pending || busyId === o.id}
                  className={btnSm.outline}
                  aria-label={`Edit ${rowName(o)}`}
                  onClick={() => {
                    if (saveInFlight.current) return;
                    editorGeneration.current += 1;
                    setDraft({
                      kind: o.kind,
                      label: o.label,
                      month: String(o.month),
                      day: String(o.day),
                      year: o.year == null ? '' : String(o.year),
                      leadDays: String(o.leadDays ?? 7),
                      notes: o.notes,
                    });
                    setEditing(o);
                    setAdding(true);
                    setError(null);
                  }}
                >
                  Edit
                </button>
                {o.quarantined ? null : (
                  <ConfirmButton
                    size="sm"
                    confirmLabel="Forget?"
                    pendingLabel="Forgetting…"
                    disabled={pending || busyId === o.id}
                    pending={busyId === o.id && busyAction === 'forget'}
                    title={`Deletes this ${kindLabel(o)} permanently`}
                    onConfirm={() => runForRow(o.id, () => forgetOccasionAction(o.id), 'forget')}
                  >
                    Forget
                  </ConfirmButton>
                )}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState>No occasions saved for {personName} yet.</EmptyState>
      )}

      {visibleSuggestions.length > 0 ? (
        <div className="mt-3 rounded-xl border border-dashed border-edge bg-sunken/40 p-3">
          <p className="text-xs text-muted">
            Found in saved facts — save any of these as a recurring reminder:
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {visibleSuggestions.map((s) => (
              <button
                key={`${s.month}-${s.day}-${s.kind}`}
                type="button"
                disabled={pending}
                onClick={() => saveSuggestion(s)}
                className={`${btn.outline} gap-1`}
                title={`Save ${MONTHS_LONG[s.month - 1]} ${s.day} as ${s.kind === 'birthday' ? 'a birthday' : 'an anniversary'}`}
              >
                + {MONTHS_LONG[s.month - 1]} {s.day}
                <span className="text-muted">· {s.kind}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {adding ? (
        <form
          key={editing?.id ?? 'new'}
          className="mt-3 flex flex-col gap-3 rounded-2xl bg-sunken/55 p-4"
          aria-busy={pending}
          onSubmit={(event) => {
            event.preventDefault();
            if (saveInFlight.current) return;
            saveInFlight.current = true;
            const generation = editorGeneration.current;
            const ownerContact = contactId;
            const submitted = { ...draft };
            const rowId = editing?.id;
            setError(null);
            startTransition(async () => {
              try {
                const result = rowId
                  ? await updateOccasionAction(rowId, submitted)
                  : await addOccasionAction(ownerContact, submitted);
                if (
                  generation !== editorGeneration.current ||
                  currentContact.current !== ownerContact
                )
                  return;
                if (result.error) setError(result.error);
                else {
                  setAdding(false);
                  setEditing(null);
                  editorGeneration.current += 1;
                }
              } catch {
                if (
                  generation === editorGeneration.current &&
                  currentContact.current === ownerContact
                )
                  setError('The occasion could not be saved. Your draft is kept here.');
              } finally {
                saveInFlight.current = false;
              }
            });
          }}
        >
          <div className="flex flex-wrap items-end gap-3">
            <label className={`flex flex-col gap-1 ${labelClass}`}>
              Type
              <select
                name="kind"
                value={draft.kind}
                disabled={pending}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, kind: event.target.value }))
                }
                className={selectClass}
              >
                <option value="birthday">Birthday</option>
                <option value="anniversary">Anniversary</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            <label className={`flex flex-col gap-1 ${labelClass}`}>
              Label (if custom)
              <input
                name="label"
                type="text"
                placeholder="e.g. graduation"
                value={draft.label}
                disabled={pending}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, label: event.target.value }))
                }
                className={`${inputClass} w-40`}
              />
            </label>
            <label className={`flex flex-col gap-1 ${labelClass}`}>
              Month
              <input
                name="month"
                value={draft.month}
                disabled={pending}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, month: event.target.value }))
                }
                type="number"
                min={1}
                max={12}
                required
                className={`${inputClass} w-20`}
              />
            </label>
            <label className={`flex flex-col gap-1 ${labelClass}`}>
              Day
              <input
                name="day"
                value={draft.day}
                disabled={pending}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, day: event.target.value }))
                }
                type="number"
                min={1}
                max={31}
                required
                className={`${inputClass} w-20`}
              />
            </label>
            <label className={`flex flex-col gap-1 ${labelClass}`}>
              Year (optional)
              <input
                name="year"
                value={draft.year}
                disabled={pending}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, year: event.target.value }))
                }
                type="number"
                min={1900}
                max={2200}
                className={`${inputClass} w-24`}
              />
            </label>
            <label className={`flex flex-col gap-1 ${labelClass}`}>
              Remind (days before)
              <input
                name="leadDays"
                type="number"
                min={0}
                max={60}
                value={draft.leadDays}
                disabled={pending}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, leadDays: event.target.value }))
                }
                className={`${inputClass} w-24`}
              />
            </label>
          </div>
          <label className={`flex flex-col gap-1 ${labelClass}`}>
            Notes / gift ideas (optional)
            <input
              name="notes"
              value={draft.notes}
              disabled={pending}
              onChange={(event) =>
                setDraft((current) => ({ ...current, notes: event.target.value }))
              }
              type="text"
              className={inputClass}
            />
          </label>
          <div className="flex items-center gap-2">
            <button type="submit" disabled={pending} className={btn.primary}>
              {editing ? 'Save changes' : 'Save occasion'}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (saveInFlight.current) return;
                editorGeneration.current += 1;
                setAdding(false);
                setEditing(null);
                setError(null);
              }}
              className={btn.outline}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (saveInFlight.current) return;
            editorGeneration.current += 1;
            setDraft({
              kind: 'birthday',
              label: '',
              month: '',
              day: '',
              year: '',
              leadDays: '7',
              notes: '',
            });
            setEditing(null);
            setAdding(true);
          }}
          className={`${btn.outline} mt-3`}
        >
          Add occasion
        </button>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </section>
  );
}
