/** Rejection diagnostics only. No provider values, IDs, URLs or error text escape. */
import {
  sanitizeTrafficDetails,
  type TrafficSnapshot,
  trafficDetails,
} from './owner-editor-traffic-details.js';

const UNKNOWN = Symbol('unreadable');
const MAX_ROWS = 1000;
const fields = [
  'PERSISTENCE_DRIVER',
  'FIRESTORE_DATABASE_ID',
  'ASSISTANT_RELEASE_SHA',
  'RELEASE_SHA',
  'ASSISTANT_RELEASE_API_CONTRACT',
  'ASSISTANT_RELEASE_SCHEMA_DRIVER',
  'ASSISTANT_RELEASE_SCHEMA_MIN',
  'ASSISTANT_RELEASE_SCHEMA_MAX',
  'ASSISTANT_RELEASE_SCHEMA_VERSION',
  'ASSISTANT_RELEASE_MANIFEST',
  'ASSISTANT_RELEASE_WRITES_PAUSED',
] as const;
const groups = [
  'service_identity',
  'account',
  'container',
  'image',
  'env_literal',
  'env_length',
  'env_chars',
  'env_duplicate',
  'env_secret_ref',
  'persistence',
  'traffic_count',
  'revision',
  'percent',
  'reconciling',
  'editor_target',
  'diagnostic_bound',
] as const;
const countNames = [
  'containers',
  'envRows',
  'trafficRows',
  'trafficZero',
  'trafficHundred',
  'trafficOther',
  'trafficInvalid',
] as const;
type Group = (typeof groups)[number];
type Check = boolean | null;
type Counts = Record<(typeof countNames)[number], number | null>;
type Audit = {
  service: 'agent' | 'web';
  reasons: Group[];
  issues: Record<Group, Check>;
  counts: Counts;
  invalidEnvFields: (typeof fields)[number][];
  diagnosticHintsOnly: true;
  trafficDetails: ReturnType<typeof trafficDetails>;
};
function array(value: unknown): boolean {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}
function object(value: unknown): value is Record<string, unknown> {
  try {
    return value !== null && typeof value === 'object' && !array(value);
  } catch {
    return false;
  }
}
/** Each requested property is captured once; accessors and throwing proxies are unknown. */
function own(value: unknown, key: string): unknown {
  if (value === UNKNOWN) return UNKNOWN;
  try {
    if (!object(value) && !array(value)) return undefined;
    const d = Object.getOwnPropertyDescriptor(value, key);
    return d ? ('value' in d ? d.value : UNKNOWN) : undefined;
  } catch {
    return UNKNOWN;
  }
}
function rows(value: unknown): unknown[] | null {
  try {
    if (!array(value)) return null;
    const length = own(value, 'length');
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > MAX_ROWS)
      return null;
    return Array.from({ length }, (_, i) => own(value, String(i)));
  } catch {
    return null;
  }
}
function invalid(value: unknown, predicate: (v: unknown) => boolean): Check {
  return value === UNKNOWN ? null : !predicate(value);
}
function mergeIssue(current: Check, next: Check): Check {
  return current === true || next === true
    ? true
    : current === null || next === null
      ? null
      : false;
}
const string = (value: unknown, pattern: RegExp) =>
  typeof value === 'string' && pattern.test(value);
const count = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_ROWS
    ? value
    : null;

export function auditServiceFacts(raw: unknown, service: 'agent' | 'web'): Audit {
  const issues = Object.fromEntries(groups.map((k) => [k, null])) as Record<Group, Check>;
  const counts = Object.fromEntries(countNames.map((k) => [k, null])) as Counts;
  const invalidFields = new Set<(typeof fields)[number]>();
  const name = own(raw, 'name'),
    template = own(raw, 'template'),
    trafficRaw = own(raw, 'trafficStatuses'),
    reconciling = own(raw, 'reconciling');
  issues.service_identity = invalid(
    name,
    (v) => v === `projects/bmson-assistant/locations/us-west1/services/assistant-${service}`,
  );
  issues.reconciling = invalid(reconciling, (v) => v === undefined || v === false);
  const account = own(template, 'serviceAccount'),
    containerRaw = own(template, 'containers');
  issues.account = invalid(account, (v) =>
    string(v, /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+\.iam\.gserviceaccount\.com$/),
  );
  const containers = rows(containerRaw),
    traffic = rows(trafficRaw);
  const trafficSnapshots: TrafficSnapshot[] = (traffic ?? []).map((entry) => ({
    revision: own(entry, 'revision'),
    percent: own(entry, 'percent'),
    tag: own(entry, 'tag'),
    uri: own(entry, 'uri'),
  }));
  counts.containers = containers?.length ?? null;
  counts.trafficRows = traffic?.length ?? null;
  issues.container = containerRaw === UNKNOWN ? null : containers?.length !== 1;
  issues.traffic_count = trafficRaw === UNKNOWN ? null : traffic?.length !== 1;
  issues.diagnostic_bound =
    (array(containerRaw) && containers === null) || (array(trafficRaw) && traffic === null);
  if (containers?.length === 1) {
    const image = own(containers[0], 'image'),
      envRaw = own(containers[0], 'env');
    issues.image = invalid(image, (v) =>
      string(
        v,
        new RegExp(
          `^us-west1-docker\\.pkg\\.dev/bmson-assistant/assistant/${service}@sha256:[a-f0-9]{64}$`,
        ),
      ),
    );
    const env = envRaw === undefined ? [] : rows(envRaw);
    counts.envRows = env?.length ?? null;
    if (array(envRaw) && env === null) issues.diagnostic_bound = true;
    if (env) {
      for (const k of [
        'env_literal',
        'env_length',
        'env_chars',
        'env_duplicate',
        'env_secret_ref',
      ] as const)
        issues[k] = false;
      let unknownEnvNames = false;
      const values = new Map<string, unknown>(),
        occurrences = new Map<string, number>();
      const add = (group: Group, verdict: Check, field?: (typeof fields)[number]) => {
        if (verdict === true) {
          issues[group] = true;
          if (field) invalidFields.add(field);
        } else if (verdict === null && issues[group] === false) issues[group] = null;
      };
      for (const entry of env) {
        const field = own(entry, 'name');
        if (field === UNKNOWN) {
          unknownEnvNames = true;
          for (const k of [
            'env_literal',
            'env_length',
            'env_chars',
            'env_duplicate',
            'env_secret_ref',
          ] as const)
            add(k, null);
          continue;
        }
        if (!object(entry) || typeof field !== 'string') {
          add('env_literal', true);
          continue;
        }
        const approved = fields.find((f) => f === field);
        if (!approved && field !== 'ASSISTANT_WORKSPACE_ID' && field !== 'FIRESTORE_AGENT_ID')
          continue;
        const value = own(entry, 'value'),
          source = own(entry, 'valueSource'),
          from = own(entry, 'valueFrom');
        occurrences.set(field, (occurrences.get(field) ?? 0) + 1);
        values.set(field, value);
        if (approved) {
          add(
            'env_literal',
            invalid(value, (v) => typeof v === 'string'),
            approved,
          );
          add(
            'env_length',
            invalid(value, (v) => typeof v === 'string' && v.length <= 128),
            approved,
          );
          add(
            'env_chars',
            invalid(value, (v) => string(v, /^[a-zA-Z0-9_.:-]*$/)),
            approved,
          );
          add('env_duplicate', (occurrences.get(field) ?? 0) > 1, approved);
          add(
            'env_secret_ref',
            source === UNKNOWN || from === UNKNOWN
              ? null
              : source !== undefined || from !== undefined,
            approved,
          );
        }
        if (
          source === UNKNOWN ||
          from === UNKNOWN ||
          (approved ? source !== undefined || from !== undefined : !!source || !!from)
        )
          values.set(field, UNKNOWN);
      }
      const expected = {
        PERSISTENCE_DRIVER: 'firestore',
        FIRESTORE_DATABASE_ID: 'assistant-production',
        ASSISTANT_RELEASE_SCHEMA_DRIVER: 'firestore',
        ASSISTANT_RELEASE_SCHEMA_MIN: '1',
        ASSISTANT_RELEASE_SCHEMA_MAX: '1',
        ASSISTANT_RELEASE_API_CONTRACT: '1',
      };
      issues.persistence = false;
      for (const [field, value] of Object.entries(expected)) {
        const actual = values.get(field);
        add(
          'persistence',
          actual === UNKNOWN || (actual === undefined && unknownEnvNames) ? null : actual !== value,
          field as (typeof fields)[number],
        );
      }
      const workspace = values.get('ASSISTANT_WORKSPACE_ID'),
        owner = values.get('FIRESTORE_AGENT_ID');
      issues.editor_target =
        workspace === UNKNOWN ||
        owner === UNKNOWN ||
        (unknownEnvNames && (workspace === undefined || owner === undefined))
          ? null
          : !(
              occurrences.get('ASSISTANT_WORKSPACE_ID') === 1 &&
              occurrences.get('FIRESTORE_AGENT_ID') === 1 &&
              string(workspace, /^[A-Za-z0-9_-]{1,128}$/) &&
              string(
                owner,
                /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
              )
            );
    } else issues.env_literal = envRaw === UNKNOWN ? null : true;
  }
  if (traffic) {
    let unreadablePercent = false;
    counts.trafficZero = 0;
    counts.trafficHundred = 0;
    counts.trafficOther = 0;
    counts.trafficInvalid = 0;
    issues.revision = false;
    issues.percent = false;
    for (const entry of trafficSnapshots) {
      const revision = entry.revision,
        percent = entry.percent;
      const badRevision = invalid(revision, (v) =>
        string(v, new RegExp(`^assistant-${service}-[a-z0-9-]{1,63}$`)),
      );
      if (badRevision === true || issues.revision === true) issues.revision = true;
      else if (badRevision === null) issues.revision = null;
      if (percent === UNKNOWN) unreadablePercent = true;
      if (percent === 0) counts.trafficZero++;
      else if (percent === 100) counts.trafficHundred++;
      else if (
        typeof percent === 'number' &&
        Number.isInteger(percent) &&
        percent > 0 &&
        percent < 100
      )
        counts.trafficOther++;
      else counts.trafficInvalid++;
      issues.percent = mergeIssue(
        issues.percent,
        invalid(percent, (v) => v === 100),
      );
    }
    if (unreadablePercent) {
      counts.trafficZero = null;
      counts.trafficHundred = null;
      counts.trafficOther = null;
      counts.trafficInvalid = null;
    }
  }
  return {
    service,
    reasons: groups.filter((k) => issues[k] === true),
    issues,
    counts,
    invalidEnvFields: fields.filter((f) => invalidFields.has(f)),
    diagnosticHintsOnly: true,
    trafficDetails: trafficDetails(traffic === null ? null : trafficSnapshots, service),
  };
}

/** Revalidate every emitted field even if an internal error object was modified. */
export function sanitizeServiceAudit(raw: unknown) {
  const service = own(raw, 'service'),
    issueRaw = own(raw, 'issues'),
    countRaw = own(raw, 'counts'),
    fieldRaw = own(raw, 'invalidEnvFields');
  const issues = Object.fromEntries(
    groups.map((k) => {
      const v = own(issueRaw, k);
      return [k, typeof v === 'boolean' ? v : null];
    }),
  ) as Record<Group, Check>;
  const counts = Object.fromEntries(countNames.map((k) => [k, count(own(countRaw, k))]));
  const fieldRows = rows(fieldRaw) ?? [];
  return {
    service: service === 'agent' || service === 'web' ? service : 'unknown',
    reason: groups.find((k) => issues[k] === true) ?? 'unknown_validation',
    reasons: groups.filter((k) => issues[k] === true),
    issues,
    counts,
    invalidEnvFields: fields.filter((f) => fieldRows.includes(f)),
    diagnosticHintsOnly: true,
    trafficDetails: sanitizeTrafficDetails(own(raw, 'trafficDetails')),
  };
}
export class InventoryServiceFactsError extends Error {
  readonly facts: Audit;
  constructor(raw: unknown, service: 'agent' | 'web') {
    super('Service facts rejected');
    this.facts = auditServiceFacts(raw, service);
  }
}
