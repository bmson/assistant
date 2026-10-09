import { emailProvenanceText, isForwardedIngest } from '../email-provenance.js';
import type { ClarificationContinuation, Trust } from '../events.js';
import { detectFutureWatchIntent } from './future-watch-intent.js';
import { detectLiveLookup } from './live-lookup.js';
import { detectPersonalReadRequest } from './read-intent.js';

export type OwnerIntentScope =
  | 'external_read'
  | 'private_read'
  | 'external_send'
  | 'workspace_write'
  | 'personal_write'
  | 'watch_create'
  | 'private_write'
  | 'memory_write'
  | 'feedback_write';

export type OwnerIntentKind =
  | 'new_request'
  | 'acknowledgment'
  | 'reaction'
  | 'external_trigger'
  | 'ambiguous';

/**
 * Deterministic provenance for the latest owner turn. Scopes are extracted
 * only from text positively separated as owner-authored; the model cannot add
 * scopes. `externalText` remains available as quoted data, never as authority.
 */
export interface OwnerIntent {
  sourceActor: 'owner' | 'assistant' | 'third_party' | 'mixed' | 'unknown';
  requestKind: OwnerIntentKind;
  ownerAuthoredText: string;
  externalText: string;
  authorizedScopes: OwnerIntentScope[];
  separation: 'clear' | 'none' | 'unknown';
}

/** Explicit opt-outs override ambient retrieval from older chats and memory. */
export function explicitlyOptsOutOfRecall(text: string): boolean {
  return (
    /\b(?:do not|don't|never|without)\s+(?:search|read|look\s+up|check|consult|use|retrieve|review)\b[^.!?\n]{0,120}\b(?:memory|memories|history|past chats|old messages|older messages|previous conversations|old conversations|anything up|anything else)\b/i.test(
      text,
    ) || /\bwithout\s+(?:looking|checking|searching)\s+anything\s+up\b/i.test(text)
  );
}

export function clarificationAnswerStatus(
  value: string,
  clarificationQuestion?: string,
): ClarificationContinuation['answerStatus'] {
  const text = value.trim().replace(/^\[The owner added this while the task was paused:\]\s*/i, '');
  if (!text || text.length > 2_000 || /^\?+$/.test(text)) return 'unrelated';
  if (
    /^(?:maybe|perhaps|i(?:'|’)m not sure|not sure|i don't know|i do not know|unsure)\b/i.test(text)
  )
    return 'uncertain';
  if (/^(?:later|not yet|after\s+that|remind me later|wait until)\b/i.test(text)) return 'deferred';
  if (
    /^(?:no(?:\s+thanks)?[.!\s]*|no[,.!\s]+(?:stop|cancel|don't send|do not send)\b.*|stop\b.*|cancel\b.*|never mind\b.*|don't send\b.*|do not send\b.*|forget it\b.*)$/i.test(
      text,
    )
  )
    return 'refusal';
  if (/^(?:by the way|separately|unrelated|new question|different topic|also,)\b/i.test(text))
    return 'unrelated';
  if (isCompleteEmailRequestAfterRecipientQuestion(text, clarificationQuestion)) return 'unrelated';
  return 'answer';
}

function isCompleteEmailRequestAfterRecipientQuestion(
  text: string,
  clarificationQuestion: string | undefined,
): boolean {
  if (
    !clarificationQuestion ||
    !/\b(?:recipient|email\s+address|which\s+(?:(?:saved\s+)?contact|(?:email\s+)?address)|who\s+should\s+(?:receive|get)|who\s+to\s+(?:send|email)|who\s+should\s+i\s+(?:email|send))\b/i.test(
      clarificationQuestion,
    )
  )
    return false;
  if (!/^\s*(?:(?:please\s+)?|(?:can|could)\s+you\s+)(?:email|e-?mail|send|message)\b/i.test(text))
    return false;
  const intent = extractOwnerIntent({ trust: 'owner', text });
  return (
    intent.sourceActor === 'owner' &&
    intent.authorizedScopes.includes('external_send') &&
    (/\b(?:about|regarding|subject|saying|that)\b/i.test(text) || /:\s*\S/.test(text))
  );
}

const externalBoundary =
  /^\s*(?:-{2,}\s*(?:forwarded|original) message\s*-{2,}|begin forwarded message\s*:|\[quoted(?: or forwarded)? content begins\]|on\b.{0,300}\bwrote\s*:|le\s+.+\ba\s+écrit\s*:|am\s+.+\bschrieb\s*:|el\s+.+\bescribió\s*:|from\s*:[^\n]*\n(?:[^\n]*\n){0,4}\s*(?:sent|date|subject)\s*:)/im;

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
        ? part.text
        : '',
    )
    .filter(Boolean)
    .join('\n');
}

function splitQuoted(text: string): { authored: string; external: string; clear: boolean } {
  const boundary = externalBoundary.exec(text);
  if (boundary?.index !== undefined) {
    return {
      authored: text.slice(0, boundary.index).trim(),
      external: text.slice(boundary.index).trim(),
      clear: true,
    };
  }

  // Citation lines are third-party text. Keep separately authored lines while
  // stripping the quote markers from the data projection.
  const lines = text.split(/\r?\n/);
  if (lines.some((line) => /^\s*>/.test(line))) {
    const authored: string[] = [];
    const external: string[] = [];
    for (const line of lines) {
      if (/^\s*>/.test(line)) external.push(line.replace(/^\s*>\s?/, ''));
      else authored.push(line);
    }
    return {
      authored: authored.join('\n').trim(),
      external: external.join('\n').trim(),
      clear: true,
    };
  }

  const fence = /```[^\n]*\n([\s\S]{1,12000}?)\n```/g;
  const fenced = [...text.matchAll(fence)];
  if (fenced.length > 0) {
    let cursor = 0;
    let authored = '';
    for (const match of fenced) {
      const start = match.index;
      if (start === undefined) continue;
      authored += `${text.slice(cursor, start)} `;
      cursor = start + match[0].length;
    }
    authored += text.slice(cursor);
    return {
      authored: authored.replace(/\s+/g, ' ').trim(),
      external: fenced
        .map((match) => match[1]?.trim() ?? '')
        .filter(Boolean)
        .join('\n'),
      clear: true,
    };
  }

  // Quoted source instructions inside an ordinary authenticated chat turn are
  // data. This deliberately handles only balanced paired quotes; unmatched
  // punctuation is ambiguous and therefore cannot grant any scope.
  const quote = /[“"]([^“”"]{1,12000})[”"]/g;
  const spans: Array<{ start: number; end: number; value: string }> = [];
  for (const match of text.matchAll(quote)) {
    const start = match.index;
    if (start === undefined) continue;
    spans.push({ start, end: start + match[0].length, value: match[1] ?? '' });
  }
  if (spans.length) {
    let cursor = 0;
    let authored = '';
    for (const span of spans) {
      authored += `${text.slice(cursor, span.start)} `;
      cursor = span.end;
    }
    authored += text.slice(cursor);
    return {
      authored: authored.replace(/\s+/g, ' ').trim(),
      external: spans
        .map((span) => span.value.trim())
        .filter(Boolean)
        .join('\n'),
      clear: true,
    };
  }
  return { authored: text.trim(), external: '', clear: true };
}

function hasUnmatchedQuote(text: string): boolean {
  const curlyOpen = (text.match(/“/g) ?? []).length;
  const curlyClose = (text.match(/”/g) ?? []).length;
  const straight = (text.match(/"/g) ?? []).length;
  return curlyOpen !== curlyClose || straight % 2 !== 0;
}

function affirmativeAction(text: string, requestedAction: string): boolean {
  const pattern = new RegExp(
    `(?:^|[.!?;\\n]|\\band\\s+)\\s*(?:please\\s+)?(?:(?:(?:can|could|would)\\s+you\\s+(?:please\\s+)?)?${requestedAction})\\b|\\b(?:I want|I need|I'd like|I would like) you to\\s+${requestedAction}\\b|\\bgo ahead and\\s+${requestedAction}\\b`,
    'i',
  );
  const match = pattern.exec(text);
  if (!match || match.index === undefined) return false;
  const rawPrefix =
    text
      .slice(0, match.index)
      .split(/[.!?;\n]/)
      .at(-1) ?? '';
  const prefix = /^[.!?;\n]/.test(match[0]) ? match[0] : `${rawPrefix} ${match[0]}`;
  return !/\b(?:do not|don't|never|should not|shouldn't|would not|wouldn't|not to)\b[^.!?]{0,100}$/i.test(
    prefix,
  );
}

function orderedReadThenSend(text: string, sendVerbs: string): boolean {
  const ordered = new RegExp(
    `^\\s*(?:(?:please\\s+)?(?:(?:can|could|would)\\s+you\\s+(?:please\\s+)?)?)?(?:search|look(?:\\s+it)?\\s+up|browse|research|investigate|check|find|read|review|summari[sz]e|analy[sz]e)\\b[^.!?;\\n]{0,180}?\\s*,?\\s+then\\s+(?:please\\s+)?${sendVerbs}\\b`,
    'i',
  );
  const match = ordered.exec(text);
  if (!match || match.index === undefined) return false;
  const then = match[0].toLocaleLowerCase().lastIndexOf('then');
  const prefix = text.slice(0, match.index + then);
  if (/\b(if|when|unless|once|until|after|before)\b/i.test(prefix)) return false;
  return !/\b(?:do not|don't|never|should not|shouldn't|would not|wouldn't|not to)\b/i.test(prefix);
}

function scopesFor(text: string): OwnerIntentScope[] {
  const scopes = new Set<OwnerIntentScope>();
  // A direct, explicit future-notification request authorizes only creation of
  // its bounded personal watch. The detector strips quoted spans and rejects
  // present-state questions, so quoted mail or a historical watch cannot grant
  // this scope.
  if (detectFutureWatchIntent(text)) scopes.add('watch_create');
  const sendVerbs = '(?:send|email|reply|text|message|invite|respond|rsvp|forward|contact)';
  if (affirmativeAction(text, sendVerbs) || orderedReadThenSend(text, sendVerbs))
    scopes.add('external_send');
  if (affirmativeAction(text, '(?:apply\\s+(?:to|for)|submit\\b.{0,80}\\b(?:application|form))')) {
    scopes.add('external_send');
    scopes.add('workspace_write');
  }
  if (
    affirmativeAction(text, 'follow through') &&
    /\b(?:and\s+(?:send|email|reply|text|message|invite|respond|rsvp|forward|contact)|(?:by|on|with)\s+(?:sending|emailing|replying|texting|messaging|inviting|responding|forwarding|contacting))\b/i.test(
      text,
    )
  )
    scopes.add('external_send');
  if (
    affirmativeAction(
      text,
      '(?:search|look(?:\\s+it)?\\s+up|browse|research|investigate|check|find|read|summari[sz]e|review|analy[sz]e)',
    )
  )
    scopes.add('external_read');
  if (/(?:^|[.!?;\n])\s*(?:what|which|who|when|where|why|how|is|are|does|did|can)\b/i.test(text))
    scopes.add('external_read');
  if (
    /\b(?:(?:my|our|the|configured)\s+)?(?:calendar|schedule|inbox|email|mail|gmail|mailbox|meeting|appointment|interview)\b/i.test(
      text,
    ) &&
    (scopes.has('external_read') ||
      /\b(?:what|when|where|who|which|is|are|search|check|find|look up|read|review)\b/i.test(text))
  )
    scopes.add('private_read');
  if (
    affirmativeAction(text, '(?:search|check|find|look up|read|review)') &&
    /\b(?:my|our)\s+(?:hotel|reservation|booking)\b/i.test(text)
  )
    scopes.add('private_read');
  if (
    affirmativeAction(text, '(?:create|make|save)\\b.{0,100}\\bcard') &&
    /\b(?:my|our)\s+(?:hotel|reservation|booking)\b/i.test(text) &&
    /\b(?:mailbox|inbox|email|mail)\b/i.test(text)
  )
    scopes.add('private_read');
  if (
    !explicitlyOptsOutOfRecall(text) &&
    detectPersonalReadRequest([{ role: 'user', content: text }])
  )
    scopes.add('private_read');
  if (
    affirmativeAction(
      text,
      '(?:create|write|save|update|append|edit|build|add)\\b.{0,100}\\b(?:document|doc|sheet|spreadsheet|slide|presentation|file|workspace|tracker|table)',
    )
  )
    scopes.add('workspace_write');
  if (
    affirmativeAction(
      text,
      '(?:create|start|update|work on|continue|make progress on)\\b.{0,80}\\b(?:goal|long-term goal)',
    )
  )
    scopes.add('memory_write');
  if (
    affirmativeAction(
      text,
      '(?:create|schedule|add|put|update|move|cancel|delete|set)\\b.{0,100}\\b(?:calendar|event|meeting|appointment|reminder|task|watch|alert|mission|goal)',
    )
  )
    scopes.add('personal_write');
  // Directly asking for a personal reminder is a personal write even when
  // phrased as “Remind me tomorrow ...” instead of “create a reminder”. Keep
  // this imperative owner-authored shape separate from questions and narration.
  const nextVisitReminder =
    /^\s*[Nn]ext\s+[Tt]ime we are down in [A-Z][\p{L}\p{M}'’.-]*(?:\s+[A-Z][\p{L}\p{M}'’.-]*){0,3},?\s+remind me about\b[^.!?;\n]{1,100}[.!]?\s*$/u.test(
      text,
    );
  if (
    affirmativeAction(
      text,
      'remind\\s+me\\b.{0,120}\\b(?:to|about|when|after|before|at|on|in|tomorrow|today|tonight|next)',
    ) ||
    nextVisitReminder
  )
    scopes.add('personal_write');
  if (
    affirmativeAction(
      text,
      '(?:schedule|set up)\\b.{0,80}\\b(?:follow[- ]?up|check[- ]?in|future task|watch|mission)',
    )
  )
    scopes.add('personal_write');
  // Registering a confirmation watch is a personal scheduling action. A
  // positively requested application may include the watch after its portal
  // receipt; registration still requires exact approval of every future write.
  const confirmationWatch = '(?:watch|monitor)\\b.{0,100}\\bconfirmation\\s+email';
  if (
    affirmativeAction(text, confirmationWatch) ||
    (scopes.has('external_send') &&
      affirmativeAction(text, '(?:apply\\s+(?:to|for)|submit\\b.{0,80}\\bapplication)') &&
      /(?:^|[.!?;\n])\s*After\s+(?:the\s+)?portal\s+receipt,\s*(?:please\s+)?(?:watch|monitor)\b[^.!?;\n]{0,100}\bconfirmation\s+email\b/i.test(
        text,
      ))
  )
    scopes.add('personal_write');
  // These are established owner-directed memory workflows that do not use
  // the generic “remember this” wording. Keep the shapes narrow: an imperative
  // birthday update or the owner’s own “order for you to remember” still grants
  // memory scope, while quoted or narrated instructions remain data.
  if (
    /^\s*(?:here are|these are)\s+(?:the\s+)?birthdays?\b[^.!?;\n]{0,180},\s*(?:please\s+)?update\s+(?:their|the listed people['’]?)\s+(?:birthday|birthdays|information|details)(?:\s+for me)?(?:[.!]|\r?\n|$)/i.test(
      text,
    ) &&
    !/\b(?:do not|don't|never|should not|shouldn't)\b[^.!?]{0,100}\b(?:update|attach|save|remember)\b/i.test(
      text,
    )
  )
    scopes.add('memory_write');
  if (
    affirmativeAction(
      text,
      '(?:this is|here is)\\s+(?:my|our)\\s+[^.!?;\\n]{1,40}\\s+for you to remember',
    )
  )
    scopes.add('memory_write');
  if (
    /^\s*(?:(?:please\s+)?remember|(?:can|could|would)\s+you\s+remember|(?:I want|I need|I'd like|I would like)\s+you\s+to\s+remember)\s+(?:my|our)\s+order\b/i.test(
      text,
    )
  )
    scopes.add('memory_write');
  if (
    affirmativeAction(
      text,
      '(?:attach|link|add)\\b.{0,100}\\b(?:these\\s+)?birthdays?\\b.{0,100}\\b(?:graph|memory|profile)',
    )
  )
    scopes.add('memory_write');
  if (
    affirmativeAction(
      text,
      '(?:remember|save|store)\\b.{0,100}\\b(?:that|this|fact|preference|memory|for later)',
    )
  )
    scopes.add('memory_write');
  if (
    affirmativeAction(
      text,
      '(?:(?:report|file|record|open)\\b.{0,100}\\b(?:bug|issue|failure|problem|incorrect behavior)|(?:report|file|record)\\s+(?:it|this|that))',
    )
  )
    scopes.add('feedback_write');
  if (affirmativeAction(text, '(?:draft|prepare)\\b.{0,80}\\b(?:email|message|reply)'))
    scopes.add('private_write');
  return [...scopes];
}

function isAcknowledgment(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!?,\s]+$/g, '');
  return /^(?:thanks|thank you|got it|okay|ok|sounds good|great|👍|🙏|❤️|yes|yep|sure)$/.test(
    normalized,
  );
}

export function extractOwnerIntent(input: {
  text: string;
  trust: Trust;
  trigger?: unknown;
}): OwnerIntent {
  if (input.trust !== 'owner') {
    return {
      sourceActor:
        input.trust === 'assistant'
          ? 'assistant'
          : input.trust === 'known' || input.trust === 'unknown'
            ? 'third_party'
            : 'unknown',
      requestKind: 'external_trigger',
      ownerAuthoredText: '',
      externalText: input.text,
      authorizedScopes: [],
      separation: 'none',
    };
  }
  if (isForwardedIngest({ trigger: input.trigger })) {
    return {
      sourceActor: 'third_party',
      requestKind: 'external_trigger',
      ownerAuthoredText: '',
      externalText: input.text,
      authorizedScopes: [],
      separation: 'clear',
    };
  }

  const payload = (input.trigger as { payload?: Record<string, unknown> } | null)?.payload;
  const quoteFlag = payload?.quotesExternalContent === true || payload?.taintedOrigin === true;
  const hasProvenance = Object.hasOwn(payload ?? {}, 'emailProvenance');
  const structured = hasProvenance
    ? emailProvenanceText(payload?.emailProvenance, input.text)
    : null;
  const triggerSource = (input.trigger as { source?: unknown } | null)?.source;
  if (hasProvenance && (triggerSource !== 'email' || !structured || structured.unknown)) {
    return {
      sourceActor: 'unknown',
      requestKind: 'ambiguous',
      ownerAuthoredText: '',
      externalText: input.text,
      authorizedScopes: [],
      separation: 'unknown',
    };
  }
  if (
    !structured &&
    quoteFlag &&
    !externalBoundary.test(input.text) &&
    !/^\s*>/m.test(input.text) &&
    !/[“"][^“”"]+[”"]/m.test(input.text)
  ) {
    return {
      sourceActor: 'unknown',
      requestKind: 'ambiguous',
      ownerAuthoredText: '',
      externalText: input.text,
      authorizedScopes: [],
      separation: 'unknown',
    };
  }

  const structuredAuthored = structured ? splitQuoted(structured.authored) : null;
  const split =
    structured && structuredAuthored
      ? {
          authored: structuredAuthored.authored,
          external: [structured.external, structuredAuthored.external].filter(Boolean).join('\n'),
        }
      : splitQuoted(input.text);
  if (!structured && hasUnmatchedQuote(input.text)) {
    return {
      sourceActor: 'unknown',
      requestKind: 'ambiguous',
      ownerAuthoredText: split.authored,
      externalText: split.external || input.text,
      authorizedScopes: [],
      separation: 'unknown',
    };
  }
  const authored = split.authored;
  const scopes = scopesFor(authored);
  const sourceActor = split.external ? 'mixed' : 'owner';
  const requestKind =
    !authored && split.external
      ? 'external_trigger'
      : scopes.length > 0 ||
          /\b(?:please|can you|could you|what|when|where|who|how)\b/i.test(authored)
        ? 'new_request'
        : isAcknowledgment(authored)
          ? 'acknowledgment'
          : authored
            ? 'reaction'
            : split.external
              ? 'external_trigger'
              : 'ambiguous';
  return {
    sourceActor,
    requestKind,
    ownerAuthoredText: authored,
    externalText: split.external,
    authorizedScopes: scopes,
    separation: split.external ? 'clear' : 'none',
  };
}

export function latestOwnerIntent(
  window: Array<{ role: string; content: unknown }>,
  input: {
    trust: Trust;
    trigger?: unknown;
    clarificationContinuation?: ClarificationContinuation;
  },
): OwnerIntent {
  const latest = [...window].reverse().find((message) => message.role === 'user');
  const current = extractOwnerIntent({ text: messageText(latest?.content), ...input });
  const publicLookupRetry =
    input.trust === 'owner' &&
    current.sourceActor === 'owner' &&
    current.separation !== 'unknown' &&
    /^(?:look it up|search the web|check (?:the )?(?:score|wcore)|run it|rub it|try again|check again)\b/i.test(
      current.ownerAuthoredText.trim(),
    );
  if (
    publicLookupRetry &&
    detectLiveLookup(ownerAuthoredWindow(window, current))?.kind === 'web' &&
    !current.authorizedScopes.includes('external_read')
  ) {
    current.authorizedScopes.push('external_read');
    if (current.requestKind === 'reaction') current.requestKind = 'new_request';
  }
  // The current owner question may name its subject by reference (for
  // example "What time is check-in?"). History resolves the read topic only;
  // it cannot reauthorize earlier mutations or quoted third-party requests.
  if (
    input.trust === 'owner' &&
    (current.sourceActor === 'owner' || current.sourceActor === 'mixed') &&
    current.separation !== 'unknown' &&
    !explicitlyOptsOutOfRecall(current.ownerAuthoredText) &&
    detectPersonalReadRequest(
      ownerAuthoredWindow(window, current).map((message) => {
        if (message.role !== 'user') return message;
        const text = messageText(message.content);
        return {
          ...message,
          content: hasUnmatchedQuote(text) ? '' : splitQuoted(text).authored,
        };
      }),
    ) &&
    !current.authorizedScopes.includes('private_read')
  )
    current.authorizedScopes.push('private_read');
  const continuation = input.clarificationContinuation;
  if (
    input.trust !== 'owner' ||
    !continuation ||
    continuation.answerStatus !== 'answer' ||
    !current.ownerAuthoredText
  )
    return current;
  return {
    ...current,
    requestKind: 'new_request',
    ownerAuthoredText:
      `${continuation.ownerAuthoredText}\nOwner clarification answer: ${current.ownerAuthoredText}`.trim(),
    authorizedScopes: [...new Set([...continuation.authorizedScopes, ...current.authorizedScopes])],
  };
}

export function ownerAuthoredWindow<T extends { role: string; content: unknown }>(
  window: T[],
  intent: OwnerIntent,
): T[] {
  const latestIndex = window.findLastIndex((message) => message.role === 'user');
  if (latestIndex < 0) return window;
  return window.map((message, index) =>
    index === latestIndex ? { ...message, content: intent.ownerAuthoredText } : message,
  );
}
