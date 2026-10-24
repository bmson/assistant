/** Deterministic phone routing only; names and model/contact mappings never grant authority. */
export type OwnerPhoneRecipientRequest =
  | { kind: 'explicit_number'; recipientE164: string }
  | { kind: 'owner_self' };

type SupportedPhoneRequest = { recipient: OwnerPhoneRecipientRequest | null; reviewOnly: boolean };

/** Deliberately small grammar. Quoted/code authority is rejected. */
function action(
  text: string,
): { verb: string; remainder: string; reviewOnlyPrefix: boolean } | null {
  if (typeof text !== 'string' || text.length > 16_384) return null;
  if (
    /["“”`]/.test(text) ||
    /^[ \t]*>/m.test(text) ||
    /(?:^|[\s([{,:;])['‘]|['’](?=$|[\s)\]},.!?:;])/.test(text) ||
    /(?:forwarded|original) message|\bon .+ wrote:/i.test(text)
  )
    return null;
  const normalized = text.trim().replace(/’/g, "'");
  if (/[\r\n]/.test(normalized)) return null;
  const direct =
    /^(?:please[ \t]+)?(?:(?:can|could|would)[ \t]+you[ \t]+(?:please[ \t]+)?)?(call|phone|dial)[ \t]+([\s\S]+)$/i.exec(
      normalized,
    );
  const wanted =
    /^(?:I want|I need|I'd like|I would like) you to[ \t]+(call|phone|dial)[ \t]+([\s\S]+)$/i.exec(
      normalized,
    );
  const ahead = /^go ahead and[ \t]+(call|phone|dial)[ \t]+([\s\S]+)$/i.exec(normalized);
  const ordered =
    /^(?:please[ \t]+)?(?:(?:can|could|would)[ \t]+you[ \t]+(?:please[ \t]+)?)?(?:search|look(?:[ \t]+it)?[ \t]+up|browse|research|investigate|check|find|read|review|summari[sz]e|analy[sz]e)\b([^.!?;\n]{1,180}?)[ \t]*,?[ \t]+then[ \t]+(?:please[ \t]+)?(call|phone|dial)[ \t]+([\s\S]+)$/i.exec(
      normalized,
    );
  const match = direct ?? wanted ?? ahead;
  const verb = match?.[1] ?? ordered?.[2];
  const raw = match?.[2] ?? ordered?.[3];
  if (!verb || !raw) return null;
  // Conditional/reported action prefixes do not fit the grammar; conditions in
  // ordered preparation also cannot turn into immediate telephone authority.
  if (ordered && /\b(?:if|when|unless|once|until|after|before|not|never)\b/i.test(ordered[1]!))
    return null;
  const remainder = raw
    .replace(/^[ \t]+|[ \t]+$/g, '')
    .replace(/[.!?]$/, '')
    .replace(/^[ \t]+|[ \t]+$/g, '');
  // Account for the complete remainder, including topic/script text. Alternatives,
  // route overrides, conditions and withdrawals are deliberately not inferred.
  if (
    !remainder ||
    /\b(?:or|but|instead|rather|otherwise|alternatively|except|unless|if|when|once|until|actually|not|don't|never|cancel|skip|stop|no)\b/i.test(
      remainder,
    )
  )
    return null;
  if (/\b(?:use|using|via|reach|contact|route)\b[^.!?;\n]{0,100}\+[1-9]\d{6,14}\b/i.test(remainder))
    return null;
  return { verb: verb.toLowerCase(), remainder, reviewOnlyPrefix: !match && Boolean(ordered) };
}

/** Every byte after the recipient must fit an explicit supported tail. */
function supportedTail(raw: string): 'automatic' | 'review' | null {
  if (/[\r\n]/.test(raw)) return null;
  if (/\b(?:call|phone|dial|calling|phoning|dialing)\b/i.test(raw)) return null;
  // Automatic authority is a complete, explicit modifier-only grammar. It never
  // treats semantic topic/script content as an automatic request.
  if (/^(?:[ \t]*,?[ \t]*(?:back|now|please|today|tomorrow|tonight)\b)*[ \t]*$/i.test(raw))
    return 'automatic';
  let tail = raw.replace(/^[ \t]+|[ \t]+$/g, '');
  if (tail.startsWith(',')) tail = tail.slice(1).replace(/^[ \t]+/, '');
  tail = tail
    .replace(/^(?:(?:back|now|please|today|tomorrow|tonight)\b[ \t,]*)+/i, '')
    .replace(/^[ \t]+|[ \t]+$/g, '');
  const data =
    /^(?:about|regarding|for|with|to[ \t]+(?:ask|discuss|confirm|check|book|reserve|tell|find)|and[ \t]+(?:say|tell|read))[ \t]+(\S[\s\S]*)$/i.exec(
      tail,
    )?.[1];
  return data &&
    data.length <= 2000 &&
    !/[.?!;,\r\n]/.test(data) &&
    !/\b(?:and|or|but|nor|yet|so|then|also)\b|[&|]/i.test(data)
    ? 'review'
    : null;
}

function request(text: string): SupportedPhoneRequest | null {
  const parsed = action(text);
  if (!parsed) return null;
  const { remainder, verb } = parsed;
  const route = (
    recipient: OwnerPhoneRecipientRequest,
    tail: string,
  ): SupportedPhoneRequest | null => {
    const kind = supportedTail(tail);
    return kind === 'automatic' && !parsed.reviewOnlyPrefix
      ? { recipient, reviewOnly: false }
      : kind
        ? { recipient: null, reviewOnly: true }
        : null;
  };
  const literal = /^(\+[1-9]\d{6,14})(?=$|[ \t,])([\s\S]*)$/.exec(remainder);
  if (literal) return route({ kind: 'explicit_number', recipientE164: literal[1]! }, literal[2]!);
  const self = /^(me|my phone number|my phone|my number)(?=$|[ \t,])([\s\S]*)$/i.exec(remainder);
  if (self) {
    if (verb === 'dial') return null;
    const tail = self[2]!;
    const routed =
      /^[ \t,]+(?:(?:back|now|please|today|tomorrow|tonight)[ \t,]+)*(?:at|on)[ \t]+(\+[1-9]\d{6,14})(?=$|[ \t,])([\s\S]*)$/i.exec(
        tail,
      );
    if (routed) return route({ kind: 'explicit_number', recipientE164: routed[1]! }, routed[2]!);
    const selfRoute = route({ kind: 'owner_self' }, tail);
    if (selfRoute) return selfRoute;
    const ambiguousRoute =
      /^[ \t,]+(?:(?:back|now|please)[ \t,]+)*(?:at|on)[ \t]+(?:my|the)[ \t]+(?:other[ \t]+)?(?:phone[ \t]+)?number([\s\S]*)$/i.exec(
        tail,
      );
    return ambiguousRoute && supportedTail(ambiguousRoute[1]!)
      ? { recipient: null, reviewOnly: true }
      : null;
  }
  if (
    /^(?:it|this|that|back|attention|things|everything|something|nothing)\b/i.test(remainder) ||
    /\b(?:api|function|method|endpoint|callback|constructor|procedure|tool|command|script)\b/i.test(
      remainder,
    )
  )
    return null;
  // Ambiguous names/recipient descriptions can only create ordinary review.
  // No capitalization heuristic grants phone_call or saved-policy authority.
  for (let words = 1; words <= 4; words += 1) {
    const named = new RegExp(
      String.raw`^([\p{L}\p{M}][\p{L}\p{M}'’-]*(?:[ \t]+[\p{L}\p{M}][\p{L}\p{M}'’-]*){${words - 1}})(?=$|[ \t,])([\s\S]*)$`,
      'u',
    ).exec(remainder);
    if (named && supportedTail(named[2]!)) return { recipient: null, reviewOnly: true };
  }
  return null;
}

export function ownerPhoneRecipientRequest(text: string): OwnerPhoneRecipientRequest | null {
  return request(text)?.recipient ?? null;
}
export function ownerRequestedPhoneCall(text: string): boolean {
  return ownerPhoneRecipientRequest(text) !== null;
}
/** Names and supported semantic instructions require exact ordinary review, never saved allow. */
export function ownerPhoneProposalNeedsApproval(text: string): boolean {
  return request(text)?.reviewOnly === true;
}
