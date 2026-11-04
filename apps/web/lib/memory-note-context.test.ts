import { describe, expect, it } from 'vitest';
import { memoryNoteHref, memoryNoteReturnTo } from './memory-note-context';

describe('saved-note return context', () => {
  it('roundtrips a validated filtered Saved-notes location through a saved-note link', () => {
    const returnTo =
      '/profile/knowledge?view=library&q=family&state=review&filter=verified&page=3&source=email';
    expect(memoryNoteReturnTo(returnTo)).toBe(returnTo);
    expect(memoryNoteHref('33333333-3333-4333-8333-333333333333', returnTo)).toBe(
      `/profile/knowledge/notes/33333333-3333-4333-8333-333333333333?returnTo=${encodeURIComponent(returnTo)}`,
    );
  });

  it('rejects external and unapproved destinations instead of forwarding them', () => {
    expect(memoryNoteReturnTo('//example.invalid/profile/knowledge?view=library')).toBeNull();
    expect(memoryNoteReturnTo('/profile/knowledge?view=delete')).toBeNull();
    expect(memoryNoteHref('33333333-3333-4333-8333-333333333333', '//example.invalid')).toBe(
      '/profile/knowledge/notes/33333333-3333-4333-8333-333333333333',
    );
  });
});
