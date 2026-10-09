import {
  createPostgresGraphRecallRepository,
  type Db,
  postgresActiveGraphWhere,
} from '@assistant/db';
import type { GraphRecallRepository, GraphRelation as RelationRow } from '@assistant/persistence';
import { GRAPH_EXTRACTION_VERSION } from './knowledge-graph.js';
import type { RecallSource } from './recall.js';
import { createRecallBlock } from './recall-budget.js';
import { recallSourceRevision, recallSurfaceKey } from './recall-surfacing.js';

/**
 * Query-time GraphRAG. Semantic memory matches seed the traversal; relation
 * edges only broaden that high-confidence evidence by two hops at most.
 */

export interface GraphRecallOptions {
  limit?: number;
  minSimilarity?: number;
  maxChars?: number;
  maxEvidenceChars?: number;
  isSuppressed?: (sourceKey: string, sourceRevision: string) => Promise<boolean>;
}

export interface GraphRecallResult {
  block: string;
  used: number;
  candidates: number;
  sources: RecallSource[];
  rankedContext?: Array<{ text: string; score: number; source: RecallSource }>;
}

/**
 * A graph attempt can share its query embedding with standard recall. Keeping
 * that hand-off in the fallback primitive prevents an additive GraphRAG
 * feature from doubling embed cost or changing the availability of chat
 * recall.
 */
export interface GraphRecallAttempt {
  graph: GraphRecallResult;
  queryEmbedding: number[] | undefined;
}

export interface HistoryRecallResult {
  block: string;
  sources: RecallSource[];
  tier?: 'segment' | 'message' | 'blended' | 'none';
  used?: number;
  rankedContext?: Array<{ text: string; score: number; source: RecallSource }>;
}

export interface LayeredRecallResult {
  block: string;
  sources: RecallSource[];
  graph: GraphRecallResult;
  graphFailed: boolean;
  historyFailed: boolean;
  history: HistoryRecallResult;
  rankedContext: Array<{ text: string; score: number; source: RecallSource }>;
}

const DEFAULTS = {
  limit: 3,
  minSimilarity: 0.75,
  maxChars: 1200,
  maxEvidenceChars: 260,
} as const;

const EMPTY: GraphRecallResult = { block: '', used: 0, candidates: 0, sources: [] };
const EMPTY_HISTORY: HistoryRecallResult = { block: '', sources: [], tier: 'none', used: 0 };

const HEADER =
  'Knowledge graph evidence (tense, polarity, and modality are preserved; qualified claims are not current facts):';

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function readablePredicate(value: string): string {
  return value.replace(/_/g, ' ');
}

function relationPath(row: RelationRow): string {
  const span =
    row.validFrom || row.validUntil
      ? ` (${row.validFrom ?? '?'} to ${row.validUntil ?? 'now'})`
      : '';
  const assertion = row.assertion;
  const qualifiers = assertion
    ? [
        assertion.tense !== 'present' && assertion.tense !== 'unspecified' ? assertion.tense : null,
        assertion.polarity === 'negative' ? 'negative' : null,
        assertion.modality !== 'asserted' ? assertion.modality : null,
      ].filter((value): value is string => Boolean(value))
    : ['unverified'];
  const qualification = qualifiers.length ? ` [${qualifiers.join(', ')}]` : '';
  return `${row.subjectLabel} —${readablePredicate(row.predicate)}→ ${row.objectLabel}${span}${qualification}`;
}

function validSimilarity(value: number | string | undefined): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function parseGraphIntervalBound(value: string | null, side: 'from' | 'until'): Date | null {
  if (value === null || value === '') return null;
  const year = /^(\d{4})$/.exec(value);
  if (year) {
    const number = Number(year[1]);
    if (number < 1000 || number > 2999) return null;
    return new Date(Date.UTC(number + (side === 'until' ? 1 : 0), 0, 1));
  }
  const month = /^(\d{4})-(\d{2})$/.exec(value);
  if (month) {
    const yearNumber = Number(month[1]);
    const monthNumber = Number(month[2]);
    if (yearNumber < 1000 || yearNumber > 2999 || monthNumber < 1 || monthNumber > 12) return null;
    return side === 'until'
      ? new Date(Date.UTC(yearNumber, monthNumber, 1))
      : new Date(Date.UTC(yearNumber, monthNumber - 1, 1));
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (day) {
    const yearNumber = Number(day[1]);
    const monthNumber = Number(day[2]);
    const dayNumber = Number(day[3]);
    if (yearNumber < 1000 || yearNumber > 2999) return null;
    const date = new Date(Date.UTC(yearNumber, monthNumber - 1, dayNumber));
    if (
      date.getUTCFullYear() !== yearNumber ||
      date.getUTCMonth() !== monthNumber - 1 ||
      date.getUTCDate() !== dayNumber
    )
      return null;
    return side === 'until' ? new Date(date.getTime() + 86_400_000) : date;
  }
  // Preserve full-precision PostgreSQL timestamps, but require the canonical UTC
  // spelling so an invalid or locale-dependent date cannot become evidence.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value ? date : null;
  }
  return null;
}

function graphIntervalEligible(row: RelationRow, now: Date, allowHistorical: boolean): boolean {
  const hasFrom = row.validFrom !== null && row.validFrom !== '';
  const hasUntil = row.validUntil !== null && row.validUntil !== '';
  const from = hasFrom ? parseGraphIntervalBound(row.validFrom, 'from') : null;
  const until = hasUntil ? parseGraphIntervalBound(row.validUntil, 'until') : null;
  if ((hasFrom && !from) || (hasUntil && !until)) return false;
  if (from && until && from >= until) return false;
  if (from && from > now) return false;
  if (!until || until > now) return true;
  return allowHistorical;
}

function asksForHistoricalGraphState(queryText: string): boolean {
  return /\b(?:before|formerly|former|previously|previous|used\s+to|back\s+then|historical|history|when\s+did)\b/i.test(
    queryText,
  );
}

export function activeGraphWhere(agentId: string) {
  return postgresActiveGraphWhere(agentId, GRAPH_EXTRACTION_VERSION);
}

function graphPathSource(evidence: Array<{ row: RelationRow; hops: 1 | 2 }>): RecallSource {
  const rows = evidence.map((item) => item.row);
  const first = rows[0];
  if (!first) throw new Error('A graph path needs source evidence');
  return {
    date: isoDate(first.createdAt),
    label: clip(
      rows.map((row) => `${row.subjectLabel} ${row.predicate} ${row.objectLabel}`).join('; '),
      80,
    ),
    kind: 'knowledge_graph',
    hops: evidence.some((item) => item.hops === 2) ? 2 : 1,
    // A single assertion keeps its established identity. Multi-assertion paths
    // use every relation ID so hiding one neighbor path cannot hide another.
    surfaceKey: recallSurfaceKey(
      'knowledge_graph',
      rows.length === 1 ? [first.relationId] : rows.map((row) => row.relationId),
    ),
    sourceRevision: recallSourceRevision(
      rows.map((row) => ({
        relationId: row.relationId,
        sourceMemoryId: row.sourceMemoryId,
        assertion: row.assertion,
        validFrom: row.validFrom,
        validUntil: row.validUntil,
        content: row.content,
        evidenceQuote: row.evidenceQuote,
      })),
    ),
    relevance: Math.max(...rows.map((row) => validSimilarity(row.similarity)), 0),
  };
}

/**
 * Retrieve a compact, evidence-labelled graph context. The caller owns query
 * embedding and trust gating; this function never embeds and never throws for
 * a missing/short query, so GraphRAG cannot block a response path.
 */
export async function recallKnowledgeGraph(
  storage: Db | GraphRecallRepository,
  args: { agentId: string; queryText: string; queryEmbedding: number[] | undefined },
  options: GraphRecallOptions = {},
): Promise<GraphRecallResult> {
  const opts = { ...DEFAULTS, ...options };
  const block = createRecallBlock(HEADER, opts.maxChars);
  if (
    args.queryText.replace(/\s+/g, ' ').trim().length < 3 ||
    !args.queryEmbedding ||
    !block.available
  )
    return EMPTY;
  const repository =
    'kind' in storage && storage.kind === 'graph-recall-repository'
      ? (storage as GraphRecallRepository)
      : createPostgresGraphRecallRepository(storage as Db);
  const candidates = await repository.seeds({
    agentId: args.agentId,
    embedding: args.queryEmbedding,
    limit: opts.limit * 4,
    extractionVersion: GRAPH_EXTRACTION_VERSION,
  });
  const now = new Date();
  const allowHistorical = asksForHistoricalGraphState(args.queryText);
  const currentCandidates = candidates.filter((row) =>
    graphIntervalEligible(row, now, allowHistorical),
  );
  const seeds = currentCandidates
    .filter((row) => validSimilarity(row.similarity) >= opts.minSimilarity)
    .filter(
      (row, index, rows) => rows.findIndex((item) => item.relationId === row.relationId) === index,
    );
  const eligibleSeeds = opts.isSuppressed
    ? (
        await Promise.all(
          seeds.map(async (row) => {
            const source = graphPathSource([{ row, hops: 1 }]);
            return (await opts.isSuppressed?.(source.surfaceKey ?? '', source.sourceRevision ?? ''))
              ? null
              : row;
          }),
        )
      )
        .filter((row): row is RelationRow => row !== null)
        .slice(0, opts.limit)
    : seeds.slice(0, opts.limit);
  if (eligibleSeeds.length === 0) return { ...EMPTY, candidates: currentCandidates.length };

  const entityIds = [
    ...new Set(eligibleSeeds.flatMap((row) => [row.subjectEntityId, row.objectEntityId])),
  ];
  const connectedRows = await repository.connected({
    agentId: args.agentId,
    entityIds,
    sourceMemoryIds: eligibleSeeds.map((row) => row.sourceMemoryId),
    limit: opts.limit * 2,
    extractionVersion: GRAPH_EXTRACTION_VERSION,
  });
  const intervalEligibleNeighbors = connectedRows.filter((row) =>
    graphIntervalEligible(row, now, allowHistorical),
  );
  const neighborRows = intervalEligibleNeighbors;

  const entries: string[] = [];
  const sources: RecallSource[] = [];
  const rankedContext: NonNullable<GraphRecallResult['rankedContext']> = [];
  const add = async (entry: string, evidence: Array<{ row: RelationRow; hops: 1 | 2 }>) => {
    const source = graphPathSource(evidence);
    if (
      opts.isSuppressed &&
      (await opts.isSuppressed(source.surfaceKey ?? '', source.sourceRevision ?? ''))
    )
      return false;
    if (!block.add(entry)) return false;
    entries.push(entry);
    sources.push(source);
    rankedContext.push({
      text: entry,
      score: source.relevance ?? 0,
      source,
    });
    return true;
  };

  for (const seed of eligibleSeeds) {
    if (entries.length >= opts.limit) break;
    const evidence = `Evidence: ${clip(seed.evidenceQuote ?? seed.content, opts.maxEvidenceChars)}.`;
    await add(`[1 hop] ${relationPath(seed)}\n  ${evidence}`, [{ row: seed, hops: 1 }]);
  }
  for (const neighbor of neighborRows) {
    if (entries.length >= opts.limit * 2) break;
    const seed = eligibleSeeds.find(
      (candidate) =>
        candidate.subjectEntityId === neighbor.subjectEntityId ||
        candidate.subjectEntityId === neighbor.objectEntityId ||
        candidate.objectEntityId === neighbor.subjectEntityId ||
        candidate.objectEntityId === neighbor.objectEntityId,
    );
    if (!seed) continue;
    const evidence = [
      `Evidence: ${clip(seed.evidenceQuote ?? seed.content, opts.maxEvidenceChars)}.`,
      `Connected evidence: ${clip(neighbor.evidenceQuote ?? neighbor.content, opts.maxEvidenceChars)}.`,
    ].join(' ');
    await add(`[2 hops] ${relationPath(seed)}; ${relationPath(neighbor)}\n  ${evidence}`, [
      { row: seed, hops: 1 },
      { row: neighbor, hops: 2 },
    ]);
  }

  if (entries.length === 0) return { ...EMPTY, candidates: currentCandidates.length };
  return {
    block: block.text,
    used: entries.length,
    candidates: currentCandidates.length,
    sources,
    rankedContext,
  };
}

/** Combine graph and conversation recall without dropping source provenance. */
export function combineRecallBlocks(
  graph: GraphRecallResult,
  history: {
    block: string;
    sources: RecallSource[];
    rankedContext?: Array<{ text: string; score: number; source: RecallSource }>;
  },
): {
  block: string;
  sources: RecallSource[];
  rankedContext: Array<{ text: string; score: number; source: RecallSource }>;
} {
  const sources = [...graph.sources, ...history.sources];
  const rankedContext = [...(graph.rankedContext ?? []), ...(history.rankedContext ?? [])];
  return {
    block: [graph.block, history.block].filter(Boolean).join('\n\n'),
    sources,
    rankedContext,
  };
}

/**
 * Run GraphRAG as an additive, best-effort layer over ordinary conversation
 * recall. Either layer can fail independently: a graph/embed failure falls
 * through to history, while a history failure preserves any usable graph
 * evidence instead of discarding the whole recall result.
 */
export async function recallWithGraphFallback(options: {
  graph?: () => Promise<GraphRecallAttempt>;
  history: (
    queryEmbedding: number[] | undefined,
    graph: GraphRecallResult,
  ) => Promise<HistoryRecallResult>;
  onGraphError?: (error: unknown) => void;
  onHistoryError?: (error: unknown) => void;
}): Promise<LayeredRecallResult> {
  let graph = EMPTY;
  let queryEmbedding: number[] | undefined;
  let graphFailed = false;
  if (options.graph) {
    try {
      ({ graph, queryEmbedding } = await options.graph());
    } catch (error) {
      graphFailed = true;
      options.onGraphError?.(error);
    }
  }
  let history = EMPTY_HISTORY;
  let historyFailed = false;
  try {
    history = await options.history(queryEmbedding, graph);
  } catch (error) {
    historyFailed = true;
    options.onHistoryError?.(error);
  }
  return { ...combineRecallBlocks(graph, history), graph, graphFailed, historyFailed, history };
}
