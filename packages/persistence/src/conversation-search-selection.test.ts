import { describe, expect, it } from 'vitest';
import type { ConversationSearchMatch } from './builtin-tools.js';
import {
  conversationSearchCandidateLimit,
  selectConversationSearchMatches,
} from './conversation-search-selection.js';

function row(index: number, text: string, conversationId: string, role = 'user', origin = 'owner') {
  return {
    messageId: `message-${index}`,
    sourceRevision: `source-${index}`,
    speakerRevision: `speaker-${index}`,
    conversationId,
    text,
    role,
    origin,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    similarity: 1 - index / 100,
  } satisfies ConversationSearchMatch & { similarity: number };
}

describe('bounded conversation source selection', () => {
  it('deduplicates repeated owner questions and spreads candidates across conversations before the cap', () => {
    const ranked = [
      row(0, 'What are my interface preferences?', 'qa-1'),
      row(1, ' What  are my interface preferences? ', 'qa-2'),
      row(2, 'What are my interface preferences?', 'qa-3'),
      ...Array.from({ length: 15 }, (_, i) =>
        row(i + 3, `Assistant answer ${i}`, 'qa-1', 'assistant', 'assistant'),
      ),
      row(18, 'Keep the interface quiet and compact.', 'preferences'),
      row(19, 'Prefer short replies.', 'preferences'),
      row(20, 'A different owner note.', 'other'),
    ];
    const selected = selectConversationSearchMatches(ranked, 8);
    expect(selected).toHaveLength(8);
    expect(selected.filter((item) => item.text.includes('interface preferences'))).toHaveLength(1);
    expect(selected.map((item) => item.text)).toContain('Keep the interface quiet and compact.');
    expect(selected.map((item) => item.text)).toContain('A different owner note.');
    expect(selected.some((item) => item.role === 'assistant')).toBe(true);
    expect(selected.every((item) => item.sourceRevision && item.speakerRevision)).toBe(true);
  });

  it('retains an assistant-only historical result and never merges identical text across speakers', () => {
    const assistantOnly = Array.from({ length: 12 }, (_, i) =>
      row(i, `Claim ${i}`, 'assistant-chat', 'assistant', 'assistant'),
    );
    expect(selectConversationSearchMatches(assistantOnly, 10)).toHaveLength(10);
    const sameWords = [
      row(30, 'Keep replies brief.', 'owner-chat'),
      row(31, 'Keep replies brief.', 'assistant-chat', 'assistant', 'assistant'),
    ];
    expect(selectConversationSearchMatches(sameWords, 2)).toHaveLength(2);
    expect(selectConversationSearchMatches([], 20)).toEqual([]);
    expect(conversationSearchCandidateLimit(20)).toBe(80);
  });
});
