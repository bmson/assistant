'use client';

import { useState, useTransition } from 'react';
import { updateAgentSettings } from '@/app/settings/actions';
import { btn, inputClass, labelClass, textareaClass } from '@/lib/ui';

/** Timezone/locale/signature editor with Saving…/Saved ✓/error feedback. */
export function AgentForm({
  initial,
}: {
  initial: { timezone: string; locale: string; signature: string };
}) {
  const [timezone, setTimezone] = useState(initial.timezone);
  const [locale, setLocale] = useState(initial.locale);
  const [signature, setSignature] = useState(initial.signature);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onChange = () => {
    setSaved(false);
    setError(null);
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className={labelClass}>Timezone</span>
          <input
            disabled={pending}
            type="text"
            value={timezone}
            onChange={(e) => {
              setTimezone(e.target.value);
              onChange();
            }}
            className={`${inputClass} w-full`}
            placeholder="Atlantic/Reykjavik"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className={labelClass}>Locale</span>
          <input
            disabled={pending}
            type="text"
            value={locale}
            onChange={(e) => {
              setLocale(e.target.value);
              onChange();
            }}
            className={`${inputClass} w-full`}
            placeholder="en"
          />
        </label>
      </div>
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className={labelClass}>Email signature</span>
        {/* textareaClass, not inputClass — the latter pins h-9 and squashed
            this to a single line regardless of rows. */}
        <textarea
          disabled={pending}
          value={signature}
          onChange={(e) => {
            setSignature(e.target.value);
            onChange();
          }}
          rows={3}
          placeholder="Appended to email the assistant sends on your behalf"
          className={`${textareaClass} w-full`}
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              setSaved(false);
              try {
                const result = await updateAgentSettings({ timezone, locale, signature });
                if (result.error) setError(result.error);
                else setSaved(true);
              } catch {
                setError('The settings could not be saved. Your entries are kept here.');
              }
            })
          }
          className={btn.primary}
        >
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
