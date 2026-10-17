import type { ModelMessage } from 'ai';

/**
 * Default clip for a tool result before the model reasons over it. Read-heavy
 * tools get a larger, per-tool limit below: clipping a fetched page or a mail
 * thread to 8 KB paid for content the model never saw, which starved research
 * tasks and invited guessing. The checkpoint stays bounded because the full
 * result lives in its tool_calls row, which `tools.read_result` can page
 * through on demand.
 */
export const DEFAULT_TOOL_RESULT_CHAR_LIMIT = 8_000;
const RESULT_CHAR_LIMITS: Readonly<Record<string, number>> = {
  'web.fetch': 24_000,
  // A lookup answer is now written by the model and checked against the full
  // result row from the database. Clipping the copy the model reasons over to
  // 8 KB would hide events it is then required to have mentioned — so a busy
  // day across several calendars, the exact case where the agenda earns its
  // keep, would be the one that always fell back to the plain list.
  'calendar.list_events': 24_000,
  'calendar.search_events': 24_000,
  'gmail.search': 24_000,
  'gmail.read_thread': 24_000,
  'docs.get': 24_000,
  'drive.read': 24_000,
  'sheets.get_rows': 24_000,
  'documents.search': 16_000,
  'tools.read_result': 32_000,
};

export function toolResultCharacterLimit(toolName: string): number {
  return RESULT_CHAR_LIMITS[toolName] ?? DEFAULT_TOOL_RESULT_CHAR_LIMIT;
}

export const CONTEXT_WINDOW_LIMIT = 60;
/**
 * Estimated-token budget for the compacted tail. Bounding by message count
 * alone let 60 large results add up to hundreds of KB — enough to overflow a
 * fallback model's real context and to make a single step's cost reservation
 * exceed a task budget. Chars-per-token ≈ 3.5 for English prose and JSON.
 */
export const CONTEXT_TOKEN_BUDGET = 25_000;
const CHARS_PER_TOKEN = 3.5;
const CONTEXT_CHAR_BUDGET = CONTEXT_TOKEN_BUDGET * CHARS_PER_TOKEN;

function messageChars(message: ModelMessage | undefined): number {
  return message ? JSON.stringify(message).length : 0;
}

function truncateResult(toolName: string, result: unknown, dbToolCallId?: string): unknown {
  const json = JSON.stringify(result ?? null);
  const limit = toolResultCharacterLimit(toolName);
  // Round-trip through JSON: results straight from tools may hold Date
  // instances (drizzle rows) or undefined props, which fail the AI SDK's
  // ModelMessage schema on the NEXT step's validation (checkpointed windows
  // don't hit this — jsonb already serialized them, which is why retries
  // succeeded where first attempts crashed).
  if (json.length <= limit) return JSON.parse(json);
  return {
    truncated: true,
    // Only claim the remainder is reachable when this call has a durable row
    // the read tool can address; a false promise of retrievability is an
    // invitation to hallucinate a retrieval path.
    note: dbToolCallId
      ? `result truncated from ${json.length} chars; read more with tools.read_result({ toolCallId: "${dbToolCallId}", offset: ${limit} })`
      : `result truncated from ${json.length} chars; the remainder is not retrievable`,
    preview: json.slice(0, limit),
  };
}

export function toolResultMessage(
  toolCallId: string,
  toolName: string,
  value: unknown,
  options?: { dbToolCallId?: string },
): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'json', value: truncateResult(toolName, value, options?.dbToolCallId) },
      },
    ],
  } as ModelMessage;
}

/**
 * Stitch the terminal result for a tool call into the transcript exactly once.
 *
 * Older checkpoints may contain provisional `awaiting_owner_approval` or
 * `background_job_running` results. Replaying one of those beside the real
 * result is invalid for providers that require a one-to-one tool_use/result
 * pairing, so settling a call replaces every earlier result with the same id.
 */
export function replaceToolResultMessage(
  window: ModelMessage[],
  toolCallId: string,
  toolName: string,
  value: unknown,
  options?: { dbToolCallId?: string },
): void {
  for (let index = window.length - 1; index >= 0; index -= 1) {
    const message = window[index];
    if (message?.role !== 'tool' || !Array.isArray(message.content)) continue;
    const content = message.content.filter(
      (part) => !(part.type === 'tool-result' && part.toolCallId === toolCallId),
    );
    if (content.length === message.content.length) continue;
    if (content.length === 0) {
      window.splice(index, 1);
    } else {
      window[index] = { ...message, content } as ModelMessage;
    }
  }
  // A resumed batch can acquire new recall or owner messages before its last
  // tool settles. Providers require every result before the next system/user
  // turn, so restore it beside its original call rather than at the live tail.
  // This also repairs an older checkpoint with a displaced provisional result.
  const callIndex = window.findLastIndex(
    (message) =>
      message.role === 'assistant' &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'tool-call' && part.toolCallId === toolCallId),
  );
  let resultIndex = callIndex >= 0 ? callIndex + 1 : window.length;
  while (window[resultIndex]?.role === 'tool') resultIndex += 1;
  window.splice(resultIndex, 0, toolResultMessage(toolCallId, toolName, value, options));
}

/**
 * A tool-call message whose serialized size alone exceeds this has its `input`
 * elided when it must be kept to preserve pairing. Small tool-call args (a
 * calendar event's fields, a search query) stay legible; only artifact bodies
 * — a whole document/sheet/deck passed to `docs.create` etc. — are shed.
 */
const TOOL_CALL_INPUT_ELIDE_CHARS = 16_000;

/** Whether an assistant message proposes tool calls (so it anchors tool results). */
function hasToolCalls(message: ModelMessage | undefined): boolean {
  return (
    message?.role === 'assistant' &&
    Array.isArray(message.content) &&
    message.content.some((part) => (part as { type?: string }).type === 'tool-call')
  );
}

/**
 * Replace an oversized assistant message's tool-call `input` with a stand-in.
 * The arguments were already dispatched and are durable in `tool_calls.args`;
 * the model does not re-read them, but the message must stay to anchor its tool
 * results (which carry the answer — e.g. the created document's URL).
 */
function elideToolCallInputs(message: ModelMessage): ModelMessage {
  if (!hasToolCalls(message) || !Array.isArray(message.content)) return message;
  if (messageChars(message) <= TOOL_CALL_INPUT_ELIDE_CHARS) return message;
  return {
    ...message,
    content: message.content.map((part) =>
      (part as { type?: string }).type === 'tool-call'
        ? {
            ...(part as object),
            input: {
              elided: true,
              note: 'tool arguments elided after dispatch (durable in the ledger)',
            },
          }
        : part,
    ),
  } as ModelMessage;
}

/**
 * Drop-oldest compaction bounded by BOTH message count and estimated tokens.
 *
 * Messages are partitioned into atomic GROUPS: an assistant message that
 * proposes tool calls is inseparable from the `tool` messages that answer it —
 * strict providers (Azure, Anthropic) require one-to-one tool_use/tool_result
 * pairing and reject an orphaned leading tool-result. Grouping (rather than the
 * older "advance past leading tool messages" cut) guarantees the tail can never
 * begin on an orphan AND can never become empty: the newest group — the turn
 * being answered, including the result just obtained — is always kept whole.
 *
 * When that newest group alone busts the char budget (a large artifact body in
 * its tool-call args), the args are elided rather than the group dropped, so the
 * tool RESULT survives. Without this a `[instruction, assistant(big docs.create),
 * tool(doc url)]` window collapsed to just the instruction and the model lost
 * the URL it had just created.
 *
 * The first and latest user messages (source instruction and correction) are PINNED: a long task must
 * not lose "what am I doing and why" to drop-oldest. Goal sessions re-seed the
 * instruction each run, but an adhoc/mission/email task has only this copy in
 * the window, and without it later steps drift once it ages out. Prepending a
 * lone user message never breaks pairing (it carries no tool-call).
 */
export function compact(window: ModelMessage[]): ModelMessage[] {
  const totalChars = window.reduce((sum, message) => sum + messageChars(message), 0);
  if (window.length <= CONTEXT_WINDOW_LIMIT && totalChars <= CONTEXT_CHAR_BUDGET) return window;

  const firstUserIndex = window.findIndex((m) => m.role === 'user');
  const lastUserIndex = window.findLastIndex((m) => m.role === 'user');
  const pins = [...new Set([firstUserIndex, lastUserIndex])].filter((index) => index >= 0);
  const pinChars = pins.reduce((sum, index) => sum + messageChars(window[index]), 0);

  // Partition into atomic groups over half-open [start, end) ranges.
  const groups: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < window.length; ) {
    let end = index + 1;
    if (hasToolCalls(window[index])) {
      while (end < window.length && window[end]?.role === 'tool') end += 1;
    }
    groups.push({ start: index, end });
    index = end;
  }

  // Leave room for the pinned instruction so the totals still respect both bounds.
  const tailMessageBudget = CONTEXT_WINDOW_LIMIT - pins.length;
  const tailCharBudget = Math.max(0, CONTEXT_CHAR_BUDGET - pinChars);
  const groupChars = ({ start, end }: { start: number; end: number }) =>
    window
      .slice(start, end)
      .reduce(
        (sum, message, offset) => sum + (pins.includes(start + offset) ? 0 : messageChars(message)),
        0,
      );

  // Walk groups newest-first; the newest is kept unconditionally, older ones
  // only while both bounds hold.
  let firstGroup = groups.length - 1;
  let chars = 0;
  let count = 0;
  for (let g = groups.length - 1; g >= 0; g -= 1) {
    const group = groups[g];
    if (!group) break;
    const thisChars = groupChars(group);
    const thisCount =
      group.end -
      group.start -
      pins.filter((index) => index >= group.start && index < group.end).length;
    const isNewest = g === groups.length - 1;
    if (
      !isNewest &&
      (chars + thisChars > tailCharBudget || count + thisCount > tailMessageBudget)
    ) {
      break;
    }
    chars += thisChars;
    count += thisCount;
    firstGroup = g;
  }

  const start = groups[firstGroup]?.start ?? 0;
  let tail = window.slice(start);

  // Elide oversized tool-call args only if the kept tail still busts the budget.
  if (
    tail.reduce((sum, message) => sum + messageChars(message), 0) + pinChars >
    CONTEXT_CHAR_BUDGET
  ) {
    tail = tail.map(elideToolCallInputs);
  }

  // Preserve both the source instruction and the latest correction. A long
  // batch must not silently revert to the original request after compaction.
  return [
    ...pins.filter((index) => index < start).map((index) => window[index] as ModelMessage),
    ...tail,
  ];
}

/** Latest direct owner wording, used only for deterministic artifact routing. */
export function latestUserText(window: ModelMessage[]): string | undefined {
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const message = window[i];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => {
          if (!part || typeof part !== 'object' || !('text' in part)) return '';
          const value = (part as { text?: unknown }).text;
          return typeof value === 'string' ? value : '';
        })
        .filter(Boolean)
        .join('\n');
      if (text) return text;
    }
  }
  return undefined;
}
