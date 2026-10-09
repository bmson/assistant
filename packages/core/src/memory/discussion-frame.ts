/** Retrieval context is reference data. It never grants connector or execution authority. */
export interface DiscussionTurn {
  id?: string;
  revision?: string;
  role: string;
  text: string;
  representation?: 'raw' | 'rendered';
}

export interface DiscussionFrame {
  queryText: string;
  bytes: number;
  available: boolean;
  currentTurnComplete: boolean;
  coverage: Array<{
    id?: string;
    revision?: string;
    role: 'user' | 'assistant';
    representation: 'raw' | 'rendered';
    bytes: number;
  }>;
  omittedTurns: number;
}

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

/**
 * Preserve the current words and a contiguous recent discussion suffix, with
 * explicit speaker boundaries. No entity or pronoun is guessed, no historical
 * statement becomes a current instruction, and no partial current request is
 * sent to the index. Supplied turns must already be owner/audience scoped and
 * must exclude notices, tool output and messages newer than the trigger.
 */
export function assembleDiscussionFrame(input: {
  currentText: string;
  turns: ReadonlyArray<DiscussionTurn>;
  maxBytes?: number;
  maxPriorTurns?: number;
}): DiscussionFrame {
  const maxBytes = Math.max(0, Math.min(input.maxBytes ?? 8192, 16384));
  const current = `Current request (scope and corrections apply to this turn):\n${input.currentText}`;
  const eligible = input.turns.filter(
    (turn) => (turn.role === 'user' || turn.role === 'assistant') && turn.text.trim(),
  );
  // The current user message is normally already the final history entry.
  const prior = [...eligible];
  if (prior.at(-1)?.role === 'user' && prior.at(-1)?.text === input.currentText) prior.pop();
  if (byteLength(current) > maxBytes) {
    return {
      queryText: '',
      bytes: 0,
      available: false,
      currentTurnComplete: false,
      coverage: [],
      omittedTurns: eligible.length,
    };
  }
  const selected: DiscussionTurn[] = [];
  let bytes = byteLength(current);
  for (const turn of prior.reverse()) {
    if (selected.length >= Math.max(0, Math.min(input.maxPriorTurns ?? 4, 8))) break;
    const rendered = `\n\nEarlier ${turn.role} statement (reference only):\n${turn.text}`;
    if (bytes + byteLength(rendered) > maxBytes) break;
    selected.push(turn);
    bytes += byteLength(rendered);
  }
  selected.reverse();
  const queryText =
    selected
      .map((turn) => `Earlier ${turn.role} statement (reference only):\n${turn.text}\n\n`)
      .join('') + current;
  return {
    queryText,
    bytes: byteLength(queryText),
    available: true,
    currentTurnComplete: true,
    coverage: selected.map((turn) => ({
      ...(turn.id ? { id: turn.id } : {}),
      ...(turn.revision ? { revision: turn.revision } : {}),
      role: turn.role as 'user' | 'assistant',
      representation: turn.representation ?? 'rendered',
      bytes: byteLength(turn.text),
    })),
    omittedTurns: prior.length - selected.length,
  };
}
