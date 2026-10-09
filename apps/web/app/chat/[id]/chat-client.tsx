'use client';

import { useChat } from '@ai-sdk/react';
import { type CardForm, type CardFormValues, findCardForm } from '@assistant/persistence/card-form';
import { DefaultChatTransport, type UIMessage } from 'ai';
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Inbox,
  Loader2,
  LogOut,
  type LucideIcon,
  Route,
  Sparkles,
  Square,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import { requestBrowserSignOut } from '@/app/browser-signout';
import { destinationIcon, formatBadgeCount, useNavCommands } from '@/app/nav-commands';
import { cancelChatTask } from '@/app/tasks/actions';
import { latestTheme } from '@/lib/chat-cues';
import {
  type CompanionActivity,
  type CompanionThought,
  setCompanionState,
} from '@/lib/companion-bus';
import { BackLink, CountBadge, focusRing, microLabelClass } from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';
import { toolLabel } from '@/lib/views';
import { archiveConversation, changeConversationModel, restoreConversation } from '../actions';
import {
  type ChatOperationTurnFence,
  isCancelledBeforeAdmissionSend,
  isCurrentChatOperation,
  requestChatOperationCancellation,
} from '../chat-operation-cancellation-client';
import {
  beginCardFormOperation,
  blockCardFormDraftForTask,
  type CardFormDraft,
  type CardFormIdentity,
  cardFormCallbackGeneration,
  carryCardFormDraft,
  clearCardFormSessionStorage,
  discardCardFormDraft,
  formatCardFormMessage,
  markCardFormReviewed,
  parseActiveCardFormConflict,
  parseStaleCardFormConflict,
  readCardFormDraft,
  recordCardFormTask,
  releaseBlockedCardFormDraft,
  releaseStaleCardFormOperation,
  saveCardFormDraft,
  sessionScopedCardFormStorage,
  settleCardFormTask,
  updateCardFormValues,
} from './card-form-operations';
import { ChatErrorBanner } from './chat-error-banner';
import { ChatLog } from './chat-log';
import {
  type ChatErrorInfo,
  type ChatLogOrder,
  chatErrorInfo,
  createChatLogOrder,
  decodeRecallHeader,
  messageText,
  orderChatLog,
  RecallNote,
  type RecallSource,
} from './message-view';
import { useCardFormTaskObserver } from './use-card-form-task-observer';
import {
  type AsyncNote,
  type AsyncTurn,
  type ChatActivityItem,
  type PollTrouble,
  type TurnState,
  useChatPolling,
} from './use-chat-polling';

interface ChatClientProps {
  conversationId: string;
  formSessionScope?: string;
  title: string;
  /** The assistant's display name — the chat header shows who you're talking to. */
  agentName: string;
  /**
   * The zone every date in the log is formatted in. Server and client use the
   * same one so day dividers and times are in the first paint rather than
   * appearing after hydration and pushing the log down.
   */
  agentTimezone: string;
  /** The server's clock at render, so "Today" means the same on both sides. */
  renderedAt: string;
  initialMessages: UIMessage[];
  models: { id: string; label: string }[];
  modelOverride: string | null;
  goalTitle?: string;
  /** A task created by the goal form before this page opened. */
  initialAsyncTurn?: AsyncTurn;
  /** Where the idle thread poll resumes from — the newest message at render. */
  initialCursor?: string | null;
  archived: boolean;
  /** The one forever thread at /chat — it needs no title header of its own. */
  isPrimary: boolean;
  canArchive: boolean;
  initialNotice?: string;
  /** Pre-fills the composer (e.g. an "ask about this document" deep-link). */
  initialInput?: string;
}

/**
 * One entry in the "/" palette. Composer commands act on this chat; navigation
 * entries leave for another surface. The palette is the app's only menu, so
 * both kinds have to live in one list you can type at.
 */
type SlashEntry = {
  command: string;
  hint: string;
  icon: LucideIcon;
  /** Other spellings that match while typing. */
  aliases: string[];
} & ({ kind: 'command' } | { kind: 'destination'; href: string; label: string; count: number });

/**
 * Commands that stay in the composer. Picking one either completes it into the
 * field, where the command's own palette (/model) takes over, or applies on the
 * spot (/auto, /signout) and hands the composer back empty.
 */
const COMPOSER_COMMANDS: SlashEntry[] = [
  {
    kind: 'command',
    command: '/model',
    hint: 'Switch which model answers this chat',
    icon: Sparkles,
    aliases: [],
  },
  {
    kind: 'command',
    command: '/auto',
    hint: 'Act without asking for this turn',
    icon: Zap,
    aliases: ['autonomous'],
  },
];

const SIGN_OUT_COMMAND: SlashEntry = {
  kind: 'command',
  command: '/signout',
  hint: 'End this session',
  icon: LogOut,
  aliases: ['logout'],
};

/** A bare "/" lists everything; typing narrows on the command or an alias. */
function matchesToken(entry: SlashEntry, token: string): boolean {
  return (
    entry.command.slice(1).startsWith(token) ||
    entry.aliases.some((alias) => alias.startsWith(token))
  );
}

export function ChatClient({
  conversationId,
  formSessionScope,
  title,
  agentName,
  agentTimezone,
  renderedAt,
  initialMessages,
  models,
  modelOverride,
  goalTitle,
  initialAsyncTurn,
  initialCursor,
  archived,
  isPrimary,
  canArchive,
  initialNotice,
  initialInput,
}: ChatClientProps) {
  const router = useRouter();
  const currentConversationIdRef = useRef(conversationId);
  currentConversationIdRef.current = conversationId;
  const { destinations, signedIn } = useNavCommands();
  const [input, setInput] = useState(initialInput ?? '');
  const inputRef = useRef(initialInput ?? '');
  inputRef.current = input;
  const [formDraft, setFormDraft] = useState<CardFormDraft | null>(null);
  const [formDraftScope, setFormDraftScope] = useState(formSessionScope);
  const [formError, setFormError] = useState<string | null>(null);
  const formDraftRef = useRef<CardFormDraft | null>(null);
  const cardFormOperationRef = useRef<CardFormDraft['operation']>(undefined);
  const volatileFormConflictRef = useRef<{ taskId: string; operationId: string } | null>(null);
  const getFormStorage = useCallback(() => {
    if (!formSessionScope) throw new Error('The authenticated form session is unavailable.');
    return sessionScopedCardFormStorage(window.sessionStorage, formSessionScope);
  }, [formSessionScope]);
  const saveFormDraft = useCallback(
    (draft: CardFormDraft | null) => {
      formDraftRef.current = draft;
      cardFormOperationRef.current = draft?.operation;
      setFormDraft(draft);
      setFormDraftScope(formSessionScope);
    },
    [formSessionScope],
  );
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);
  const [isSwitching, startTransition] = useTransition();
  const [selectedModel, setSelectedModel] = useState(modelOverride);
  const [modelError, setModelError] = useState<string | null>(null);
  /** Keyboard cursor into the /model palette (arrow keys move it, Enter picks). */
  const [modelHighlight, setModelHighlight] = useState(0);
  /** Whether the scroller is pinned near the bottom (drives the jump pill). */
  const [atBottom, setAtBottom] = useState(true);
  /** New messages that arrived while scrolled up (the pill shows a dot). */
  const [unseenCount, setUnseenCount] = useState(0);
  /** Set when the route handed the turn to the executor — we poll until it settles. */
  const [asyncTurn, setAsyncTurn] = useState<AsyncTurn | null>(initialAsyncTurn ?? null);
  /** How an open turn ended. `retryable` offers to resend the opening message. */
  const [asyncNote, setAsyncNote] = useState<AsyncNote | null>(null);
  /** The silent poll loop's only surfaces: repeated failure, or a dead session. */
  const [pollTrouble, setPollTrouble] = useState<PollTrouble>(null);
  const [asyncActionError, setAsyncActionError] = useState<string | null>(null);
  const [operationCancellation, setOperationCancellation] = useState<{
    turn: ChatOperationTurnFence;
    phase: 'checking' | 'unknown';
  } | null>(null);
  const operationCancellationRef = useRef<typeof operationCancellation>(null);
  const activeOrdinaryOperationRef = useRef<(ChatOperationTurnFence & { taskId?: string }) | null>(
    null,
  );
  const ordinaryTurnTokenRef = useRef(0);
  const setOperationCancellationState = (state: typeof operationCancellation) => {
    operationCancellationRef.current = state;
    setOperationCancellation(state);
  };
  const [isCancellingAsync, startCancelTransition] = useTransition();
  const [activity, setActivity] = useState<ChatActivityItem[]>([]);
  /** Live provenance for the current streaming turn (the persisted part covers reloads). */
  const [liveRecall, setLiveRecall] = useState<RecallSource[] | null>(null);
  /** This-turn autonomy: one submitted turn can skip routine approvals. */
  const [autonomous, setAutonomous] = useState(false);
  const autonomousRef = useRef(false);
  autonomousRef.current = autonomous;
  const resetAutonomyAfterSubmitRef = useRef(false);
  /** One-shot "run it for real" reroute — arming, sending, and clearing below. */
  const forceRef = useRef(false);
  /** A failed send can put the exact text back into the composer without guesswork. */
  const [lastSubmittedText, setLastSubmittedText] = useState('');
  const admittingTurnRef = useRef(false);
  const mountedGenerationRef = useRef(0);
  const previousFormSessionScopeRef = useRef(formSessionScope);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each conversation change invalidates outstanding send observations.
  useEffect(
    () => () => {
      mountedGenerationRef.current += 1;
    },
    [conversationId],
  );
  useLayoutEffect(() => {
    const previous = previousFormSessionScopeRef.current;
    previousFormSessionScopeRef.current = formSessionScope;
    if (!previous || previous === formSessionScope) return;
    // A newly supplied scope came from the authenticated server render. Discard
    // the old session's local drafts and invalidate callbacks from its requests.
    mountedGenerationRef.current += 1;
    pendingOperationIdRef.current = null;
    activeOrdinaryOperationRef.current = null;
    operationCancellationRef.current = null;
    setOperationCancellation(null);
    volatileFormConflictRef.current = null;
    setAsyncTurn(null);
    setInput('');
    saveFormDraft(null);
    try {
      clearCardFormSessionStorage(window.sessionStorage, previous);
    } catch {
      setFormError('The previous browser session draft could not be cleared.');
    }
  }, [formSessionScope, saveFormDraft]);
  const pendingOperationIdRef = useRef<{
    id: string;
    autonomous: boolean;
    force: boolean;
  } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** What the autosize effect last wrote, and the text it measured — see below. */
  const appliedInputHeightRef = useRef(0);
  const previousInputRef = useRef(initialInput ?? '');
  const messageScrollerRef = useRef<HTMLDivElement>(null);
  /** The floating composer overlays the log — see the layout note on the form. */
  const [composerHeight, setComposerHeight] = useState(112);
  const stickToBottomRef = useRef(true);
  const previousMessageCountRef = useRef(initialMessages.length);
  /**
   * How long the transcript was when the reader last left the bottom. `null`
   * means there is no baseline because the reader is pinned there and the pill
   * it feeds cannot be showing — see the effect that maintains it.
   */
  const previousTranscriptLengthRef = useRef<number | null>(null);
  /** Messages present at mount render static; only genuinely new ones animate in. */
  const initialMessageIdsRef = useRef<Set<string> | null>(null);
  if (initialMessageIdsRef.current === null) {
    initialMessageIdsRef.current = new Set(initialMessages.map((message) => message.id));
  }
  const initialMessageIds = initialMessageIdsRef.current;
  /**
   * What the log has learned about sequence: where each message came into it,
   * and the send time parsed out of each one. Only the client's own messages
   * need the arrival half — they carry no send time to sort on — but every id
   * is recorded, so a message's place in the sequence is fixed the first time
   * it is seen and never recomputed. See orderChatLog.
   */
  const logOrderRef = useRef<ChatLogOrder>(createChatLogOrder());

  /**
   * How far the thread poll has read. This is deliberately a ref and not state:
   * it has to survive a turn settling, and re-running the poll effect on every
   * change would restart the loop mid-conversation.
   */
  const cursorRef = useRef<string | null>(initialCursor ?? null);
  /**
   * Ids the server has actually sent us. A message the client made itself — an
   * optimistic user turn, a reply still streaming — is not in here, which is
   * how the merge tells its own provisional copies from durable ones.
   */
  const serverIdsRef = useRef<Set<string> | null>(null);
  if (serverIdsRef.current === null) {
    serverIdsRef.current = new Set(initialMessages.map((message) => message.id));
  }
  /** Read inside the poll loop, which must not re-subscribe when these change. */
  const asyncTurnRef = useRef<AsyncTurn | null>(initialAsyncTurn ?? null);
  const statusRef = useRef<string>('ready');
  /** Lets the poll name the decision cards on screen without re-subscribing. */
  const logRef = useRef<UIMessage[]>(initialMessages);
  /** Per-turn settle bookkeeping, reset when a new task takes over. */
  const turnRef = useRef<TurnState | null>(null);
  /** Lets a fresh turn wake the poll instead of waiting out an idle interval. */
  const pokePollRef = useRef<(() => void) | null>(null);

  const setMessagesForReceiptRef = useRef<
    ((update: (messages: UIMessage[]) => UIMessage[]) => void) | null
  >(null);
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        body: { conversationId },
        // The server owns history. Sending only the new user turn keeps request
        // size flat and prevents a client from selecting model context.
        prepareSendMessagesRequest: ({ messages, body }) => {
          const latestUser = [...messages].reverse().find((message) => message.role === 'user');
          const cardFormOperation = cardFormOperationRef.current;
          const isCardFormOperation =
            !!cardFormOperation &&
            cardFormOperation.submission.operationId === pendingOperationIdRef.current?.id;
          // Read the toggle through a ref so the memoized transport always sees
          // its current value without re-creating on every keystroke.
          return {
            body: {
              ...body,
              autonomous: pendingOperationIdRef.current?.autonomous ?? autonomousRef.current,
              force: pendingOperationIdRef.current?.force ?? forceRef.current,
              clientOperationId: pendingOperationIdRef.current?.id ?? latestUser?.id,
              messages: latestUser ? [latestUser] : [],
              ...(isCardFormOperation ? { cardFormSubmission: cardFormOperation.submission } : {}),
            },
          };
        },
        // Wrap fetch to capture the routing headers set by the chat route.
        fetch: (async (info, init) => {
          // The request body is already built by now, so the one-shot reroute
          // flag clears here — error responses included, it can never leak into
          // an unrelated later send.
          forceRef.current = false;
          const generation = mountedGenerationRef.current;
          const formGeneration = cardFormCallbackGeneration();
          const operationId = pendingOperationIdRef.current?.id;
          const activeOrdinary = activeOrdinaryOperationRef.current;
          const capturedOrdinaryTurn =
            activeOrdinary && activeOrdinary.clientOperationId === operationId
              ? activeOrdinary
              : null;
          const cardFormOperation = cardFormOperationRef.current;
          const isCardFormOperation =
            !!cardFormOperation && cardFormOperation.submission.operationId === operationId;
          const headers = new Headers(init?.headers);
          if (isCardFormOperation) headers.set('x-chat-card-form', 'card-form-v1');
          const response = await fetch(info, { ...init, headers });
          if (
            generation !== mountedGenerationRef.current ||
            currentConversationIdRef.current !== conversationId ||
            formGeneration !== cardFormCallbackGeneration() ||
            operationId !== pendingOperationIdRef.current?.id
          )
            return response;
          if (capturedOrdinaryTurn && response.status === 409) {
            const body = (await response
              .clone()
              .json()
              .catch(() => null)) as unknown;
            if (
              generation !== mountedGenerationRef.current ||
              currentConversationIdRef.current !== conversationId ||
              operationId !== pendingOperationIdRef.current?.id ||
              !isCurrentChatOperation(activeOrdinaryOperationRef.current, capturedOrdinaryTurn)
            )
              return response;
            if (isCancelledBeforeAdmissionSend(body, capturedOrdinaryTurn)) {
              // A cancellation-first send is a terminal receipt, never an
              // accepted stream or a reason to mint a replacement operation.
              activeOrdinaryOperationRef.current = null;
              pendingOperationIdRef.current = null;
              operationCancellationRef.current = null;
              setOperationCancellation(null);
              setAsyncTurn(null);
              setActivity([]);
              setAsyncNote({
                text: 'This message was stopped before it was admitted. No task started.',
                retryable: false,
              });
              setMessagesForReceiptRef.current?.((rows) =>
                rows.filter(
                  (message) =>
                    !(
                      message.role === 'user' &&
                      message.id === capturedOrdinaryTurn.clientOperationId
                    ),
                ),
              );
              return response;
            }
          }
          let blockedOnActiveTask = false;
          if (isCardFormOperation && cardFormOperation && response.status === 409) {
            const body = (await response
              .clone()
              .json()
              .catch(() => null)) as unknown;
            if (
              generation !== mountedGenerationRef.current ||
              formGeneration !== cardFormCallbackGeneration()
            )
              return response;
            const conflict = parseActiveCardFormConflict(body);
            if (conflict) {
              const current = formDraftRef.current;
              if (current?.operation?.submission.operationId === operationId) {
                try {
                  saveFormDraft(
                    blockCardFormDraftForTask({
                      storage: getFormStorage(),
                      draft: current,
                      operationId,
                      taskId: conflict.taskId,
                      taskStatus: conflict.taskStatus,
                    }),
                  );
                  setInput(cardFormOperation.submission.ownerMessageText);
                  setFormError(
                    'Another request for this form is still running. Your message remains an unsent draft. Send it again after that task finishes.',
                  );
                  setAsyncNote(null);
                  setAsyncActionError(null);
                  setAsyncTurn({ taskId: conflict.taskId, cursor: cursorRef.current ?? '' });
                  pendingOperationIdRef.current = null;
                  blockedOnActiveTask = true;
                  setMessagesForReceiptRef.current?.((currentMessages) =>
                    currentMessages.filter(
                      (message) => !(message.role === 'user' && message.id === operationId),
                    ),
                  );
                } catch {
                  volatileFormConflictRef.current = { taskId: conflict.taskId, operationId };
                  setInput(cardFormOperation.submission.ownerMessageText);
                  setAsyncTurn({ taskId: conflict.taskId, cursor: cursorRef.current ?? '' });
                  pendingOperationIdRef.current = null;
                  setFormError(
                    'Another form request is active. This message is still saved here; check that task before trying again.',
                  );
                }
              }
            }
          }
          if (blockedOnActiveTask) return response;
          if (isCardFormOperation && response.status === 409) {
            const body = (await response
              .clone()
              .json()
              .catch(() => null)) as unknown;
            if (
              generation !== mountedGenerationRef.current ||
              formGeneration !== cardFormCallbackGeneration()
            )
              return response;
            const stale = parseStaleCardFormConflict(body);
            const current = formDraftRef.current;
            if (
              stale &&
              operationId &&
              current?.operation?.submission.operationId === operationId
            ) {
              const submission = current.operation.submission;
              saveFormDraft(
                releaseStaleCardFormOperation({
                  storage: getFormStorage(),
                  draft: current,
                  operationId,
                }),
              );
              pendingOperationIdRef.current = null;
              volatileFormConflictRef.current = null;
              setInput(submission.ownerMessageText);
              setFormError(
                'This card changed before your message was accepted. Review its current form, then send again.',
              );
              setMessagesForReceiptRef.current?.((rows) =>
                rows.filter((message) => !(message.role === 'user' && message.id === operationId)),
              );
              return response;
            }
          }
          const ownerMessageId = response.headers.get('x-owner-message-id');
          if (ownerMessageId && operationId) {
            setMessagesForReceiptRef.current?.((current) =>
              current.map((message) =>
                message.role === 'user' && message.id === operationId
                  ? {
                      ...message,
                      metadata: {
                        ...(message.metadata as object | undefined),
                        durableMessageId: ownerMessageId,
                      },
                    }
                  : message,
              ),
            );
          }
          const modelId = response.headers.get('x-model-id');
          const degraded = response.headers.get('x-model-degraded') === 'true';
          setFallbackNote(degraded && modelId ? `responded with ${modelId} (fallback)` : null);
          setLiveRecall(decodeRecallHeader(response.headers.get('x-recall')));
          const taskId = response.headers.get('x-async-task');
          const cursor = response.headers.get('x-message-cursor');
          if (
            taskId &&
            capturedOrdinaryTurn &&
            isCurrentChatOperation(activeOrdinaryOperationRef.current, capturedOrdinaryTurn)
          )
            activeOrdinaryOperationRef.current = { ...capturedOrdinaryTurn, taskId };
          setAsyncTurn(taskId && cursor ? { taskId, cursor } : null);
          if (isCardFormOperation && cardFormOperation && operationId) {
            if (taskId && cursor) {
              try {
                const current = formDraftRef.current;
                if (current?.operation?.submission.operationId === operationId) {
                  saveFormDraft(
                    recordCardFormTask({
                      storage: getFormStorage(),
                      draft: current,
                      operationId,
                      taskId,
                      cursor,
                    }),
                  );
                  if (inputRef.current.trim() === cardFormOperation.submission.ownerMessageText)
                    setInput('');
                }
              } catch {
                volatileFormConflictRef.current = { taskId, operationId };
                setAsyncTurn({ taskId, cursor });
                setFormError('The task started. Check its status before trying again.');
              }
            } else if (response.status === 400 || response.status === 422) {
              const current = formDraftRef.current;
              if (current?.operation?.submission.operationId === operationId) {
                const released = { ...current, operation: undefined };
                try {
                  saveCardFormDraft(getFormStorage(), released);
                  saveFormDraft(released);
                  setFormError(
                    'This form could not be sent. Review the current card and try again.',
                  );
                } catch {
                  setFormError(
                    'This form was rejected, but its local retry state could not be saved. Keep this chat open and retry when browser storage is available.',
                  );
                }
              }
            }
          }
          if (taskId) {
            setAsyncNote(null);
            setAsyncActionError(null);
          }
          return response;
        }) as typeof fetch,
      }),
    [conversationId, getFormStorage, saveFormDraft],
  );

  const { messages, sendMessage, setMessages, status, error, clearError, stop } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
  });
  // The poll loop reads these without re-subscribing on every change.
  statusRef.current = status;
  asyncTurnRef.current = asyncTurn;

  /**
   * The log as it is read: ordered once, in one place, from the merged set.
   *
   * An action turn's hand-off arrives as a transient data part, which never
   * enters the message list — the presence UI reports the work instead, so
   * nothing here has to recognise and drop a placeholder.
   */
  setMessagesForReceiptRef.current = setMessages;
  const log = useMemo(() => orderChatLog(messages, logOrderRef.current), [messages]);
  logRef.current = log;

  useEffect(() => {
    setSelectedModel(modelOverride);
  }, [modelOverride]);

  useEffect(() => {
    saveFormDraft(null);
    pendingOperationIdRef.current = null;
    activeOrdinaryOperationRef.current = null;
    operationCancellationRef.current = null;
    setOperationCancellation(null);
    setFormError(null);
    try {
      if (!formSessionScope) {
        setFormError('Form drafts are unavailable for this browser session.');
        return;
      }
      const draft = readCardFormDraft(getFormStorage(), conversationId);
      if (!draft) return;
      saveFormDraft(draft);
      if (draft.blockedByTask) {
        setInput(draft.blockedByTask.submission.ownerMessageText);
        setAsyncTurn({ taskId: draft.blockedByTask.taskId, cursor: cursorRef.current ?? '' });
      } else if (draft.operation) {
        const operation = draft.operation;
        pendingOperationIdRef.current = {
          id: operation.submission.operationId,
          autonomous: false,
          force: false,
        };
        if (operation.taskId && operation.cursor) {
          setAsyncTurn({ taskId: operation.taskId, cursor: operation.cursor });
          if (draft.composerText !== undefined) setInput(draft.composerText);
        } else {
          setInput(operation.submission.ownerMessageText);
        }
      } else if (draft.composerText !== undefined) {
        setInput(draft.composerText);
      }
    } catch {
      setFormError(
        'The saved form request could not be restored. Keep this chat open and try again.',
      );
    }
  }, [conversationId, formSessionScope, getFormStorage, saveFormDraft]);

  // The elevated mode belongs to exactly one turn. Wait until useChat has
  // accepted the request so the memoized transport can read the submitted
  // value, then return the composer to its safer default.
  useEffect(() => {
    if (resetAutonomyAfterSubmitRef.current && (status === 'submitted' || status === 'streaming')) {
      resetAutonomyAfterSubmitRef.current = false;
      setAutonomous(false);
    }
  }, [status]);

  const formCallbackGenerationAtRender = cardFormCallbackGeneration();

  const handleFormTaskTerminal = useCallback(
    (taskId: string, status: 'done' | 'failed' | 'cancelled') => {
      if (formCallbackGenerationAtRender !== cardFormCallbackGeneration()) return;
      const current = formDraftRef.current;
      if (!current) return;
      const ownsTask =
        current.operation?.taskId === taskId ||
        current.blockedByTask?.taskId === taskId ||
        volatileFormConflictRef.current?.taskId === taskId;
      if (ownsTask && asyncTurnRef.current?.taskId === taskId) {
        // The exact form observer can finish before foreground polling sees
        // an assistant message. Release that turn without touching a reply.
        setAsyncTurn(null);
        setAsyncNote(null);
        setActivity([]);
        turnRef.current = null;
      }
      try {
        const blocked = current.blockedByTask;
        if (blocked?.taskId === taskId) {
          const released = releaseBlockedCardFormDraft({
            storage: getFormStorage(),
            draft: current,
            taskId,
            status,
          });
          saveFormDraft(released);
          setInput((text) => text || released.composerText || blocked.submission.ownerMessageText);
          setFormError(
            'The earlier request has finished. Review this message and press Send to try again.',
          );
          return;
        }
        const volatile = volatileFormConflictRef.current;
        if (volatile?.taskId === taskId && ['done', 'failed', 'cancelled'].includes(status)) {
          const submission = current.operation?.submission;
          volatileFormConflictRef.current = null;
          pendingOperationIdRef.current = null;
          if (submission) {
            const released = {
              ...current,
              operation: undefined,
              reviewed: true,
              composerText: submission.ownerMessageText,
              releasedBlockedTask: true,
            };
            try {
              saveCardFormDraft(getFormStorage(), released);
            } catch {
              /* Keep the exact task result in this tab if storage is unavailable. */
            }
            saveFormDraft(released);
            setInput((text) => text || submission.ownerMessageText);
          }
          setFormError(
            'The earlier request has finished. Review this message and press Send to try again.',
          );
          return;
        }
        const settled = settleCardFormTask({
          storage: getFormStorage(),
          draft: current,
          taskId,
          status,
        });
        if (
          current.operation?.taskId === taskId &&
          ['done', 'failed', 'cancelled'].includes(status)
        ) {
          pendingOperationIdRef.current = null;
          if (settled === null) {
            saveFormDraft(null);
            setInput((text) =>
              text === current.operation?.submission.ownerMessageText ? '' : text,
            );
            setFormError(null);
          } else {
            saveFormDraft(settled);
            setInput((text) => text || settled.composerText || '');
            setFormError(
              'This request did not finish. Review the message and press Send to try again.',
            );
          }
          return;
        }
        saveFormDraft(settled);
      } catch {
        setFormError(
          'The exact task finished, but its local status could not be saved. Reload this chat to confirm.',
        );
      }
    },
    [formCallbackGenerationAtRender, getFormStorage, saveFormDraft],
  );
  const volatileFormTask = volatileFormConflictRef.current;
  const observedFormTask = formDraft?.blockedByTask
    ? { taskId: formDraft.blockedByTask.taskId }
    : formDraft?.operation?.taskId
      ? { taskId: formDraft.operation.taskId, cursor: formDraft.operation.cursor }
      : volatileFormTask
        ? { taskId: volatileFormTask.taskId, cursor: cursorRef.current ?? undefined }
        : null;
  useCardFormTaskObserver({
    conversationId,
    task: observedFormTask,
    onTerminal: handleFormTaskTerminal,
    onUnavailable: () =>
      setFormError(
        'The form task could not be checked in this session. Keep its message and retry after refreshing Activity.',
      ),
  });

  // One poll for the whole thread, for as long as the page is open. Form tasks
  // have their own exact observer so a parked task cannot lock the composer.
  useChatPolling({
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
    onTaskTerminal: handleFormTaskTerminal,
  });

  // Sending a turn must not wait out an idle interval before the poll notices
  // the new task — re-tick as soon as one is handed over.
  useEffect(() => {
    if (asyncTurn) pokePollRef.current?.();
  }, [asyncTurn]);

  // One instant for every relative day label, taken from the server's clock, so
  // the markup the browser hydrates matches the markup it was sent.
  const renderedNow = useMemo(() => new Date(renderedAt), [renderedAt]);
  const observedFormTaskId = observedFormTask?.taskId;
  const formAdmissionAwaitingReceipt =
    !!formDraft?.operation &&
    !formDraft.operation.taskId &&
    pendingOperationIdRef.current?.id === formDraft.operation.submission.operationId;
  const cancellationUnresolved = operationCancellation?.turn.conversationId === conversationId;
  const busy =
    status === 'submitted' ||
    status === 'streaming' ||
    (asyncTurn !== null && asyncTurn.taskId !== observedFormTaskId) ||
    cancellationUnresolved;

  // Pinned to 'default' by owner decision (see chat-cues.test.ts) — the call
  // is constant-time, so it needs no memo of its own; the attribute below stays
  // wired up so the themes in globals.css can be turned back on in one place.
  const chatTheme = latestTheme(log);
  const companionActivity: CompanionActivity =
    status === 'submitted'
      ? 'thinking'
      : status === 'streaming'
        ? 'speaking'
        : asyncTurn
          ? 'working'
          : 'listening';

  /*
   * What the island says the model is doing — its inner monologue, one line at
   * a time.
   *
   * The newest tool step wins while a task is running, because that is the
   * thing actually happening; the two turn-level states cover the gap before
   * any tool has reported. Labels come from toolLabel, the same source the work
   * trail reads, so the island and the log never describe one step two ways.
   */
  const latestStep = activity.length > 0 ? activity[activity.length - 1] : undefined;
  const thought = useMemo<CompanionThought | null>(() => {
    if (status === 'submitted') return { label: 'Thinking', tone: 'thinking' };
    if (status === 'streaming') return { label: 'Replying', tone: 'working' };
    if (!asyncTurn) return null;
    if (!latestStep) return { label: 'Starting the work', tone: 'working' };
    const label = toolLabel(latestStep.toolName);
    if (latestStep.status === 'failed' || latestStep.status === 'denied') {
      return { label, tone: 'failed' };
    }
    if (latestStep.status === 'awaiting_approval') return { label, tone: 'waiting' };
    if (latestStep.status === 'succeeded') return { label, tone: 'done' };
    return { label, tone: 'working' };
  }, [status, asyncTurn, latestStep]);

  // Hand it to the island at the top of the screen. The bus compares thoughts
  // by value and drops no-op patches, so this runs on every render without
  // restarting the animation it is already playing.
  useEffect(() => {
    setCompanionState({ activity: companionActivity, thought });
  }, [companionActivity, thought]);

  // A chat left open should not keep claiming the island once you navigate
  // away; the shell's own presence takes back over.
  useEffect(() => {
    return () => {
      setCompanionState({ activity: 'idle', thought: null });
    };
  }, []);

  const displayTitle = title === 'Untitled' ? 'New conversation' : title;
  const notificationMode = displayTitle.toLowerCase() === 'notifications';
  const commandInput = input.trimStart();
  const modelCommandOpen = /^\/model(?:\s.*)?$/i.test(commandInput);
  const modelQuery = modelCommandOpen
    ? commandInput
        .replace(/^\/model\s*/i, '')
        .trim()
        .toLowerCase()
    : '';
  const modelOptions = useMemo(
    () =>
      [
        {
          id: null,
          label: 'Auto',
          detail: 'Use the best model for the request',
        },
        ...models.map((model) => ({ ...model, detail: model.id })),
      ].filter(
        (model) =>
          modelQuery === '' ||
          model.label.toLowerCase().includes(modelQuery) ||
          model.detail.toLowerCase().includes(modelQuery),
      ),
    [models, modelQuery],
  );
  const selectedModelLabel =
    selectedModel === null
      ? 'Auto'
      : (models.find((model) => model.id === selectedModel)?.label ?? selectedModel);

  // The "/" affordance: a bare slash token lists everything the composer can
  // do and everywhere the app can go, so nobody has to already know "/model" or
  // hunt for a menu. Once the token completes into a real command, that
  // command's own palette takes over (modelCommandOpen above).
  //
  // Composer commands sort ahead of destinations, and the two render as
  // separate groups — but they share one flat match list, so the arrow keys
  // walk the whole palette without knowing the groups exist.
  const slashEntries = useMemo<SlashEntry[]>(
    () => [
      ...COMPOSER_COMMANDS,
      ...(signedIn ? [SIGN_OUT_COMMAND] : []),
      ...destinations.map(
        (destination): SlashEntry => ({
          kind: 'destination',
          command: destination.command,
          hint: destination.hint,
          icon: destinationIcon(destination.href),
          aliases: destination.aliases,
          href: destination.href,
          label: destination.label,
          count: destination.count,
        }),
      ),
    ],
    [destinations, signedIn],
  );
  const slashToken =
    /^\/\S*$/.test(commandInput) && !modelCommandOpen ? commandInput.slice(1).toLowerCase() : null;
  const commandMatches =
    slashToken !== null ? slashEntries.filter((entry) => matchesToken(entry, slashToken)) : [];
  const commandPaletteOpen = commandMatches.length > 0;
  const composerMatches = commandMatches.filter((entry) => entry.kind === 'command');
  const destinationMatches = commandMatches.filter((entry) => entry.kind === 'destination');
  /** There is something to send, and nothing in the way of sending it. */
  const canSend =
    !busy && input.trim() !== '' && !modelCommandOpen && !commandPaletteOpen && !isSwitching;
  const [commandHighlight, setCommandHighlight] = useState(0);
  // Clamp instead of resetting via effect — the list is tiny and refilters
  // on every keystroke, so an out-of-range cursor just snaps to the end.
  const safeCommandHighlight = Math.min(commandHighlight, Math.max(0, commandMatches.length - 1));

  const runCommand = (entry: SlashEntry) => {
    // A destination leaves the chat, so the token goes with it — coming back to
    // a composer still holding "/settings" would read as an unsent draft.
    if (entry.kind === 'destination') {
      setInput('');
      router.push(entry.href);
      return;
    }
    // /auto and /signout are actions, not prefixes: they have no palette of
    // their own to hand off to, so they apply on the spot and give the composer
    // back empty rather than leaving a token the reader has to clear.
    if (entry.command === '/auto') {
      setAutonomous((value) => !value);
      setInput('');
      textareaRef.current?.focus();
      return;
    }
    if (entry.command === '/signout') {
      setInput('');
      void requestBrowserSignOut()
        .then((destination) => {
          clearCardFormSessionStorage(window.sessionStorage);
          window.location.assign(destination);
        })
        .catch(() => setAsyncActionError('Could not sign out. Try again.'));
      return;
    }
    setInput(entry.command);
    textareaRef.current?.focus();
  };

  // Every row reads the same way — the token you typed, then what it does —
  // so a destination is not a different kind of object from a command, just a
  // command that happens to leave. The badge is the only extra a row can carry.
  const renderCommandOption = (entry: SlashEntry, index: number) => {
    const highlighted = index === safeCommandHighlight;
    const EntryIcon = entry.icon;
    const count = entry.kind === 'destination' ? entry.count : 0;
    return (
      <button
        key={entry.command}
        id={`command-option-${index}`}
        type="button"
        role="option"
        aria-selected={highlighted}
        aria-label={`${entry.command}, ${entry.hint}${
          count > 0 ? `, ${count} waiting for you` : ''
        }`}
        onMouseMove={() => setCommandHighlight(index)}
        onClick={() => runCommand(entry)}
        className={`mobile-touch-target flex min-h-11 w-full min-w-0 items-center gap-3 rounded-[var(--radius-shell-inset-6)] px-3 py-2 text-left motion-safe:transition-colors ${focusRing} ${
          highlighted ? 'bg-sunken text-strong' : 'text-strong hover:bg-sunken'
        }`}
      >
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <EntryIcon className="size-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-sm font-medium">{entry.command}</span>
          <span className="block truncate text-xs text-muted">{entry.hint}</span>
        </span>
        {count > 0 ? (
          <span aria-hidden="true">
            <CountBadge tone="amber">{formatBadgeCount(count)}</CountBadge>
          </span>
        ) : null}
      </button>
    );
  };

  // A heading only earns its space when there is something to tell apart, so
  // the labels appear once a filter still leaves both kinds of entry standing.
  const showGroupLabels = composerMatches.length > 0 && destinationMatches.length > 0;

  const renderCommandGroup = (label: string, entries: SlashEntry[], offset: number) => (
    // A `group` inside a `listbox` is the ARIA pattern for exactly this; the
    // semantic element the rule wants (`fieldset`) is form markup and would be
    // invalid as a listbox child.
    // biome-ignore lint/a11y/useSemanticElements: listbox sections are ARIA groups
    <div role="group" aria-label={label}>
      {showGroupLabels ? (
        <p
          aria-hidden="true"
          className={`px-3 pt-2.5 pb-1 first:pt-1 ${microLabelClass} text-muted`}
        >
          {label}
        </p>
      ) : null}
      {entries.map((entry, index) => renderCommandOption(entry, offset + index))}
    </div>
  );

  // Opening the palette (or refiltering it) lands the cursor on the current
  // model, or the top match when it's filtered out.
  useEffect(() => {
    if (!modelCommandOpen) return;
    const selectedIndex = modelOptions.findIndex((model) => model.id === selectedModel);
    setModelHighlight(selectedIndex >= 0 ? selectedIndex : 0);
  }, [modelCommandOpen, modelOptions, selectedModel]);

  // Keep the highlighted option in view as the arrows walk the list. Both
  // palettes scroll now — the "/" list carries every destination in the app.
  useEffect(() => {
    if (!modelCommandOpen) return;
    document.getElementById(`model-option-${modelHighlight}`)?.scrollIntoView({ block: 'nearest' });
  }, [modelCommandOpen, modelHighlight]);

  useEffect(() => {
    if (!commandPaletteOpen) return;
    document
      .getElementById(`command-option-${safeCommandHighlight}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [commandPaletteOpen, safeCommandHighlight]);

  // Follow the newest message down while the reader is pinned to the bottom.
  //
  // This used to run after every render with no dependencies at all, which
  // meant a forced layout (`scrollHeight`) and a scroll write on every
  // keystroke, every resize of the composer and every scroll event — the
  // scroller was re-measured constantly to discover that nothing had moved.
  // The dependencies below are everything this column can grow by: the log
  // itself, the space reserved for the composer, and the few notes appended
  // under it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are triggers to re-measure on, not values the effect reads
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const scroller = messageScrollerRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [log, composerHeight, liveRecall, asyncNote, asyncActionError, pollTrouble]);

  /*
   * Whether the scroller is pinned to the bottom, measured once per frame
   * rather than once per scroll event.
   *
   * A scroll fires far more often than it changes this answer, and reading
   * `scrollHeight` inside the event handler forced layout in the middle of the
   * gesture — while a stream was landing, that was a synchronous re-layout of
   * the whole transcript on every event. Coalescing into an animation frame
   * moves the read to the point where layout has already settled, and a
   * passive listener keeps it off the critical path of the gesture. React
   * drops the state writes when the answer has not changed, so an ordinary
   * scroll now re-renders nothing at all.
   */
  useEffect(() => {
    const scroller = messageScrollerRef.current;
    if (!scroller) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
      stickToBottomRef.current = bottom;
      setAtBottom(bottom);
      if (bottom) setUnseenCount(0);
    };
    const onScroll = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  // A message or streamed text landed while the reader was scrolled up — keep
  // the jump pill meaningful even when the message count itself did not grow.
  //
  // Summing the whole transcript is O(everything said so far), and it ran on
  // every streamed token. The pill it feeds only exists while the reader is
  // scrolled away, so while pinned to the bottom the sum is skipped and the
  // baseline is dropped; leaving the bottom re-establishes it from the log as
  // it stands, which is the only moment its value is ever read.
  useEffect(() => {
    const addedMessages = Math.max(0, log.length - previousMessageCountRef.current);
    previousMessageCountRef.current = log.length;
    if (stickToBottomRef.current) {
      previousTranscriptLengthRef.current = null;
      return;
    }
    const transcriptLength = log.reduce((total, message) => total + messageText(message).length, 0);
    const baseline = previousTranscriptLengthRef.current;
    previousTranscriptLengthRef.current = transcriptLength;
    if (baseline === null) return;
    const streamedTextGrew = transcriptLength > baseline;
    if (addedMessages > 0 || streamedTextGrew) {
      setUnseenCount((count) => (addedMessages > 0 ? count + addedMessages : Math.max(count, 1)));
    }
  }, [log]);

  // The composer floats over the conversation, so nothing in the log can rely
  // on it taking layout space. Measure the form and feed that height back two
  // ways: a negative top margin cancels the space it would occupy in the
  // column, and the scroller reserves it as bottom padding so the newest
  // message still clears the composer by the same 5rem the log keeps on top.
  useLayoutEffect(() => {
    const element = formRef.current;
    if (!element) return;
    let frame = 0;
    const commitHeight = (height: number) => {
      // WebKit may report sub-pixel border-box changes while the visual
      // viewport and safe-area settle. Round them, coalesce deliveries to one
      // animation frame, and do not write state when the effective height did
      // not change. This keeps ResizeObserver out of a synchronous layout /
      // setState feedback loop (React production error #185).
      const next = Math.max(0, Math.round(height));
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setComposerHeight((current) => (current === next ? current : next));
      });
    };
    commitHeight(element.offsetHeight);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) commitHeight(entry.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight);
    });
    observer.observe(element);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  // Grow the composer with its content, up to the CSS max-height cap. `input`
  // is the trigger; the new height is read from the DOM, not from `input`.
  //
  // Measuring shrinkage means collapsing the box to nothing and reading it
  // back, and that write-then-read is a forced synchronous layout. It used to
  // happen on every keystroke. It is only ever needed when the text got
  // shorter: a textarea already reports a `scrollHeight` larger than itself the
  // moment its content outgrows it, so growing needs no collapse, and typing
  // forward — the overwhelmingly common case — now costs a single clean read.
  // The applied height is remembered so an unchanged one is never written back,
  // which also keeps the form's ResizeObserver quiet.
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    const previous = previousInputRef.current;
    previousInputRef.current = input;
    const mayShrink = appliedInputHeightRef.current === 0 || input.length <= previous.length;
    if (mayShrink) element.style.height = '0px';
    const next = Math.min(element.scrollHeight, 160);
    if (next !== appliedInputHeightRef.current || mayShrink) {
      appliedInputHeightRef.current = next;
      element.style.height = `${next}px`;
    }
  }, [input]);

  const jumpToLatest = () => {
    stickToBottomRef.current = true;
    setAtBottom(true);
    setUnseenCount(0);
    const scroller = messageScrollerRef.current;
    if (!scroller) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  };

  const sendTurn = (
    text: string,
    clearComposer: boolean,
    retryOperation?: { id: string; autonomous: boolean; force: boolean },
  ) => {
    const pendingCancel = operationCancellationRef.current;
    if (pendingCancel && pendingCancel.turn.conversationId === conversationId) {
      forceRef.current = false;
      setAsyncActionError(
        'Stop is still unconfirmed. Retry Stop with the same message before sending another turn.',
      );
      return;
    }
    const unresolved = formDraftRef.current;
    const operation = unresolved?.operation;
    const volatileConflict = volatileFormConflictRef.current;
    if (operation && !operation.taskId) {
      const exactReplay =
        retryOperation?.id === operation.submission.operationId &&
        text.trim() === operation.submission.ownerMessageText;
      const ownerReplyDuringKnownConflict =
        volatileConflict?.operationId === operation.submission.operationId &&
        text.trim() !== operation.submission.ownerMessageText;
      if (!exactReplay && !ownerReplyDuringKnownConflict) {
        forceRef.current = false;
        setFormError(
          volatileConflict?.operationId === operation.submission.operationId
            ? 'This message is still waiting on that task. Send a different reply or wait for the task to finish.'
            : 'This request has not been confirmed yet. Retry the same message before starting another turn.',
        );
        return;
      }
    }
    if (
      unresolved?.blockedByTask &&
      text.trim() === unresolved.blockedByTask.submission.ownerMessageText
    ) {
      forceRef.current = false;
      setFormError(
        'Another request for this form is still running. Send a different reply or wait for that task to finish.',
      );
      return;
    }
    if (busy || admittingTurnRef.current || !text.trim()) return;
    admittingTurnRef.current = true;
    stickToBottomRef.current = true;
    setAtBottom(true);
    setUnseenCount(0);
    setLastSubmittedText(text);
    pendingOperationIdRef.current = retryOperation ?? {
      id: crypto.randomUUID(),
      autonomous: autonomousRef.current,
      force: forceRef.current,
    };
    const operationId = pendingOperationIdRef.current.id;
    const isFormOperation = unresolved?.operation?.submission.operationId === operationId;
    if (isFormOperation) {
      activeOrdinaryOperationRef.current = null;
      setOperationCancellationState(null);
    } else {
      const current = activeOrdinaryOperationRef.current;
      if (
        !current ||
        current.conversationId !== conversationId ||
        current.clientOperationId !== operationId ||
        current.scopeGeneration !== mountedGenerationRef.current
      ) {
        ordinaryTurnTokenRef.current += 1;
        activeOrdinaryOperationRef.current = {
          conversationId,
          clientOperationId: operationId,
          turnToken: ordinaryTurnTokenRef.current,
          scopeGeneration: mountedGenerationRef.current,
        };
      }
    }
    if (clearComposer) setInput('');
    setFallbackNote(null);
    setModelError(null);
    setLiveRecall(null);
    if (error) clearError();
    resetAutonomyAfterSubmitRef.current = autonomous;
    void sendMessage({
      id: pendingOperationIdRef.current.id,
      role: 'user',
      parts: [{ type: 'text', text }],
    }).finally(() => {
      admittingTurnRef.current = false;
    });
  };

  const submitCurrentMessage = () => {
    if (previousFormSessionScopeRef.current !== formSessionScope) {
      setFormError('The signed-in session changed. Wait for this chat to refresh before sending.');
      return;
    }
    const savedOperation = formDraftRef.current?.operation;
    if (
      savedOperation &&
      !savedOperation.taskId &&
      volatileFormConflictRef.current?.operationId !== savedOperation.submission.operationId
    ) {
      if (busy) return;
      const exactText = savedOperation.submission.ownerMessageText;
      setInput(exactText);
      pendingOperationIdRef.current = {
        id: savedOperation.submission.operationId,
        autonomous: false,
        force: false,
      };
      sendTurn(exactText, false, {
        id: savedOperation.submission.operationId,
        autonomous: false,
        force: false,
      });
      return;
    }
    const text = input.trim();
    const currentDraft = formDraftRef.current;
    if (
      currentDraft &&
      !currentDraft.reviewed &&
      !(currentDraft.releasedBlockedTask && currentDraft.composerText !== text)
    ) {
      setFormError('Review this form and its message, or clear the saved answers, before sending.');
      return;
    }
    if (!text || busy) return;
    // Slash commands are local composer controls, never conversation messages.
    if (/^\/model(?:\s.*)?$/i.test(text)) return;
    if (commandPaletteOpen) return;
    const draft = formDraftRef.current;
    if (
      draft?.reviewed &&
      !draft.blockedByTask &&
      !draft.operation &&
      !(draft.releasedBlockedTask && draft.composerText !== text)
    ) {
      let form: CardForm | null = null;
      for (const message of logRef.current) {
        const parts = message.parts as Array<{ type?: string; data?: unknown }>;
        for (const part of parts) {
          if (part.type !== 'data-card') continue;
          const card = part.data as Record<string, unknown> | undefined;
          if (
            card?.kind !== 'generated-card' ||
            card.id !== draft.identity.cardId ||
            card.revisionId !== draft.identity.revisionId
          )
            continue;
          const spec = card.spec as Record<string, unknown> | undefined;
          form = findCardForm(spec, draft.identity.formId);
          if (form) break;
        }
        if (form) break;
      }
      if (!form) {
        setFormError(
          'This card version is no longer available. Review the current card before sending.',
        );
        return;
      }
      try {
        const frozen = beginCardFormOperation({
          storage: getFormStorage(),
          draft,
          form,
          ownerMessageText: text,
          createId: () => window.crypto.randomUUID(),
        });
        saveFormDraft(frozen);
        setFormError(null);
        pendingOperationIdRef.current = {
          id: frozen.operation?.submission.operationId ?? '',
          autonomous: false,
          force: false,
        };
        sendTurn(text, false, {
          id: frozen.operation?.submission.operationId ?? '',
          autonomous: false,
          force: false,
        });
        return;
      } catch (error) {
        setFormError(error instanceof Error ? error.message : 'This form could not be sent.');
        return;
      }
    }
    sendTurn(text, true);
  };

  // The off-course card's fix: the same words again, but routed around the
  // classifier straight to the executor, where the tools are.
  const runForReal = (text: string) => {
    if (busy || admittingTurnRef.current || text.trim() === '') return;
    forceRef.current = true;
    sendTurn(text, false);
  };

  /*
   * The transcript is memoized, so the callbacks it holds must keep one
   * identity for the life of the page — otherwise every keystroke would hand
   * it new functions and defeat the memo. The refs carry the live closures, so
   * what runs is always the current `sendTurn`, not the one from mount.
   */
  const sendTurnRef = useRef(sendTurn);
  sendTurnRef.current = sendTurn;
  const runForRealRef = useRef(runForReal);
  runForRealRef.current = runForReal;
  const handleSend = useCallback((text: string) => sendTurnRef.current(text, false), []);
  const handleRunForReal = useCallback((text: string) => runForRealRef.current(text), []);

  const handleFormChange = useCallback(
    (identity: CardFormIdentity, _form: CardForm, values: CardFormValues) => {
      try {
        const wasReviewed = formDraftRef.current?.reviewed === true;
        const next = updateCardFormValues({
          storage: getFormStorage(),
          current: formDraftRef.current,
          identity,
          values,
        });
        saveFormDraft(next);
        if (wasReviewed) setInput('');
        setFormError(null);
      } catch (error) {
        setFormError(error instanceof Error ? error.message : 'Could not save this form draft.');
      }
    },
    [getFormStorage, saveFormDraft],
  );

  const handleFormReview = useCallback(
    (identity: CardFormIdentity, form: CardForm, values: CardFormValues) => {
      try {
        const draft = updateCardFormValues({
          storage: getFormStorage(),
          current: formDraftRef.current,
          identity,
          values,
        });
        const reviewed = markCardFormReviewed(
          getFormStorage(),
          draft,
          formatCardFormMessage(form, values),
        );
        saveFormDraft(reviewed);
        setFormError(null);
        setInput(formatCardFormMessage(form, values));
        window.requestAnimationFrame(() => textareaRef.current?.focus());
      } catch (error) {
        setFormError(error instanceof Error ? error.message : 'Could not prepare this message.');
      }
    },
    [getFormStorage, saveFormDraft],
  );

  const handleFormDiscard = useCallback(
    (identity: CardFormIdentity) => {
      const current = formDraftRef.current;
      if (
        !current ||
        current.operation ||
        current.blockedByTask ||
        current.identity.conversationId !== identity.conversationId
      )
        return;
      try {
        discardCardFormDraft(getFormStorage(), identity.conversationId);
        saveFormDraft(null);
        setFormError(null);
      } catch {
        setFormError('Could not clear the saved form answers.');
      }
    },
    [getFormStorage, saveFormDraft],
  );

  const handleFormCarry = useCallback(
    (identity: CardFormIdentity, form: CardForm) => {
      const current = formDraftRef.current;
      if (!current) return;
      try {
        const carried = carryCardFormDraft({
          storage: getFormStorage(),
          draft: current,
          identity,
          form,
        });
        saveFormDraft(carried);
        setFormError(null);
      } catch (error) {
        setFormError(
          error instanceof Error ? error.message : 'Could not carry these answers forward.',
        );
      }
    },
    [getFormStorage, saveFormDraft],
  );

  const closeModelPicker = () => {
    // You reach the picker by typing "/model" over whatever was in the
    // composer, so there is no draft of yours left to put back.
    setModelError(null);
    setInput('');
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const chooseModel = (modelId: string | null) => {
    if (isSwitching) return;
    setModelError(null);
    startTransition(async () => {
      try {
        await changeConversationModel(conversationId, modelId);
        setSelectedModel(modelId);
        closeModelPicker();
      } catch {
        setModelError('Could not switch models. Try again.');
      }
    });
  };

  const cancelOrdinaryOperation = (captured: ChatOperationTurnFence) => {
    if (operationCancellationRef.current?.phase === 'checking') return;
    const current = activeOrdinaryOperationRef.current;
    if (
      !isCurrentChatOperation(current, captured) ||
      mountedGenerationRef.current !== captured.scopeGeneration ||
      currentConversationIdRef.current !== captured.conversationId ||
      conversationId !== captured.conversationId ||
      pendingOperationIdRef.current?.id !== captured.clientOperationId
    )
      return;
    setAsyncActionError(null);
    setOperationCancellationState({ turn: captured, phase: 'checking' });
    startCancelTransition(async () => {
      const outcome = await requestChatOperationCancellation({
        conversationId: captured.conversationId,
        clientOperationId: captured.clientOperationId,
      });
      if (
        mountedGenerationRef.current !== captured.scopeGeneration ||
        currentConversationIdRef.current !== captured.conversationId ||
        conversationId !== captured.conversationId ||
        !isCurrentChatOperation(activeOrdinaryOperationRef.current, captured)
      )
        return;
      if (outcome.kind === 'unknown') {
        setOperationCancellationState({ turn: captured, phase: 'unknown' });
        setAsyncActionError(
          'Stop is unconfirmed. Retry Stop to check the same message; do not send it again yet.',
        );
        return;
      }
      setOperationCancellationState(null);
      setAsyncActionError(null);
      pendingOperationIdRef.current = null;
      if (outcome.outcome === 'cancelled_before_admission') {
        activeOrdinaryOperationRef.current = null;
        setAsyncTurn(null);
        setActivity([]);
        setAsyncNote({
          text: 'This message was stopped before it was admitted. No task started.',
          retryable: false,
        });
        setMessagesForReceiptRef.current?.((rows) =>
          rows.filter(
            (message) => !(message.role === 'user' && message.id === captured.clientOperationId),
          ),
        );
        return;
      }
      if (outcome.outcome === 'cancelled' || outcome.outcome === 'already_cancelled') {
        activeOrdinaryOperationRef.current = { ...captured, taskId: outcome.taskId };
        setAsyncTurn({ taskId: outcome.taskId, cursor: cursorRef.current ?? '' });
        setAsyncNote({
          text: 'Cancellation was recorded. A dispatched effect may still be in progress.',
          retryable: false,
        });
        return;
      }
      activeOrdinaryOperationRef.current = null;
      setAsyncTurn(null);
      setActivity([]);
      setAsyncNote({ text: 'This message had already finished.', retryable: false });
    });
  };

  const stopCurrentTurn = () => {
    const operationId = pendingOperationIdRef.current?.id;
    const formOperation = formDraftRef.current?.operation;
    const isFormOperation = !!formOperation && formOperation.submission.operationId === operationId;
    const streaming = status === 'submitted' || status === 'streaming';
    if (isFormOperation && !formOperation.taskId) {
      // This operation has no ordinary cancellation identity. Keep its frozen
      // form receipt and request body intact until the server answers.
      return;
    }
    if (streaming) stop();
    if (
      isFormOperation &&
      formOperation.taskId &&
      asyncTurnRef.current?.taskId === formOperation.taskId
    ) {
      cancelAsyncTurn();
      return;
    }

    const ordinary = activeOrdinaryOperationRef.current;
    if (
      ordinary &&
      ordinary.conversationId === conversationId &&
      ordinary.clientOperationId === operationId &&
      ordinary.scopeGeneration === mountedGenerationRef.current
    ) {
      cancelOrdinaryOperation(ordinary);
      return;
    }
    if (asyncTurnRef.current) cancelAsyncTurn();
  };

  const cancelAsyncTurn = () => {
    if (!asyncTurn || isCancellingAsync) return;
    const taskId = asyncTurn.taskId;
    const capturedConversationId = conversationId;
    const capturedConversationRef = currentConversationIdRef;
    const capturedScopeGeneration = mountedGenerationRef.current;
    const currentOrdinary = activeOrdinaryOperationRef.current;
    const capturedOrdinary = currentOrdinary?.taskId === taskId ? currentOrdinary : null;
    const isCurrentCancellation = () =>
      mountedGenerationRef.current === capturedScopeGeneration &&
      capturedConversationRef.current === capturedConversationId &&
      conversationId === capturedConversationId &&
      asyncTurnRef.current?.taskId === taskId &&
      (!capturedOrdinary ||
        (isCurrentChatOperation(activeOrdinaryOperationRef.current, capturedOrdinary) &&
          activeOrdinaryOperationRef.current?.taskId === taskId));
    setAsyncActionError(null);
    startCancelTransition(async () => {
      try {
        const result = await cancelChatTask(taskId);
        if (!isCurrentCancellation()) return;
        if (result.outcome === 'not_found' || result.outcome === 'no_longer_retriable') {
          setAsyncActionError(
            'This task is no longer available. Refresh Activity to see its current state.',
          );
          return;
        }
        setAsyncNote({
          text:
            result.outcome === 'cancelled'
              ? 'Stop requested. The task will stop at its next checkpoint.'
              : result.outcome === 'already_cancelled'
                ? 'This task was already stopped.'
                : 'This task had already finished.',
          retryable: result.outcome === 'cancelled' || result.outcome === 'already_cancelled',
        });
        if (
          formDraftRef.current?.operation?.taskId === taskId ||
          formDraftRef.current?.blockedByTask?.taskId === taskId
        ) {
          pokePollRef.current?.();
          return;
        }
        setAsyncTurn(null);
        setActivity([]);
      } catch {
        if (!isCurrentCancellation()) return;
        setAsyncActionError('Could not stop this task. Try again or open Activity.');
      }
    });
  };

  const errorInfo: ChatErrorInfo | null = error ? chatErrorInfo(error) : null;
  const visibleFormDraft = formDraftScope === formSessionScope ? formDraft : null;
  /** A failed turn can always be resent as-is; the draft is the escape hatch. */
  const retryLastTurn = () => {
    if (lastSubmittedText.trim() === '') return;
    clearError();
    sendTurn(lastSubmittedText, false, pendingOperationIdRef.current ?? undefined);
  };

  return (
    // Conversation CSS gives the log the space remaining below the real app
    // header. The log and composer share this flexible column; internal
    // padding supplies their breathing room without assuming a chrome height.
    //
    // The column widens on larger screens so the header/composer use the
    // space a floating rail plus a wide canvas otherwise leaves empty — but
    // User bubbles cap their own width separately, keeping a two-way exchange
    // conversational on a wide canvas. Assistant sheets and cards span this
    // whole column, matching the native transcript and keeping result surfaces
    // aligned with one another.
    <div
      data-chat-theme={chatTheme !== 'default' ? chatTheme : undefined}
      className="chat-viewport relative mx-auto flex min-h-0 w-full min-w-0 max-w-3xl flex-1 flex-col lg:max-w-4xl 2xl:max-w-[56rem]"
    >
      {/* The primary thread is the whole surface — it needs no title. Side and
          goal chats keep a slim header so you know which one you're in. */}
      {!isPrimary ? (
        // A side thread is a subpage like any other: it gets back to its parent
        // list, which gets back to the main thread. The "/" palette only exists
        // in the composer below, so this is the way out that is always visible.
        <header className="chat-heading border-b border-white/15 pt-7 pb-3 lg:pt-10">
          <BackLink href="/chat/all">All chats</BackLink>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h1
                className="truncate font-display text-lg font-semibold tracking-[-0.03em]"
                title={displayTitle}
              >
                {displayTitle}
              </h1>
              {goalTitle ? (
                <p className="mt-0.5 truncate text-xs text-stage-muted">
                  Working toward: {goalTitle}
                </p>
              ) : null}
              {archived ? (
                <p className="mt-0.5 text-xs text-stage-muted">
                  Archived — sending a message restores this chat.
                </p>
              ) : null}
            </div>
            {archived || canArchive ? (
              <div className="flex min-w-0 items-center gap-2">
                {archived ? (
                  <form action={restoreConversation.bind(null, conversationId)}>
                    <SubmitButton variant="outline" pendingLabel="Restoring…">
                      Restore
                    </SubmitButton>
                  </form>
                ) : canArchive ? (
                  <form action={archiveConversation.bind(null, conversationId)}>
                    <SubmitButton variant="outline" pendingLabel="Archiving…">
                      Archive
                    </SubmitButton>
                  </form>
                ) : null}
              </div>
            ) : null}
          </div>
        </header>
      ) : null}
      {initialNotice ? (
        <div
          role="alert"
          className="paper mt-3 rounded-xl border border-amber-300/80 bg-amber-50 px-4 py-2.5 text-sm leading-5 text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/60 dark:text-amber-100"
        >
          {initialNotice}
        </div>
      ) : null}

      <div
        ref={messageScrollerRef}
        role="log"
        aria-label="Conversation"
        style={{ paddingBottom: `calc(5rem + ${composerHeight}px)` }}
        className={`scroll-subtle min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto ${log.length === 0 ? 'pt-6' : 'pt-20'}`}
      >
        {/* A short thread rests on the composer instead of hanging from the top
            of the window with a void beneath it — `mt-auto` on the log (and
            `my-auto` on the opening screen) does that, while a thread long
            enough to overflow simply scrolls as before. */}
        <div className="flex min-h-full min-w-0 flex-col">
          {log.length === 0 ? (
            <div className="mx-auto flex max-w-xl flex-col items-center text-center my-auto">
              {isPrimary ? (
                <span className="inline-flex size-14 items-center justify-center rounded-2xl">
                  <Sparkles className="size-5" aria-hidden="true" />
                </span>
              ) : null}
              <p
                className={`${isPrimary ? 'mt-5' : ''} font-display text-2xl leading-8 font-semibold tracking-[-0.025em] text-balance`}
              >
                What should we move forward?
              </p>
              {/* A small hand-drawn stroke that sketches itself in under the
                greeting — the page's one flourish. Static for reduced motion. */}
              {isPrimary ? (
                <svg
                  aria-hidden="true"
                  viewBox="0 0 140 10"
                  fill="none"
                  className="mt-2 h-2.5 w-36"
                >
                  <path
                    d="M3 7 C 28 3, 55 8.5, 82 5 S 125 3.5, 137 5.5"
                    stroke="currentColor"
                    strokeOpacity="0.45"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    className="[stroke-dasharray:160] [stroke-dashoffset:160] motion-safe:animate-[draw-in_700ms_ease-out_250ms_forwards] motion-reduce:[stroke-dashoffset:0]"
                  />
                </svg>
              ) : null}
              <p className="mt-2 max-w-md text-base leading-6 text-pretty text-stage-muted">
                Start with an outcome. {agentName} can research, plan, draft, schedule, and keep
                following up when the work takes time.
              </p>
              <div className="mt-6 grid w-full gap-2 sm:grid-cols-3">
                {[
                  {
                    text: 'Summarize my unread email',
                    label: 'Clear the inbox',
                    icon: Inbox,
                  },
                  {
                    text: 'What’s on my calendar this week?',
                    label: 'Review the week',
                    icon: CalendarDays,
                  },
                  {
                    text: 'Draft a plan for my next trip',
                    label: 'Plan a trip',
                    icon: Route,
                  },
                ].map((suggestion, index) => {
                  const SuggestionIcon = suggestion.icon;
                  return (
                    <button
                      key={suggestion.text}
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        sendTurn(suggestion.text, false);
                      }}
                      style={{ animationDelay: `${index * 60}ms` }}
                      className={`mobile-touch-target flex min-h-20 flex-col items-start justify-between p-3 text-left motion-safe:animate-[presence-arrive_320ms_ease-out_both] disabled:opacity-60 ${focusRing}`}
                    >
                      <SuggestionIcon className="size-4 opacity-70" aria-hidden="true" />
                      <span className="mt-3 text-sm font-medium">{suggestion.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="mt-auto flex min-w-0 flex-col">
              <ChatLog
                log={log}
                busy={busy}
                streaming={status === 'streaming'}
                notificationMode={notificationMode}
                agentTimezone={agentTimezone}
                renderedNow={renderedNow}
                initialMessageIds={initialMessageIds}
                onSend={handleSend}
                onRunForReal={handleRunForReal}
                conversationId={conversationId}
                formDraft={visibleFormDraft}
                formSessionScope={formSessionScope}
                formError={formError}
                onChangeForm={handleFormChange}
                onReviewForm={handleFormReview}
                onCarryForm={handleFormCarry}
                onDiscardForm={handleFormDiscard}
              />
              {/* Nothing transient is written here any more.
               *
               * "Thinking…", "Working…" and the live work trail all used to
               * land in the log, and every one of them was a line that existed
               * for a few seconds and then meant nothing — pushing the reply
               * you were waiting for up the screen as it went. The island at
               * the top of the screen reports all of it now, in the place the
               * phone already uses for "something is happening", and announces
               * it to a screen reader from there (notch-companion.tsx). What
               * is left in the log is what stays true after the work ends.
               *
               * An error is one of those things, so it still lands here. */}
              {(asyncTurn && asyncActionError) ||
              (operationCancellation?.turn.conversationId === conversationId &&
                operationCancellation.phase === 'unknown') ? (
                <p
                  role="alert"
                  className="chat-action-error mt-6 rounded-xl border px-4 py-3 text-sm leading-6"
                >
                  {asyncActionError}
                </p>
              ) : null}
              {asyncNote ? (
                <p role="status" className="mt-3 text-xs text-stage-muted">
                  {asyncNote.text}{' '}
                  <Link href="/tasks" className="font-medium underline underline-offset-2">
                    Open Activity
                  </Link>
                  {asyncNote.retryable && !busy && lastSubmittedText.trim() !== '' ? (
                    <>
                      {' · '}
                      <button
                        type="button"
                        onClick={retryLastTurn}
                        className={`font-medium underline underline-offset-2 hover:no-underline ${focusRing}`}
                      >
                        Try again
                      </button>
                    </>
                  ) : null}
                </p>
              ) : null}
              {pollTrouble === 'expired' ? (
                <p role="alert" className="mt-3 text-xs text-stage-muted">
                  Your session expired — live updates are off.{' '}
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className={`font-medium underline underline-offset-2 hover:no-underline ${focusRing}`}
                  >
                    Reload to sign in again
                  </button>
                </p>
              ) : pollTrouble === 'stale' ? (
                <p role="status" className="mt-3 text-xs text-stage-muted">
                  Live updates paused — retrying.
                </p>
              ) : null}
              {liveRecall ? <RecallNote sources={liveRecall} /> : null}
            </div>
          )}
        </div>
      </div>

      {/* The composer floats over the conversation rather than docking under
          it: no bar, no border — just the raised card lifted off the log, with
          a scrim so the text scrolling beneath it fades out instead of
          colliding with it. It stays `sticky` so it tracks the viewport bottom
          even when the column overflows, and the negative margin gives back
          the space it would otherwise take from the log. Everything transient
          (errors, palettes) sits in an out-of-flow stack above it, so opening
          the "/" palette never resizes the conversation. */}
      {/* Out of the composer's form on purpose, even though it is positioned
          against it. Out here the pill shares the log's own context, so what it
          frosts is the conversation itself — inside, it sat above the veil and
          could only ever pick up the veil's own output. The composer's measured
          height is what keeps it in the same place either way. */}
      {!atBottom && log.length > 0 && !error && !commandPaletteOpen && !modelCommandOpen ? (
        <div
          // `composerHeight` is the whole form's box, padding and safe-area
          // clearance included, so this is the same 1.25rem gap above the card
          // that the old `-top-14` inside the form worked out to.
          style={{ bottom: `calc(${composerHeight}px + 1.25rem)` }}
          className="pointer-events-none absolute inset-x-0 z-30 flex justify-center"
        >
          <button
            type="button"
            onClick={jumpToLatest}
            aria-label="Jump to latest"
            className={`pointer-events-auto mobile-touch-target inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium motion-safe:animate-[pop-in_140ms_ease-out] ${focusRing}`}
          >
            <ArrowDown className="size-3.5" aria-hidden="true" />
            Jump to latest
            {unseenCount > 0 ? (
              <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
            ) : null}
          </button>
        </div>
      ) : null}
      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          submitCurrentMessage();
        }}
        style={{ marginTop: `-${composerHeight}px` }}
        className="mobile-safe-bottom pointer-events-none sticky bottom-0 z-20 min-w-0 sm:pb-3"
      >
        {/* The veil the composer and the jump pill are glass against: it
            frosts and thins the log on its way under them rather than hiding
            it behind a band of stage — conversation.css cuts the material.

            It stops at the composer's own bottom edge. It used to hang below
            it, which cost nothing when the column ended above the fold but now
            adds its overhang to the document — the whole page would scroll a
            little, sliding the "full height" log out of place. */}
        <span
          aria-hidden="true"
          className="composer-veil pointer-events-none absolute inset-x-0 -top-28 bottom-0"
        />
        <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 min-w-0">
          {/* Autonomy is a per-turn choice, so it no longer holds a permanent
              seat in the composer — /auto sets it and this says so until the
              turn goes out. Out of flow, so arming it never resizes the field. */}
          {autonomous ? (
            <div className="pointer-events-auto mb-2 flex min-w-0 items-center gap-2 rounded-[var(--radius-shell)] bg-amber-100 px-3 py-1.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-300">
              <Zap className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">Acting without asking this turn</span>
              <button
                data-testid="chat-autonomy-mode"
                type="button"
                onClick={() => setAutonomous(false)}
                aria-label="Ask before acting again"
                title="Sensitive steps including unknown recipients and logged-in browsing still ask, and budget caps still apply."
                className={`shrink-0 rounded-[var(--radius-shell-inset-8)] px-2 font-medium underline underline-offset-2 hover:no-underline ${focusRing}`}
              >
                Cancel
              </button>
            </div>
          ) : null}
          {error && errorInfo ? (
            <ChatErrorBanner
              error={errorInfo}
              canRetry={lastSubmittedText.trim() !== '' && input === ''}
              onRetry={retryLastTurn}
              onRestoreDraft={() => {
                clearError();
                setInput(lastSubmittedText);
                window.requestAnimationFrame(() => textareaRef.current?.focus());
              }}
              onDismiss={clearError}
            />
          ) : null}
          {commandPaletteOpen ? (
            <section
              aria-label="Commands"
              className="paper pointer-events-auto relative mb-2 min-w-0 overflow-hidden rounded-[var(--radius-shell)] bg-raised ring-1 ring-edge motion-safe:animate-[pop-in_120ms_ease-out]"
            >
              <div className="flex min-w-0 items-center justify-between gap-3 border-b border-edge px-4 py-2.5">
                <p className="text-sm font-semibold text-strong">Commands</p>
                <span className="hidden shrink-0 text-xs text-muted sm:block">
                  ↑↓ choose · Enter open · Esc dismiss
                </span>
              </div>
              {/* One flat listbox in two labelled groups. The arrow keys index
                  `commandMatches`, so the destination rows continue the
                  composer rows' numbering rather than restarting at zero. */}
              <div
                id="command-listbox"
                role="listbox"
                aria-label="Commands"
                className="max-h-72 overscroll-contain overflow-y-auto p-1.5"
              >
                {composerMatches.length > 0
                  ? renderCommandGroup('This chat', composerMatches, 0)
                  : null}
                {destinationMatches.length > 0
                  ? renderCommandGroup('Go to', destinationMatches, composerMatches.length)
                  : null}
              </div>
            </section>
          ) : null}
          {modelCommandOpen ? (
            <section
              aria-label="Choose response model"
              className="paper pointer-events-auto relative mb-2 min-w-0 overflow-hidden rounded-[var(--radius-shell)] bg-raised ring-1 ring-edge motion-safe:animate-[pop-in_120ms_ease-out]"
            >
              <div className="flex min-w-0 items-center justify-between gap-3 border-b border-edge px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-strong">Response model</p>
                  <p className="truncate text-xs text-muted">Currently {selectedModelLabel}</p>
                </div>
                {isSwitching ? (
                  <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted">
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    Switching…
                  </span>
                ) : (
                  <span className="hidden shrink-0 text-xs text-muted sm:block">
                    ↑↓ choose · Enter select · Esc close
                  </span>
                )}
              </div>
              <div
                id="model-listbox"
                role="listbox"
                aria-label="Response model"
                className="max-h-56 overscroll-contain overflow-y-auto p-1.5"
              >
                {modelOptions.length > 0 ? (
                  modelOptions.map((model, index) => {
                    const active = selectedModel === model.id;
                    const highlighted = index === modelHighlight;
                    return (
                      <button
                        key={model.id ?? 'auto'}
                        id={`model-option-${index}`}
                        type="button"
                        role="option"
                        aria-selected={active}
                        disabled={isSwitching}
                        onMouseMove={() => setModelHighlight(index)}
                        onClick={() => chooseModel(model.id)}
                        className={`mobile-touch-target flex min-h-11 w-full min-w-0 items-center gap-3 rounded-[var(--radius-shell-inset-6)] px-3 py-2 text-left motion-safe:transition-colors ${focusRing} ${
                          active
                            ? 'bg-accent/10 text-accent'
                            : highlighted
                              ? 'bg-sunken text-strong'
                              : 'text-strong hover:bg-sunken'
                        } ${active && highlighted ? 'ring-1 ring-accent/40' : ''}`}
                      >
                        <span
                          aria-hidden="true"
                          className={`size-2 shrink-0 rounded-full ${
                            active ? 'bg-accent' : 'bg-edge'
                          }`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{model.label}</span>
                          <span className="block truncate text-xs text-muted">{model.detail}</span>
                        </span>
                      </button>
                    );
                  })
                ) : (
                  <p className="px-3 py-4 text-center text-sm text-muted">
                    No models match “{modelQuery}”
                  </p>
                )}
              </div>
              {modelError ? (
                <p role="alert" className="border-t border-edge px-4 py-2 text-xs text-red-700">
                  {modelError}
                </p>
              ) : null}
            </section>
          ) : null}
        </div>
        <div className="pointer-events-auto relative min-w-0">
          {/* One row: the field, then send. `items-end` keeps the button on the
              last line as the field grows upward, and the card's own padding is
              the only inset either of them needs. */}
          <div
            data-testid="chat-composer-surface"
            className="flex min-w-0 items-end gap-2 overflow-hidden rounded-[var(--radius-shell)] p-2 motion-safe:transition-shadow"
          >
            <textarea
              ref={textareaRef}
              role="combobox"
              aria-label="Message"
              aria-expanded={modelCommandOpen || commandPaletteOpen}
              aria-haspopup="listbox"
              aria-autocomplete="list"
              aria-controls={
                modelCommandOpen
                  ? 'model-listbox'
                  : commandPaletteOpen
                    ? 'command-listbox'
                    : undefined
              }
              aria-activedescendant={
                modelCommandOpen
                  ? `model-option-${modelHighlight}`
                  : commandPaletteOpen
                    ? `command-option-${safeCommandHighlight}`
                    : undefined
              }
              value={input}
              disabled={Boolean(
                formDraft?.operation &&
                  !formDraft.operation.taskId &&
                  !volatileFormConflictRef.current,
              )}
              onChange={(event) => {
                const nextText = event.target.value;
                setInput(nextText);
                const current = formDraftRef.current;
                if (
                  current?.reviewed &&
                  !current.blockedByTask &&
                  !current.releasedBlockedTask &&
                  (!current.operation || current.operation.taskId !== undefined)
                ) {
                  try {
                    const updated = { ...current, composerText: nextText };
                    saveCardFormDraft(getFormStorage(), updated);
                    saveFormDraft(updated);
                  } catch {
                    setFormError(
                      'This browser could not save the message draft. Keep this chat open.',
                    );
                  }
                }
              }}
              onKeyDown={(event) => {
                // While the /model palette is open the arrows drive it, Enter picks
                // the highlighted model, and Escape closes it — so none of those
                // reach the send handler.
                if (modelCommandOpen) {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setModelHighlight((h) =>
                      modelOptions.length ? (h + 1) % modelOptions.length : 0,
                    );
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setModelHighlight((h) =>
                      modelOptions.length ? (h - 1 + modelOptions.length) % modelOptions.length : 0,
                    );
                  } else if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    const choice = modelOptions[modelHighlight];
                    if (choice && !isSwitching) chooseModel(choice.id);
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    closeModelPicker();
                  }
                  return;
                }
                // The "/" palette: arrows move the cursor, Enter or Tab complete
                // the highlighted command, Escape dismisses.
                if (commandPaletteOpen) {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setCommandHighlight((h) => (h + 1) % commandMatches.length);
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setCommandHighlight(
                      (h) => (h - 1 + commandMatches.length) % commandMatches.length,
                    );
                  } else if (
                    event.key === 'Tab' ||
                    (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing)
                  ) {
                    event.preventDefault();
                    const choice = commandMatches[safeCommandHighlight];
                    if (choice) runCommand(choice);
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setInput('');
                  }
                  return;
                }
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  formRef.current?.requestSubmit();
                }
              }}
              placeholder="Ask anything…"
              rows={1}
              className="block max-h-40 min-h-10 w-full min-w-0 flex-1 resize-none self-center border-0 bg-transparent px-2 py-2 text-base leading-6 outline-none sm:text-sm"
            />
            {/* No rule between the field and its controls. A full-bleed border
                ran straight into the card's corner arc, which cut it off at an
                angle and made one object look like two stacked ones. Without it
                the card reads as a single well with the controls resting in it,
                and the round send button agrees with the corners instead of
                fighting them. */}
            {operationCancellation?.turn.conversationId === conversationId ? (
              <button
                type="button"
                disabled={operationCancellation.phase === 'checking'}
                onClick={() => cancelOrdinaryOperation(operationCancellation.turn)}
                title={operationCancellation.phase === 'checking' ? 'Checking stop' : 'Retry stop'}
                aria-label={
                  operationCancellation.phase === 'checking' ? 'Checking stop' : 'Retry stop'
                }
                className={`inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-white/25 bg-white/15 text-stage-strong motion-safe:transition-colors hover:bg-white/25 disabled:cursor-not-allowed ${focusRing}`}
              >
                {operationCancellation.phase === 'checking' ? (
                  <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                ) : (
                  <Square className="size-3 fill-current" aria-hidden="true" />
                )}
              </button>
            ) : asyncTurn &&
              asyncTurn.taskId === observedFormTaskId &&
              status !== 'submitted' &&
              status !== 'streaming' ? (
              <button
                type="button"
                disabled={isCancellingAsync}
                onClick={cancelAsyncTurn}
                title="Stop this task"
                aria-label={isCancellingAsync ? 'Stopping the task' : 'Stop this task'}
                className={`inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-white/25 bg-white/15 text-stage-strong motion-safe:transition-colors hover:bg-white/25 disabled:cursor-not-allowed ${focusRing}`}
              >
                <Square className="size-3 fill-current" aria-hidden="true" />
              </button>
            ) : null}
            {(status === 'submitted' || status === 'streaming') &&
            operationCancellation?.turn.conversationId !== conversationId ? (
              <button
                type="button"
                disabled={formAdmissionAwaitingReceipt}
                onClick={stopCurrentTurn}
                title={
                  formAdmissionAwaitingReceipt
                    ? 'Waiting for form receipt'
                    : 'Stop generating and request cancellation'
                }
                aria-label={formAdmissionAwaitingReceipt ? 'Waiting for form receipt' : 'Stop'}
                className={`inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-white/25 bg-white/15 text-stage-strong motion-safe:animate-[pop-in_120ms_ease-out] motion-safe:transition-colors hover:bg-white/25 disabled:cursor-wait disabled:opacity-70 ${focusRing}`}
              >
                {formAdmissionAwaitingReceipt ? (
                  <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                ) : (
                  <>
                    <Square className="size-3 fill-current" aria-hidden="true" />
                    <span className="sr-only">Stop</span>
                  </>
                )}
              </button>
            ) : asyncTurn && asyncTurn.taskId !== observedFormTaskId ? (
              // The spinner IS the stop control. It used to be an inert badge
              // saying "busy" while the button that could actually stop the
              // work sat further up the log — so the one thing on screen that
              // represents the running task was the one thing you could not
              // press. Same position, same spinner, now it does the obvious.
              <button
                type="button"
                disabled={isCancellingAsync}
                onClick={stopCurrentTurn}
                title="Stop this task"
                aria-label={isCancellingAsync ? 'Stopping the task' : 'Stop this task'}
                className={`group/stop inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-white/25 bg-white/15 text-stage-strong motion-safe:transition-colors hover:bg-white/25 disabled:cursor-not-allowed ${focusRing}`}
              >
                {/* The square only replaces the spinner under a pointer that
                    can hover; on a touch screen the spinner stays put and the
                    tap does the stopping. */}
                <Loader2
                  className="size-4 motion-safe:animate-spin group-hover/stop:hidden"
                  aria-hidden="true"
                />
                <Square
                  className="hidden size-3 fill-current group-hover/stop:block"
                  aria-hidden="true"
                />
              </button>
            ) : (
              // Readiness is a state change, not a dimmed copy of the live
              // button: with nothing to send it sits back into the composer's
              // own well, then lifts to solid white — the one bright object on
              // the stage — once you have typed.
              <button
                type="submit"
                disabled={!canSend}
                aria-label="Send"
                className={`inline-flex size-10 shrink-0 items-center justify-center rounded-full motion-safe:transition-[background-color,color] ${focusRing} ${
                  canSend
                    ? 'bg-white text-stage hover:bg-white/90'
                    : 'cursor-not-allowed bg-white/12 text-stage-muted'
                }`}
              >
                <ArrowUp className="size-4" aria-hidden="true" />
              </button>
            )}
          </div>
          <span aria-live="polite" className="sr-only">
            {modelCommandOpen && modelOptions[modelHighlight]
              ? `${modelOptions[modelHighlight].label}, ${modelOptions[modelHighlight].detail}`
              : commandPaletteOpen && commandMatches[safeCommandHighlight]
                ? `${commandMatches[safeCommandHighlight].command}, ${commandMatches[safeCommandHighlight].hint}`
                : ''}
          </span>
          {fallbackNote ? (
            <p className="px-1 pt-1.5 text-right text-xs text-stage-muted">{fallbackNote}</p>
          ) : null}
        </div>
      </form>
    </div>
  );
}
