import { stripBackgroundNoticeEcho } from '../chat-card.js';
import {
  explicitlyRequestsRepetition,
  gradeAuditedOutput,
  repairPresentationDefects,
} from '../model-router/audit-graders.js';
import { correctFlightWriteClaims } from './flight-write-contract.js';
import { gmailThreadIdsToRead, type PersonalReadRequest } from './read-intent.js';
import { isDurableSave, isMemoryWriteRequest, savedWorkSummary } from './saved-work.js';

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
}

interface ResponseContractOptions {
  requestText?: string;
  urlCorpus?: string;
  /** Deterministically detected from the latest owner turn. */
  readRequest?: PersonalReadRequest | null;
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
const BACKGROUND_OBJECTS = 'mission|task|watcher|monitoring|tracker';

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
  const terseObjectStatus = new RegExp(String.raw`\b${object}\b\s*(?::|-|—)?\s*${status}\b`, 'i');

  return (
    actionBeforeObject.test(text) ||
    firstPersonAction.test(text) ||
    objectStatus.test(text) ||
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

function successful(evidence: ActionEvidence): boolean {
  if (evidence.status !== 'succeeded') return false;
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

function supports(kind: ActionKind, evidence: ActionEvidence[], currentTaskOnly = false): boolean {
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
      return usable.some((item) => {
        const result = record(item.result);
        return (
          item.toolName === 'reminder.create' &&
          result?.created !== false &&
          typeof result?.reminderId === 'string' &&
          result.reminderId.trim().length > 0
        );
      });
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
      return names.some(
        (name) =>
          name === 'mission.update' ||
          name === 'task.schedule' ||
          name === 'applications.watch_confirmation',
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
      text,
      OUTBOUND_OBJECTS,
      'sent|delivered|contacted|emailed|texted|messaged|called|replied|forwarded|reached out to|notified|pinged',
      // "confirmed" is not a send. It is what booking and travel mail says about
      // itself ("your reservation is confirmed"), and the action verbs above
      // already cover every way an outbound message actually completes.
      'sent|delivered|contacted|emailed|texted|messaged|called|replied|forwarded|reached out to|notified|pinged',
    ) ||
    firstPersonCompletedAction(
      text,
      'sent|delivered|contacted|emailed|texted|messaged|called|replied|forwarded|reached out to|notified|pinged',
    ) ||
    passiveOutbound.test(text)
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
  return evidence
    .filter((item) => item.fromCurrentTask !== false && !successful(item))
    .slice(-2)
    .map(
      (item) => `${item.toolName}: ${item.error || 'the tool did not return a successful result'}`,
    );
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
    name === 'applications.watch_confirmation'
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
      if (described) descriptions.add(`${described}${when}`);
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

interface NormalizedUrl {
  normalized: string;
  noQuery: string;
  host: string;
  idSegments: string[];
}

function normalizeUrl(raw: string): NormalizedUrl | null {
  const cleaned = raw.replace(/[.,;:!?'")\]]+$/, '');
  try {
    const u = new URL(cleaned);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.replace(/\/+$/, '');
    const base = `${u.protocol}//${host}${path}`.toLowerCase();
    return {
      normalized: `${base}${u.search}`.toLowerCase(),
      noQuery: base,
      host,
      // Lowercased to match the lowercased corpus. Google ids are technically
      // case-sensitive, but rewrite-not-block tolerates that tiny leniency.
      idSegments: path
        .split('/')
        .filter((s) => s.length >= 16)
        .map((s) => s.toLowerCase()),
    };
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
 * owner/tool turns) contains it (with or without its query string). Google
 * doc/drive/calendar/mail links the model reconstructs from an id are allowed
 * only when that id is itself in the corpus; a Google Maps link the model
 * composes from an address is always allowed.
 */
export function enforceUrlProvenance(
  text: string,
  corpus: string,
): { text: string; strippedUrls: string[] } {
  const haystack = corpus.toLowerCase();
  const stripped: string[] = [];
  const isEvidenced = (raw: string): boolean => {
    const n = normalizeUrl(raw);
    if (!n) return true; // unparseable — leave it rather than mangle the text
    if (haystack.includes(n.normalized) || haystack.includes(n.noQuery)) return true;
    if (n.host === 'www.google.com' && n.noQuery.includes('/maps')) return true;
    if (CONSTRUCTIBLE_GOOGLE_HOSTS.has(n.host)) {
      // A bare app link (no id) is harmless; an id-bearing link must cite an
      // id the evidence actually produced.
      return n.idSegments.length === 0 || n.idSegments.every((seg) => haystack.includes(seg));
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
      resultItems(row, 'messages').length > 0
    );
  });
}

function matchingPrivateReadRows(
  request: PersonalReadRequest,
  current: ActionEvidence[],
): ActionEvidence[] {
  return current.filter((row) => {
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
): { labels: string[]; unsupported: ActionKind[] } {
  const current = currentSuccessfulEvidence(evidence);
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
  const expectedThreadIds = gmailThreadIdsToRead(gmailSearches);
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
  if (request.kind !== 'calendar' && gmailSearches.length === 0) {
    labels.push('a successful Gmail search using the requested terms');
    unsupported.push('inbox_read');
  } else if (request.requiresThreadRead && gmailHits.length > 0 && missingThreadIds.length > 0) {
    labels.push(
      `successful reads of ${missingThreadIds.length} matching Gmail ${missingThreadIds.length === 1 ? 'thread' : 'threads'}`,
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

function calendarTime(value: string, timeZone?: string): string {
  if (!value) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T12:00:00.000Z`);
    return new Intl.DateTimeFormat('en-US', {
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
    return new Intl.DateTimeFormat('en-US', {
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
    return new Intl.DateTimeFormat('en-GB', {
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
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: isDateOnly ? 'UTC' : (timeZone ?? 'UTC'),
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(new Date(ms));
  } catch {
    return '';
  }
}

/** Does the searched window cover more than one local day? */
function spansDays(window: PersonalReadRequest['timeWindow']): boolean {
  if (!window) return true;
  const from = Date.parse(window.timeMin);
  const to = Date.parse(window.timeMax);
  return !Number.isFinite(from) || !Number.isFinite(to) || to - from > 26 * 60 * 60 * 1000;
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
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
  } catch {
    timeZone = 'UTC';
  }
  const clock = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
  const zonedTime = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const zoneAt = (ms: number) =>
    Number.isFinite(ms)
      ? zonedTime.formatToParts(new Date(ms)).find((part) => part.type === 'timeZoneName')?.value
      : undefined;
  const dateTime = new Intl.DateTimeFormat('en-US', {
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
      new Intl.DateTimeFormat('en-CA', {
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
  const messages = [
    ...searches.flatMap((row) => resultItems(row, 'results')),
    ...matchingGmailThreadRows(searches, current).flatMap((row) => resultItems(row, 'messages')),
  ];

  const reasons: string[] = [];

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
  const prose = draft
    .replace(MARKDOWN_LINK_RE, ' ')
    .replace(BARE_URL_RE, ' ')
    .replace(/[*_`#]/g, ' ');
  const draftWords = groundingWords(prose);
  const draftText = draftWords.join(' ');

  // Every event the calendar returned has to survive into the answer. Matching
  // is deliberately loose — a shortened title is good writing, not a drop.
  if (events.length > MAX_AGENDA_EVENTS) {
    reasons.push(`${events.length} events is past the agenda shape`);
  } else {
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
): string {
  const current = currentSuccessfulEvidence(evidence);
  if (request.kind === 'drive') {
    const rows = matchingPrivateReadRows(request, current);
    const files = uniqueRecords(
      rows.flatMap((row) => resultItems(row, 'files')),
      (file) =>
        stringField(file, 'fileId') || stringField(file, 'url') || stringField(file, 'name'),
    );
    const query = stringField(record(rows[0]?.args) ?? {}, 'query');
    if (files.length === 0) {
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
    const memories = uniqueRecords(
      matchingPrivateReadRows(request, current).flatMap((row) => resultItems(row, 'memories')),
      (memory) => stringField(memory, 'id') || stringField(memory, 'content'),
    );
    if (memories.length === 0) return 'I found no supported saved memories for that.';
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
    const relations = uniqueRecords(
      matchingPrivateReadRows(request, current).flatMap((row) => resultItems(row, 'relationships')),
      (relation) => stringField(relation, 'id'),
    );
    if (relations.length === 0) {
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
    request.verification
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
      if (events.length === 0) {
        lines.push(
          calendarRows.length > 0
            ? `Nothing on the calendar — no matching events${calendars.size > 0 ? ` across ${[...calendars].join(', ')}` : ''}.`
            : '- Calendar: no successful event read.',
        );
      } else {
        const multiDay = spansDays(request.timeWindow);
        const manyCalendars =
          new Set(events.map((event) => stringField(event, 'calendar')).filter(Boolean)).size > 1;
        for (const event of events.slice(0, 20)) {
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
          const bestLink =
            linkList.find((link) => stringField(link, 'type') === 'video') ??
            linkList.find((link) => stringField(link, 'type') !== 'calendar') ??
            linkList[0];
          const bestUrl = bestLink ? stringField(bestLink, 'url') : '';
          const eventLinks = bestUrl
            ? `[${stringField(bestLink ?? {}, 'label') || 'Event link'}](${bestUrl})`
            : '';
          // Time first, in the shape the agenda answer uses, so the fallback
          // still reads like an answer rather than a dump of record fields.
          const clockStart = clockOnly(rawStart, request.timeZone);
          const clockEnd = clockOnly(rawEnd, request.timeZone);
          const datePrefix = multiDay ? shortDate(rawStart, request.timeZone) : '';
          const when = allDay
            ? [datePrefix, 'All day'].filter(Boolean).join(' · ')
            : [datePrefix, clockStart ? `${clockStart}${clockEnd ? `–${clockEnd}` : ''}` : '']
                .filter(Boolean)
                .join(' · ');
          // A window ending on a different day than it started is the one case
          // the plain clock cannot express on its own.
          const spanNote = allDay && end && end !== start ? ` (through ${end})` : '';
          lines.push(
            `- **${when || start || '(no time returned)'}** — ${summary}${spanNote}${location ? ` — ${location}` : ''}${attendeeText ? ` — with ${attendeeText}` : ''}${eventLinks ? ` — ${eventLinks}` : ''}${calendar && manyCalendars ? ` (${calendar})` : ''}`,
          );
        }
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
    if (results.length === 0) {
      lines.push(
        searches.length > 0
          ? 'Nothing in the mail — no matching messages were returned.'
          : '- Gmail: no successful search.',
      );
    } else {
      // Sender first, in the rundown shape: who it is from is what decides
      // whether the owner opens it.
      for (const message of results.slice(0, 10)) {
        const subject = stringField(message, 'subject') || '(no subject)';
        const from = stringField(message, 'from');
        const date = stringField(message, 'date');
        const snippet = stringField(message, 'snippet');
        lines.push(
          `- **${from || '(unknown sender)'}** — ${subject}${date ? ` — ${date}` : ''}${snippet ? ` · ${snippet}` : ''}`,
        );
      }
    }
    for (const message of threadMessages.slice(0, 10)) {
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
    if (searches.some((row) => record(row.result)?.complete === false)) {
      lines.push('Heads up: there were more matches than this lookup opened.');
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
): ResponseContractResult {
  const verified = currentSuccessfulEvidence(evidence).length
    ? `${verifiedReadResponse(request, evidence)}\n\n`
    : '';
  return {
    text: `${verified}${missingReadResponse(gaps.labels, evidence)}`,
    blocked: true,
    unsupported: gaps.unsupported,
  };
}

export function enforcePersonalReadResponse(
  request: PersonalReadRequest,
  evidence: ActionEvidence[],
): ResponseContractResult {
  const gaps = requiredReadGaps(request, evidence);
  if (gaps.labels.length > 0) return coverageGapResponse(request, evidence, gaps);

  return {
    text: verifiedReadResponse(request, evidence),
    blocked: false,
    unsupported: [],
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
  const gaps = requiredReadGaps(request, evidence);
  if (gaps.labels.length > 0) return coverageGapResponse(request, evidence, gaps);
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
  if (
    /\b(?:i|we)(?:['’]ll| will)\s+(?:remind|alert|notify|ping)\s+you\b/i.test(text) &&
    !evidence.some(
      (row) =>
        row.fromCurrentTask !== false &&
        successful(row) &&
        (supports('reminder_create', [row]) ||
          (row.toolName === 'task.schedule' &&
            record(row.result)?.scheduled === true &&
            Boolean(record(row.result)?.taskId))),
    )
  ) {
    const saved = savedWorkSummary(evidence);
    return {
      text: `${saved ? `${saved}\n\n` : ''}No reminder has been scheduled for this request, so I cannot promise an automatic alert.`,
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
  text = flightCorrection.text;
  const readGrounding = enforcePersonalReadGrounding(text, evidence, opts);
  if (readGrounding) {
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
  const unsupported = claimed.filter(
    (kind) =>
      !supports(
        kind,
        evidence,
        (kind === 'workspace' || kind === 'spreadsheet' || kind === 'presentation') &&
          freshArtifactEditClaim(text, kind),
      ),
  );
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
