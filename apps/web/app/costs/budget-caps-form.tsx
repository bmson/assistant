'use client';

import { type BudgetCaps, normalizeBudgetCaps } from '@assistant/persistence/budget-caps';
import { useRef, useState, useTransition } from 'react';
import { updateCaps } from '@/app/costs/actions';
import { btn, inputClass } from '@/lib/ui';

const scopes = [
  ['task_default', 'Default task cap (USD)'],
  ['daily', 'Daily cap (USD)'],
  ['monthly', 'Monthly cap (USD)'],
] as const;

/** Shared exact-cent validation; a confirmed receipt names the submitted values. */
export function BudgetCapsForm({ initial }: { initial: BudgetCaps }) {
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<BudgetCaps>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<BudgetCaps | null>(null);
  const [pending, startTransition] = useTransition();
  const inFlight = useRef(false);
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      noValidate
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        if (inFlight.current) return;
        const invalid: BudgetCaps = {};
        for (const [scope] of scopes) {
          const raw = draft[scope]?.trim();
          if (!raw) continue;
          const result = normalizeBudgetCaps({ [scope]: raw });
          if (result.error) invalid[scope] = result.error;
        }
        setErrors(invalid);
        setSaved(null);
        setError(null);
        if (Object.keys(invalid).length) return;
        const normalized = normalizeBudgetCaps(draft);
        if (normalized.error) {
          setError(normalized.error);
          return;
        }
        const submitted = normalized.caps ?? {};
        const body = new FormData();
        for (const [scope, amount] of Object.entries(submitted)) body.set(scope, amount);
        inFlight.current = true;
        startTransition(async () => {
          try {
            await updateCaps(body);
            setSaved(submitted);
          } catch {
            setError(
              'The limits could not be saved. Your entries are kept here; check the connection and try again.',
            );
          } finally {
            inFlight.current = false;
          }
        });
      }}
    >
      {scopes.map(([scope, label]) => (
        <label key={scope} className="flex flex-col gap-1 text-xs font-medium text-muted">
          {label}
          <input
            name={scope}
            type="text"
            inputMode="decimal"
            disabled={pending}
            value={draft[scope] ?? ''}
            aria-invalid={!!errors[scope]}
            aria-describedby={errors[scope] ? `${scope}-error` : 'cap-semantics'}
            onChange={(event) => {
              setDraft((current) => ({ ...current, [scope]: event.target.value }));
              setErrors((current) => ({ ...current, [scope]: undefined }));
              setSaved(null);
            }}
            className={`${inputClass} w-28`}
          />
          {errors[scope] ? (
            <span id={`${scope}-error`} role="alert" className="text-red-600">
              {errors[scope]}
            </span>
          ) : null}
        </label>
      ))}
      <button type="submit" disabled={pending} className={`${btn.outline} w-full sm:w-auto`}>
        {pending ? 'Updating…' : 'Update caps'}
      </button>
      <p id="cap-semantics" className="w-full text-xs text-muted">
        Enter $0.00–$10,000.00 in whole cents. Zero pauses spending; blank leaves that limit
        unchanged. Saving does not remove a cap.
      </p>
      {error ? (
        <p role="alert" className="w-full text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="w-full text-xs text-muted">
          Saved:{' '}
          {scopes
            .filter(([scope]) => saved[scope] !== undefined)
            .map(([scope, label]) => `${label}: $${saved[scope]}`)
            .join('; ')}
          .
        </p>
      ) : null}
    </form>
  );
}
