import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { SavedNoteRecovery, savedNoteHasConflict } from './owner-memory-editor';

const props = {
  state: {
    message: 'The earlier save has no confirmed result yet.',
    phase: 'pending' as const,
    busy: false,
  },
  saved: false,
  awaitingReadback: false,
  sessionMatches: true,
  otherNote: null,
  canReconcile: false,
  reload: vi.fn(),
  check: vi.fn(),
  reconcile: vi.fn(),
};
describe('saved note dialog recovery content', () => {
  it('keeps pending result, check and disabled unbound resolve together in the dialog content', () => {
    const html = renderToStaticMarkup(
      <div role="dialog">
        <SavedNoteRecovery {...props} />
      </div>,
    );
    expect(html).toContain(props.state.message);
    expect(html).toContain('Check earlier save');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Resolve earlier save<\/button>/);
    expect(html).toContain('Closing this editor does not cancel a save.');
  });
  it('enables resolve only with binding proof and while idle', () => {
    const bound = renderToStaticMarkup(<SavedNoteRecovery {...props} canReconcile />);
    expect(bound).not.toMatch(/<button[^>]*disabled=""[^>]*>Resolve earlier save<\/button>/);
    const busy = renderToStaticMarkup(
      <SavedNoteRecovery {...props} canReconcile state={{ ...props.state, busy: true }} />,
    );
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*>Resolve earlier save<\/button>/);
  });
  it('shows saved refresh/readback state in modal content without a false conflict', () => {
    const html = renderToStaticMarkup(
      <div role="dialog">
        <SavedNoteRecovery
          {...props}
          saved
          awaitingReadback
          state={{ message: 'Saved.', phase: 'resolved', busy: false }}
        />
      </div>,
    );
    expect(html).toContain('Your correction is saved.');
    expect(html).toContain('profile summary may still need to refresh');
    expect(html).toContain('Reload saved note');
    expect(html).not.toContain('Resolve earlier save');
    expect(savedNoteHasConflict('before', 'after', true)).toBe(false);
    expect(savedNoteHasConflict('before', 'after', false)).toBe(true);
    expect(savedNoteHasConflict('before', 'before', false)).toBe(false);
  });
});
