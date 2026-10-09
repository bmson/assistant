'use client';

import { Plus } from 'lucide-react';
import { useRef, useState, useTransition } from 'react';
import { createMemoryAction } from '@/app/profile/actions';
import { btn, btnSm, labelClass, selectClass, textareaClass } from '@/lib/ui';

const TOPICS: Array<{ value: string; label: string }> = [
  { value: 'identity', label: 'Identity' },
  { value: 'work', label: 'Work' },
  { value: 'home', label: 'Home' },
  { value: 'relationships', label: 'Relationships' },
  { value: 'preferences', label: 'Preferences' },
  { value: 'health', label: 'Health' },
  { value: 'other', label: 'Other' },
];

/**
 * Owner-driven "add a fact" about a specific subject (the owner, or a person).
 * `subjectLabel` is only cosmetic — it names who the fact is about in the CTA.
 */
export function AddFact({
  subjectContactId,
  subjectLabel,
  defaultDomain = 'other',
}: {
  subjectContactId: string;
  subjectLabel: string;
  defaultDomain?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({
    content: '',
    domain: defaultDomain,
    importance: '3',
    pinned: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const submitting = useRef(false);

  if (!open) {
    return (
      // btnBase is shrink-0 with no max-width, so a long subject name makes the
      // button wider than the viewport rather than wrapping. max-w-full lets
      // btnBase's whitespace-normal actually do its job.
      <button type="button" onClick={() => setOpen(true)} className={`${btnSm.outline} max-w-full`}>
        <Plus className="size-3.5 shrink-0" aria-hidden="true" />
        Add a fact about {subjectLabel}
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
            const result = await createMemoryAction({
              content: String(formData.get('content') ?? ''),
              domain: String(formData.get('domain') ?? 'other'),
              importance: String(formData.get('importance') ?? '3'),
              pinned: formData.get('pinned') === 'on',
              subjectContactId,
            });
            if (result.error) setError(result.error);
            else {
              setOpen(false);
              setDraft({ content: '', domain: defaultDomain, importance: '3', pinned: false });
            }
          } catch {
            setError('The fact could not be saved. Your draft is kept here.');
          } finally {
            submitting.current = false;
          }
        })
      }
    >
      <label className={`flex flex-col gap-1 ${labelClass}`}>
        Fact about {subjectLabel}
        <textarea
          name="content"
          disabled={pending}
          value={draft.content}
          onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
          required
          rows={2}
          minLength={3}
          maxLength={2000}
          placeholder={`Something durable about ${subjectLabel}…`}
          className={textareaClass}
        />
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <label className={`flex flex-col gap-1 ${labelClass}`}>
          Topic
          <select
            name="domain"
            disabled={pending}
            value={draft.domain}
            onChange={(event) =>
              setDraft((current) => ({ ...current, domain: event.target.value }))
            }
            className={selectClass}
          >
            {TOPICS.map((topic) => (
              <option key={topic.value} value={topic.value}>
                {topic.label}
              </option>
            ))}
          </select>
        </label>
        <label className={`flex flex-col gap-1 ${labelClass}`}>
          Importance
          <select
            name="importance"
            disabled={pending}
            value={draft.importance}
            onChange={(event) =>
              setDraft((current) => ({ ...current, importance: event.target.value }))
            }
            className={selectClass}
          >
            <option value="5">Very high</option>
            <option value="4">High</option>
            <option value="3">Normal</option>
            <option value="2">Low</option>
            <option value="1">Minor</option>
          </select>
        </label>
        <label className="mobile-touch-target flex items-center gap-2 text-sm font-medium text-muted">
          {/* Tick colour comes from the global accent-color token (globals.css). */}
          <input
            name="pinned"
            type="checkbox"
            disabled={pending}
            checked={draft.pinned}
            onChange={(event) =>
              setDraft((current) => ({ ...current, pinned: event.target.checked }))
            }
            className="size-4"
          />
          Keep in profile summary
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" disabled={pending} className={btn.primary}>
          {pending ? 'Saving…' : 'Save fact'}
        </button>
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
