'use client';

import { useTransition } from 'react';
import { purgeVoiceSamplesAction } from '@/app/profile/actions';
import { VoiceProfileForm } from '@/app/profile/voice-profile-form';
import {
  btn,
  CountBadge,
  cardBodyClass,
  cardFooterClass,
  cardShellClass,
  fileInputClass,
  MetaLine,
  selectClass,
} from '@/lib/ui';
import { ConfirmButton } from '@/lib/ui-client';

/** Plain-serializable view built in page.tsx. */
export interface VoiceImportView {
  source: string;
  status: string;
  itemsTotal: number | null;
  itemsProcessed: number;
  memoriesSaved: number;
  taskId: string | null;
  error: string | null;
}

const registerOptions: Array<{ value: string; label: string }> = [
  { value: 'email_casual', label: 'Casual email' },
  { value: 'email_professional', label: 'Professional email' },
  { value: 'sms', label: 'Text messages' },
  { value: 'chat', label: 'Chat' },
];

const statusLabels: Record<string, string> = {
  pending: 'Queued',
  running: 'Learning',
  done: 'Done',
  failed: 'Needs attention',
  purged: 'Removed',
};

/**
 * Voice-sample corpus controls: upload a batch of your own sent mail to teach
 * the assistant your writing style faster, see how many samples it has, and
 * clear the auto-captured + uploaded ones.
 */
export function VoiceSamplesPanel({
  total,
  auto,
  uploaded,
  imports,
  profile,
  readOnly = false,
  profileEditable = !readOnly,
  uploadable = !readOnly,
}: {
  total: number;
  auto: number;
  uploaded: number;
  imports: VoiceImportView[];
  profile: { description: string; dos: string[]; donts: string[]; signature: string };
  readOnly?: boolean;
  profileEditable?: boolean;
  uploadable?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const purgeable = auto + uploaded;

  return (
    <section aria-label="Writing voice samples and profile" className={`${cardShellClass} mt-6`}>
      <div className={cardBodyClass}>
        <div>
          <CountBadge>
            {total} {total === 1 ? 'sample' : 'samples'}
          </CountBadge>
          <p className="mt-1 text-xs leading-5 text-muted">
            Only your own sent messages are used; forwarded and quoted text is excluded.
          </p>
        </div>
        {/* The pill already carries the total — the breakdown is one quiet
            line, not a grid of three boxed figures. */}
        {total > 0 ? (
          <MetaLine
            segments={[
              `${auto.toLocaleString()} learned from your sent mail`,
              `${uploaded.toLocaleString()} uploaded`,
            ]}
          />
        ) : null}

        {/* The distilled profile the samples taught — owner-editable. */}
        <div className="rounded-xl bg-sunken/55 p-3">
          <p className="text-sm font-semibold text-strong">The voice it learned</p>
          <p className="mt-1 mb-3 text-xs leading-5 text-muted">
            {profileEditable
              ? 'What outbound drafts are rewritten to sound like. Re-ingesting samples rewrites this — make edits after an ingest.'
              : 'What outbound drafts are rewritten to sound like.'}
          </p>
          {profileEditable ? (
            <VoiceProfileForm initial={profile} />
          ) : (
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div className="sm:col-span-2">
                <dt className="text-muted">Description</dt>
                <dd>{profile.description || 'No description yet'}</dd>
              </div>
              <div>
                <dt className="text-muted">Use</dt>
                <dd>{profile.dos.length ? profile.dos.join(', ') : 'None'}</dd>
              </div>
              <div>
                <dt className="text-muted">Avoid</dt>
                <dd>{profile.donts.length ? profile.donts.join(', ') : 'None'}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-muted">Signature</dt>
                <dd className="whitespace-pre-wrap">{profile.signature || 'None'}</dd>
              </div>
            </dl>
          )}
        </div>

        {/* Upload */}
        {uploadable && (
          <form
            action="/api/import/upload"
            method="post"
            encType="multipart/form-data"
            className="grid gap-3 rounded-xl bg-sunken/55 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
          >
            <input type="hidden" name="voice" value="1" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-strong">Add sent messages</p>
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-3">
                <input
                  type="file"
                  name="file"
                  aria-label="Sent messages file"
                  required
                  accept=".mbox,.txt,.json,.md,text/plain,application/json"
                  className={fileInputClass}
                />
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  Style
                  <select name="register" defaultValue="email_casual" className={selectClass}>
                    {registerOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted">
                Gmail Takeout <code>.mbox</code>, plain text, or JSON · up to 25MB. Only your
                configured email address is used from archives; plain text is treated as writing you
                confirm is yours. Quoted and forwarded text is excluded.
              </p>
            </div>
            <button type="submit" className={btn.primary}>
              Upload sent mail
            </button>
          </form>
        )}

        {/* In-flight / failed voice imports */}
        {imports.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {imports.map((imp) => (
              <div key={imp.source} className="rounded-xl bg-sunken/55 px-3 py-2.5 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{statusLabels[imp.status] ?? imp.status}</span>
                  <span className="text-muted">
                    {imp.memoriesSaved} {imp.memoriesSaved === 1 ? 'sample' : 'samples'}
                  </span>
                </div>
                {imp.itemsTotal ? (
                  <p className="mt-1 text-muted">
                    {imp.itemsProcessed} of {imp.itemsTotal} messages
                  </p>
                ) : null}
                {imp.error ? (
                  <p className="mt-1 text-red-600 dark:text-red-400">{imp.error}</p>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* Purge */}
      {!readOnly && purgeable > 0 ? (
        <footer className={cardFooterClass}>
          <ConfirmButton
            pending={pending}
            pendingLabel="Clearing…"
            confirmLabel={`Clear ${purgeable} ${purgeable === 1 ? 'sample' : 'samples'}?`}
            onConfirm={() => startTransition(() => purgeVoiceSamplesAction())}
            title="Delete the auto-learned and uploaded samples; the distilled voice profile is kept"
          >
            Clear learned & uploaded samples
          </ConfirmButton>
        </footer>
      ) : null}
    </section>
  );
}
