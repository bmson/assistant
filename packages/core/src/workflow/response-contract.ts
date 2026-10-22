import { sameCalendarOccurrence } from '@assistant/persistence';
import { stripBackgroundNoticeEcho } from '../chat-card.js';
import { communicationReceipt } from '../communication-receipt.js';
import {
  explicitlyRequestsRepetition,
  gradeAuditedOutput,
  repairPresentationDefects,
} from '../model-router/audit-graders.js';
import { billingAuditProjection, renderBillingAudit } from './billing-audit.js';
import type { BriefingCalendarEvent } from './briefing.js';
import { calendarEventAnalysisResponse } from './calendar-event-analysis.js';
import {
  calendarSourceDateLabel,
  calendarSourceInterval,
  calendarWindowMembership,
} from './calendar-read-window.js';
import {
  calendarArrivalLead,
  calendarRelationship,
  classifyCalendarOverlap,
  parseCalendarOwnerParticipation,
  possibleCalendarIdentityDisagreement,
  verifiedOwnerParticipation,
} from './calendar-relationship.js';
import { safeCalendarSourceUrl, safeVideoMeetingUrl } from './calendar-source-link.js';
import { type ClaimFact, evidenceClaimFacts } from './claim-facts.js';
import type { CompoundTripExtraction } from './compound-trip-extraction.js';
import {
  compoundTripReadProjection,
  renderCompoundTripReadResponse,
  upcomingFlightReadProjection,
} from './compound-trip-read.js';
import { createdDocumentVerification } from './document-verification.js';
import {
  type ExplicitSourceSelection,
  explicitSourceCoverage,
  explicitSourceResponse,
} from './explicit-source-read.js';
import { correctFlightWriteClaims } from './flight-write-contract.js';
import { detectFutureWatchIntent, type FutureWatchIntent } from './future-watch-intent.js';
import {
  familyBirthdayReadProjection,
  type MemoryReadSelection,
  renderMemoryReadAnswer,
  validMemoryReadSelection,
} from './memory-read-answer.js';
import { personCalendarResponse } from './person-calendar.js';
import { matchesHistoricalMemorySearch, type PersonalReadRequest } from './read-intent.js';
import { effectiveReminders } from './reminder-state.js';
import { weatherLookupResponseCards } from './response-cards.js';
import { isDurableSave, isMemoryWriteRequest, savedWorkSummary } from './saved-work.js';
import {
  weeklyCalendarPlan as renderWeeklyCalendarPlan,
  weeklyCalendarPlanResult,
} from './weekly-calendar-plan.js';

/**
 * The model writes prose, but the task/tool ledger is the authority for what
 * happened. This module is deliberately conservative: when a reply describes
 * an external action without matching evidence, replace it with a transparent
 * response instead of publishing a convincing but false status update.
 */

export interface ActionEvidence {
  toolName: string;
  status: string;
  args?: unknown;
  result: unknown;
  error?: string | null;
  /**
   * False when the row comes from an earlier task in the same conversation.
   * Absent means "this task" so existing callers keep the strict behaviour.
   */
  fromCurrentTask?: boolean;
  /**
   * The call's position in its task's step loop. The contract never reads it;
   * it is here so a caller that selects the ledger for the contract can also
   * put the rows back in execution order (see card-steps.ts).
   */
  step?: number;
}

type ActionKind =
  | 'workspace'
  | 'spreadsheet'
  | 'presentation'
  | 'outbound'
  | 'email_draft'
  | 'inbox_write'
  | 'application'
  | 'calendar'
  | 'reminder_create'
  | 'reminder_cancel'
  | 'calendar_read'
  | 'inbox_read'
  | 'research'
  | 'background'
  | 'memory'
  | 'approval';

export interface ResponseContractResult {
  text: string;
  blocked: boolean;
  unsupported: ActionKind[];
  /** The draft was replaced because it contained an obvious generation loop. */
  qualityFallback?: boolean;
  /**
   * Why a lookup answer was rendered from the ledger instead of published as
   * the model wrote it. Absent on a published draft and on every non-read
   * turn. Not a block: the owner still gets a complete, verified answer, just
   * in a plainer shape, so this is a signal to watch rather than a failure to
   * surface.
   */
  groundingFallback?: string[];
  /** Structured evidence for a weekly review; drives task status without parsing prose. */
  weeklyPlanAssessment?: { coverageComplete: boolean; slotCount: number };
}

interface ResponseContractOptions {
  /** Runtime-selected exact historical quotes; revalidated against the current ledger. */
  memoryReadSelection?: MemoryReadSelection;
  explicitSourceSelection?: ExplicitSourceSelection;
  requestText?: string;
  urlCorpus?: string;
  /** Deterministically detected from the latest owner turn. */
  readRequest?: PersonalReadRequest | null;
  /** A companion weather lookup was explicitly requested in this owner turn. */
  companionWeather?: boolean;
  /** Task-local, quote-validated facts extracted from complete booking messages. */
  compoundTripExtraction?: CompoundTripExtraction;
  /**
   * Context the turn legitimately supplied that is not itself a tool result —
   * chiefly the ambient weather/location block, which v25 invites the answer
   * to close on. Without it a true local aside reads as an invention.
   */
  groundingCorpus?: string;
  /**
   * What a live lookup in this same turn retrieved — weather readings, game
   * lines, a route. "What's on tomorrow and what's the weather?" is answered
   * from two sources; the calendar half is still held to the calendar, and
   * the rest may name only what the lookup returned.
   */
  liveCorpus?: string;
}

const OUTBOUND_OBJECTS = 'email|message|sms|text|call|outreach|reply|follow-?up';
const APPLICATION_OBJECTS =
  'application|applications|job application|application form|career portal|form submission|jobs?|roles?|positions?';
const CALENDAR_OBJECTS = 'calendar|calendar event|event|appointment|meeting|interview';
const CALENDAR_READ_OBJECTS = 'calendars?|schedule|agenda|upcoming events|appointments';
const INBOX_READ_OBJECTS = 'inbox|e-?mails?|mail|messages|threads|texts';
// Read claims are past-tense only, so "check your calendar" (advice) and
// "I'll check" (a promise) don't trip them.
const READ_ACTIONS =
  'checked|reviewed|looked (?:at|through|over|in|into)|went (?:through|over)|searched|scanned|read through|pulled up|examined|inspected';
const RESEARCH_OBJECTS =
  'research|companies|company list|target companies|job boards?|sources?|search results?';
const BACKGROUND_OBJECTS = 'mission|task|watch(?:er|es)?|monitor(?:ing)?|tracker';

const FIRST_PERSON_PREFIX = String.raw`\b(?:i|we|the assistant)(?:['’]ve\s+|\s+(?:(?:have|has|had|just|already|successfully|now|am|are|was|were)\s+)*)`;

/**
 * Detect a completed external action while keeping the object connected to
 * its verb. Looking only for "I sent" plus a later "document" caused an
 * email *about* a document to be mistaken for a document creation.
 */
function completedActionClaim(
  text: string,
  objects: string,
  actions: string,
  statuses = actions,
): boolean {
  const object = `(?:${objects})`;
  const action = `(?:${actions})`;
  const status = `(?:${statuses})`;
  const article = String.raw`(?:a|an|the|your|all)?\s*`;

  // A terse first-person recap drops the pronoun ("Sent the email", "…, and sent
  // the client an email"), so the verb may OPEN a clause. It must not match
  // mid-clause: there the subject is almost always somebody else — "TripIt sent
  // you an email", "Hotels.com emailed your confirmation" — and reporting what a
  // sender did is not a claim that the assistant did it. That false positive
  // threw away correct answers to ordinary "did I get mail about X" questions.
  const clauseStart = String.raw`(?:(?:^|\n)\s*(?:[-*•]\s*)?|[.!?;:—]\s*|,\s*(?:(?:and|then|also|but)\s+)?|\b(?:and|then|also|but)\s+)`;
  const leadIn = String.raw`(?:(?:just|already|now|successfully|then)\s+)*`;
  const actionBeforeObject = new RegExp(
    String.raw`${clauseStart}${leadIn}${action}\b[^.\n]{0,44}\b${article}${object}\b`,
    'im',
  );
  const firstPersonAction = new RegExp(
    String.raw`${FIRST_PERSON_PREFIX}(?!(?:not|never)\b)${action}\b[^.\n]{0,80}\b${object}\b`,
    'i',
  );
  const objectStatus = new RegExp(
    String.raw`\b${article}${object}\b[^.\n]{0,70}\b(?:has|have|was|were|is|are)\s+(?:been\s+)?${status}\b`,
    'i',
  );
  const terseObjectStatus = new RegExp(
    String.raw`${clauseStart}${article}${object}\b\s*(?::|-|—)?\s*${status}\b`,
    'im',
  );
  const assistantObjectStatus = [...text.matchAll(new RegExp(objectStatus.source, 'gi'))].some(
    (match) => {
      const before = text.slice(Math.max(0, (match.index ?? 0) - 80), match.index);
      const after = text.slice((match.index ?? 0) + match[0].length);
      // Explicit source actors do not claim the assistant performed the work.
      return (
        !/\b(?:his|her|their|its|[\p{L}]+['’]s)\s*$/iu.test(before) &&
        !/^\s+by\s+(?!me\b|us\b|the assistant\b)\S+/i.test(after)
      );
    },
  );

  return (
    actionBeforeObject.test(text) ||
    firstPersonAction.test(text) ||
    assistantObjectStatus ||
    terseObjectStatus.test(text)
  );
}

function firstPersonCompletedAction(text: string, actions: string): boolean {
  return new RegExp(
    String.raw`${FIRST_PERSON_PREFIX}(?!(?:not|never)\b)(?:${actions})\b`,
    'i',
  ).test(text);
}

/**
 * Keep the guard focused on promises of *ongoing* hidden work. A next-step
 * plan such as "I'll research jobs" is not a completed-action claim, so it
 * must not be rewritten into a misleading failure response.
 */
const backgroundPromise =
  /\b(?:i|we)(?:\s+will|['’]ll)\s+(?:continue|keep)\b|\b(?:i|we)[^.\n]{0,80}\b(?:silently|in the background|while you(?:'|’)re away)\b|\b(?:starting|proceeding|running)\s+(?:silently|in the background)\b|\b(?:silently|in the background|real[- ]time tracker|mission launched)\b/i;
const futureWatchPromise =
  /\b(?:i|we)(?:\s+will|['’]ll)\s+(?:watch|monitor|keep\s+(?:watching|monitoring|an\s+eye\s+on)|notify|alert|ping|let\s+you\s+know)\b[^.!?\n]{0,120}\b(?:if|when|once|until)\b|\b(?:watch|monitoring)\b[^.!?\n]{0,100}\bactive\b/i;
const withoutFutureWatchPromise = (text: string): string =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => sentence.trim() && !futureWatchPromise.test(sentence))
    .join('\n')
    .trim();

/** Preserve useful turn results while naming the missing future-watch receipt. */
export function withMissingFutureWatchNotice(text: string): string {
  const usefulAnswer = withoutFutureWatchPromise(text);
  if (
    /\b(?:no active watch|watch\b[^.!?\n]{0,60}\b(?:not|never|could not|couldn't|cannot)\b[^.!?\n]{0,30}\b(?:confirmed|created|active)|(?:could not|couldn't|cannot) confirm\b[^.!?\n]{0,40}\bwatch)\b/i.test(
      usefulAnswer,
    )
  )
    return usefulAnswer;
  return `${usefulAnswer ? `${usefulAnswer}\n\n` : ''}No active watch has been confirmed for this request, so I cannot promise a future notification.`;
}
const backgroundApplicationPromise =
  /\b(?:i|we)(?:\s+will|['’]ll)\s+(?:continue|keep)\s+(?:applying|submitting|filing|completing)\b|\b(?:continue|keep)\s+(?:applying|submitting|filing)\s+(?:to|for)\b/i;
const progressClaim =
  /\b\d+\s+(?:target\s+)?(?:companies|applications|outreach(?:\s+messages)?|drafts)\s+(?:identified|logged|added|ready|submitted|sent|completed)\b/i;
const statusNarrative =
  /\b(?:tracker|company list|applications?|outreach|drafts?|target companies)\b[^.\n]{0,80}\b(?:active|live|ready|complete|completed|updated|added|logged|researching|submitted|sent)\b/i;
const artifactStatus =
  /\b(?:spreadsheet|sheet|document|doc|deck|slides|file|tracker)\b[^.\n]{0,40}\b(?:ready|live|active|updated|available|shared)\b/i;
const countedTracker =
  /\b(?:tracker|company list|spreadsheet|sheet)\b[^.\n]{0,70}\b(?:now\s+)?(?:has|have)\s+\d+\b/i;
// Passive outbound: the subject is the recipient rather than the message, so
// the object-anchored outbound patterns miss it ("the client has been emailed",
// "they were notified"). Requires the "(has|have|was|were) been <verb>" form so
// it does not fire on ordinary prose.
const passiveOutbound =
  /\b(?:has|have|was|were)\s+been\s+(?:contacted|emailed|texted|messaged|notified|pinged|reached\s+out\s+to)\b/i;
// An explicit negative status is not a claim that this turn completed an
// outbound effect. Remove only the negated clause before checking positive
// completion claims, so another affirmative clause remains evidence-gated.
const NEGATED_OUTBOUND_STATUS =
  /\bno\s+(?:new\s+)?(?:(?:emails?|messages?|texts?|calls?|replies|follow-ups?)\s+(?:(?:was|were)\s+|(?:has|have)\s+been\s+)|outreach\s+(?:was\s+|has\s+been\s+))(?:sent|delivered|contacted|emailed|texted|messaged|called|replied|forwarded|notified|pinged)\b/gi;

function withoutNegatedOutboundStatus(text: string): string {
  return text.replace(NEGATED_OUTBOUND_STATUS, '');
}
// A completed claim that a fact was written to long-term memory/the owner
// profile. Requires a completion verb near the memory/profile object, so a
// future-tense "I'll keep that in mind" does not trip it.
const memoryClaim =
  /\b(?:saved|stored|recorded|noted|logged|updated|corrected|remembered|memoriz(?:e|ed)|committed|kept|added|confirmed)\b[^.\n]{0,40}\b(?:in|to|into)?\s*(?:your\s+)?(?:memory|profile|the\s+record)\b/i;
const memoryPromise =
  /\b(?:i|we)(?:['’]ll|\s+will)\s+remember\b|\bmemory\s+(?:(?:has been|was|is)\s+)?(?:saved|updated|stored)\b/i;
// Negative-result narration of a read: "found no flights on your calendar",
// "nothing in your inbox", "your calendar is clear". A model that never ran a
// read tool asserting emptiness is the same fabrication as a fake "I checked".
//
// NEGATED_ANY is the third arm, and in practice the common one: a model with no
// tools reaches for "I don't see any emails in your inbox" far more readily than
// for "nothing in your inbox". It needs its own arm because the negation sits on
// the verb here rather than on the noun.
const NEGATED_ANY = String.raw`\b(?:do(?:es)?n(?:'|’)?t|did\s?n(?:'|’)?t|can(?:'|’)?t|cannot|could\s?n(?:'|’)?t|won(?:'|’)?t|am\s+not|(?:'|’)m\s+not|is\s+not|isn(?:'|’)?t|not)\s+(?:seeing|see|find|finding|show(?:ing)?|have|having)\b[^.\n]{0,30}\bany(?:thing)?\b`;
const emptyCalendarClaim = new RegExp(
  [
    String.raw`\b(?:no|none|nothing|zero)\b[^.\n]{0,40}\b(?:on|in)\s+(?:your|the|my|either|any)\b[^.\n]{0,30}\b(?:calendar|schedule|agenda)\b`,
    String.raw`\byour (?:calendar|schedule) (?:is|looks|appears) (?:clear|empty|free|wide open)\b`,
    String.raw`${NEGATED_ANY}[^.\n]{0,40}\b(?:calendar|schedule|agenda|events?|appointments?|meetings?)\b`,
  ].join('|'),
  'i',
);
const emptyInboxClaim = new RegExp(
  [
    String.raw`\b(?:no|none|nothing|zero)\b[^.\n]{0,40}\bin\s+(?:your|the|my)\b[^.\n]{0,30}\b(?:inbox|mailbox|e-?mail)\b`,
    String.raw`\byour inbox (?:is|looks|appears) (?:clear|empty)\b`,
    String.raw`${NEGATED_ANY}[^.\n]{0,40}\b(?:inbox|mailbox|e-?mails?|mail|messages?)\b`,
  ].join('|'),
  'i',
);
const INBOX_WRITE_ACTIONS =
  'archived|unarchived|flagged|unflagged|starred|unstarred|labeled|labelled|marked|moved';
const INBOX_WRITE_OBJECTS = 'e-?mails?|messages?|threads?|inbox|it|them';
const INBOX_WRITE_NAMED_OBJECTS = 'e-?mails?|messages?|threads?|inbox';
const inboxWriteClaim = new RegExp(
  String.raw`${FIRST_PERSON_PREFIX}(?!(?:not|never)\b)(?:${INBOX_WRITE_ACTIONS})\b[^.\n]{0,70}\b(?:${INBOX_WRITE_OBJECTS})\b|(?:^|[.!?]\s+)(?:${INBOX_WRITE_ACTIONS})\b[^.\n]{0,70}\b(?:${INBOX_WRITE_NAMED_OBJECTS})\b|\b(?:${INBOX_WRITE_NAMED_OBJECTS})\b[^.\n]{0,40}\b(?:has|have|was|were)\s+(?:been\s+)?(?:archived|unarchived|flagged|unflagged|starred|unstarred|labeled|labelled|marked|moved)\b`,
  'im',
);
const savedEmailDraftClaim =
  /\b(?:saved|created|added)\b[^.\n]{0,70}\b(?:(?:gmail|drafts? folder)\b[^.\n]{0,30}\bdraft|draft\b[^.\n]{0,30}\b(?:gmail|drafts? folder))\b|\bdrafted\b[^.\n]{0,50}\b(?:e-?mail|message|reply)\b[^.\n]{0,20}\bin\s+(?:gmail|the drafts? folder)\b|\b(?:gmail\s+draft|draft\s+in\s+(?:gmail|the drafts? folder))\b[^.\n]{0,30}\b(?:saved|created|ready)\b|\bdraft\b[^.\n]{0,30}\b(?:is|was)\s+(?!not\b)(?:now\s+)?in\s+(?:gmail|the drafts? folder)\b|\b(?:find|see)\b[^.\n]{0,40}\bdraft\b[^.\n]{0,30}\bin\s+(?:gmail|the\s+(?:gmail\s+)?drafts?\s+folder)\b/i;

/**
 * Approval rows and short codes are created only by the dispatcher. A model
 * can mimic an earlier notice from conversation history without emitting a
 * tool call, leaving the owner looking for an approval that does not exist.
 */
export function isSimulatedApprovalNotice(text: string): boolean {
  return (
    /\bthis needs your approval before i act\b/i.test(text) ||
    /\bapprove or deny it on the approvals page\b/i.test(text) ||
    /\*\*\[A\d+\]\*\*/i.test(text)
  );
}

export type ActiveWatchReceipt =
  | {
      channel: 'email';
      watchId: string;
      expiresAt: string;
      expectedSenderEmails: string[];
      keywords: string[];
    }
  | {
      channel: 'web';
      watchId: string;
      expiresAt: string;
      url: string;
      mode: 'change' | 'contains' | 'absent';
      pattern?: string;
    };

/** Parse a current-task receipt for an unexpired, active watch. */
export function activeWatchReceipt(
  evidence: ActionEvidence,
  nowMs = Date.now(),
): ActiveWatchReceipt | undefined {
  if (
    evidence.fromCurrentTask === false ||
    evidence.status !== 'succeeded' ||
    (evidence.toolName !== 'watch.create' && evidence.toolName !== 'watch.web')
  )
    return undefined;
  const result = record(evidence.result);
  if (
    !result ||
    result.ok === false ||
    result.status !== 'active' ||
    typeof result.watchId !== 'string' ||
    !result.watchId.trim() ||
    typeof result.expiresAt !== 'string'
  )
    return undefined;
  const expiry = Date.parse(result.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= nowMs) return undefined;
  if (evidence.toolName === 'watch.create') {
    const senders = result.expectedSenderEmails;
    if (
      !Array.isArray(senders) ||
      senders.length === 0 ||
      !senders.every(
        (sender) => typeof sender === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender),
      )
    )
      return undefined;
    return {
      channel: 'email',
      watchId: result.watchId,
      expiresAt: new Date(expiry).toISOString(),
      expectedSenderEmails: [...new Set(senders.map((sender) => sender.toLowerCase()))],
      keywords: Array.isArray(result.keywords)
        ? result.keywords.filter((keyword): keyword is string => typeof keyword === 'string')
        : [],
    };
  }
  if (
    typeof result.url !== 'string' ||
    !['change', 'contains', 'absent'].includes(String(result.mode))
  )
    return undefined;
  let url: URL;
  try {
    url = new URL(result.url);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    (result.mode !== 'change' && (typeof result.pattern !== 'string' || !result.pattern.trim()))
  )
    return undefined;
  return {
    channel: 'web',
    watchId: result.watchId,
    expiresAt: new Date(expiry).toISOString(),
    url: url.href,
    mode: result.mode as 'change' | 'contains' | 'absent',
    ...(typeof result.pattern === 'string' ? { pattern: result.pattern } : {}),
  };
}

function watchMatchesRequest(
  receipt: ActiveWatchReceipt,
  intent: FutureWatchIntent,
  evidence: ActionEvidence[],
): boolean {
  if (receipt.channel !== intent.channel) return false;
  if (receipt.channel === 'web') {
    if (intent.explicitUrls.length === 0) return false;
    return intent.explicitUrls.some((raw) => {
      try {
        return new URL(raw).href === receipt.url;
      } catch {
        return false;
      }
    });
  }
  if (intent.explicitEmails.length > 0) {
    return intent.explicitEmails.some((email) => receipt.expectedSenderEmails.includes(email));
  }
  const targetTerms = intent.targetTerms.map((term) => term.toLowerCase());
  if (targetTerms.length === 0) return false;
  const resolved = new Set<string>();
  for (const row of evidence) {
    if (
      row.fromCurrentTask === false ||
      row.status !== 'succeeded' ||
      row.toolName !== 'gmail.search'
    )
      continue;
    const result = record(row.result);
    if (result?.complete !== true || !Array.isArray(result.results)) continue;
    for (const match of result.results) {
      const item = record(match);
      if (!item) continue;
      const from = typeof item.from === 'string' ? item.from.toLowerCase() : '';
      const subject = typeof item.subject === 'string' ? item.subject.toLowerCase() : '';
      if (!targetTerms.some((term) => from.includes(term) || subject.includes(term))) continue;
      for (const email of from.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []) {
        resolved.add(email.toLowerCase());
      }
    }
  }
  return resolved.size === 1 && receipt.expectedSenderEmails.includes([...resolved][0] ?? '');
}

function successful(evidence: ActionEvidence): boolean {
  if (evidence.status !== 'succeeded') return false;
  if (evidence.toolName === 'watch.create' || evidence.toolName === 'watch.web')
    return Boolean(activeWatchReceipt(evidence));
  if (evidence.toolName === 'gmail.send' || evidence.toolName === 'sms.send')
    return !!communicationReceipt(evidence);
  if (!evidence.result || typeof evidence.result !== 'object') return true;

  const result = evidence.result as Record<string, unknown>;
  if (result.ok === false) return false;
  if (typeof result.status === 'number' && result.status >= 400) return false;
  if (result.deliveryStatus === 'unknown') return false;
  return true;
}

/** Browser step actions that actually submit a form (vs. read-only navigation). */
const BROWSER_SUBMIT_ACTIONS: ReadonlySet<string> = new Set([
  'click',
  'press',
  'select',
  'type',
  'upload',
]);

const CONFIRMATION_TEXT =
  /\b(?:application[^.\n]{0,100}\b(?:submitted|received|complete|confirmed)|thank\s+you\s+for\s+applying|we(?:'|’)ve\s+received\s+your\s+application)\b/i;

/**
 * A submission receipt only counts when THIS browser run actually interacted
 * with a form AND then read back an explicit confirmation. A read-only
 * goto+extract of a careers/marketing page that merely contains "thank you for
 * applying" is not evidence of a submission — and that extracted page text is
 * attacker-influenceable, so on its own it must never authorise an
 * "I submitted your application" claim.
 */
function browserApplicationConfirmed(evidence: ActionEvidence): boolean {
  if (!successful(evidence) || evidence.toolName !== 'browser.execute') return false;
  if (!evidence.result || typeof evidence.result !== 'object') return false;
  const outputs = (evidence.result as { outputs?: unknown }).outputs;
  if (!Array.isArray(outputs)) return false;
  const submitted = outputs.some((output) => {
    if (!output || typeof output !== 'object') return false;
    const action = (output as { action?: unknown }).action;
    return (
      typeof action === 'string' &&
      BROWSER_SUBMIT_ACTIONS.has(action) &&
      (output as { ok?: unknown }).ok !== false
    );
  });
  if (!submitted) return false;
  return outputs.some((output) => {
    if (!output || typeof output !== 'object') return false;
    const text = (output as { text?: unknown }).text;
    return typeof text === 'string' && CONFIRMATION_TEXT.test(text);
  });
}

/**
 * Outward-facing, hard-to-reverse actions must be evidenced by THIS task: a
 * send, submission, or booking from an earlier turn never authorises claiming
 * a fresh one. Artifact, research, and background kinds accept
 * conversation-scoped evidence, because the thing they refer to still exists —
 * truthfully mentioning a doc created two turns ago was being rewritten into
 * "I have not created anything outside this chat".
 */
const CURRENT_TASK_ONLY: ReadonlySet<ActionKind> = new Set([
  'outbound',
  'email_draft',
  'inbox_write',
  'application',
  'calendar',
  'reminder_create',
  'reminder_cancel',
  // "I saved that to memory" is a claim about THIS turn — an earlier save
  // doesn't authorise narrating a fresh one.
  'memory',
  // "I checked your calendar/inbox" narrates a fresh read; last turn's read
  // says nothing about what's there now.
  'calendar_read',
  'inbox_read',
]);

function inScope(kind: ActionKind, item: ActionEvidence): boolean {
  return !CURRENT_TASK_ONLY.has(kind) || item.fromCurrentTask !== false;
}

function supports(
  kind: ActionKind,
  evidence: ActionEvidence[],
  currentTaskOnly = false,
  requestText?: string,
): boolean {
  const usable = evidence.filter(
    (item) =>
      successful(item) &&
      inScope(kind, item) &&
      (!currentTaskOnly || item.fromCurrentTask !== false),
  );
  const names = usable.map((item) => item.toolName);
  switch (kind) {
    case 'workspace':
      return names.some(
        (name) =>
          /^(docs\.(?:create|append|replace_text|share)|workspace\.write)$/.test(name) ||
          name === 'drive.download',
      );
    case 'spreadsheet':
      return names.some((name) => /^sheets\.(?:create|append_rows|write_rows)$/.test(name));
    case 'presentation':
      return names.some((name) => /^slides\.(?:create|append)$/.test(name));
    case 'outbound':
      return names.some((name) => /^(gmail\.send|sms\.send|email\.send)$/.test(name));
    case 'email_draft':
      return usable.some((item) => {
        const draftId = record(item.result)?.draftId;
        return (
          item.toolName === 'gmail.create_draft' &&
          typeof draftId === 'string' &&
          draftId.length > 0
        );
      });
    case 'inbox_write':
      return usable.some((item) => {
        if (item.toolName !== 'gmail.modify') return false;
        const result = record(item.result);
        return (
          (Array.isArray(result?.addedLabels) && result.addedLabels.length > 0) ||
          (Array.isArray(result?.removedLabels) && result.removedLabels.length > 0)
        );
      });
    // A browser run is not a submission receipt. Until there is a dedicated
    // application tool with an explicit confirmation result, never claim an
    // application was submitted.
    case 'application':
      return (
        names.some((name) => name === 'application.submit') ||
        usable.some(browserApplicationConfirmed)
      );
    case 'calendar':
      return names.some((name) => /^calendar\.(create|update|cancel|delete)/.test(name));
    case 'reminder_create':
      return [...effectiveReminders(usable).values()].some(
        (state) => state.created && state.enabled,
      );
    case 'reminder_cancel':
      return usable.some(
        (item) => item.toolName === 'reminder.cancel' && record(item.result)?.cancelled === true,
      );
    // A write proves only that a write happened. It does not prove the assistant
    // inspected every calendar or knew what else was scheduled.
    case 'calendar_read':
      return usable.some((item) => {
        const result = record(item.result);
        if (!result) return false;
        if (item.toolName === 'calendar.list_calendars') return Array.isArray(result.calendars);
        if (item.toolName === 'calendar.availability') return Array.isArray(result.busy);
        return (
          /^calendar\.(?:list_events|search_events)$/.test(item.toolName) &&
          Array.isArray(result.events)
        );
      });
    case 'inbox_read':
      return usable.some((item) => {
        const result = record(item.result);
        return item.toolName === 'gmail.search'
          ? Array.isArray(result?.results)
          : item.toolName === 'gmail.read_thread' && Array.isArray(result?.messages);
      });
    case 'research':
      return names.some((name) => name === 'web.fetch' || name === 'browser.execute');
    case 'background':
      return (
        names.some(
          (name) =>
            name === 'mission.update' ||
            name === 'task.schedule' ||
            name === 'applications.watch_confirmation',
        ) ||
        usable.some((item) => {
          const receipt = activeWatchReceipt(item);
          if (!receipt) return false;
          const intent = requestText ? detectFutureWatchIntent(requestText) : null;
          return !intent || watchMatchesRequest(receipt, intent, evidence);
        })
      );
    // Both tools persist owner information. A successful function invocation
    // can still return saved:false (e.g. a forgotten/tombstoned fact).
    case 'memory':
      return usable.some(isDurableSave);
    case 'approval':
      // Genuine approval notices are posted by the executor when it parks the
      // task and do not pass through the model-final response contract.
      return false;
  }
}

/**
 * A Google Workspace link is a *reference*, not a claim. Treating every
 * occurrence of the URL as a creation claim meant that linking a doc the
 * assistant really did build in an earlier turn ("you can track updates
 * here: <link>") was rewritten into a flat denial that it had created
 * anything. Require a completed mutation verb alongside the link, and read
 * the artifact kind off the URL path so a Sheets link is not reported as a
 * document action.
 */
const WORKSPACE_MUTATION =
  /\b(?:created|shared|uploaded|saved|updated|published|generated|prepared|exported|added|wrote|written|filled|populated)\b/i;
const ARTIFACT_EDIT =
  'updated|changed|edited|replaced|added|wrote|written|filled|populated|appended|formatted|reformatted';

const GOOGLE_ARTIFACT_URL = {
  workspace: /https:\/\/docs\.google\.com\/document\//i,
  spreadsheet: /https:\/\/docs\.google\.com\/spreadsheets\//i,
  presentation: /https:\/\/docs\.google\.com\/presentation\//i,
} as const;

/**
 * Line-scoped so the verb has to travel with the link. "I updated the
 * itinerary. Here it is: <link>" is a claim; a bare link under a future-tense
 * sentence is not.
 */
function googleArtifactMutationClaim(text: string, url: RegExp): boolean {
  return text.split('\n').some((line) => url.test(line) && WORKSPACE_MUTATION.test(line));
}

/**
 * An existing artifact may truthfully be referenced using evidence from an
 * earlier turn. A claim that it was freshly edited is different: it needs a
 * successful write in this task, otherwise an old docs.create can mask a new
 * no-op update.
 */
function freshArtifactEditClaim(text: string, kind: 'workspace' | 'spreadsheet' | 'presentation') {
  const objects = {
    workspace: 'document|doc|file|drive file',
    spreadsheet: 'spreadsheet|sheet|tracker',
    presentation: 'deck|slides|presentation',
  }[kind];
  return (
    completedActionClaim(text, objects, ARTIFACT_EDIT) ||
    text
      .split('\n')
      .some(
        (line) =>
          GOOGLE_ARTIFACT_URL[kind].test(line) &&
          new RegExp(`\\b(?:${ARTIFACT_EDIT})\\b`, 'i').test(line),
      )
  );
}

function claimedKinds(text: string): ActionKind[] {
  const kinds = new Set<ActionKind>();
  const lower = text.toLowerCase();
  const outboundClaimText = withoutNegatedOutboundStatus(text);

  if (
    completedActionClaim(
      text,
      'document|doc|file|drive file',
      'created|shared|uploaded|downloaded|saved|deleted|updated|published|generated|prepared|exported|added',
      'created|shared|uploaded|downloaded|saved|deleted|updated|published|generated|prepared|exported|added|ready|live|active|available',
    ) ||
    googleArtifactMutationClaim(text, GOOGLE_ARTIFACT_URL.workspace) ||
    (/\b(?:document|doc|file)\b/.test(lower) && artifactStatus.test(text))
  ) {
    kinds.add('workspace');
  }
  if (
    completedActionClaim(
      text,
      'spreadsheet|sheet|tracker',
      'created|shared|uploaded|downloaded|saved|deleted|updated|published|generated|prepared|exported|added',
      'created|shared|uploaded|downloaded|saved|deleted|updated|published|generated|prepared|exported|added|ready|live|active|available',
    ) ||
    googleArtifactMutationClaim(text, GOOGLE_ARTIFACT_URL.spreadsheet) ||
    (/\b(?:spreadsheet|sheet)\b/.test(lower) && artifactStatus.test(text)) ||
    countedTracker.test(text)
  ) {
    kinds.add('spreadsheet');
  }
  if (
    completedActionClaim(
      text,
      'deck|slides|presentation',
      'created|shared|uploaded|downloaded|saved|deleted|updated|published|generated|prepared|exported|added',
      'created|shared|uploaded|downloaded|saved|deleted|updated|published|generated|prepared|exported|added|ready|live|active|available',
    ) ||
    googleArtifactMutationClaim(text, GOOGLE_ARTIFACT_URL.presentation) ||
    (/\b(?:deck|slides|presentation)\b/.test(lower) && artifactStatus.test(text))
  ) {
    kinds.add('presentation');
  }
  if (
    completedActionClaim(
      outboundClaimText,
      OUTBOUND_OBJECTS,
      'sent|delivered|contacted|emailed|texted|messaged|called|replied|forwarded|reached out to|notified|pinged',
      // "confirmed" is not a send. It is what booking and travel mail says about
      // itself ("your reservation is confirmed"), and the action verbs above
      // already cover every way an outbound message actually completes.
      'sent|delivered|contacted|emailed|texted|messaged|called|replied|forwarded|reached out to|notified|pinged',
    ) ||
    firstPersonCompletedAction(
      outboundClaimText,
      'sent|delivered|contacted|emailed|texted|messaged|called|replied|forwarded|reached out to|notified|pinged',
    ) ||
    passiveOutbound.test(outboundClaimText)
  ) {
    kinds.add('outbound');
  }
  if (savedEmailDraftClaim.test(text)) kinds.add('email_draft');
  if (inboxWriteClaim.test(text)) kinds.add('inbox_write');
  if (
    completedActionClaim(
      text,
      APPLICATION_OBJECTS,
      'submitted|applied|completed|confirmed|uploaded|saved|filed',
      'submitted|applied|complete|completed|confirmed|uploaded|saved|filed|received|went through|gone through',
    ) ||
    // Object-free application verbs must stay application-specific. "completed"
    // and "confirmed" are ordinary English ("I've completed the review",
    // "confirmed the address") and were rewriting perfectly good replies into
    // failure boilerplate; they still count when anchored to an application
    // object via completedActionClaim above.
    firstPersonCompletedAction(text, 'submitted|applied|uploaded|filed') ||
    backgroundApplicationPromise.test(text)
  ) {
    kinds.add('application');
  }
  if (
    completedActionClaim(
      text,
      CALENDAR_OBJECTS,
      'scheduled|booked|created|updated|cancelled|canceled|confirmed|added|set up|put',
      'scheduled|booked|created|updated|cancelled|canceled|confirmed|added|set up|put|ready|set|on your calendar',
    )
  ) {
    kinds.add('calendar');
  }
  if (
    completedActionClaim(text, CALENDAR_READ_OBJECTS, READ_ACTIONS) ||
    emptyCalendarClaim.test(text)
  ) {
    kinds.add('calendar_read');
  }
  if (
    completedActionClaim(
      text,
      'reminders?|alerts?',
      'created|scheduled|saved|added|set|set up|rescheduled|updated',
    )
  ) {
    kinds.add('reminder_create');
  }
  if (
    completedActionClaim(text, 'reminders?|alerts?', 'cancelled|canceled|removed|deleted|stopped')
  ) {
    kinds.add('reminder_cancel');
  }
  if (completedActionClaim(text, INBOX_READ_OBJECTS, READ_ACTIONS) || emptyInboxClaim.test(text)) {
    kinds.add('inbox_read');
  }
  if (
    completedActionClaim(
      text,
      RESEARCH_OBJECTS,
      'researched|fetched|browsed|searched|found|identified|collected|located|reviewed|analyzed|analysed|listed|logged',
      'researched|fetched|browsed|searched|found|identified|collected|located|reviewed|analyzed|analysed|listed|logged|ready|complete|completed',
    ) ||
    (firstPersonCompletedAction(text, 'researched|fetched|browsed|searched') &&
      !kinds.has('calendar_read') &&
      !kinds.has('inbox_read')) ||
    progressClaim.test(text) ||
    statusNarrative.test(text) ||
    countedTracker.test(text)
  ) {
    kinds.add('research');
  }
  if (
    backgroundPromise.test(text) ||
    futureWatchPromise.test(text) ||
    completedActionClaim(
      text,
      BACKGROUND_OBJECTS,
      'scheduled|started|launched|queued|paused|resumed|stopped|cancelled|canceled',
      'scheduled|started|launched|queued|active|running|in flight|sleeping|paused|resumed|stopped|cancelled|canceled|monitoring|tracking',
    ) ||
    (/\b(?:mission|tracker)\b/.test(lower) &&
      (progressClaim.test(text) || statusNarrative.test(text) || countedTracker.test(text)))
  ) {
    kinds.add('background');
  }
  if (memoryClaim.test(text) || memoryPromise.test(text)) kinds.add('memory');
  if (isSimulatedApprovalNotice(text)) kinds.add('approval');

  return [...kinds];
}

/** Only this task's failures — an earlier turn's error is not this attempt. */
function failureDetails(evidence: ActionEvidence[]): string[] {
  return [
    ...new Set(
      evidence
        .filter((item) => item.fromCurrentTask !== false && !successful(item))
        .slice(-2)
        .map((item) => {
          if (/BudgetReservationError:.*daily budget/i.test(item.error ?? ''))
            return 'the daily spending limit prevented another lookup';
          if (/BudgetReservationError:.*monthly budget/i.test(item.error ?? ''))
            return 'the monthly spending limit prevented another lookup';
          const cause = plainCause(item.error);
          const kind = toolKind(item.toolName);
          const step =
            item.toolName === 'conversations.search' ||
            item.toolName === 'conversations.context' ||
            item.toolName === 'memory.recall'
              ? 'the history lookup'
              : kind
                ? PLAIN_STEP[kind]
                : 'one of the lookup steps';
          return `${step} did not complete${cause ? ` (${cause})` : ''}`;
        }),
    ),
  ];
}

/**
 * What a person would call the step that failed. The tool's own name
 * ("calendar.list_events") and its error text belong to the task record, not to
 * the sentence the owner reads.
 */
const PLAIN_STEP: Record<ActionKind, string> = {
  workspace: 'the document step',
  spreadsheet: 'the spreadsheet step',
  presentation: 'the presentation step',
  outbound: 'sending the message',
  email_draft: 'saving the email draft',
  inbox_write: 'the inbox change',
  application: 'the application',
  calendar: 'the calendar change',
  reminder_create: 'setting the reminder',
  reminder_cancel: 'removing the reminder',
  calendar_read: 'the calendar lookup',
  inbox_read: 'the mailbox lookup',
  research: 'the web lookup',
  background: 'setting up the follow-up',
  memory: 'saving that to memory',
  approval: 'the approval request',
};

/**
 * The reason a tool gave, if it is fit to repeat to a person: short, in words,
 * with no identifiers, URLs, JSON or stack frames. A provider's whole error body
 * is not.
 */
function plainCause(error: string | null | undefined): string {
  const text = (error ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^Error:\s*/u, '')
    .replace(/[.\s]+$/u, '');
  if (!text || text.length > 90) return '';
  if (
    /[{}<>[\]]|https?:|\bAI_\w|\w\.\w+\(|\bat \S+:\d+|^\w*Error:|did not return a successful result/u.test(
      text,
    )
  )
    return '';
  return text;
}

export function transparentFailureResponse(evidence: ActionEvidence[]): string {
  const failed = evidence
    .filter((item) => item.fromCurrentTask !== false && !successful(item))
    .slice(-2);
  const steps = [
    ...new Set(
      failed.map((item) => {
        const kind = toolKind(item.toolName);
        const step = kind ? PLAIN_STEP[kind] : 'one of the steps';
        const cause = plainCause(item.error);
        return `${step} didn't go through${cause ? ` (${cause})` : ''}`;
      }),
    ),
  ];
  const detail = steps.length ? steps.join(' and ') : 'none of the steps came back successful';
  return `I couldn't complete this because ${detail}. No external change was made.`;
}

const UNSUPPORTED_LABEL: Record<ActionKind, string> = {
  workspace: 'the requested document or file action',
  spreadsheet: 'the requested spreadsheet or tracker action',
  presentation: 'the requested presentation action',
  outbound: 'the requested outbound message',
  email_draft: 'the claimed saved email draft',
  inbox_write: 'the claimed inbox change',
  application: 'the application submission',
  calendar: 'the requested calendar action',
  reminder_create: 'the requested reminder',
  reminder_cancel: 'the requested reminder removal',
  calendar_read: 'the claimed calendar check',
  inbox_read: 'the claimed inbox check',
  research: 'the requested research',
  background: 'the promised background work',
  memory: 'the requested memory update',
  approval: 'the claimed approval request',
};

/** Map a tool name to the action-kind it evidences (mirror of `supports`). */
function toolKind(name: string): ActionKind | undefined {
  if (
    name === 'drive.download' ||
    name === 'workspace.write' ||
    /^docs\.(?:create|append|replace_text|share)$/.test(name)
  ) {
    return 'workspace';
  }
  if (/^sheets\.(?:create|append_rows|write_rows)$/.test(name)) return 'spreadsheet';
  if (/^slides\.(?:create|append)$/.test(name)) return 'presentation';
  if (/^(gmail\.send|sms\.send|email\.send)$/.test(name)) return 'outbound';
  if (name === 'gmail.create_draft') return 'email_draft';
  if (name === 'gmail.modify') return 'inbox_write';
  if (name === 'application.submit') return 'application';
  if (/^calendar\.(create|update|cancel|delete)/.test(name)) return 'calendar';
  if (name === 'reminder.create') return 'reminder_create';
  if (name === 'reminder.cancel') return 'reminder_cancel';
  if (/^calendar\.(?:list_calendars|list_events|search_events|availability)$/.test(name)) {
    return 'calendar_read';
  }
  if (/^gmail\.(?:search|read_thread)$/.test(name)) return 'inbox_read';
  if (name === 'web.fetch' || name === 'browser.execute') return 'research';
  if (name === 'memory.save' || name === 'occasions.save') return 'memory';
  if (
    name === 'mission.update' ||
    name === 'task.schedule' ||
    name === 'applications.watch_confirmation' ||
    name === 'watch.create' ||
    name === 'watch.web'
  ) {
    return 'background';
  }
  return undefined;
}

function describeTool(name: string): string | undefined {
  if (name === 'drive.download') return 'the requested Drive file was staged';
  if (/^docs\.(?:create|append|replace_text|share)$/.test(name)) {
    return 'the Google Doc action completed';
  }
  if (name === 'workspace.write') return 'the workspace file was written';
  if (/^sheets\.(?:create|append_rows|write_rows)$/.test(name)) {
    return 'the Google Sheet action completed';
  }
  if (/^slides\.(?:create|append)$/.test(name)) return 'the Google Slides action completed';
  if (name === 'gmail.send') return 'the email was sent';
  if (name === 'gmail.create_draft') return 'the Gmail draft was created';
  if (name === 'gmail.modify') return 'the inbox change completed';
  if (name === 'sms.send' || name === 'email.send') return 'the message was sent';
  if (/^calendar\.(create|update|cancel|delete)/.test(name)) return 'the calendar action completed';
  if (name === 'reminder.create') return 'the reminder was scheduled';
  if (name === 'reminder.cancel') return 'the reminder was removed';
  if (/^calendar\.(?:list_calendars|list_events|search_events|availability)$/.test(name)) {
    return 'the calendar was actually read';
  }
  if (/^gmail\.(?:search|read_thread)$/.test(name)) return 'the mailbox was actually read';
  if (name === 'web.fetch') return 'the web request completed';
  if (name === 'memory.save') return 'the fact was saved to memory';
  if (name === 'occasions.save') return 'the occasion was saved in People';
  if (name === 'application.submit') return 'the application was submitted';
  if (name === 'applications.watch_confirmation') return 'the confirmation watch was created';
  if (name === 'watch.create') return 'the email watch is active';
  if (name === 'watch.web') return 'the web watch is active';
  if (name === 'mission.update' || name === 'task.schedule') {
    return 'the background task was created or updated';
  }
  return undefined;
}

/**
 * Describe what actually happened, without reprinting the whole conversation.
 * Current-task actions genuinely ran this turn, so they're always reportable.
 * A prior-turn artifact (a doc that still exists) is reported with "earlier in
 * this conversation" only when THIS turn actually referred to that kind and the
 * kind may be cited across turns — so a "save this to memory" turn never lists
 * every earlier Drive/Sheet/calendar action, and a prior outbound/calendar
 * (CURRENT_TASK_ONLY) is never passed off as confirmation of a fresh one.
 */
function verifiedActionDescriptions(
  evidence: ActionEvidence[],
  claimedSet: ReadonlySet<ActionKind>,
): string[] {
  const descriptions = new Set<string>();
  const citable = (kind: ActionKind, item: ActionEvidence): boolean =>
    item.fromCurrentTask !== false || (claimedSet.has(kind) && inScope(kind, item));
  for (const item of evidence) {
    if (!successful(item)) continue;
    const when = item.fromCurrentTask === false ? ' earlier in this conversation' : '';
    const kind = toolKind(item.toolName);
    if (kind !== undefined && citable(kind, item) && supports(kind, [item])) {
      const described = describeTool(item.toolName);
      if (described) {
        const receipt = activeWatchReceipt(item);
        const withExpiry = receipt ? `${described} until ${receipt.expiresAt}` : described;
        descriptions.add(`${withExpiry}${when}`);
      }
    }
    if (citable('application', item) && browserApplicationConfirmed(item)) {
      descriptions.add(`the portal returned an explicit application confirmation${when}`);
    }
  }
  return [...descriptions];
}

/** A partial receipt after interrupted prose, using only this task's ledger. */
export function verifiedCurrentActionSummary(evidence: ActionEvidence[]): string | undefined {
  const verified = verifiedActionDescriptions(
    evidence.filter((item) => item.fromCurrentTask !== false),
    new Set(),
  );
  return verified.length ? `Confirmed: ${verified.join('; ')}.` : undefined;
}

function partialFailureResponse(
  evidence: ActionEvidence[],
  unsupported: ActionKind[],
  claimedSet: ReadonlySet<ActionKind>,
): string | undefined {
  const verified = verifiedActionDescriptions(evidence, claimedSet);
  if (verified.length === 0) return undefined;
  const missing = [...new Set(unsupported.map((kind) => UNSUPPORTED_LABEL[kind]))];
  const failures = failureDetails(evidence);
  const reason = failures.length ? ` Reason: ${failures.join('; ')}.` : '';
  return `Completed: ${verified.join('; ')}. Still needed: ${missing.join(' or ')}.${reason}`;
}

// Google surfaces the model legitimately constructs from an id it already has
// (a docs.create returned the id; the model rebuilds the shareable URL). These
// are allowed only when the id in the path is itself present in the evidence.
const CONSTRUCTIBLE_GOOGLE_HOSTS = new Set([
  'docs.google.com',
  'drive.google.com',
  'calendar.google.com',
  'mail.google.com',
]);

const BARE_URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi;

function normalizeUrl(raw: string): URL | null {
  const cleaned = raw.replace(/[.,;:!?'")\]]+$/, '');
  try {
    const url = new URL(cleaned);
    // Resource, action, port, path case and fragment retain their meaning.
    for (const key of [...url.searchParams.keys()]) {
      if (
        /^(?:utm|utm_source|utm_medium|utm_campaign|utm_term|utm_content|gclid|fbclid)$/.test(key)
      )
        url.searchParams.delete(key);
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * Strip http(s) links from a final answer that never appeared in the task's
 * sources — a fabricated "confirmation here: https://…" the response contract's
 * action rules don't catch (they only inspect Google-artifact mutation claims).
 *
 * Rewrite, not block: an unevidenced markdown link keeps its label text and
 * loses the href; a bare URL is removed; one trailing note explains the strip.
 * This keeps the false-positive cost to a single link rather than a blanked
 * answer. A link is evidenced when the corpus (tool results + trigger + the
 * owner/tool turns) contains the same canonical resource URL. Google
 * doc/drive/calendar/mail links the model reconstructs from an id are allowed
 * only when that id is itself in the corpus; a Google Maps link the model
 * composes from an address is always allowed.
 */
export function enforceUrlProvenance(
  text: string,
  corpus: string,
): { text: string; strippedUrls: string[] } {
  const sourceUrls = new Set(
    (corpus.match(/https?:\/\/[^\s<>"'`\\)\]]+/g) ?? [])
      .map((value) => normalizeUrl(value)?.href)
      .filter((value): value is string => Boolean(value)),
  );
  const stripped: string[] = [];
  const isEvidenced = (raw: string): boolean => {
    const n = normalizeUrl(raw);
    if (!n) return false;
    if (sourceUrls.has(n.href)) return true;
    if (n.protocol !== 'https:' || n.port || n.username || n.password) return false;
    if (n.hostname === 'www.google.com' && /^\/maps\/(?:search|dir)\/?$/.test(n.pathname))
      return true;
    if (CONSTRUCTIBLE_GOOGLE_HOSTS.has(n.hostname)) {
      if (n.pathname === '/' && !n.search && !n.hash) return true;
      const match =
        n.hostname === 'docs.google.com'
          ? /^\/(?:document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]+)\/(?:edit|view|preview)$/.exec(
              n.pathname,
            )
          : n.hostname === 'drive.google.com'
            ? /^\/file\/d\/([A-Za-z0-9_-]+)\/view$/.exec(n.pathname)
            : null;
      // Constructed links bind exact provider IDs; navigation parameters
      // require an actual source URL rather than a guessed destination.
      return (
        !n.search &&
        !n.hash &&
        Boolean(
          match?.[1] &&
            new RegExp(`(?:^|[^A-Za-z0-9_-])${match[1]}(?:$|[^A-Za-z0-9_-])`).test(corpus),
        )
      );
    }
    return false;
  };

  let out = text.replace(MARKDOWN_LINK_RE, (match, label: string, url: string) => {
    if (isEvidenced(url)) return match;
    stripped.push(url);
    return label;
  });
  out = out.replace(BARE_URL_RE, (match) => {
    if (isEvidenced(match)) return match;
    stripped.push(match);
    return '';
  });
  if (stripped.length > 0) {
    out = `${out.replace(/[ \t]{2,}/g, ' ').trimEnd()}\n\n(I removed a link I couldn't trace to this task's sources.)`;
  }
  return { text: out, strippedUrls: stripped };
}

const CALENDAR_EVENT_READS = new Set(['calendar.list_events', 'calendar.search_events']);
const CALENDAR_PRIVATE_READS = new Set([...CALENDAR_EVENT_READS, 'calendar.availability']);

function currentSuccessfulEvidence(evidence: ActionEvidence[]): ActionEvidence[] {
  return evidence.filter((item) => item.fromCurrentTask !== false && successful(item));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resultItems(row: ActionEvidence, key: string): Record<string, unknown>[] {
  const items = record(row.result)?.[key];
  return Array.isArray(items)
    ? items.map(record).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function calendarEventAnalysisCoverageComplete(rows: ActionEvidence[]): boolean {
  if (rows.length === 0) return false;
  let expectedPageToken: string | undefined;
  let finalResult: Record<string, unknown> | undefined;
  for (const row of rows) {
    const args = record(row.args);
    const result = record(row.result);
    if (
      !args ||
      !result ||
      (typeof args.pageToken === 'string' ? args.pageToken : undefined) !== expectedPageToken ||
      result.calendarRosterComplete !== true ||
      !Array.isArray(result.unavailable) ||
      result.unavailable.length > 0 ||
      result.paginationUnavailable === true
    )
      return false;
    expectedPageToken =
      typeof result.nextPageToken === 'string' && result.nextPageToken.length > 0
        ? result.nextPageToken
        : undefined;
    finalResult = result;
  }
  return (
    finalResult?.complete === true &&
    typeof finalResult.nextPageToken !== 'string' &&
    expectedPageToken === undefined
  );
}

function queryCovers(row: ActionEvidence, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const query = record(row.args)?.query;
  if (typeof query !== 'string') return false;
  const lower = query.toLowerCase();
  return terms.every((term) => lower.includes(term.toLowerCase()));
}

function gmailQueryCovers(row: ActionEvidence, request: PersonalReadRequest): boolean {
  const query = record(row.args)?.query;
  if (typeof query !== 'string') return false;
  if (request.mailQueries?.length) {
    return request.mailQueries.some(
      (entry) => query.trim().toLowerCase() === entry.query.toLowerCase(),
    );
  }
  if (request.mailQuery) return query.trim().toLowerCase() === request.mailQuery.toLowerCase();
  return queryCovers(row, request.queryTerms);
}

function matchingCalendarRows(
  request: PersonalReadRequest,
  current: ActionEvidence[],
): ActionEvidence[] {
  return current.filter((row) => {
    if (
      row.toolName !== request.firstToolName ||
      !CALENDAR_PRIVATE_READS.has(row.toolName) ||
      !queryCovers(row, request.queryTerms)
    ) {
      return false;
    }
    const args = record(row.args);
    if (
      request.timeWindow &&
      (args?.timeMin !== request.timeWindow.timeMin || args?.timeMax !== request.timeWindow.timeMax)
    ) {
      return false;
    }
    const calendarIds = args?.calendarIds;
    const result = record(row.result);
    if (row.toolName === 'calendar.availability') {
      return (
        Array.isArray(result?.busy) &&
        Array.isArray(result.calendarsChecked) &&
        typeof result.complete === 'boolean'
      );
    }
    return (
      (!Array.isArray(calendarIds) || calendarIds.length === 0) &&
      Array.isArray(result?.events) &&
      Array.isArray(result.calendarsSearched) &&
      typeof result.complete === 'boolean'
    );
  });
}

function matchingGmailSearchRows(
  request: PersonalReadRequest,
  current: ActionEvidence[],
): ActionEvidence[] {
  return current.filter((row) => {
    if (row.toolName !== 'gmail.search' || !gmailQueryCovers(row, request)) return false;
    const result = record(row.result);
    return (
      Array.isArray(result?.results) &&
      typeof result.mailboxSearched === 'string' &&
      Boolean(result.mailboxSearched) &&
      typeof result.complete === 'boolean'
    );
  });
}

function matchingGmailThreadRows(
  searches: ActionEvidence[],
  current: ActionEvidence[],
): ActionEvidence[] {
  const threadIds = new Set(
    searches
      .flatMap((row) => resultItems(row, 'results'))
      .map((item) => stringField(item, 'threadId'))
      .filter(Boolean),
  );
  return current.filter((row) => {
    if (row.toolName !== 'gmail.read_thread') return false;
    const threadId = record(row.args)?.threadId;
    return (
      typeof threadId === 'string' &&
      threadIds.has(threadId) &&
      resultItems(row, 'messages').length > 0 &&
      record(row.result)?.complete === true
    );
  });
}

function gmailMetadataCoverageComplete(searches: ActionEvidence[]): boolean {
  if (searches.length === 0) return false;
  const last = record(searches.at(-1)?.result) ?? {};
  const unavailable = searches.reduce((count, row) => {
    const items = record(row.result)?.unavailable;
    return count + (Array.isArray(items) ? items.length : 0);
  }, 0);
  return last.complete !== false && last.hasMore !== true && unavailable === 0;
}

function matchingPrivateReadRows(
  request: PersonalReadRequest,
  current: ActionEvidence[],
): ActionEvidence[] {
  return current.filter((row) => {
    if (request.kind === 'memory' && request.conversationQuery)
      return matchesHistoricalMemorySearch(request, row);
    if (row.toolName !== request.firstToolName) return false;
    const query = record(row.args)?.query;
    if (typeof query !== 'string') return false;
    const lower = query.toLowerCase();
    return request.queryTerms.every((term) => lower.includes(term.toLowerCase()));
  });
}

function requiredReadGaps(
  request: PersonalReadRequest,
  evidence: ActionEvidence[],
  compoundTripExtraction?: CompoundTripExtraction,
): { labels: string[]; unsupported: ActionKind[] } {
  const current = currentSuccessfulEvidence(evidence);
  if (request.upcomingFlightDiscovery) {
    const projection = upcomingFlightReadProjection(request, evidence, compoundTripExtraction);
    const unsupported: ActionKind[] = [];
    if (!projection.calendarComplete) unsupported.push('calendar_read');
    if (!projection.gmailSearchComplete || !projection.threadsComplete)
      unsupported.push('inbox_read');
    return {
      labels: projection.blocked
        ? projection.text.split('\n\n').filter((line) => line.startsWith('Needs confirmation:'))
        : [],
      unsupported,
    };
  }
  if (request.compoundTripDiscovery) {
    const projection = compoundTripReadProjection(request, evidence, compoundTripExtraction);
    const labels = projection.blocked
      ? projection.text.split('\n\n').filter((line) => line.startsWith('Needs confirmation:'))
      : [];
    const unsupported: ActionKind[] = [];
    if (!projection.calendarRows.length || !projection.calendarComplete)
      unsupported.push('calendar_read');
    if (
      !projection.gmailSearchRows.length ||
      !projection.gmailSearchComplete ||
      !projection.threadsComplete
    )
      unsupported.push('inbox_read');
    if (!projection.mapRoute || !projection.webSearch) unsupported.push('research');
    return { labels: [...new Set(labels)], unsupported };
  }
  if (request.kind === 'drive' || request.kind === 'memory' || request.kind === 'knowledge_graph') {
    if (matchingPrivateReadRows(request, current).length > 0) {
      return { labels: [], unsupported: [] };
    }
    return {
      labels: [
        request.kind === 'drive'
          ? 'a successful Drive search using the requested terms'
          : request.kind === 'memory'
            ? 'a successful durable-memory lookup using the requested terms'
            : 'a successful active knowledge-graph lookup using the requested terms',
      ],
      unsupported: [request.kind === 'drive' ? 'workspace' : 'memory'],
    };
  }
  const calendars = matchingCalendarRows(request, current);
  const gmailSearches = matchingGmailSearchRows(request, current);
  const gmailHits = gmailSearches.flatMap((row) => resultItems(row, 'results'));
  const gmailThreads = matchingGmailThreadRows(gmailSearches, current);
  const expectedThreadIds = [
    ...new Set(gmailHits.map((hit) => stringField(hit, 'threadId')).filter(Boolean)),
  ];
  const readThreadIds = new Set(
    gmailThreads
      .map((row) => record(row.args)?.threadId)
      .filter((value): value is string => typeof value === 'string'),
  );
  const missingThreadIds = expectedThreadIds.filter((id) => !readThreadIds.has(id));
  const labels: string[] = [];
  const unsupported: ActionKind[] = [];

  if (request.kind !== 'email' && calendars.length === 0) {
    labels.push('a successful all-calendar event search using the requested terms/date range');
    unsupported.push('calendar_read');
  }
  if (
    request.upcomingFlightDiscovery &&
    calendars.length > 0 &&
    calendars.some((row) => {
      const result = record(row.result);
      return (
        result?.complete !== true ||
        typeof result?.nextPageToken === 'string' ||
        result?.paginationUnavailable === true ||
        result?.calendarRosterComplete !== true ||
        !Array.isArray(result?.unavailable) ||
        result.unavailable.length > 0
      );
    })
  ) {
    labels.push('complete future-calendar coverage to establish which flight is next');
    unsupported.push('calendar_read');
  }
  if (request.kind !== 'calendar' && gmailSearches.length === 0) {
    labels.push('a successful Gmail search using the requested terms');
    unsupported.push('inbox_read');
  } else if (request.requiresThreadRead && gmailHits.length > 0 && missingThreadIds.length > 0) {
    labels.push(
      `successful reads of ${missingThreadIds.length} matching Gmail ${missingThreadIds.length === 1 ? 'thread' : 'threads'}`,
    );
    unsupported.push('inbox_read');
  }
  if (
    request.kind !== 'calendar' &&
    gmailSearches.length > 0 &&
    !gmailMetadataCoverageComplete(gmailSearches)
  ) {
    labels.push(
      'a complete Gmail metadata search, including remaining pages and unavailable message metadata',
    );
    unsupported.push('inbox_read');
  }
  return { labels, unsupported: [...new Set(unsupported)] };
}

function stringField(item: Record<string, unknown>, key: string): string {
  const value = item[key];
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 2_000) : '';
}

function rawStringField(item: Record<string, unknown>, key: string): string {
  const value = item[key];
  return typeof value === 'string' ? value.trim().slice(0, 8_000) : '';
}

function uniqueRecords(
  items: Record<string, unknown>[],
  key: (item: Record<string, unknown>) => string,
): Record<string, unknown>[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const MAX_DATE_TIME_FORMATTERS = 64;

function cachedDateTimeFormatter(
  locale: string | string[],
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = JSON.stringify([locale, options]);
  const cached = dateTimeFormatters.get(key);
  if (cached) {
    dateTimeFormatters.delete(key);
    dateTimeFormatters.set(key, cached);
    return cached;
  }
  const formatter = new Intl.DateTimeFormat(locale, options);
  if (dateTimeFormatters.size >= MAX_DATE_TIME_FORMATTERS) {
    const oldest = dateTimeFormatters.keys().next().value;
    if (oldest !== undefined) dateTimeFormatters.delete(oldest);
  }
  dateTimeFormatters.set(key, formatter);
  return formatter;
}

function calendarTime(value: string, timeZone?: string): string {
  if (!value) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T12:00:00.000Z`);
    return cachedDateTimeFormatter('en-US', {
      timeZone: 'UTC',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(date);
  }
  if (!timeZone) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return cachedDateTimeFormatter('en-US', {
      timeZone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(date);
  } catch {
    return value;
  }
}

/** "09:30" in the owner's zone; empty for a date with no time of day. */
function clockOnly(value: string, timeZone?: string): string {
  if (!value || /^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return '';
  try {
    return cachedDateTimeFormatter('en-GB', {
      timeZone: timeZone ?? 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return '';
  }
}

/** "Mon 17 Aug" — the date prefix a window spanning several days needs. */
function shortDate(value: string, timeZone?: string): string {
  if (!value) return '';
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const ms = Date.parse(isDateOnly ? `${value}T12:00:00.000Z` : value);
  if (Number.isNaN(ms)) return '';
  try {
    return cachedDateTimeFormatter('en-GB', {
      timeZone: isDateOnly ? 'UTC' : (timeZone ?? 'UTC'),
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(new Date(ms));
  } catch {
    return '';
  }
}

/** A readable date for both ends of an interval that crosses local days. */
function intervalDateTime(value: string, timeZone?: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  try {
    return cachedDateTimeFormatter('en-US', {
      timeZone: timeZone ?? 'UTC',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(ms));
  } catch {
    return value;
  }
}

function overlapClock(value: number, timeZone?: string): string {
  try {
    return cachedDateTimeFormatter('en-US', {
      timeZone: timeZone ?? 'UTC',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return new Date(value).toISOString();
  }
}

/** Compact agendas use one readable 12-hour clock style for rows and overlaps. */
function compactClock(value: number, timeZone?: string): string {
  try {
    return cachedDateTimeFormatter('en-US', {
      timeZone: timeZone ?? 'UTC',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return new Date(value).toISOString();
  }
}

function calendarAllDayWindowLabel(
  event: Record<string, unknown>,
  request: PersonalReadRequest,
): string | undefined {
  const startDate = stringField(event, 'start');
  const endDate = stringField(event, 'end');
  const window = request.timeWindow;
  const zone = request.timeZone ?? 'UTC';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || !window)
    return undefined;
  const interval = calendarSourceInterval(event);
  const windowStart = Date.parse(window.timeMin);
  const windowEnd = Date.parse(window.timeMax);
  if (!interval || !Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) return undefined;
  const overlapStart = Math.max(interval.start, windowStart);
  const overlapEnd = Math.min(interval.end, windowEnd);
  if (overlapStart >= overlapEnd) return undefined;
  const startIso = new Date(windowStart).toISOString();
  const endIso = new Date(windowEnd).toISOString();
  const startsAtLocalMidnight = clockOnly(startIso, zone) === '00:00';
  const endsAtLocalMidnight = clockOnly(endIso, zone) === '00:00';
  const sameLocalDay =
    eventLocalDay(startIso, zone) === eventLocalDay(new Date(windowEnd - 1).toISOString(), zone);
  const entireLocalDay =
    overlapStart === windowStart &&
    overlapEnd === windowEnd &&
    startsAtLocalMidnight &&
    endsAtLocalMidnight &&
    sameLocalDay;
  const sourceDate = calendarSourceDateLabel(event).replace(/^source date /, '');
  const sourceNote = `source all-day ${sourceDate || 'date'}`;
  if (entireLocalDay) return `${shortDate(startIso, zone)} · All day (${sourceNote})`;
  const startDay = shortDate(new Date(overlapStart).toISOString(), zone);
  const endDay = shortDate(new Date(overlapEnd).toISOString(), zone);
  const range =
    startDay === endDay
      ? `${startDay} ${overlapClock(overlapStart, zone)}–${overlapClock(overlapEnd, zone)}`
      : `${startDay} ${overlapClock(overlapStart, zone)}–${endDay} ${overlapClock(overlapEnd, zone)}`;
  const clipping =
    overlapEnd < interval.end
      ? `; continues until ${intervalDateTime(new Date(interval.end).toISOString(), zone)}`
      : '';
  return `All-day record · ${range} within requested window (${sourceNote}${clipping})`;
}

function compactLocalRange(start: number, end: number, timeZone: string): string {
  const startIso = new Date(start).toISOString();
  const endIso = new Date(end).toISOString();
  const startDate = shortDate(startIso, timeZone);
  const endDate = shortDate(endIso, timeZone);
  return `${startDate} ${compactClock(start, timeZone)}–${endDate === startDate ? '' : `${endDate} `}${compactClock(end, timeZone)}`;
}

/** Preserve source civil dates and the actual local-day intersection compactly. */
function compactAllDaySourceDetail(
  event: Record<string, unknown>,
  request: PersonalReadRequest,
): string {
  const sourceDate = (calendarSourceDateLabel(event) || 'source date unavailable')
    .replace(/^source date /, '')
    .replace('; calendar time zone unavailable', ' (calendar time zone unavailable)');
  const window = request.timeWindow;
  const interval = calendarSourceInterval(event);
  const start = window ? Date.parse(window.timeMin) : NaN;
  const end = window ? Date.parse(window.timeMax) : NaN;
  if (!interval || !Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return `${sourceDate} · local extent unresolved`;
  const overlapStart = Math.max(interval.start, start);
  const overlapEnd = Math.min(interval.end, end);
  if (overlapStart >= overlapEnd) return `${sourceDate} · outside local window`;
  const zone = request.timeZone ?? 'UTC';
  const startsAtMidnight = clockOnly(new Date(overlapStart).toISOString(), zone) === '00:00';
  const endsAtMidnight = clockOnly(new Date(overlapEnd).toISOString(), zone) === '00:00';
  const sameDay =
    eventLocalDay(new Date(overlapStart).toISOString(), zone) ===
    eventLocalDay(new Date(overlapEnd - 1).toISOString(), zone);
  const localExtent =
    sameDay && startsAtMidnight && endsAtMidnight
      ? `all of ${shortDate(new Date(overlapStart).toISOString(), zone)}`
      : compactLocalRange(overlapStart, overlapEnd, zone);
  return `${sourceDate} · local ${localExtent}`;
}

function compactEventStatus(event: Record<string, unknown>): string {
  const attendance = verifiedOwnerParticipation(event);
  const availability = event.blocksTime === false ? 'free' : '';
  return [availability, attendance === 'unknown' || attendance === 'needsAction' ? '' : attendance]
    .filter(Boolean)
    .join(' · ');
}

function compactLocationRequested(request: PersonalReadRequest): boolean {
  return request.includeCalendarLocations === true;
}

function compactLocationForAgenda(location: string, explicitlyRequested: boolean): string {
  const place = location.replace(/\s+/g, ' ').trim();
  if (!place) return '';
  // Preserve concise venue labels and short locations such as "Laugavegur 12".
  // Full postal-style addresses stay out of a brief unless the owner asked for
  // locations; never derive or rewrite a venue from the address text.
  const hasMultipleAddressComponents = place.split(',').length - 1 >= 2;
  if (!explicitlyRequested && (place.length > 60 || hasMultipleAddressComponents)) return '';
  return place.length > 100 ? `${place.slice(0, 99)}…` : place;
}

function compactEventTitleLink(title: string, url: string): string {
  const safeTitle = title
    .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([\\`*_{}[\]()#+.!|>~-])/g, '\\$1');
  if (!url) return safeTitle;
  const safeUrl = safeCalendarSourceUrl(url);
  return safeUrl
    ? `[${safeTitle}](${safeUrl.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')})`
    : safeTitle;
}

function compactEventSpan(start: string, end: string, timeZone: string): string {
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 'time span unresolved';
  return compactLocalRange(from, to, timeZone);
}

function calendarLodgingContext(event: Record<string, unknown>, complete: boolean): boolean {
  const interval = calendarSourceInterval(event);
  const description = stringField(event, 'description');
  return (
    complete &&
    interval !== undefined &&
    interval.end - interval.start >= 18 * 60 * 60_000 &&
    /\b(?:hotel|lodging|accommodation|overnight)\b/i.test(
      `${stringField(event, 'summary')} ${description}`,
    ) &&
    /\bcheck[ -]?in\b/i.test(description) &&
    /\bcheck[ -]?out\b/i.test(description) &&
    /(?:Z|[+-]\d{2}:?\d{2})$/i.test(stringField(event, 'start')) &&
    /(?:Z|[+-]\d{2}:?\d{2})$/i.test(stringField(event, 'end'))
  );
}

function calendarOverlapSummary(
  events: Record<string, unknown>[],
  request: PersonalReadRequest,
  complete: boolean,
): string[] {
  if (!request.includeCalendarOverlapSummary) return [];
  const zone = request.timeZone ?? 'UTC';
  const candidates = events.flatMap((event) => {
    if (
      stringField(event, 'status') === 'cancelled' ||
      verifiedOwnerParticipation(event) === 'declined' ||
      event.blocksTime === false
    )
      return [];
    const rawStart = stringField(event, 'start');
    const rawEnd = stringField(event, 'end');
    const interval = calendarSourceInterval(event);
    const explicitStayContext = calendarLodgingContext(event, complete);
    // All-day records have no timed meeting interval. A multi-day stay is
    // treated as context only when complete event details explicitly supply
    // check-in/check-out and offset-aware boundaries; title alone is not proof.
    if (
      event.allDay === true ||
      (/^\d{4}-\d{2}-\d{2}$/.test(rawStart) && /^\d{4}-\d{2}-\d{2}$/.test(rawEnd)) ||
      !interval
    )
      return [];
    if (explicitStayContext && !request.compactCalendarBriefing) return [];
    const projected: BriefingCalendarEvent = {
      summary: stringField(event, 'summary') || '(untitled event)',
      start: stringField(event, 'start'),
      end: stringField(event, 'end'),
      calendar: stringField(event, 'calendar'),
      allDay: event.allDay === true,
      ...(stringField(event, 'eventId') ? { eventId: stringField(event, 'eventId') } : {}),
      ...(stringField(event, 'calendarId') ? { calendarId: stringField(event, 'calendarId') } : {}),
      ...(stringField(event, 'iCalUID') ? { iCalUID: stringField(event, 'iCalUID') } : {}),
      ...(stringField(event, 'recurringEventId')
        ? { recurringEventId: stringField(event, 'recurringEventId') }
        : {}),
      ...(stringField(event, 'originalStartTime')
        ? { originalStartTime: stringField(event, 'originalStartTime') }
        : {}),
      ...(stringField(event, 'ownerResponse')
        ? { ownerResponse: stringField(event, 'ownerResponse') }
        : {}),
      ...(parseCalendarOwnerParticipation(event.ownerParticipation)
        ? { ownerParticipation: parseCalendarOwnerParticipation(event.ownerParticipation) }
        : {}),
      ...(event.calendarPurpose === 'commitments' || event.calendarPurpose === 'reference'
        ? { calendarPurpose: event.calendarPurpose }
        : {}),
      ...(Array.isArray(event.sourceVariants) ? { sourceVariants: event.sourceVariants } : {}),
      ...(event.sourceIntegrity === 'disputed' || event.sourceIntegrity === 'consistent'
        ? { sourceIntegrity: event.sourceIntegrity }
        : {}),
      ...(typeof event.blocksTime === 'boolean' ? { blocksTime: event.blocksTime } : {}),
      ...(stringField(event, 'location') ? { location: stringField(event, 'location') } : {}),
      ...(stringField(event, 'description')
        ? { description: stringField(event, 'description') }
        : {}),
    };
    return [{ event, projected, interval, explicitStayContext }];
  });
  const requestedStart = request.timeWindow ? Date.parse(request.timeWindow.timeMin) : undefined;
  const requestedEnd = request.timeWindow ? Date.parse(request.timeWindow.timeMax) : undefined;
  const window =
    requestedStart !== undefined &&
    requestedEnd !== undefined &&
    Number.isFinite(requestedStart) &&
    Number.isFinite(requestedEnd) &&
    requestedEnd > requestedStart
      ? { start: requestedStart, end: requestedEnd }
      : undefined;
  const notes: string[] = [];
  const travelContextNotes: string[] = [];
  const arrivalNotes: string[] = [];
  const MAX_FORMATTED_OVERLAP_DETAILS = 100;
  let formattedDetails = 0;
  let overlapPairCount = 0;
  let unconfirmedAttendanceCount = 0;
  let travelContextCount = 0;
  let arrivalCount = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const left = candidates[index];
    if (!left) continue;
    for (let rightIndex = index + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex];
      if (!right) continue;
      if (sameCalendarOccurrence(left.projected, right.projected)) continue;
      const start = Math.max(left.interval.start, right.interval.start, window?.start ?? -Infinity);
      const end = Math.min(left.interval.end, right.interval.end, window?.end ?? Infinity);
      if (start >= end) continue;
      if (possibleCalendarIdentityDisagreement(left.projected, right.projected)) {
        overlapPairCount += 1;
        unconfirmedAttendanceCount += 1;
        if (formattedDetails < MAX_FORMATTED_OVERLAP_DETAILS) {
          formattedDetails += 1;
          notes.push(
            `- Possible copies with different times: ${left.projected.calendar || 'Calendar'} · ${left.projected.summary} + ${right.projected.calendar || 'Calendar'} · ${right.projected.summary}. Assistant cannot confirm whether these are the same event or which time is current. Both entries stay visible; check each invitation.`,
          );
        }
        continue;
      }
      const contextOverlap = left.explicitStayContext || right.explicitStayContext;
      // A verified lodging stay can overlap a travel block in the calendar,
      // but that is useful context rather than evidence of physical attendance
      // or a scheduling conflict. Keep the event pair visible with that label.
      if (contextOverlap) {
        const stay = left.explicitStayContext ? left : right;
        const other = left.explicitStayContext ? right : left;
        const otherSource = [
          stringField(other.event, 'summary'),
          stringField(other.event, 'description'),
          stringField(other.event, 'location'),
        ]
          .filter(Boolean)
          .join(' ');
        if (!FLIGHT_SOURCE.test(otherSource)) continue;
        travelContextCount += 1;
        if (formattedDetails < MAX_FORMATTED_OVERLAP_DETAILS) {
          formattedDetails += 1;
          const sameDay =
            eventLocalDay(new Date(start).toISOString(), zone) ===
            eventLocalDay(new Date(end).toISOString(), zone);
          const overlapLabel = sameDay
            ? `${shortDate(new Date(start).toISOString(), zone)} ${compactClock(start, zone)}–${compactClock(end, zone)}`
            : `${intervalDateTime(new Date(start).toISOString(), zone)} – ${intervalDateTime(new Date(end).toISOString(), zone)}`;
          travelContextNotes.push(
            `- Travel context overlap **${overlapLabel}**: ${stay.projected.summary} + ${other.projected.summary} (busy stay block).`,
          );
        }
        continue;
      }
      const arrivalLead = calendarArrivalLead(left.projected, right.projected);
      if (arrivalLead !== undefined) {
        const earlier = left.interval.start < right.interval.start ? left : right;
        const later = earlier === left ? right : left;
        arrivalCount += 1;
        if (formattedDetails < MAX_FORMATTED_OVERLAP_DETAILS) {
          formattedDetails += 1;
          arrivalNotes.push(
            `- Arrival guidance: **${compactClock(earlier.interval.start, zone)} arrival for ${compactClock(later.interval.start, zone)} start** — ${later.projected.summary} requests arrival ${arrivalLead} minutes early. These entries may be for one event; both remain visible until the invitation is checked.`,
          );
        }
        continue;
      }
      const relationship = calendarRelationship(left.projected, right.projected);
      // Arrival/start records can be one event. Similar phone listings are
      // reported as uncertain copies, never as personal conflicts.
      if (relationship === 'compatible_time_roles') continue;
      if (relationship === 'probable_duplicate') {
        overlapPairCount += 1;
        unconfirmedAttendanceCount += 1;
        if (formattedDetails < MAX_FORMATTED_OVERLAP_DETAILS) {
          formattedDetails += 1;
          const sameDay =
            eventLocalDay(new Date(start).toISOString(), zone) ===
            eventLocalDay(new Date(end).toISOString(), zone);
          const overlapLabel = sameDay
            ? `${shortDate(new Date(start).toISOString(), zone)} ${request.compactCalendarBriefing ? compactClock(start, zone) : overlapClock(start, zone)}–${request.compactCalendarBriefing ? compactClock(end, zone) : overlapClock(end, zone)}`
            : `${intervalDateTime(new Date(start).toISOString(), zone)} – ${intervalDateTime(new Date(end).toISOString(), zone)}`;
          notes.push(
            `- Possible copies **${overlapLabel}**: ${left.projected.calendar || 'Calendar'} · ${left.projected.summary} + ${right.projected.calendar || 'Calendar'} · ${right.projected.summary}. Both entries stay visible; check the invitations to confirm.`,
          );
        }
        continue;
      }
      overlapPairCount += 1;
      if (formattedDetails < MAX_FORMATTED_OVERLAP_DETAILS) {
        formattedDetails += 1;
        const sameDay =
          eventLocalDay(new Date(start).toISOString(), zone) ===
          eventLocalDay(new Date(end).toISOString(), zone);
        const overlapLabel = sameDay
          ? `${shortDate(new Date(start).toISOString(), zone)} ${request.compactCalendarBriefing ? compactClock(start, zone) : overlapClock(start, zone)}–${request.compactCalendarBriefing ? compactClock(end, zone) : overlapClock(end, zone)}`
          : `${intervalDateTime(new Date(start).toISOString(), zone)} – ${intervalDateTime(new Date(end).toISOString(), zone)}`;
        const classification = classifyCalendarOverlap(left.event, right.event);
        if (classification !== 'personal_commitment_conflict') unconfirmedAttendanceCount += 1;
        const label =
          classification === 'personal_commitment_conflict'
            ? 'Your accepted commitments overlap'
            : classification === 'commitments_policy_overlap'
              ? 'Possible commitments overlap'
              : 'Possible overlap';
        notes.push(
          request.compactCalendarBriefing
            ? `- ${label} **${overlapLabel}**: ${left.projected.calendar || 'Calendar'} · ${left.projected.summary} + ${right.projected.calendar || 'Calendar'} · ${right.projected.summary}.${classification === 'personal_commitment_conflict' ? ' You accepted both invitations, and the times overlap.' : classification === 'commitments_policy_overlap' ? ' Your calendar settings mark these as commitments; acceptance is not confirmed for both.' : ' Whether you will attend both is unconfirmed.'}`
            : `- ${label}: **${left.projected.calendar || 'Calendar'} · ${left.projected.summary}** and **${right.projected.calendar || 'Calendar'} · ${right.projected.summary}**, ${overlapLabel}.${classification === 'personal_commitment_conflict' ? ' You accepted both invitations, and the times overlap.' : classification === 'commitments_policy_overlap' ? ' Your calendar settings mark these as commitments; acceptance is not confirmed for both.' : classification === 'attendance_unconfirmed' ? ' Your attendance is not confirmed for both events.' : ''}`,
        );
      }
    }
  }
  if (overlapPairCount === 0 && travelContextCount === 0 && arrivalCount === 0)
    return [
      complete
        ? 'No unresolved overlaps between timed calendar entries were found in the checked results.'
        : events.length > 0
          ? 'No overlaps appeared in the checked event subset; calendar coverage is incomplete.'
          : 'An overlap check was requested, but no calendar events were available to compare.',
    ];
  const shown = notes.slice(0, 3);
  if (overlapPairCount > shown.length)
    shown.push(
      `- ${overlapPairCount.toLocaleString('en-US')} calendar-entry pairs overlap in time; further pair details are not expanded.`,
    );
  const result = [
    ...shown,
    ...arrivalNotes.slice(0, 3),
    ...(arrivalCount > arrivalNotes.length
      ? [
          `- ${arrivalCount.toLocaleString('en-US')} additional arrival comparisons were counted but not expanded.`,
        ]
      : []),
    ...travelContextNotes.slice(0, 3),
    ...(travelContextCount > travelContextNotes.length
      ? [
          `- ${travelContextCount.toLocaleString('en-US')} additional travel-context overlaps were counted but not expanded.`,
        ]
      : []),
  ];
  if (request.includeCalendarBriefing && result.length > 0 && unconfirmedAttendanceCount > 0)
    result.push(
      'Some comparisons involve possible copies or entries whose attendance is unconfirmed.',
    );
  return result;
}

/** Does the searched window cover more than one local day? The end is exclusive. */
function spansDays(window: PersonalReadRequest['timeWindow'], timeZone?: string): boolean {
  if (!window) return true;
  const from = Date.parse(window.timeMin);
  const to = Date.parse(window.timeMax);
  if (!timeZone || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return true;
  const startDay = eventLocalDay(new Date(from).toISOString(), timeZone);
  const finalIncludedDay = eventLocalDay(new Date(to - 1).toISOString(), timeZone);
  return !startDay || !finalIncludedDay || startDay !== finalIncludedDay;
}

function calendarFreeIntervals(
  slots: Record<string, unknown>[],
  window: NonNullable<PersonalReadRequest['timeWindow']>,
): Array<{ start: string; end: string }> {
  const windowStart = Date.parse(window.timeMin);
  const windowEnd = Date.parse(window.timeMax);
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) {
    return [];
  }
  const merged: Array<{ start: number; end: number }> = [];
  const intervals = slots
    .map((slot) => ({
      start: Math.max(windowStart, Date.parse(stringField(slot, 'start'))),
      end: Math.min(windowEnd, Date.parse(stringField(slot, 'end'))),
    }))
    .filter(
      (slot) => Number.isFinite(slot.start) && Number.isFinite(slot.end) && slot.end > slot.start,
    )
    .sort((a, b) => a.start - b.start);
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  const free: Array<{ start: string; end: string }> = [];
  let cursor = windowStart;
  for (const interval of merged) {
    if (interval.start > cursor) {
      free.push({
        start: new Date(cursor).toISOString(),
        end: new Date(interval.start).toISOString(),
      });
    }
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < windowEnd) {
    free.push({
      start: new Date(cursor).toISOString(),
      end: new Date(windowEnd).toISOString(),
    });
  }
  return free;
}

/** Availability answers keep technical range identifiers in the ledger/card. */
function calendarAvailabilityLines(
  request: PersonalReadRequest,
  calendarRows: ActionEvidence[],
): string[] {
  const window = request.timeWindow;
  const windowStart = window ? Date.parse(window.timeMin) : Number.NaN;
  const windowEnd = window ? Date.parse(window.timeMax) : Number.NaN;
  const validWindow =
    Number.isFinite(windowStart) && Number.isFinite(windowEnd) && windowEnd > windowStart;
  const busy = uniqueRecords(
    calendarRows.flatMap((row) => resultItems(row, 'busy')),
    (slot) =>
      [stringField(slot, 'calendar'), stringField(slot, 'start'), stringField(slot, 'end')].join(
        '|',
      ),
  ).filter((slot) => {
    const from = Date.parse(stringField(slot, 'start'));
    const to = Date.parse(stringField(slot, 'end'));
    // An extra provider block outside the exact checked range is not a
    // conflict in that range. Malformed blocks remain visible and incomplete.
    return (
      !validWindow ||
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      to <= from ||
      (from < windowEnd && to > windowStart)
    );
  });
  const calendars = new Set<string>();
  const unavailable = new Set<string>();
  let complete = calendarRows.length > 0;
  for (const row of calendarRows) {
    const result = record(row.result);
    if (result?.complete !== true) complete = false;
    for (const value of Array.isArray(result?.calendarsChecked) ? result.calendarsChecked : [])
      if (typeof value === 'string' && value.trim()) calendars.add(value.trim());
    for (const value of Array.isArray(result?.unavailable) ? result.unavailable : [])
      if (typeof value === 'string' && value.trim()) unavailable.add(value.trim());
  }
  if (unavailable.size > 0 || calendars.size === 0) complete = false;
  if (window && !validWindow) complete = false;

  const start = window ? zonedClock(window.timeMin, request.timeZone) : null;
  const end = window ? zonedClock(window.timeMax, request.timeZone) : null;
  const nextDay = start
    ? new Date(Date.parse(`${start.day}T12:00:00.000Z`) + 86400000).toISOString().slice(0, 10)
    : '';
  const fullDay = Boolean(
    window &&
      request.timeZone &&
      start &&
      end &&
      start.minutes === 0 &&
      end.minutes === 0 &&
      windowStart % 60000 === 0 &&
      windowEnd % 60000 === 0 &&
      end.day === nextDay,
  );
  const day =
    window?.label || (window ? shortDate(window.timeMin, request.timeZone) : 'the checked day');
  const period = fullDay ? day : 'the checked time range';
  const named = [...calendars];
  const joined =
    named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0];
  const scope = joined
    ? `the ${joined} calendar${named.length === 1 ? '' : 's'} I checked`
    : 'the checked calendars';

  // Format only local wall-clock copy here; absent/invalid owner zones never
  // turn an ISO timestamp into prose or imply a complete owner-local day.
  let timeZone = request.timeZone ?? 'UTC';
  try {
    cachedDateTimeFormatter('en-US', { timeZone }).format(0);
  } catch {
    timeZone = 'UTC';
  }
  const clock = cachedDateTimeFormatter('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
  const zonedTime = cachedDateTimeFormatter('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const zoneAt = (ms: number) =>
    Number.isFinite(ms)
      ? zonedTime.formatToParts(new Date(ms)).find((part) => part.type === 'timeZoneName')?.value
      : undefined;
  const dateTime = cachedDateTimeFormatter('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const time = (value: string, compact: boolean, includeZone = false) => {
    const ms = Date.parse(value);
    return Number.isFinite(ms)
      ? (compact ? (includeZone ? zonedTime : clock) : dateTime).format(new Date(ms))
      : '(time not returned)';
  };
  const malformedBusy = busy.some((slot) => {
    const from = Date.parse(stringField(slot, 'start'));
    const to = Date.parse(stringField(slot, 'end'));
    return !Number.isFinite(from) || !Number.isFinite(to) || to <= from;
  });
  if (malformedBusy) complete = false;

  const title = complete
    ? busy.length === 0
      ? `${period[0]?.toUpperCase()}${period.slice(1)} is clear on ${scope}.`
      : `You have busy time ${fullDay ? day : 'within the checked time range'} on ${scope}.`
    : busy.length > 0
      ? `I found busy time ${fullDay ? day : 'within the checked time range'} on ${scope}, but I can’t confirm your full availability.`
      : `I can’t confirm that ${period} is clear yet.`;
  const lines = [request.verification ? `I rechecked it. ${title}` : title];
  if (!fullDay && window)
    lines.push(`Checked: ${time(window.timeMin, false)} to ${time(window.timeMax, false)}.`);
  if (!complete && busy.length === 0 && calendars.size > 0)
    lines.push(
      `${scope[0]?.toUpperCase()}${scope.slice(1)} returned no busy blocks for ${fullDay ? day : 'that range'}.`,
    );
  if (!complete && calendars.size === 0)
    lines.push('No calendars were listed as successfully checked.');
  for (const slot of busy.slice(0, 50)) {
    const calendar = stringField(slot, 'calendar');
    const rawFrom = Date.parse(stringField(slot, 'start'));
    const rawTo = Date.parse(stringField(slot, 'end'));
    const from = validWindow && Number.isFinite(rawFrom) ? Math.max(windowStart, rawFrom) : rawFrom;
    const to = validWindow && Number.isFinite(rawTo) ? Math.min(windowEnd, rawTo) : rawTo;
    const zoneChanges = zoneAt(from) !== zoneAt(to);
    const slotTime = (ms: number, isEnd: boolean) =>
      fullDay && ms === (isEnd ? windowEnd : windowStart)
        ? isEnd
          ? 'the end of the day'
          : 'the start of the day'
        : Number.isFinite(ms)
          ? time(new Date(ms).toISOString(), fullDay, zoneChanges)
          : '(time not returned)';
    const span =
      fullDay && from === windowStart && to === windowEnd
        ? 'all day'
        : `${slotTime(from, false)} to ${slotTime(to, true)}`;
    lines.push(`- Busy${calendar ? ` (${calendar})` : ''}: ${span}`);
  }
  if (complete && window && busy.length > 0) {
    for (const free of calendarFreeIntervals(busy, window)) {
      const zoneChanges = zoneAt(Date.parse(free.start)) !== zoneAt(Date.parse(free.end));
      const from =
        fullDay && Date.parse(free.start) === Date.parse(window.timeMin)
          ? 'the start of the day'
          : time(free.start, fullDay, zoneChanges);
      const to =
        fullDay && Date.parse(free.end) === Date.parse(window.timeMax)
          ? 'the end of the day'
          : time(free.end, fullDay, zoneChanges);
      lines.push(`- Open according to the checked calendars: ${from} to ${to}`);
    }
  }
  if (!complete)
    lines.push(
      `Calendar availability coverage was incomplete${unavailable.size > 0 ? `; unavailable: ${[...unavailable].join(', ')}` : ''}.`,
    );
  return lines;
}

function emailExcerpt(text: string, terms: string[]): string {
  const compacted = text.replace(/\s+/g, ' ').trim();
  if (!compacted) return '';
  // Short confirmations fit the existing display bound. Preserve the whole
  // receipt so a fourth sentence containing the price or booking reference
  // is not silently dropped by the relevance/sentence filter below.
  if (compacted.length <= 700) return compacted;
  const sentences = compacted.split(/(?<=[.!?])\s+/);
  const relevant = sentences.filter((sentence) => {
    const lower = sentence.toLowerCase();
    return (
      terms.some((term) => lower.includes(term.toLowerCase())) ||
      /\b(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
        sentence,
      )
    );
  });
  return (relevant.length > 0 ? relevant : sentences).slice(0, 3).join(' ').slice(0, 700);
}

function literalLinks(value: string): string[] {
  return [
    ...new Set(
      (value.match(/https?:\/\/[^\s<>'"`]+/gi) ?? []).map((url) =>
        url.replace(/[.,;:!?)\]]+$/, ''),
      ),
    ),
  ].slice(0, 5);
}

/**
 * Words a grounded answer may use without having invented them: every literal
 * field the lookup returned, plus whatever the owner and the tools already put
 * in the window. Normalized to bare lowercase tokens so a draft that rewrites
 * “Bay FC vs. Houston Dash” as “Bay FC vs Houston Dash” still matches.
 */
function groundingWords(value: string): string[] {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * The calendar day and minute-of-day an instant falls on in the owner's zone.
 * The draft states wall-clock times ("11:15"), while the ledger holds offsets
 * ("2026-08-23T11:15:00-07:00"), so both sides have to be reduced to the same
 * zoned reading before they can be compared at all. An all-day date carries no
 * minute, which is why `minutes` is -1 rather than 0 there.
 */
function zonedClock(value: string, timeZone?: string): { day: string; minutes: number } | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { day: value, minutes: -1 };
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  try {
    const parts = Object.fromEntries(
      cachedDateTimeFormatter('en-CA', {
        timeZone: timeZone ?? 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
        .formatToParts(new Date(ms))
        .map((part) => [part.type, part.value]),
    );
    const hour = Number(parts.hour === '24' ? '00' : parts.hour);
    return {
      day: `${parts.year}-${parts.month}-${parts.day}`,
      minutes: hour * 60 + Number(parts.minute),
    };
  } catch {
    return null;
  }
}

/** Wall-clock times the draft states: "09:30", "9:30 AM", "3pm", "14:00". */
const DRAFT_CLOCK_RE = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\.?\b|\b(\d{1,2}):(\d{2})\b/gi;

/**
 * Availability phrasing states a boundary the owner is free either side of
 * ("clear from 14:00", "nothing after 5pm"). Those times are derived from the
 * agenda rather than copied off an event, so they are exempt from the boundary
 * check — only a time presented as an event's own is held to it.
 */
const AVAILABILITY_CONTEXT =
  /\b(?:after|around|before|by|clear|free|from|open|past|rest of|since|till|until|up to)\b[^.;:\n]{0,24}$/i;

/** Runs of two or more capitalised words — what an invented venue or title looks like. */
const PROPER_RUN_RE =
  /\b([A-Z][\w'’-]*(?:[ \t]+(?:of|the|at|in|on|and|de|van|von)[ \t]+)?(?:[ \t]+[A-Z][\w'’-]*)+)\b/g;

const GROUNDING_STOPWORDS = new Set([
  ...groundingWords(
    'monday tuesday wednesday thursday friday saturday sunday jan feb mar apr may jun jul aug sep oct nov dec',
  ),
  ...groundingWords(
    'january february march april june july august september october november december',
  ),
  ...groundingWords('am pm all day today tomorrow tonight this next last week weekend morning'),
  ...groundingWords('afternoon evening night the and or you your i a an at on in to of for with'),
  ...groundingWords('open in google calendar event link video meeting conference no nothing none'),
]);

const FALSE_EMPTY_RE =
  /\b(?:nothing(?:\s+(?:on|at all|scheduled|happening|else|planned))?|no events?|no meetings?|calendar is (?:clear|empty)|(?:clear|free|empty) (?:all day|today|the whole day))\b/i;

/**
 * Claims about time the owner does NOT have booked. These cannot be read off
 * an event the way a start time can — they are an assertion about everything
 * that is absent, which only a complete view of the window can support.
 */
const FREE_CLAIM_RE =
  /\b(?:free|clear|wide open|nothing (?:on|until|till|after|before)|no conflicts?|available)\b/i;

const CARDINALS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const MONTH_NUMBER: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function claimUnits(text: string): string[] {
  return text
    .replace(/\s+and\s+(?=(?:the\s+)?[A-Z\d])/g, '\n')
    .split(/\n+|(?<=[.!?;])\s+/)
    .map((unit) => unit.trim().replace(/^\s*[-*+]\s*/, ''))
    .filter(Boolean);
}

function eventClaimMatches(unit: string, event: ClaimFact & { kind: 'calendar_event' }): boolean {
  const words = groundingWords(unit);
  const text = words.join(' ');
  return (
    draftMentions(event.summary, words, text) ||
    (event.location.length > 0 && draftMentions(event.location, words, text))
  );
}

function explicitCivilDates(unit: string): string[] {
  const dates: string[] = [];
  for (const [date] of unit.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)) dates.push(date);
  for (const match of unit.matchAll(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/gi,
  )) {
    const month = MONTH_NUMBER[(match[1] ?? '').toLowerCase()];
    const day = Number(match[2]);
    const year = Number(match[3]) || null;
    if (month && day >= 1 && day <= 31) dates.push(`${year ?? '*'}-${month}-${day}`);
  }
  for (const match of unit.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?\b/g)) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31)
      dates.push(`${Number(match[3]) || '*'}-${month}-${day}`);
  }
  return dates;
}

function eventLocalDay(value: string, timeZone?: string): string | null {
  return zonedClock(value, timeZone)?.day ?? null;
}

function datesMatchEvent(
  unit: string,
  event: ClaimFact & { kind: 'calendar_event' },
  timeZone?: string,
): boolean {
  const day = eventLocalDay(event.start, timeZone);
  if (!day) return false;
  for (const date of explicitCivilDates(unit)) {
    const [yearText, monthText, dayText] = date.split('-');
    if (
      Number(monthText) !== Number(day.slice(5, 7)) ||
      Number(dayText) !== Number(day.slice(8, 10)) ||
      (yearText !== '*' && Number(yearText) !== Number(day.slice(0, 4)))
    )
      return false;
  }
  const weekdayMatch = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(unit);
  if (weekdayMatch) {
    const expected = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
      weekday: 'long',
      timeZone: 'UTC',
    });
    if (expected.toLowerCase() !== weekdayMatch[1]?.toLowerCase()) return false;
  }
  return true;
}

function calendarRelationshipReasons(
  text: string,
  request: PersonalReadRequest,
  events: Record<string, unknown>[],
  facts: ClaimFact[],
): string[] {
  const eventFacts = facts.filter(
    (fact): fact is ClaimFact & { kind: 'calendar_event' } => fact.kind === 'calendar_event',
  );
  const reasons: string[] = [];
  if (!eventFacts.length) return reasons;
  for (const unit of claimUnits(text)) {
    const clocks = [
      ...statedClocks(unit),
      ...[...unit.matchAll(ISO_INSTANT_RE)]
        .map(([instant]) => zonedClock(instant, request.timeZone)?.minutes)
        .filter((minute): minute is number => typeof minute === 'number' && minute >= 0),
    ];
    const dates = explicitCivilDates(unit);
    const names = [...unit.matchAll(PROPER_RUN_RE)].map((match) => match[1] ?? '');
    PROPER_RUN_RE.lastIndex = 0;
    const namedCalendar = names.some((name) =>
      eventFacts.some((event) => {
        const words = groundingWords(`${event.summary} ${event.location}`);
        return groundingWords(name).some((token) => token.length >= 4 && words.includes(token));
      }),
    );
    const freeClaim = FREE_CLAIM_RE.test(unit);
    const calendarMarker =
      /\b(?:calendar|schedule|agenda|event|appointment|meeting|interview|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
        unit,
      );
    if (!clocks.length && !dates.length && !namedCalendar && !freeClaim) continue;
    if (freeClaim) {
      reasons.push('a free-time boundary is not established by event rows or a named search');
      continue;
    }
    const candidates = eventFacts.filter((event) => eventClaimMatches(unit, event));
    if (candidates.length !== 1) {
      if (!candidates.length && !namedCalendar && !calendarMarker) continue;
      reasons.push('date, time, or place is not joined to one matching calendar event');
      continue;
    }
    const event = candidates[0];
    if (!event) continue;
    const expectedTimes = [event.start, event.end]
      .map((value) => zonedClock(value, request.timeZone)?.minutes)
      .filter((value): value is number => typeof value === 'number' && value >= 0);
    if (clocks.some((clock) => !expectedTimes.includes(clock)))
      reasons.push('a clock time does not belong to the named calendar event');
    if (!datesMatchEvent(unit, event, request.timeZone))
      reasons.push('a date does not belong to the named calendar event');
    const prose = unit.replace(MARKDOWN_LINK_RE, ' ').replace(BARE_URL_RE, ' ');
    for (const match of prose.matchAll(PROPER_RUN_RE)) {
      const phrase = match[1] ?? '';
      const normalized = groundingWords(phrase).join(' ');
      if (!normalized) continue;
      const sameEventWords = groundingWords(`${event.summary} ${event.location}`).join(' ');
      if (!sameEventWords.includes(normalized))
        reasons.push('a named place is not part of the same calendar event');
    }
  }
  // Completeness applies to the searched window, not to the query's matches.
  if (
    request.firstToolName === 'calendar.search_events' &&
    events.length > 0 &&
    FREE_CLAIM_RE.test(text)
  )
    reasons.push('a named calendar search cannot establish free time around its matches');
  return [...new Set(reasons)];
}

function exactTeamMatch(claim: string, team: string): boolean {
  const tokens = groundingWords(team).filter(
    (word) => word.length > 2 && !GROUNDING_STOPWORDS.has(word),
  );
  const claimTokens = groundingWords(claim);
  const nickname = tokens.at(-1);
  return (
    tokens.length > 0 &&
    (tokens.every((token) => claimTokens.includes(token)) ||
      Boolean(nickname && nickname.length >= 4 && claimTokens.includes(nickname)))
  );
}

function normalizedPlace(value: string): string {
  return groundingWords(value).join(' ');
}

function exactPlaceMatch(claim: string, fact: string): boolean {
  const expected = normalizedPlace(fact);
  return expected.length > 0 && normalizedPlace(claim) === expected;
}

const LIVE_TEMPERATURE_RE = /(-?\d{1,3})\s*°\s*([CF])?\b|(-?\d{1,3})\s+degrees\s*([CF])?\b/gi;
const PLACE_WORD = String.raw`[\p{L}][\p{L}\p{M}'’.-]*`;
const PLACE_PHRASE = String.raw`${PLACE_WORD}(?:\s+${PLACE_WORD}){0,3}`;

function localTemperatureQualifiers(unit: string, match: RegExpMatchArray): string {
  const start = match.index ?? 0;
  const priorTemperatureEnds = [...unit.matchAll(LIVE_TEMPERATURE_RE)]
    .filter((prior) => (prior.index ?? 0) < start)
    .map((prior) => (prior.index ?? 0) + prior[0].length);
  const previousEnd = priorTemperatureEnds.at(-1) ?? 0;
  return unit.slice(previousEnd, start).toLowerCase();
}

function claimedPlaceForTemperature(
  unit: string,
  match: RegExpMatchArray,
  facts: Array<Extract<ClaimFact, { kind: 'temperature' }>>,
): string | undefined {
  const temperatureAt = match.index ?? 0;
  const candidates: Array<{ value: string; at: number }> = [];
  const add = (value: string, at: number) => {
    let place = value.trim().replace(/[.,;:!?]+$/u, '');
    const trailingContext = new Set([
      'today',
      'tomorrow',
      'tonight',
      'currently',
      'now',
      'right',
      'forecast',
      'temperature',
      'weather',
      'is',
      'was',
      'will',
      'be',
    ]);
    const words = place.split(/\s+/u);
    while (words.length > 1) {
      const lastWord = words.at(-1)?.toLowerCase();
      if (!lastWord || !trailingContext.has(lastWord)) break;
      words.pop();
    }
    place = words.join(' ');
    if (place) candidates.push({ value: place, at });
  };

  // Prefer an explicit prepositional location. This accepts lowercase names
  // while preserving the actual phrase the response attached to the reading.
  const preposition = new RegExp(`\\b(?:in|for)\\s+(${PLACE_PHRASE})`, 'giu');
  for (const place of unit.matchAll(preposition)) {
    const value = place[1] ?? '';
    const at = place.index ?? 0;
    if (value) add(value, at);
  }

  // A sentence can put the city before the reading ("Paris is currently
  // 20°C"). Ignore common grammatical subjects so "It is 20°C" stays
  // location-neutral.
  const leadingPlace = new RegExp(
    `^\\s*(${PLACE_PHRASE})\\s+(?:is|was|will\\s+be|currently|right\\s+now)\\b`,
    'iu',
  ).exec(unit);
  if (leadingPlace?.[1]) {
    const value = leadingPlace[1].trim();
    if (
      !new Set(['it', 'the temperature', 'current temperature', 'the weather']).has(
        value.toLowerCase(),
      )
    )
      add(value, 0);
  }

  // Known place names also bind when the wording omits "in/for". Matching
  // source names case-insensitively supports both sentence-initial and
  // lowercase forms without treating arbitrary nouns as a location.
  for (const fact of facts) {
    const place = fact.place.trim();
    if (!place) continue;
    const escaped = place
      .split(/\s+/u)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
      .join('\\s+');
    const knownPlace = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
    for (const occurrence of unit.matchAll(knownPlace))
      candidates.push({ value: place, at: occurrence.index ?? 0 });
  }

  const nearest = candidates
    .filter((candidate) => Math.abs(candidate.at - temperatureAt) <= 160)
    .sort(
      (left, right) => Math.abs(left.at - temperatureAt) - Math.abs(right.at - temperatureAt),
    )[0];
  return nearest?.value;
}

function weekdayKey(value: string): string {
  const normalized = value.toLowerCase();
  const aliases: Record<string, string> = {
    mon: 'monday',
    monday: 'monday',
    tue: 'tuesday',
    tues: 'tuesday',
    tuesday: 'tuesday',
    wed: 'wednesday',
    wednesday: 'wednesday',
    thu: 'thursday',
    thur: 'thursday',
    thurs: 'thursday',
    thursday: 'thursday',
    fri: 'friday',
    friday: 'friday',
    sat: 'saturday',
    saturday: 'saturday',
    sun: 'sunday',
    sunday: 'sunday',
  };
  return aliases[normalized] ?? normalized;
}

function liveRelationshipReasons(
  text: string,
  facts: ClaimFact[],
  hasWeatherEvidence = false,
): string[] {
  const reasons: string[] = [];
  const scoreFacts = facts.filter(
    (fact): fact is Extract<ClaimFact, { kind: 'score' }> => fact.kind === 'score',
  );
  for (const unit of claimUnits(text)) {
    const scoreClaim =
      /\b(.+?)\s+(?:beat|beats|defeated|lost to)\s+(.+?)\s+(\d{1,3})\s*[-–—]\s*(\d{1,3})\b/i.exec(
        unit,
      );
    if (scoreClaim) {
      const winner = scoreClaim[1] ?? '';
      const loser = scoreClaim[2] ?? '';
      const first = Number(scoreClaim[3]);
      const second = Number(scoreClaim[4]);
      const matched = scoreFacts.some((fact) => {
        const subjectIsAway = exactTeamMatch(winner, fact.away) && exactTeamMatch(loser, fact.home);
        const subjectIsHome = exactTeamMatch(winner, fact.home) && exactTeamMatch(loser, fact.away);
        if (!subjectIsAway && !subjectIsHome) return false;
        const subjectScore = subjectIsAway ? fact.awayScore : fact.homeScore;
        const opponentScore = subjectIsAway ? fact.homeScore : fact.awayScore;
        if (first !== subjectScore || second !== opponentScore) return false;
        return /lost to/i.test(scoreClaim[0])
          ? subjectScore < opponentScore
          : subjectScore > opponentScore;
      });
      if (!matched) reasons.push('a score and the teams it describes do not match one game record');
    }
    const temperatureFacts = facts.filter(
      (fact): fact is Extract<ClaimFact, { kind: 'temperature' }> => fact.kind === 'temperature',
    );
    const temperatureClaims =
      temperatureFacts.length || hasWeatherEvidence ? [...unit.matchAll(LIVE_TEMPERATURE_RE)] : [];
    for (const match of temperatureClaims) {
      const value = Number(match[1] ?? match[3]);
      const unitName = (match[2] ?? match[4] ?? '').toUpperCase();
      const qualifierContext = localTemperatureQualifiers(unit, match);
      const qualifierWords =
        /\b(high|maximum|low|minimum|current|currently|now|forecast|hourly|feels?\s+like)\b/i
          .exec(qualifierContext)?.[1]
          ?.toLowerCase();
      const qualifier =
        qualifierWords?.includes('high') || qualifierWords === 'maximum'
          ? 'high'
          : qualifierWords?.includes('low') || qualifierWords === 'minimum'
            ? 'low'
            : qualifierWords === 'hourly'
              ? 'hourly'
              : qualifierWords === 'current' ||
                  qualifierWords === 'currently' ||
                  qualifierWords === 'now'
                ? 'current'
                : undefined;
      const metric = /\bfeels?\s+like\b/i.test(qualifierContext) ? 'feels_like' : 'temperature';
      const place = claimedPlaceForTemperature(unit, match, temperatureFacts);
      const weekday = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
        .exec(unit)?.[1]
        ?.toLowerCase();
      const isoDate = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(unit)?.[1];
      const relativeDate = /\b(today|tomorrow|tonight)\b/i.exec(unit)?.[1]?.toLowerCase();
      const daypart = /\b(early[- ]morning|morning|midday|afternoon|evening|night)\b/i
        .exec(unit)?.[1]
        ?.toLowerCase()
        .replace('-', ' ');
      const clock = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b/i.exec(unit);
      const claimedHour = clock
        ? (Number(clock[1]) % 12) + (clock[3]?.toLowerCase() === 'pm' ? 12 : 0)
        : undefined;
      const forecastClaim = /\bforecast\b/i.test(qualifierContext);
      const hourMatchesDaypart = (hour: number, label: string): boolean => {
        const ranges: Record<string, readonly [number, number]> = {
          'early morning': [5, 8],
          morning: [8, 11],
          midday: [11, 14],
          afternoon: [14, 17],
          evening: [17, 21],
          night: [21, 24],
        };
        const range = ranges[label];
        return Boolean(range && hour >= range[0] && hour < range[1]);
      };
      PROPER_RUN_RE.lastIndex = 0;
      const matched = temperatureFacts.some((fact) => {
        const dateMatches =
          (!weekday || weekdayKey(fact.weekday) === weekdayKey(weekday)) &&
          (!isoDate || fact.date === isoDate) &&
          (!relativeDate ||
            (relativeDate === 'today'
              ? fact.scope === 'current' ||
                (fact.requestedDate.length > 0 && fact.date === fact.requestedDate)
              : fact.requestedDate.length > 0 && fact.date === fact.requestedDate));
        const qualifierMatches = !qualifier || fact.qualifier === qualifier;
        const hourMatches =
          claimedHour === undefined
            ? !daypart ||
              fact.windowLabel.toLowerCase().replace('-', ' ') === daypart ||
              (fact.hour !== null && hourMatchesDaypart(fact.hour, daypart))
            : fact.hour === claimedHour;
        const occurrenceBound =
          fact.scope === 'current'
            ? !forecastClaim &&
              !weekday &&
              !isoDate &&
              relativeDate !== 'tomorrow' &&
              claimedHour === undefined &&
              !daypart
            : Boolean(
                weekday ||
                  isoDate ||
                  relativeDate ||
                  forecastClaim ||
                  claimedHour !== undefined ||
                  daypart,
              );
        return (
          fact.value === value &&
          (!unitName || fact.unit === unitName) &&
          fact.metric === metric &&
          qualifierMatches &&
          (!place || exactPlaceMatch(place, fact.place)) &&
          dateMatches &&
          hourMatches &&
          occurrenceBound
        );
      });
      if (!matched)
        reasons.push(
          'a temperature value, unit, qualifier, or place is not supported by one reading',
        );
    }
  }
  return reasons;
}

function liveRelationFallback(facts: ClaimFact[], reasons: string[]): string {
  const lines: string[] = [];
  for (const fact of facts) {
    if (fact.kind === 'score') lines.push(`- ${fact.sourceLine}`);
    if (fact.kind === 'temperature') {
      const metric = fact.metric === 'feels_like' ? 'feels-like temperature' : 'temperature';
      const qualifier = fact.qualifier === 'current' ? 'current' : fact.qualifier;
      const day = fact.weekday || fact.date;
      lines.push(
        `- ${[
          day,
          fact.windowLabel || fact.window,
          fact.hour === null ? '' : `${fact.hour}:00`,
          qualifier,
          metric,
          fact.place,
        ]
          .filter(Boolean)
          .join(' ')}: ${fact.value}°${fact.unit ?? ''}`,
      );
    }
  }
  const detail =
    lines.length > 0 ? ` The returned readings are:\n${[...new Set(lines)].join('\n')}` : '';
  const subject = reasons.some((reason) => reason.includes('temperature'))
    ? 'temperature reading'
    : 'scoreline';
  return `I couldn't verify that ${subject} against one returned record, so I won't report the disputed figure as fact.${detail}`;
}

function actionRelationshipFailures(text: string, evidence: ActionEvidence[]): ActionKind[] {
  const facts = evidenceClaimFacts(evidence);
  const failures = new Set<ActionKind>();
  const calendarFacts = facts.filter(
    (fact): fact is Extract<ClaimFact, { kind: 'calendar_mutation' }> =>
      fact.kind === 'calendar_mutation',
  );
  for (const unit of claimUnits(text)) {
    const operationMatches = [
      ...unit.matchAll(
        /\b(create|created|add|added|schedule|scheduled|book|booked|cancel|cancelled|canceled|delete|deleted|remove|removed|update|updated|change|changed|move|moved|reschedule|rescheduled)\b/gi,
      ),
    ];
    if (operationMatches.length > 0 && claimedKinds(unit).includes('calendar')) {
      const requested = operationMatches.map((match) => {
        const verb = (match[1] ?? '').toLowerCase();
        if (/^(?:cancel|cancelled|canceled)$/.test(verb)) return ['cancel'];
        if (/^(?:delete|deleted|remove|removed)$/.test(verb)) return ['delete', 'cancel'];
        if (/^(?:update|updated|change|changed|move|moved|reschedule|rescheduled)$/.test(verb))
          return ['update'];
        return ['create'];
      });
      if (requested.some((ops) => !calendarFacts.some((fact) => ops.includes(fact.operation))))
        failures.add('calendar');
      const named = PROPER_RUN_RE.exec(unit)?.[1] ?? '';
      PROPER_RUN_RE.lastIndex = 0;
      if (named) {
        const name = groundingWords(named).join(' ');
        const operationFacts = calendarFacts.filter((fact) =>
          requested.some((ops) => ops.includes(fact.operation)),
        );
        if (
          operationFacts.length > 0 &&
          !operationFacts.some((fact) => groundingWords(fact.summary).join(' ').includes(name))
        )
          failures.add('calendar');
      }
    }
    if (claimedKinds(unit).includes('outbound')) {
      const sendFacts = facts.filter(
        (fact): fact is Extract<ClaimFact, { kind: 'outbound' }> => fact.kind === 'outbound',
      );
      const countMatch =
        /\b(?:sent|emailed|texted|messaged|called|notified)\s+(?:(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+)?(?:emails?|messages?|texts?|calls?)\b/i.exec(
          unit,
        );
      if (countMatch?.[1]) {
        const requestedCount = CARDINALS[countMatch[1].toLowerCase()] ?? Number(countMatch[1]);
        if (Number.isFinite(requestedCount) && requestedCount !== sendFacts.length)
          failures.add('outbound');
      }
      const target =
        /\b(?:to|for)\s+([\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)\b/u.exec(
          unit,
        )?.[1] ??
        /\b(?:to|for)\s+([A-Z][\p{L}\p{M}'’.-]*(?:\s+[A-Z][\p{L}\p{M}'’.-]*){0,2})\b/u.exec(
          unit,
        )?.[1] ??
        /\b(?:emailed|texted|messaged|contacted|notified|called)\s+(?:an?\s+)?(?:email\s+to\s+)?([\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)\b/u.exec(
          unit,
        )?.[1] ??
        /\b(?:emailed|texted|messaged|contacted|notified|called)\s+(?:an?\s+)?([A-Z][\p{L}\p{M}'’.-]*(?:\s+[A-Z][\p{L}\p{M}'’.-]*){0,2})\b/u.exec(
          unit,
        )?.[1];
      if (target) {
        const targetEmail = target.includes('@') ? target.toLowerCase() : undefined;
        const normalized = groundingWords(target);
        const recipientMatch = sendFacts.some((fact) =>
          fact.recipients.some((recipient) => {
            if (targetEmail) return recipient.toLowerCase() === targetEmail;
            const recipientWords = groundingWords(
              recipient.replace(/@.*/, '').replace(/[._+-]/g, ' '),
            );
            return (
              normalized.length > 0 && normalized.every((word) => recipientWords.includes(word))
            );
          }),
        );
        if (!recipientMatch) failures.add('outbound');
      }
    }
  }
  return [...failures];
}

/**
 * Past this many events an agenda stops being prose worth writing and the
 * ledger's flat list is genuinely the better answer, so coverage is not
 * enforced above it — the draft falls back instead.
 */
const MAX_AGENDA_EVENTS = 12;

/** Every wall-clock time stated in a piece of text, as minutes past midnight. */
const ISO_INSTANT_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g;

function statedClocks(value: string): number[] {
  const found: number[] = [];
  for (const match of value.matchAll(DRAFT_CLOCK_RE)) {
    const meridiem = match[3]?.toLowerCase();
    const hour = Number(match[1] ?? match[4]);
    const minute = Number(match[2] ?? match[5] ?? '0');
    if (!Number.isFinite(hour) || hour > 23 || minute > 59) continue;
    found.push(
      meridiem ? ((hour % 12) + (meridiem === 'p' ? 12 : 0)) * 60 + minute : hour * 60 + minute,
    );
  }
  return found;
}

const FLIGHT_SOURCE = /\b(?:flight|flights|airline|itinerary|boarding|departure)\b/i;
const FLIGHT_BOOKING_SOURCE =
  /\b(?:booking|confirmation|itinerary|ticket|reservation|boarding pass|e-ticket)\b/i;
const FLIGHT_DEPARTURE_CLOCK =
  /\b(?:departure(?:\s+time)?|departs?|departed|departing|leaves?)\s*(?:(?:is|was|will be)\s+)?(?:at\s+)?(?::\s*)?(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|\d{1,2}:\d{2})\b/gi;

type FlightDepartureFact = {
  day: string;
  minutes: number;
  subject: string;
  source: string;
  threadId: string;
};

function requestedLocalDay(request: PersonalReadRequest): string | null {
  const start = request.temporalIntent?.interval.start ?? request.timeWindow?.timeMin;
  return start ? eventLocalDay(start, request.timeZone) : null;
}

type UpcomingFlightCandidate = {
  day: string;
  instant: number;
  event: Record<string, unknown>;
  source: string;
};

/** Select only a timestamped future flight record from the calendar. */
function upcomingFlightCandidate(
  request: PersonalReadRequest,
  evidence: ActionEvidence[],
): UpcomingFlightCandidate | null {
  if (!request.upcomingFlightDiscovery) {
    const day = requestedLocalDay(request);
    return day ? { day, instant: 0, event: {}, source: '' } : null;
  }
  const interval = request.temporalIntent?.interval;
  if (!interval) return null;
  const start = Date.parse(interval.start);
  const end = Date.parse(interval.endExclusive);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const candidates: UpcomingFlightCandidate[] = [];
  const current = currentSuccessfulEvidence(evidence);

  for (const row of matchingCalendarRows(request, current)) {
    for (const event of resultItems(row, 'events')) {
      const eventStart = stringField(event, 'start');
      if (!/[T ]\d{2}:\d{2}/.test(eventStart)) continue;
      const instant = Date.parse(eventStart);
      const source = [
        stringField(event, 'summary'),
        stringField(event, 'description'),
        stringField(event, 'location'),
      ].join(' ');
      if (
        !Number.isFinite(instant) ||
        instant < start ||
        instant >= end ||
        !FLIGHT_SOURCE.test(source) ||
        stringField(event, 'status').toLowerCase() === 'cancelled'
      )
        continue;
      const day = eventLocalDay(eventStart, request.timeZone);
      if (day) candidates.push({ day, instant, event, source });
    }
  }
  candidates.sort(
    (left, right) =>
      left.instant - right.instant ||
      left.day.localeCompare(right.day) ||
      stringField(left.event, 'eventId').localeCompare(stringField(right.event, 'eventId')) ||
      stringField(left.event, 'summary').localeCompare(stringField(right.event, 'summary')),
  );
  return candidates[0] ?? null;
}

function flightRouteTerms(source: string): string[] {
  const route = source.match(
    /\b(?:to|from)\s+([\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){0,2})/iu,
  )?.[1];
  return route ? groundingWords(route) : [];
}

function dateMatchesDay(sourceDate: string, day: string): boolean {
  const [yearText, monthText, dayText] = sourceDate.split('-');
  const [year, month, date] = day.split('-').map(Number);
  return (
    Number(monthText) === month &&
    Number(dayText) === date &&
    (yearText === '*' || Number(yearText) === year)
  );
}

/** Keep departure clocks bound to their own dated, destination-matching mail. */
function flightDepartureFacts(
  request: PersonalReadRequest,
  evidence: ActionEvidence[],
  dayOverride?: string | null,
  candidateSource?: string,
): FlightDepartureFact[] {
  const day = dayOverride ?? requestedLocalDay(request);
  if (!day || (request.queryTerms.length === 0 && !request.upcomingFlightDiscovery)) return [];
  const current = currentSuccessfulEvidence(evidence);
  const searches = matchingGmailSearchRows(request, current);
  const threads = matchingGmailThreadRows(searches, current);
  const facts = new Map<string, FlightDepartureFact>();
  const routeTerms = candidateSource ? flightRouteTerms(candidateSource) : [];
  if (request.upcomingFlightDiscovery && routeTerms.length === 0) return [];
  for (const thread of threads) {
    const threadId = stringField(record(thread.args) ?? {}, 'threadId');
    for (const message of resultItems(thread, 'messages')) {
      const source = [
        stringField(message, 'subject'),
        stringField(message, 'snippet'),
        rawStringField(message, 'text'),
      ]
        .filter(Boolean)
        .join(' ');
      if (!FLIGHT_SOURCE.test(source)) continue;
      if (request.upcomingFlightDiscovery && !FLIGHT_BOOKING_SOURCE.test(source)) continue;
      const sourceWords = new Set(groundingWords(source));
      if (routeTerms.some((term) => !sourceWords.has(term))) continue;
      if (
        request.queryTerms.some((term) =>
          groundingWords(term).some((word) => !sourceWords.has(word)),
        )
      )
        continue;
      const sourceDates = explicitCivilDates(source);
      const sourceDateMatchesDay = (date: string) =>
        dateMatchesDay(date, day) && (!request.upcomingFlightDiscovery || !date.startsWith('*-'));
      const oneDatedItinerary =
        new Set(sourceDates).size === 1 && sourceDates.some(sourceDateMatchesDay);
      const subject = stringField(message, 'subject');
      // Airline confirmations commonly use standalone DEPARTURE / ARRIVAL
      // headings followed by a date-and-time line. Keep each heading's bounded
      // section separate so an arrival or onward departure cannot donate its
      // clock to the requested leg.
      const itineraryLines = rawStringField(message, 'text').split(/\r?\n/);
      for (let index = 0; index < itineraryLines.length; index += 1) {
        if (!/^\s*departure\s*$/i.test(itineraryLines[index] ?? '')) continue;
        const section: string[] = [];
        for (
          let cursor = index + 1;
          cursor < Math.min(itineraryLines.length, index + 7);
          cursor += 1
        ) {
          const line = itineraryLines[cursor] ?? '';
          if (/^\s*(?:arrival(?:\s+\+?\d+)?|departure)\s*$/i.test(line)) break;
          section.push(line);
        }
        const sectionText = section.join(' ');
        if (!explicitCivilDates(sectionText).some(sourceDateMatchesDay)) continue;
        const clockLine = /\bat\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\b/gi;
        for (const match of sectionText.matchAll(clockLine)) {
          for (const minutes of statedClocks(match[1] ?? ''))
            facts.set(`${day}:${minutes}:${source}`, { day, minutes, subject, source, threadId });
        }
      }
      // If a message contains outbound and return legs, bind each departure to
      // its own clause date. A single dated itinerary may carry the date in a
      // header sentence, so its departure clause can inherit that one date.
      for (const clause of source.split(/[;.!?\n]+/)) {
        const dateBound =
          explicitCivilDates(clause).some(sourceDateMatchesDay) || oneDatedItinerary;
        if (!dateBound) continue;
        FLIGHT_DEPARTURE_CLOCK.lastIndex = 0;
        for (const match of clause.matchAll(FLIGHT_DEPARTURE_CLOCK)) {
          for (const minutes of statedClocks(match[1] ?? ''))
            facts.set(`${day}:${minutes}:${source}`, { day, minutes, subject, source, threadId });
        }
      }
      FLIGHT_DEPARTURE_CLOCK.lastIndex = 0;
    }
  }
  return [...facts.values()];
}

function flightIdentityReasons(draft: string, facts: FlightDepartureFact[]): string[] {
  const sources = facts.map((fact) => fact.source);
  if (sources.length === 0) return [];
  const sourceWords = new Set(sources.flatMap(groundingWords));
  const reasons: string[] = [];
  const flightClaims = claimUnits(draft).filter((unit) => /\bflight\b/i.test(unit));
  for (const claim of flightClaims) {
    const beforeFlight = claim.slice(0, claim.search(/\bflight\b/i)).trim();
    const candidate =
      beforeFlight
        .split(/\s+/)
        .at(-1)
        ?.replace(/[^\p{L}\p{N}'’-]/gu, '') ?? '';
    const candidateWords = groundingWords(candidate);
    const genericLead = /^(?:a|an|the|my|your|our|this|that)$/i.test(candidate);
    if (
      !genericLead &&
      candidateWords.length > 0 &&
      !candidateWords.every((word) => sourceWords.has(word))
    )
      reasons.push(`the named flight source “${candidate}” is not in the dated matching booking`);
    if (/\b(?:direct(?:ly)?|non[ -]?stop)\b/i.test(claim)) {
      const affirmativelyDirect = sources.some(
        (source) =>
          /\b(?:direct(?:ly)?|non[ -]?stop)\b/i.test(source) &&
          !/\b(?:not|never|no)\s+(?:a\s+)?(?:direct|non[ -]?stop)\b/i.test(source),
      );
      if (!affirmativelyDirect)
        reasons.push('a direct or nonstop route is not established by the dated matching booking');
    }
  }
  return [...new Set(reasons)];
}

function flightClockLabel(minutes: number): string {
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${hour24 % 12 || 12}:${String(minute).padStart(2, '0')} ${hour24 < 12 ? 'AM' : 'PM'}`;
}

type FlightCalendarClock = { minutes: number; label: string };

function upcomingFlightSourceLinks(
  candidate: UpcomingFlightCandidate | null,
  threadIds: string[] = [],
): string {
  const sources: string[] = [];
  const links = candidate?.event.links;
  if (Array.isArray(links)) {
    for (const link of links) {
      const value = record(link);
      if (stringField(value ?? {}, 'type') !== 'calendar') continue;
      const raw = stringField(value ?? {}, 'url');
      try {
        const parsed = new URL(raw);
        const eventLink =
          parsed.protocol === 'https:' &&
          ['calendar.google.com', 'www.google.com'].includes(parsed.hostname) &&
          parsed.pathname.toLowerCase().includes('event') &&
          parsed.username === '' &&
          parsed.password === '';
        if (eventLink)
          sources.push(`Calendar source: ${parsed.href.replace(/[()]/g, encodeURIComponent)}`);
      } catch {
        // Ignore a malformed or non-Google provider URL.
      }
    }
  }
  for (const threadId of [...new Set(threadIds)]) {
    if (/^[A-Za-z0-9_-]{3,128}$/.test(threadId))
      sources.push(`Booking email candidate: https://mail.google.com/mail/u/0/#all/${threadId}`);
  }
  return sources.length > 0 ? `\n${sources.join('\n')}` : '';
}

function timeZoneLabel(timeZone: string | undefined, instant: number): string {
  if (!timeZone) return 'your calendar time zone';
  try {
    return (
      cachedDateTimeFormatter('en-US', { timeZone, timeZoneName: 'long' })
        .formatToParts(new Date(instant))
        .find((part) => part.type === 'timeZoneName')?.value ?? 'your calendar time zone'
    );
  } catch {
    return 'your calendar time zone';
  }
}

function flightCalendarClocks(
  request: PersonalReadRequest,
  events: Record<string, unknown>[],
  dayOverride?: string | null,
  candidate?: UpcomingFlightCandidate | null,
): FlightCalendarClock[] {
  const day = dayOverride ?? requestedLocalDay(request);
  if (!day) return [];
  const clocks = new Map<number, FlightCalendarClock>();
  for (const event of events) {
    if (candidate && candidate.event !== event) continue;
    const start = stringField(event, 'start');
    if (!start || !/[T ]\d{2}:\d{2}/.test(start)) continue;
    const parsed = zonedClock(start, request.timeZone);
    if (!parsed || parsed.day !== day) continue;
    const source = [
      stringField(event, 'summary'),
      stringField(event, 'description'),
      stringField(event, 'location'),
    ]
      .filter(Boolean)
      .join(' ');
    const words = new Set(groundingWords(source));
    if (
      !FLIGHT_SOURCE.test(source) ||
      request.queryTerms.some((term) => groundingWords(term).some((word) => !words.has(word)))
    )
      continue;
    const label = /\bboarding\b/i.test(source)
      ? 'calendar boarding entry'
      : 'calendar flight entry';
    clocks.set(parsed.minutes, { minutes: parsed.minutes, label });
  }
  return [...clocks.values()];
}

function flightSourcesAreComplete(
  request: PersonalReadRequest,
  evidence: ActionEvidence[],
): boolean {
  const current = currentSuccessfulEvidence(evidence);
  const searches = matchingGmailSearchRows(request, current);
  if (!gmailMetadataCoverageComplete(searches)) return false;
  const expected = new Set(
    searches
      .flatMap((row) => resultItems(row, 'results'))
      .map((item) => stringField(item, 'threadId'))
      .filter(Boolean),
  );
  const read = new Set(
    matchingGmailThreadRows(searches, current)
      .map((row) => stringField(record(row.args) ?? {}, 'threadId'))
      .filter(Boolean),
  );
  return [...expected].every((threadId) => read.has(threadId));
}

export interface ReadGrounding {
  grounded: boolean;
  reasons: string[];
}

/**
 * Is this event's title actually present in the draft? Deliberately generous
 * about form, because shortening a title is good writing and only dropping one
 * is the failure being caught. “Stagecoach Greens with Eva & Jordan's Family”
 * is answered as “Stagecoach Greens”, so a title counts as present when the
 * draft carries its distinctive opening, not only when it carries most of it.
 */
function draftMentions(summary: string, draftWords: string[], draftText: string): boolean {
  const normalized = groundingWords(summary);
  if (normalized.length === 0) return true;
  if (draftText.includes(normalized.join(' '))) return true;
  const significant = normalized.filter((word) => word.length >= 3);
  if (significant.length === 0) return normalized.some((word) => draftWords.includes(word));
  const lead = significant.slice(0, 2);
  if (lead.length === 2 && lead.join('').length >= 8 && draftText.includes(lead.join(' '))) {
    return true;
  }
  const present = significant.filter((word) => draftWords.includes(word));
  return (
    present.length / significant.length >= 0.6 &&
    (significant.every((word) => word.length < 5) || present.some((word) => word.length >= 5))
  );
}

/**
 * Check a model-written lookup answer against the tool ledger it must come
 * from. This is the counterpart to letting the model write calendar and inbox
 * answers at all: the prose is published only if every event-shaped fact in it
 * traces back to a literal field a successful read returned.
 *
 * Deliberately asymmetric about the two ways an agenda can lie. Inventing an
 * event is caught, and so is dropping one — a missed meeting harms the owner
 * at least as much as a phantom one — but a mail rundown may select, because
 * triaging twenty hits down to the three that matter is the entire job. What
 * this cannot parse it leaves alone: a check that fell back on every good
 * answer would just be the ledger under another name.
 *
 * `licensed` carries the rest of the turn's own words (the owner's question,
 * earlier tool output, the ambient weather/location block) so context the
 * owner supplied is never mistaken for something the model made up.
 */
export function groundReadDraft(
  text: string,
  request: PersonalReadRequest,
  evidence: ActionEvidence[],
  licensed = '',
  live = '',
): ReadGrounding {
  const draft = text.trim();
  if (!draft) return { grounded: false, reasons: ['empty draft'] };
  // Calendar briefings are a ledger projection. A fluent model paragraph can
  // still turn similar-looking events into an unsupported duplicate or
  // attendance claim, so keep event identity and source links in the checked
  // projection and reserve generation for the separately checked skill step.
  if (request.includeCalendarBriefing) {
    const projection = verifiedReadResponse(request, evidence);
    if (!draft.startsWith(`${projection}\n\nNext step: `))
      return {
        grounded: false,
        reasons: ['calendar briefing is rendered from checked event rows'],
      };
  }
  // "Are you sure?" is a challenge to the prose itself. The literal ledger is
  // the only answer that settles it, so prose never wins this one.
  if (request.verification) return { grounded: false, reasons: ['verification request'] };
  // A free/busy answer is a claim about every hour in the window at once, and
  // getting it wrong double-books the owner. The ledger's explicit busy blocks
  // and open intervals are the right shape for that question, so it keeps it.
  if (request.firstToolName === 'calendar.availability') {
    return { grounded: false, reasons: ['availability lookup'] };
  }

  const current = currentSuccessfulEvidence(evidence);
  const calendarRows = matchingCalendarRows(request, current);
  const searches = matchingGmailSearchRows(request, current);
  const returnedEvents = uniqueRecords(
    calendarRows.flatMap((row) => resultItems(row, 'events')),
    (event) =>
      [
        stringField(event, 'calendarId'),
        stringField(event, 'eventId'),
        stringField(event, 'start'),
        stringField(event, 'summary'),
      ].join('|'),
  );
  const events = returnedEvents.filter(
    (event) =>
      stringField(event, 'status') !== 'cancelled' &&
      calendarWindowMembership(event, request) !== 'outside',
  );
  const messages = [
    ...searches.flatMap((row) => resultItems(row, 'results')),
    ...matchingGmailThreadRows(searches, current).flatMap((row) => resultItems(row, 'messages')),
  ];

  const reasons: string[] = [];
  if (
    events.some((event) => calendarWindowMembership(event, request) === 'source-date-only') &&
    !/source dates?[^\n]*(?:only|unavailable|unconfirmed)|not confirmed for (?:the )?requested local day/i.test(
      draft,
    )
  )
    reasons.push('floating source dates are not qualified against the requested local day');

  if (request.answerFocus === 'flight') {
    const uncertainty =
      /\b(?:could(?:n['’]t| not)|cannot|can['’]t|unable to|not sure|unclear|unconfirmed|conflicting|ambiguous)\b/i.test(
        draft,
      );
    const facts = flightDepartureFacts(request, evidence);
    const times = [...new Set(facts.map((fact) => fact.minutes))];
    const calendarClocks = flightCalendarClocks(request, events);
    const claims = claimUnits(draft).filter(
      (unit) =>
        /\b(?:flight|departure|depart|boarding|leave|leaves)\b/i.test(unit) &&
        statedClocks(unit).length > 0,
    );
    reasons.push(...flightIdentityReasons(draft, facts));
    if (claims.length === 0 && !uncertainty) {
      reasons.push('does not state a verified departure time or an honest coverage gap');
    } else if (claims.length > 0) {
      if (!flightSourcesAreComplete(request, evidence)) {
        reasons.push('the matching itinerary sources are incomplete or not fully read');
      } else if (times.length !== 1) {
        reasons.push('no single dated departure time is established by the matching itineraries');
      } else if (calendarClocks.some((clock) => clock.minutes !== times[0])) {
        reasons.push('the calendar flight entry conflicts with the date-matched booking message');
      } else if (claims.some((unit) => statedClocks(unit).some((clock) => clock !== times[0]))) {
        reasons.push('a departure time is not supported by the dated matching itinerary');
      }
    }
  }

  // Mail confirmations often give a date but no weekday. Do not let a
  // paraphrase add an unverified weekday (for example calling Sep 5 Friday).
  // Calendar-only answers retain their timestamp-derived weekday rendering.
  if (request.answerFocus === 'lodging' && events.length === 0) {
    const source = JSON.stringify(messages).toLowerCase();
    for (const day of draft.match(
      /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
    ) ?? []) {
      if (!source.includes(day.toLowerCase()))
        reasons.push(`${day} is not supplied by the booking evidence`);
    }
  }

  // No returned records means no basis for a personal booking/application
  // answer, even when a fluent guess contains no capitalized names or dates.
  // Render the explicit empty ledger instead of relying on lexical checks.
  if (request.answerFocus && events.length === 0 && messages.length === 0) {
    reasons.push('no source records establish the requested personal fact');
  }

  // Partial coverage is the ledger's strongest case: it names the gap in a way
  // prose reliably smooths over. Hand those turns straight back to it.
  const incomplete = [...calendarRows, ...searches].some((row) => {
    const result = record(row.result);
    return (
      result?.complete === false ||
      (Array.isArray(result?.unavailable) && result.unavailable.length > 0)
    );
  });
  const failedRead = evidence.some(
    (row) =>
      row.fromCurrentTask !== false &&
      /^(?:calendar|gmail)\./.test(row.toolName) &&
      !successful(row),
  );
  if (incomplete || failedRead) reasons.push('a source was incomplete or failed');

  const vocabulary = new Set<string>(GROUNDING_STOPWORDS);
  const boundaries = new Set<number>();
  for (const event of events) {
    for (const key of ['summary', 'location', 'organizer', 'calendar', 'description']) {
      for (const word of groundingWords(stringField(event, key))) vocabulary.add(word);
    }
    const attendees = event.attendees;
    if (Array.isArray(attendees)) {
      for (const attendee of attendees) {
        if (typeof attendee === 'string') {
          for (const word of groundingWords(attendee)) vocabulary.add(word);
        }
      }
    }
    for (const key of ['start', 'end']) {
      const clock = zonedClock(stringField(event, key), request.timeZone);
      if (clock && clock.minutes >= 0) boundaries.add(clock.minutes);
    }
  }
  for (const message of messages) {
    for (const key of ['subject', 'from', 'snippet', 'to']) {
      for (const word of groundingWords(stringField(message, key))) vocabulary.add(word);
    }
    for (const word of groundingWords(rawStringField(message, 'text'))) vocabulary.add(word);
    // A named appointment is often confirmed only in the mail body, so the
    // times written there are as literal a source as an event's own start.
    for (const clock of statedClocks(
      `${stringField(message, 'subject')} ${stringField(message, 'snippet')} ${rawStringField(message, 'text')}`,
    )) {
      boundaries.add(clock);
    }
  }
  for (const term of request.queryTerms) {
    for (const word of groundingWords(term)) vocabulary.add(word);
  }
  for (const word of groundingWords(licensed)) vocabulary.add(word);
  // A live lookup's own words and times: a game's start, a route's departure.
  // Its timestamps are instants, so read them on the owner's clock the way an
  // event's start is read above.
  for (const word of groundingWords(live)) vocabulary.add(word);
  for (const clock of statedClocks(live)) boundaries.add(clock);
  for (const [instant] of live.matchAll(ISO_INSTANT_RE)) {
    const clock = zonedClock(instant, request.timeZone);
    if (clock && clock.minutes >= 0) boundaries.add(clock.minutes);
  }

  // Strip links first: a fabricated URL is enforceUrlProvenance's job, and a
  // link label would otherwise read as an invented proper noun.
  // A byte-for-byte deterministic agenda remains authoritative when a saved
  // skill contributes a separately checked planning step. Only that appended
  // paragraph is generative; its facts and action claims still need evidence.
  const projection = request.includeCalendarBriefing ? verifiedReadResponse(request, evidence) : '';
  const hasVerifiedPrefix = Boolean(projection && draft.startsWith(`${projection}\n\nNext step: `));
  const generativeDraft = hasVerifiedPrefix ? draft.slice(projection.length).trim() : draft;
  if (
    hasVerifiedPrefix &&
    (!/^Next step:\s*(?:consider|confirm|check|review|prepare|decide|prioriti[sz]e|keep|use|before|if|for|allow|plan|take|bring|make)\b/i.test(
      generativeDraft,
    ) ||
      /\bi(?:['’]ve| have)?\s+(?:already\s+)?(?:sent|emailed|messaged|booked|scheduled|cancelled|canceled|deleted|updated|created|saved|changed|moved)\b/i.test(
        generativeDraft,
      ))
  )
    reasons.push('the appended planning step must be advice, not a claimed result');
  const prose = generativeDraft
    .replace(MARKDOWN_LINK_RE, ' ')
    .replace(BARE_URL_RE, ' ')
    .replace(/[*_`#]/g, ' ');
  const draftWords = groundingWords(prose);
  if (hasVerifiedPrefix) {
    // The canonical briefing's own preparation step uses these connectors
    // and travel advice; named facts, clocks and action claims stay checked.
    const adviceWords = new Set(
      groundingWords(
        'next step consider confirm check review prepare preparation preparing decide prioritize prioritise keep use before if whether for allow plan take bring make need needs necessary attend attendance involvement details sources links source dates times date time coverage calendars unavailable confirm confirmation checking reviewing preparing planning clarify verify avoid resolve conflicts overlapping relevant yourself which who can could should would may might must does do did be being been it its they them these those that this their theirs we us our own only both each any more less some rather instead then travel personal priorities priority practical required requirements materials notes organizer organiser agenda',
      ),
    );
    if (draftWords.some((word) => !vocabulary.has(word) && !adviceWords.has(word)))
      reasons.push('the appended planning step introduces detail absent from its sources');
  }
  const draftText = draftWords.join(' ');

  // Every event the calendar returned has to survive into the answer. Matching
  // is deliberately loose — a shortened title is good writing, not a drop.
  if (!hasVerifiedPrefix && events.length > MAX_AGENDA_EVENTS) {
    reasons.push(`${events.length} events is past the agenda shape`);
  } else if (!hasVerifiedPrefix) {
    for (const event of events) {
      const summary = stringField(event, 'summary');
      if (!draftMentions(summary, draftWords, draftText)) {
        reasons.push(
          `“${summary || '(untitled event)'}” was returned but is missing from the answer`,
        );
      }
    }
  }

  for (const match of prose.matchAll(PROPER_RUN_RE)) {
    const phrase = match[1] ?? '';
    const words = groundingWords(phrase).filter((word) => !GROUNDING_STOPWORDS.has(word));
    if (words.length === 0) continue;
    if (!words.every((word) => vocabulary.has(word))) {
      reasons.push(`“${phrase}” is not in any source result`);
    }
  }

  if (boundaries.size > 0) {
    for (const match of prose.matchAll(DRAFT_CLOCK_RE)) {
      if (AVAILABILITY_CONTEXT.test(prose.slice(0, match.index ?? 0))) continue;
      const meridiem = match[3]?.toLowerCase();
      const hour = Number(match[1] ?? match[4]);
      const minute = Number(match[2] ?? match[5] ?? '0');
      if (!Number.isFinite(hour) || hour > 23 || minute > 59) continue;
      const minutes = meridiem
        ? ((hour % 12) + (meridiem === 'p' ? 12 : 0)) * 60 + minute
        : hour * 60 + minute;
      if (!boundaries.has(minutes)) {
        reasons.push(`${match[0].trim()} is not the start or end of any event that was read`);
      }
    }
  }

  if (events.length > 0 && FALSE_EMPTY_RE.test(prose)) {
    reasons.push('reports an empty day over a non-empty ledger');
  }

  // Saying the owner is free somewhere needs a complete view of the window to
  // rest on. A search that returned the events it was asked for says nothing
  // about the hours around them.
  if (FREE_CLAIM_RE.test(prose) && !(request.timeWindow && !incomplete)) {
    reasons.push('asserts free time without a complete window to read it from');
  }

  reasons.push(
    ...calendarRelationshipReasons(
      generativeDraft,
      request,
      events,
      evidenceClaimFacts(current, live),
    ),
  );
  reasons.push(
    ...liveRelationshipReasons(
      text,
      evidenceClaimFacts(current, live),
      current.some((row) => row.toolName === 'weather.lookup' && successful(row)),
    ),
  );

  // A row-shaped answer that has more rows than the ledger has items is
  // inventing one, whatever the invented row happens to be called. This is the
  // catch for a fabrication too plainly worded to read as a proper noun.
  const rows = (prose.match(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+\S/gm) ?? []).length;
  if (rows > events.length + messages.length) {
    reasons.push(`lists ${rows} items from ${events.length + messages.length} in the ledger`);
  }

  const opening = prose.split('\n', 1)[0] ?? '';
  const cardinal = /^\W*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.exec(opening);
  const stated = cardinal
    ? (CARDINALS[cardinal[1]?.toLowerCase() ?? ''] ?? Number(cardinal[1]))
    : undefined;
  const available = request.kind === 'email' ? messages.length : events.length + messages.length;
  if (stated !== undefined && Number.isFinite(stated) && stated > available) {
    reasons.push(`claims ${stated} items from ${available} in the ledger`);
  }

  return { grounded: reasons.length === 0, reasons };
}

/**
 * Calendar/email answers are rendered from the tool ledger instead of model
 * prose. This is intentionally less flexible: a deterministic list of literal
 * fields is preferable to a fluent answer that can add one plausible event.
 */
export function verifiedReadResponse(
  request: PersonalReadRequest,
  evidence: ActionEvidence[],
  compoundTripExtraction?: CompoundTripExtraction,
): string {
  if (request.temporalIssue || request.scopeIssue)
    return request.temporalIssue ?? request.scopeIssue ?? '';
  if (request.personCalendar) return personCalendarResponse(request, evidence).text;
  if (request.calendarEventAnalysis) {
    const rows = matchingCalendarRows(request, currentSuccessfulEvidence(evidence));
    const events = uniqueRecords(
      rows.flatMap((row) => resultItems(row, 'events')),
      (event) =>
        [
          stringField(event, 'calendarId'),
          stringField(event, 'eventId'),
          stringField(event, 'start'),
          stringField(event, 'summary'),
        ].join('|'),
    );
    const coverageComplete = calendarEventAnalysisCoverageComplete(rows);
    return calendarEventAnalysisResponse({
      request: request.calendarEventAnalysis,
      timeWindow: request.timeWindow,
      timeZone: request.timeZone,
      events,
      coverageComplete,
    });
  }
  if (request.upcomingFlightDiscovery)
    return upcomingFlightReadProjection(request, evidence, compoundTripExtraction).text;
  if (request.compoundTripDiscovery)
    return renderCompoundTripReadResponse(
      compoundTripReadProjection(request, evidence, compoundTripExtraction),
    );
  const current = currentSuccessfulEvidence(evidence);
  if (request.weeklyCalendarPlan) {
    const interval =
      request.temporalIntent?.interval ??
      (request.timeWindow
        ? { start: request.timeWindow.timeMin, endExclusive: request.timeWindow.timeMax }
        : undefined);
    return interval
      ? renderWeeklyCalendarPlan({
          timeMin: interval.start,
          timeMax: interval.endExclusive,
          timeZone: request.timeZone,
          evidence: current,
          plan: request.calendarPlanOptions,
        })
      : 'I couldn’t safely resolve the calendar window for next week. Please confirm the date range and time zone.';
  }
  if (request.kind === 'drive') {
    const rows = matchingPrivateReadRows(request, current);
    const files = uniqueRecords(
      rows.flatMap((row) => resultItems(row, 'files')),
      (file) =>
        stringField(file, 'fileId') || stringField(file, 'url') || stringField(file, 'name'),
    );
    const query = stringField(record(rows[0]?.args) ?? {}, 'query');
    if (files.length === 0) {
      if (!rows.length || rows.some((row) => record(row.result)?.complete !== true))
        return `No matching Drive files were returned${query ? ` for “${query}”` : ''} in this bounded lookup; coverage does not establish that none exist.`;
      return `I searched Drive${query ? ` for “${query}”` : ''} and found no matching files.`;
    }
    return [
      `I found ${files.length} matching Drive ${files.length === 1 ? 'file' : 'files'}:`,
      ...files.map((file) => {
        const name = stringField(file, 'name') || 'Untitled file';
        const modified = stringField(file, 'modifiedTime');
        const url = stringField(file, 'url');
        return `- ${name}${modified ? ` — modified ${modified}` : ''}${url ? ` — ${url}` : ''}`;
      }),
    ].join('\n');
  }
  if (request.kind === 'memory') {
    const rows = matchingPrivateReadRows(request, current);
    const memories = uniqueRecords(
      rows.flatMap((row) => resultItems(row, 'memories')),
      (memory) => stringField(memory, 'id') || stringField(memory, 'content'),
    );
    if (memories.length === 0)
      return rows.length > 0 && rows.every((row) => record(row.result)?.complete === true)
        ? 'I found no supported saved memories for that.'
        : 'No matching saved memories were returned in this bounded lookup; it does not establish that no saved record exists.';
    return [
      `I found ${memories.length} saved ${memories.length === 1 ? 'record' : 'records'}:`,
      ...memories.map((memory) => {
        const content = stringField(memory, 'content');
        const source = stringField(memory, 'source');
        const confidence = Number(memory.confidence);
        const unconfirmed = memory.unconfirmed === true || memory.ownerConfirmed !== true;
        const details = [
          source ? `source: ${source}` : '',
          Number.isFinite(confidence) ? `confidence: ${Math.round(confidence * 100)}%` : '',
          unconfirmed ? 'not owner-confirmed' : 'owner-confirmed',
        ].filter(Boolean);
        return `- ${content}${details.length ? ` (${details.join(', ')})` : ''}`;
      }),
    ].join('\n');
  }
  if (request.kind === 'knowledge_graph') {
    const rows = matchingPrivateReadRows(request, current);
    const relations = uniqueRecords(
      rows.flatMap((row) => resultItems(row, 'relationships')),
      (relation) => stringField(relation, 'id'),
    );
    if (relations.length === 0) {
      if (!rows.length || rows.some((row) => record(row.result)?.complete !== true))
        return 'No matching source-backed connections were returned in this bounded lookup; it does not establish that no connection exists.';
      return 'I found no active, source-backed knowledge-graph connections for that.';
    }
    return [
      `I found ${relations.length} active source-backed ${relations.length === 1 ? 'connection' : 'connections'}:`,
      ...relations.flatMap((relation) => {
        const subject = stringField(relation, 'subjectLabel');
        const predicate = stringField(relation, 'predicate').replaceAll('_', ' ');
        const object = stringField(relation, 'objectLabel');
        const evidenceQuote = stringField(relation, 'evidenceQuote');
        const sourceMemory = stringField(relation, 'sourceMemory');
        const source = stringField(relation, 'source');
        const confidence = Number(relation.memoryConfidence);
        const unconfirmed = relation.unconfirmed === true || relation.ownerConfirmed !== true;
        return [
          `- ${subject} —${predicate}→ ${object}`,
          evidenceQuote ? `  Evidence: “${evidenceQuote}”` : '',
          sourceMemory ? `  Saved fact: ${sourceMemory}` : '',
          `  ${[
            source ? `source: ${source}` : '',
            Number.isFinite(confidence) ? `confidence: ${Math.round(confidence * 100)}%` : '',
            unconfirmed ? 'not owner-confirmed' : 'owner-confirmed',
          ]
            .filter(Boolean)
            .join(', ')}`,
        ].filter(Boolean);
      }),
    ].join('\n');
  }
  const where =
    request.kind === 'email'
      ? 'the mail'
      : request.kind === 'calendar'
        ? 'the calendar'
        : 'the calendar and mail';
  const forWindow = request.timeWindow ? ` for ${request.timeWindow.label}` : '';
  const lines = [
    request.includeCalendarBriefing
      ? `Calendar briefing${forWindow} (local time):`
      : request.verification
        ? 'I rechecked it — this is everything the sources actually return:'
        : `Here's what ${where} has${forWindow}:`,
  ];

  if (request.kind !== 'email') {
    const calendarRows = matchingCalendarRows(request, current);
    if (request.firstToolName === 'calendar.availability') {
      const availability = calendarAvailabilityLines(request, calendarRows);
      if (request.kind === 'calendar') lines.splice(0, lines.length, ...availability);
      else lines.push(...availability);
    } else {
      const events = uniqueRecords(
        calendarRows.flatMap((row) => resultItems(row, 'events')),
        (event) =>
          [
            stringField(event, 'calendarId'),
            stringField(event, 'eventId'),
            stringField(event, 'start'),
            stringField(event, 'summary'),
          ].join('|'),
      );
      if (request.answerFocus === 'flight') {
        const complete = flightSourcesAreComplete(request, evidence);
        const calendarCoverageComplete =
          request.upcomingFlightDiscovery &&
          calendarRows.length > 0 &&
          calendarRows.every((row) => {
            const result = record(row.result);
            return (
              result?.complete === true &&
              typeof result.nextPageToken !== 'string' &&
              result.paginationUnavailable !== true &&
              result.calendarRosterComplete === true &&
              Array.isArray(result.unavailable) &&
              result.unavailable.length === 0
            );
          });
        const candidate = upcomingFlightCandidate(request, evidence);
        const day = candidate?.day ?? null;
        const facts =
          complete && day ? flightDepartureFacts(request, evidence, day, candidate?.source) : [];
        const times = [...new Set(facts.map((fact) => fact.minutes))];
        const candidateEvents =
          request.upcomingFlightDiscovery && candidate ? [candidate.event] : events;
        const calendarClocks = flightCalendarClocks(
          request,
          candidateEvents,
          day,
          request.upcomingFlightDiscovery ? candidate : null,
        );
        if (request.upcomingFlightDiscovery && !day) {
          return calendarCoverageComplete
            ? 'I found no dated flight candidate in the calendar I could check; booking-only itineraries were not independently selected. Connections, hotel, and ground transport remain unverified.'
            : 'I could not establish which flight is next because calendar coverage is incomplete; booking-only itineraries were not independently selected. Connections, hotel, and ground transport remain unverified.';
        }
        const dayLabel =
          request.upcomingFlightDiscovery && day
            ? new Date(`${day}T12:00:00.000Z`).toLocaleDateString('en-US', {
                timeZone: 'UTC',
                dateStyle: 'long',
              })
            : undefined;
        const destination =
          request.queryTerms
            .filter(
              (term) => !/^(?:flight|flights|airline|itinerary|boarding|departure)$/i.test(term),
            )
            .join(' ') || 'requested';
        const candidateTitle = (
          stringField(candidate?.event ?? {}, 'summary').slice(0, 160) || 'the upcoming flight'
        ).replace(/([\\`*_{}[\]()#+.!|>~-])/g, '\\$1');
        const candidateLead = calendarCoverageComplete
          ? `The next flight candidate in your calendar is ${candidateTitle}`
          : `A flight candidate in your calendar is ${candidateTitle}`;
        const candidateCoverageNote = calendarCoverageComplete
          ? ''
          : ' Calendar coverage was incomplete, so I cannot establish that this is the next flight.';
        const sourceLinks = (threadIds: string[] = []) =>
          request.upcomingFlightDiscovery ? upcomingFlightSourceLinks(candidate, threadIds) : '';
        const conflict = calendarClocks.find(
          (clock) => times.length === 1 && clock.minutes !== times[0],
        );
        if (request.upcomingFlightDiscovery && times.length > 1) {
          const routeLabel = flightRouteTerms(candidate?.source ?? '').join(' ') || 'this route';
          return `${candidateLead}${dayLabel ? ` on ${dayLabel}` : ''}, but I found multiple departure clocks in booking-email candidates for ${routeLabel} and couldn't establish which, if any, belongs to this calendar flight.${candidateCoverageNote} Connections, hotel, and ground transport remain unverified.${sourceLinks(facts.map((fact) => fact.threadId))}`;
        }
        if (request.upcomingFlightDiscovery && times.length === 1) {
          const calendarTime = calendarClocks[0];
          const dayText = dayLabel ? ` on ${dayLabel}` : '';
          const calendarText = calendarTime
            ? ` The calendar shows ${flightClockLabel(calendarTime.minutes)} ${timeZoneLabel(request.timeZone, candidate?.instant ?? Date.now())}.`
            : '';
          const routeLabel = flightRouteTerms(candidate?.source ?? '').join(' ') || 'this route';
          return `${candidateLead}${dayText}.${calendarText} A separate booking-email candidate mentioning ${routeLabel} lists departure at ${flightClockLabel(times[0] as number)}, but I couldn't establish that it is the same flight or reconcile its source time zone.${candidateCoverageNote} Connections, hotel, and ground transport remain unverified.${sourceLinks(facts.map((fact) => fact.threadId))}`;
        }
        if (!request.upcomingFlightDiscovery && conflict && times.length === 1)
          return `The matching booking message lists departure at ${flightClockLabel(times[0] as number)}, while the ${conflict.label} shows ${flightClockLabel(conflict.minutes)}${dayLabel ? ` on ${dayLabel}` : ''}. They conflict, so I couldn't confirm which time is current.`;
        if (!request.upcomingFlightDiscovery && times.length > 1)
          return `I found conflicting departure times for the matching ${destination} itineraries${dayLabel ? ` on ${dayLabel}` : ''}, so I couldn't confirm which time is current.`;
        if (!request.upcomingFlightDiscovery && times.length === 1)
          return `The matching ${destination} booking message lists departure at ${flightClockLabel(times[0] as number)}${dayLabel ? ` on ${dayLabel}` : ''}.`;
        if (calendarClocks.length > 0)
          return request.upcomingFlightDiscovery
            ? `${candidateLead}${dayLabel ? ` on ${dayLabel}` : ''} at ${flightClockLabel(calendarClocks[0]?.minutes ?? 0)} ${timeZoneLabel(request.timeZone, candidate?.instant ?? Date.now())}, but I couldn't confirm its departure time from the booking email.${candidateCoverageNote} Connections, hotel, and ground transport remain unverified.${sourceLinks()}`
            : `The calendar has a ${destination} flight entry${dayLabel ? ` on ${dayLabel}` : ''}, but the mail results did not confirm its departure time. I couldn't verify the flight time.`;
        if (request.upcomingFlightDiscovery)
          return `I found an upcoming flight candidate for ${dayLabel ?? 'an unconfirmed date'}, but its departure time is not confirmed by the booking email I read.${candidateCoverageNote} Connections, hotel, and ground transport remain unverified.${sourceLinks()}`;
        return `I couldn't confirm a departure time for a ${destination} flight ${request.timeWindow?.label ?? 'on the requested date'} from the calendar and mail results I read.`;
      }
      const calendars = new Set<string>();
      const ranges = new Set<string>();
      const unavailable: string[] = [];
      let complete = calendarRows.length > 0;
      for (const row of calendarRows) {
        const result = record(row.result);
        const args = record(row.args);
        if (result?.complete === false) complete = false;
        const timeMin = typeof args?.timeMin === 'string' ? args.timeMin : '';
        const timeMax = typeof args?.timeMax === 'string' ? args.timeMax : '';
        if (timeMin && timeMax) ranges.add(`${timeMin} to ${timeMax}`);
        const searched = result?.calendarsSearched;
        if (Array.isArray(searched)) {
          for (const value of searched) if (typeof value === 'string') calendars.add(value);
        }
        const missing = result?.unavailable;
        if (Array.isArray(missing)) {
          for (const value of missing) {
            const item = record(value);
            const name = item ? stringField(item, 'calendar') : '';
            if (name) unavailable.push(name);
          }
        }
      }
      // The window is already named in the lead-in; echoing its ISO bounds told
      // the owner nothing they asked for. Without a resolved window the raw
      // ranges are all there is to show, so those still print.
      if (!request.timeWindow) {
        for (const range of ranges) lines.push(`- Searched ${range}`);
      }
      const activeEvents = events.filter((event) => stringField(event, 'status') !== 'cancelled');
      const sourceDateEvents = activeEvents.filter(
        (event) => calendarWindowMembership(event, request) === 'source-date-only',
      );
      const agendaEvents = activeEvents.filter(
        (event) => calendarWindowMembership(event, request) === 'confirmed',
      );
      const compactAllDayItems: string[] = [];
      const compactOngoingItems: string[] = [];
      const compactTimedItems: string[] = [];
      if (
        request.timeWindow &&
        request.timeZone &&
        !spansDays(request.timeWindow, request.timeZone)
      )
        lines.push(
          `${shortDate(request.timeWindow.timeMin, request.timeZone)} (${request.timeZone}).`,
        );
      if (agendaEvents.length === 0 && sourceDateEvents.length === 0) {
        lines.push(
          calendarRows.length > 0 && complete
            ? `Nothing on the calendar — no matching events${calendars.size > 0 ? ` across ${[...calendars].join(', ')}` : ''}.`
            : calendarRows.length > 0
              ? 'No matching calendar events were returned in the checked subset; coverage does not establish an empty calendar.'
              : '- Calendar: no successful event read.',
        );
      } else {
        const multiDay = spansDays(request.timeWindow, request.timeZone);
        const manyCalendars =
          new Set(agendaEvents.map((event) => stringField(event, 'calendar')).filter(Boolean))
            .size > 1;
        // Retrieval is already bounded by the read tool. A successful full
        // agenda must not silently become a twenty-event display preview.
        for (const event of agendaEvents) {
          const summary = stringField(event, 'summary') || '(untitled event)';
          const rawStart = stringField(event, 'start');
          const rawEnd = stringField(event, 'end');
          const dateOnly =
            /^\d{4}-\d{2}-\d{2}$/.test(rawStart) && /^\d{4}-\d{2}-\d{2}$/.test(rawEnd);
          const allDay = event.allDay === true || dateOnly;
          const start = calendarTime(rawStart, request.timeZone);
          let end = calendarTime(rawEnd, request.timeZone);
          if (dateOnly) {
            const inclusiveEnd = new Date(`${rawEnd}T12:00:00.000Z`);
            inclusiveEnd.setUTCDate(inclusiveEnd.getUTCDate() - 1);
            const inclusive = inclusiveEnd.toISOString().slice(0, 10);
            end = inclusive === rawStart ? '' : calendarTime(inclusive, request.timeZone);
          }
          const location = stringField(event, 'location');
          const calendar = stringField(event, 'calendar');
          const attendees = event.attendees;
          const attendeeText = Array.isArray(attendees)
            ? attendees.filter((value): value is string => typeof value === 'string').join(', ')
            : '';
          // One link, and the one the owner would actually press: a joining
          // link beats the "open this in Google Calendar" link every time.
          const linkList = Array.isArray(event.links)
            ? event.links
                .map(record)
                .filter((link): link is Record<string, unknown> => Boolean(link))
            : [];
          const safeAgendaLinks = linkList.filter(
            (link) =>
              (stringField(link, 'type') === 'video'
                ? safeVideoMeetingUrl(stringField(link, 'url'))
                : safeCalendarSourceUrl(stringField(link, 'url'))) !== undefined,
          );
          const bestLink =
            safeAgendaLinks.find((link) => stringField(link, 'type') === 'video') ??
            safeAgendaLinks.find((link) => stringField(link, 'type') !== 'calendar') ??
            safeAgendaLinks[0];
          const bestUrl = bestLink ? stringField(bestLink, 'url') : '';
          const safeBestUrl =
            stringField(bestLink ?? {}, 'type') === 'video'
              ? safeVideoMeetingUrl(bestUrl)
              : safeCalendarSourceUrl(bestUrl);
          const eventLinks = safeBestUrl
            ? `[${stringField(bestLink ?? {}, 'label') || 'Event link'}](${safeBestUrl})`
            : '';
          const compactSourceLink =
            linkList.find(
              (link) => safeCalendarSourceUrl(stringField(link, 'url')) !== undefined,
            ) ?? undefined;
          const compactUrl = compactSourceLink ? stringField(compactSourceLink, 'url') : '';
          // Time first, in the shape the agenda answer uses, so the fallback
          // still reads like an answer rather than a dump of record fields.
          const clockStart = clockOnly(rawStart, request.timeZone);
          const clockEnd = clockOnly(rawEnd, request.timeZone);
          const datePrefix = multiDay || dateOnly ? shortDate(rawStart, request.timeZone) : '';
          const spansDates = Boolean(
            rawEnd &&
              eventLocalDay(rawStart, request.timeZone) !== eventLocalDay(rawEnd, request.timeZone),
          );
          const intervalRange = spansDates
            ? `${intervalDateTime(rawStart, request.timeZone)} – ${intervalDateTime(rawEnd, request.timeZone)}`
            : '';
          const briefingAllDay =
            dateOnly && request.includeCalendarBriefing
              ? calendarAllDayWindowLabel(event, request)
              : undefined;
          const continues =
            request.includeCalendarBriefing &&
            request.timeWindow &&
            Date.parse(rawStart) < Date.parse(request.timeWindow.timeMin) &&
            Date.parse(rawEnd) >= Date.parse(request.timeWindow.timeMax);
          const when =
            briefingAllDay ??
            (allDay
              ? [datePrefix, 'All day'].filter(Boolean).join(' · ')
              : continues
                ? `Ongoing through ${shortDate(rawEnd, request.timeZone)} ${clockEnd}`
                : intervalRange ||
                  [datePrefix, clockStart ? `${clockStart}${clockEnd ? `–${clockEnd}` : ''}` : '']
                    .filter(Boolean)
                    .join(' · '));
          // A window ending on a different day than it started is the one case
          // the plain clock cannot express on its own.
          const spanNote =
            allDay && end && end !== start
              ? ` (through ${end})`
              : spansDates && !continues
                ? request.timeWindow &&
                  Date.parse(rawStart) < Date.parse(request.timeWindow.timeMin) &&
                  Date.parse(rawEnd) > Date.parse(request.timeWindow.timeMin)
                  ? ' (continues into the requested period)'
                  : ''
                : '';
          if (request.compactCalendarBriefing) {
            const linkedTitle = compactEventTitleLink(summary, compactUrl);
            const status = compactEventStatus(event);
            const metadata = [calendar, status]
              .filter(Boolean)
              .map((value) => compactEventTitleLink(value, ''))
              .join(' · ');
            const metadataLabel = metadata ? ` (${metadata})` : '';
            if (allDay) {
              compactAllDayItems.push(
                `- ${linkedTitle}${metadataLabel} — ${compactEventTitleLink(compactAllDaySourceDetail(event, request), '')}`,
              );
            } else {
              const eventStart = Date.parse(rawStart);
              const eventEnd = Date.parse(rawEnd);
              const windowStart = request.timeWindow ? Date.parse(request.timeWindow.timeMin) : NaN;
              const ongoing =
                Number.isFinite(eventStart) &&
                Number.isFinite(eventEnd) &&
                Number.isFinite(windowStart) &&
                eventStart < windowStart &&
                eventEnd > windowStart;
              if (ongoing) {
                compactOngoingItems.push(
                  `- ${linkedTitle}${metadataLabel} — **${compactEventSpan(rawStart, rawEnd, request.timeZone ?? 'UTC').replace('–', ' through ')}**`,
                );
              } else {
                const when = spansDates
                  ? compactEventSpan(rawStart, rawEnd, request.timeZone ?? 'UTC')
                  : [
                      datePrefix,
                      clockStart
                        ? `${compactClock(Date.parse(rawStart), request.timeZone ?? 'UTC')}${clockEnd ? `–${compactClock(Date.parse(rawEnd), request.timeZone ?? 'UTC')}` : ''}`
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' ');
                const place = compactLocationForAgenda(location, compactLocationRequested(request));
                const compactPlace = place ? ` — ${compactEventTitleLink(place, '')}` : '';
                compactTimedItems.push(
                  `- **${when || '(time unavailable)'}** — ${linkedTitle}${metadataLabel}${compactPlace}`,
                );
              }
            }
            continue;
          }
          lines.push(
            `- **${when || start || '(no time returned)'}** — ${summary}${spanNote}${dateOnly && request.timeWindow && !briefingAllDay ? ` (${calendarSourceDateLabel(event)})` : ''}${!request.includeCalendarBriefing && location ? ` — ${location}` : ''}${!request.includeCalendarBriefing && attendeeText ? ` — with ${attendeeText}` : ''}${eventLinks ? ` — ${eventLinks}` : ''}${calendar && (manyCalendars || request.includeCalendarBriefing) ? ` (${calendar})` : ''}`,
          );
        }
      }
      if (request.compactCalendarBriefing) {
        if (compactAllDayItems.length > 0) {
          lines.push(
            'All-day records (source date and local intersection):',
            ...compactAllDayItems,
          );
        }
        if (compactOngoingItems.length > 0)
          lines.push('Ongoing context (full interval):', ...compactOngoingItems);
        if (compactTimedItems.length > 0) lines.push('Timed appointments:', ...compactTimedItems);
        if (request.includeCalendarBriefing) {
          const busyStays = agendaEvents.filter(
            (event) => calendarLodgingContext(event, complete) && event.blocksTime === true,
          );
          if (busyStays.length > 0)
            lines.push(
              `${busyStays.length === 1 ? 'A lodging stay' : 'Lodging stays'} marked busy ${busyStays.length === 1 ? 'is' : 'are'} shown as context, not timed appointments.`,
            );
        }
      }
      if (sourceDateEvents.length > 0) {
        lines.push(
          request.compactCalendarBriefing
            ? 'Source-date-only entries (not confirmed for this local day):'
            : 'Source dates only — these entries are not confirmed for the requested local day:',
        );
        for (const event of sourceDateEvents) {
          const links = Array.isArray(event.links) ? event.links.map(record).filter(Boolean) : [];
          const link =
            links.find(
              (item) =>
                item &&
                stringField(item, 'type') === 'calendar' &&
                safeCalendarSourceUrl(stringField(item, 'url')) !== undefined,
            ) ?? undefined;
          const url = link ? (safeCalendarSourceUrl(stringField(link, 'url')) ?? '') : '';
          const summary = stringField(event, 'summary') || '(untitled event)';
          const compactLink = compactEventTitleLink(summary, url);
          const safeSummary = compactEventTitleLink(summary, '');
          const calendar = compactEventTitleLink(stringField(event, 'calendar'), '');
          lines.push(
            request.compactCalendarBriefing
              ? `- ${compactLink}${calendar ? ` (${calendar})` : ''} — ${calendarSourceDateLabel(event) || 'date/time unresolved'}`
              : `- ${safeSummary} — ${calendarSourceDateLabel(event) || 'date/time unresolved'}${calendar ? ` (${calendar})` : ''}${url ? ` — ${compactEventTitleLink('Source event', url)}` : ''}`,
          );
        }
      }
      if (request.includeCalendarBriefing && !request.compactCalendarBriefing) {
        const stays = agendaEvents.filter((event) => calendarLodgingContext(event, complete));
        for (const stay of stays)
          lines.push(
            `Lodging context: **${stringField(stay, 'summary')}** has explicit check-in/check-out details, so its multi-night span is excluded from timed appointment overlaps.${stay.blocksTime === true ? ' The calendar still marks this stay as busy; this does not establish free time.' : ''}`,
          );
      }
      if (request.includeCalendarOverlapSummary) {
        lines.push(...calendarOverlapSummary(agendaEvents, request, complete));
        if (sourceDateEvents.length > 0)
          lines.push('Source-date-only entries could not be compared for local-time overlaps.');
      }
      if (request.includeCalendarBriefing && !request.compactCalendarBriefing) {
        const firstAppointment = agendaEvents.find(
          (event) =>
            event.allDay !== true &&
            !/^\d{4}-\d{2}-\d{2}$/.test(stringField(event, 'start')) &&
            event.blocksTime !== false &&
            verifiedOwnerParticipation(event) !== 'declined' &&
            !calendarLodgingContext(event, complete),
        );
        const next = firstAppointment
          ? `Check whether you need to attend **${stringField(firstAppointment, 'summary')}**, then review its source details for preparation${stringField(firstAppointment, 'location') ? ' and travel' : ''}.`
          : sourceDateEvents.length > 0 || !complete
            ? 'Confirm the unresolved calendar dates or coverage before relying on this briefing.'
            : agendaEvents.length > 0
              ? 'Review the source details of the all-day records and confirm whether they require your attention.'
              : 'Review your priorities for the day before choosing your next task.';
        lines.push(`Next step: ${next}`);
      }
      if (!complete || unavailable.length > 0) {
        lines.push(
          `Heads up: calendar coverage was incomplete${unavailable.length > 0 ? `; unavailable: ${[...new Set(unavailable)].join(', ')}` : ''}.`,
        );
      }
    }
  }

  if (request.kind !== 'calendar') {
    const searches = matchingGmailSearchRows(request, current);
    const results = uniqueRecords(
      searches.flatMap((row) => resultItems(row, 'results')),
      (message) =>
        [
          stringField(message, 'messageId'),
          stringField(message, 'threadId'),
          stringField(message, 'date'),
          stringField(message, 'subject'),
        ].join('|'),
    );
    const threadRows = matchingGmailThreadRows(searches, current);
    const threadMessages = uniqueRecords(
      threadRows.flatMap((row) => resultItems(row, 'messages')),
      (message) =>
        [
          stringField(message, 'messageId'),
          stringField(message, 'date'),
          stringField(message, 'subject'),
          rawStringField(message, 'text').slice(0, 120),
        ].join('|'),
    );
    const queries = new Set(
      searches.map((row) => stringField(record(row.args) ?? {}, 'query')).filter(Boolean),
    );
    const mailboxes = new Set(
      searches
        .map((row) => stringField(record(row.result) ?? {}, 'mailboxSearched'))
        .filter(Boolean),
    );
    const unavailableMessageIds = [
      ...new Set(
        searches.flatMap((row) => {
          const raw = record(row.result)?.unavailable;
          return Array.isArray(raw)
            ? raw.map((item) => stringField(record(item) ?? {}, 'messageId')).filter(Boolean)
            : [];
        }),
      ),
    ];
    const metadataReturned = results.length;
    const discovered = searches.reduce((maximum, row) => {
      const result = record(row.result) ?? {};
      const coverage = record(result.coverage) ?? {};
      const count =
        typeof result.matchingMessagesEstimate === 'number'
          ? result.matchingMessagesEstimate
          : typeof coverage.discovered === 'number'
            ? coverage.discovered
            : 0;
      return Math.max(maximum, count);
    }, metadataReturned + unavailableMessageIds.length);
    const lastSearch = record(searches.at(-1)?.result) ?? {};
    const metadataHasMore = lastSearch.hasMore === true;
    const metadataComplete =
      searches.length > 0 &&
      lastSearch.complete !== false &&
      !metadataHasMore &&
      unavailableMessageIds.length === 0;
    const matchedThreadIds = [
      ...new Set(results.map((row) => stringField(row, 'threadId')).filter(Boolean)),
    ];
    const openedThreadIds = new Set(
      threadRows
        .map((row) => record(row.args)?.threadId)
        .filter((id): id is string => typeof id === 'string'),
    );
    const openedThreads = matchedThreadIds.filter((id) => openedThreadIds.has(id)).length;
    if (results.length === 0) {
      lines.push(
        metadataComplete
          ? 'Nothing in the mail — no matching messages were returned.'
          : searches.length > 0
            ? 'No matching mail was returned in the checked subset; coverage does not establish that no matching message exists.'
            : '- Gmail: no successful search.',
      );
    } else {
      // Sender first, in the rundown shape: who it is from is what decides
      // whether the owner opens it.
      for (const message of results) {
        const subject = stringField(message, 'subject') || '(no subject)';
        const from = stringField(message, 'from');
        const date = stringField(message, 'date');
        const snippet = stringField(message, 'snippet');
        lines.push(
          `- **${from || '(unknown sender)'}** — ${subject}${date ? ` — ${date}` : ''}${snippet ? ` · ${snippet}` : ''}`,
        );
      }
    }
    for (const message of threadMessages) {
      const subject = stringField(message, 'subject') || '(no subject)';
      const from = stringField(message, 'from');
      const rawText = rawStringField(message, 'text');
      const excerpt = emailExcerpt(rawText, request.queryTerms);
      const links = literalLinks(rawText);
      // A thread read hangs off the message it belongs to rather than
      // repeating the whole header as a second top-level row.
      lines.push(
        `  ↳ ${subject}${from ? ` (${from})` : ''}${excerpt ? `: ${excerpt}` : ''}${links.length > 0 ? ` — ${links.join(', ')}` : ''}`,
      );
    }
    if (searches.length > 0) {
      const queryText =
        [...queries].map((query) => `“${query}”`).join(', ') || 'the requested query';
      const scope =
        discovered === metadataReturned + unavailableMessageIds.length
          ? `${discovered} discovered message${discovered === 1 ? '' : 's'}`
          : `about ${discovered} matching messages`;
      lines.push(
        `Mail coverage: searched ${queryText}; ${scope}; metadata returned for ${metadataReturned}; ${unavailableMessageIds.length} unavailable; ${openedThreads} of ${matchedThreadIds.length} matching threads opened${matchedThreadIds.length > openedThreads ? ` (${matchedThreadIds.length - openedThreads} remain unopened)` : ''}${metadataHasMore ? '; more metadata pages remain' : metadataComplete ? '; metadata search complete' : '; metadata coverage is partial'}.`,
      );
      if (!request.requiresThreadRead && threadMessages.length === 0) {
        lines.push(
          'Thread bodies were not opened because the requested sender/subject metadata was sufficient.',
        );
      }
      if (unavailableMessageIds.length > 0) {
        lines.push(`Metadata unavailable for message IDs: ${unavailableMessageIds.join(', ')}.`);
      }
    }
    // The query goes last: it is how the owner knows what to re-ask, not the
    // headline of the answer.
    if (queries.size > 0) {
      lines.push(
        `Searched ${mailboxes.size > 0 ? [...mailboxes].join(', ') : 'the mailbox'} for ${[...queries].map((query) => `“${query}”`).join(', ')}.`,
      );
    }
  }
  return lines.join('\n');
}

function missingReadResponse(labels: string[], evidence: ActionEvidence[]): string {
  const failures = failureDetails(evidence);
  return [
    `That's everything I could actually see. What I couldn't get to: ${labels.join('; ')}. I'd rather tell you that than fill it in from memory.`,
    failures.length > 0 ? `What stopped the lookup: ${failures.join('; ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * A lookup that could not cover its sources: answer with whatever the ledger
 * genuinely holds, then name the gap. Blocked, because the missing half is
 * exactly what the model would otherwise fill in.
 */
function coverageGapResponse(
  request: PersonalReadRequest,
  evidence: ActionEvidence[],
  gaps: { labels: string[]; unsupported: ActionKind[] },
  compoundTripExtraction?: CompoundTripExtraction,
): ResponseContractResult {
  if (request.compoundTripDiscovery) {
    return {
      text: renderCompoundTripReadResponse(
        compoundTripReadProjection(request, evidence, compoundTripExtraction),
      ),
      blocked: true,
      unsupported: gaps.unsupported,
    };
  }
  if (request.upcomingFlightDiscovery) {
    return {
      text: upcomingFlightReadProjection(request, evidence, compoundTripExtraction).text,
      blocked: true,
      unsupported: gaps.unsupported,
    };
  }
  const verified = currentSuccessfulEvidence(evidence).length
    ? `${verifiedReadResponse(request, evidence)}\n\n`
    : '';
  if (request.answerFocus === 'flight') {
    const missing = gaps.unsupported.includes('calendar_read')
      ? gaps.unsupported.includes('inbox_read')
        ? 'the calendar and booking emails'
        : 'the calendar'
      : 'the booking emails';
    return {
      text: `${verified}I couldn't finish checking ${missing}, so the departure time is still unverified.`,
      blocked: true,
      unsupported: gaps.unsupported,
    };
  }
  return {
    text: `${verified}${missingReadResponse(gaps.labels, evidence)}`,
    blocked: true,
    unsupported: gaps.unsupported,
  };
}

function explicitSourceGaps(
  request: PersonalReadRequest,
  evidence: ActionEvidence[],
): ActionKind[] {
  return explicitSourceCoverage(request, evidence)
    .filter((row) => !row.complete)
    .map(
      (row): ActionKind =>
        row.source === 'calendar'
          ? 'calendar_read'
          : row.source === 'mail'
            ? 'inbox_read'
            : 'memory',
    );
}

export function enforcePersonalReadResponse(
  request: PersonalReadRequest,
  evidence: ActionEvidence[],
): ResponseContractResult {
  if (request.billingAuditIssue)
    return {
      text: request.billingAuditIssue,
      blocked: true,
      unsupported: ['inbox_read'],
    };
  if (request.billingAudit) {
    const projection = billingAuditProjection(request, evidence);
    return {
      text: renderBillingAudit({
        scope: request.billingAudit,
        rows: projection.rows,
        coverage: projection.coverage,
        mailbox: projection.mailbox,
      }),
      blocked: !projection.coverage.complete,
      unsupported: projection.coverage.complete ? [] : ['inbox_read'],
    };
  }
  if (request.sourceReads) {
    const result = explicitSourceResponse(request, evidence);
    const unsupported = explicitSourceGaps(request, evidence);
    return { ...result, blocked: unsupported.length > 0, unsupported };
  }
  if (request.personCalendar && !request.temporalIssue) {
    const result = personCalendarResponse(request, evidence);
    return { ...result, unsupported: result.blocked ? ['calendar_read'] : [] };
  }
  const weeklyInterval = request.weeklyCalendarPlan
    ? (request.temporalIntent?.interval ??
      (request.timeWindow
        ? { start: request.timeWindow.timeMin, endExclusive: request.timeWindow.timeMax }
        : undefined))
    : undefined;
  const weeklyAssessment = weeklyInterval
    ? weeklyCalendarPlanResult({
        timeMin: weeklyInterval.start,
        timeMax: weeklyInterval.endExclusive,
        timeZone: request.timeZone,
        evidence: currentSuccessfulEvidence(evidence),
        plan: request.calendarPlanOptions,
      })
    : request.weeklyCalendarPlan
      ? { text: '', coverageComplete: false, slotCount: 0 }
      : undefined;
  if (request.temporalIssue || request.scopeIssue)
    return {
      text: request.temporalIssue ?? request.scopeIssue ?? '',
      blocked: true,
      unsupported: ['calendar_read'],
      ...(weeklyAssessment
        ? { weeklyPlanAssessment: { coverageComplete: false, slotCount: 0 } }
        : {}),
    };
  // A typed flight projection can be blocked by unverified booking identity
  // even when every read completed and its prose has no coverage-gap paragraph.
  // Preserve that status directly instead of deriving completion from text.
  if (request.upcomingFlightDiscovery) {
    const projection = upcomingFlightReadProjection(request, evidence);
    const unsupported: ActionKind[] = [];
    if (!projection.calendarComplete) unsupported.push('calendar_read');
    if (!projection.gmailSearchComplete || !projection.threadsComplete)
      unsupported.push('inbox_read');
    return { text: projection.text, blocked: projection.blocked, unsupported };
  }
  const gaps = requiredReadGaps(request, evidence);
  if (gaps.labels.length > 0) {
    const response = coverageGapResponse(request, evidence, gaps);
    return weeklyAssessment
      ? {
          ...response,
          weeklyPlanAssessment: {
            coverageComplete: false,
            slotCount: weeklyAssessment.slotCount,
          },
        }
      : response;
  }

  return {
    text: verifiedReadResponse(request, evidence),
    blocked: false,
    unsupported: [],
    ...(weeklyAssessment
      ? {
          weeklyPlanAssessment: {
            coverageComplete: weeklyAssessment.coverageComplete,
            slotCount: weeklyAssessment.slotCount,
          },
        }
      : {}),
  };
}

/**
 * A lookup turn resolves in one of three ways, and only the first is a
 * failure: a coverage gap is answered from the ledger and blocked, a draft
 * that cannot be traced to the ledger is quietly answered from it instead,
 * and a draft that checks out is published — then still held to every other
 * rule below, because a truthful agenda can also claim it emailed someone.
 */
function enforcePersonalReadGrounding(
  text: string,
  evidence: ActionEvidence[],
  opts?: ResponseContractOptions,
): ResponseContractResult | undefined {
  const request = opts?.readRequest;
  if (!request) return undefined;
  if (request.billingAuditIssue)
    return {
      text: request.billingAuditIssue,
      blocked: true,
      unsupported: ['inbox_read'],
      groundingFallback: ['billing audit paused until its bounded local-month scope is known'],
    };
  if (request.billingAudit) {
    const projection = billingAuditProjection(request, evidence);
    return {
      text: renderBillingAudit({
        scope: request.billingAudit,
        rows: projection.rows,
        coverage: projection.coverage,
        mailbox: projection.mailbox,
      }),
      blocked: !projection.coverage.complete,
      unsupported: projection.coverage.complete ? [] : ['inbox_read'],
      groundingFallback: [
        'billing classifications rendered from received-date-bounded complete Gmail message receipts',
      ],
    };
  }
  if (request.temporalIssue || request.scopeIssue)
    return {
      text: request.temporalIssue ?? request.scopeIssue ?? '',
      blocked: true,
      unsupported: ['calendar_read'],
    };
  if (request.personCalendar) {
    const result = personCalendarResponse(request, evidence);
    return {
      ...result,
      unsupported: result.blocked ? ['calendar_read'] : [],
      groundingFallback: [
        'named-person calendar scope rendered from current exact-window source evidence',
      ],
    };
  }
  if (request.sourceReads) {
    const result = explicitSourceResponse(request, evidence, opts?.explicitSourceSelection);
    return {
      ...result,
      unsupported: result.blocked
        ? explicitSourceGaps(request, evidence).length
          ? explicitSourceGaps(request, evidence)
          : ['memory']
        : [],
      groundingFallback: [
        'combined private-source answer rendered from exact current-task quotes and explicit source coverage',
      ],
    };
  }
  if (request.familyBirthday) {
    const result = familyBirthdayReadProjection(
      opts?.memoryReadSelection ?? { version: 1, status: 'unavailable', selections: [] },
      evidence,
      opts?.requestText ?? request.memoryQuery ?? '',
    );
    return {
      ...result,
      unsupported: result.blocked ? ['memory'] : [],
      groundingFallback: [
        'family relationships and birthday dates checked against owner source evidence',
      ],
    };
  }
  const gaps = requiredReadGaps(request, evidence, opts?.compoundTripExtraction);
  if (gaps.labels.length > 0) {
    if (request.upcomingFlightDiscovery)
      return {
        text: upcomingFlightReadProjection(request, evidence, opts?.compoundTripExtraction).text,
        blocked: true,
        unsupported: gaps.unsupported,
      };
    return coverageGapResponse(request, evidence, gaps, opts?.compoundTripExtraction);
  }
  if (request.calendarEventAnalysis)
    return {
      text: verifiedReadResponse(request, evidence),
      blocked: false,
      unsupported: [],
      groundingFallback: [
        'calendar counts and gaps rendered directly from the current task ledger',
      ],
    };
  if (request.kind === 'memory' && opts?.memoryReadSelection)
    return {
      text: renderMemoryReadAnswer(opts.memoryReadSelection, evidence, opts.requestText),
      blocked: !validMemoryReadSelection(
        opts.memoryReadSelection,
        currentSuccessfulEvidence(evidence),
        opts.requestText,
      ),
      unsupported: validMemoryReadSelection(
        opts.memoryReadSelection,
        currentSuccessfulEvidence(evidence),
        opts.requestText,
      )
        ? []
        : ['memory'],
      groundingFallback: ['historical answer rendered from exact selected source passages'],
    };
  if (request.upcomingFlightDiscovery) {
    const projection = upcomingFlightReadProjection(
      request,
      evidence,
      opts?.compoundTripExtraction,
    );
    return { text: projection.text, blocked: projection.blocked, unsupported: [] };
  }
  if (request.answerFocus === 'flight')
    return {
      text: verifiedReadResponse(request, evidence, opts?.compoundTripExtraction),
      blocked: false,
      unsupported: [],
    };
  if (request.compoundTripDiscovery)
    return {
      text: verifiedReadResponse(request, evidence, opts?.compoundTripExtraction),
      blocked: false,
      unsupported: [],
    };
  if (request.kind === 'memory' || request.kind === 'knowledge_graph') {
    const rows = matchingPrivateReadRows(request, currentSuccessfulEvidence(evidence));
    const facts = rows.flatMap((row) =>
      resultItems(row, request.kind === 'memory' ? 'memories' : 'relationships'),
    );
    const normalize = (value: string) =>
      value
        .toLowerCase()
        .replace(/[_—→]/g, ' ')
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
    const views = facts.map((fact) => ({
      fact,
      statements:
        request.kind === 'memory'
          ? [stringField(fact, 'content')]
          : [
              stringField(fact, 'evidenceQuote'),
              stringField(fact, 'sourceMemory'),
              [
                stringField(fact, 'subjectLabel'),
                stringField(fact, 'predicate'),
                stringField(fact, 'objectLabel'),
              ].join(' '),
            ],
    }));
    // Compatibility bridge until a versioned ResponsePlan carries fact IDs.
    // Match whole supported statements, never a bag of names from different
    // edges. This deliberately admits narrow source wording and preserves the
    // existing fallback for free-form claims we cannot prove deterministically.
    const units = text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((unit) =>
        normalize(
          unit
            .replace(/^\s*[-*]\s*/, '')
            .replace(/^According to (?:the )?(?:saved memory|source),?\s*/i, ''),
        ),
      )
      .filter(Boolean);
    const qualifiers = new Set([
      'not ownerconfirmed',
      'not owner confirmed',
      'this is unconfirmed',
    ]);
    const substantive = units.filter((unit) => !qualifiers.has(unit));
    const selected = substantive.map((unit) =>
      views.find((view) => view.statements.some((statement) => normalize(statement) === unit)),
    );
    const needsQualifier = selected.some(
      (view) => view && (view.fact.unconfirmed === true || view.fact.ownerConfirmed !== true),
    );
    if (
      substantive.length > 0 &&
      selected.every(Boolean) &&
      request.queryTerms.every((term) => normalize(text).includes(normalize(term))) &&
      (!needsQualifier || units.some((unit) => qualifiers.has(unit)))
    )
      return undefined;
  }
  if (request.kind === 'drive' || request.kind === 'memory' || request.kind === 'knowledge_graph') {
    return {
      text: verifiedReadResponse(request, evidence),
      blocked: false,
      unsupported: [],
      groundingFallback: ['private lookup rendered directly from the current task ledger'],
    };
  }
  const grounding = groundReadDraft(
    text,
    request,
    evidence,
    opts?.groundingCorpus ?? '',
    opts?.liveCorpus ?? '',
  );
  if (!grounding.grounded) {
    return {
      text: verifiedReadResponse(request, evidence),
      blocked: false,
      unsupported: [],
      groundingFallback: grounding.reasons,
    };
  }
  return undefined;
}

/** Replace unsupported action claims with a deterministic, evidence-based reply. */
export function enforceResponseContract(
  text: string,
  evidence: ActionEvidence[],
  opts?: ResponseContractOptions,
): ResponseContractResult {
  text = stripBackgroundNoticeEcho(text);
  if (
    gradeAuditedOutput(text, {
      repetitionRequested: explicitlyRequestsRepetition(opts?.requestText),
    }).some((defect) => defect.kind === 'repetitive-output' || defect.kind === 'malformed-output')
  ) {
    return {
      text: "I couldn't produce a reliable answer just now. Please try again.",
      blocked: true,
      unsupported: [],
      qualityFallback: true,
    };
  }
  const documentVerification = createdDocumentVerification(opts?.requestText ?? '', evidence, text);
  if (documentVerification)
    return {
      text: documentVerification.text,
      blocked: false,
      unsupported: [],
      ...(documentVerification.reason ? { groundingFallback: [documentVerification.reason] } : {}),
    };
  const completedEvent =
    /^(?:the|my)\s+(interview|meeting|appointment|event)\s+(?:(?:has\s+)?already\s+happened|happened\s+already|is\s+over)[.!]?$/i.exec(
      opts?.requestText?.trim() ?? '',
    );
  if (completedEvent && !evidence.some((row) => row.fromCurrentTask !== false)) {
    // This is an owner-supplied correction, not a request to mutate a task.
    // Preserve the useful acknowledgement when the draft invents a status
    // change; a generic action-failure notice would fail to answer the owner.
    return {
      text: `Understood—the ${completedEvent[1]?.toLowerCase()} has already happened.`,
      blocked: false,
      unsupported: [],
    };
  }
  if (
    /\b(?:i(?:['’]ve| have)?\s+marked|marking)\b[^.!?\n]{0,120}\b(?:complete|completed|resolved)\b/i.test(
      text,
    ) &&
    !evidence.some(
      (row) =>
        row.fromCurrentTask !== false &&
        row.status === 'succeeded' &&
        /\.(?:update|complete|resolve)(?:_|$)/.test(row.toolName) &&
        record(row.result)?.ok !== false,
    )
  ) {
    return {
      text: "I understand the update, but I haven't changed the saved completion status. No status update was verified for this request.",
      blocked: true,
      unsupported: ['background'],
    };
  }
  // A saved place preference is not a scheduled arrival reminder. Require a
  // current durable schedule before promising a future alert.
  const requestedWatch = detectFutureWatchIntent(opts?.requestText ?? '');
  const hasReminderReceipt = evidence.some(
    (row) =>
      row.fromCurrentTask !== false &&
      successful(row) &&
      (supports('reminder_create', [row]) ||
        (row.toolName === 'task.schedule' &&
          record(row.result)?.scheduled === true &&
          Boolean(record(row.result)?.taskId))),
  );
  const hasRequestedWatch = requestedWatch
    ? supports('background', evidence, true, opts?.requestText)
    : false;
  if (
    /\b(?:i|we)(?:['’]ll| will)\s+(?:remind|alert|notify|ping)\s+you\b/i.test(text) &&
    !hasReminderReceipt &&
    !hasRequestedWatch
  ) {
    const saved = savedWorkSummary(evidence);
    return {
      text: requestedWatch
        ? withMissingFutureWatchNotice(
            [withoutFutureWatchPromise(text), saved]
              .filter((value, index, rows) => Boolean(value) && rows.indexOf(value) === index)
              .join('\n\n'),
          )
        : `${saved ? `${saved}\n\n` : ''}No reminder has been scheduled for this request, so I cannot promise an automatic alert.`,
      blocked: true,
      unsupported: ['background'],
    };
  }
  const flightCorrection = correctFlightWriteClaims(
    text,
    evidence,
    opts?.requestText ?? '',
    explicitlyRequestsRepetition(opts?.requestText ?? ''),
  );
  text =
    opts?.readRequest?.answerFocus === 'flight' && flightCorrection.flightUpdateReceipt
      ? flightCorrection.flightUpdateReceipt
      : flightCorrection.text;
  const readGrounding = enforcePersonalReadGrounding(text, evidence, opts);
  if (readGrounding) {
    if (opts?.readRequest?.includeCalendarBriefing && opts.companionWeather) {
      // Reuse the same current-task weather projection as the card. Never let
      // mixed prose weaken calendar attendance/identity gates or erase a
      // successful companion answer when the agenda falls back to checked rows.
      const weather = weatherLookupResponseCards(evidence)
        .map((card) => {
          const rows = Array.isArray(card.details) ? card.details.map(record).filter(Boolean) : [];
          const day = rows.find((row) => row && stringField(row, 'label') === 'Day');
          const label = card.current
            ? 'Current weather'
            : `Weather${day ? ` for ${stringField(day, 'value')}` : ''}`;
          const location = stringField(card, 'location');
          const values = [stringField(card, 'temperature'), stringField(card, 'condition')].filter(
            Boolean,
          );
          return values.length
            ? `${label}${location ? ` in ${compactEventTitleLink(location, '')}` : ''}: ${values.map((value) => compactEventTitleLink(value, '')).join(', ')}.`
            : '';
        })
        .filter(Boolean);
      if (weather.length) readGrounding.text = `${readGrounding.text}\n\n${weather.join('\n')}`;
    }
    // A request-scoped successful flight update takes precedence over the
    // earlier read snapshot, including when the model already used its time.
    if (opts?.readRequest?.answerFocus === 'flight' && flightCorrection.flightUpdateReceipt)
      return { ...readGrounding, text: flightCorrection.flightUpdateReceipt, blocked: true };
    // Some private-read paths render directly from the ledger and return early.
    // Run the same narrow flight-write check on that deterministic reply too.
    const correctedRead = correctFlightWriteClaims(
      readGrounding.text,
      evidence,
      opts?.requestText ?? '',
      explicitlyRequestsRepetition(opts?.requestText ?? ''),
    );
    return correctedRead.changed
      ? { ...readGrounding, text: correctedRead.text, blocked: true }
      : readGrounding;
  }
  // A public live lookup need not be a calendar/email PersonalReadRequest.
  // Keep weather and sports claims under the same typed record check before
  // publication, including pure lookups with no private-read context.
  if (opts?.liveCorpus !== undefined && !opts.readRequest) {
    const liveFacts = evidenceClaimFacts(evidence, opts.liveCorpus);
    const liveReasons = liveRelationshipReasons(
      text,
      liveFacts,
      evidence.some((row) => row.toolName === 'weather.lookup' && successful(row)),
    );
    if (liveReasons.length > 0) {
      return {
        text: liveRelationFallback(liveFacts, liveReasons),
        blocked: false,
        unsupported: [],
        groundingFallback: liveReasons,
      };
    }
  }
  const claimed = claimedKinds(text);
  // Short receipts and pronouns still claim the requested effect. Do not let
  // "Done" or "I removed it" hide a false/ambiguous cancellation result.
  const reminderRequest = /\b(?:cancel|remove|delete|stop)\b[^.\n]{0,80}\breminder\b/i.test(
    opts?.requestText ?? '',
  )
    ? 'reminder_cancel'
    : /\bremind me\b|\b(?:create|schedule|set|add)\b[^.\n]{0,80}\breminder\b/i.test(
          opts?.requestText ?? '',
        )
      ? 'reminder_create'
      : undefined;
  if (
    reminderRequest &&
    (/^(?:done|all set|saved|scheduled|cancelled|canceled|removed|deleted)\b/i.test(text.trim()) ||
      firstPersonCompletedAction(
        text,
        reminderRequest === 'reminder_cancel'
          ? 'cancelled|canceled|removed|deleted|stopped'
          : 'created|scheduled|saved|added|set',
      )) &&
    !claimed.includes(reminderRequest)
  ) {
    claimed.push(reminderRequest);
  }
  const memoryRequest = isMemoryWriteRequest(opts?.requestText ?? '');
  if (
    memoryRequest &&
    (/^(?:done|all set|got it|noted|saved|remembered)\b/i.test(text.trim()) ||
      firstPersonCompletedAction(text, 'saved|stored|recorded|noted|remembered') ||
      completedActionClaim(
        text,
        'facts?|birthdays?|dates?|order|preferences?|details?|information|entries',
        'saved|stored|recorded|remembered|updated',
      )) &&
    !claimed.includes('memory')
  ) {
    claimed.push('memory');
  }
  const relationshipFailures = actionRelationshipFailures(text, evidence);
  const unsupported = [
    ...new Set([
      ...claimed.filter(
        (kind) =>
          !supports(
            kind,
            evidence,
            (kind === 'workspace' || kind === 'spreadsheet' || kind === 'presentation') &&
              freshArtifactEditClaim(text, kind),
            opts?.requestText,
          ),
      ),
      ...relationshipFailures,
    ]),
  ];
  if (unsupported.length === 1 && unsupported[0] === 'background' && requestedWatch) {
    return {
      text: withMissingFutureWatchNotice(text),
      blocked: true,
      unsupported,
    };
  }
  if (unsupported.length === 0) {
    if (memoryRequest && claimed.includes('memory')) {
      const saved = savedWorkSummary(evidence);
      if (saved)
        return {
          text: `${saved}\nOnly these confirmed saves are included in this receipt.`,
          blocked: false,
          unsupported: [],
        };
    }
    // The action-claim rules passed, but a fabricated link can still ride along
    // in an otherwise-honest answer. Only meaningful with a corpus (the finalize
    // call site provides one; existing unit callers omit it and skip the rule).
    let published = text;
    if (opts?.urlCorpus !== undefined) {
      const { text: cleaned, strippedUrls } = enforceUrlProvenance(published, opts.urlCorpus);
      if (strippedUrls.length > 0) {
        console.warn('stripped unverifiable url(s) from final answer', {
          strippedUrls,
        });
      }
      published = cleaned;
    }
    // An honest answer can still be malformed. The regression suite has always
    // graded unclosed fences and leaked tags; until now nothing enforced them,
    // so the suite promised a guarantee that did not ship. Same shared checks,
    // same rewrite-not-block bargain as the links above.
    const { text: repairedText, repairs } = repairPresentationDefects(published);
    if (repairs.length > 0) {
      console.warn('repaired presentation defects in final answer', { repairs });
    }
    return { text: repairedText, blocked: flightCorrection.changed, unsupported: [] };
  }
  if (unsupported.includes('approval')) {
    return {
      text: 'No approval request actually exists, so nothing is waiting on the Approvals page. I couldn’t finish this reply. Check Activity for anything that already ran before trying again.',
      blocked: true,
      unsupported,
    };
  }
  if (unsupported.length === 1 && unsupported[0] === 'reminder_cancel') {
    const cancellation = [...evidence]
      .reverse()
      .find((item) => item.fromCurrentTask !== false && item.toolName === 'reminder.cancel');
    const result = cancellation && successful(cancellation) ? record(cancellation.result) : null;
    const matches = Array.isArray(result?.matches)
      ? result.matches
          .flatMap((match) => {
            const label = record(match)?.text;
            return typeof label === 'string' && label.trim()
              ? [label.replace(/\s+/g, ' ').trim().slice(0, 160)]
              : [];
          })
          .slice(0, 5)
      : [];
    return {
      text:
        result?.cancelled === false && result.reason === 'ambiguous'
          ? `More than one reminder matches, so I have not removed any.${matches.length ? `\n${matches.map((label) => `- ${label}`).join('\n')}` : ''}\nWhich reminder should I remove?`
          : result?.cancelled === false && result.reason === 'not_found'
            ? 'I could not find an active reminder matching that request, so I have not removed one. Tell me the reminder name or check Reminders.'
            : 'I have not confirmed that the reminder was removed. Check Reminders or ask me to retry.',
      blocked: true,
      unsupported,
    };
  }
  if (unsupported.length === 1 && unsupported[0] === 'reminder_create') {
    return {
      text: 'I have not confirmed a scheduled reminder for this request. Ask me to retry with the reminder and time you want.',
      blocked: true,
      unsupported,
    };
  }
  if (unsupported.length === 1 && unsupported[0] === 'memory') {
    const currentSaves = evidence.filter(
      (item) =>
        item.fromCurrentTask !== false && ['memory.save', 'occasions.save'].includes(item.toolName),
    );
    const forgotten = currentSaves.some((item) => record(item.result)?.tombstoned === true);
    const quarantined = currentSaves.some((item) => record(item.result)?.quarantined === true);
    return {
      text: forgotten
        ? 'This information was previously forgotten, so I did not restore it to memory.'
        : quarantined
          ? 'The information was recorded for review, but is not available as trusted memory yet.'
          : "I haven't confirmed a save for this request. An earlier message saying I would remember it is not a save receipt. If the information wasn't included, send the exact details; otherwise ask me to retry saving the information you supplied.",
      blocked: true,
      unsupported,
    };
  }
  // The confirm-list is scoped to what THIS turn claimed (in-scope only), so an
  // unrelated turn never reprints the whole conversation's ledger of artifacts.
  const claimedSet = new Set(claimed);
  return {
    text:
      partialFailureResponse(evidence, unsupported, claimedSet) ??
      transparentFailureResponse(evidence),
    blocked: true,
    unsupported,
  };
}
