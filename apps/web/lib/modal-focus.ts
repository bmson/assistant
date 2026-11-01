/** Only wrap the boundary of an already-open native modal; middle Tab stays native. */
type ModalTabEvent = {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
  nativeEvent?: { isComposing?: boolean };
  isComposing?: boolean;
  currentTarget: HTMLDialogElement;
  target: EventTarget | null;
  preventDefault(): void;
};

const selector =
  'a[href],area[href],button,input,select,textarea,iframe,audio[controls],video[controls],summary,[contenteditable]:not([contenteditable="false"]),[tabindex]';

function tabbableControls(dialog: HTMLDialogElement): HTMLElement[] {
  const controls = [...dialog.querySelectorAll<HTMLElement>(selector)].filter((control) => {
    const visibility = dialog.ownerDocument.defaultView?.getComputedStyle(control).visibility;
    return (
      control.tabIndex >= 0 &&
      !control.matches(':disabled') &&
      !control.closest('[hidden],[inert]') &&
      control.getClientRects().length > 0 &&
      visibility !== 'hidden' &&
      visibility !== 'collapse'
    );
  });
  // Native Tab visits one enabled radio per named/form group, not every input.
  const stops = controls.filter((control) => {
    if (control.tagName !== 'INPUT' || control.getAttribute('type')?.toLowerCase() !== 'radio')
      return true;
    const radio = control as HTMLInputElement;
    if (!radio.name) return true;
    const group = controls.filter(
      (candidate) =>
        candidate.tagName === 'INPUT' &&
        candidate.getAttribute('type')?.toLowerCase() === 'radio' &&
        (candidate as HTMLInputElement).name === radio.name &&
        (candidate as HTMLInputElement).form === radio.form,
    ) as HTMLInputElement[];
    return radio === (group.find((candidate) => candidate.checked) ?? group[0]);
  });
  // Positive tabindex precedes ordinary DOM-order stops, as in native navigation.
  return stops.sort((left, right) => {
    const a = left.tabIndex > 0 ? left.tabIndex : Number.POSITIVE_INFINITY;
    const b = right.tabIndex > 0 ? right.tabIndex : Number.POSITIVE_INFINITY;
    return a === b ? 0 : a - b;
  });
}

export function containModalBoundaryTab(event: ModalTabEvent): void {
  const dialog = event.currentTarget;
  if (
    event.key !== 'Tab' ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.isComposing ||
    event.nativeEvent?.isComposing ||
    event.defaultPrevented ||
    !dialog.open ||
    !dialog.matches(':modal')
  )
    return;
  const eventDialog = (event.target as Element | null)?.closest?.('dialog');
  if (eventDialog && eventDialog !== dialog) return;
  const active = dialog.ownerDocument.activeElement;
  if (!active || !dialog.contains(active)) return; // Never pull focus from elsewhere.
  const controls = tabbableControls(dialog); // Busy/dynamic controls are re-read for each key.
  const first = controls[0];
  const last = controls.at(-1);
  if (!first || !last) {
    event.preventDefault();
    dialog.focus();
  } else if (event.shiftKey ? active === first : active === last) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}
