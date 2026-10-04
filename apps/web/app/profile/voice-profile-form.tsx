'use client';

import { useState, useTransition } from 'react';
import { updateVoiceProfileAction } from '@/app/profile/actions';
import { btn, inputClass, labelClass, textareaClass } from '@/lib/ui';

/**
 * Editor for the distilled voice profile the rewriter imitates on outbound
 * email/SMS. Do's and don'ts are one per line; the signature appends to
 * outgoing mail. Re-ingesting samples rewrites these — edit after an ingest.
 */
export function VoiceProfileForm({
  initial,
}: {
  initial: { description: string; dos: string[]; donts: string[]; signature: string };
}) {
  const [description, setDescription] = useState(initial.description);
  const [dos, setDos] = useState(initial.dos.join('\n'));
  const [donts, setDonts] = useState(initial.donts.join('\n'));
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
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className={labelClass}>The voice in one or two sentences</span>
        <textarea
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            onChange();
          }}
          rows={2}
          placeholder="Plain, warm, and direct — writes like a capable human colleague."
          className={`${textareaClass} w-full`}
        />
      </label>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className={labelClass}>Do</span>
          <textarea
            value={dos}
            onChange={(e) => {
              setDos(e.target.value);
              onChange();
            }}
            rows={4}
            placeholder={'Get to the point\nSound warm, not formal'}
            className={`${textareaClass} w-full`}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className={labelClass}>Don't</span>
          <textarea
            value={donts}
            onChange={(e) => {
              setDonts(e.target.value);
              onChange();
            }}
            rows={4}
            placeholder={'No corporate filler\nNo hedging preambles'}
            className={`${textareaClass} w-full`}
          />
        </label>
      </div>
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className={labelClass}>Signature on outbound email</span>
        <input
          type="text"
          value={signature}
          onChange={(e) => {
            setSignature(e.target.value);
            onChange();
          }}
          placeholder="— Assistant"
          className={`${inputClass} w-full`}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              setSaved(false);
              try {
                const result = await updateVoiceProfileAction({
                  description,
                  dos,
                  donts,
                  signature,
                });
                if (result.error) setError(result.error);
                else setSaved(true);
              } catch {
                setError(
                  'Your writing voice could not be saved. Your changes are still here; try again.',
                );
              }
            })
          }
          className={btn.primary}
        >
          {pending ? 'Saving…' : 'Save voice'}
        </button>
        {saved && !pending ? (
          <span
            role="status"
            className="text-sm font-medium text-emerald-600 dark:text-emerald-400"
          >
            Saved
          </span>
        ) : null}
        {error ? (
          <span role="alert" className="basis-full text-sm text-red-600 dark:text-red-400">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}
