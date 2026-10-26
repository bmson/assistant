'use client';

import { ChevronDown, History } from 'lucide-react';
import { useId, useState } from 'react';
import {
  friendlyRecallDate,
  hasRecallLedgerReference,
  RecallFeedbackControl,
  type RecallSource,
  RecallSourceControl,
} from './message-view';

/** Only identical versioned references collapse; legacy entries keep their own place. */
export function replyContextRecords(sources: readonly RecallSource[]): RecallSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (!source.surfaceKey || !source.sourceRevision) return true;
    const key = JSON.stringify([source.surfaceKey, source.sourceRevision]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function replyContextKind(kind: RecallSource['kind']): string {
  switch (kind) {
    case 'chat':
      return 'Earlier chats';
    case 'knowledge_graph':
      return 'Knowledge graph';
    case 'decision':
      return 'Saved decisions';
    case 'commitment':
      return 'Commitments';
    default:
      return 'Saved context';
  }
}

export function replyContextDate(day: string, now: Date): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== day
  ) {
    return 'Date unavailable';
  }
  return friendlyRecallDate(day, now);
}

/** Prop-owned presentation only: transport remains in the existing recall controls. */
export function ReplyContextFooter({
  sources,
  messageId,
  conversationId = '',
  sessionScope,
  now,
  onFeedback,
}: {
  sources: RecallSource[];
  messageId: string;
  conversationId?: string;
  sessionScope?: string;
  now: Date;
  onFeedback?: (messageId: string, verdict: 'helpful' | 'not_helpful') => Promise<void>;
}) {
  const owner = JSON.stringify([sessionScope, conversationId, messageId]);
  const [expandedOwner, setExpandedOwner] = useState<string | null>(null);
  const expanded = expandedOwner === owner;
  const detailsId = useId();
  const records = replyContextRecords(sources);
  if (records.length === 0) return null;
  return (
    <div className="reply-context-footer" data-reply-context-footer="true">
      <button
        type="button"
        className="reply-context-disclosure"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpandedOwner(expanded ? null : owner)}
      >
        <History size={14} aria-hidden="true" className="reply-context-icon" />
        <span className="reply-context-summary">
          <span>Context for this reply</span>
          <span className="reply-context-count">
            {records.length} {records.length === 1 ? 'item' : 'items'}
          </span>
        </span>
        <ChevronDown size={14} aria-hidden="true" className="reply-context-chevron" />
      </button>
      {expanded ? (
        <ReplyContextDetails
          id={detailsId}
          sources={records}
          messageId={messageId}
          conversationId={conversationId}
          sessionScope={sessionScope}
          now={now}
          onFeedback={onFeedback}
        />
      ) : null}
    </div>
  );
}

/** Mounted only while expanded; source-control effects cannot run in the collapsed footer. */
export function ReplyContextDetails({
  id,
  sources: records,
  messageId,
  conversationId = '',
  sessionScope,
  now,
  onFeedback,
}: {
  id: string;
  sources: RecallSource[];
  messageId: string;
  conversationId?: string;
  sessionScope?: string;
  now: Date;
  onFeedback?: (messageId: string, verdict: 'helpful' | 'not_helpful') => Promise<void>;
}) {
  const sourceIdentity = JSON.stringify(
    records.map((source, index) => [
      source.surfaceKey ?? null,
      source.sourceRevision ?? null,
      source.surfaceKey && source.sourceRevision
        ? null
        : [source.label, source.date, source.kind, source.hops],
      index,
    ]),
  );
  return (
    <div id={id} className="reply-context-details">
      <p>
        These entries were retrieved when this reply was prepared. Changing future recall does not
        rewrite this reply or delete the saved source.
      </p>
      <ul className="reply-context-records">
        {records.map((source, index) => {
          const key =
            source.surfaceKey && source.sourceRevision
              ? JSON.stringify([source.surfaceKey, source.sourceRevision])
              : `legacy-${index}`;
          const knownKind =
            source.kind === 'chat' ||
            source.kind === 'knowledge_graph' ||
            source.kind === 'decision' ||
            source.kind === 'commitment';
          return (
            <li key={key} className="reply-context-record">
              <p className="reply-context-label whitespace-pre-wrap break-words">
                <span>Saved context: </span>
                {source.label}
              </p>
              <p className="reply-context-metadata">
                {replyContextDate(source.date, now)} · {replyContextKind(source.kind)}
                {source.hops === 1 || source.hops === 2 ? ` · ${source.hops}-hop connection` : ''}
              </p>
              <div className="reply-context-source-action">
                {knownKind && hasRecallLedgerReference(source) ? (
                  <RecallSourceControl
                    source={source}
                    messageId={messageId}
                    identityScope={conversationId}
                    sessionScope={sessionScope}
                  />
                ) : (
                  <p>Privacy controls unavailable for this saved reference.</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {onFeedback ? (
        <RecallFeedbackControl
          key={sourceIdentity}
          messageId={messageId}
          onFeedback={onFeedback}
          identityScope={JSON.stringify([conversationId, sourceIdentity])}
          sessionScope={sessionScope}
        />
      ) : null}
    </div>
  );
}
