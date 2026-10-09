import type { ModelMessage } from 'ai';
import { sanitizeAuditUrls, scrubAuditCredentials } from '../audit-redaction.js';

/**
 * Turning a model call into a reviewable record.
 *
 * The cost ledger (`model_calls`) proves a call happened and what it spent; it
 * keeps neither the prompt nor the answer. That makes every question about
 * answer quality unanswerable from production data — which is how a bad week
 * goes unnoticed until someone reads a transcript by hand. `model_call_audit`
 * is the other half, and this module is the part that decides what is safe to
 * put in it.
 *
 * Everything here is pure. The redaction is deliberately conservative and
 * pattern-based: it removes the identifiers that make a leaked row harmful
 * (who, which account, which booking) while keeping the structure, the
 * reasoning and the evidence shape that make the row worth reviewing at all.
 * It is not a promise of anonymity — free text can always name a person — and
 * `full` capture makes no attempt at one. It is the difference between a table
 * that costs an owner their address book and one that costs them a paragraph.
 */

/** How much of any single field is kept. Long enough to review, short enough to store. */
export const AUDIT_FIELD_CAP = 16_000;

export type AuditCaptureMode = 'off' | 'redacted' | 'full';

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
/**
 * A phone-shaped run: optional country prefix then digits, allowing the spaces,
 * dashes and parens people actually write them with. Bounded on both sides so
 * it cannot start mid-number. Whether a match really is a phone number is
 * decided by digit count in the replacer below, not by this shape alone.
 */
const PHONE = /(?<![\w.])\+?\d[\d\s().-]{5,18}\d(?![\w.])/g;
/** Booking references, account numbers, card numbers — anything that long identifies something. */
const LONG_DIGITS = /(?<![\w.])\d{9,}(?![\w.])/g;
/**
 * Digits needed before a separated run is treated as a phone number rather than
 * a date. `2026-09-07` carries eight; the shortest national numbers people
 * actually write carry nine or more once a country or area code is present, and
 * anything with an explicit `+` is a phone whatever its length.
 */
const PHONE_MIN_DIGITS = 9;

/**
 * Scrub the identifiers from one string.
 *
 * Order matters: emails first, so a local part containing digits is gone before
 * the digit rules see it; then URLs, so a path is reduced before its numeric
 * segments are; then unbroken long runs, so a card number is labelled as the
 * identifier it is rather than as a phone; then the separated phone shapes that
 * remain.
 */
export function redactAuditText(text: string): string {
  return sanitizeAuditUrls(String(scrubAuditCredentials(text)), true)
    .replace(EMAIL, '[email]')
    .replace(LONG_DIGITS, '[number]')
    .replace(PHONE, (match) => {
      // Without this, `2026-09-07` reads as a phone number and the dates that
      // make a record worth reviewing are the first thing redaction destroys.
      // Count digits only — the separators are not the signal.
      const digits = match.replace(/\D/g, '').length;
      const explicitCountryCode = match.trimStart().startsWith('+');
      return explicitCountryCode || digits >= PHONE_MIN_DIGITS ? '[phone]' : match;
    });
}

/** Apply the capture mode and the length cap to one optional field. */
export function captureField(
  text: string | undefined,
  mode: Exclude<AuditCaptureMode, 'off'>,
): { text: string | undefined; truncated: boolean } {
  if (text === undefined) return { text: undefined, truncated: false };
  const scrubbed =
    mode === 'redacted' ? redactAuditText(text) : String(scrubAuditCredentials(text));
  if (scrubbed.length <= AUDIT_FIELD_CAP) return { text: scrubbed, truncated: false };
  return { text: scrubbed.slice(0, AUDIT_FIELD_CAP), truncated: true };
}

/**
 * Render the message window as reviewable text.
 *
 * The stored form is for a human (or a grader) reading back what the model saw,
 * not for replay, so it flattens multi-part content to its text parts and names
 * the non-text ones rather than trying to serialize them.
 */
export function flattenMessages(messages: ModelMessage[] | undefined): string | undefined {
  if (!messages?.length) return undefined;
  return messages
    .map((message) => {
      const { role, content } = message;
      if (typeof content === 'string') return `${role}: ${content}`;
      if (!Array.isArray(content)) return `${role}: [${typeof content}]`;
      const rendered = content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object' && 'type' in part) {
            const typed = part as { type: string; text?: string; toolName?: string };
            if (typed.type === 'text' && typeof typed.text === 'string') return typed.text;
            if (typed.toolName) return `[${typed.type}: ${typed.toolName}]`;
            return `[${typed.type}]`;
          }
          return '[part]';
        })
        .join('\n');
      return `${role}: ${rendered}`;
    })
    .join('\n\n');
}

/** The input half of a call, however the caller chose to express it. */
export function captureInput(opts: {
  prompt?: string;
  messages?: ModelMessage[];
}): string | undefined {
  return opts.prompt ?? flattenMessages(opts.messages);
}
