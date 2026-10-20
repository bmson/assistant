'use client';

import { LoaderCircle } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react';
import { btn, cardTitleClass, fileInputClass, inputClass, Panel } from '@/lib/ui';
import { requestPanelUpload } from './upload-request';

/**
 * The one upload form. Documents and Import had byte-identical copies of this
 * panel (file input, submit, an optional-label disclosure, a size hint) that
 * differed only in wording and field name — one component keeps them from
 * drifting apart again.
 */
export function UploadPanel({
  title,
  action,
  submitLabel,
  labelSummary,
  labelName,
  labelCaption,
  labelPlaceholder,
  hint,
  className = '',
}: {
  title: string;
  /** Route the multipart form posts to. */
  action: string;
  submitLabel: string;
  /** Summary line of the optional-label disclosure ("Give it a title"). */
  labelSummary: string;
  /** Form field name of the optional label input. */
  labelName: string;
  labelCaption: string;
  labelPlaceholder: string;
  hint: ReactNode;
  className?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const errorId = useId();
  const hintId = useId();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const data = new FormData(event.currentTarget);
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const destination = await requestPanelUpload(action, data);
      window.location.assign(destination);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'The upload could not be completed. Try again.',
      );
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <Panel tone="sunken" className={className}>
      <h2 className={cardTitleClass}>{title}</h2>
      <form
        action={action}
        method="post"
        encType="multipart/form-data"
        onSubmit={submit}
        aria-busy={pending}
        className="mt-3 flex flex-col items-start gap-3"
      >
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="file"
            name="file"
            required
            disabled={pending}
            aria-label="File to upload"
            aria-describedby={error ? `${hintId} ${errorId}` : hintId}
            className={fileInputClass}
          />
          <button type="submit" disabled={pending} aria-busy={pending} className={btn.primary}>
            {pending ? (
              <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />
            ) : null}
            {pending ? 'Uploading…' : error ? 'Retry upload' : submitLabel}
          </button>
        </div>
        <details className="text-xs text-muted">
          <summary className="disclosure flex items-center gap-2 cursor-pointer">
            {labelSummary}
          </summary>
          <label className="mt-2 flex flex-col gap-1">
            {labelCaption}
            <input
              type="text"
              name={labelName}
              disabled={pending}
              placeholder={labelPlaceholder}
              className={`${inputClass} w-64`}
            />
          </label>
        </details>
      </form>
      {error ? (
        <div className="mt-3 grid gap-2">
          <p id={errorId} role="alert" className="text-sm leading-6 text-red-700 dark:text-red-300">
            {error}
          </p>
          <a
            href={action === '/api/documents/upload' ? '/documents' : '/import'}
            className="text-sm text-accent underline underline-offset-4"
          >
            Refresh list
          </a>
        </div>
      ) : null}
      <p id={hintId} className="mt-2 text-xs text-muted">
        {hint}
      </p>
    </Panel>
  );
}
