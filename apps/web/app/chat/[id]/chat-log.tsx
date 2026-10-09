'use client';

/*
 * The transcript.
 *
 * This is a separate module, and every row is memoized, for one reason: the
 * chat client re-renders constantly for reasons that have nothing to do with
 * what is already on screen. A keystroke in the composer, the soft keyboard
 * resizing the form, a scroll crossing the bottom threshold, a token landing on
 * the newest reply — each of those used to re-run this whole list, markdown
 * parsing and `Intl` formatting included, and on a long thread that is what
 * made the field feel like it opened a few hundred milliseconds late.
 *
 * Everything a row needs is a prop, and every prop is either a value or a
 * callback ChatClient keeps stable, so React skips the rows that did not
 * change. During a stream that leaves exactly one row re-rendering per token.
 */

import type { CardForm, CardFormValues } from '@assistant/persistence/card-form';
import type { UIMessage } from 'ai';
import Link from 'next/link';
import { memo } from 'react';
import { refreshSavedCardInline } from '@/app/cards/actions';
import { chipsOf } from '@/lib/chat-cues';
import {
  approvalSummaryOf,
  isContractNotice,
  isDecisionProseNotice,
  isOffCourse,
  noticeKindOf,
  noticePresentationOf,
  offCourseReplacement,
  retractionNoticeOf,
  turnFailedReason,
} from '@/lib/chat-notices';
import { chip } from '@/lib/ui';
import { recordRecallFeedbackAction } from '../actions';
import { ActionChips } from './action-chips';
import { ApprovalGroup } from './approval-group';
import { ApprovalSummaryCard } from './approval-summary';
import type { CardFormDraft, CardFormIdentity } from './card-form-operations';
import type { InlineApprovalPart } from './inline-approval';
import { InlineBudgetRequest, type InlineBudgetRequestPart } from './inline-budget-request';
import { type InlineSuggestionPart, SuggestionCard } from './inline-suggestion';
import { MessageMarkdown } from './markdown';
import {
  AssistantUpdate,
  MessageActions,
  messageDate,
  messageText,
  NoticeCard,
  RecallNote,
  recallSourcesOf,
  stampLabel,
} from './message-view';
import { OffCourseCard } from './off-course-card';
import {
  cardsReplaceProse,
  ResponseCards,
  rendersAllCards,
  rendersSomeCards,
  responseCardPayloads,
} from './response-card';
import { standaloneResponseCards } from './suggestion-context';

interface ChatMessageRowProps {
  message: UIMessage;
  /** Who spoke last. A change of speaker opens a new run, which gets more air. */
  previousRole: UIMessage['role'] | undefined;
  /** The words that opened this turn — what an off-course or failed card resends. */
  precedingUserText: string | undefined;
  /** Only the newest row offers action chips, and only it can carry the caret. */
  isLast: boolean;
  /** Rows present at mount render static; only genuinely new ones animate in. */
  isNew: boolean;
  streamingCaret: boolean;
  /** A turn is in flight, so nothing in the log may start another one. */
  busy: boolean;
  notificationMode: boolean;
  agentTimezone: string;
  renderedNow: Date;
  onSend: (text: string) => void;
  onRunForReal: (text: string) => void;
  conversationId?: string;
  formSessionScope?: string;
  formDraft?: CardFormDraft | null;
  formError?: string | null;
  onChangeForm?: (identity: CardFormIdentity, form: CardForm, values: CardFormValues) => void;
  onReviewForm?: (identity: CardFormIdentity, form: CardForm, values: CardFormValues) => void;
  onCarryForm?: (identity: CardFormIdentity, form: CardForm) => void;
  onDiscardForm?: (identity: CardFormIdentity) => void;
}

const ChatMessageRow = memo(function ChatMessageRow({
  message,
  previousRole,
  precedingUserText,
  isLast,
  isNew,
  streamingCaret,
  busy,
  notificationMode,
  agentTimezone,
  renderedNow,
  onSend,
  onRunForReal,
  conversationId,
  formSessionScope,
  formDraft,
  formError,
  onChangeForm,
  onReviewForm,
  onCarryForm,
  onDiscardForm,
}: ChatMessageRowProps) {
  const parts = message.parts as Array<
    UIMessage['parts'][number] | InlineApprovalPart | InlineBudgetRequestPart | InlineSuggestionPart
  >;
  const approvalSummary = approvalSummaryOf(parts);
  const approvalParts = parts.filter(
    (part): part is InlineApprovalPart => part.type === 'approval',
  );
  const budgetParts = parts.filter(
    (part): part is InlineBudgetRequestPart => part.type === 'budget-request',
  );
  const suggestionParts = parts.filter(
    (part): part is InlineSuggestionPart =>
      part.type === 'suggestion' &&
      typeof part.suggestionId === 'string' &&
      !!part.suggestionId.trim() &&
      typeof part.summary === 'string' &&
      typeof part.proposedAction === 'string',
  );
  // A streamed draft the response contract replaced renders as the
  // replacement — the text the server actually persisted — so reloading
  // the thread cannot change the answer out from under the reader.
  const replacement = message.role === 'assistant' ? offCourseReplacement(parts) : null;
  const textParts = replacement
    ? [{ type: 'text' as const, text: replacement }]
    : parts.filter(
        (part): part is Extract<UIMessage['parts'][number], { type: 'text' }> =>
          part.type === 'text',
      );
  // The card repeats the executor's own prose about the same
  // decision — hide the duplicate text, never the persisted
  // message itself.
  const visibleTextParts =
    approvalSummary !== null
      ? []
      : approvalParts.length > 0 || budgetParts.length > 0
        ? textParts.filter((part) => !isDecisionProseNotice(part.text))
        : textParts;
  // Whitespace-only text parts are the residue of a [break]
  // split point — they join into the message text (dedupe
  // relies on that) but render as nothing.
  const renderedTextParts = visibleTextParts.filter((part) => part.text.trim().length > 0);
  const fullText = visibleTextParts
    .map((part) => part.text)
    .join('')
    .trim();
  // A card the assistant placed answers for itself, so a notice
  // marker on the same message never overrides it. `isContractNotice`
  // still matches by prose for messages persisted before the
  // structured marker existed.
  const noticeKind =
    message.role === 'assistant' &&
    approvalParts.length === 0 &&
    budgetParts.length === 0 &&
    approvalSummary === null &&
    fullText !== ''
      ? (noticeKindOf(parts) ?? (isContractNotice(fullText) ? 'response-contract' : null))
      : null;
  const noticePresentation = noticeKind === null ? null : noticePresentationOf(parts);
  // An off-course reply keeps its text (it had already streamed)
  // and adds the marker card; a turn-failed notice IS the card.
  // Both recoveries resend the words that opened this turn.
  const offCourse = message.role === 'assistant' && isOffCourse(parts);
  const failedReason = message.role === 'assistant' ? turnFailedReason(parts) : null;
  const retraction = message.role === 'assistant' ? retractionNoticeOf(parts) : null;
  const date = messageDate(message);
  // A chat is one continuous discussion — per-message clock times
  // are noise there, and the reply's own footer carries the "when"
  // for anyone who wants it. Proactive updates are the exception:
  // those arrive at a time that is part of the message, so
  // Notifications keeps them.
  const showTime = date !== null && notificationMode;
  const recallSources = recallSourcesOf(message);
  // Rich cards ARE the answer when every card on the message can
  // render here — showing the prose too would restate it. A kind
  // this surface can't render keeps the prose fallback instead
  // (parity with the iOS bubble). So does a card read out of the
  // reply itself, which summarizes an answer rather than being one.
  const allCards = message.role === 'assistant' ? responseCardPayloads(parts) : [];
  const cards = standaloneResponseCards(allCards, suggestionParts);
  const cardContext = {
    onSendAvailable: !busy && Boolean(onSend),
    onCardFormReviewAvailable: Boolean(
      conversationId && formSessionScope && onReviewForm && onChangeForm,
    ),
  };
  const renderCards =
    cards.length > 0 && rendersSomeCards(cards, cardContext) && noticeKind === null;
  const richAnswer =
    allCards.length > 0 && rendersAllCards(allCards, cardContext) && noticeKind === null;
  const hasText =
    renderedTextParts.length > 0 &&
    noticeKind === null &&
    !(richAnswer && cardsReplaceProse(allCards));

  // A "run" is a streak of turns from the same speaker. Handing
  // over gets a clear break; a follow-on from the same speaker
  // tucks in close, so a run reads as one continuous thought.
  const startsRun = previousRole !== message.role;
  return (
    <div
      className={`flex min-w-0 flex-col gap-2 first:mt-0 ${startsRun ? 'mt-7' : 'mt-2'} ${
        isNew ? 'motion-safe:animate-[message-in_220ms_ease-out]' : ''
      }`}
      data-message-block="true"
      data-role={message.role}
      data-run-start={startsRun}
    >
      {noticeKind !== null ? (
        <NoticeCard
          kind={noticeKind}
          text={fullText}
          presentation={noticePresentation}
          originalText={retraction?.originalText}
          retractionReason={retraction?.reason}
          actions={
            noticeKind === 'turn-failed' ? (
              <>
                {failedReason === 'budget' ? (
                  <Link href="/costs" className={chip.accent}>
                    Open Costs
                  </Link>
                ) : null}
                {precedingUserText ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onSend(precedingUserText)}
                    className={chip.accent}
                  >
                    Try again
                  </button>
                ) : null}
              </>
            ) : undefined
          }
        />
      ) : notificationMode && message.role === 'assistant' && hasText ? (
        <AssistantUpdate
          text={fullText}
          sources={recallSources}
          messageId={message.id}
          onFeedback={recordRecallFeedbackAction}
        />
      ) : hasText ? (
        <div className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
          {message.role === 'assistant' ? (
            // The assistant speaks on paper: a white sheet laid
            // on the stage, which is the one opaque material in
            // the thread and so reads as the thing that was
            // brought to you. The raised-card treatment stays
            // reserved for objects it places in the thread (an
            // approval, a budget ask). A reply split by [break]
            // cues arrives as several text parts — each renders
            // as its own sheet, the way separate texts from a
            // person stack.
            <div className="group/msg min-w-0 w-full max-w-none">
              <RecallNote
                sources={recallSources}
                messageId={message.id}
                onFeedback={recordRecallFeedbackAction}
              />
              <div className="flex min-w-0 flex-col gap-2">
                {renderedTextParts.map((part, index) => (
                  <div
                    key={`${message.id}-${index.toString()}`}
                    className={`bubble-assistant min-w-0 max-w-full rounded-[1.375rem] px-4 py-6 text-sm leading-6 ${
                      streamingCaret && index === renderedTextParts.length - 1 ? 'chat-caret' : ''
                    }`}
                  >
                    <MessageMarkdown text={part.text} />
                  </div>
                ))}
              </div>
              <MessageActions
                text={fullText}
                date={date}
                now={renderedNow}
                timeZone={agentTimezone}
              />
            </div>
          ) : (
            // Both speakers read at the same size — a smaller user
            // bubble made your own words look like a footnote.
            // That size is the one the event cards already use, so
            // speech and system notices sit on one typographic
            // scale instead of two. Your voice takes no material
            // at all: an outline on the stage against the
            // assistant's sheet of paper, so the two are told
            // apart by what they are made of and not only by
            // which side of the column they sit on.
            <div
              title={date ? date.toLocaleString() : undefined}
              className="bubble-owner min-w-0 max-w-[88%] rounded-[1.375rem] px-4 py-3 text-sm leading-6 sm:max-w-[min(76%,42rem)]"
            >
              {visibleTextParts.map((part, index) => (
                <p
                  key={`${message.id}-${index.toString()}`}
                  className="break-words whitespace-pre-wrap [overflow-wrap:anywhere]"
                >
                  {part.text}
                </p>
              ))}
            </div>
          )}
        </div>
      ) : null}
      {approvalParts.length > 0 ? <ApprovalGroup parts={approvalParts} /> : null}
      {budgetParts.map((part) => (
        <InlineBudgetRequest key={part.taskId} part={part} />
      ))}
      <SuggestionCard parts={suggestionParts} timeZone={agentTimezone} />
      {approvalSummary ? <ApprovalSummaryCard summary={approvalSummary} /> : null}
      {renderCards ? (
        <ResponseCards
          cards={cards}
          timeZone={agentTimezone}
          conversationId={conversationId}
          formSessionScope={formSessionScope}
          formDraft={formDraft}
          formError={formError}
          onChangeForm={onChangeForm}
          onReviewForm={onReviewForm}
          onCarryForm={onCarryForm}
          onDiscardForm={onDiscardForm}
          onSend={busy ? undefined : onSend}
          onRefresh={refreshSavedCardInline}
        />
      ) : null}
      {offCourse ? (
        <OffCourseCard
          active={!busy}
          onRunForReal={precedingUserText ? () => onRunForReal(precedingUserText) : undefined}
        />
      ) : null}
      {message.role === 'assistant' && noticeKind === null ? (
        <ActionChips labels={chipsOf(message)} active={isLast && !busy} onSend={onSend} />
      ) : null}
      {showTime && date ? (
        <p
          title={date.toLocaleString()}
          className={`text-xs text-stage-muted ${
            message.role === 'user' ? 'self-end' : 'self-start'
          }`}
        >
          {stampLabel(date, renderedNow, agentTimezone)}
        </p>
      ) : null}
    </div>
  );
});

export interface ChatLogProps {
  log: UIMessage[];
  busy: boolean;
  /** Drives the caret on the newest reply while its text is still arriving. */
  streaming: boolean;
  notificationMode: boolean;
  agentTimezone: string;
  renderedNow: Date;
  initialMessageIds: Set<string>;
  onSend: (text: string) => void;
  onRunForReal: (text: string) => void;
  conversationId?: string;
  formSessionScope?: string;
  formDraft?: CardFormDraft | null;
  formError?: string | null;
  onChangeForm?: (identity: CardFormIdentity, form: CardForm, values: CardFormValues) => void;
  onReviewForm?: (identity: CardFormIdentity, form: CardForm, values: CardFormValues) => void;
  onCarryForm?: (identity: CardFormIdentity, form: CardForm) => void;
  onDiscardForm?: (identity: CardFormIdentity) => void;
}

/**
 * The rendered log. Memoized as a whole as well as per row, so a render of
 * ChatClient that changed none of these props — every keystroke, in other
 * words — does not even walk the list.
 */
export const ChatLog = memo(function ChatLog({
  log,
  busy,
  streaming,
  notificationMode,
  agentTimezone,
  renderedNow,
  initialMessageIds,
  onSend,
  onRunForReal,
  conversationId,
  formSessionScope,
  formDraft,
  formError,
  onChangeForm,
  onReviewForm,
  onCarryForm,
  onDiscardForm,
}: ChatLogProps) {
  // Carried forward as the list is walked rather than re-scanned backwards from
  // each row, which turned a long thread into quadratic work.
  let lastUserText: string | undefined;
  const lastIndex = log.length - 1;
  return (
    <>
      {log.map((message, index) => {
        const precedingUserText = lastUserText;
        if (message.role === 'user') lastUserText = messageText(message);
        return (
          <ChatMessageRow
            key={message.id}
            message={message}
            previousRole={index > 0 ? log[index - 1]?.role : undefined}
            precedingUserText={precedingUserText}
            isLast={index === lastIndex}
            isNew={!initialMessageIds.has(message.id)}
            streamingCaret={streaming && message.role === 'assistant' && index === lastIndex}
            busy={busy}
            notificationMode={notificationMode}
            agentTimezone={agentTimezone}
            renderedNow={renderedNow}
            onSend={onSend}
            onRunForReal={onRunForReal}
            conversationId={conversationId}
            formSessionScope={formSessionScope}
            formDraft={formDraft}
            formError={formError}
            onChangeForm={onChangeForm}
            onReviewForm={onReviewForm}
            onCarryForm={onCarryForm}
            onDiscardForm={onDiscardForm}
          />
        );
      })}
    </>
  );
});
