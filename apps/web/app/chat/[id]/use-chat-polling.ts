'use client';

/*
 * The chat's long-poll loop, extracted from chat-client.tsx so the component
 * owns presentation and this hook owns synchronization. One poll runs for the
 * whole thread for as long as the page is open: it used to start when a turn
 * was handed to the executor and stop when that task settled, which meant the
 * log only ever updated itself during a turn you had just sent. Everything
 * else — the executor resuming after you approve, a schedule or watch posting,
 * inbound mail mirrored into chat — landed in the database with nobody
 * listening and appeared only on the next page load. The cursor now outlives
 * any single task: settling a turn ends the turn's presence UI, not the
 * listening.
 */
import type { UIMessage } from 'ai';
import { type Dispatch, type RefObject, type SetStateAction, useEffect, useRef } from 'react';
import { CARD_REFRESH_EVENT } from './card-refresh-events';
import { uniqueMessageIds } from './message-reconciliation';
import {
  type RecallSource,
  recallSourcesOf,
  retireProvisionalReplies,
  retireProvisionalUserTurns,
} from './message-view';
import { suggestionTaskIsActive } from './suggestion-state';

/** The executor hand-off the open turn is waiting on. */
export interface AsyncTurn {
  taskId: string;
  cursor: string;
}

/** How an open turn ended. `retryable` offers to resend the opening message. */
export interface AsyncNote {
  text: string;
  retryable: boolean;
}

/** One live tool step reported for a running task. */
export interface ChatActivityItem {
  toolName: string;
  status: string;
  step: number;
}

/** The silent poll loop's only surfaces: repeated failure, or a dead session. */
export type PollTrouble = 'stale' | 'expired' | null;

/** Task statuses that mean "parked on the owner", not "finished". */
const PARKED_TASK_STATUSES = new Set(['waiting_approval', 'waiting_budget', 'needs_attention']);

/**
 * A task publishes a parked status before the card explaining the park is
 * persisted. The executor now writes that card ahead of its outbound owner
 * ping, so the gap is a single insert — but a poll can still land inside it,
 * and stopping there is what left approvals invisible until a reload. Give a
 * parked task this many extra polls to produce a card before settling, so a
 * park that legitimately has no card (plain needs_attention prose) still ends.
 */
const PARK_GRACE_TICKS = 4;
const EMPTY_SERVER_IDS = new Set<string>();

/** An approval or budget card — the thing a parked task is waiting on. */
function hasDecisionPart(message: UIMessage): boolean {
  return (message.parts as Array<{ type?: string }>).some(
    (part) => part?.type === 'approval' || part?.type === 'budget-request',
  );
}

/** How many on-screen decision cards one poll re-reads (matches the route). */
const MAX_REFRESH_IDS = 10;

/**
 * Whether a row the server just sent is the one already on screen.
 *
 * Both sides of this comparison are the same server serializer's output, so
 * the encoded form is stable and comparing it is enough to tell a genuine
 * update from a re-read. Only rows already in the log are ever compared, so
 * this costs nothing on a page of new messages.
 */
function sameMessage(current: UIMessage, incoming: UIMessage): boolean {
  return (
    current.role === incoming.role &&
    JSON.stringify(current.metadata) === JSON.stringify(incoming.metadata) &&
    JSON.stringify(current.parts) === JSON.stringify(incoming.parts)
  );
}

/**
 * One poll's rows folded into the log the reader is looking at.
 *
 * Merged by id, then the client's own provisional copies of what arrived are
 * retired. Ordering is NOT decided here — orderChatLog derives it from the
 * merged set on every render, so this and useChat's own appends cannot
 * disagree about where a message goes.
 *
 * Returns `current` ITSELF when the tick moved nothing, which is what keeps a
 * quiet thread quiet: `refresh` re-asks for every open decision card on every
 * tick, so a thread holding one unanswered approval used to hand React a fresh
 * array — and re-parse that card's markdown — every twelve seconds to report
 * that nothing had happened. A row that comes back identical is not news.
 */
export function mergeChatLog(
  current: UIMessage[],
  arriving: UIMessage[],
  options: { serverIds: Set<string>; streaming: boolean; retracted: Set<string> },
): UIMessage[] {
  const merged = uniqueMessageIds(current);
  const indexes = new Map(merged.map((message, index) => [message.id, index]));
  let touched = merged.length !== current.length;
  for (const message of arriving) {
    const index = indexes.get(message.id);
    if (index === undefined) {
      indexes.set(message.id, merged.length);
      merged.push(message);
      touched = true;
      continue;
    }
    if (sameMessage(merged[index] as UIMessage, message)) continue;
    merged[index] = message;
    touched = true;
  }
  // A reply still streaming has no persisted twin yet, so leave replies alone
  // until it finishes. Reconciling the user's own turn is always safe — it only
  // ever removes a duplicate of something already on screen, and that duplicate
  // was visible for the whole stream before.
  let reconciled = retireProvisionalUserTurns(merged, options.serverIds);
  if (!options.streaming) reconciled = retireProvisionalReplies(reconciled, options.serverIds);
  // `retracted` is applied AFTER the merges, because a refreshed card this tick
  // re-read can itself be the row being replaced.
  if (options.retracted.size > 0) {
    reconciled = reconciled.filter((message) => !options.retracted.has(message.id));
  }
  // Reconciliation reads the whole log rather than one page, so an idle tick
  // can still finish what a tick during a stream could not.
  return touched || reconciled.length !== merged.length ? reconciled : current;
}

/**
 * Messages whose decision is still open. Their live status lives in another
 * table, so a card answered on the Approvals page would otherwise keep offering
 * Approve/Decline here until a reload — the log saying something that is no
 * longer true.
 */
export function unresolvedDecisionIds(
  log: UIMessage[],
  priorityCardIds: ReadonlySet<string> = new Set(),
): string[] {
  const ids: string[] = log
    .filter((message) =>
      (
        message.parts as Array<{
          type?: string;
          data?: { id?: string; kind?: string; refreshState?: string };
        }>
      ).some(
        (part) =>
          part.type === 'data-card' &&
          !!part.data?.id &&
          (priorityCardIds.has(part.data.id) ||
            (part.data.kind === 'generated-card' && part.data.refreshState === 'refreshing')),
      ),
    )
    .map((message) => message.id)
    .slice(-MAX_REFRESH_IDS);
  // Newest first: a thread can hold more open cards than one poll may carry,
  // and the ones the reader is looking at are the recent ones.
  for (let index = log.length - 1; index >= 0 && ids.length < MAX_REFRESH_IDS; index -= 1) {
    const message = log[index] as UIMessage;
    const open = (
      message.parts as Array<{
        type?: string;
        status?: string;
        pendingCount?: number;
        acceptedTaskStatus?: string;
        data?: { kind?: string; refreshState?: string; spec?: { refreshable?: boolean } };
      }>
    ).some((part) => {
      // The approval summary carries no status of its own — it is open while
      // anything it stands for is still pending, and an un-hydrated one is
      // assumed open so the very first re-read can settle it.
      if (part?.type === 'approval-summary') {
        return part.pendingCount === undefined || part.pendingCount > 0;
      }
      if (part?.type === 'suggestion' && part.status === 'accepted') {
        return suggestionTaskIsActive(part.acceptedTaskStatus);
      }
      if (part?.type === 'data-card' && part.data?.kind === 'generated-card') {
        return part.data.refreshState === 'refreshing' || part.data.spec?.refreshable === true;
      }
      return (
        (part?.type === 'approval' ||
          part?.type === 'budget-request' ||
          part?.type === 'suggestion') &&
        (part.status === undefined || part.status === 'pending' || part.status === 'snoozed')
      );
    });
    if (open && !ids.includes(message.id)) ids.push(message.id);
  }
  return ids;
}

/**
 * Fallback poll cadence, for a server that answers immediately instead of
 * holding the request open. A current server holds (see POLL_HOLD_MS), and
 * `nextPollDelayMs` keeps these out of the way when it does.
 */
const ACTIVE_POLL_MS = 2_500;
const IDLE_POLL_MS = 12_000;

/**
 * How long the server may hold a poll open before answering "nothing yet".
 *
 * Under the service's own 25s ceiling so the server is what ends the hold.
 * This is what removes the dead time between a reply being written and the
 * next tick noticing: there is no next tick, the open request answers.
 */
const POLL_HOLD_MS = 20_000;

/**
 * A response faster than this did not involve a hold — either it carried news,
 * or the server predates `wait` and answered straight away.
 */
const HELD_THRESHOLD_MS = 2_000;

/**
 * A poll that has not answered in this long is not going to answer usefully —
 * the next tick asks again from the same cursor anyway. It has to clear the
 * hold itself, or every held poll would abort as a client timeout.
 */
const POLL_TIMEOUT_MS = POLL_HOLD_MS + 15_000;

/**
 * How long to wait before asking again, given what the last poll did.
 *
 * A held connection already did the waiting, so the next request goes out at
 * once — that is what makes a reply appear when it is written rather than up
 * to a full interval later. An instant answer falls back to the timed cadence,
 * which is the only thing keeping an older server from turning this loop into
 * a spin.
 */
export function nextPollDelayMs(input: {
  elapsedMs: number;
  carriedNews: boolean;
  turnActive: boolean;
}): number {
  if (input.elapsedMs >= HELD_THRESHOLD_MS) return 0;
  if (input.carriedNews) return 250;
  return input.turnActive ? ACTIVE_POLL_MS : IDLE_POLL_MS;
}
/** How long to keep claiming live progress for one turn before saying so. */
const TURN_TIMEOUT_MS = 5 * 60 * 1000;

/** Per-turn settle bookkeeping, reset when a new task takes over. */
export interface TurnState {
  taskId: string;
  startedAt: number;
  sawAssistant: boolean;
  sawDecision: boolean;
  graceTicks: number;
}

/**
 * Refs the loop reads without re-subscribing, and the setters it reports
 * through. Everything here is owned by the component; the hook only borrows.
 */
export function useChatPolling({
  conversationId,
  setMessages,
  statusRef,
  asyncTurnRef,
  cursorRef,
  logRef,
  serverIdsRef,
  turnRef,
  pokePollRef,
  setAsyncNote,
  setAsyncTurn,
  setActivity,
  setLiveRecall,
  setPollTrouble,
  onTaskTerminal,
  keepPollingTask,
}: {
  conversationId: string;
  setMessages: Dispatch<SetStateAction<UIMessage[]>>;
  statusRef: RefObject<string>;
  asyncTurnRef: RefObject<AsyncTurn | null>;
  cursorRef: RefObject<string | null>;
  logRef: RefObject<UIMessage[]>;
  serverIdsRef: RefObject<Set<string> | null>;
  turnRef: RefObject<TurnState | null>;
  /** Lets a fresh turn wake the poll instead of waiting out an idle interval. */
  pokePollRef: RefObject<(() => void) | null>;
  setAsyncNote: Dispatch<SetStateAction<AsyncNote | null>>;
  setAsyncTurn: Dispatch<SetStateAction<AsyncTurn | null>>;
  setActivity: Dispatch<SetStateAction<ChatActivityItem[]>>;
  setLiveRecall: Dispatch<SetStateAction<RecallSource[] | null>>;
  setPollTrouble: Dispatch<SetStateAction<PollTrouble>>;
  onTaskTerminal?: (taskId: string, status: 'done' | 'failed' | 'cancelled') => void;
  /** Tasks blocking an unsent form draft must remain observed through parked states. */
  keepPollingTask?: (taskId: string) => boolean;
}): void {
  const onTaskTerminalRef = useRef(onTaskTerminal);
  onTaskTerminalRef.current = onTaskTerminal;
  const keepPollingTaskRef = useRef(keepPollingTask);
  keepPollingTaskRef.current = keepPollingTask;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the loop reads component-owned refs and stable setters by design — re-subscribing on every cursor move would restart the poll mid-conversation, so only a new conversation id does.
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    let nextDelayMs: number | undefined;
    const observation = new AbortController();
    let pollFailures = 0;
    const requestedCards = new Map<string, { taskId?: string; expires: number }>();
    // Kept locally too, so React is only poked when the state actually flips.
    let trouble: PollTrouble = null;
    const setTrouble = (next: PollTrouble) => {
      if (trouble === next || cancelled) return;
      trouble = next;
      setPollTrouble(next);
    };

    // One tick's rows, handed to mergeChatLog. `superseded` is the retraction
    // channel: a state row delivered by an earlier tick can be replaced by a
    // newer twin that arrives behind it (a crash-retry re-emitting a task's
    // stop notice), and the server names the losers.
    const mergeMessages = (incoming: UIMessage[], refreshed: UIMessage[], superseded: string[]) => {
      const arriving = [...incoming, ...refreshed];
      // The live recall note under the log exists only until its durable twin
      // — the recall part on the persisted reply — arrives; past that point it
      // is the same provenance shown twice.
      if (
        arriving.some((message) => message.role === 'assistant' && recallSourcesOf(message).length)
      ) {
        setLiveRecall(null);
      }
      for (const message of arriving) serverIdsRef.current?.add(message.id);
      const retracted = new Set(superseded);
      // A reply still streaming has no persisted twin yet, so leave replies
      // alone until it finishes. Reconciling the user's own turn is always safe
      // — it only ever removes a duplicate of something already on screen, and
      // that duplicate was visible for the whole stream before.
      const streaming = statusRef.current === 'streaming' || statusRef.current === 'submitted';
      setMessages((current) =>
        mergeChatLog(current, arriving, {
          serverIds: serverIdsRef.current ?? EMPTY_SERVER_IDS,
          streaming,
          retracted,
        }),
      );
    };

    const settle = (
      expectedTaskId: string,
      note: string | null,
      opts?: { retryable?: boolean },
    ) => {
      if (cancelled || asyncTurnRef.current?.taskId !== expectedTaskId) return;
      setAsyncNote(note ? { text: note, retryable: opts?.retryable ?? false } : null);
      setAsyncTurn(null);
      setActivity([]);
      turnRef.current = null;
    };

    const poll = async () => {
      if (cancelled) return;
      const turn = asyncTurnRef.current;
      // Nothing to catch up on while the tab is hidden, and a background tab
      // polling forever is the kind of thing that shows up on a phone battery.
      if (document.visibilityState !== 'visible') return schedule(turn);
      // Per-turn settle state, reset whenever a new task takes over.
      if (turn && turnRef.current?.taskId !== turn.taskId) {
        turnRef.current = {
          taskId: turn.taskId,
          startedAt: Date.now(),
          sawAssistant: false,
          sawDecision: false,
          graceTicks: PARK_GRACE_TICKS,
        };
      }
      const turnState = turn ? turnRef.current : null;
      // What this poll did, read by schedule() at the bottom to decide whether
      // the server held (ask again now) or answered at once (back off).
      let elapsedMs = 0;
      let carriedNews = false;
      try {
        const query = new URLSearchParams({ conversationId });
        if (turn) query.set('taskId', turn.taskId);
        if (cursorRef.current) query.set('cursor', cursorRef.current);
        for (const [id, request] of requestedCards) {
          const settled = logRef.current.some((message) =>
            (
              message.parts as Array<{
                type?: string;
                data?: { id?: string; refreshTaskId?: string; refreshState?: string };
              }>
            ).some(
              (part) =>
                part.type === 'data-card' &&
                part.data?.id === id &&
                !!request.taskId &&
                part.data.refreshTaskId === request.taskId &&
                ['idle', 'failed'].includes(part.data.refreshState ?? ''),
            ),
          );
          if (settled || (!request.taskId && request.expires < Date.now()))
            requestedCards.delete(id);
        }
        const refreshIds = unresolvedDecisionIds(logRef.current, new Set(requestedCards.keys()));
        if (refreshIds.length > 0) query.set('refresh', refreshIds.join(','));
        query.set('wait', String(POLL_HOLD_MS));
        // Still bounded, because poll() awaits this before rescheduling: the
        // deadline now clears the hold we asked for, so it catches a genuinely
        // hung request without cutting off a healthy one.
        const startedAt = Date.now();
        const res = await fetch(`/api/chat/status?${query.toString()}`, {
          signal: AbortSignal.any([observation.signal, AbortSignal.timeout(POLL_TIMEOUT_MS)]),
        });
        if (cancelled) return;
        elapsedMs = Date.now() - startedAt;
        // A dead session never recovers by polling — say so and stop asking.
        if (res.status === 401 || res.status === 403) {
          pollFailures = 0;
          setTrouble('expired');
          return;
        }
        if (res.ok) {
          pollFailures = 0;
          setTrouble(null);
          const data = (await res.json()) as {
            taskStatus: string | null;
            messages: UIMessage[];
            refreshed?: UIMessage[];
            superseded?: string[];
            nextCursor: string | null;
            hasMore: boolean;
            activity?: ChatActivityItem[];
          };
          if (cancelled) return;
          const sameTurn =
            !!turn && asyncTurnRef.current?.taskId === turn.taskId && turnRef.current === turnState;
          if (sameTurn) setActivity(data.activity ?? []);
          // `refreshed` is deliberately kept out of the settle checks below: a
          // re-read of a card already on screen is not this turn producing an
          // answer. `superseded` is likewise a removal, never new output.
          mergeMessages(data.messages, data.refreshed ?? [], data.superseded ?? []);
          carriedNews = data.messages.length > 0 || (data.superseded ?? []).length > 0;
          // The cursor deliberately lags behind rows too fresh to be safely
          // remembered (see CURSOR_SETTLE_MS in the application service), so a
          // tick can legitimately end where it began. Only chase the next page
          // when the cursor actually moved — otherwise this loop would re-ask
          // for the same page with no delay between tries.
          const advanced = Boolean(data.nextCursor) && data.nextCursor !== cursorRef.current;
          if (data.nextCursor) cursorRef.current = data.nextCursor;
          if (data.hasMore && advanced) {
            nextDelayMs = 0;
            return;
          }
          if (sameTurn && turnState && data.taskStatus) {
            turnState.sawAssistant ||= data.messages.some(
              (message) => message.role === 'assistant',
            );
            turnState.sawDecision ||= data.messages.some(hasDecisionPart);
            if (
              data.taskStatus === 'done' &&
              (turnState.sawAssistant || keepPollingTaskRef.current?.(turnState.taskId))
            ) {
              onTaskTerminalRef.current?.(turnState.taskId, 'done');
              return settle(turnState.taskId, null);
            }
            if (PARKED_TASK_STATUSES.has(data.taskStatus) && turnState.sawAssistant) {
              // Stop as soon as the card the park is waiting on is here.
              // Without one, keep polling for a bounded grace: the status can
              // be observed in the moment between the park commit and the
              // card's insert, and settling there loses the card.
              if (
                !keepPollingTaskRef.current?.(turnState.taskId) &&
                (turnState.sawDecision || turnState.graceTicks <= 0)
              )
                return settle(turnState.taskId, null);
              if (!keepPollingTaskRef.current?.(turnState.taskId)) turnState.graceTicks -= 1;
            }
            if (data.taskStatus === 'failed' || data.taskStatus === 'cancelled') {
              onTaskTerminalRef.current?.(turnState.taskId, data.taskStatus);
              return settle(
                turnState.taskId,
                `The task ${data.taskStatus === 'cancelled' ? 'was cancelled' : 'ended unsuccessfully'}.`,
                { retryable: true },
              );
            }
          }
        } else {
          pollFailures += 1;
          if (pollFailures >= 3) setTrouble('stale');
        }
      } catch {
        if (cancelled) return;
        // Transient poll failures retry on the next tick — but a thread that
        // has silently gone stale is indistinguishable from a quiet one, so a
        // streak of failures says so in the log.
        pollFailures += 1;
        if (pollFailures >= 3) setTrouble('stale');
      }
      // Give up on *waiting* for a long turn, not on the thread: the presence
      // row stops claiming live progress while the poll keeps running, so the
      // answer still lands on its own whenever the executor finishes.
      if (
        turnState &&
        asyncTurnRef.current?.taskId === turnState.taskId &&
        !keepPollingTaskRef.current?.(turnState.taskId) &&
        Date.now() - turnState.startedAt > TURN_TIMEOUT_MS
      ) {
        settle(turnState.taskId, 'Still working. The result will appear here when it finishes.');
        return schedule(null, { elapsedMs, carriedNews });
      }
      schedule(asyncTurnRef.current, { elapsedMs, carriedNews });
    };

    // A visibility change or a newly handed-off task can wake the loop while
    // the previous request is still in flight. Queue one follow-up instead of
    // allowing responses to race and move the cursor out of order.
    let pollInFlight = false;
    let pollQueued = false;
    const tick = async () => {
      if (pollInFlight) {
        pollQueued = true;
        return;
      }
      pollInFlight = true;
      nextDelayMs = undefined;
      try {
        await poll();
      } finally {
        pollInFlight = false;
        if (!cancelled && trouble !== 'expired') {
          window.clearTimeout(timer);
          const delay = pollQueued
            ? 0
            : (nextDelayMs ??
              nextPollDelayMs({
                elapsedMs: 0,
                carriedNews: false,
                turnActive: Boolean(asyncTurnRef.current),
              }));
          pollQueued = false;
          timer = window.setTimeout(tick, delay);
        }
      }
    };

    const schedule = (
      turn: { taskId: string } | null,
      last: { elapsedMs: number; carriedNews: boolean } = { elapsedMs: 0, carriedNews: false },
    ) => {
      if (cancelled) return;
      nextDelayMs = nextPollDelayMs({ ...last, turnActive: Boolean(turn) });
    };

    // Coming back to the tab should feel current immediately, not one idle
    // interval later.
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || cancelled || trouble === 'expired') return;
      window.clearTimeout(timer);
      void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    const onCardRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ cardId?: unknown; taskId?: unknown }>).detail;
      const id = detail?.cardId;
      if (typeof id !== 'string') return;
      requestedCards.set(id, {
        taskId: typeof detail.taskId === 'string' ? detail.taskId : undefined,
        expires: Date.now() + TURN_TIMEOUT_MS,
      });
      onVisible();
    };
    window.addEventListener(CARD_REFRESH_EVENT, onCardRefresh);
    pokePollRef.current = onVisible;
    void tick();
    return () => {
      cancelled = true;
      observation.abort();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(CARD_REFRESH_EVENT, onCardRefresh);
      pokePollRef.current = null;
    };
  }, [conversationId, setMessages]);
}
