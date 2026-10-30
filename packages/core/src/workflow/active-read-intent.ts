import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  detectPersonalReadRequest,
  type PersonalReadRequest,
  type ReadIntentMessage,
  resolveTemporalIntent,
} from './read-intent.js';

const nonempty = z.string().trim().min(1);
const civilDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  });
export const VerifiedReadProvenanceSchema = z
  .object({
    agentId: nonempty,
    conversationId: nonempty,
    taskId: nonempty,
    triggerMessageId: nonempty,
    requestHash: nonempty,
    basisMessageIds: z.array(nonempty).min(1).max(8),
  })
  .strict();
export type VerifiedReadProvenance = z.infer<typeof VerifiedReadProvenanceSchema>;
export const PublicActivityScopeDataSchema = z
  .object({
    version: z.literal(1),
    conversationId: nonempty,
    requestMessageId: nonempty,
    revision: z.number().int().positive(),
    basisMessageIds: z.array(nonempty).min(1).max(8),
    topic: nonempty.max(160),
    location: z.object({ label: nonempty.max(160), basisMessageId: nonempty }).strict(),
    civilWindow: z
      .object({ startDate: civilDate, endDateExclusive: civilDate, label: nonempty.max(80) })
      .strict(),
    clock: z
      .object({
        referenceAt: z.string().datetime(),
        timeZone: nonempty.refine(validZone),
        source: z.literal('task_created_at'),
      })
      .strict(),
    sourceExclusions: z.array(z.enum(['calendar', 'mail'])).max(2),
    filters: z
      .array(
        z
          .object({
            kind: z.enum(['free', 'category', 'accessibility', 'age', 'other_public_preference']),
            value: nonempty.max(120),
            basisMessageId: nonempty,
          })
          .strict(),
      )
      .max(8),
    provenance: VerifiedReadProvenanceSchema,
  })
  .strict()
  .superRefine((scope, ctx) => {
    const days =
      (Date.parse(scope.civilWindow.endDateExclusive) - Date.parse(scope.civilWindow.startDate)) /
      86400000;
    if (!(days > 0 && days <= 31))
      ctx.addIssue({ code: 'custom', message: 'Unsupported civil window' });
    const ids = scope.basisMessageIds;
    if (
      new Set(ids).size !== ids.length ||
      !ids.includes(scope.requestMessageId) ||
      !ids.includes(scope.location.basisMessageId) ||
      scope.filters.some((f) => !ids.includes(f.basisMessageId)) ||
      JSON.stringify(ids) !== JSON.stringify(scope.provenance.basisMessageIds) ||
      scope.conversationId !== scope.provenance.conversationId ||
      scope.requestMessageId !== scope.provenance.triggerMessageId
    )
      ctx.addIssue({ code: 'custom', message: 'Scope provenance mismatch' });
  });
export type PublicActivityScopeData = z.infer<typeof PublicActivityScopeDataSchema>;
export type ExplicitPersonalReadPurpose =
  | { kind: 'availability'; basisMessageId: string }
  | { kind: 'explicit_personal_read'; ownerRequest: string; basisMessageId: string };
export type PartialPublicActivityData = Partial<Omit<PublicActivityScopeData, 'provenance'>>;
export type ResolvedReadIntent =
  | { kind: 'none' }
  | { kind: 'personal'; personal: PersonalReadRequest; provenance?: VerifiedReadProvenance }
  | { kind: 'public_activity'; public: PublicActivityScopeData }
  | {
      kind: 'combined';
      public: PublicActivityScopeData;
      personal: PersonalReadRequest;
      combinationPurpose: ExplicitPersonalReadPurpose;
    }
  | {
      kind: 'clarify_public';
      reason:
        | 'missing_provenance'
        | 'missing_location'
        | 'missing_time'
        | 'ambiguous'
        | 'unsupported';
      partial: PartialPublicActivityData;
    };
export interface VerifiedOwnerReadTurn {
  id: string;
  agentId: string;
  conversationId: string;
  taskId?: string;
  role: 'user';
  origin: 'owner';
  text: string;
  ownerAuthoredText: string;
  /** Validated originating task.createdAt; never derived from source prose. */
  requestAt?: Date;
}
export interface ResolveActiveReadIntentInput {
  text: string;
  now: Date;
  timeZone: string;
  provenance?: Omit<VerifiedReadProvenance, 'basisMessageIds'>;
  ownerTurns?: readonly VerifiedOwnerReadTurn[];
  previousPublic?: PublicActivityScopeData;
  personalHistory?: ReadIntentMessage[];
}
function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}
const PUBLIC =
  /\b(?:public\s+(?:events?|activities)|city\s+events?|things?\s+to\s+do|(?:events?|activities)\b[^.!?]{0,60}\b(?:attend|in\s+San\s+Francisco)|anything\s+(?:happening|going\s+on)\s+in\b)/i;
const PERSONAL_QUALIFICATION = /\b(?:my|our)\s+(?:calendar|agenda|schedule|inbox|email)\b/i;
const OWNED_PRIVATE_RECORD =
  /\b(?:my|our)\s+(?:[\p{L}'’-]+\s+){0,4}(?:reservations?|bookings?|confirmations?|itinerar(?:y|ies)|tickets?|appointments?)\b/iu;
const EXPLICIT_PUBLIC =
  /\b(?:public\s+(?:events?|activities)|city\s+events?|things?\s+to\s+do|(?:events?|activities)\b[^.!?]{0,40}\battend)\b/i;
const CONTINUATION =
  /^(?:please\s+)?(?:search\s+for\s+events?\s+for\s+me|(?:but\s+)?look\s+for\s+events?|anything\s+free|try\s+again|search\s+the\s+web|public\s+events?|i\s+mean\s+city\s+events?)\b/i;
const FREE_OUTDOOR_PREFERENCE = /\b(?:only\s+)?free\s+outdoor\s+(?:things|activities|events?)\b/gi;
const FREE_OUTDOOR_PREFERENCE_FOLLOWUP =
  /^\s*(?:only\s+)?free\s+outdoor\s+(?:things|activities|events?)\b[\s\S]{0,120}$/i;
const TEMPORAL =
  /\b(?:today|tonight|tomorrow|weekend|week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2})\b/i;
function dateOnlyContinuation(text: string): boolean {
  return /^(?:(?:today|tomorrow|tonight|(?:this|next)\s+weekend|\d{4}-\d{2}-\d{2})(?:\s+instead)?|instead[, ]+\s*(?:today|tomorrow|tonight|(?:this|next)\s+weekend|\d{4}-\d{2}-\d{2}))[.!?]*$/i.test(
    text.trim(),
  );
}
function isPublicContinuation(text: string): boolean {
  return (
    CONTINUATION.test(text) ||
    FREE_OUTDOOR_PREFERENCE_FOLLOWUP.test(text) ||
    dateOnlyContinuation(text) ||
    /^\s*(?:not\s+my\s+calendar|not\s+(?:my\s+)?(?:inbox|email))\b/i.test(text)
  );
}
function place(text: string): string | undefined {
  if (/\b(?:San\s+Francisco|SF)\b/i.test(text)) return 'San Francisco';
  return /\b(?:in|near)\s+([A-Z][\p{L}.'-]*(?:\s+[A-Z][\p{L}.'-]*){0,3})(?=\s+(?:today|tonight|tomorrow|this|next|on|for)|[,.!?;]|$)/u.exec(
    text,
  )?.[1];
}
function isPublicRequest(text: string): boolean {
  return (
    (PUBLIC.test(text) ||
      (Boolean(place(text)) &&
        (/\b(?:events?|activities|happening)\b/i.test(text) || Boolean(activityTopic(text))))) &&
    (!(PERSONAL_QUALIFICATION.test(text) || OWNED_PRIVATE_RECORD.test(text)) ||
      EXPLICIT_PUBLIC.test(text))
  );
}
function activityTopic(text: string): string | undefined {
  const explicitCategory = /\bpublic\s+([\p{L}][\p{L} -]{0,80}?)\s+events?\b/iu.exec(text)?.[1];
  if (explicitCategory) return `public ${explicitCategory.toLowerCase()} events`;
  const match =
    /\b(concerts?|live music|comedy|festivals?|museums?|art exhibitions?|outdoor activities|theater|theatre|films?|movies?)\b/i.exec(
      text,
    );
  if (!match) return undefined;
  const prefix = text
    .slice(0, match.index)
    .replace(/^(?:(?:please|find|show|me|search|for|public|recommend|some)\s+)+/i, '')
    .trim();
  // Keep short owner-supplied category modifiers such as jazz; no source prose.
  const modifier = /^[\p{L}-]+(?:\s+[\p{L}-]+){0,2}$/u.test(prefix) ? `${prefix} ` : '';
  return `public ${modifier}${match[0].toLowerCase()} events and activities`;
}
function dateAt(instant: string, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  return ['year', 'month', 'day']
    .map((type) => parts.find((p) => p.type === type)?.value)
    .join('-');
}
export function parsePublicActivityScope(value: unknown): PublicActivityScopeData | undefined {
  const parsed = PublicActivityScopeDataSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
export function buildPublicActivityQuery(
  scope: PublicActivityScopeData,
): { kind: 'query'; query: string } | { kind: 'unsupported' } {
  if (!parsePublicActivityScope(scope)) return { kind: 'unsupported' };
  const query =
    `${scope.topic} in ${scope.location.label} ${scope.civilWindow.startDate} to before ${scope.civilWindow.endDateExclusive} ${scope.filters.map((f) => f.value).join(' ')}`.trim();
  return query.length <= 256 ? { kind: 'query', query } : { kind: 'unsupported' };
}
export function publicActivityScopeHash(scope: PublicActivityScopeData): string {
  return createHash('sha256').update(JSON.stringify(scope)).digest('hex');
}

/** Resolves source selection only. Existing dispatcher/journal retains all execution authority. */
export function resolveActiveReadIntent(input: ResolveActiveReadIntentInput): ResolvedReadIntent {
  const text = input.text.trim();
  const prior = parsePublicActivityScope(input.previousPublic);
  const currentPublic = isPublicRequest(text);
  const continuing = isPublicContinuation(text);
  const p = input.provenance;
  const rows = (input.ownerTurns ?? []).filter(
    (r) =>
      p &&
      r.agentId === p.agentId &&
      r.conversationId === p.conversationId &&
      r.role === 'user' &&
      r.origin === 'owner' &&
      r.text === r.ownerAuthoredText,
  );
  const current = rows.find(
    (r) =>
      r.id === p?.triggerMessageId &&
      r.text.trim() === text &&
      (!r.taskId || r.taskId === p?.taskId),
  );
  const recent = rows.slice(-8);
  const activeRows: VerifiedOwnerReadTurn[] = [];
  for (const row of [...recent].reverse()) {
    if (row.id !== current?.id && !isPublicRequest(row.text) && !isPublicContinuation(row.text))
      break;
    activeRows.unshift(row);
  }
  const previousPublicRow = [...activeRows]
    .reverse()
    .find((r) => r.id !== current?.id && isPublicRequest(r.text));
  const publicRequest = currentPublic || (continuing && Boolean(prior || previousPublicRow));
  if (!publicRequest) {
    const personal = detectPersonalReadRequest(
      input.personalHistory ?? [{ role: 'user', content: text }],
      { now: input.now, timeZone: input.timeZone },
    );
    return personal ? { kind: 'personal', personal } : { kind: 'none' };
  }
  const partial: PartialPublicActivityData = { sourceExclusions: ['calendar', 'mail'] };
  if (
    !p ||
    !current ||
    !p.requestHash ||
    !p.taskId ||
    !current.agentId ||
    !recent.some((r) => r.id === current.id)
  )
    return { kind: 'clarify_public', reason: 'missing_provenance', partial };
  const usablePrior =
    prior &&
    prior.conversationId === p.conversationId &&
    prior.provenance.agentId === p.agentId &&
    (prior.provenance.taskId === p.taskId ||
      prior.basisMessageIds.every((id) => activeRows.some((r) => r.id === id)))
      ? prior
      : undefined;
  const basisRows = activeRows.filter(
    (r) => r.id === current.id || isPublicRequest(r.text) || isPublicContinuation(r.text),
  );
  const basisIds = [
    ...new Set([
      ...(continuing && usablePrior ? usablePrior.basisMessageIds : []),
      ...basisRows.map((r) => r.id),
    ]),
  ];
  if (basisIds.length > 8 || !validZone(input.timeZone) || !Number.isFinite(input.now.getTime()))
    return { kind: 'clarify_public', reason: 'unsupported', partial };
  const preferenceFollowup = FREE_OUTDOOR_PREFERENCE_FOLLOWUP.test(text);
  const locationRow = [...basisRows]
    .reverse()
    .find((r) => (!preferenceFollowup || r.id !== current.id) && place(r.text));
  const currentPlace = place(text);
  const historicalPlace = locationRow ? place(locationRow.text) : undefined;
  const location =
    !preferenceFollowup && currentPlace
      ? { label: currentPlace, basisMessageId: current.id }
      : locationRow && historicalPlace
        ? { label: historicalPlace, basisMessageId: locationRow.id }
        : continuing
          ? usablePrior?.location
          : undefined;
  partial.location = location;
  if (!location) return { kind: 'clarify_public', reason: 'missing_location', partial };
  const timeRow = [...basisRows].reverse().find((r) => TEMPORAL.test(r.text));
  const temporalText = TEMPORAL.test(text) ? text : timeRow?.text;
  let civilWindow = continuing && usablePrior ? usablePrior.civilWindow : undefined;
  let referenceAt =
    continuing && usablePrior && !TEMPORAL.test(text)
      ? usablePrior.clock.referenceAt
      : input.now.toISOString();
  if (temporalText && !(continuing && usablePrior && !TEMPORAL.test(text))) {
    const temporalAnchor = TEMPORAL.test(text) ? input.now : timeRow?.requestAt;
    if (!temporalAnchor || !Number.isFinite(temporalAnchor.getTime()))
      return { kind: 'clarify_public', reason: 'missing_time', partial };
    referenceAt = temporalAnchor.toISOString();
    const resolved = resolveTemporalIntent(
      temporalText.replace(/\bmy weekend is empty\b/i, 'this weekend'),
      'calendar',
      false,
      { now: temporalAnchor, timeZone: input.timeZone },
    );
    if (resolved.kind !== 'resolved')
      return { kind: 'clarify_public', reason: 'unsupported', partial };
    civilWindow = {
      startDate: dateAt(resolved.intent.interval.start, input.timeZone),
      endDateExclusive: dateAt(resolved.intent.interval.endExclusive, input.timeZone),
      label: resolved.intent.window.label,
    };
  }
  partial.civilWindow = civilWindow;
  if (!civilWindow) return { kind: 'clarify_public', reason: 'missing_time', partial };
  const personalClause =
    /\b(?:and|also|then)\s+((?:check|read|show|look\s+at)\s+(?:my\s+)?(?:calendar|inbox|email)|(?:check\s+)?(?:my\s+)?availability)[^.!?]*/i.exec(
      text,
    )?.[0];
  const publicText = (value: string) =>
    value.replace(
      /\b(?:and|also|then)\s+(?:(?:check|read|show|look\s+at)\s+(?:my\s+)?(?:calendar|inbox|email)|(?:check\s+)?(?:my\s+)?availability)[^.!?]*/i,
      '',
    );
  const filters = [...(continuing && usablePrior ? usablePrior.filters : [])];
  for (const row of basisRows) {
    const content = publicText(row.text);
    const supportedPreferences = content.match(FREE_OUTDOOR_PREFERENCE) ?? [];
    const unsupportedCheckText = content.replace(FREE_OUTDOOR_PREFERENCE, ' ');
    const preferenceOnlyRemainder = unsupportedCheckText.replace(/[.,;!?]/g, '').trim();
    if (FREE_OUTDOOR_PREFERENCE_FOLLOWUP.test(content) && preferenceOnlyRemainder)
      return { kind: 'clarify_public', reason: 'unsupported', partial };
    // Unsupported material constraints must remain visible instead of disappearing
    // into a broader search. Only the exact supported preference above is removed
    // before this check; other uses of "only" still require clarification.
    if (
      /\b(?:wheelchair|accessible|accessibility|under\s*18|adults?[- ]only|kids?|children|food|vegan|vegetarian|family[- ]friendly|near(?:by)?|at|only|must|without|budget|less than|under\s*\$)\b/i.test(
        unsupportedCheckText,
      )
    )
      return { kind: 'clarify_public', reason: 'unsupported', partial };
    if (/\bfree\b(?!\s+time)/i.test(content) && !filters.some((f) => f.kind === 'free'))
      filters.push({ kind: 'free', value: 'free admission', basisMessageId: row.id });
    if (
      supportedPreferences.length > 0 &&
      !filters.some((f) => f.kind === 'category' && f.value === 'outdoor activities')
    )
      filters.push({ kind: 'category', value: 'outdoor activities', basisMessageId: row.id });
  }
  const topic =
    activityTopic(publicText(text)) ??
    [...basisRows]
      .reverse()
      .map((row) => activityTopic(publicText(row.text)))
      .find(Boolean) ??
    (continuing ? usablePrior?.topic : undefined) ??
    'public events and activities';
  const provenance: VerifiedReadProvenance = { ...p, basisMessageIds: basisIds };
  const candidate = {
    version: 1,
    conversationId: p.conversationId,
    requestMessageId: current.id,
    revision: usablePrior
      ? usablePrior.revision + (usablePrior.requestMessageId === current.id ? 0 : 1)
      : basisIds.length,
    basisMessageIds: basisIds,
    topic,
    location,
    civilWindow,
    clock:
      continuing && usablePrior && !TEMPORAL.test(text)
        ? usablePrior.clock
        : { referenceAt, timeZone: input.timeZone, source: 'task_created_at' },
    sourceExclusions: ['calendar', 'mail'],
    filters,
    provenance,
  };
  const scope = parsePublicActivityScope(candidate);
  if (!scope || buildPublicActivityQuery(scope).kind === 'unsupported')
    return { kind: 'clarify_public', reason: 'unsupported', partial };

  if (personalClause) {
    const inheritedTemporalPhrase = temporalText
      ?.replace(/\bmy weekend is empty\b/i, 'this weekend')
      .match(
        /\b(?:(?:this|next)\s+(?:weekend|week|month|year)|today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2})\b/i,
      )?.[0];
    const personalTemporal =
      TEMPORAL.test(personalClause) || !inheritedTemporalPhrase
        ? personalClause
        : `${personalClause} ${inheritedTemporalPhrase}`;
    const personal = detectPersonalReadRequest([{ role: 'user', content: personalTemporal }], {
      now: new Date(scope.clock.referenceAt),
      timeZone: scope.clock.timeZone,
    });
    if (personal)
      return {
        kind: 'combined',
        public: scope,
        personal,
        combinationPurpose: /availability|free\s+time/i.test(personalClause)
          ? { kind: 'availability', basisMessageId: current.id }
          : {
              kind: 'explicit_personal_read',
              ownerRequest: personalClause,
              basisMessageId: current.id,
            },
      };
  }
  return { kind: 'public_activity', public: scope };
}

/** Only a verified owner follow-up linked to this search may supersede its proposal. */
export function publicActivityFollowupDisposition(
  scope: PublicActivityScopeData,
  followupResolved: ResolvedReadIntent,
  text: string,
  originalResolved?: ResolvedReadIntent,
): 'unrelated' | 'same_scope' | 'superseded' {
  const value = text.trim();
  const explicitStop =
    /^(?:please\s+)?(?:stop|cancel)[.!]*$/i.test(value) ||
    /\b(?:stop|cancel|don't\s+(?:run|do|continue)|do\s+not\s+(?:run|do|continue))\s+(?:(?:this|that|the)\s+)?(?:search|public\s+events?\s+search|events?\s+search)\b/i.test(
      value,
    );
  if (explicitStop) return 'superseded';
  const cityOnly = Boolean(
    (place(value) || place(`in ${value}`)) &&
      /^(?:in\s+)?[A-Z][\p{L} .'-]+[.!]?$/u.test(value) &&
      !/\b(?:find|search|events?|activities|happening)\b/i.test(value),
  );
  const sourceCorrection =
    /\b(?:use|check|read)\s+(?:my\s+)?(?:calendar|inbox|email)\s+instead\b|\bnot\s+my\s+(?:calendar|inbox|email)\b/i.test(
      value,
    );
  if (sourceCorrection) return 'superseded';
  const linked =
    isPublicContinuation(value) ||
    /^(?:no\b|rather\b|instead\b|i\s+mean\b|not\s+my\s+(?:calendar|inbox|email)\b)/i.test(value) ||
    /\b(?:rather\s+than|instead\s+of|change\s+(?:the\s+)?(?:city|date|search)|make\s+(?:it|that))\b/i.test(
      value,
    ) ||
    cityOnly;
  if (!linked) return 'unrelated';
  if (followupResolved.kind === 'clarify_public' || cityOnly) return 'superseded';
  if (followupResolved.kind !== 'public_activity' && followupResolved.kind !== 'combined')
    return 'unrelated';
  if (
    originalResolved &&
    (originalResolved.kind === 'public_activity' || originalResolved.kind === 'combined')
  ) {
    if (originalResolved.kind !== followupResolved.kind) return 'superseded';
    if (
      originalResolved.kind === 'combined' &&
      followupResolved.kind === 'combined' &&
      JSON.stringify({
        personal: originalResolved.personal,
        purpose: originalResolved.combinationPurpose.kind,
      }) !==
        JSON.stringify({
          personal: followupResolved.personal,
          purpose: followupResolved.combinationPurpose.kind,
        })
    )
      return 'superseded';
  }
  const effective = (s: PublicActivityScopeData) =>
    JSON.stringify({
      location: s.location.label.toLocaleLowerCase(),
      civilWindow: {
        startDate: s.civilWindow.startDate,
        endDateExclusive: s.civilWindow.endDateExclusive,
      },
      topic: s.topic.toLocaleLowerCase(),
      filters: s.filters
        .map((f) => ({ kind: f.kind, value: f.value.toLocaleLowerCase() }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      sourceExclusions: [...s.sourceExclusions].sort(),
    });
  return effective(scope) === effective(followupResolved.public) ? 'same_scope' : 'superseded';
}
