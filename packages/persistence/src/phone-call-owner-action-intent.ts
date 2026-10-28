import type { OwnerPhoneRecipientRequest } from './phone-call-owner-intent.js';

const E164 = /^\+[1-9]\d{6,14}$/;

export interface OwnerCallActionIntent {
  action: 'phone.call';
  recipientRequest: OwnerPhoneRecipientRequest;
}

const EXCLUDED =
  /\b(?:if|when|unless|once|until|after|before|or|but|nor|yet|so|then|also|except|instead|rather|otherwise|alternatively|actually|don't|do not|never|cancel|withdraw|stop|skip|forget|disregard|no longer|changed my mind|not|no|maybe|perhaps|later)\b/i;
const AMBIGUOUS_TAIL =
  /\b(?:and|or|but|nor|yet|so|then|also|except|if|when|unless|once|until|after|before|instead|rather|otherwise|alternatively|actually|don't|do not|never|cancel|withdraw|stop|skip|forget|disregard|no longer|changed my mind|not|no|maybe|perhaps|later|call|phone|dial|calling|phoning|dialing)\b/i;
const WITHDRAWN_CALL_ACTION =
  /\b(?:i changed my mind|(?:forget|disregard) (?:that|it|the call|my request)|do not call|don't call|no call is needed|no longer (?:want|need) (?:you to )?(?:call|phone|dial)?|(?:cancel|stop|skip) (?:the|that|my) (?:phone call|call|request))\b/i;
const AMBIGUOUS_CALL_ACTION =
  /\b(?:or|but|instead|rather|otherwise|alternatively|if|when|unless|once|until|maybe|perhaps|later|actually)\b/i;

function supportedTopicTail(value: string): boolean {
  let tail = value.trim().replace(/^[,\s]+|[,\s]+$/g, '');
  tail = tail.replace(/^(?:(?:back|now|please|today|tomorrow|tonight)\b[,\s]*)+/i, '');
  if (!tail) return true;
  if (
    tail.length > 2_000 ||
    EXCLUDED.test(tail) ||
    AMBIGUOUS_TAIL.test(tail) ||
    /[\r\n;,.!?"“”'‘’`<>]/u.test(tail)
  )
    return false;
  const data =
    /^(?:about|regarding|for|with|to\s+(?:ask|discuss|confirm|check|book|reserve|tell|find))\s+(\S[\s\S]*)$/i.exec(
      tail,
    )?.[1];
  return Boolean(data && !/\b(?:and|or|but|nor|yet|so|then|also)\b|[&|]/i.test(data));
}

/** Parse a complete direct owner call action and its literal/self destination. */
export function parsePhoneCallOwnerActionIntent(text: string): OwnerCallActionIntent | null {
  if (
    typeof text !== 'string' ||
    text.length > 16_384 ||
    /[\r\n\u2028\u2029]/u.test(text) ||
    /["“”‘’`]/u.test(text) ||
    /(?:^|[\s([{,:;])['‘]|['’](?=$|[\s)\]},.!?:;])/u.test(text) ||
    /^[ \t]*>/m.test(text) ||
    /(?:forwarded|original) message|\bon .+ wrote:/i.test(text)
  )
    return null;

  let normalized = text.trim().replace(/’/g, "'");
  normalized = normalized.replace(/[.!?]$/u, '').trim();
  if (!normalized || EXCLUDED.test(normalized)) return null;

  const direct =
    /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:call|phone|dial)\s+([\s\S]+)$/i.exec(
      normalized,
    );
  const wanted =
    /^(?:I want|I need|I'd like|I would like) you to\s+(?:call|phone|dial)\s+([\s\S]+)$/i.exec(
      normalized,
    );
  const ahead = /^go ahead and\s+(?:call|phone|dial)\s+([\s\S]+)$/i.exec(normalized);
  const raw = direct?.[1] ?? wanted?.[1] ?? ahead?.[1];
  if (!raw || EXCLUDED.test(raw) || AMBIGUOUS_TAIL.test(raw)) return null;

  const literal = /^(\+[1-9]\d{6,14})(?=$|[\s,])([\s\S]*)$/u.exec(raw.trim());
  if (literal && E164.test(literal[1]!) && supportedTopicTail(literal[2]!))
    return {
      action: 'phone.call',
      recipientRequest: { kind: 'explicit_number', recipientE164: literal[1]! },
    };

  const self = /^(me|my phone number|my phone|my number)(?=$|[\s,])([\s\S]*)$/iu.exec(raw.trim());
  if (!self) return null;
  const tail = self[2]!;
  const explicit =
    /^[\s,]+(?:(?:back|now|please|today|tomorrow|tonight)[\s,]+)*(?:at|on)\s+(\+[1-9]\d{6,14})(?=$|[\s,])([\s\S]*)$/iu.exec(
      tail,
    );
  if (explicit) {
    if (!E164.test(explicit[1]!) || !supportedTopicTail(explicit[2]!)) return null;
    return {
      action: 'phone.call',
      recipientRequest: { kind: 'explicit_number', recipientE164: explicit[1]! },
    };
  }
  if (!supportedTopicTail(tail)) return null;
  return { action: 'phone.call', recipientRequest: { kind: 'owner_self' } };
}

/**
 * Detect a directly addressed, routed call request whose remainder retracts or
 * makes the action ambiguous. These messages must not fall through to an older
 * broad allow rule merely because the strict v2 parser rejected the remainder.
 */
export function hasAmbiguousOrWithdrawnPhoneCallOwnerAction(text: string): boolean {
  if (typeof text !== 'string' || text.length > 16_384) return false;
  // A strict parse proves the whole current message fits the supported action
  // grammar. Its comma separators are harmless, so punctuation alone cannot
  // cancel a valid direct request.
  if (parsePhoneCallOwnerActionIntent(text)) return false;
  const normalized = text
    .trim()
    .replace(/[.!?]$/u, '')
    .trim();
  const direct =
    /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:call|phone|dial)\s+([\s\S]+)$/i.exec(
      normalized,
    );
  const wanted =
    /^(?:I want|I need|I'd like|I would like) you to\s+(?:call|phone|dial)\s+([\s\S]+)$/i.exec(
      normalized,
    );
  const ahead = /^go ahead and\s+(?:call|phone|dial)\s+([\s\S]+)$/i.exec(normalized);
  const raw = direct?.[1] ?? wanted?.[1] ?? ahead?.[1];
  if (!raw) return false;
  const target =
    /^(\+[1-9]\d{6,14}|me|my phone number|my phone|my number)(?=$|[\s,])(?:[\s\S]*)$/i.exec(
      raw.trim(),
    );
  if (!target) return false;
  const remainder = raw.trim().slice(target[1]!.length);
  return (
    WITHDRAWN_CALL_ACTION.test(remainder) ||
    AMBIGUOUS_CALL_ACTION.test(remainder) ||
    /[;!?"“”'‘’`<>]/u.test(remainder) ||
    /\.\s*(?:actually|instead|rather|otherwise|alternatively|but|or)\b/i.test(remainder)
  );
}
