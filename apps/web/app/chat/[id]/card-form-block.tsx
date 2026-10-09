'use client';

import type { CardForm, CardFormValues } from '@assistant/persistence/card-form';
import { useEffect, useRef, useState } from 'react';
import { focusRing } from '@/lib/ui';
import type { CardFormIdentity } from './card-form-operations';
import {
  formatDateInputValue,
  type NativeValueControl,
  nativeValueNeedsCaption,
} from './card-form-value-caption';

export interface CardFormBlockProps {
  form: CardForm;
  identity: CardFormIdentity | null;
  values: CardFormValues;
  warningFacts: Array<{ id: string; label: string; value: string }>;
  editable: boolean;
  staleDraft?: boolean;
  error?: string | null;
  lockedReason?: string | null;
  onChange?: (values: CardFormValues) => void;
  onReview?: (values: CardFormValues) => void;
  onCarry?: () => void;
  onDiscard?: () => void;
}

export function CardFormBlock({
  form,
  identity,
  values,
  warningFacts,
  editable,
  staleDraft = false,
  error,
  lockedReason,
  onChange,
  onReview,
  onCarry,
  onDiscard,
}: CardFormBlockProps) {
  const prefix = identity
    ? `form-${identity.cardId}-${identity.revisionId}-${form.id}`
    : `form-unavailable-${form.id}`;
  const sectionRef = useRef<HTMLElement>(null);
  const [captionFields, setCaptionFields] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    let disposed = false;
    let frame = 0;
    const fields = new Map(form.fields.map((field) => [field.id, field]));
    const measure = () => {
      const next = new Set<string>();
      const controls = section.querySelectorAll<NativeValueControl>('[data-value-caption-field]');
      for (const control of controls) {
        const id = control.dataset.valueCaptionField;
        const field = id ? fields.get(id) : undefined;
        const value = id ? values[id] : undefined;
        if (
          !id ||
          typeof value !== 'string' ||
          !field ||
          (field.type !== 'date' && field.type !== 'choice')
        )
          continue;
        const displayValue =
          field.type === 'date'
            ? formatDateInputValue(value, navigator.language)
            : (field.options.find((option) => option.id === value)?.label ?? null);
        if (displayValue && nativeValueNeedsCaption(control, displayValue, field.type))
          next.add(id);
      }
      if (!disposed) {
        setCaptionFields((current) =>
          current.size === next.size && [...current].every((id) => next.has(id)) ? current : next,
        );
      }
    };
    const scheduleMeasure = () => {
      if (disposed) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!disposed) measure();
      });
    };
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasure);
    section
      .querySelectorAll<NativeValueControl>('[data-value-caption-field]')
      .forEach((control) => {
        observer?.observe(control);
      });
    window.addEventListener('resize', scheduleMeasure);
    document.fonts?.addEventListener('loadingdone', scheduleMeasure);
    void document.fonts?.ready.then(() => {
      if (!disposed) scheduleMeasure();
    });
    scheduleMeasure();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
      document.fonts?.removeEventListener('loadingdone', scheduleMeasure);
    };
  }, [form.fields, values]);
  const setValue = (id: string, value: string | boolean) => {
    onChange?.({ ...values, [id]: value });
  };

  return (
    <section ref={sectionRef} aria-labelledby={`${prefix}-title`} className="grid min-w-0 gap-3">
      <div className="grid gap-1">
        <h4 id={`${prefix}-title`} className="text-sm font-semibold text-strong">
          {form.title}
        </h4>
        <p className="text-sm text-muted">Review your answers in the message before sending.</p>
      </div>
      {warningFacts.length > 0 ? (
        <aside
          aria-label="Please check"
          className="grid gap-1 border-l-2 border-amber-500/60 pl-3 text-sm"
        >
          {warningFacts.map((fact) => (
            <p key={fact.id} className="break-words text-strong [overflow-wrap:anywhere]">
              <span className="font-medium">{fact.label}: </span>
              {fact.value}
            </p>
          ))}
        </aside>
      ) : null}
      <fieldset disabled={!editable} className="grid min-w-0 gap-3">
        <legend className="sr-only">{form.title}</legend>
        {form.fields.map((field) => {
          const controlId = `${prefix}-${field.id}`;
          const value = values[field.id];
          return (
            <div key={field.id} className="grid min-w-0 gap-1">
              {field.type === 'boolean' ? (
                field.required ? (
                  <fieldset className="grid min-w-0 gap-1">
                    <legend className="text-sm font-medium text-strong">
                      {field.label}
                      <span aria-hidden="true"> *</span>
                    </legend>
                    <div
                      role="radiogroup"
                      aria-required="true"
                      aria-label={field.label}
                      className="flex min-w-0 flex-wrap items-center gap-4 text-sm text-strong"
                    >
                      {[true, false].map((answer) => (
                        <label
                          key={String(answer)}
                          className="inline-flex min-h-11 items-center gap-2"
                        >
                          <input
                            type="radio"
                            name={`${prefix}-${field.id}`}
                            value={String(answer)}
                            required
                            checked={value === answer}
                            onChange={() => setValue(field.id, answer)}
                            className={`size-4 shrink-0 accent-[var(--accent)] ${focusRing}`}
                          />
                          {answer ? 'Yes' : 'No'}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ) : (
                  <label
                    htmlFor={controlId}
                    className="flex min-h-11 min-w-0 items-center gap-3 text-sm text-strong"
                  >
                    <input
                      id={controlId}
                      type="checkbox"
                      checked={value === true}
                      onChange={(event) => setValue(field.id, event.currentTarget.checked)}
                      className={`size-4 shrink-0 accent-[var(--accent)] ${focusRing}`}
                    />
                    <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                      {field.label}
                    </span>
                  </label>
                )
              ) : (
                <>
                  <label htmlFor={controlId} className="text-sm font-medium text-strong">
                    {field.label}
                    {field.required ? <span aria-hidden="true"> *</span> : null}
                  </label>
                  {field.type === 'choice' ? (
                    <>
                      <select
                        id={controlId}
                        required={field.required}
                        value={typeof value === 'string' ? value : ''}
                        data-value-caption-field={field.id}
                        aria-describedby={
                          captionFields.has(field.id) ? `${controlId}-selected-value` : undefined
                        }
                        onChange={(event) => setValue(field.id, event.currentTarget.value)}
                        className={`min-h-11 w-full min-w-0 rounded-lg border border-edge bg-paper px-3 py-2 text-sm text-strong ${focusRing}`}
                      >
                        <option value="">Choose an answer</option>
                        {field.options.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      {captionFields.has(field.id) && typeof value === 'string' ? (
                        <p
                          id={`${controlId}-selected-value`}
                          className="text-sm leading-5 text-muted break-words [overflow-wrap:anywhere]"
                        >
                          Selected:{' '}
                          {field.options.find((option) => option.id === value)?.label ?? value}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <input
                        id={controlId}
                        type={field.type === 'date' ? 'date' : 'text'}
                        required={field.required}
                        maxLength={500}
                        value={typeof value === 'string' ? value : ''}
                        data-value-caption-field={field.type === 'date' ? field.id : undefined}
                        aria-describedby={
                          field.type === 'date' && captionFields.has(field.id)
                            ? `${controlId}-selected-value`
                            : undefined
                        }
                        onChange={(event) => setValue(field.id, event.currentTarget.value)}
                        className={`min-h-11 w-full min-w-0 rounded-lg border border-edge bg-paper px-3 py-2 text-sm text-strong ${focusRing} ${field.type === 'date' ? 'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent' : ''}`}
                      />
                      {field.type === 'date' &&
                      captionFields.has(field.id) &&
                      typeof value === 'string' ? (
                        <p
                          id={`${controlId}-selected-value`}
                          className="text-sm leading-5 text-muted break-words [overflow-wrap:anywhere]"
                        >
                          Selected date:{' '}
                          {formatDateInputValue(
                            value,
                            typeof navigator === 'undefined' ? undefined : navigator.language,
                          ) ?? value}
                        </p>
                      ) : null}
                    </>
                  )}
                </>
              )}
            </div>
          );
        })}
      </fieldset>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {lockedReason ? (
        <p role="status" className="text-sm text-muted">
          {lockedReason}
        </p>
      ) : null}
      {staleDraft ? (
        <div className="grid gap-2">
          <p role="status" className="text-sm text-muted">
            This card has a newer version. Carry compatible answers forward or clear the saved draft
            before using it.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {onCarry ? (
              <button
                type="button"
                onClick={onCarry}
                className={`mobile-touch-target min-h-11 w-fit rounded-lg border border-edge px-3 py-2 text-sm font-medium text-strong hover:bg-sunken ${focusRing}`}
              >
                Carry compatible answers
              </button>
            ) : null}
            {onDiscard ? (
              <button
                type="button"
                onClick={onDiscard}
                className={`mobile-touch-target min-h-11 px-2 text-sm text-muted underline underline-offset-2 ${focusRing}`}
              >
                Clear saved answers
              </button>
            ) : null}
          </div>
        </div>
      ) : onReview ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!editable}
            onClick={() => onReview(values)}
            className={`mobile-touch-target min-h-11 w-fit rounded-lg border border-edge px-3 py-2 text-sm font-medium text-strong hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`}
          >
            Review in message
          </button>
          {onDiscard ? (
            <button
              type="button"
              disabled={!editable}
              onClick={onDiscard}
              className={`mobile-touch-target min-h-11 px-2 text-sm text-muted underline underline-offset-2 disabled:cursor-not-allowed ${focusRing}`}
            >
              Clear answers
            </button>
          ) : null}
        </div>
      ) : (
        <p role="note" className="text-sm text-muted">
          This form is available to review, but cannot be filled in this chat view.
        </p>
      )}
    </section>
  );
}
