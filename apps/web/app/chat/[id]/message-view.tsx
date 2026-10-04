'use client';

/*
 * Presentational pieces of the chat message stream — day dividers, presence
 * and activity indicators, notice cards, recall provenance — plus the small
 * date/text helpers they share with ChatClient. Everything here is pure
 * props-in/markup-out; the stateful streaming logic stays in chat-client.tsx.
 */
import type { UIMessage } from 'ai';
import {
  Check,
  CircleX,
  Copy,
  History,
  type LucideIcon,
  MoonStar,
  PauseCircle,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { type ReactNode, useEffect, useState, useTransition } from 'react';
import type { ChatCardPresentation } from '@/lib/chat-notices';
import { type NoticeKind, offCourseReplacement } from '@/lib/chat-notices';
import { focusRing } from '@/lib/ui';
import { DecisionCard, type DecisionTone } from './decision-card';
import { MessageMarkdown } from './markdown';

export interface RecallSource {
  date: string;
  label: string;
  kind?: 'chat' | 'knowledge_graph';
  hops?: 1 | 2;
}

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
  for (const message of messages) {
    if (!arrival.has(message.id)) arrival.set(message.id, arrival.size);
  }
  return [...messages].sort((a, b) => {
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

/**
 * Retire the optimistic user turn once its persisted twin is in the log.
 *
 * The client sent the text, so matching on it is reliable, and one durable
 * message retires exactly one local copy — asking the same question twice still
 * shows twice. Safe to run mid-stream: it only ever removes a duplicate of
 * something already on screen.
 */
export function retireProvisionalUserTurns(log: UIMessage[], serverIds: Set<string>): UIMessage[] {
  const durable: string[] = [];
  for (const message of log) {
    if (message.role === 'user' && !isProvisional(message, serverIds)) {
      durable.push(messageText(message).trim());
    }
  }
  if (durable.length === 0) return log;
  return log.filter((message) => {
    if (message.role !== 'user' || !isProvisional(message, serverIds)) return true;
    const at = durable.indexOf(messageText(message).trim());
    if (at === -1) return true;
    durable.splice(at, 1);
    return false;
  });
}

/**
 * The words a reply actually shows. Normally its text parts — but a streamed
 * draft the response contract replaced shows the replacement instead, carried
 * on its `data-off-course` part, which is also the text chat-turn.ts persisted.
 * Reading it here is what keeps the streamed copy and its durable twin
 * comparable when the contract intervenes.
 */
function shownText(message: UIMessage): string {
  return (offCourseReplacement(message.parts) ?? messageText(message)).trim();
}

/**
 * Retire a locally streamed reply once its persisted twin is in the log.
 *
 * This used to retire every local reply as soon as ANY durable assistant
 * message arrived, which meant a scheduled brief, a watch firing, or inbound
 * mail mirrored into chat would delete a reply the client was still holding —
 * a message visibly disappearing for no reason the reader could see. The text
 * a streamed reply shows and the text of its persisted twin are identical by
 * construction (chat-turn.ts persists exactly what it streamed, and streams
 * the contract's replacement when it corrects one), so matching on text names
 * the right one instead of the nearest one.
 *
 * Matching runs against the whole log rather than one poll page, so a twin that
 * landed while the stream was still live is still reconciled on a later tick.
 */
export function retireProvisionalReplies(log: UIMessage[], serverIds: Set<string>): UIMessage[] {
  const durable: string[] = [];
  for (const message of log) {
    if (message.role === 'assistant' && !isProvisional(message, serverIds)) {
      durable.push(shownText(message));
    }
  }
  if (durable.length === 0) return log;
  return log.filter((message) => {
    if (message.role !== 'assistant' || !isProvisional(message, serverIds)) return true;
    const at = durable.indexOf(shownText(message));
    if (at === -1) return true;
    durable.splice(at, 1);
    return false;
  });
}

/*
 * Dates render in the agent's configured timezone, on the server and in the
 * browser alike. They used to be gated behind a `mounted` flag so the browser's
 * own zone could be used safely — which meant every timestamp was missing from
 * the first paint and appeared a frame later, pushing the whole log down as it
 * did. One zone on both sides makes the first paint the final one.
 */
/*
 * Building an `Intl.DateTimeFormat` is expensive enough to show up in a render
 * profile: every reply on screen asks for a day key, a clock time and a full
 * tooltip stamp, so an unmemoized log built hundreds of them per keystroke.
 * The set of shapes used here is tiny and fixed, so they are built once and
 * kept.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  const cached = formatterCache.get(key);
  if (cached) return cached;
  const built = new Intl.DateTimeFormat('en-US', { timeZone, ...options });
  formatterCache.set(key, built);
  return built;
}

function dayKey(date: Date, timeZone: string): string {
  // en-CA gives an ISO-shaped YYYY-MM-DD, so day keys compare as strings and
  // the year is the first four characters.
  const key = `en-CA|${timeZone}|day`;
  let cached = formatterCache.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatterCache.set(key, cached);
  }
  return cached.format(date);
}

export function sameDay(a: Date, b: Date, timeZone: string): boolean {
  return dayKey(a, timeZone) === dayKey(b, timeZone);
}

export function dayLabel(date: Date, now: Date, timeZone: string): string {
  const key = dayKey(date, timeZone);
  const today = dayKey(now, timeZone);
  if (key === today) return 'Today';
  if (key === dayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000), timeZone)) return 'Yesterday';
  return formatter(timeZone, {
    month: 'short',
    day: 'numeric',
    ...(key.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }),
  }).format(date);
}

export function timeLabel(date: Date, timeZone: string): string {
  return formatter(timeZone, { hour: 'numeric', minute: '2-digit' }).format(date);
}

/**
 * When a message landed, as the footer states it.
 *
 * A day only earns a mention when it is not the one you are in: inside today —
 * which is nearly always, for a chat you are having — this is a clock time and
 * nothing else. Older messages carry their day in the same line rather than
 * behind a divider above them, so the "when" travels with the message instead
 * of with its position in the log.
 */
export function stampLabel(date: Date, now: Date, timeZone: string): string {
  const time = timeLabel(date, timeZone);
  if (sameDay(date, now, timeZone)) return time;
  return `${dayLabel(date, now, timeZone)} · ${time}`;
}

/**
 * Copy a reply, and the time it landed — revealed on hover where hover exists.
 * Touch devices keep the compact row visible so copy is discoverable there too.
 */
export function MessageActions({
  text,
  date,
  now,
  timeZone,
}: {
  text: string;
  date: Date | null;
  now: Date;
  timeZone: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), 1800);
    return () => window.clearTimeout(timer);
  }, [state]);

  if (text === '') return null;

  const copy = async () => {
    try {
      // Undefined outside a secure context — say so rather than doing nothing.
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  };

  return (
    <div className="msg-actions mt-1.5 flex items-center gap-2 opacity-0 motion-safe:transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100">
      <button
        type="button"
        onClick={() => void copy()}
        title={state === 'failed' ? 'Your browser blocked clipboard access' : 'Copy this reply'}
        className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium motion-safe:transition-colors ${focusRing} ${
          state === 'failed'
            ? 'text-red-300'
            : state === 'copied'
              ? 'text-emerald-300'
              : 'text-stage-muted hover:bg-white/10 hover:text-stage-strong'
        }`}
      >
        {state === 'copied' ? (
          <Check className="size-3" aria-hidden="true" />
        ) : (
          <Copy className="size-3" aria-hidden="true" />
        )}
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : 'Copy'}
      </button>
      {date ? (
        <span title={date.toLocaleString()} className="text-xs text-stage-muted">
          {stampLabel(date, now, timeZone)}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Everything the runtime says ABOUT the work rather than in reply to you: the
 * honesty check replacing an unverifiable draft, a task parking itself until a
 * budget resets, a task that cannot continue without the owner. Each is a
 * statement of state, so each gets the same card the decisions get — never
 * assistant prose, which is what made "I'm pausing here…" read as small talk.
 */
const NOTICE_PRESENTATION = {
  'response-contract': { tone: 'system', icon: ShieldCheck, label: 'System check' },
  parked: { tone: 'system', icon: PauseCircle, label: 'Paused — resumes on its own' },
  'needs-attention': { tone: 'waiting', icon: TriangleAlert, label: 'Needs you' },
  'provider-failed': { tone: 'system', icon: CircleX, label: 'Response interrupted' },
  'turn-failed': { tone: 'system', icon: CircleX, label: 'Didn’t go through' },
  retracted: { tone: 'system', icon: RotateCcw, label: 'Retracted response' },
} as const satisfies Record<NoticeKind, { tone: DecisionTone; icon: LucideIcon; label: string }>;

export function NoticeCard({
  kind,
  text,
  presentation,
  actions,
  originalText,
  retractionReason,
}: {
  kind: NoticeKind;
  text: string;
  presentation?: ChatCardPresentation | null;
  /** Recovery affordances — a turn-failed card's retry, for instance. */
  actions?: ReactNode;
  originalText?: string;
  retractionReason?: string;
}) {
  const { tone, icon, label } = NOTICE_PRESENTATION[kind];
  const headline = presentation?.headline ?? label;
  const summary = presentation?.summary ?? text;
  const diagnostics = presentation?.diagnostics ?? [];
  return (
    <DecisionCard tone={tone} icon={icon} label={label}>
      <h3 className="text-base leading-6 font-semibold tracking-[-0.015em] text-strong">
        {headline}
      </h3>
      <p className="mt-1 max-w-[68ch] break-words text-sm leading-5 text-muted [overflow-wrap:anywhere]">
        {summary}
      </p>
      {presentation?.facts?.length ? (
        <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
          {presentation.facts.map((fact, index) => (
            <div
              key={`${fact.label}-${index.toString()}`}
              className="flex items-baseline gap-1.5 text-xs"
            >
              <dt className="text-muted">{fact.label}</dt>
              <dd className="font-medium text-strong">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {actions ? <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div> : null}
      {diagnostics.length > 0 || kind === 'response-contract' ? (
        <details className="mt-3 border-t border-edge/60 pt-2.5">
          <summary className="disclosure flex cursor-pointer select-none items-center gap-2 text-xs font-medium text-muted">
            {presentation?.detailLabel ?? 'Details'}
          </summary>
          <div className="mt-2 max-h-72 overflow-auto rounded-xl bg-sunken/55 px-3 py-2.5 text-xs leading-5 text-muted">
            {diagnostics.length > 0 ? (
              diagnostics.map((item, index) => (
                <p
                  key={`${index.toString()}-${item.slice(0, 20)}`}
                  className="break-words [overflow-wrap:anywhere]"
                >
                  {item}
                </p>
              ))
            ) : (
              <p>
                The assistant only reports actions backed by completed tool results. Nothing was
                sent or changed outside this chat.
              </p>
            )}
          </div>
        </details>
      ) : null}
      {kind === 'retracted' ? (
        <details className="mt-2">
          <summary className="disclosure flex cursor-pointer select-none items-center gap-2 text-xs text-muted">
            View original response
          </summary>
          <p className="mt-2 text-xs leading-5 text-muted">
            {retractionReason ?? 'This response was not supported by verified source data.'}
          </p>
          {originalText ? (
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-sunken p-3 font-sans text-xs leading-5 text-muted">
              {originalText}
            </pre>
          ) : null}
        </details>
      ) : null}
    </DecisionCard>
  );
}

/**
 * Proactive notifications are part of the assistant's activity stream, not a
 * conversational reply. Give them a compact editorial treatment so a string
 * of updates remains scannable without hiding any of the original detail.
 */
export function AssistantUpdate({
  text,
  sources,
  messageId,
  onFeedback,
}: {
  text: string;
  sources: RecallSource[];
  messageId: string;
  onFeedback?: (messageId: string, verdict: 'helpful' | 'not_helpful') => Promise<void>;
}) {
  const attention = /(?:⚠️|anomaly|waiting for you|needs? (?:your )?attention)/i.test(text);
  const reflection = /(?:🌙|while you slept|reflected)/i.test(text);
  const tone: DecisionTone = attention ? 'waiting' : reflection ? 'quiet' : 'info';
  const icon = attention ? TriangleAlert : reflection ? MoonStar : Sparkles;
  const label = attention ? 'Needs attention' : reflection ? 'Quiet update' : 'Update';
  return (
    <DecisionCard tone={tone} icon={icon} label={label}>
      <RecallNote sources={sources} messageId={messageId} onFeedback={onFeedback} />
      <div className="break-words text-sm leading-6 text-strong [overflow-wrap:anywhere]">
        <MessageMarkdown text={text} />
      </div>
    </DecisionCard>
  );
}

/** Auto-recall provenance carried on an assistant message's custom `recall` part. */
export function recallSourcesOf(message: UIMessage): RecallSource[] {
  for (const part of message.parts as Array<{
    type?: string;
    sources?: unknown;
  }>) {
    if (part?.type === 'recall' && Array.isArray(part.sources)) {
      return (part.sources as RecallSource[]).filter(
        (s) => s && typeof s.date === 'string' && typeof s.label === 'string',
      );
    }
  }
  return [];
}

/**
 * "2026-07-12" → "Jul 12" (falls back to the raw string on parse failure).
 *
 * The source day is produced UTC-side (`isoDate` in memory/graph-recall.ts), so
 * it is read back with an explicit `Z` and formatted in UTC. Parsing it as local
 * time and formatting in the viewer's zone shifted every source back a day for
 * anyone west of UTC. The year appears once it differs from the current one —
 * without it a two-year-old memory was indistinguishable from last week's.
 */
function friendlyRecallDate(isoDay: string, now: Date = new Date()): string {
  const date = new Date(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDay;
  const sameYear = date.getUTCFullYear() === now.getUTCFullYear();
  return formatter('UTC', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date);
}

function RecallFeedbackControl({
  messageId,
  onFeedback,
}: {
  messageId: string;
  onFeedback: (messageId: string, verdict: 'helpful' | 'not_helpful') => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [selection, setSelection] = useState<'helpful' | 'not_helpful' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = (verdict: 'helpful' | 'not_helpful') => {
    setError(null);
    startTransition(async () => {
      try {
        await onFeedback(messageId, verdict);
        setSelection(verdict);
      } catch {
        setError('Could not save feedback.');
      }
    });
  };
  return (
    <span className="ml-1 inline-flex items-center gap-1 border-l border-current/15 pl-2">
      <span className="sr-only">Was this recalled context useful?</span>
      <button
        type="button"
        disabled={pending}
        onClick={() => save('helpful')}
        aria-pressed={selection === 'helpful'}
        title="This recalled context was useful"
        className="rounded px-1 py-0.5 text-[11px] font-medium hover:bg-current/10 disabled:opacity-50"
      >
        Helpful
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => save('not_helpful')}
        aria-pressed={selection === 'not_helpful'}
        title="This recalled context was not useful"
        className="rounded px-1 py-0.5 text-[11px] font-medium hover:bg-current/10 disabled:opacity-50"
      >
        Not useful
      </button>
      {error ? (
        <span role="status" className="sr-only">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** The "recalled from earlier" affordance: provenance plus owner feedback. */
export function RecallNote({
  sources,
  messageId,
  onFeedback,
}: {
  sources: RecallSource[];
  /** Live streamed provenance has no durable message id, so it is view-only. */
  messageId?: string;
  /** Kept at the transport boundary so this shared view stays server-free. */
  onFeedback?: (messageId: string, verdict: 'helpful' | 'not_helpful') => Promise<void>;
}) {
  if (sources.length === 0) return null;
  const graphSources = sources.filter((source) => source.kind === 'knowledge_graph');
  const label =
    graphSources.length === 0
      ? 'Drawing on'
      : graphSources.length === sources.length
        ? 'Drawing on knowledge graph'
        : 'Drawing on knowledge graph and earlier chats';
  return (
    // Provenance is required reading. Its surface supplies opaque supporting
    // ink, while size and spacing keep it secondary to the actual reply.
    <div className="recall-note mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
      <History className="size-3 shrink-0" aria-hidden="true" />
      <span className="font-medium">{label}</span>
      {sources.map((source, index) => (
        <span
          key={`${source.date}-${index.toString()}`}
          className="inline-block max-w-56 truncate align-bottom"
          title={`From ${source.date}${source.hops ? ` · ${source.hops}-hop connection` : ''} — ${source.label}`}
        >
          {index > 0 ? '· ' : ''}
          {friendlyRecallDate(source.date)} — {source.label}
        </span>
      ))}
      {messageId && onFeedback ? (
        <RecallFeedbackControl messageId={messageId} onFeedback={onFeedback} />
      ) : null}
    </div>
  );
}

export function decodeRecallHeader(value: string | null): RecallSource[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as unknown;
    if (!Array.isArray(parsed)) return null;
    const sources = parsed.filter(
      (s): s is RecallSource =>
        Boolean(s) &&
        typeof (s as RecallSource).date === 'string' &&
        typeof (s as RecallSource).label === 'string' &&
        ((s as RecallSource).kind === undefined ||
          (s as RecallSource).kind === 'chat' ||
          (s as RecallSource).kind === 'knowledge_graph') &&
        ((s as RecallSource).hops === undefined ||
          (s as RecallSource).hops === 1 ||
          (s as RecallSource).hops === 2),
    );
    return sources.length > 0 ? sources : null;
  } catch {
    return null;
  }
}

export interface ChatErrorInfo {
  message: string;
  /** Server-supplied machine code (`budget_exhausted`, …) driving actions. */
  code?: string;
}

/**
 * The transport throws `Error(await response.text())` on non-ok responses, so
 * 402/503 JSON bodies from the chat route arrive as the error message. The
 * server's `error` string is already owner-facing copy (the iOS app shows it
 * verbatim); the `code` rides along for clients that attach actions to kinds
 * of failure. A bare `unauthorized` from older proxies still gets translated.
 */
export function chatErrorInfo(error: Error): ChatErrorInfo {
  try {
    const parsed = JSON.parse(error.message) as { error?: string; code?: string };
    if (parsed.error) return { message: parsed.error, code: parsed.code };
  } catch {
    // not JSON — fall through to the raw message
  }
  if (error.message === 'unauthorized') {
    return { message: 'Your session expired — sign in again, then resend.', code: 'unauthorized' };
  }
  return {
    message:
      error.message ||
      'We could not display the response. Your message may still have been saved — refresh this chat before retrying.',
  };
}
