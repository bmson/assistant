'use client';

import { Lightbulb } from 'lucide-react';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import {
  addSkillAction,
  deleteSkillAction,
  editSkillAction,
  toggleSkillDeprecatedAction,
} from '@/app/skills/actions';
import {
  Badge,
  btn,
  cardBodyClass,
  cardFooterClass,
  cardHeaderClass,
  cardShellClass,
  cardTitleClass,
  EmptyState,
  labelClass,
  MetaLine,
  inputClass as sharedInputClass,
  textareaClass,
} from '@/lib/ui';
import { ConfirmButton } from '@/lib/ui-client';

export interface SkillView {
  id: string;
  name: string;
  preconditions: string;
  steps: string;
  gotchas: string;
  ownerAuthored: boolean;
  deprecated: boolean;
  useCount: number;
  successCount: number;
  failureCount: number;
  createdLabel: string;
}

const inputClass = `${sharedInputClass} w-full`;

export function SkillForm({
  initial,
  submitting,
  onSubmit,
  onCancel,
  error,
}: {
  initial?: Partial<SkillView>;
  submitting: boolean;
  onSubmit: (fd: FormData) => void;
  onCancel?: () => void;
  error?: string | null;
}) {
  const formId = useId();
  const [draft, setDraft] = useState({
    name: initial?.name ?? '',
    preconditions: initial?.preconditions ?? '',
    steps: initial?.steps ?? '',
    gotchas: initial?.gotchas ?? '',
  });
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameInput.current?.focus();
  }, []);
  return (
    <form
      action={onSubmit}
      className="flex min-w-0 flex-col gap-4"
      aria-describedby={error ? `${formId}-error` : undefined}
    >
      <label className="flex flex-col gap-1.5" htmlFor={`${formId}-name`}>
        <span className={labelClass}>Skill name</span>
        <input
          id={`${formId}-name`}
          ref={nameInput}
          name="name"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          placeholder="For example, plan a weekend away"
          required
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1.5" htmlFor={`${formId}-preconditions`}>
        <span className={labelClass}>When to use it (optional)</span>
        <input
          id={`${formId}-preconditions`}
          name="preconditions"
          value={draft.preconditions}
          onChange={(event) => setDraft({ ...draft, preconditions: event.target.value })}
          placeholder="Describe the request or situation"
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1.5" htmlFor={`${formId}-steps`}>
        <span className={labelClass}>Steps</span>
        <textarea
          id={`${formId}-steps`}
          name="steps"
          value={draft.steps}
          onChange={(event) => setDraft({ ...draft, steps: event.target.value })}
          placeholder="Describe the procedure in plain language"
          required
          rows={3}
          className={`${textareaClass} w-full`}
        />
      </label>
      <label className="flex flex-col gap-1.5" htmlFor={`${formId}-gotchas`}>
        <span className={labelClass}>Watch for (optional)</span>
        <input
          id={`${formId}-gotchas`}
          name="gotchas"
          value={draft.gotchas}
          onChange={(event) => setDraft({ ...draft, gotchas: event.target.value })}
          placeholder="Exceptions or things to avoid"
          className={inputClass}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={submitting} className={btn.primary}>
          {submitting ? 'Saving…' : 'Save skill'}
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel} className={btn.outline}>
            Cancel
          </button>
        ) : null}
      </div>
      {error ? (
        <p id={`${formId}-error`} role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function SkillsPanel({
  skills,
  readOnly = false,
}: {
  skills: SkillView[];
  readOnly?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A skill is owner-authored prose; deleting it is not recoverable. Two-step
  // like every other destructive control (documents, memory, stop goal).
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fields = (fd: FormData) => ({
    name: String(fd.get('name') ?? ''),
    preconditions: String(fd.get('preconditions') ?? ''),
    steps: String(fd.get('steps') ?? ''),
    gotchas: String(fd.get('gotchas') ?? ''),
  });

  return (
    <section aria-label="Skills collection" className="mt-8">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted tabular-nums">
          {skills.length} {skills.length === 1 ? 'skill' : 'skills'}
        </p>
        {!readOnly && !adding ? (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setError(null);
            }}
            className={btn.outline}
          >
            Add skill
          </button>
        ) : null}
      </div>

      {!readOnly && adding ? (
        <div className={`${cardShellClass} mt-3 p-4`}>
          <SkillForm
            submitting={pending}
            error={error}
            onCancel={() => {
              setAdding(false);
              setError(null);
            }}
            onSubmit={(fd) =>
              startTransition(async () => {
                setError(null);
                try {
                  const result = await addSkillAction(fields(fd));
                  if (result.error) setError(result.error);
                  else setAdding(false);
                } catch {
                  setError('The skill could not be saved. Your changes are still here; try again.');
                }
              })
            }
          />
        </div>
      ) : null}

      {skills.length === 0 && !adding ? (
        <EmptyState icon={<Lightbulb className="size-5" aria-hidden="true" />}>
          {readOnly
            ? 'No skills yet — the assistant drafts these from tasks it solves a non-obvious way.'
            : 'No skills yet — the assistant drafts these from tasks it solves a non-obvious way, and you can add your own.'}
        </EmptyState>
      ) : (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {skills.map((s) => (
            <article key={s.id} className={`${cardShellClass} flex h-full flex-col`}>
              {!readOnly && editingId === s.id ? (
                <div className={cardBodyClass}>
                  <SkillForm
                    initial={s}
                    submitting={pending}
                    error={error}
                    onCancel={() => {
                      setEditingId(null);
                      setError(null);
                    }}
                    onSubmit={(fd) =>
                      startTransition(async () => {
                        setError(null);
                        try {
                          const result = await editSkillAction(s.id, fields(fd));
                          if (result.error) setError(result.error);
                          else setEditingId(null);
                        } catch {
                          setError(
                            'The skill could not be saved. Your changes are still here; try again.',
                          );
                        }
                      })
                    }
                  />
                </div>
              ) : (
                <>
                  <div className={`${cardBodyClass} flex-1`}>
                    <div className={cardHeaderClass}>
                      <div className="min-w-0">
                        <h3 className={cardTitleClass}>{s.name}</h3>
                        <p className="mt-0.5 text-xs text-muted">
                          {s.ownerAuthored ? 'Written by you' : 'Learned from completed work'}
                        </p>
                      </div>
                      {/* Active is the default state — badging every live
                          skill green was color spent on saying nothing. Only
                          the exception gets a label. */}
                      {s.deprecated ? <Badge tone="muted">Retired</Badge> : null}
                    </div>
                    <section>
                      <h4 className="text-sm font-medium text-muted">How it works</h4>
                      <p className="mt-1 text-sm leading-5 whitespace-pre-wrap text-strong">
                        {s.steps}
                      </p>
                    </section>
                    {s.preconditions || s.gotchas ? (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {s.preconditions ? (
                          <section className="rounded-xl bg-sunken/65 px-3 py-2.5">
                            <h4 className="text-xs font-medium text-muted">When to use it</h4>
                            <p className="mt-1 text-xs leading-5 text-strong">{s.preconditions}</p>
                          </section>
                        ) : null}
                        {s.gotchas ? (
                          <section className="rounded-xl bg-amber-50 px-3 py-2.5 dark:bg-amber-950/25">
                            <h4 className="text-xs font-medium text-amber-800 dark:text-amber-300">
                              Watch for
                            </h4>
                            <p className="mt-1 text-xs leading-5 text-amber-900 dark:text-amber-200">
                              {s.gotchas}
                            </p>
                          </section>
                        ) : null}
                      </div>
                    ) : null}
                    <MetaLine
                      className="tabular-nums"
                      segments={[
                        `Used ${s.useCount}×`,
                        `${s.successCount} succeeded`,
                        <span
                          key="failed"
                          className={
                            s.failureCount > 0 ? 'font-medium text-red-600 dark:text-red-400' : ''
                          }
                        >
                          {s.failureCount} failed
                        </span>,
                        s.createdLabel,
                      ]}
                    />
                  </div>
                  {!readOnly ? (
                    <footer className={cardFooterClass}>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(s.id);
                          setError(null);
                        }}
                        className={btn.outline}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            setError(null);
                            try {
                              await toggleSkillDeprecatedAction(s.id, !s.deprecated);
                            } catch {
                              setError('The skill could not be updated. Try again.');
                            }
                          })
                        }
                        className={btn.outline}
                      >
                        {s.deprecated ? 'Restore' : 'Retire'}
                      </button>
                      <ConfirmButton
                        disabled={pending && deletingId !== s.id}
                        pending={pending && deletingId === s.id}
                        pendingLabel="Deleting…"
                        confirmLabel="Delete?"
                        onConfirm={() => {
                          setDeletingId(s.id);
                          startTransition(async () => {
                            try {
                              await deleteSkillAction(s.id);
                            } catch {
                              setError('The skill could not be deleted. Try again.');
                            } finally {
                              setDeletingId(null);
                            }
                          });
                        }}
                      >
                        Delete
                      </ConfirmButton>
                    </footer>
                  ) : null}
                </>
              )}
            </article>
          ))}
        </div>
      )}
      {error && !adding && editingId === null ? (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </section>
  );
}
