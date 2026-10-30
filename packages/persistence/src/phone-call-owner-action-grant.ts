import { createHash } from 'node:crypto';
import {
  compareExactTimestamps,
  ExactTimestamp,
  isValidExactTimestamp,
  offsetExactTimestamp,
  parseExactTimestamp,
} from './exact-timestamp.js';
import type { OwnerCallActionIntent } from './phone-call-owner-action-intent.js';
import type { OwnerPhoneRecipientRequest } from './phone-call-owner-intent.js';
import type { DirectOwnerCallRequestBinding } from './phone-call-owner-number-grant.js';
import { sameDirectOwnerCallRequestBinding } from './phone-call-owner-number-grant.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9]\d{6,14}$/;
const TEMPLATE_KEY = 'phone.call.owner_action.v2';
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_DAILY_EVENTS = 100;

/** Versioned, bounded authority for current-owner calls to one exact destination. */
export interface OwnerCallActionGrantMatch {
  schemaVersion: 2;
  grantId: string;
  action: 'phone.call';
  recipientE164: string;
  maxMinutes: number;
  maxCallsPerHour: number;
  maxCallsPerDay: number;
  maxCostUsdMicrosPerCall: number;
  maxCostUsdMicrosPerDay: number;
  expiresAt: string;
}

export interface OwnerCallActionIntentBinding {
  intent: OwnerCallActionIntent;
  ownerMessageFingerprint: string;
}

export interface ExpectedOwnerCallActionGrantBinding {
  policyId: string;
  match: OwnerCallActionGrantMatch;
  directOwnerRequest: DirectOwnerCallRequestBinding;
  ownerActionIntent: OwnerCallActionIntentBinding;
  recipientAuthority:
    | { kind: 'explicit_number'; recipientE164: string }
    | { kind: 'configured_owner_phone'; recipientE164: string; fingerprint: string };
  /** Server quote from the same call-cost estimator used by the dial path. */
  estimatedCostUsdMicros: number;
}

export interface OwnerCallActionGrantUsageEvent {
  toolCallId: string;
  at: Date;
  costUsdMicros: number;
}

export interface OwnerCallActionGrantUsage {
  ownerId: string;
  policyId: string;
  grantScopeFingerprint: string;
  events: OwnerCallActionGrantUsageEvent[];
  updatedAt: Date;
}

export interface OwnerCallActionGrantUsageScope {
  ownerId: string;
  policyId: string;
  match: OwnerCallActionGrantMatch;
}

export type OwnerCallActionGrantUsageReservation =
  | { ok: true; usage: OwnerCallActionGrantUsage; replayed: boolean }
  | { ok: false; reason: string };

function validDate(value: unknown): value is Date {
  return isValidExactTimestamp(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** Unknown fields and versions fail closed rather than widening a saved permission. */
export function parsePhoneCallOwnerActionGrantMatch(
  value: unknown,
): OwnerCallActionGrantMatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !exactKeys(row, [
      'action',
      'expiresAt',
      'grantId',
      'maxCallsPerDay',
      'maxCallsPerHour',
      'maxCostUsdMicrosPerCall',
      'maxCostUsdMicrosPerDay',
      'maxMinutes',
      'recipientE164',
      'schemaVersion',
    ]) ||
    row.schemaVersion !== 2 ||
    row.action !== 'phone.call' ||
    typeof row.grantId !== 'string' ||
    !UUID.test(row.grantId) ||
    typeof row.recipientE164 !== 'string' ||
    !E164.test(row.recipientE164) ||
    typeof row.maxMinutes !== 'number' ||
    !Number.isSafeInteger(row.maxMinutes) ||
    row.maxMinutes < 1 ||
    row.maxMinutes > 60 ||
    typeof row.maxCallsPerHour !== 'number' ||
    !Number.isSafeInteger(row.maxCallsPerHour) ||
    row.maxCallsPerHour < 1 ||
    row.maxCallsPerHour > 100 ||
    typeof row.maxCallsPerDay !== 'number' ||
    !Number.isSafeInteger(row.maxCallsPerDay) ||
    row.maxCallsPerDay < 1 ||
    row.maxCallsPerDay > 100 ||
    typeof row.maxCostUsdMicrosPerCall !== 'number' ||
    !Number.isSafeInteger(row.maxCostUsdMicrosPerCall) ||
    row.maxCostUsdMicrosPerCall < 1 ||
    typeof row.maxCostUsdMicrosPerDay !== 'number' ||
    !Number.isSafeInteger(row.maxCostUsdMicrosPerDay) ||
    row.maxCostUsdMicrosPerDay < 1 ||
    row.maxCallsPerHour > row.maxCallsPerDay ||
    row.maxCostUsdMicrosPerCall > row.maxCostUsdMicrosPerDay ||
    typeof row.expiresAt !== 'string'
  )
    return null;
  try {
    parseExactTimestamp(row.expiresAt);
  } catch {
    return null;
  }
  return {
    schemaVersion: 2,
    grantId: row.grantId,
    action: 'phone.call',
    recipientE164: row.recipientE164,
    maxMinutes: row.maxMinutes,
    maxCallsPerHour: row.maxCallsPerHour,
    maxCallsPerDay: row.maxCallsPerDay,
    maxCostUsdMicrosPerCall: row.maxCostUsdMicrosPerCall,
    maxCostUsdMicrosPerDay: row.maxCostUsdMicrosPerDay,
    expiresAt: row.expiresAt,
  };
}

/** Stable SHA-256 identity for this template and exact parsed scope. */
export function phoneCallOwnerActionGrantScopeFingerprint(value: unknown): string | null {
  const match = parsePhoneCallOwnerActionGrantMatch(value);
  if (!match) return null;
  return createHash('sha256')
    .update(JSON.stringify({ templateKey: TEMPLATE_KEY, match }), 'utf8')
    .digest('hex');
}

export function phoneCallOwnerActionGrantIsLive(value: unknown, repositoryNow: Date): boolean {
  const grant = parsePhoneCallOwnerActionGrantMatch(value);
  if (!grant || !validDate(repositoryNow)) return false;
  const expiresAt = parseExactTimestamp(grant.expiresAt);
  return (
    compareExactTimestamps(
      new ExactTimestamp(BigInt(expiresAt.seconds), expiresAt.nanoseconds),
      repositoryNow,
    ) > 0
  );
}

export function phoneCallOwnerActionGrantMatches(
  value: unknown,
  brief: { to?: unknown; maxMinutes?: unknown },
): boolean {
  const grant = parsePhoneCallOwnerActionGrantMatch(value);
  return Boolean(
    grant &&
      brief.to === grant.recipientE164 &&
      typeof brief.maxMinutes === 'number' &&
      Number.isSafeInteger(brief.maxMinutes) &&
      brief.maxMinutes > 0 &&
      brief.maxMinutes <= grant.maxMinutes,
  );
}

function sameIntent(left: OwnerCallActionIntent | null, right: OwnerCallActionIntent): boolean {
  return Boolean(
    left &&
      left.action === 'phone.call' &&
      right.action === 'phone.call' &&
      left.recipientRequest.kind === right.recipientRequest.kind &&
      (left.recipientRequest.kind === 'owner_self'
        ? right.recipientRequest.kind === 'owner_self'
        : right.recipientRequest.kind === 'explicit_number' &&
          left.recipientRequest.recipientE164 === right.recipientRequest.recipientE164),
  );
}

function sameRecipientRequest(
  left: OwnerPhoneRecipientRequest | null,
  right: OwnerPhoneRecipientRequest,
): boolean {
  // The legacy direct-owner binding intentionally has no recipient for newer
  // topic phrasing. The v2 action is independently parsed from the same
  // fingerprint-bound current owner message. Cross-check only when the legacy
  // parser did produce a recipient.
  if (!left) return true;
  if (left.kind !== right.kind) return false;
  return (
    left.kind === 'owner_self' ||
    (right.kind === 'explicit_number' && left.recipientE164 === right.recipientE164)
  );
}

/** Recheck the exact selected v2 row, live owner message intent, destination, duration, and quote. */
export function phoneCallOwnerActionGrantBindingMatches(
  expected: ExpectedOwnerCallActionGrantBinding,
  row: {
    id: string;
    agentId: string;
    toolName: string;
    templateKey: string;
    effect: string;
    enabled: boolean;
    match: unknown;
  } | null,
  agentId: string,
  brief: { to?: unknown; maxMinutes?: unknown },
  repositoryNow: Date,
  configuredOwnerPhoneFingerprint: string | null,
  current: {
    directOwnerRequest: DirectOwnerCallRequestBinding | null;
    ownerActionIntent: OwnerCallActionIntent | null;
  },
): boolean {
  const grant = parsePhoneCallOwnerActionGrantMatch(expected.match);
  const persisted = parsePhoneCallOwnerActionGrantMatch(row?.match);
  const intent = expected.ownerActionIntent;
  const authority = expected.recipientAuthority;
  if (
    !grant ||
    !persisted ||
    !row ||
    row.id !== expected.policyId ||
    row.agentId !== agentId ||
    row.toolName !== 'phone.call' ||
    row.templateKey !== TEMPLATE_KEY ||
    row.effect !== 'allow' ||
    row.enabled !== true ||
    JSON.stringify(grant) !== JSON.stringify(persisted) ||
    !validDate(repositoryNow) ||
    !phoneCallOwnerActionGrantIsLive(grant, repositoryNow) ||
    !phoneCallOwnerActionGrantMatches(grant, brief) ||
    !Number.isSafeInteger(expected.estimatedCostUsdMicros) ||
    expected.estimatedCostUsdMicros < 1 ||
    expected.estimatedCostUsdMicros > grant.maxCostUsdMicrosPerCall ||
    !intent ||
    intent.ownerMessageFingerprint !== expected.directOwnerRequest.ownerMessageFingerprint ||
    !sameRecipientRequest(
      expected.directOwnerRequest.recipientRequest,
      intent.intent.recipientRequest,
    ) ||
    !sameIntent(current.ownerActionIntent, intent.intent) ||
    !sameDirectOwnerCallRequestBinding(expected.directOwnerRequest, current.directOwnerRequest) ||
    authority.recipientE164 !== grant.recipientE164 ||
    intent.intent.action !== 'phone.call'
  )
    return false;
  if (authority.kind === 'explicit_number') {
    return (
      intent.intent.recipientRequest.kind === 'explicit_number' &&
      authority.recipientE164 === intent.intent.recipientRequest.recipientE164 &&
      authority.recipientE164 === grant.recipientE164
    );
  }
  return (
    intent.intent.recipientRequest.kind === 'owner_self' &&
    /^[a-f0-9]{64}$/.test(authority.fingerprint) &&
    configuredOwnerPhoneFingerprint === authority.fingerprint &&
    authority.recipientE164 === grant.recipientE164
  );
}

function parseUsageEvent(value: unknown): OwnerCallActionGrantUsageEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !exactKeys(row, ['at', 'costUsdMicros', 'toolCallId']) ||
    typeof row.toolCallId !== 'string' ||
    !UUID.test(row.toolCallId) ||
    !validDate(row.at) ||
    typeof row.costUsdMicros !== 'number' ||
    !Number.isSafeInteger(row.costUsdMicros) ||
    row.costUsdMicros < 1
  )
    return null;
  return { toolCallId: row.toolCallId, at: row.at, costUsdMicros: row.costUsdMicros };
}

function parseUsage(
  scope: OwnerCallActionGrantUsageScope,
  value: OwnerCallActionGrantUsage | null,
  now: Date,
): OwnerCallActionGrantUsage | null {
  const fingerprint = phoneCallOwnerActionGrantScopeFingerprint(scope.match);
  if (!fingerprint) return null;
  if (value === null)
    return {
      ownerId: scope.ownerId,
      policyId: scope.policyId,
      grantScopeFingerprint: fingerprint,
      events: [],
      updatedAt: now,
    };
  if (
    !value ||
    typeof value !== 'object' ||
    !exactKeys(value as unknown as Record<string, unknown>, [
      'events',
      'grantScopeFingerprint',
      'ownerId',
      'policyId',
      'updatedAt',
    ]) ||
    value.ownerId !== scope.ownerId ||
    value.policyId !== scope.policyId ||
    value.grantScopeFingerprint !== fingerprint ||
    !validDate(value.updatedAt) ||
    compareExactTimestamps(value.updatedAt, now) > 0 ||
    !Array.isArray(value.events) ||
    value.events.length > MAX_DAILY_EVENTS
  )
    return null;
  const events: OwnerCallActionGrantUsageEvent[] = [];
  const ids = new Set<string>();
  for (const raw of value.events) {
    const event = parseUsageEvent(raw);
    if (!event || compareExactTimestamps(event.at, now) > 0 || ids.has(event.toolCallId))
      return null;
    ids.add(event.toolCallId);
    events.push(event);
  }
  return {
    ownerId: value.ownerId,
    policyId: value.policyId,
    grantScopeFingerprint: value.grantScopeFingerprint,
    events,
    updatedAt: value.updatedAt,
  };
}

/**
 * Add one conservative pre-dial usage receipt under repository time. Only the
 * rolling 24-hour window is retained; replay of a retained operation is free
 * only when its quoted amount is identical.
 */
export function reserveOwnerCallGrantUsage(
  scope: OwnerCallActionGrantUsageScope,
  usage: OwnerCallActionGrantUsage | null,
  toolCallId: string,
  now: Date,
  estimatedMicros: number,
): OwnerCallActionGrantUsageReservation {
  const grant = parsePhoneCallOwnerActionGrantMatch(scope.match);
  if (
    !grant ||
    !UUID.test(scope.ownerId) ||
    !UUID.test(scope.policyId) ||
    !UUID.test(toolCallId) ||
    !validDate(now) ||
    !Number.isSafeInteger(estimatedMicros) ||
    estimatedMicros < 1 ||
    estimatedMicros > grant.maxCostUsdMicrosPerCall ||
    !phoneCallOwnerActionGrantIsLive(grant, now)
  )
    return { ok: false, reason: 'owner-call grant scope, quote, or repository time is invalid' };
  const current = parseUsage(scope, usage, now);
  if (!current)
    return { ok: false, reason: 'owner-call grant usage record is malformed or changed' };
  const replay = current.events.find((event) => event.toolCallId === toolCallId);
  if (replay) {
    if (replay.costUsdMicros !== estimatedMicros)
      return { ok: false, reason: 'owner-call grant usage replay quote changed' };
    return { ok: true, usage: current, replayed: true };
  }
  const cutoff = offsetExactTimestamp(now, -DAY_MS);
  const events = current.events.filter((event) => compareExactTimestamps(event.at, cutoff) > 0);
  const hourCutoff = offsetExactTimestamp(now, -HOUR_MS);
  if (events.length >= MAX_DAILY_EVENTS)
    return { ok: false, reason: 'owner-call grant usage receipt bound reached' };
  if (events.length >= grant.maxCallsPerDay)
    return { ok: false, reason: 'owner-call grant daily call limit reached' };
  if (
    events.filter((event) => compareExactTimestamps(event.at, hourCutoff) > 0).length >=
    grant.maxCallsPerHour
  )
    return { ok: false, reason: 'owner-call grant hourly call limit reached' };
  let spent = 0;
  for (const event of events) {
    spent += event.costUsdMicros;
    if (!Number.isSafeInteger(spent))
      return { ok: false, reason: 'owner-call grant daily cost total is invalid' };
  }
  if (spent + estimatedMicros > grant.maxCostUsdMicrosPerDay)
    return { ok: false, reason: 'owner-call grant daily cost limit reached' };
  return {
    ok: true,
    replayed: false,
    usage: {
      ...current,
      events: [...events, { toolCallId, at: now, costUsdMicros: estimatedMicros }],
      updatedAt: now,
    },
  };
}
