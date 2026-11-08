import { describe, expect, it } from 'vitest';
import { observableMailLabels } from './email-observation-scope.js';

describe('Gmail observation scope', () => {
  it('observes received mail whether unread, read, filtered or archived', () => {
    for (const labels of [['INBOX', 'UNREAD'], ['INBOX'], ['CATEGORY_PERSONAL'], []])
      expect(observableMailLabels(labels, true)).toBe(true);
  });
  it('keeps direct assistant correspondence inbox-scoped', () => {
    expect(observableMailLabels(['INBOX'], false)).toBe(true);
    expect(observableMailLabels(['CATEGORY_PERSONAL'], false)).toBe(false);
  });
  it('accepts Gmail’s omitted empty label set and excludes outbound messages, drafts and junk', () => {
    expect(observableMailLabels(undefined, true)).toBe(true);
    expect(observableMailLabels(undefined, false)).toBe(false);
    for (const label of ['SENT', 'DRAFT', 'SPAM', 'TRASH'])
      expect(observableMailLabels(['INBOX', label], true)).toBe(false);
  });
});
