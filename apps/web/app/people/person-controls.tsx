'use client';

import { unstable_rethrow, useRouter } from 'next/navigation';
import { useId, useRef, useState, useTransition } from 'react';
import {
  deleteContactAction,
  updateContactIdentityAction,
  updateContactRelationship,
} from '@/app/profile/actions';
import { btn, btnSm, inputClass, labelClass } from '@/lib/ui';

/**
 * Everything that identifies one person — name, aliases, relationship — edited
 * as a single form with one Save and one confirmation. They used to be two
 * forms with a save button each, which read as two unrelated controls sharing a
 * row.
 */
export function PersonControls({
  contactId,
  initialName,
  initialAliases,
  initialRelationship,
}: {
  contactId: string;
  initialName: string;
  initialAliases: string[];
  initialRelationship: string;
}) {
  const initialAliasText = initialAliases.join(', ');
  const [name, setName] = useState(initialName);
  const [aliases, setAliases] = useState(initialAliasText);
  const [relationship, setRelationship] = useState(initialRelationship);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fieldId = useId();
  const saving = useRef(false);

  // The server action revalidates this page, so the initial* props catch up
  // after a save and the button settles back to disabled on its own.
  const dirty =
    name !== initialName || aliases !== initialAliasText || relationship !== initialRelationship;

  /** Any edit clears the last save's feedback, so it never labels new text. */
  const touched = () => {
    setSaved(false);
    setError(null);
  };

  const save = () => {
    // Block a second activation before React renders the pending state.
    if (saving.current || pending || !dirty) return;
    saving.current = true;
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        let result: Awaited<ReturnType<typeof updateContactIdentityAction>>;
        try {
          result = await updateContactIdentityAction(contactId, name, aliases);
        } catch (cause) {
          unstable_rethrow(cause);
          setError('Couldn’t confirm the save. Your edits are still here. Try again.');
          return;
        }
        if (result.error) {
          setError(result.error);
          return;
        }
        if (relationship !== initialRelationship) {
          // This one reports failure by throwing rather than returning an error,
          // so an unguarded await escaped the transition: the owner saw neither a
          // confirmation nor a message, even though the name had already saved.
          try {
            await updateContactRelationship(contactId, relationship);
          } catch {
            setError('The name was saved, but the relationship could not be. Try again.');
            return;
          }
        }
        setSaved(true);
      } finally {
        saving.current = false;
      }
    });
  };

  const saveOnEnter = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    }
  };

  return (
    <div className="mt-4 min-w-0">
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor={`${fieldId}-name`} className={labelClass}>
            Name
          </label>
          <input
            id={`${fieldId}-name`}
            type="text"
            value={name}
            maxLength={120}
            disabled={pending}
            onChange={(event) => {
              setName(event.target.value);
              touched();
            }}
            onKeyDown={saveOnEnter}
            className={`${inputClass} mt-1.5 w-full`}
          />
        </div>
        <div className="min-w-0">
          <label htmlFor={`${fieldId}-relationship`} className={labelClass}>
            Relationship
          </label>
          <input
            id={`${fieldId}-relationship`}
            type="text"
            value={relationship}
            maxLength={80}
            disabled={pending}
            placeholder="sister, colleague, neighbour…"
            onChange={(event) => {
              setRelationship(event.target.value);
              touched();
            }}
            onKeyDown={saveOnEnter}
            className={`${inputClass} mt-1.5 w-full`}
          />
        </div>
        <div className="min-w-0 sm:col-span-2">
          <label htmlFor={`${fieldId}-aliases`} className={labelClass}>
            Also known as
          </label>
          <input
            id={`${fieldId}-aliases`}
            type="text"
            value={aliases}
            maxLength={4_000}
            disabled={pending}
            placeholder="Nicknames and spellings, comma separated"
            onChange={(event) => {
              setAliases(event.target.value);
              touched();
            }}
            onKeyDown={saveOnEnter}
            className={`${inputClass} mt-1.5 w-full`}
          />
          <p className="mt-1.5 text-xs text-muted">
            Aliases help the assistant recognise this person in email, calendar invites, and chat.
          </p>
        </div>
      </div>
      <div className="mt-4 flex min-w-0 flex-wrap items-center gap-3">
        <button type="button" disabled={pending || !dirty} onClick={save} className={btn.primary}>
          {pending ? 'Saving…' : 'Save changes'}
        </button>
        {saved && !pending ? (
          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Saved</span>
        ) : null}
        {error ? (
          <span role="alert" className="text-xs text-red-600 dark:text-red-400">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Deleting a person also tombstones their facts, so it asks first. */
export function DeletePerson({
  contactId,
  name,
  returnTo = '/people',
}: {
  contactId: string;
  name: string;
  /** Where to land once the person no longer exists to navigate back to. */
  returnTo?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const remove = () => {
    setError(null);
    startTransition(async () => {
      const result = await deleteContactAction(contactId);
      if (result.error) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      router.push(returnTo);
      router.refresh();
    });
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {confirming ? (
        <>
          <span className="text-xs text-red-700 dark:text-red-400">
            Delete {name} and every fact about them?
          </span>
          <button type="button" disabled={pending} onClick={remove} className={btnSm.danger}>
            {pending ? 'Deleting…' : 'Yes, delete'}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirming(false)}
            className={btnSm.outline}
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setConfirming(true);
            setError(null);
          }}
          className={btnSm.dangerOutline}
        >
          Delete person
        </button>
      )}
      {error ? (
        <span role="alert" className="w-full text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : null}
    </div>
  );
}
