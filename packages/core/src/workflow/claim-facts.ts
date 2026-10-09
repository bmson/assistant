import { communicationReceipt } from '../communication-receipt.js';

/** Typed records that keep a factual claim joined to the source row that proves it. */
export type ClaimFact =
  | {
      kind: 'calendar_event';
      eventId: string;
      calendarId: string;
      summary: string;
      location: string;
      start: string;
      end: string;
      complete: boolean;
      query: string | null;
    }
  | {
      kind: 'calendar_mutation';
      operation: 'create' | 'update' | 'cancel' | 'delete';
      eventId: string;
      summary: string;
      location: string;
      start: string;
      end: string;
    }
  | { kind: 'outbound'; channel: string; messageId: string; recipients: string[] }
  | {
      kind: 'score';
      away: string;
      awayScore: number;
      home: string;
      homeScore: number;
      sourceLine: string;
    }
  | {
      kind: 'temperature';
      value: number;
      unit: 'C' | 'F' | null;
      qualifier: 'current' | 'forecast' | 'high' | 'low' | 'hourly';
      metric: 'temperature' | 'feels_like';
      place: string;
      date: string;
      weekday: string;
      requestedDate: string;
      hour: number | null;
      window: string;
      windowLabel: string;
      scope: 'current' | 'forecast' | 'target';
    };

interface EvidenceRow {
  toolName?: unknown;
  status?: unknown;
  fromCurrentTask?: unknown;
  args?: unknown;
  result?: unknown;
}

const MAX_FACT_NODES = 4_096;
const MAX_FACT_DEPTH = 24;
const MAX_LIVE_CORPUS_CHARS = 256_000;

function row(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
        .slice(0, MAX_FACT_NODES)
        .map(row)
        .filter((item): item is Record<string, unknown> => item !== null)
    : [];
}

function values(source: Record<string, unknown>, keys: string[]): unknown[] {
  return keys.flatMap((key) => (source[key] === undefined ? [] : [source[key]]));
}

function recipients(value: unknown): string[] {
  const candidates = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return candidates.flatMap((candidate) => {
    if (typeof candidate === 'string' && candidate.trim()) return [candidate.trim()];
    const item = row(candidate);
    const name = str(item?.name);
    const email = str(item?.email ?? item?.address);
    return [name, email].filter(Boolean);
  });
}

function normalizedRecipients(source: Record<string, unknown>): string[] {
  return [...new Set(values(source, ['to', 'recipient', 'recipients']).flatMap(recipients))];
}

function safeCommunicationReceipt(evidence: EvidenceRow, result: Record<string, unknown>) {
  try {
    return communicationReceipt({
      toolName: str(evidence.toolName),
      status: str(evidence.status),
      args: evidence.args,
      result,
    });
  } catch {
    // Malformed/cyclic adapter evidence cannot create a verified send fact.
    return undefined;
  }
}

function sendRecipients(evidenceRow: EvidenceRow, result: Record<string, unknown>): string[] {
  // A compact receipt deliberately says the old arguments have expired. They
  // are intent, not proof of which address the provider accepted.
  if (result.requestedArgumentsVerified === false) return [];
  const hasReceipt = Object.hasOwn(result, 'communicationReceipt');
  const receipt = safeCommunicationReceipt(evidenceRow, result);
  if (hasReceipt) {
    if (!receipt) return [];
    const returned = normalizedRecipients(result);
    if (returned.length > 0) {
      const actual = [...receipt.recipients].map((item) => item.toLowerCase()).sort();
      const projected = returned.map((item) => item.toLowerCase()).sort();
      if (JSON.stringify(actual) !== JSON.stringify(projected)) return [];
    }
    return [...receipt.recipients];
  }
  // Only fields returned by the operation may support a recipient claim.
  // Never union them with the model's requested arguments.
  return normalizedRecipients(result);
}

function successful(evidenceRow: EvidenceRow): boolean {
  if (evidenceRow.status !== 'succeeded' || evidenceRow.fromCurrentTask === false) return false;
  const payload = row(evidenceRow.result);
  if (/^(?:gmail|sms|email)\.send$/.test(str(evidenceRow.toolName)) && payload) {
    if (payload.deliveryStatus !== undefined && payload.deliveryStatus !== 'accepted') return false;
    if (
      Object.hasOwn(payload, 'communicationReceipt') &&
      !safeCommunicationReceipt(evidenceRow, payload)
    )
      return false;
  }
  return !(
    payload &&
    (payload.ok === false ||
      (typeof payload.status === 'number' && payload.status >= 400) ||
      payload.deliveryStatus === 'unknown')
  );
}

function scoreFromLine(line: string): ClaimFact | null {
  const match = /(.+?)\s+at\s+(.+?):\s*(\d{1,3})\s*[-–—]\s*(\d{1,3})(?:,|\s|$)/i.exec(line);
  if (!match) return null;
  return {
    kind: 'score',
    away: match[1]?.trim() ?? '',
    home: match[2]?.trim() ?? '',
    awayScore: Number(match[3]),
    homeScore: Number(match[4]),
    sourceLine: line,
  };
}

function boundedVisit(
  value: unknown,
  visit: (item: Record<string, unknown>) => void,
  seen = new WeakSet<object>(),
  state = { nodes: 0 },
  depth = 0,
): void {
  if (depth > MAX_FACT_DEPTH || state.nodes >= MAX_FACT_NODES) return;
  if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const child of value.slice(0, MAX_FACT_NODES - state.nodes)) {
      state.nodes += 1;
      boundedVisit(child, visit, seen, state, depth + 1);
      if (state.nodes >= MAX_FACT_NODES) break;
    }
    return;
  }
  const item = row(value);
  if (!item || seen.has(item)) return;
  seen.add(item);
  state.nodes += 1;
  visit(item);
  for (const child of Object.values(item)) {
    boundedVisit(child, visit, seen, state, depth + 1);
    if (state.nodes >= MAX_FACT_NODES) break;
  }
}

function structuredScores(value: unknown, facts: ClaimFact[]): void {
  boundedVisit(value, (item) => {
    const line = str(item.line);
    const score = line ? scoreFromLine(line) : null;
    if (score) facts.push(score);
  });
}

interface WeatherContext {
  place: string;
  date: string;
  weekday: string;
  requestedDate: string;
  hour: number | null;
  window: string;
  windowLabel: string;
  scope: 'current' | 'forecast' | 'target';
  qualifier: 'current' | 'forecast' | 'high' | 'low' | 'hourly';
}

function encodedUnit(key: string, item: Record<string, unknown>): 'C' | 'F' | null {
  const suffix = /(?:temp|high|low|feelsLike(?:High|Low)?)([CF])$/i.exec(key)?.[1]?.toUpperCase();
  if (suffix === 'C' || suffix === 'F') return suffix;
  const unitText = str(item.unit ?? item.temperatureUnit ?? item.units);
  return /fahrenheit|\bF\b/i.test(unitText) ? 'F' : /celsius|\bC\b/i.test(unitText) ? 'C' : null;
}

function weatherFacts(value: unknown, facts: ClaimFact[], requestedDate = ''): void {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const walk = (current: unknown, context: WeatherContext, depth: number): void => {
    if (
      depth > MAX_FACT_DEPTH ||
      nodes >= MAX_FACT_NODES ||
      !current ||
      typeof current !== 'object'
    )
      return;
    if (seen.has(current)) return;
    seen.add(current);
    nodes += 1;
    if (Array.isArray(current)) {
      for (const child of current.slice(0, MAX_FACT_NODES - nodes)) {
        walk(child, context, depth + 1);
        if (nodes >= MAX_FACT_NODES) break;
      }
      return;
    }
    const item = current as Record<string, unknown>;
    const ownPlace = str(item.place ?? item.name ?? item.location ?? item.city) || context.place;
    const ownDate = str(item.date) || context.date;
    const ownWeekday = str(item.weekday) || context.weekday;
    const timeHour = /T(\d{2}):\d{2}/.exec(str(item.time))?.[1];
    const ownHour =
      typeof item.hour === 'number' ? item.hour : timeHour ? Number(timeHour) : context.hour;
    const ownWindow = str(item.window) || context.window;
    const ownWindowLabel = str(item.label) || context.windowLabel;
    for (const [key, valueAtKey] of Object.entries(item).slice(0, MAX_FACT_NODES - nodes)) {
      const lowerKey = key.toLowerCase();
      const metric = /feels.?like/.test(lowerKey) ? 'feels_like' : 'temperature';
      const qualifier: 'current' | 'forecast' | 'high' | 'low' | 'hourly' = /high|maximum/.test(
        lowerKey,
      )
        ? 'high'
        : /low|minimum/.test(lowerKey)
          ? 'low'
          : /^(?:current)$/i.test(key)
            ? 'current'
            : context.qualifier;
      if (
        typeof valueAtKey === 'number' &&
        /^(?:temp(?:[CF])?|temperature|currentTemp|high(?:[CF])?|low(?:[CF])?|feelsLike(?:[CF])?|feelsLikeHigh(?:[CF])?|feelsLikeLow(?:[CF])?)$/i.test(
          key,
        )
      ) {
        facts.push({
          kind: 'temperature',
          value: valueAtKey,
          unit: encodedUnit(key, item),
          qualifier,
          metric,
          place: ownPlace,
          date: ownDate,
          weekday: ownWeekday,
          requestedDate: context.requestedDate,
          hour: ownHour,
          window: ownWindow,
          windowLabel: ownWindowLabel,
          scope: context.scope,
        });
      }
      const childScope =
        key === 'current'
          ? 'current'
          : key === 'forecast'
            ? 'forecast'
            : key === 'target' || key === 'windows' || key === 'hours'
              ? 'target'
              : context.scope;
      const childQualifier: 'current' | 'forecast' | 'high' | 'low' | 'hourly' =
        /high|maximum/.test(lowerKey)
          ? 'high'
          : /low|minimum/.test(lowerKey)
            ? 'low'
            : key === 'current'
              ? 'current'
              : key === 'forecast'
                ? 'forecast'
                : key === 'hours' || context.scope === 'target'
                  ? 'hourly'
                  : context.qualifier;
      walk(
        valueAtKey,
        {
          place: ownPlace,
          date: ownDate,
          weekday: ownWeekday,
          requestedDate: context.requestedDate,
          hour: ownHour,
          window: ownWindow,
          windowLabel: ownWindowLabel,
          scope: childScope,
          qualifier: childQualifier,
        },
        depth + 1,
      );
      nodes += 1;
      if (nodes >= MAX_FACT_NODES) break;
    }
  };
  walk(
    value,
    {
      place: '',
      date: '',
      weekday: '',
      requestedDate,
      hour: null,
      window: '',
      windowLabel: '',
      scope: 'current',
      qualifier: 'current',
    },
    0,
  );
}

function uniqueFacts(facts: ClaimFact[]): ClaimFact[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key =
      fact.kind === 'outbound'
        ? `outbound:${fact.channel}:${fact.messageId}`
        : fact.kind === 'temperature'
          ? `temperature:${fact.value}:${fact.unit}:${fact.qualifier}:${fact.metric}:${fact.place}:${fact.date}:${fact.scope}:${fact.hour}:${fact.window}`
          : fact.kind === 'score'
            ? `score:${fact.sourceLine}`
            : fact.kind === 'calendar_event'
              ? `calendar:${fact.calendarId}:${fact.eventId}:${fact.start}`
              : `mutation:${fact.operation}:${fact.eventId}:${fact.start}`;
    if (fact.kind === 'outbound' && !fact.messageId) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Extracts facts from each successful row without combining fields across rows. */
export function evidenceClaimFacts(evidence: readonly EvidenceRow[], liveCorpus = ''): ClaimFact[] {
  const facts: ClaimFact[] = [];
  const outboundByIdentity = new Map<string, Extract<ClaimFact, { kind: 'outbound' }>>();
  for (const evidenceRow of evidence.slice(0, MAX_FACT_NODES)) {
    if (!successful(evidenceRow) || typeof evidenceRow.toolName !== 'string') continue;
    const toolName = evidenceRow.toolName;
    const result = row(evidenceRow.result);
    const args = row(evidenceRow.args);
    if (toolName === 'calendar.list_events' || toolName === 'calendar.search_events') {
      for (const event of rows(result?.events)) {
        const start = str(event.start);
        const end = str(event.end);
        const eventId = str(event.eventId ?? event.id);
        if (!start || !eventId) continue;
        facts.push({
          kind: 'calendar_event',
          eventId,
          calendarId: str(event.calendarId),
          summary: str(event.summary),
          location: str(event.location),
          start,
          end,
          complete: result?.complete === true,
          query: typeof args?.query === 'string' ? args.query : null,
        });
      }
    }
    if (toolName.startsWith('calendar.') && /(?:create|update|cancel|delete)/.test(toolName)) {
      const operation = /cancel/.test(toolName)
        ? 'cancel'
        : /delete/.test(toolName)
          ? 'delete'
          : /update/.test(toolName)
            ? 'update'
            : 'create';
      facts.push({
        kind: 'calendar_mutation',
        operation,
        eventId: str(result?.eventId ?? args?.eventId),
        summary: str(result?.summary ?? args?.summary),
        location: str(result?.location ?? args?.location),
        start: str(result?.start ?? args?.start),
        end: str(result?.end ?? args?.end),
      });
    }
    if (/^(?:gmail|sms|email)\.send$/.test(toolName) && result) {
      const receipt = safeCommunicationReceipt(evidenceRow, result);
      const messageId = str(
        receipt?.providerMessageId ?? result.messageId ?? result.id ?? result.sid,
      );
      if (messageId) {
        const candidates = sendRecipients(evidenceRow, result);
        const existing = outboundByIdentity.get(messageId);
        if (!existing) {
          const fact = {
            kind: 'outbound' as const,
            channel: toolName.split('.')[0] ?? '',
            messageId,
            recipients: candidates,
          };
          outboundByIdentity.set(messageId, fact);
        } else if (
          JSON.stringify([...existing.recipients].sort()) !== JSON.stringify([...candidates].sort())
        ) {
          // Conflicting projections of the same provider effect cannot license
          // a recipient claim.
          existing.recipients = [];
        }
      }
    }
    if (toolName === 'sports.scores' && result) {
      for (const game of rows(result.games)) {
        const line = str(game.line);
        const fact = scoreFromLine(line);
        if (fact) facts.push(fact);
      }
    }
    if (toolName === 'weather.lookup' && result) weatherFacts(result, facts, str(args?.date));
  }
  facts.push(...outboundByIdentity.values());
  for (const line of liveCorpus
    .slice(0, MAX_LIVE_CORPUS_CHARS)
    .split('\n')
    .slice(0, MAX_FACT_NODES)) {
    const candidate = line.trim();
    if (
      candidate.length > MAX_LIVE_CORPUS_CHARS ||
      (!candidate.startsWith('{') && !candidate.startsWith('['))
    )
      continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      weatherFacts(parsed, facts);
      structuredScores(parsed, facts);
    } catch {
      // The legacy text corpus remains available to lexical grounding. Only
      // parseable structured records can create relational facts.
    }
  }
  return uniqueFacts(facts);
}
