import type { UIMessage } from 'ai';

export function messageText(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => part.type === 'text',
    )
    .map((part) => part.text)
    .join('');
}

/** Persisted send time, carried on message.metadata by the server mappers. */
export function messageDate(message: UIMessage): Date | null {
  const meta = message.metadata as { createdAt?: unknown } | undefined;
  if (meta && typeof meta.createdAt === 'string') {
    const date = new Date(meta.createdAt);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/**
 * What the log has learned about sequence, carried across renders by the
 * component that owns it. Both halves only ever grow, so what they say about
 * a message never changes once it has been said.
 */
export interface ChatLogOrder {
  /** Where each id was first seen — the fallback order for undated messages. */
  arrival: Map<string, number>;
  /** Parsed send times, so an instant is derived from its ISO string once. */
  sendTimes: Map<string, number>;
}

export function createChatLogOrder(): ChatLogOrder {
  return { arrival: new Map(), sendTimes: new Map() };
}

/**
 * A message's send time as a number, parsed at most once per id.
 *
 * `messageDate` builds a Date from an ISO string, and the sort below asks for
 * one O(n log n) times per render — which during a stream is once per token.
 * On a long thread that was thousands of Date constructions a second, all of
 * them re-deriving an instant that cannot move: the server fixes a message's
 * send time when it persists it.
 *
 * Only real timestamps are remembered. A message the client made itself has no
 * send time *yet* — it gets one when its durable twin arrives under the same
 * id — so caching its absence would pin it after the log forever. Those cost a
 * property check per comparison and no Date at all.
 */
function sendTime(message: UIMessage, order: ChatLogOrder): number {
  const cached = order.sendTimes.get(message.id);
  if (cached !== undefined) return cached;
  const at = messageDate(message)?.getTime();
  if (at === undefined) return Number.POSITIVE_INFINITY;
  order.sendTimes.set(message.id, at);
  return at;
}

/**
 * Keep one UI row per message identity. The AI SDK normally replaces the
 * in-flight assistant snapshot by id, but a polling merge can insert the
 * persisted sibling between stream updates; a later SDK update then appends a
 * second snapshot with the same id. Keep the last copy because it is the most
 * recent streamed state. This is identity reconciliation, never text dedupe.
 */
export function uniqueMessageIds(messages: UIMessage[]): UIMessage[] {
  const seen = new Set<string>();
  const unique: UIMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || seen.has(message.id)) continue;
    seen.add(message.id);
    unique.push(message);
  }
  unique.reverse();
  return unique;
}

/**
 * A persisted reply and its still-streaming AI SDK snapshot can briefly coexist
 * under different row ids. When both carry the same server channel identity,
 * render the persisted row's complete parts and metadata. A late partial stream
 * snapshot must not replace the guarded, durable answer. The identity match is
 * exact; equal text alone never merges messages.
 */
function collapseProvisionalAssistantEchoes(messages: UIMessage[]): UIMessage[] {
  const groups = new Map<string, number[]>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    const metadata = message.metadata as { channelMessageId?: unknown } | undefined;
    if (typeof metadata?.channelMessageId !== 'string' || !metadata.channelMessageId) continue;
    const group = groups.get(metadata.channelMessageId) ?? [];
    group.push(index);
    groups.set(metadata.channelMessageId, group);
  }

  const replacements = new Map<number, UIMessage>();
  const removed = new Set<number>();
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    const persisted = indexes.filter((index) => messageDate(messages[index] as UIMessage) !== null);
    const provisional = indexes.filter(
      (index) => messageDate(messages[index] as UIMessage) === null,
    );
    // Multiple durable rows with one channel key indicate corrupt input; don't
    // hide either. Only reconcile the expected one-durable/one-stream shape.
    if (persisted.length !== 1 || provisional.length === 0) continue;
    const durableIndex = persisted[0] as number;
    const durable = messages[durableIndex] as UIMessage;
    replacements.set(durableIndex, durable);
    for (const index of indexes) if (index !== durableIndex) removed.add(index);
  }

  if (removed.size === 0) return messages;
  return messages.flatMap((message, index) =>
    removed.has(index) ? [] : [replacements.get(index) ?? message],
  );
}

/**
 * Chronological order for the rendered log, and the only place order is
 * decided. Everything else — the poll's merge, useChat's own appends — just
 * puts messages in the set; this puts them in sequence.
 *
 * Persisted messages sort by their send time and tie-break on id, exactly as
 * the server ordered them (listMessages: `created_at, id`). Anything the client
 * made itself has no send time yet and no server order to agree with, so it
 * sorts after everything durable, in the order it appeared here. That last part
 * is the fix for a real reversal: the optimistic user turn and the reply
 * streaming in response to it were both undated, so the tie-break ran on two
 * randomly generated ids and the answer could render above the question.
 *
 * `order` is mutated to record each id on first sight.
 */
export function orderChatLog(messages: UIMessage[], order: ChatLogOrder): UIMessage[] {
  const { arrival } = order;
  const uniqueMessages = collapseProvisionalAssistantEchoes(uniqueMessageIds(messages));
  for (const message of uniqueMessages) {
    if (!arrival.has(message.id)) arrival.set(message.id, arrival.size);
  }
  return uniqueMessages.sort((a, b) => {
    const left = sendTime(a, order);
    const right = sendTime(b, order);
    if (left !== right) return left - right;
    if (Number.isFinite(left)) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return (arrival.get(a.id) ?? 0) - (arrival.get(b.id) ?? 0);
  });
}

/** A message the client made itself — the server has never sent us this id. */
function isProvisional(message: UIMessage, serverIds: Set<string>): boolean {
  return !serverIds.has(message.id);
}

/** Provisional rows are reconciled only with an explicitly acknowledged persisted identity. */
function retireAcknowledged(
  log: UIMessage[],
  serverIds: Set<string>,
  role: 'user' | 'assistant',
): UIMessage[] {
  const durable = log.filter(
    (message) => message.role === role && !isProvisional(message, serverIds),
  );
  return log.filter((message) => {
    if (message.role !== role || !isProvisional(message, serverIds)) return true;
    const meta = message.metadata as
      | { durableMessageId?: string; channelMessageId?: string }
      | undefined;
    return !durable.some(
      (row) =>
        row.id === meta?.durableMessageId ||
        (typeof meta?.channelMessageId === 'string' &&
          meta.channelMessageId.length > 0 &&
          (row.metadata as { channelMessageId?: string } | undefined)?.channelMessageId ===
            meta.channelMessageId),
    );
  });
}

export function retireProvisionalUserTurns(log: UIMessage[], serverIds: Set<string>): UIMessage[] {
  return retireAcknowledged(log, serverIds, 'user');
}

export function retireProvisionalReplies(log: UIMessage[], serverIds: Set<string>): UIMessage[] {
  return retireAcknowledged(log, serverIds, 'assistant');
}
