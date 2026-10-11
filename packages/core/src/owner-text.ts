/**
 * Formatting for text the owner reads.
 *
 * These live in persistence — the one package that depends on nothing — because
 * every producer of owner-facing prose needs them: the briefing and the pulse in
 * core, the SMS and push channels in modules. Before this module each of those
 * formatted its own dates and cut its own strings, which is how a single digest
 * came to render half its events in the owner's timezone and half in UTC, and
 * how sentences reached the owner ending mid-word.
 *
 * Nothing here touches a database or a provider. It is pure text.
 */

/** A single glyph, so a truncation mark costs one character on a metered channel. */
const ELLIPSIS = '…';

/**
 * Flatten external text so it cannot break the structure it is spliced into.
 *
 * Calendar locations, mail subjects and model-written sentences all arrive with
 * newlines in them — a Google Calendar location is routinely "Venue\nStreet,
 * City". Interpolated into a markdown bullet, that newline ends the list item
 * and the address renders as its own top-level paragraph, detached from the
 * event it belongs to. Collapsing on the way in keeps a bullet a bullet.
 */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * Shorten to `max` characters on a word boundary, marking that text was cut.
 *
 * A hard `slice` ends a sentence mid-word with no terminator, which reads as a
 * bug rather than as a summary and hides that anything was dropped at all. Falls
 * back to a hard cut only when a single word is itself longer than the budget.
 */
export function truncateAtBoundary(value: string, max: number): string {
  if (max <= 0) return '';
  const text = collapseWhitespace(value);
  if (text.length <= max) return text;
  const budget = max - ELLIPSIS.length;
  if (budget <= 0) return ELLIPSIS.slice(0, max);
  // One character past the budget, so a space landing exactly on the boundary
  // is still found and the whole preceding word is kept.
  const head = text.slice(0, budget + 1);
  const lastSpace = head.lastIndexOf(' ');
  const cut = lastSpace > 0 ? head.slice(0, lastSpace) : text.slice(0, budget);
  return `${cut.replace(/[\s,;:.–—-]+$/u, '')}${ELLIPSIS}`;
}

function parseInstant(value: string): Date | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** The calendar day an instant falls on in `timeZone`, as `YYYY-MM-DD`. */
function zonedDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * The day after `day`, computed on the date string rather than by adding 24
 * hours to an instant — a DST transition makes a local day 23 or 25 hours long,
 * and "tomorrow" must not depend on which.
 */
function dayAfter(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) return day;
  const next = new Date(Date.UTC(year, month - 1, date));
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** Clock time in the owner's zone, e.g. `6:30 PM`. */
export function ownerTime(value: string, timeZone: string): string {
  const date = parseInstant(value);
  if (!date) return value;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/**
 * The day in the owner's zone, relative where that is what a person would say.
 * `Today`, `Tomorrow`, otherwise `Tue, Sep 15`.
 */
export function ownerDate(value: string, timeZone: string, now: Date = new Date()): string {
  const date = parseInstant(value);
  if (!date) return value;
  const day = zonedDay(date, timeZone);
  const today = zonedDay(now, timeZone);
  if (day === today) return 'Today';
  if (day === dayAfter(today)) return 'Tomorrow';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/** Day and clock time together, e.g. `Tomorrow 6:30 PM` or `Tue, Sep 15 6:30 PM`. */
export function ownerDateTime(value: string, timeZone: string, now: Date = new Date()): string {
  const date = parseInstant(value);
  if (!date) return value;
  return `${ownerDate(value, timeZone, now)} ${ownerTime(value, timeZone)}`;
}

export interface OwnerEventTime {
  /** RFC3339 instant, or `YYYY-MM-DD` for an all-day event. */
  start: string;
  end?: string;
  allDay?: boolean;
}

/**
 * One event's "when", in the owner's zone.
 *
 * An all-day event carries a bare date that `new Date` reads as midnight UTC, so
 * it is rendered from the date parts directly rather than shifted into a zone
 * that could move it onto the previous day.
 */
export function ownerEventWhen(
  event: OwnerEventTime,
  timeZone: string,
  now: Date = new Date(),
): string {
  if (event.allDay) {
    const day = event.start.slice(0, 10);
    const label = ownerDate(`${day}T12:00:00Z`, timeZone, now);
    return `${label} (all day)`;
  }
  const start = parseInstant(event.start);
  if (!start) return event.start;
  if (!event.end) return ownerDateTime(event.start, timeZone, now);
  const end = parseInstant(event.end);
  if (!end) return ownerDateTime(event.start, timeZone, now);
  // Same local day is the common case; repeating the date on both sides of the
  // dash is noise the owner has to read past.
  if (zonedDay(start, timeZone) === zonedDay(end, timeZone)) {
    return `${ownerDate(event.start, timeZone, now)} ${ownerTime(event.start, timeZone)} – ${ownerTime(event.end, timeZone)}`;
  }
  return `${ownerDateTime(event.start, timeZone, now)} → ${ownerDateTime(event.end, timeZone, now)}`;
}

/**
 * A short, human line for an approval card in the chat.
 *
 * The stored approval summary is written for review, not for conversation: a
 * call carries its whole brief ("… · May agree to: … · Never: … · May share: …")
 * and a fetch carries a raw URL. Showing that in the transcript turns a
 * one-line question — "Okay to call you?" — into a page of fine print. The full
 * text stays on the approval row and on the Approvals page, where the owner goes
 * to check what exactly they are agreeing to; this is the line the chat shows.
 */
export function approvalHeadline(summary: string, max = 110): string {
  const text = collapseWhitespace(summary.replace(/\*\*|`/gu, ''));
  // Everything after the first " · " is guardrails and fine print.
  const lead = (text.split(' · ')[0] ?? text).trim();

  const call = /^Call (.+?) for up to (\d+) min\b/iu.exec(lead);
  if (call) {
    const who = (call[1] ?? '').replace(/\s*\(\+?[\d\s().-]{7,}\)\s*$/u, '').trim();
    const minutes = Number(call[2]);
    return `Call ${who} for up to ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }

  const page = /^(?:Fetch the public web page|Open)\s+[“"]?(https?:\/\/[^\s”"]+)[”"]?$/iu.exec(
    lead,
  );
  if (page)
    return `Open ${truncateAtBoundary((page[1] ?? '').replace(/^https?:\/\/(?:www\.)?/iu, ''), 80)}`;

  return sentenceCase(truncateAtBoundary(lead || text, max));
}

/**
 * What the owner reads in place of an approval card when only text can be shown.
 * One thing is a question; several are a short list. No codes, no instructions
 * about where to click — the card carries the buttons.
 */
export function approvalPrompt(headlines: readonly string[]): string {
  const lines = headlines.map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return 'I need your okay on something.';
  if (lines.length === 1) return `${lines[0]} — okay to go ahead?`;
  return `A few things need your okay:\n${lines.map((line) => `- ${line}`).join('\n')}`;
}

export type FailureCause = 'provider' | 'billing' | 'internal';

/**
 * Sort a raw error into something worth telling a person. The owner does not
 * need `AI_RetryError: Failed after 3 attempts` or a provider's JSON body; they
 * need to know whether it is worth trying again, and whether it is theirs to fix.
 */
export function classifyFailure(error: unknown): FailureCause {
  // ModelRouter wraps a failed configured fallback so both attempts remain
  // available for diagnostics. Classify the original provider rejection for
  // notice presentation without exposing either raw error to the owner.
  let classifiedError = error;
  const seen = new Set<Error>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      !(classifiedError instanceof Error) ||
      classifiedError.name !== 'ModelCallFallbackAttemptError' ||
      !('fallbackAttempted' in classifiedError) ||
      classifiedError.fallbackAttempted !== true
    )
      break;
    const cause = (classifiedError as Error & { cause?: unknown }).cause;
    if (!(cause instanceof Error) || cause === classifiedError || seen.has(cause)) break;
    seen.add(classifiedError);
    classifiedError = cause;
  }
  const text = String(classifiedError).toLowerCase();
  if (/payment method|credit|billing|quota|insufficient|exhausted/u.test(text)) return 'billing';
  if (
    /rate.?limit|overload|temporar|timed? ?out|timeout|(?:code|status|http)\W{0,3}5\d\d|bad gateway|upstream|not available|ai_(?:apicall|retry)|api_?call|provider|unavailable/u.test(
      text,
    )
  )
    return 'provider';
  return 'internal';
}

/**
 * The one line a person gets when work they asked for could not be finished.
 * First person, no error text, no page names — the raw error stays on the task,
 * where Activity shows it to anyone who wants it.
 */
export function failureNotice(error: unknown): string {
  switch (classifyFailure(error)) {
    case 'provider':
      return "I couldn't finish that — one of my AI providers is having trouble right now. Want me to try again in a bit?";
    case 'billing':
      return "I couldn't finish that — one of my AI providers needs attention on the billing side. It's logged in Activity.";
    default:
      return "I couldn't finish that — I hit a snag on my side. It's in Activity if you want me to retry.";
  }
}

/**
 * A task's name as a person would say it, or nothing. Task titles for scheduled
 * work are the first 80 characters of the instruction the model was given —
 * "Prepare the owner's morning brief. Check: (1) today's events on your calen…" —
 * which reads as a leaked prompt the moment it is quoted back.
 */
export function ownerTaskLabel(title: string | null | undefined): string {
  const text = collapseWhitespace(title ?? '');
  if (!text || text.endsWith('…') || text.length > 60) return '';
  if (/\b(?:the owner|owner's|check:|\(\d\))/iu.test(text)) return '';
  return `“${text}”`;
}

/**
 * Where something is, the way a person would say it in passing: the venue, not
 * the postal address. A calendar location is usually "Venue\nStreet, City, ZIP,
 * Country"; "starts in 30 minutes at Crocker Amazon 1669 Geneva Avenue, San
 * Francisco, CA 94134" reads like a form, and the full address is on the card.
 */
export function shortPlace(location: string): string {
  const lines = location
    .split(/[\r\n]+/u)
    .map(collapseWhitespace)
    .filter(Boolean);
  const first = lines[0] ?? '';
  if (!first) return '';
  // Several lines: the first is the venue. One line: everything before the
  // first comma ("Laugavegur 12, Reykjavik" -> "Laugavegur 12").
  const lead = lines.length > 1 ? first : (first.split(',')[0]?.trim() ?? first);
  return truncateAtBoundary(lead, 60);
}

/** Start a sentence with a capital without touching the rest of it. */
export function sentenceCase(text: string): string {
  return text.replace(/^\p{Ll}/u, (letter) => letter.toLocaleUpperCase());
}

/**
 * Is this the sort of task the owner would recognise? Scheduled automations are
 * titled with the opening words of the instruction they were given, and the
 * assistant's own maintenance jobs carry their internal names. Neither belongs
 * in a list the owner reads — when one of them stalls, that is the assistant's
 * housekeeping and the Activity page's business, not something to act on.
 */
export function isOwnerFacingTask(title: string | null | undefined): boolean {
  const text = collapseWhitespace(title ?? '');
  if (/^self[- .](?:repair|improve|maintain)/iu.test(text)) return false;
  return ownerTaskLabel(text) !== '';
}

/**
 * A sender as a person would name them. A display name wins. A bare address
 * falls back to the part that means something: the tag after a `+` and any
 * machine-generated token are dropped, and a do-not-reply mailbox is named for
 * its domain ("donotreply+701544cc-…@parentsquare.com" is just "Parentsquare").
 */
export function readableSender(name: string | null | undefined, email: string): string {
  const display = collapseWhitespace(name ?? '');
  if (display) return display;
  const address = collapseWhitespace(email);
  const [rawLocal = '', domain = ''] = address.split('@');
  const local = rawLocal.split('+')[0] ?? rawLocal;
  const brand = domain.split('.').slice(-2, -1)[0] ?? '';
  const automated =
    /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer|info|hello|team|support)$/iu.test(
      local,
    );
  if ((automated || !local) && brand) return brand.charAt(0).toLocaleUpperCase() + brand.slice(1);
  return local || address;
}

/**
 * The question the owner is asked when work cannot start without them. The
 * planner lists what is missing; this words it the way a person would text it —
 * one question as a question, several as a short list — instead of
 * "Before I proceed, I need to know: A; B; C", which reads as a form being
 * rejected.
 */
export function clarifyingQuestion(missing: readonly string[]): string {
  const items = missing.map((item) => collapseWhitespace(item)).filter(Boolean);
  const ask = (item: string) => sentenceCase(item);
  if (items.length === 0)
    return 'I need a bit more detail before I can do this — what exactly would you like me to do?';
  if (items.length === 1) {
    const only = ask(items[0] ?? '');
    return only.endsWith('?') ? `Quick question: ${only}` : `I need one thing from you: ${only}`;
  }
  return `A few quick questions:\n${items.map((item) => `- ${ask(item)}`).join('\n')}`;
}
