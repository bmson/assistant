/** An owner can require an answer from supplied text without granting any tool use. */
export function explicitlyDisallowsTools(text: string): boolean {
  const authored = text.replace(/[“"][^“”"]*[”"]/g, '').replace(/’/g, "'");
  const simulationOnly =
    /^\s*(?:please\s+)?simulate\s+only\b/i.test(authored) ||
    (/^\s*(?:please\s+)?simulate\b/i.test(authored) &&
      /\b(?:fictional|hypothetical)\b/i.test(authored) &&
      /\b(?:do not|don't|no|without)\b[^.!?\n]{0,120}\b(?:real\s+(?:tasks?|actions?)|read\s+accounts|send\s+anything)\b/i.test(
        authored,
      ));
  if (simulationOnly) return true;
  return /\b(?:do not|don't|never)\s+(?:use|call|invoke|run|access)\s+(?:(?:any|external|real|live)\s+)?tools\b|\bwithout\s+(?:(?:using|calling|invoking|running|accessing)\s+)?(?:(?:any|external|real|live)\s+)?tools\b|\bno\s+(?:(?:external|real|live)\s+)?(?:tools\b|tool\s+(?:calls|use)\b)/i.test(
    authored,
  );
}

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
  if (explicitlyDisallowsTools(text)) return true;
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
  const hypotheticalWithoutLookup =
    /\b(?:hypothetical|hypothetically|fictional)\b/i.test(text) &&
    /\b(?:do not|don't|don’t)\s+look\s+anything\s+up\b|\bno\s+research(?:\s+needed|\s+or\s+actions)?\b/i.test(
      text,
    );
  const suppliedScenarioOnly =
    /\b(?:use|using)\s+only\s+(?:this|the(?:\s+supplied)?)\s+(?:scenario|facts|example)\b/i.test(
      text,
    );
  const hypotheticalWithoutInventedFacts =
    /\b(?:fictional|hypothetical)\b/i.test(text) &&
    /\b(?:do not|don't|don’t)\s+(?:assume|invent|add|infer)\b[^.!?\n]{0,120}\b(?:facts|details|information)\b/i.test(
      text,
    );
  return (
    hypotheticalWithoutLookup ||
    suppliedScenarioOnly ||
    hypotheticalWithoutInventedFacts ||
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
  if (
    /\b(?:earlier|previous|prior|past|last\s+(?:time|chat|conversation|answer|response)|history|memories?|conversation|chat|context|before|as\s+(?:we|you|I)\s+(?:said|mentioned|discussed|did)|as\s+discussed)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  const number = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
  const operation = String.raw`(?:[+\-−×x*/÷]|plus|minus|times|multiplied\s+by|divided\s+by)`;
  const expression = new RegExp(
    String.raw`^(?:(?:what\s+is|calculate|compute|solve)\s+)?${number}\s*${operation}\s*${number}(?:\s*[.!?])?(?:\s+(?:and\s+)?(?:give|show|return|state|provide)\s+(?:me\s+)?(?:the\s+)?(?:result|answer)\b[^.!?\n]{0,100}[.!?]?)?$`,
    'i',
  );
  return expression.test(text.trim());
}

/** Deliberation over supplied constraints deserves reasoning without granting tools. */
export const CONVERSATION_REASONING_DIRECTIVE =
  'Reason from the supplied facts and constraints only. Before answering, check each proposed identity, number, prior event, resource assumption and causal conclusion: supplied facts, conditional proposals and unknowns must stay distinct. Do not invent contacts, deadlines, earlier arrangements, availability or completed preparation. Give a useful conditional recommendation and the smallest reversible next step, rather than questions that can be answered from the scenario. Recompute costs against the entire budget, account for effort and dependencies, preserve competing explanations, and give an observable measure and review point for an experiment. Use short separated entries for several options or steps. For simulations, describe what should happen in third person or conditionally, including what may be confirmed only after verification; never issue a first-person action receipt or promise an actual future check. Honor the requested length.';

export function needsConversationReasoning(text: string): boolean {
  return (
    isConversationLocalContext(text) &&
    /\b(?:assess|explain|choose|suggest|experiment|options?|update|change|plan|reason|compare|trade[- ]?offs?|tension|competing|recommend|revise|revised|propose|prioriti[sz]e|decision|alternatives?|distinguish|constraints?|pilot|success|what useful|what changes|handling|fair arrangement)\b/i.test(
      text,
    )
  );
}
