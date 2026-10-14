import type { ConversationSearchMatch } from './builtin-tools.js';

/** Extra candidates are inspected locally; the public search result still has at most 20 rows. */
export function conversationSearchCandidateLimit(limit: number): number {
  return Math.min(80, limit * 4);
}

function speaker(row: ConversationSearchMatch): 'owner' | 'assistant' | 'other' {
  if (row.role === 'user' && row.origin === 'owner') return 'owner';
  if (row.role === 'assistant' && row.origin === 'assistant') return 'assistant';
  return 'other';
}

function normalizedContent(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US');
}

/** Keep the best-ranked copy of repeated text, then spread each speaker across chats. */
function diverse<T extends ConversationSearchMatch>(rows: T[]): T[] {
  const seenContent = new Set<string>();
  const unique = rows.filter((row) => {
    const key = `${row.role}\u0000${row.origin}\u0000${normalizedContent(row.text)}`;
    if (seenContent.has(key)) return false;
    seenContent.add(key);
    return true;
  });
  const chats = new Map<string, T[]>();
  for (const row of unique) {
    const bucket = chats.get(row.conversationId) ?? [];
    bucket.push(row);
    chats.set(row.conversationId, bucket);
  }
  const result: T[] = [];
  while (result.length < unique.length) {
    for (const bucket of chats.values()) {
      const row = bucket.shift();
      if (row) result.push(row);
    }
  }
  return result;
}

/** Reserve room for both recorded owner statements and earlier assistant claims. */
export function selectConversationSearchMatches<T extends ConversationSearchMatch>(
  ranked: T[],
  limit: number,
): T[] {
  const groups = { owner: [] as T[], assistant: [] as T[], other: [] as T[] };
  for (const row of ranked) groups[speaker(row)].push(row);
  const owner = diverse(groups.owner);
  const assistant = diverse(groups.assistant);
  const other = diverse(groups.other);
  const selected = [
    ...owner.splice(0, Math.ceil(limit * 0.6)),
    ...assistant.splice(0, Math.floor(limit * 0.4)),
  ];
  const remainder = [...owner, ...assistant, ...other];
  const rank = new Map(ranked.map((row, index) => [row.messageId, index]));
  remainder.sort(
    (left, right) => (rank.get(left.messageId) ?? 0) - (rank.get(right.messageId) ?? 0),
  );
  return [...selected, ...remainder.slice(0, limit - selected.length)].sort(
    (left, right) => (rank.get(left.messageId) ?? 0) - (rank.get(right.messageId) ?? 0),
  );
}
