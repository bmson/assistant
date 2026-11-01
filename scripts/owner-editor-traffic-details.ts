/** Traffic diagnostics only. ProtoJSON interpretation never changes acceptance. */
import { createHash } from 'node:crypto';
export interface TrafficSnapshot {
  revision: unknown;
  percent: unknown;
  tag: unknown;
  uri: unknown;
}
const types = ['absent', 'number', 'string', 'boolean', 'null', 'object', 'unknown'] as const;
const tagKinds = [
  'absent',
  'candidate_run_attempt',
  'resume_run_attempt',
  'candidate_local_hex',
  'resume_local_hex',
  'other',
  'unknown',
] as const;
type WireType = (typeof types)[number];
const wireType = (value: unknown): WireType =>
  value === undefined
    ? 'absent'
    : value === null
      ? 'null'
      : typeof value === 'number'
        ? 'number'
        : typeof value === 'string'
          ? 'string'
          : typeof value === 'boolean'
            ? 'boolean'
            : typeof value === 'object'
              ? 'object'
              : 'unknown';
const percent = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
const hash = (value: unknown) =>
  typeof value === 'string' && value.length <= 4096
    ? createHash('sha256').update(value).digest('hex')
    : null;
function publicTagUri(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' &&
      u.hostname.endsWith('.run.app') &&
      !u.username &&
      !u.password &&
      !u.port &&
      u.pathname === '/' &&
      !u.search &&
      !u.hash
      ? u
      : null;
  } catch {
    return null;
  }
}
export function trafficDetails(snapshots: TrafficSnapshot[] | null, service: 'agent' | 'web') {
  if (snapshots === null) return { rows: [], truncated: null, diagnosticHintsOnly: true };
  const serving = snapshots.filter((s) => s.percent === 100);
  const reference =
    serving.length === 1 && typeof serving[0]?.revision === 'string' ? serving[0].revision : null;
  return {
    truncated: snapshots.length > 32,
    rows: snapshots.slice(0, 32).map((s, index) => {
      const percentType = wireType(s.percent),
        tagType = wireType(s.tag),
        uriType = wireType(s.uri);
      const tagValid = typeof s.tag === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(s.tag);
      const match = tagValid
        ? /^(candidate|resume)-([0-9]{1,20})-([1-9][0-9]{0,5})$/.exec(s.tag as string)
        : null;
      const run = match && `${match[2]}-${match[3]}`.length <= 21 ? match : null;
      const local = tagValid ? /^(candidate|resume)-[a-f0-9]{20}$/.exec(s.tag as string) : null;
      const tagKind =
        tagType === 'absent'
          ? 'absent'
          : tagType === 'unknown'
            ? 'unknown'
            : run
              ? `${run[1]}_run_attempt`
              : local
                ? `${local[1]}_local_hex`
                : 'other';
      const uri = publicTagUri(s.uri);
      return {
        index,
        percentType,
        percentPresent: percentType === 'unknown' ? null : percentType !== 'absent',
        percentValue: percent(s.percent),
        protoJsonDefaultZero: percentType === 'absent',
        effectivePercent: percentType === 'absent' ? 0 : percent(s.percent),
        tagType,
        tagPresent: tagType === 'unknown' ? null : tagType !== 'absent',
        tagShapeValid: tagType === 'unknown' ? null : tagValid,
        tagSha256: hash(s.tag),
        tagKind,
        tagRunId: run?.[2] ?? null,
        tagRunAttempt: run ? Number(run[3]) : null,
        ownershipProven: false,
        uriType,
        uriPresent: uriType === 'unknown' ? null : uriType !== 'absent',
        uriShapeValid: uriType === 'unknown' ? null : uri !== null,
        uriSha256: hash(s.uri),
        uriMatchesTag:
          uri && tagValid ? uri.hostname.startsWith(`${s.tag}---assistant-${service}-`) : null,
        revisionSha256: hash(s.revision),
        sameRevisionAsUniqueHundred:
          reference === null || typeof s.revision !== 'string' ? null : s.revision === reference,
      };
    }),
    diagnosticHintsOnly: true,
  };
}
function own(raw: unknown, key: string): unknown {
  try {
    if (!raw || typeof raw !== 'object') return undefined;
    const d = Object.getOwnPropertyDescriptor(raw, key);
    return d && 'value' in d ? d.value : undefined;
  } catch {
    return undefined;
  }
}
const bool = (value: unknown) => (typeof value === 'boolean' ? value : null);
const sha = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
function member<T extends string>(value: unknown, set: readonly T[]): T | 'unknown' {
  return typeof value === 'string' && (set as readonly string[]).includes(value)
    ? (value as T)
    : 'unknown';
}
/** Do not trust even internal typed diagnostics: rebuild fixed fields and derived values. */
export function sanitizeTrafficDetails(raw: unknown) {
  const source = own(raw, 'rows'),
    length = own(source, 'length');
  let isArray = false;
  try {
    isArray = Array.isArray(source);
  } catch {
    /* Unknown hostile prototype. */
  }
  const rows =
    isArray && typeof length === 'number' && Number.isInteger(length) && length >= 0 && length <= 32
      ? Array.from({ length }, (_, i) => {
          const row = own(source, String(i)),
            percentType = member(own(row, 'percentType'), types),
            tagType = member(own(row, 'tagType'), types),
            uriType = member(own(row, 'uriType'), types),
            value = percent(own(row, 'percentValue'));
          const tagKind = member(own(row, 'tagKind'), tagKinds),
            id = own(row, 'tagRunId'),
            attempt = own(row, 'tagRunAttempt');
          const runValid =
            (tagKind === 'candidate_run_attempt' || tagKind === 'resume_run_attempt') &&
            typeof id === 'string' &&
            /^[0-9]{1,20}$/.test(id) &&
            typeof attempt === 'number' &&
            Number.isInteger(attempt) &&
            attempt >= 1 &&
            attempt <= 999999 &&
            `${id}-${attempt}`.length <= 21;
          return {
            index: i,
            percentType,
            percentPresent: percentType === 'unknown' ? null : percentType !== 'absent',
            percentValue: percentType === 'number' ? value : null,
            protoJsonDefaultZero: percentType === 'absent',
            effectivePercent:
              percentType === 'absent' ? 0 : percentType === 'number' ? value : null,
            tagType,
            tagPresent: tagType === 'unknown' ? null : tagType !== 'absent',
            tagShapeValid: bool(own(row, 'tagShapeValid')),
            tagSha256: sha(own(row, 'tagSha256')),
            tagKind,
            tagRunId: runValid ? id : null,
            tagRunAttempt: runValid ? attempt : null,
            ownershipProven: false,
            uriType,
            uriPresent: uriType === 'unknown' ? null : uriType !== 'absent',
            uriShapeValid: bool(own(row, 'uriShapeValid')),
            uriSha256: sha(own(row, 'uriSha256')),
            uriMatchesTag: bool(own(row, 'uriMatchesTag')),
            revisionSha256: sha(own(row, 'revisionSha256')),
            sameRevisionAsUniqueHundred: bool(own(row, 'sameRevisionAsUniqueHundred')),
          };
        })
      : [];
  return { rows, truncated: bool(own(raw, 'truncated')), diagnosticHintsOnly: true };
}
