import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { containModalBoundaryTab } from './modal-focus';
import { Modal, NativeModalDialog } from './ui-client';

vi.mock('lucide-react', () => ({
  Check: () => null,
  LoaderCircle: () => null,
  ArrowLeft: () => null,
}));
vi.mock('next/link', () => ({ default: () => null }));

type Control = {
  tagName: string;
  tabIndex: number;
  disabled: boolean;
  hidden: boolean;
  inert: boolean;
  rendered: boolean;
  visibility: string;
  name: string;
  form: object | null;
  checked: boolean;
  type: string;
  focus: ReturnType<typeof vi.fn>;
  matches(selector: string): boolean;
  closest(selector: string): unknown;
  getAttribute(name: string): string | null;
  getClientRects(): object[];
};

/** Native geometry/navigation still needs browser proof; these fakes test the real handler's decisions. */
function fixture(options: Partial<Control>[] = [{}, {}]) {
  let open = true;
  let modal = true;
  const doc = {
    activeElement: null as unknown,
    defaultView: { getComputedStyle: (control: Control) => ({ visibility: control.visibility }) },
  };
  const controls: Control[] = [];
  const dialog = {
    get open() {
      return open;
    },
    ownerDocument: doc,
    matches: (selector: string) => selector === ':modal' && modal,
    querySelectorAll: () => controls,
    contains: (element: unknown) => element === dialog || controls.includes(element as Control),
    focus: vi.fn(() => {
      doc.activeElement = dialog;
    }),
    closest: () => dialog,
  };
  for (const option of options) {
    const control: Control = {
      tagName: 'BUTTON',
      tabIndex: 0,
      disabled: false,
      hidden: false,
      inert: false,
      rendered: true,
      visibility: 'visible',
      name: '',
      form: null,
      checked: false,
      type: '',
      focus: vi.fn(),
      matches: () => false,
      closest: () => null,
      getAttribute: () => null,
      getClientRects: () => [],
      ...option,
    };
    control.focus = vi.fn(() => {
      doc.activeElement = control;
    });
    control.matches = (selector) => selector === ':disabled' && control.disabled;
    control.closest = (selector) =>
      selector === 'dialog'
        ? dialog
        : selector === '[hidden],[inert]' && (control.hidden || control.inert)
          ? {}
          : null;
    control.getAttribute = (name) => (name === 'type' ? control.type : null);
    control.getClientRects = () => (control.rendered ? [{}] : []);
    controls.push(control);
  }
  doc.activeElement = controls[0] ?? dialog;
  const event = (changes: Partial<Parameters<typeof containModalBoundaryTab>[0]> = {}) => ({
    key: 'Tab',
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    defaultPrevented: false,
    nativeEvent: { isComposing: false },
    target: doc.activeElement as EventTarget,
    currentTarget: dialog as unknown as HTMLDialogElement,
    preventDefault: vi.fn(),
    ...changes,
  });
  return {
    controls,
    dialog,
    doc,
    event,
    activate: (value: unknown) => {
      doc.activeElement = value;
    },
    close: () => {
      open = false;
    },
    nonmodal: () => {
      modal = false;
    },
  };
}

describe('native Modal boundary Tab', () => {
  it('wraps last→first forward and first→last reverse without activating a control', () => {
    const f = fixture();
    f.activate(f.controls[1]);
    const forward = f.event();
    containModalBoundaryTab(forward);
    expect(forward.preventDefault).toHaveBeenCalledOnce();
    expect(f.controls[0]?.focus).toHaveBeenCalledOnce();
    const reverse = f.event({ shiftKey: true });
    containModalBoundaryTab(reverse);
    expect(reverse.preventDefault).toHaveBeenCalledOnce();
    expect(f.controls[1]?.focus).toHaveBeenCalledOnce();
  });
  it('leaves ordinary middle Tab navigation native', () => {
    const f = fixture([{}, {}, {}]);
    f.activate(f.controls[1]);
    for (const shiftKey of [false, true]) {
      const e = f.event({ shiftKey });
      containModalBoundaryTab(e);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(f.controls.every((control) => control.focus.mock.calls.length === 0)).toBe(true);
  });
  it('excludes disabled, hidden, inert, unrendered and CSS-invisible controls', () => {
    const f = fixture([
      { disabled: true },
      { hidden: true },
      { inert: true },
      { rendered: false },
      { visibility: 'hidden' },
      { visibility: 'collapse' },
      {},
      {},
    ]);
    f.activate(f.controls[7]);
    const e = f.event();
    containModalBoundaryTab(e);
    expect(f.doc.activeElement).toBe(f.controls[6]);
    expect(f.controls.slice(0, 6).every((control) => control.focus.mock.calls.length === 0)).toBe(
      true,
    );
  });
  it('recomputes candidates when busy/dynamic controls become disabled or are added', () => {
    const f = fixture();
    f.activate(f.controls[1]);
    if (f.controls[0]) f.controls[0].disabled = true;
    containModalBoundaryTab(f.event());
    expect(f.doc.activeElement).toBe(f.controls[1]);
    if (f.controls[0]) f.controls[0].disabled = false;
    containModalBoundaryTab(f.event());
    expect(f.doc.activeElement).toBe(f.controls[0]);
    const added = fixture([{}]).controls[0];
    if (!added) throw new Error('Missing test control');
    added.closest = (selector) => (selector === 'dialog' ? f.dialog : null);
    added.focus = vi.fn(() => f.activate(added));
    f.controls.push(added);
    f.activate(added);
    containModalBoundaryTab(f.event());
    expect(f.doc.activeElement).toBe(f.controls[0]);
  });
  it('uses positive tabindex order before ordinary DOM order', () => {
    const f = fixture([{ tabIndex: 0 }, { tabIndex: 3 }, { tabIndex: 1 }]);
    f.activate(f.controls[0]);
    containModalBoundaryTab(f.event());
    expect(f.doc.activeElement).toBe(f.controls[2]);
    containModalBoundaryTab(f.event({ shiftKey: true }));
    expect(f.doc.activeElement).toBe(f.controls[0]);
  });
  it('uses the checked radio in each named/form group as the Tab stop', () => {
    const form = {};
    const f = fixture([
      { tagName: 'INPUT', type: 'radio', name: 'choice', form },
      { tagName: 'INPUT', type: 'radio', name: 'choice', form, checked: true },
      {},
    ]);
    f.activate(f.controls[2]);
    containModalBoundaryTab(f.event());
    expect(f.doc.activeElement).toBe(f.controls[1]);
    containModalBoundaryTab(f.event({ shiftKey: true }));
    expect(f.doc.activeElement).toBe(f.controls[2]);
    expect(f.controls[0]?.focus).not.toHaveBeenCalled();
  });
  it('uses the first enabled radio when unchecked and keeps different forms separate', () => {
    const a = {},
      b = {};
    const f = fixture([
      { tagName: 'INPUT', type: 'radio', name: 'choice', form: a, disabled: true },
      { tagName: 'INPUT', type: 'radio', name: 'choice', form: a },
      { tagName: 'INPUT', type: 'radio', name: 'choice', form: b, checked: true },
    ]);
    f.activate(f.controls[2]);
    containModalBoundaryTab(f.event());
    expect(f.doc.activeElement).toBe(f.controls[1]);
  });
  it('handles zero and one enabled control with a programmatic-only dialog fallback', () => {
    const empty = fixture([]);
    const e = empty.event();
    containModalBoundaryTab(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(empty.dialog.focus).toHaveBeenCalledOnce();
    const one = fixture([{}]);
    containModalBoundaryTab(one.event());
    containModalBoundaryTab(one.event({ shiftKey: true }));
    expect(one.controls[0]?.focus).toHaveBeenCalledTimes(2);
  });
  it('ignores composition, handled events, non-Tab keys and Ctrl/Meta/Alt combinations', () => {
    const f = fixture();
    f.activate(f.controls[1]);
    for (const change of [
      { key: 'Enter' },
      { key: ' ' },
      { key: 'Escape' },
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { defaultPrevented: true },
      { isComposing: true },
      { nativeEvent: { isComposing: true } },
    ]) {
      const e = f.event(change);
      containModalBoundaryTab(e);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(f.controls.every((control) => control.focus.mock.calls.length === 0)).toBe(true);
  });
  it('does not steal focus from outside, closed/nonmodal or nested dialogs', () => {
    const f = fixture();
    f.activate({});
    const outside = f.event();
    containModalBoundaryTab(outside);
    expect(outside.preventDefault).not.toHaveBeenCalled();
    f.activate(f.controls[1]);
    f.close();
    const closed = f.event();
    containModalBoundaryTab(closed);
    expect(closed.preventDefault).not.toHaveBeenCalled();
    const other = fixture();
    other.nonmodal();
    const nonmodal = other.event();
    containModalBoundaryTab(nonmodal);
    expect(nonmodal.preventDefault).not.toHaveBeenCalled();
    const nested = fixture();
    nested.activate(nested.controls[1]);
    const e = nested.event({ target: { closest: () => ({}) } as unknown as EventTarget });
    containModalBoundaryTab(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
  it('binds the real component key handler and keeps native cancel behavior', () => {
    const markup = renderToStaticMarkup(
      <Modal label="Remove connection" dismissible={false} onClose={vi.fn()}>
        <button type="button">Cancel</button>
      </Modal>,
    );
    expect(markup).toContain('tabindex="-1"');
    const onCancel = vi.fn();
    const native = NativeModalDialog({ 'aria-label': 'Remove connection', onCancel });
    const props = native.props as Record<string, unknown>;
    expect(native.type).toBe('dialog');
    expect(props.tabIndex).toBe(-1);
    expect(props.onKeyDown).toBe(containModalBoundaryTab);
    const f = fixture();
    f.activate(f.controls[1]);
    const event = f.event();
    (props.onKeyDown as typeof containModalBoundaryTab)(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(f.doc.activeElement).toBe(f.controls[0]);
    expect(props.onCancel).toBe(onCancel);
  });
});
