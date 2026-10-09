export type FutureWatchChannel = 'email' | 'web';

export interface FutureWatchIntent {
  channel: FutureWatchChannel;
  /** A current-state check is requested before deciding whether to watch. */
  checkCurrentFirst: boolean;
  explicitEmails: string[];
  explicitUrls: string[];
  targetTerms: string[];
}

export interface FutureWatchEvidence {
  toolName: string;
  status: string;
  result?: unknown;
}

const FUTURE_WATCH_REQUEST =
  /\b(?:tell|let|notify|alert|ping)\s+me\s+(?:if|when|once|as\s+soon\s+as)\b|\b(?:watch|monitor|keep\s+an\s+eye\s+on)\b/i;
const FUTURE_MAIL_EVENT =
  /\b(?:when|if|once|as\s+soon\s+as)\b[^.!?\n]{0,100}\b(?:emails?\s+me|repl(?:y|ies)|responds?|arrives?|comes?\s+in|lands?)\b/i;
const PRESENT_MAIL_LOOKUP =
  /^\s*(?:has|have|did|was|were|is|are)\b[^.!?\n]{0,100}\b(?:emailed|replied|responded|arrived|come\s+in|landed)\b/i;
const TARGET_STOP_WORDS = new Set([
  'about',
  'after',
  'alert',
  'anything',
  'arrive',
  'arrives',
  'as',
  'at',
  'email',
  'emails',
  'for',
  'from',
  'if',
  'in',
  'let',
  'me',
  'message',
  'messages',
  'monitor',
  'my',
  'notify',
  'on',
  'page',
  'ping',
  'reply',
  'replies',
  'respond',
  'response',
  'site',
  'someone',
  'something',
  'tell',
  'that',
  'the',
  'they',
  'this',
  'to',
  'watch',
  'website',
  'when',
  'will',
  'with',
  'you',
]);

function unquotedRequest(text: string): string {
  return text.replace(/```[\s\S]*?```|`[^`]*`|"[^"\n]*"|“[^”\n]*”/g, ' ');
}

/** Detect only explicit future notification requests, leaving present lookup questions alone. */
export function detectFutureWatchIntent(text: string): FutureWatchIntent | null {
  const request = unquotedRequest(text).trim();
  if (!request || (PRESENT_MAIL_LOOKUP.test(request) && !FUTURE_WATCH_REQUEST.test(request))) {
    return null;
  }
  if (
    /\b(?:do not|don't|never|stop)\s+(?:tell|let|notify|alert|ping)\s+me\b|\b(?:do not|don't|never|stop)\s+(?:watch|monitor|keep an eye on)\b|\b(?:i do not want|i don't want|i never want)\s+(?:you to\s+)?(?:watch|monitor|keep an eye on)\b/i.test(
      request,
    ) ||
    /\b(?:the|this|that|a|an)\s+(?:website|email|message|newsletter|document|audit|page|sender)\s+(?:says?|asks?|requests?|instructs?)\b/i.test(
      request,
    )
  )
    return null;

  const urls = [...request.matchAll(/https?:\/\/[^\s<>()\]]+/gi)].map((match) =>
    (match[0] ?? '').replace(/[.,;!?]+$/, ''),
  );
  const webSurface =
    urls.length > 0 || /\b(?:public\s+)?(?:page|website|site|web\s+page)\b/i.test(request);
  const emailSurface =
    /\b(?:e-?mail(?:s|ed|ing)?|inbox|mail|messages?|repl(?:y|ies|ied)|respond(?:ed|s|ing)?|response)\b/i.test(
      request,
    );
  const explicitFuture = FUTURE_WATCH_REQUEST.test(request) || FUTURE_MAIL_EVENT.test(request);
  if (!explicitFuture || (!webSurface && !emailSurface)) return null;
  // A page watch without an exact URL cannot be created safely. Keep the intent
  // so the planner asks for the missing page instead of returning a lookup.
  const channel: FutureWatchChannel = webSurface ? 'web' : 'email';
  const explicitEmails = [...request.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map(
    (match) => (match[0] ?? '').toLowerCase(),
  );
  const targetTerms = [
    ...new Set(
      request
        .toLowerCase()
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ')
        .replace(/https?:\/\/[^\s<>()\]]+/gi, ' ')
        .replace(/[^\p{L}\p{N}'’-]+/gu, ' ')
        .split(/\s+/)
        .map((term) => term.replace(/['’]s$/u, ''))
        .filter((term) => term.length > 2 && !TARGET_STOP_WORDS.has(term)),
    ),
  ].slice(0, 8);
  const checkCurrentFirst =
    /\b(?:check|find\s+out|see|verify|look\s+up)\b/i.test(request) &&
    /\b(?:if\s+not|if\s+no|unless|whether)\b/i.test(request);
  return { channel, checkCurrentFirst, explicitEmails, explicitUrls: urls, targetTerms };
}

/**
 * Late recovery is permitted only when the target is already grounded by the
 * owner's request or a complete current-task mailbox search. This deliberately
 * does not infer a sender from partial, failed, or historical search evidence.
 */
export function futureWatchTargetIsResolved(
  intent: FutureWatchIntent,
  evidence: readonly FutureWatchEvidence[],
): boolean {
  if (intent.checkCurrentFirst) return false;
  return intent.channel === 'web'
    ? intent.explicitUrls.length === 1
    : resolveFutureWatchEmailTargets(intent, evidence).length > 0;
}

export function resolveFutureWatchEmailTargets(
  intent: FutureWatchIntent,
  evidence: readonly FutureWatchEvidence[],
): string[] {
  if (intent.channel !== 'email') return [];
  if (intent.explicitEmails.length > 0) return [...new Set(intent.explicitEmails)].sort();
  if (intent.targetTerms.length === 0) return [];

  const resolved = new Set<string>();
  for (const row of evidence) {
    if (row.toolName !== 'gmail.search' || row.status !== 'succeeded') continue;
    const result = row.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) continue;
    const value = result as Record<string, unknown>;
    if (value.complete !== true || !Array.isArray(value.results)) continue;
    for (const candidate of value.results) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const item = candidate as Record<string, unknown>;
      const from = typeof item.from === 'string' ? item.from.toLowerCase() : '';
      const subject = typeof item.subject === 'string' ? item.subject.toLowerCase() : '';
      const matchedTerms = intent.targetTerms.filter(
        (term) => from.includes(term) || subject.includes(term),
      ).length;
      if (matchedTerms < Math.min(2, intent.targetTerms.length)) continue;
      for (const email of from.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []) {
        resolved.add(email.toLowerCase());
      }
    }
  }
  return resolved.size === 1 ? [...resolved] : [];
}

export function futureWatchRecoveryCallMatches(
  intent: FutureWatchIntent,
  evidence: readonly FutureWatchEvidence[],
  call: { toolName: string; input: unknown },
): boolean {
  if (!futureWatchTargetIsResolved(intent, evidence)) return false;
  if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input)) return false;
  const input = call.input as Record<string, unknown>;
  if (intent.channel === 'web') {
    if (call.toolName !== 'watch.web' || typeof input.url !== 'string') return false;
    try {
      return new URL(input.url).href === new URL(intent.explicitUrls[0] ?? '').href;
    } catch {
      return false;
    }
  }
  if (call.toolName !== 'watch.create' || !Array.isArray(input.expectedSenderEmails)) return false;
  const expected = resolveFutureWatchEmailTargets(intent, evidence);
  const actual = input.expectedSenderEmails
    .filter((email): email is string => typeof email === 'string')
    .map((email) => email.trim().toLowerCase())
    .sort();
  return (
    actual.length === expected.length && actual.every((email, index) => email === expected[index])
  );
}

export function shouldAttemptFutureWatchRecovery(input: {
  intent: FutureWatchIntent;
  evidence: readonly FutureWatchEvidence[];
  attempts: number;
  step: number;
  maxSteps: number;
}): boolean {
  return (
    input.attempts === 0 &&
    input.step < input.maxSteps &&
    !input.evidence.some(
      (row) => row.toolName === 'watch.create' || row.toolName === 'watch.web',
    ) &&
    futureWatchTargetIsResolved(input.intent, input.evidence)
  );
}

/** Contract and planner language shared for explicit future notification requests. */
export function futureWatchRequestGuidance(intent: FutureWatchIntent): string[] {
  if (intent.channel === 'web') {
    return [
      'The owner asked for future monitoring, not only a current page lookup.',
      'Use watch.web for the exact public URL and requested change/contains/absent condition. If no exact URL or condition can be resolved, ask one concise question instead of claiming a watch exists.',
      'Use its bounded expiry and report the created watch only after this task receives an active watch receipt.',
    ];
  }
  return [
    'The owner asked for a future email notification, not only a current mailbox answer.',
    ...(intent.checkCurrentFirst
      ? [
          'First check the current mailbox for the named reply; create a watch only if the requested condition has not already occurred.',
        ]
      : []),
    'Resolve the exact sender from the configured mailbox when possible, then create a bounded watch.create request for that exact sender. Do not guess a sender or turn a broad ambiguous outcome into a broad mailbox watch.',
    'If sender, event scope, or follow-up scope remains ambiguous after available reads, ask one concise question. Claim active monitoring only after this task receives an active watch receipt.',
  ];
}

export function normalizeFutureWatchPlan<
  T extends {
    action: 'reply' | 'workflow' | 'mission' | 'schedule' | 'clarify';
    reasoning: string;
    steps: string[];
    missingInfo: string[];
  },
>(plan: T, intent: FutureWatchIntent): T {
  const targetCanBeResolved =
    intent.channel === 'email'
      ? intent.explicitEmails.length > 0 || intent.targetTerms.length > 0
      : intent.explicitUrls.length > 0;
  if (plan.action === 'clarify' && !targetCanBeResolved) return plan;
  const steps = [
    ...(intent.checkCurrentFirst
      ? ['Check the current matching mailbox state before deciding whether to create the watch.']
      : []),
    ...(intent.channel === 'email'
      ? [
          'Resolve the exact sender through configured Gmail reads; if exactly one intended sender is known, create a bounded watch.create watch. Ask one question if the sender or follow-up scope is still ambiguous.',
        ]
      : [
          'Resolve the exact public page and change condition; create a bounded watch.web watch. Ask one question if the page or condition is still ambiguous.',
        ]),
  ];
  return {
    ...plan,
    action: 'workflow',
    reasoning: 'Create the requested bounded future watch after resolving its exact target',
    steps,
    missingInfo: [],
  };
}
