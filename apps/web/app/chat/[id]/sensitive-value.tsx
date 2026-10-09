'use client';

/*
 * A value the card holds back: a booking reference, a confirmation number, a
 * ticket code. It sits in the card masked and reveals on tap, so the card can
 * be read — or handed across a table — without the number in it.
 *
 * The mask is asterisks in the same monospace face, one per character of the
 * value, so revealing changes what the line says and not where anything on it
 * sits. Bullets in a proportional face reflowed the whole row on reveal, which
 * is what made the card look like it was rebuilding itself.
 */
import { useId } from 'react';
import { focusRing } from '@/lib/ui';

/**
 * What a screen reader is told this button does. Never the asterisks
 * themselves: announced character by character, a mask is noise, and it is not
 * what the control is for.
 */
function actionLabel(revealed: boolean, label: string): string {
  const name = label.trim().toLowerCase() || 'value';
  return `${revealed ? 'Hide' : 'Show'} ${name}`;
}

export function SensitiveValue({
  value,
  label,
  revealed,
  onToggle,
  className = '',
}: {
  value: string;
  /** The fact's own label ("Booking reference") — the button is named for it. */
  label: string;
  revealed: boolean;
  onToggle: () => void;
  /** Type scale from the block the value sits in; the face stays monospace. */
  className?: string;
}) {
  const action = actionLabel(revealed, label);
  const valueId = useId();
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={revealed}
        aria-label={action}
        aria-describedby={revealed ? valueId : undefined}
        title={action}
        className={`-mx-1 rounded px-1 text-left font-mono break-all motion-safe:transition-colors hover:bg-sunken/70 ${focusRing} ${className}`}
      >
        <span aria-hidden="true">{revealed ? value : '*'.repeat(value.length)}</span>
      </button>
      {revealed ? (
        <span id={valueId} className="sr-only" role="status">
          {value}
        </span>
      ) : null}
    </>
  );
}
