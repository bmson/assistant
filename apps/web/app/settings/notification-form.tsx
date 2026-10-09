'use client';

import { useState, useTransition } from 'react';
import { updateNotificationSettings } from '@/app/settings/actions';
import { btn, inputClass, labelClass } from '@/lib/ui';

/**
 * Quiet hours + the daily ambient-ping cap. Both fields blank = the shipped
 * default (no quiet hours, no cap), so saving an untouched form changes
 * nothing.
 */
export function NotificationForm({
  initial,
}: {
  initial: { quietStart: string; quietEnd: string; ambientDailyCap: string };
}) {
  const [quietStart, setQuietStart] = useState(initial.quietStart);
  const [quietEnd, setQuietEnd] = useState(initial.quietEnd);
  const [ambientDailyCap, setAmbientDailyCap] = useState(initial.ambientDailyCap);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onChange = () => {
    setSaved(false);
    setError(null);
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid min-w-0 gap-4 sm:grid-cols-3">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className={labelClass}>Quiet from</span>
          <input
            disabled={pending}
            type="time"
            value={quietStart}
            onChange={(e) => {
              setQuietStart(e.target.value);
              onChange();
            }}
            className={`${inputClass} w-full`}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className={labelClass}>Quiet until</span>
          <input
            disabled={pending}
            type="time"
            value={quietEnd}
            onChange={(e) => {
              setQuietEnd(e.target.value);
              onChange();
            }}
            className={`${inputClass} w-full`}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className={labelClass}>Daily ping limit</span>
          <input
            disabled={pending}
            type="number"
            min={1}
            max={100}
            value={ambientDailyCap}
            onChange={(e) => {
              setAmbientDailyCap(e.target.value);
              onChange();
            }}
            placeholder="No limit"
            className={`${inputClass} w-full`}
          />
        </label>
      </div>
      <p className="text-xs leading-5 text-muted">
        During quiet hours the assistant still posts everything to chat, but only what you are
        waiting on (approvals, stalled work) may buzz your phone. The limit caps how often routine
        notices — a briefing, a watch hit, an arrival nudge, anything the assistant volunteers
        during the day — may interrupt, and doubles as how often it may speak up unprompted at all.
        Leave both empty to be reachable at any hour.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              setSaved(false);
              try {
                const result = await updateNotificationSettings({
                  quietStart,
                  quietEnd,
                  ambientDailyCap,
                });
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
