import { isRepairFeedback } from '@assistant/core/workflow/self-repair';
/**
 * Deterministic pre-gate for the chat action/conversation triage.
 *
 * The dashboard chat route classifies each turn as an action (→ run through the
 * executor with tools/approvals) or plain conversation (→ stream a tool-less
 * reply). That classification runs on the cheapest `classify` model, which
 * occasionally reads a terse imperative like "add lunch Friday noon" as
 * conversation — sending it to the tool-less path where the model can only
 * role-play the action (the exact silent no-op the triage exists to prevent).
 *
 * The costs are asymmetric: a false "conversation" verdict drops the action
 * entirely, while a false "action" verdict merely costs a slower-but-correct
 * answer via the executor. So we force the action path whenever a message
 * clearly reads as a request to DO or CHECK something, and let the model decide
 * only the genuinely ambiguous rest.
 */

import { detectLiveLookups } from '@assistant/core/workflow/live-lookup';
import {
  detectPersonalReadRequest,
  type ReadIntentMessage,
} from '@assistant/core/workflow/read-intent';
import { isMemoryWriteRequest, isSaveStatusQuestion } from '@assistant/core/workflow/saved-work';

// Leading imperative verbs that are unambiguous actions in an assistant chat.
const LEADING_ACTION =
  /^(add|schedule|book|remind|send|email|e-?mail|text|dm|invite|rsvp|order|buy|purchase|pay|cancel|reschedule|postpone|draft|forward|unsubscribe|subscribe)\b/;

// Object-requiring phrasings whose verbs are too idiom-prone to gate on alone
// ("check this out", "look, ...", "find that funny" must NOT trip these).
const ACTION_PHRASE =
  /(remind me\b|(?:on|to) (?:my|the) calendar|to (?:my|the) (?:to-?do|todo|task|shopping|grocery) list|set (?:a|an|up) (?:reminder|meeting|event|alarm|timer|call|appointment)|(?:book|schedule|set up) (?:a|an|me|us|my)\b|send (?:a|an|the|him|her|them)\b|look up\b|search for\b|check (?:my|the) (?:calendar|inbox|e-?mail|mail|schedule|messages|texts|dms)\b|move (?:my|the) [\w\s]*?(?:meeting|call|appointment|event)|find (?:me |us )?(?:a|an|the)\b)/;

// Surfaces the assistant can actually open with tools.
const READ_TARGET =
  '(?:calendars?|schedule|agenda|inbox|e-?mails?|mail|messages|texts|dms|appointments|events|meetings|reminders|to-?dos?|tasks?)';

// Read phrasings: "look at my calendar", "show me my inbox", "what's on my
// calendar", "go through my email", "tell me my schedule". Verbs are anchored
// to a possessive + target so "check this out" / "look, ..." stay untouched.
// Present-tense only on purpose: "looked at" (a recap) does not match.
const READ_PHRASE = new RegExp(
  [
    String.raw`\b(?:check|look (?:at|in|into|through|over)|go (?:through|over)|review|scan|open|search|pull up|bring up|show(?: me| us)?|see)\s+(?:my|the|our)\s+${READ_TARGET}\b`,
    // "read" is spelled the same in past tense, so "I read the email you
    // drafted" (a recap) must not trip; require a possessive object.
    String.raw`\bread\s+(?:my|our)\s+${READ_TARGET}\b`,
    String.raw`\bwhat(?:'|’)?s (?:on|in) (?:my|the|our) ${READ_TARGET}\b`,
    String.raw`\bwhat (?:do|does) (?:i|we) have (?:on|in|scheduled|coming up|planned)\b`,
    String.raw`\btell me (?:what(?:'|’)?s on |about )?(?:my|the|our) (?:[\w-]+ )?(?:schedule|calendar|agenda|appointments|flights|day|week)\b`,
    String.raw`\b(?:anything|what(?:'|’)?s) (?:new|urgent|important)? ?in (?:my|the) (?:inbox|e-?mail|mail)\b`,
  ].join('|'),
);

// Mail and replies ARRIVE; they are not "checked". These phrasings name no
// possessive surface and often no mail word at all ("anything from the
// landlord?"), so READ_PHRASE cannot see them and detectPersonalReadRequest —
// which needs a mail/calendar surface word — declines too. The cheap classifier
// has been left to call them, and calling one "conversation" drops the request
// onto the tool-less path, where the model can only guess at what arrived.
const RECEIPT_PHRASE =
  /\b(?:any|anything|something|nothing)\s+(?:new\s+|yet\s+)?from\s+\w|\b(?:hear|heard)\s+(?:back\s+)?from\b|\bget(?:ting)?\s+back\s+to\s+me\b|\b(?:has|have|did)\s+[\w.'’-]+\s+(?:e-?mailed?|written|replied|responded|got(?:ten)?\s+back|sent)\b|\b(?:has|have|did)\s+(?:the|my|our|any)\s+[\w\s'’-]{0,30}?(?:arrived?|come\s+in|came\s+in|shown?\s+up|landed)\b/i;

// Leading politeness/filler to peel off before looking for an imperative verb.
const LEADING_FILLER =
  /^(hey|hi|hello|yo|ok|okay|so|also|and|then|now|please|pls|kindly|just|quick|quickly|could you|can you|would you|will you|can u|would u|i need (?:you )?to|i'?d like (?:you )?to|i want (?:you )?to|i'?d like|let'?s|lets|go ahead and)\b[\s,:-]*/;

// A failed-action follow-up often has no imperative at all: "I'm not seeing
// the change" means "check/fix the update you just promised." The cheap
// classifier used to treat that as feedback and send it to the no-tools path.
const FAILED_ACTION_FOLLOW_UP =
  /\b(?:i(?:'m| am) not seeing (?:the |any )?(?:change|changes|update|updates)|i (?:do not|don't) see (?:the |any )?(?:change|changes|update|updates)|(?:it|that|this|they|those|these) (?:wasn't|was not|weren't|were not|isn't|is not|aren't|are not|hasn't|has not|haven't|have not) (?:actually )?(?:updated|changed|added|sent|created|saved|scheduled|booked|fixed|applied|submitted)|(?:it|that|this|they|those|these) (?:didn't|did not) (?:actually )?(?:update|change|send|save|work)|nothing (?:changed|happened|was updated|was added|was sent|was created|was saved)|still (?:missing|unchanged|not updated|not changed|not there)|did you (?:actually )?(?:update|change|add|send|create|save|schedule|book|fix|apply|submit))\b/;

// The ambient block carries one thing about the sky: conditions right now, at
// the owner's current location. A forecast for another day or another place is
// a lookup, and on the tool-less path the model can only invent one or
// apologise for having no data — both of which it has done in production.
const WEATHER_SUBJECT = /\b(?:weather|forecast|temperature|rain|raining|snow|snowing)\b/;

// Anything but right-here-right-now: a named day, a later part of today, or a
// stretch of the week.
const WEATHER_ELSEWHEN =
  /\b(?:tomorrow|tonight|later|this (?:evening|afternoon|morning|week|weekend)|next (?:week|weekend)|the weekend|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/;

// A place the ambient location line cannot be: "in San Francisco", "for Tokyo".
// Matched against the original text — the capital is the signal.
const WEATHER_ELSEWHERE = /\b(?:in|at|for|near|around)\s+(?:the\s+)?[A-Z][A-Za-z]/;

// Questions and explicit checks route; casual weather comments remain
// conversation. Imperatives need no question mark or named place.
const QUESTION_OPENER =
  /^(?:how|what|when|where|will|is|are|any|do|does|should|can|could|gonna|going to)\b/;

function looksLikeWeatherLookup(text: string, stripped: string): boolean {
  if (!WEATHER_SUBJECT.test(stripped)) return false;
  if (/^(?:check|look up|find out|show me|tell me)\b/.test(stripped)) return true;
  if (!text.includes('?') && !QUESTION_OPENER.test(stripped)) return false;
  return WEATHER_ELSEWHEN.test(stripped) || WEATHER_ELSEWHERE.test(text);
}

const PRIOR_ACTION_COMMITMENT =
  /\b(?:update|change|edit|replace|fix|format|add|send|create|save|schedule|book|apply|submit|upload|share|delete|cancel)(?:d|s|ing)?\b/;

const ACCEPT_ACTION_OFFER =
  /^(?:yes(?:[, ]+(?:please|go ahead|do it))?|please do|go ahead|do it|continue|keep going)[.!]*$/i;
const ACTION_OFFER =
  /\b(?:would you like me to|shall i|should i|i can|i will|i['’]ll|let me)\s+(?:(?:also|now|first)\s+)?(?:check|search|look up|read|find|verify|add|send|create|save|schedule|book|apply|submit|update|cancel|remind)\b/i;

export function looksLikeActionRequest(
  text: string,
  priorAssistantText = '',
  recentHistory: ReadonlyArray<ReadIntentMessage> = [],
): boolean {
  let t = text.trim().toLowerCase();
  if (!t) return false;
  if (isRepairFeedback(text)) return true;
  if (
    detectLiveLookups([
      ...recentHistory.slice(-8),
      ...(priorAssistantText ? [{ role: 'assistant', content: priorAssistantText }] : []),
      { role: 'user', content: text },
    ]).length > 0
  )
    return true;
  if (/^(?:approved?|i approve(?: the budget increase)?)[.!]*$/i.test(t)) return true;
  if (isMemoryWriteRequest(text) || isSaveStatusQuestion(text)) return true;
  // Routing is not approval: the executor still enforces exact tool arguments
  // and the normal policy gate. A bare yes with no concrete offer stays with
  // the classifier rather than inheriting some old action in the thread.
  if (ACCEPT_ACTION_OFFER.test(t) && ACTION_OFFER.test(priorAssistantText)) return true;
  let prev = '';
  while (t !== prev) {
    prev = t;
    t = t.replace(LEADING_FILLER, '');
  }
  if (
    detectPersonalReadRequest([
      ...recentHistory.slice(-8),
      ...(priorAssistantText ? [{ role: 'assistant', content: priorAssistantText }] : []),
      { role: 'user', content: text },
    ])
  ) {
    return true;
  }
  return (
    LEADING_ACTION.test(t) ||
    ACTION_PHRASE.test(t) ||
    READ_PHRASE.test(t) ||
    RECEIPT_PHRASE.test(t) ||
    looksLikeWeatherLookup(text, t) ||
    (FAILED_ACTION_FOLLOW_UP.test(t) &&
      PRIOR_ACTION_COMMITMENT.test(priorAssistantText.toLowerCase()))
  );
}
