/** Shared, dependency-free boundary for work scoped to this conversation. */
export function stripNegativePrivateWriteConstraints(text: string): string {
  return (
    text
      // Remove only retention operands inside a negative clause, including a
      // chained "or save memory". Keep subsequent affirmative reads intact.
      .replace(/\b(?:do not|don't|don’t|never|avoid)\b[^.!?;\n]*/giu, (clause) => {
        const [negative, ...affirmative] = clause.split(
          /(?=\b(?:but|however|instead|then)\s+(?:read|search|check|use|consult|retrieve)\b)/iu,
        );
        return [
          negative?.replace(
            /\b(?:save|store|write|update|add|retain|record)\s+(?:to\s+)?(?:my\s+)?memor(?:y|ies)\b/giu,
            '',
          ),
          ...affirmative,
        ].join('');
      })
      .replace(
        /\b(?:no|zero|without)\b[^.!?;,\n]*?\b(?:memories?|calendar|calendars|email|gmail|documents?|docs|drive)\s+(?:writes?|updates?|changes?|creates?|sends?)\b/giu,
        '',
      )
      .replace(
        /\b(?:no|zero|without)\b[^.!?;,\n]*?\b(?:writes?|writing|updates?|updating|changes?|changing|creates?|creating|sends?|sending)\b[^.!?;,\n]*?\b(?:memories?|calendar|calendars|email|gmail|documents?|docs|drive)\b/giu,
        '',
      )
  );
}

export function isConversationLocalContext(text: string): boolean {
  const withoutNegativeReadConstraints = text.replace(
    /\b(?:do not|don't|don’t|never|without|avoid)\s+(?:search|read|look(?:\s+up)?|check|consult|use|retrieve|review|open|pull\s+up)\b[^.!?;,\n]*\b(?:memories?|history|past chats|old messages|older messages|previous conversations|old conversations|calendar|schedule|agenda|email|mail|inbox|messages?|threads?|drive)\b/giu,
    '',
  );
  const explicitHistoricalRead =
    /\b(?:use|using|read|reading|search|searching|retrieve|retrieving|recall|recalling|consult|consulting|look back)\b[^.!?\n]{0,90}\b(?:saved memories|saved memory|earlier conversations|previous conversations|past conversations|old messages)\b/i.test(
      withoutNegativeReadConstraints,
    ) ||
    /\b(?:earlier|previous|prior|past)\s+(?:(?:hypothetical|fictional)\s+)?(?:[\p{L}\p{N}_-]+\s+){0,3}(?:exercise|scenario|discussion)\b/iu.test(
      withoutNegativeReadConstraints,
    ) ||
    /\bwhat\s+(?:did|have)\s+i\s+(?:tell|say|mention)\s+you\b|\bwhat\s+did\s+i\s+say\s+about\b/i.test(
      withoutNegativeReadConstraints,
    );
  const explicitPrivateRead =
    /\b(?:check|read|search|look(?:\s+up)?|consult|use|retrieve|recall|show|review|open|pull\s+up)\b[^.!?\n]{0,100}\b(?:my|our)\s+(?:calendar|schedule|agenda|email|mail|inbox|messages?|threads?|drive|memories|memory)\b/i.test(
      withoutNegativeReadConstraints,
    ) ||
    /\b(?:my|our)\s+(?:real|actual|personal|saved|previous|earlier|past)\s+(?:calendar|schedule|agenda|email|mail|inbox|messages?|threads?|drive|memories|memory)\b/i.test(
      withoutNegativeReadConstraints,
    );
  if (explicitHistoricalRead || explicitPrivateRead) return false;
  return (
    /\b(?:hypothetical|fictional)\b[^.!?\n]{0,80}\b(?:exercise|scenario|example|project|schedule|planning|plan|morning|afternoon|day|week|test)\b|\b(?:exercise|scenario)\s+only\b/i.test(
      text,
    ) ||
    /\b(?:using|use|from|based on)\b[^.!?\n]{0,100}\b(?:just gave you|this conversation|this chat|the details above)\b/i.test(
      text,
    )
  );
}

/** A complete numeric calculation needs no historical conversation context. */
export function isSelfContainedCalculationRequest(text: string): boolean {
  const number = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
  const operation = String.raw`(?:[+\-−×x*/÷]|plus|minus|times|multiplied\s+by|divided\s+by)`;
  const expression = new RegExp(
    String.raw`^(?:(?:what\s+is|calculate|compute|solve)\s+)?${number}\s*${operation}\s*${number}(?:\s*[.!?])?(?:\s+(?:and\s+)?(?:give|show|return|state|provide)\s+(?:me\s+)?(?:the\s+)?(?:result|answer)\b[^.!?\n]{0,100}[.!?]?)?$`,
    'i',
  );
  return expression.test(text.trim());
}
