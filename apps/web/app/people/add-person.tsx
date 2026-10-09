'use client';

import { UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { createPersonAction } from '@/app/profile/actions';
import { btn, btnSm, inputClass, labelClass } from '@/lib/ui';

/** Owner-driven "add a person" — creates a known contact and opens their page. */
export function AddPerson() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ name: '', relationship: '', aliases: '' });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const submitting = useRef(false);
  const router = useRouter();

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={btnSm.outline}>
        <UserPlus className="size-3.5" aria-hidden="true" />
        Add person
      </button>
    );
  }

  return (
    <form
      aria-busy={pending}
      className="mt-3 flex flex-col gap-3 rounded-2xl border border-edge bg-raised p-4"
      action={(formData) =>
        startTransition(async () => {
          if (submitting.current) return;
          submitting.current = true;
          setError(null);
          try {
            const result = await createPersonAction({
              name: String(formData.get('name') ?? ''),
              relationship: String(formData.get('relationship') ?? ''),
              aliases: String(formData.get('aliases') ?? ''),
            });
            if (result.error) setError(result.error);
            else if (result.contactId) router.push(`/people/${result.contactId}`);
            else {
              setOpen(false);
              router.refresh();
            }
          } catch {
            setError('The person could not be saved. Your draft is kept here.');
          } finally {
            submitting.current = false;
          }
        })
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className={`flex flex-col gap-1 ${labelClass}`}>
          Name
          <input
            name="name"
            disabled={pending}
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            type="text"
            required
            className={`${inputClass} w-56`}
          />
        </label>
        <label className={`flex flex-col gap-1 ${labelClass}`}>
          Relationship
          <input
            name="relationship"
            disabled={pending}
            value={draft.relationship}
            onChange={(event) =>
              setDraft((current) => ({ ...current, relationship: event.target.value }))
            }
            type="text"
            placeholder="e.g. sister, colleague"
            className={`${inputClass} w-44`}
          />
        </label>
        <label className={`flex flex-col gap-1 ${labelClass}`}>
          Also known as (optional)
          <input
            name="aliases"
            disabled={pending}
            value={draft.aliases}
            onChange={(event) =>
              setDraft((current) => ({ ...current, aliases: event.target.value }))
            }
            type="text"
            placeholder="nicknames, comma separated"
            className={`${inputClass} w-56`}
          />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" disabled={pending} className={btn.primary}>
          {pending ? 'Adding…' : 'Add person'}
        </button>
        {/* Not cancellable mid-flight: the contact is already being created,
            and letting the form close implied otherwise — then the resolved
            request navigated to the new person seconds later. */}
        <button
          type="button"
          disabled={pending}
          onClick={() => setOpen(false)}
          className={btn.outline}
        >
          Cancel
        </button>
        {error ? (
          <span role="alert" className="text-xs text-red-600 dark:text-red-400">
            {error}
          </span>
        ) : null}
      </div>
    </form>
  );
}
