import type { ReactNode } from 'react';
import { cardTitleClass, fileInputClass, inputClass, Panel } from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';

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
  return (
    <Panel tone="sunken" className={className}>
      <h2 className={cardTitleClass}>{title}</h2>
      <form
        action={action}
        method="post"
        encType="multipart/form-data"
        className="mt-3 flex min-w-0 w-full flex-col items-start gap-3"
      >
        <div className="flex min-w-0 w-full flex-wrap items-center gap-3">
          <input type="file" name="file" required className={fileInputClass} />
          <SubmitButton variant="primary" pendingLabel="Uploading…">
            {submitLabel}
          </SubmitButton>
        </div>
        <details className="min-w-0 max-w-full text-xs text-muted">
          <summary className="disclosure flex items-center gap-2 cursor-pointer">
            {labelSummary}
          </summary>
          <label className="mt-2 flex flex-col gap-1">
            {labelCaption}
            <input
              type="text"
              name={labelName}
              placeholder={labelPlaceholder}
              className={`${inputClass} w-64`}
            />
          </label>
        </details>
      </form>
      <p className="mt-2 text-xs text-muted">{hint}</p>
    </Panel>
  );
}
