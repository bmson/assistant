'use client';

import { Check, LoaderCircle } from 'lucide-react';
import type { ReactNode, ToggleEvent } from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { btn, btnSm } from './ui';

type BtnVariant = keyof typeof btn;

// Size the button by choosing the scale here — never by passing btnSm.* through
// className (that stacks h-9 and h-8 utilities on one element and the winner is
// stylesheet order, not intent). 'md' is the default; 'sm' is for list rows.
const btnScale = { md: btn, sm: btnSm } as const;

/**
 * A server-action submit button that disables itself and shows a pending label
 * while the action runs (via useFormStatus) — so the plain-form buttons that
 * used to be silently double-submittable now give feedback. Drop into any
 * <form action={serverAction}>.
 */
export function SubmitButton({
  children,
  pendingLabel = 'Working…',
  variant = 'outline',
  size = 'md',
  className = '',
  title,
  disabled = false,
}: {
  children: ReactNode;
  pendingLabel?: string;
  variant?: BtnVariant;
  size?: 'md' | 'sm';
  className?: string;
  title?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      aria-busy={pending}
      title={title}
      className={`${btnScale[size][variant]} ${className}`}
    >
      <StableLabel pending={pending} pendingLabel={pendingLabel}>
        {children}
      </StableLabel>
    </button>
  );
}

/**
 * The resting label and the pending label share one grid cell, so the button
 * is always as wide as the longer of the two and never resizes — or shoves its
 * neighbours sideways — while an action is in flight.
 */
function StableLabel({
  children,
  pending,
  pendingLabel,
}: {
  children: ReactNode;
  pending: boolean;
  pendingLabel: ReactNode;
}) {
  return (
    <span className="grid min-w-0 max-w-full grid-cols-[minmax(0,1fr)] items-center justify-items-center">
      <span
        className="invisible col-start-1 row-start-1 flex min-w-0 max-w-full flex-wrap items-center justify-center gap-2 [overflow-wrap:break-word]"
        aria-hidden="true"
      >
        {children}
      </span>
      <span
        className="invisible col-start-1 row-start-1 flex min-w-0 max-w-full flex-wrap items-center justify-center gap-2 [overflow-wrap:break-word]"
        aria-hidden="true"
      >
        <LoaderCircle />
        {pendingLabel}
      </span>
      <span className="col-start-1 row-start-1 flex min-w-0 max-w-full flex-wrap items-center justify-center gap-2 [overflow-wrap:break-word]">
        {pending ? (
          <>
            <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />
            {pendingLabel}
          </>
        ) : (
          children
        )}
      </span>
    </span>
  );
}

/**
 * A click-handler button with the app's one in-flight treatment: disabled,
 * `aria-busy`, a spinner, and a present-participle label ("Approving…"). Use it
 * wherever a button runs a transition or a server call directly; inside a
 * `<form action>` use <SubmitButton>, which reads the form's own status.
 */
export function ActionButton({
  children,
  pending = false,
  pendingLabel = 'Working…',
  variant = 'outline',
  size = 'md',
  className = '',
  title,
  disabled = false,
  onClick,
  'aria-label': ariaLabel,
}: {
  children: ReactNode;
  pending?: boolean;
  pendingLabel?: ReactNode;
  variant?: BtnVariant;
  size?: 'md' | 'sm';
  className?: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      disabled={pending || disabled}
      aria-busy={pending}
      aria-label={ariaLabel}
      title={title}
      onClick={onClick}
      className={`${btnScale[size][variant]} ${className}`}
    >
      <StableLabel pending={pending} pendingLabel={pendingLabel}>
        {children}
      </StableLabel>
    </button>
  );
}

/**
 * A dropdown of secondary actions behind a trigger button. The panel is a
 * native `popover`, so it renders in the top layer — it can never be clipped
 * by an `overflow-hidden` card shell — and light-dismiss (outside click,
 * Escape) comes from the platform. Placement is viewport-aware: the panel
 * opens downward and flips above the trigger when the fold would cut it off.
 *
 * Clicking a link or an element marked `data-menu-close` closes the panel;
 * everything else (submit buttons, two-step confirms) keeps it open so
 * pending labels and arm states stay visible until the action lands.
 */
export function ActionMenu({
  label = 'More',
  trigger,
  triggerClassName,
  triggerTitle,
  variant = 'outline',
  size = 'md',
  panelClassName = 'w-56',
  className = '',
  children,
}: {
  label?: ReactNode;
  /** Replaces `label` inside the trigger button — for callers that need the
      trigger to look like something other than a standard button (e.g. a nav
      tile). Pairs with `triggerClassName`. */
  trigger?: ReactNode;
  /** Full className override for the trigger button; `label`/btnScale styling
      applies only when this is omitted. */
  triggerClassName?: string;
  triggerTitle?: string;
  variant?: BtnVariant;
  size?: 'md' | 'sm';
  /** Sizing/extra classes for the panel; keep a width here so placement can measure. */
  panelClassName?: string;
  className?: string;
  children: ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const panelId = useId();
  const triggerId = useId();
  const [open, setOpen] = useState(false);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel?.matches(':popover-open')) return;
    const edge = 8;
    const rect = trigger.getBoundingClientRect();
    const fitsBelow = window.innerHeight - rect.bottom >= panel.offsetHeight + edge * 2;
    const flipUp = !fitsBelow && rect.top >= panel.offsetHeight + edge * 2;
    const preferredTop = flipUp ? rect.top - panel.offsetHeight - edge : rect.bottom + edge;
    panel.style.top = `${Math.max(edge, Math.min(preferredTop, window.innerHeight - panel.offsetHeight - edge))}px`;
    panel.style.left = `${Math.max(
      edge,
      Math.min(rect.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - edge),
    )}px`;
  }, []);

  // The trigger can move under an open panel (window resize, any scroll).
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        id={triggerId}
        popoverTarget={panelId}
        aria-controls={panelId}
        aria-expanded={open}
        title={triggerTitle}
        className={triggerClassName ?? `${btnScale[size][variant]} ${className}`}
        onClick={() => {
          // The native invoker owns focus restoration and logical tab order.
          // Position after its default toggle and before the next paint.
          requestAnimationFrame(place);
        }}
      >
        {trigger ?? label}
      </button>
      {/* Click delegation, not an interactive element itself: menu items are real
          buttons/links (keyboard-activatable), and Escape closes via the popover. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Enter on items fires click; Escape is native */}
      <section
        ref={panelRef}
        id={panelId}
        aria-labelledby={triggerId}
        popover="auto"
        onToggle={(event: ToggleEvent<HTMLElement>) => {
          const isOpen = event.newState === 'open';
          setOpen(isOpen);
          if (isOpen) place();
        }}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a, [data-menu-close]')) {
            panelRef.current?.hidePopover();
          }
        }}
        // Open/close motion lives in globals.css on [popover] — a keyframe here
        // would only play on enter and would fight the exit transition.
        className={`scroll-subtle fixed inset-auto z-50 m-0 max-h-[min(24rem,calc(100vh-1rem))] max-w-[calc(100vw-1rem)] flex-col gap-1 overflow-y-auto rounded-xl border border-edge bg-raised p-1.5 shadow-[var(--shadow-overlay)] [&:popover-open]:flex ${panelClassName}`}
      >
        {children}
      </section>
    </>
  );
}

/** How long an armed confirmation waits for its second tap — the iOS app's
 *  `AssistantConfirmationState.lifetime` is the same eight seconds. */
const CONFIRM_WINDOW_MS = 8000;

/**
 * Two activations of the same control, with a visible, expiring confirmation.
 *
 * This is the app's one "are you sure?" — every decision that acts on the
 * owner's behalf (Approve, Deny) and every destructive action (Reject, Forget,
 * Delete, Stop task) goes through it, so asking twice looks and times out the
 * same everywhere. It used to be joined by a 3-second hook in the budget card
 * and by hand-rolled "Really reject" + "Cancel" pairs that swapped the button
 * row out from under the pointer.
 *
 * Arming never moves anything: every label the button can show reserves the
 * same cell. A destructive variant fills red while armed; any other variant
 * picks up an accent ring, so the second tap is always visibly different.
 */
export function ConfirmButton({
  children,
  confirmLabel = 'Confirm?',
  pendingLabel = 'Working…',
  pending: pendingProp = false,
  variant = 'dangerOutline',
  size = 'md',
  className = '',
  title,
  disabled = false,
  onConfirm,
  'aria-label': ariaLabel,
}: {
  children: ReactNode;
  confirmLabel?: string;
  pendingLabel?: string;
  /** In-flight state for `onConfirm` callers; form callers get it from the form. */
  pending?: boolean;
  variant?: BtnVariant;
  size?: 'md' | 'sm';
  className?: string;
  title?: string;
  disabled?: boolean;
  onConfirm?: () => void;
  'aria-label'?: string;
}) {
  const formStatus = useFormStatus();
  const pending = formStatus.pending || pendingProp;
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const armed = expiresAt !== null;
  const unavailable = pending || disabled;
  const danger = variant === 'dangerOutline' || variant === 'danger';
  const armedRing = armed && !danger ? 'ring-2 ring-accent/40' : '';
  const base = `${btnScale[size][armed && danger ? 'danger' : variant]} ${armedRing} ${className}`;

  useEffect(() => {
    if (!expiresAt) return;
    const reset = () => setExpiresAt(null);
    const timer = window.setTimeout(reset, Math.max(0, expiresAt - Date.now()));
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
    };
  }, [expiresAt]);
  useEffect(() => {
    if (unavailable) setExpiresAt(null);
  }, [unavailable]);

  const reserve = 'invisible col-start-1 row-start-1 inline-flex items-center gap-2';
  return (
    <button
      type="button"
      disabled={unavailable}
      aria-busy={pending}
      aria-label={ariaLabel && !armed && !pending ? ariaLabel : undefined}
      title={title}
      onBlur={() => setExpiresAt(null)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setExpiresAt(null);
      }}
      onClick={(event) => {
        if (!expiresAt || Date.now() >= expiresAt) {
          event.preventDefault();
          setExpiresAt(Date.now() + CONFIRM_WINDOW_MS);
          return;
        }
        setExpiresAt(null);
        if (onConfirm) onConfirm();
        else event.currentTarget.form?.requestSubmit();
      }}
      className={base}
    >
      {/* Reserve every label so the confirmation stays under the pointer. */}
      <span className="grid items-center justify-items-center">
        <span className={reserve} aria-hidden="true">
          {children}
        </span>
        <span className={reserve} aria-hidden="true">
          <Check />
          {confirmLabel}
        </span>
        <span className={reserve} aria-hidden="true">
          <LoaderCircle />
          {pendingLabel}
        </span>
        <span className="col-start-1 row-start-1 inline-flex items-center gap-2" aria-live="polite">
          {pending ? (
            <>
              <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />
              {pendingLabel}
            </>
          ) : armed ? (
            <>
              <Check aria-hidden="true" />
              {confirmLabel}
            </>
          ) : (
            children
          )}
        </span>
      </span>
    </button>
  );
}

/**
 * A modal in the browser's top layer.
 *
 * An overlay nested inside a card cannot escape it with `position: fixed`:
 * every `cardShellClass` carries `.reveal`, whose view-timeline animation
 * targets `transform`, and an element with an active transform animation is
 * the containing block for its fixed descendants. `overflow-hidden` on the
 * same shell then clips what is left, so the panel opened *inside* the card,
 * at card size, instead of over the window. A native `<dialog>` opened with
 * `showModal()` sidesteps both — the top layer is positioned against the
 * viewport whatever its ancestors do — and brings Escape-to-close, focus
 * containment, and an inert background with it.
 *
 * The dialog element itself is the full-viewport scrim; `panelClassName` sizes
 * and spaces the card inside it, a bottom sheet on a phone and centred from
 * `sm` up.
 */
export function Modal({
  label,
  onClose,
  panelClassName = 'max-w-2xl gap-4',
  dismissible = true,
  children,
}: {
  /** Accessible name for the dialog, since the heading lives in `children`. */
  label: string;
  onClose: () => void;
  /** Pending writes may keep the dialog open until the authoritative result arrives. */
  dismissible?: boolean;
  /** Width and internal spacing for the panel; the shell styling is fixed. */
  panelClassName?: string;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Light dismiss only when the press *started* on the scrim: a drag that
  // selects text in the panel and releases outside it is not a dismissal.
  const pressedScrim = useRef(false);

  // Mount-time open: the caller renders <Modal> only while it should be shown,
  // so there is no open prop to track. `hidden open:grid` keeps the frame
  // before this effect from flashing a scrim that is not in the top layer yet.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  const outside = (target: EventTarget | null) => !panelRef.current?.contains(target as Node);

  return (
    // The click is light dismiss, not an interactive element: the keyboard
    // equivalent is Escape, which the dialog already handles natively.
    // biome-ignore lint/a11y/useKeyWithClickEvents: see above
    <dialog
      ref={dialogRef}
      aria-label={label}
      onCancel={(event) => {
        if (!dismissible) event.preventDefault();
      }}
      onClose={() => {
        // `close` is fired from a queued task, so the one Strict Mode's
        // mount/unmount/mount provokes arrives *after* the remount reopened
        // the dialog. A dialog still open here never really closed.
        if (!dialogRef.current?.open) onClose();
      }}
      onMouseDown={(event) => {
        pressedScrim.current = outside(event.target);
      }}
      onClick={(event) => {
        // Testing containment rather than `target === dialog` keeps a native
        // select's option list — which reports the select as its target while
        // painting outside the panel — from closing the form.
        if (dismissible && pressedScrim.current && outside(event.target)) onClose();
      }}
      className="fixed inset-0 m-0 hidden h-full max-h-none w-full max-w-none place-items-end border-0 bg-transparent p-0 backdrop:bg-strong/25 open:grid sm:place-items-center sm:p-6"
    >
      <div
        ref={panelRef}
        className={`grid max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl bg-raised p-5 shadow-[var(--shadow-overlay)] sm:rounded-2xl sm:p-6 ${panelClassName}`}
      >
        {children}
      </div>
    </dialog>
  );
}
