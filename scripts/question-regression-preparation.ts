import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { QuestionCase } from '../packages/tools/src/question-regression/corpus.js';

export interface QuestionPreparationInput {
  fixtures: QuestionCase[];
  suite: string;
  partition: string;
  version: string;
  sourceCommit: string;
  workingTreeDirty: boolean;
  sourceHashes: Record<string, string>;
  dirtySourceIdentity?: {
    dirtyFileHashes: Record<string, string | null>;
    workingDiffSha256: string;
    scope: string;
  };
  configSha256: string | null;
  blockers: string[];
}

export interface QuestionPreparationManifest {
  manifestVersion: 1;
  mode: 'prepare';
  status: 'not_run';
  suite: string;
  partition: string;
  version: string;
  sourceCommit: string;
  workingTreeDirty: boolean;
  sourceHashes: Record<string, string>;
  dirtySourceIdentity?: {
    dirtyFileHashes: Record<string, string | null>;
    workingDiffSha256: string;
    scope: string;
  };
  configSha256: string | null;
  corpusSha256: string;
  schemaManifestSha256: string;
  blockers: string[];
  claimsLimits: string[];
  cases: Array<Record<string, unknown>>;
}

const secretField = /(?:api[-_]?key|token|secret|authorization|cookie|password|credential)/i;
const bearerValue = /\bBearer\s+[^\s,;]+/gi;
const opaquePaginationField = /^(?:pageToken|nextPageToken)$/i;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Preparation manifest contains a non-JSON value');
  return encoded;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.replace(bearerValue, 'Bearer [redacted]');
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol')
    return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== 'object') return null;
  if (seen.has(value)) throw new TypeError('Preparation fixtures must not contain cyclic data');
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => sanitize(item, seen));
    seen.delete(value);
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (secretField.test(key) && !opaquePaginationField.test(key)) continue;
    result[key] = sanitize(item, seen);
  }
  seen.delete(value);
  return result;
}

function toolManifest(fixture: QuestionCase) {
  return (fixture.localTools ?? []).map((tool) => {
    const schema = z.toJSONSchema(tool.schema);
    return {
      name: tool.name,
      description: tool.description ?? null,
      risk: tool.risk ?? null,
      flags: sanitize(tool.flags ?? null),
      acceptsUntrustedInput: tool.acceptsUntrustedInput ?? null,
      schema,
      schemaSha256: sha256(schema),
      outcomes: sanitize(tool.outcomes),
    };
  });
}

function prepareCase(fixture: QuestionCase): Record<string, unknown> {
  const tools = toolManifest(fixture);
  const setup = sanitize({
    source: fixture.source,
    weather: fixture.weather,
    sports: fixture.sports,
    maps: fixture.maps,
    calendar: fixture.calendar,
    mailbox: fixture.mailbox,
    memory: fixture.memory,
    missingInfo: fixture.missingInfo,
    priorEvidence: fixture.priorEvidence,
    approvalDecision: fixture.approvalDecision,
    retryFailures: fixture.retryFailures,
    verification: fixture.verification,
  });
  return {
    id: fixture.id,
    request: fixture.request,
    history: sanitize(fixture.history ?? []),
    timeZone: fixture.timeZone ?? null,
    frozenAt: fixture.at ?? null,
    setup,
    tools,
    evidenceExpected: {
      records: [...fixture.records],
      expected: sanitize(fixture.expect),
      rubric: sanitize(fixture.independentRubric ?? []),
    },
    run: {
      status: 'not_run',
      modelCalls: null,
      toolCalls: null,
      latencyMs: null,
      tokens: null,
      costUsd: null,
      quality: 'not_evaluated',
    },
  };
}

const claimsLimits = [
  'Selected seam hashes are scoped; the immutable commit and dirty source inventory/diff hash identify additional local code changes, not an exhaustive dependency manifest.',
  'Preparation only: no model, tool, database, or provider execution is performed.',
  'The deterministic private-read routing slice does not establish blanket model quality.',
  'Holdouts present in the supplied corpus are source-exposed and are not blind.',
  'Tool outcomes are synthetic fixtures and do not prove authoritative external effects.',
  'Latency, token usage, cost, and independent quality are unmeasured.',
  'Registered fixture schemas are hashed, but exact model-visible tools, tool choice and provider options are not captured; exact provider-request parity remains unverified.',
];

/** Build a deterministic, non-executing manifest for an explicitly selected synthetic slice. */
export function buildQuestionPreparation(
  input: QuestionPreparationInput,
): QuestionPreparationManifest {
  const ids = new Set<string>();
  for (const fixture of input.fixtures) {
    if (ids.has(fixture.id)) throw new Error(`Duplicate question fixture ID: ${fixture.id}`);
    ids.add(fixture.id);
    if (fixture.executionPath !== 'production-routing')
      throw new Error(`Unsupported fixture ${fixture.id}: expected production-routing`);
    if (fixture.script.length > 0)
      throw new Error(`Unsupported fixture ${fixture.id}: scripted answers are not allowed`);
    if (fixture.plan !== undefined)
      throw new Error(`Unsupported fixture ${fixture.id}: preset plans are not allowed`);
  }

  const cases = input.fixtures.map(prepareCase);
  const corpusContent = cases.map(({ run: _run, ...definition }) => definition);
  const schemaContent = cases.map((entry) => ({
    id: entry.id,
    tools: (entry.tools as Array<Record<string, unknown>>).map(
      ({ name, description, risk, flags, acceptsUntrustedInput, schema, schemaSha256 }) => ({
        name,
        description,
        risk,
        flags,
        acceptsUntrustedInput,
        schema,
        schemaSha256,
      }),
    ),
  }));

  return {
    manifestVersion: 1,
    mode: 'prepare',
    status: 'not_run',
    suite: input.suite,
    partition: input.partition,
    version: input.version,
    sourceCommit: input.sourceCommit,
    workingTreeDirty: input.workingTreeDirty,
    sourceHashes: Object.fromEntries(
      Object.entries(input.sourceHashes).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
    ...(input.dirtySourceIdentity ? { dirtySourceIdentity: input.dirtySourceIdentity } : {}),
    configSha256: input.configSha256,
    corpusSha256: sha256(corpusContent),
    schemaManifestSha256: sha256(schemaContent),
    blockers: [...input.blockers],
    claimsLimits: [...claimsLimits],
    cases,
  };
}
