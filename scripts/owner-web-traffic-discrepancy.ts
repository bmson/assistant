/** Failure hints only; never retirement/readiness authority or a repair plan. No provider calls. */
import { createHash } from 'node:crypto';
import { HISTORICAL_WEB_TAGS, WEB_SERVICE } from './owner-web-tag-retirement.js';

const TYPE = 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION';
const LIMIT = 32;
const BYTE_LIMIT = 16384;
type Row = { type: typeof TYPE; revision: string; percent: number; tag: string };
type Issue =
  | 'row_not_object'
  | 'unknown_field'
  | 'allocation_unresolved'
  | 'revision_invalid'
  | 'percent_invalid'
  | 'tag_invalid';
type Membership = 'historical_old' | 'historical_current' | 'other' | 'absent';
interface TrafficRowHint {
  identitySha256: string;
  revisionSha256: string;
  revisionMembership: Membership;
  allocationType: 'revision';
  effectivePercent: number;
  count: number;
}
interface TrafficTagHint {
  tagSha256: string | null;
  tagMembership: Membership;
  desiredCount: number;
  observedCount: number;
  presence: 'both' | 'desired_only' | 'observed_only';
  revisionAssignmentDiffers: boolean;
  percentAssignmentDiffers: boolean;
  desired: TrafficRowHint[];
  observed: TrafficRowHint[];
}
export interface TrafficDiscrepancy {
  format: 1;
  diagnosticHintsOnly: true;
  ownershipProven: false;
  readiness: 'unknown';
  mutationAuthority: false;
  repairProposed: false;
  comparison:
    | 'unavailable'
    | 'uncomparable'
    | 'canonical_multiset_equal'
    | 'canonical_multiset_differs';
  reason?:
    | 'fixed_service_unverified'
    | 'traffic_arrays_missing'
    | 'traffic_row_bound'
    | 'projection_unreadable'
    | 'diagnostic_byte_bound';
  desiredCount?: number | null;
  observedCount?: number | null;
  rowBound?: number;
  byteBound?: number;
  desired?: ReturnType<typeof summarize>['facts'];
  observed?: ReturnType<typeof summarize>['facts'];
  desiredOnlyIdentities?: number;
  observedOnlyIdentities?: number;
  categories?: string[];
  byTag?: TrafficTagHint[] | null;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const encoded = (row: Row) => JSON.stringify(row);
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function membership(value: string, field: 'tag' | 'revision'): Membership {
  if (!value) return 'absent';
  if (value === HISTORICAL_WEB_TAGS[0]?.[field]) return 'historical_old';
  if (value === HISTORICAL_WEB_TAGS[1]?.[field]) return 'historical_current';
  return 'other';
}
function parse(
  value: unknown,
  status: boolean,
): { row: Row | null; issues: Issue[]; omittedPercent: boolean } {
  const object = record(value);
  if (!object) return { row: null, issues: ['row_not_object'], omittedPercent: false };
  const issues: Issue[] = [];
  if (
    Object.keys(object).some(
      (key) => !['type', 'revision', 'percent', 'tag', ...(status ? ['uri'] : [])].includes(key),
    )
  )
    issues.push('unknown_field');
  if (object.type !== TYPE) issues.push('allocation_unresolved');
  const revision =
    typeof object.revision === 'string' && object.revision.startsWith(`${WEB_SERVICE}/revisions/`)
      ? object.revision.slice(`${WEB_SERVICE}/revisions/`.length)
      : object.revision;
  if (typeof revision !== 'string' || !/^assistant-web-[a-z0-9-]{1,63}$/.test(revision))
    issues.push('revision_invalid');
  const omittedPercent = object.percent === undefined,
    percent = omittedPercent ? 0 : object.percent;
  if (typeof percent !== 'number' || !Number.isInteger(percent) || percent < 0 || percent > 100)
    issues.push('percent_invalid');
  const tag = object.tag === undefined ? '' : object.tag;
  if (object.tag !== undefined && (typeof tag !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(tag)))
    issues.push('tag_invalid');
  if (issues.length) return { row: null, issues, omittedPercent };
  return {
    row: {
      type: TYPE,
      revision: revision as string,
      percent: percent as number,
      tag: tag as string,
    },
    issues,
    omittedPercent,
  };
}
function summarize(values: unknown[], status: boolean) {
  const parsed = values.map((value) => parse(value, status));
  const rows = parsed.flatMap((value) => (value.row ? [value.row] : []));
  const issueCounts = new Map<Issue, number>();
  for (const value of parsed)
    for (const issue of value.issues) issueCounts.set(issue, (issueCounts.get(issue) ?? 0) + 1);
  const identities = new Map<string, number>();
  for (const row of rows) identities.set(encoded(row), (identities.get(encoded(row)) ?? 0) + 1);
  const allComparable = rows.length === values.length;
  const fieldHash = (field: keyof Row) =>
    allComparable
      ? hash(JSON.stringify(rows.map((row) => JSON.stringify(row[field])).sort()))
      : null;
  return {
    rows,
    identities,
    facts: {
      rowCount: values.length,
      comparableRows: rows.length,
      uncomparableRows: values.length - rows.length,
      omittedPercentRows: parsed.filter((value) => value.omittedPercent).length,
      invalidCategories: [...issueCounts]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([category, count]) => ({ category, count })),
      canonicalTrafficSha256: allComparable ? hash(JSON.stringify(rows.map(encoded).sort())) : null,
      fieldMultisetSha256: {
        type: fieldHash('type'),
        revision: fieldHash('revision'),
        percent: fieldHash('percent'),
        tag: fieldHash('tag'),
      },
      duplicateIdentities: [...identities]
        .filter(([, count]) => count > 1)
        .map(([identity, count]) => ({ identitySha256: hash(identity), count }))
        .sort((a, b) => a.identitySha256.localeCompare(b.identitySha256)),
    },
  };
}
/** Accept only the already-fetched fixed service snapshot. Never retain arbitrary keys/values. */
export function describeWebTrafficDiscrepancy(raw: unknown): TrafficDiscrepancy {
  const base = {
    format: 1,
    diagnosticHintsOnly: true,
    ownershipProven: false,
    readiness: 'unknown',
    mutationAuthority: false,
    repairProposed: false,
  } as const;
  try {
    const service = record(raw);
    if (!service || service.name !== WEB_SERVICE)
      return { ...base, comparison: 'unavailable', reason: 'fixed_service_unverified' };
    const desired = service.traffic,
      observed = service.trafficStatuses;
    if (!Array.isArray(desired) || !Array.isArray(observed))
      return {
        ...base,
        comparison: 'unavailable',
        reason: 'traffic_arrays_missing',
        desiredCount: Array.isArray(desired) ? desired.length : null,
        observedCount: Array.isArray(observed) ? observed.length : null,
      };
    if (
      desired.length < 1 ||
      observed.length < 1 ||
      desired.length > LIMIT ||
      observed.length > LIMIT
    )
      return {
        ...base,
        comparison: 'unavailable',
        reason: 'traffic_row_bound',
        desiredCount: desired.length,
        observedCount: observed.length,
        rowBound: LIMIT,
      };
    const d = summarize(desired, false),
      o = summarize(observed, true);
    if (d.facts.uncomparableRows || o.facts.uncomparableRows)
      return {
        ...base,
        comparison: 'uncomparable',
        desired: d.facts,
        observed: o.facts,
        categories: ['invalid_traffic_identity'],
        byTag: null,
      };
    const categories: string[] = [];
    if (desired.length !== observed.length) categories.push('row_count_differs');
    for (const field of ['type', 'revision', 'percent', 'tag'] as const)
      if (d.facts.fieldMultisetSha256[field] !== o.facts.fieldMultisetSha256[field])
        categories.push(`${field}_multiset_differs`);
    if (d.facts.duplicateIdentities.length) categories.push('desired_duplicate_identity');
    if (o.facts.duplicateIdentities.length) categories.push('observed_duplicate_identity');
    let desiredOnly = 0,
      observedOnly = 0;
    for (const [key, count] of d.identities)
      desiredOnly += Math.max(0, count - (o.identities.get(key) ?? 0));
    for (const [key, count] of o.identities)
      observedOnly += Math.max(0, count - (d.identities.get(key) ?? 0));
    if (desiredOnly) categories.push('desired_only_identity');
    if (observedOnly) categories.push('observed_only_identity');
    const project = (rows: Row[]) => {
      const grouped = new Map<string, TrafficRowHint>();
      for (const row of rows) {
        const key = encoded(row),
          value = grouped.get(key) ?? {
            identitySha256: hash(key),
            revisionSha256: hash(row.revision),
            revisionMembership: membership(row.revision, 'revision'),
            allocationType: 'revision' as const,
            effectivePercent: row.percent,
            count: 0,
          };
        value.count++;
        grouped.set(key, value);
      }
      return [...grouped.values()].sort((a, b) => a.identitySha256.localeCompare(b.identitySha256));
    };
    const tags = [...new Set([...d.rows, ...o.rows].map((row) => row.tag))];
    const byTag = tags
      .map((tag): TrafficTagHint => {
        const dr = d.rows.filter((row) => row.tag === tag),
          or = o.rows.filter((row) => row.tag === tag);
        const dv = project(dr),
          ov = project(or);
        const revisionSet = (rows: Row[]) =>
          JSON.stringify([...new Set(rows.map((row) => row.revision))].sort());
        const allocationSet = (rows: Row[]) =>
          JSON.stringify(
            [...new Set(rows.map((row) => JSON.stringify([row.revision, row.percent])))].sort(),
          );
        return {
          tagSha256: tag ? hash(tag) : null,
          tagMembership: membership(tag, 'tag'),
          desiredCount: dr.length,
          observedCount: or.length,
          presence: dr.length && or.length ? 'both' : dr.length ? 'desired_only' : 'observed_only',
          revisionAssignmentDiffers:
            dr.length > 0 && or.length > 0 && revisionSet(dr) !== revisionSet(or),
          percentAssignmentDiffers:
            dr.length > 0 && or.length > 0 && allocationSet(dr) !== allocationSet(or),
          desired: dv,
          observed: ov,
        };
      })
      .sort((a, b) => (a.tagSha256 ?? '').localeCompare(b.tagSha256 ?? ''));
    if (byTag.some((tag) => tag.presence === 'desired_only'))
      categories.push('tag_absent_from_observed');
    if (byTag.some((tag) => tag.presence === 'observed_only'))
      categories.push('tag_absent_from_desired');
    if (byTag.some((tag) => tag.revisionAssignmentDiffers))
      categories.push('same_tag_revision_assignment_differs');
    if (byTag.some((tag) => tag.percentAssignmentDiffers))
      categories.push('same_tag_percent_assignment_differs');
    const report: TrafficDiscrepancy = {
      ...base,
      comparison:
        desiredOnly || observedOnly ? 'canonical_multiset_differs' : 'canonical_multiset_equal',
      desired: d.facts,
      observed: o.facts,
      desiredOnlyIdentities: desiredOnly,
      observedOnlyIdentities: observedOnly,
      categories,
      byTag,
    };
    if (Buffer.byteLength(JSON.stringify(report)) > BYTE_LIMIT)
      return {
        ...base,
        comparison: 'unavailable',
        reason: 'diagnostic_byte_bound',
        desiredCount: desired.length,
        observedCount: observed.length,
        byteBound: BYTE_LIMIT,
      };
    return report;
  } catch {
    return { ...base, comparison: 'unavailable', reason: 'projection_unreadable' };
  }
}
