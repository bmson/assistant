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
import type { ChatCardPresentation, NoticeKind } from '@/lib/chat-notices';
import { focusRing } from '@/lib/ui';
import { DecisionCard, type DecisionTone } from './decision-card';
import { MessageMarkdown } from './markdown';

export interface RecallSource {
  date: string;
  label: string;
  kind?: 'chat' | 'knowledge_graph' | 'decision' | 'commitment';
  hops?: 1 | 2;
  surfaceKey?: string;
  sourceRevision?: string;
}

export type { ChatLogOrder } from './message-reconciliation';
export {
  createChatLogOrder,
  messageDate,
  messageText,
  orderChatLog,
  retireProvisionalReplies,
  retireProvisionalUserTurns,
} from './message-reconciliation';

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

function RecallSourceControl({ source }: { source: RecallSource }) {
  const [pending, startTransition] = useTransition();
  const [suppressed, setSuppressed] = useState<boolean | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!source.surfaceKey) return;
    let active = true;
    const sourceRevision = source.sourceRevision;
    void fetch(
      `/api/recall/sources/${source.surfaceKey}?sourceRevision=${encodeURIComponent(sourceRevision ?? '')}`,
      { cache: 'no-store' },
    )
      .then(async (response) =>
        response.ok ? ((await response.json()) as { suppressed?: boolean }) : null,
      )
      .then((value) => {
        if (active && typeof value?.suppressed === 'boolean') setSuppressed(value.suppressed);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [source.surfaceKey, source.sourceRevision]);
  if (!source.surfaceKey || !source.sourceRevision) return null;
  const save = () => {
    if (suppressed === null) return;
    const next = !suppressed;
    setError(false);
    startTransition(async () => {
      try {
        const response = await fetch(`/api/recall/sources/${source.surfaceKey}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ suppressed: next, expectedSourceRevision: source.sourceRevision }),
        });
        if (!response.ok) throw new Error('Recall control rejected');
        setSuppressed(next);
      } catch {
        setError(true);
      }
    });
  };
  return (
    <button
      type="button"
      className="ml-1 rounded underline decoration-current/40 underline-offset-2 hover:decoration-current disabled:opacity-50"
      disabled={pending || suppressed === null}
      onClick={save}
      aria-label={
        suppressed ? 'Allow this version in future recall' : 'Hide this version from future recall'
      }
      title={error ? 'Recall control could not be saved' : undefined}
    >
      {error ? 'Retry source control' : suppressed ? 'Allow this version' : 'Hide this version'}
    </button>
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
          {messageId ? <RecallSourceControl source={source} /> : null}
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
          (s as RecallSource).kind === 'knowledge_graph' ||
          (s as RecallSource).kind === 'decision' ||
          (s as RecallSource).kind === 'commitment') &&
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
