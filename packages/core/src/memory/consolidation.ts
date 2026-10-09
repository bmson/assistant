import { createHash, randomUUID } from 'node:crypto';
import {
  agents,
  assertPostgresPrivacyObservationFence,
  createPostgresOwnerCardCompilationRepository,
  type Db,
  importSources,
  isTombstoned,
  knowledgeGraphSources,
  lockPostgresPrivacyObservationFence,
  memories,
  memoryImportLineage,
  occasionImportLineage,
  ownerCard,
} from '@assistant/db';
import {
  type ConsolidationMerge,
  canRewriteConsolidationFacts,
  earliestConsolidationSource,
  embeddingSpaceIdentityKey,
  isOwnerCardCompilationRepository,
  isOwnerContextRepository,
  type MemoryConsolidationRepository,
  type OwnerCardCompilationInput,
  type OwnerCardCompilationRepository,
  type OwnerContextRepository,
} from '@assistant/persistence';
import { and, asc, eq, gt, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { BudgetReservationError, nextDailyReset, nextMonthlyReset } from '../cost.js';
import { isUnparseableObjectError, type ModelRouter } from '../model-router/router.js';
import { withSpan } from '../otel.js';
import { MEMORY_DOMAINS } from './extraction.js';
import { saveOccasion } from './occasions.js';
import { isCurrentAt, validitySuffix } from './validity.js';

/**
 * Nightly consolidation (Phase 8): per entity, the model DETECTS duplicate
 * groups, contradiction groups, and same-topic merge groups; the CODE decides
 * winners (confidence-weighted, newer-wins, owner-confirmed always wins),
 * writes unified facts, and expires losers/members with supersededById
 * provenance — superseded facts expire, they are never deleted.
 * Ends by recompiling the owner card.
 */

const ConsolidationFindingsSchema = z.object({
  duplicateGroups: z
    .array(z.array(z.string()).min(2).max(10))
    .max(20)
    .describe('Groups of fact ids that state the SAME thing (possibly in different words).'),
  contradictionGroups: z
    .array(z.array(z.string()).min(2).max(10))
    .max(20)
    .describe('Groups of fact ids that CANNOT all be true at once.'),
  mergeGroups: z
    .array(
      z.object({
        ids: z.array(z.string()).min(2).max(6),
        unified: z.string().min(10).max(300),
      }),
    )
    .max(15)
    .default([])
    .describe(
      'Groups of facts about the SAME topic/attribute that read better as one crisp sentence, with the unified wording. Faithful to the members — no invention, no dropped specifics. Do NOT merge unrelated facts or facts marked [curated].',
    ),
  domainFixes: z
    .array(z.object({ id: z.string(), domain: z.enum(MEMORY_DOMAINS) }))
    .max(40)
    .describe('Facts whose life domain is missing or wrong.'),
  timeline: z
    .array(
      z.object({
        id: z.string(),
        validFrom: z.string().default(''),
        validUntil: z.string().default(''),
      }),
    )
    .max(40)
    .describe(
      'Temporal validity explicitly stated in a fact ("2019–2023", "since March"). ISO dates; empty string = unknown/open.',
    ),
  occasions: z
    .array(
      z.object({
        kind: z.enum(['birthday', 'anniversary', 'custom']),
        label: z.string().max(120).default('').describe('For a custom occasion, what it is.'),
        month: z.number().int().min(1).max(12),
        day: z.number().int().min(1).max(31),
        year: z.number().int().min(1900).max(2200).nullable().default(null),
        notes: z.string().max(500).default('').describe('Gift ideas or context, if mentioned.'),
      }),
    )
    .max(10)
    .default([])
    .describe(
      'Recurring dates for THIS person stated in the facts — birthdays, anniversaries, and other dated events. Only when a specific month and day are given; include the year only if stated.',
    ),
});
type ConsolidationFindings = z.infer<typeof ConsolidationFindingsSchema>;

/** Exported for the write-time supersession check, which shares `pickWinner`. */
export interface FactLite {
  id: string;
  agentId: string;
  content: string;
  kind: string;
  confidence: string;
  importance: number;
  domain: string | null;
  ownerConfirmed: boolean;
  pinned: boolean;
  lastConsolidatedAt: Date | null;
  createdAt: Date;
  validFrom: Date | null;
  validUntil: Date | null;
  importSources?: string[];
  importSourceProvenance?: Array<{
    source: string;
    sourceUnitProvenance: import('@assistant/persistence').ImportUnitProvenance[];
  }>;
}

const MAX_WINDOWS_PER_RUN = 12;
const MAX_FACTS_PER_ENTITY = 60;

function mergeImportUnitProvenance(
  existing: import('@assistant/persistence').ImportUnitProvenance[],
  incoming: import('@assistant/persistence').ImportUnitProvenance[],
): import('@assistant/persistence').ImportUnitProvenance[] {
  const byIdentity = new Map<string, import('@assistant/persistence').ImportUnitProvenance>();
  for (const unit of [...existing, ...incoming]) {
    const key = `${unit.sourceOffset}\0${unit.unitOffset}\0${unit.unitTextHash}`;
    byIdentity.set(key, unit);
  }
  return [...byIdentity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, unit]) => unit);
}

/**
 * The fields precedence actually turns on. Stated as its own type so the
 * write-time supersession check can share this rule without carrying a whole
 * consolidation row — and so the rule stays honest about what it reads.
 */
export type FactPrecedence = Pick<FactLite, 'id' | 'confidence' | 'createdAt' | 'ownerConfirmed'>;

/**
 * Pick the surviving fact of a group. Owner-confirmed beats everything;
 * otherwise confidence-weighted with a newest bonus (newer-wins on ties).
 * Exported for tests.
 */
export function pickWinner<T extends FactPrecedence>(group: T[]): T {
  const newest = group.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  const score = (f: FactPrecedence) =>
    (f.ownerConfirmed ? 10 : 0) + Number(f.confidence) + (f.id === newest.id ? 0.15 : 0);
  return [...group].sort(
    (a, b) => score(b) - score(a) || b.createdAt.getTime() - a.createdAt.getTime(),
  )[0] as T;
}

/** Every retirement ends at a surviving fact; overlapping groups cannot erase a cycle. */
export function flattenFactRetirements(
  proposed: Map<string, string>,
  facts: FactPrecedence[],
): Map<string, string> {
  const edges = new Map(proposed);
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  for (const start of [...edges.keys()]) {
    const path: string[] = [];
    const positions = new Map<string, number>();
    let node = start;
    while (edges.has(node)) {
      const prior = positions.get(node);
      if (prior !== undefined) {
        const cycle = path
          .slice(prior)
          .sort()
          .map((id) => byId.get(id));
        if (cycle.some((fact) => !fact)) throw new Error('Retirement references an unknown fact');
        const winner = pickWinner(cycle as FactPrecedence[]);
        edges.delete(winner.id);
        node = winner.id;
        break;
      }
      positions.set(node, path.length);
      path.push(node);
      const next = edges.get(node);
      if (!next || !byId.has(node) || !byId.has(next))
        throw new Error('Retirement references an unknown fact');
      node = next;
    }
    for (const id of path) {
      if (id === node) edges.delete(id);
      else edges.set(id, node);
    }
  }
  return edges;
}

function parseIsoDate(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value.length === 4 ? `${value}-01-01` : value);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function runFirestoreMemoryConsolidation(
  repository: MemoryConsolidationRepository,
  cardRepository: OwnerCardCompilationRepository,
  router: ModelRouter,
  opts: { taskId?: string; agentId?: string },
  heartbeat?: () => Promise<void>,
): Promise<ConsolidationResult> {
  const embeddingSpace = await router.embeddingSpace();
  const embeddingSpaceKey = embeddingSpaceIdentityKey(embeddingSpace);
  const agentId = opts.agentId;
  if (!agentId) throw new Error('Firestore memory consolidation requires an agent ID');
  const result: ConsolidationResult = {
    entities: 0,
    batches: 0,
    memoriesReviewed: 0,
    standaloneReviewed: 0,
    duplicatesExpired: 0,
    contradictionsResolved: 0,
    factsUnified: 0,
    domainsAssigned: 0,
    occasionsSaved: 0,
    cardCompiled: false,
  };
  const batch = await repository.candidates(agentId);
  await heartbeat?.();
  result.standaloneReviewed = await repository.stampStandalone(agentId, batch.standalone);
  if (batch.window) {
    const { subjectContactId, facts } = batch.window;
    result.entities = 1;
    const byId = new Map(facts.map((fact) => [fact.id, fact]));
    const listing = facts
      .map(
        (fact) =>
          `id=${fact.id} | ${fact.createdAt.toISOString().slice(0, 10)} | validFrom=${fact.validFrom?.toISOString() ?? 'unknown/open'} | validUntil=${fact.validUntil?.toISOString() ?? 'unknown/open'} | conf=${fact.confidence} | domain=${fact.domain ?? '?'}${fact.ownerConfirmed || fact.pinned ? ' | [curated]' : ''} | ${fact.content}`,
      )
      .join('\n');
    const outcome = await router
      .object<ConsolidationFindings>('extract', {
        taskId: opts.taskId,
        schema: ConsolidationFindingsSchema,
        system: [
          "You review one person's memory facts for a personal assistant.",
          'Find exact-or-paraphrase duplicates, direct contradictions, missing/wrong life domains,',
          'explicitly stated temporal validity, and same-topic groups worth merging into one',
          'unified sentence. Refer to facts ONLY by their id.',
          'Do NOT invent contradictions — different facts about the same topic are fine unless they cannot both be true.',
          'Merging: only group fragmented facts about the SAME topic or attribute; invent nothing,',
          'and leave facts marked [curated] alone.',
          'Temporal validity and uncertainty are invariants. Retain historical, future, dated or uncertain claims separately; do not turn them into current timeless wording.',
          'Only report recurring occasions with a specific month and day explicitly stated in a fact.',
        ].join('\n'),
        prompt: listing,
      })
      .catch((err) => {
        if (!isUnparseableObjectError(err)) throw err;
        console.error(
          `memory consolidation: skipping entity ${subjectContactId} the model could not structure`,
          err,
        );
        return null;
      });
    if (!outcome) {
      // Leave this window pending for retry; no partial updates have occurred.
    } else if (!outcome.ok) {
      throw new BudgetReservationError(
        outcome.decision.reason,
        outcome.decision.reason.includes('monthly') ? nextMonthlyReset() : nextDailyReset(),
      );
    } else {
      await heartbeat?.();
      let retirements = new Map<string, string>();
      const chooseLoserRetirements = (groups: string[][]) => {
        for (const group of groups) {
          const members = group.map((id) => byId.get(id)).filter((fact) => fact !== undefined);
          if (!canRewriteConsolidationFacts(members)) continue;
          const winner = pickWinner(members);
          for (const member of members) {
            if (
              member.id !== winner.id &&
              !member.pinned &&
              (!member.ownerConfirmed || winner.ownerConfirmed)
            )
              retirements.set(member.id, winner.id);
          }
        }
      };
      chooseLoserRetirements(outcome.object.duplicateGroups);
      chooseLoserRetirements(outcome.object.contradictionGroups);
      retirements = flattenFactRetirements(retirements, facts);
      const survivors = new Set(retirements.values());
      const replacement = new Map(retirements);
      const mostCommon = (values: Array<string | null>) => {
        const counts = new Map<string, number>();
        for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      };
      const merges: ConsolidationMerge[] = [];
      for (const merge of outcome.object.mergeGroups) {
        const members = merge.ids
          .map((id) => byId.get(id))
          .filter(
            (fact): fact is NonNullable<typeof fact> =>
              fact !== undefined && !fact.ownerConfirmed && !fact.pinned,
          );
        if (
          !canRewriteConsolidationFacts(members) ||
          members.some((member) => replacement.has(member.id) || survivors.has(member.id))
        )
          continue;
        const content = merge.unified.trim();
        const contentHash = createHash('sha256').update(content).digest('hex');
        const [embedding] = await router.embed([content], { expectedSpace: embeddingSpace });
        if (!embedding) continue;
        merges.push({
          id: randomUUID(),
          content,
          contentHash,
          embedding,
          embeddingSpaceKey,
          kind: mostCommon(members.map((member) => member.kind)) ?? 'fact',
          confidence: Math.min(...members.map((member) => Number(member.confidence))).toFixed(2),
          importance: Math.max(...members.map((member) => member.importance)),
          domain: mostCommon(members.map((member) => member.domain)),
          sourceTaskId: opts.taskId ?? null,
          memberIds: members.map((member) => member.id),
        });
        const created = merges.at(-1);
        if (created) for (const member of members) replacement.set(member.id, created.id);
      }
      const fixes = outcome.object.domainFixes.filter((fix) => byId.has(fix.id));
      const timeline = outcome.object.timeline.flatMap((item) => {
        if (!byId.has(item.id)) return [];
        const original = byId.get(item.id);
        const proposedFrom = parseIsoDate(item.validFrom);
        const proposedUntil = parseIsoDate(item.validUntil);
        const validFrom =
          original?.validFrom && proposedFrom && proposedFrom < original.validFrom
            ? original.validFrom
            : proposedFrom;
        const validUntil =
          original?.validUntil && proposedUntil && proposedUntil > original.validUntil
            ? original.validUntil
            : proposedUntil;
        const effectiveFrom = validFrom ?? original?.validFrom;
        const effectiveUntil = validUntil ?? original?.validUntil;
        if (effectiveFrom && effectiveUntil && effectiveFrom > effectiveUntil) return [];
        return validFrom || validUntil
          ? [
              {
                id: item.id,
                ...(validFrom ? { validFrom } : {}),
                ...(validUntil ? { validUntil } : {}),
              },
            ]
          : [];
      });
      const applied = await repository.applyReview({
        agentId,
        subjectContactId,
        facts,
        retirements: [...retirements].map(([id, supersededById]) => ({ id, supersededById })),
        merges,
        domainFixes: fixes.filter((fix) => byId.get(fix.id)?.domain !== fix.domain),
        timeline,
        occasions: outcome.object.occasions,
      });
      result.batches = 1;
      result.memoriesReviewed = facts.filter((fact) => fact.lastConsolidatedAt === null).length;
      result.duplicatesExpired = applied.retired.filter((id) =>
        outcome.object.duplicateGroups.some((group) => group.includes(id)),
      ).length;
      result.contradictionsResolved = applied.retired.filter((id) =>
        outcome.object.contradictionGroups.some((group) => group.includes(id)),
      ).length;
      result.factsUnified = applied.merged.reduce(
        (count, id) => count + (merges.find((merge) => merge.id === id)?.memberIds.length ?? 0),
        0,
      );
      result.domainsAssigned = applied.domainsAssigned.length;
      result.occasionsSaved = applied.occasionsSaved ?? 0;
    }
  }
  await heartbeat?.();
  await compileOwnerCard(cardRepository, agentId, new Date());
  result.cardCompiled = true;
  return result;
}

export interface ConsolidationResult {
  entities: number;
  batches: number;
  memoriesReviewed: number;
  standaloneReviewed: number;
  duplicatesExpired: number;
  contradictionsResolved: number;
  factsUnified: number;
  domainsAssigned: number;
  occasionsSaved: number;
  cardCompiled: boolean;
}

/** Lock all contributing source rows in a stable order before derived writes. */
async function withConsolidationSourceFence<T>(
  db: Db,
  input: {
    agentId: string;
    sources: readonly string[];
    observedPrivacyFence: string | null;
  },
  write: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await lockPostgresPrivacyObservationFence(tx, input.agentId);
    await assertPostgresPrivacyObservationFence(tx, input.agentId, input.observedPrivacyFence);
    const sources = [...new Set(input.sources)].sort();
    if (sources.length) {
      const rows = await transaction
        .select({
          source: importSources.source,
          agentId: importSources.agentId,
          status: importSources.status,
        })
        .from(importSources)
        .where(
          and(eq(importSources.agentId, input.agentId), inArray(importSources.source, sources)),
        )
        .orderBy(asc(importSources.source))
        .for('share');
      if (
        rows.length !== sources.length ||
        rows.some(
          (row, index) =>
            row.agentId !== input.agentId ||
            row.source !== sources[index] ||
            row.status === 'purged',
        )
      )
        throw new Error('An imported source changed while consolidation was in flight');
    }
    return write(tx);
  });
}

export async function runMemoryConsolidation(
  deps: {
    db: Db;
    router: ModelRouter;
    heartbeat?: () => Promise<void>;
    persistence?: import('@assistant/persistence').ExecutionPersistence;
  },
  opts: { taskId?: string; agentId?: string } = {},
): Promise<ConsolidationResult> {
  if (deps.persistence?.driver === 'firestore') {
    const repository = deps.persistence.memoryConsolidation;
    if (!repository)
      throw new Error('Memory consolidation repository is missing from Firestore persistence');
    if (!opts.agentId) throw new Error('Firestore memory consolidation requires an agent ID');
    return runFirestoreMemoryConsolidation(
      repository,
      deps.persistence.ownerCardCompilation,
      deps.router,
      opts,
      deps.heartbeat,
    );
  }
  const { db, router } = deps;
  const embeddingSpace = await router.embeddingSpace();
  const embeddingSpaceKey = embeddingSpaceIdentityKey(embeddingSpace);
  // Capture the owner's privacy generation before reading facts or invoking the
  // model. Every later publication compares this token while holding the
  // owner lock, so a suspended review cannot republish pre-erasure content.
  const observedPrivacyFences = await db.transaction(async (transaction) => {
    const owners = opts.agentId
      ? await transaction.select({ id: agents.id }).from(agents).where(eq(agents.id, opts.agentId))
      : await transaction.select({ id: agents.id }).from(agents).orderBy(asc(agents.id));
    const observed = new Map<string, string | null>();
    for (const owner of owners)
      observed.set(
        owner.id,
        await lockPostgresPrivacyObservationFence(transaction as unknown as Db, owner.id),
      );
    if (opts.agentId && !observed.has(opts.agentId))
      throw new Error('Consolidation owner is unavailable');
    return observed;
  });
  return withSpan('memory.consolidate', {}, async () => {
    const result: ConsolidationResult = {
      entities: 0,
      batches: 0,
      memoriesReviewed: 0,
      standaloneReviewed: 0,
      duplicatesExpired: 0,
      contradictionsResolved: 0,
      factsUnified: 0,
      domainsAssigned: 0,
      occasionsSaved: 0,
      cardCompiled: false,
    };

    const activeFacts = and(
      opts.agentId ? eq(memories.agentId, opts.agentId) : undefined,
      eq(memories.category, 'knowledge'),
      eq(memories.quarantined, false),
      or(isNull(memories.expiresAt), gt(memories.expiresAt, sql`now()`)),
    );

    // A fact with no subject, or the only fact about a person, has nothing it
    // can be compared with. Treat it as organized instead of leaving it in the
    // owner's backlog forever. This is a lifecycle stamp, not a content rewrite.
    const singletonEntities = await db
      .select({ subjectContactId: memories.subjectContactId, n: sql<number>`count(*)` })
      .from(memories)
      .where(and(activeFacts, sql`${memories.subjectContactId} IS NOT NULL`))
      .groupBy(memories.subjectContactId)
      .having(sql`count(*) = 1`);
    const singletonIds = singletonEntities
      .map((row) => row.subjectContactId)
      .filter((id): id is string => Boolean(id));
    const standaloneReviewed = await db
      .update(memories)
      .set({ lastConsolidatedAt: sql`now()` })
      .where(
        and(
          activeFacts,
          isNull(memories.lastConsolidatedAt),
          or(
            isNull(memories.subjectContactId),
            singletonIds.length > 0 ? inArray(memories.subjectContactId, singletonIds) : undefined,
          ),
        ),
      )
      .returning({ id: memories.id });
    result.standaloneReviewed = standaloneReviewed.length;

    // Work in bounded windows rather than taking one window per person. A
    // large owner profile can otherwise take dozens of manual clicks while
    // small profiles consume the rest of the run. Re-querying after each
    // window keeps null (never-reviewed) facts at the front of the queue.
    const processedEntities = new Set<string>();
    const failedEntities = new Set<string>();
    for (let window = 0; window < MAX_WINDOWS_PER_RUN; window += 1) {
      await deps.heartbeat?.();
      const [entity] = await db
        .select({ subjectContactId: memories.subjectContactId })
        .from(memories)
        .where(
          and(
            activeFacts,
            sql`${memories.subjectContactId} IS NOT NULL`,
            failedEntities.size > 0
              ? notInArray(memories.subjectContactId, [...failedEntities])
              : undefined,
          ),
        )
        .groupBy(memories.subjectContactId)
        .having(
          sql`count(*) >= 2 AND count(*) FILTER (WHERE ${memories.lastConsolidatedAt} IS NULL) > 0`,
        )
        .orderBy(
          sql`min(${memories.lastConsolidatedAt}) asc nulls first`,
          sql`count(*) FILTER (WHERE ${memories.lastConsolidatedAt} IS NULL) desc`,
        )
        .limit(1);
      if (!entity) break;
      if (!entity.subjectContactId) continue;
      processedEntities.add(entity.subjectContactId);
      result.entities = processedEntities.size;
      const facts: FactLite[] = await db
        .select({
          id: memories.id,
          agentId: memories.agentId,
          content: memories.content,
          kind: memories.kind,
          confidence: memories.confidence,
          importance: memories.importance,
          domain: memories.domain,
          ownerConfirmed: memories.ownerConfirmed,
          pinned: memories.pinned,
          lastConsolidatedAt: memories.lastConsolidatedAt,
          createdAt: memories.createdAt,
          validFrom: memories.validFrom,
          validUntil: memories.validUntil,
        })
        .from(memories)
        .where(and(activeFacts, eq(memories.subjectContactId, entity.subjectContactId)))
        // rotation: least-recently-reviewed facts first, so an entity with more
        // than MAX_FACTS_PER_ENTITY facts is groomed in full over several runs
        // instead of re-reviewing the same oldest window forever
        .orderBy(sql`${memories.lastConsolidatedAt} asc nulls first`, memories.createdAt)
        .limit(MAX_FACTS_PER_ENTITY);
      if (facts.length < 2) continue;
      const lineageRows = await db
        .select({
          memoryId: memoryImportLineage.memoryId,
          source: memoryImportLineage.source,
          sourceUnitProvenance: memoryImportLineage.sourceUnitProvenance,
        })
        .from(memoryImportLineage)
        .where(
          inArray(
            memoryImportLineage.memoryId,
            facts.map((fact) => fact.id),
          ),
        );
      const sourcesByMemory = new Map<string, string[]>();
      const provenanceByMemory = new Map<
        string,
        Map<string, import('@assistant/persistence').ImportUnitProvenance[]>
      >();
      for (const row of lineageRows) {
        const sources = sourcesByMemory.get(row.memoryId) ?? [];
        sources.push(row.source);
        sourcesByMemory.set(row.memoryId, sources);
        const sourcesForMemory = provenanceByMemory.get(row.memoryId) ?? new Map();
        sourcesForMemory.set(row.source, row.sourceUnitProvenance);
        provenanceByMemory.set(row.memoryId, sourcesForMemory);
      }
      for (const fact of facts) {
        fact.importSources = sourcesByMemory.get(fact.id) ?? [];
        fact.importSourceProvenance = [...(provenanceByMemory.get(fact.id) ?? new Map())].map(
          ([source, sourceUnitProvenance]) => ({ source, sourceUnitProvenance }),
        );
      }
      result.entities += 1;

      const byId = new Map(facts.map((f) => [f.id, f]));
      const listing = facts
        .map(
          (f) =>
            `id=${f.id} | ${f.createdAt.toISOString().slice(0, 10)} | validFrom=${f.validFrom?.toISOString() ?? 'unknown/open'} | validUntil=${f.validUntil?.toISOString() ?? 'unknown/open'} | conf=${f.confidence} | domain=${f.domain ?? '?'}${f.ownerConfirmed || f.pinned ? ' | [curated]' : ''} | ${f.content}`,
        )
        .join('\n');

      // One entity whose facts the model can't structure (even on the fallback)
      // must not fail the whole nightly consolidation into a dead-letter — skip
      // it and carry on. Budget stops still park; other errors still surface.
      const outcome = await router
        .object<ConsolidationFindings>('extract', {
          taskId: opts.taskId,
          schema: ConsolidationFindingsSchema,
          system: [
            "You review one person's memory facts for a personal assistant.",
            'Find exact-or-paraphrase duplicates, direct contradictions, missing/wrong life domains,',
            'explicitly stated temporal validity, and same-topic groups worth merging into one',
            'unified sentence. Refer to facts ONLY by their id.',
            'Do NOT invent contradictions — different facts about the same topic are fine unless they cannot both be true.',
            'Merging: only group fragmented facts about the SAME topic or attribute whose combined',
            'sentence loses nothing ("drinks coffee black" + "prefers espresso after lunch" →',
            '"Drinks coffee black; espresso after lunch"). Keep every specific, invent nothing,',
            'and leave facts marked [curated] alone.',
            'Temporal validity and uncertainty are invariants. Retain historical, future, dated or uncertain claims separately; do not turn them into current timeless wording.',
            'Occasions: if a fact states a recurring date for THIS person (a birthday,',
            'anniversary, or other dated event with a specific month and day), surface it in',
            'the occasions array so it can be reminded at lead time. Include the year only if',
            'stated. Do not guess a date that is not written in a fact.',
          ].join('\n'),
          prompt: listing,
        })
        .catch((err) => {
          if (!isUnparseableObjectError(err)) throw err;
          console.error(
            `memory consolidation: skipping entity ${entity.subjectContactId} the model could not structure`,
            err,
          );
          return null;
        });
      if (outcome === null) {
        failedEntities.add(entity.subjectContactId);
        continue;
      }
      await deps.heartbeat?.();
      if (!outcome.ok) {
        throw new BudgetReservationError(
          outcome.decision.reason,
          outcome.decision.reason.includes('monthly') ? nextMonthlyReset() : nextDailyReset(),
        );
      }

      const expireLosers = async (group: string[], kind: 'duplicate' | 'contradiction') => {
        const members = group.map((id) => byId.get(id)).filter((f): f is FactLite => Boolean(f));
        if (!canRewriteConsolidationFacts(members)) return;
        const winner = pickWinner(members);
        const ownerId = members[0]?.agentId;
        if (!ownerId || members.some((fact) => fact.agentId !== ownerId))
          throw new Error('Consolidation facts cross owner boundaries');
        const expired = await withConsolidationSourceFence(
          db,
          {
            agentId: ownerId,
            sources: members.flatMap((fact) => fact.importSources ?? []),
            observedPrivacyFence: observedPrivacyFences.get(ownerId) ?? null,
          },
          async (tx) => {
            const ids: string[] = [];
            for (const loser of members) {
              if (loser.id === winner.id || loser.pinned) continue;
              // never silently expire an owner-confirmed fact in favor of an unconfirmed one
              if (loser.ownerConfirmed && !winner.ownerConfirmed) continue;
              const [updated] = await tx
                .update(memories)
                .set({ expiresAt: sql`now()`, supersededById: winner.id })
                .where(and(eq(memories.id, loser.id), eq(memories.agentId, ownerId)))
                .returning({ id: memories.id });
              if (updated) ids.push(updated.id);
            }
            return ids;
          },
        );
        for (const id of expired) {
          byId.delete(id);
          if (kind === 'duplicate') result.duplicatesExpired += 1;
          else result.contradictionsResolved += 1;
        }
      };

      for (const group of outcome.object.duplicateGroups) await expireLosers(group, 'duplicate');
      for (const group of outcome.object.contradictionGroups)
        await expireLosers(group, 'contradiction');

      const mostCommon = (values: Array<string | null>): string | null => {
        const counts = new Map<string, number>();
        for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      };

      for (const merge of outcome.object.mergeGroups) {
        const members = merge.ids
          .map((id) => byId.get(id))
          .filter((f): f is FactLite => Boolean(f))
          // owner-curated wording is sacrosanct — never fold it into a rewrite
          .filter((f) => !f.ownerConfirmed && !f.pinned);
        if (!canRewriteConsolidationFacts(members)) continue;
        const unified = merge.unified.trim();
        const contentHash = createHash('sha256').update(unified).digest('hex');
        if (await isTombstoned(db, contentHash)) continue;
        const [embedding] = await router.embed([unified], { expectedSpace: embeddingSpace });
        await deps.heartbeat?.();
        const ownerId = members[0]?.agentId;
        if (!ownerId || members.some((fact) => fact.agentId !== ownerId))
          throw new Error('Consolidation merge crosses owner boundaries');
        const row = await withConsolidationSourceFence(
          db,
          {
            agentId: ownerId,
            sources: members.flatMap((member) => member.importSources ?? []),
            observedPrivacyFence: observedPrivacyFences.get(ownerId) ?? null,
          },
          async (tx) => {
            const [inserted] = await tx
              .insert(memories)
              .values({
                agentId: ownerId,
                category: 'knowledge',
                kind: mostCommon(members.map((m) => m.kind)) ?? 'fact',
                content: unified,
                contentHash,
                embedding,
                embeddingSpaceKey,
                importance: Math.max(...members.map((m) => m.importance)),
                // a unified claim is only as reliable as its shakiest member
                confidence: Math.min(...members.map((m) => Number(m.confidence))).toFixed(2),
                originTrust: 'assistant',
                subjectContactId: entity.subjectContactId,
                domain: mostCommon(members.map((m) => m.domain)),
                sourceTaskId: opts.taskId,
                lastConsolidatedAt: sql`now()`,
                createdAt: earliestConsolidationSource(members),
              })
              .onConflictDoNothing({ target: memories.contentHash })
              .returning();
            if (!inserted) return null;
            const derivedSources = [
              ...new Set(members.flatMap((member) => member.importSources ?? [])),
            ];
            if (derivedSources.length) {
              const sourceUnits = new Map<
                string,
                import('@assistant/persistence').ImportUnitProvenance[]
              >();
              for (const member of members)
                for (const provenance of member.importSourceProvenance ?? []) {
                  const prior = sourceUnits.get(provenance.source) ?? [];
                  sourceUnits.set(provenance.source, [
                    ...prior,
                    ...provenance.sourceUnitProvenance,
                  ]);
                }
              await tx
                .insert(memoryImportLineage)
                .values(
                  derivedSources.map((source) => ({
                    source,
                    memoryId: inserted.id,
                    sourceUnitProvenance: mergeImportUnitProvenance(
                      [],
                      sourceUnits.get(source) ?? [],
                    ),
                  })),
                )
                .onConflictDoNothing();
            }
            for (const member of members)
              await tx
                .update(memories)
                .set({ expiresAt: sql`now()`, supersededById: inserted.id })
                .where(and(eq(memories.id, member.id), eq(memories.agentId, ownerId)));
            return inserted;
          },
        );
        if (!row) continue; // unified wording already stored
        for (const member of members) {
          byId.delete(member.id);
          result.factsUnified += 1;
        }
      }

      for (const fix of outcome.object.domainFixes) {
        const fact = byId.get(fix.id);
        if (!fact || fact.domain === fix.domain) continue;
        const [updated] = await withConsolidationSourceFence(
          db,
          {
            agentId: fact.agentId,
            sources: fact.importSources ?? [],
            observedPrivacyFence: observedPrivacyFences.get(fact.agentId) ?? null,
          },
          (tx) =>
            tx
              .update(memories)
              .set({ domain: fix.domain })
              .where(and(eq(memories.id, fix.id), eq(memories.agentId, fact.agentId)))
              .returning({ id: memories.id }),
        );
        if (updated) result.domainsAssigned += 1;
      }

      for (const t of outcome.object.timeline) {
        const fact = byId.get(t.id);
        if (!fact) continue;
        const proposedFrom = parseIsoDate(t.validFrom);
        const proposedUntil = parseIsoDate(t.validUntil);
        const validFrom =
          fact.validFrom && proposedFrom && proposedFrom < fact.validFrom
            ? fact.validFrom
            : proposedFrom;
        const validUntil =
          fact.validUntil && proposedUntil && proposedUntil > fact.validUntil
            ? fact.validUntil
            : proposedUntil;
        const effectiveFrom = validFrom ?? fact.validFrom;
        const effectiveUntil = validUntil ?? fact.validUntil;
        if (effectiveFrom && effectiveUntil && effectiveFrom > effectiveUntil) continue;
        if (!validFrom && !validUntil) continue;
        await withConsolidationSourceFence(
          db,
          {
            agentId: fact.agentId,
            sources: fact.importSources ?? [],
            observedPrivacyFence: observedPrivacyFences.get(fact.agentId) ?? null,
          },
          async (tx) => {
            const [updated] = await tx
              .update(memories)
              .set({
                ...(validFrom ? { validFrom } : {}),
                ...(validUntil ? { validUntil } : {}),
              })
              .where(and(eq(memories.id, t.id), eq(memories.agentId, fact.agentId)))
              .returning({ id: memories.id });
            if (updated)
              await tx
                .update(knowledgeGraphSources)
                .set({ extractionVersion: 0 })
                .where(eq(knowledgeGraphSources.memoryId, t.id));
          },
        );
      }

      // Backfill occasions from dates already stated in this person's facts, so
      // a birthday captured before occasion-mining existed (or imported as plain
      // text) still populates the Occasions panel and morning brief. Derived
      // from already-vetted active facts → not quarantined; saveOccasion is an
      // idempotent upsert, so re-running never duplicates. A bad date is skipped
      // rather than failing the whole pass.
      const occasionContactId = entity.subjectContactId;
      if (!occasionContactId) continue;
      for (const occ of outcome.object.occasions ?? []) {
        try {
          const occasionOwnerId = facts[0]?.agentId;
          if (!occasionOwnerId) throw new Error('Consolidation occasion has no owner');
          const derivedSources = [...new Set(facts.flatMap((fact) => fact.importSources ?? []))];
          const saved = await withConsolidationSourceFence(
            db,
            {
              agentId: occasionOwnerId,
              sources: derivedSources,
              observedPrivacyFence: observedPrivacyFences.get(occasionOwnerId) ?? null,
            },
            async (tx) => {
              const result = await saveOccasion(tx, {
                agentId: occasionOwnerId,
                contactId: occasionContactId,
                kind: occ.kind,
                label: occ.label,
                month: occ.month,
                day: occ.day,
                year: occ.year,
                notes: occ.notes,
                originTrust: 'assistant',
                quarantined: false,
                source: 'consolidation',
              });
              if (derivedSources.length)
                await tx
                  .insert(occasionImportLineage)
                  .values(
                    derivedSources.map((source) => ({ source, occasionId: result.occasion.id })),
                  )
                  .onConflictDoNothing();
              return result;
            },
          );
          if (saved.saved) result.occasionsSaved += 1;
        } catch (err) {
          console.error('memory consolidation: skipping unsavable occasion', err);
        }
      }

      // everything reviewed this round goes to the back of the rotation queue
      await db
        .update(memories)
        .set({ lastConsolidatedAt: sql`now()` })
        .where(
          inArray(
            memories.id,
            facts.map((f) => f.id),
          ),
        );
      result.batches += 1;
      result.memoriesReviewed += facts.filter((fact) => fact.lastConsolidatedAt === null).length;
    }

    await deps.heartbeat?.();
    await compileOwnerCard(db);
    result.cardCompiled = true;
    return result;
  });
}

const CARD_DOMAIN_ORDER = [
  'identity',
  'work',
  'home',
  'relationships',
  'preferences',
  'health',
  'other',
] as const;
/** Exported so the Profile page can mark exactly which facts are in the card. */
export const CARD_AUTO_FACTS_PER_DOMAIN = 2;
export const CARD_AUTO_MIN_IMPORTANCE = 4;
const CARD_PEOPLE_LIMIT = 5;
const CARD_PEOPLE_MIN_FACTS = 3;

/** Deterministic rendering shared by PostgreSQL and Firestore compilation adapters. */
export function renderOwnerCard(input: OwnerCardCompilationInput, now: Date): string {
  const lines: string[] = [];
  let omitted = 0;
  for (const domain of CARD_DOMAIN_ORDER) {
    const inDomain = input.ownerFacts.filter((fact) => (fact.domain ?? 'other') === domain);
    const chosen = [
      ...inDomain.filter((fact) => fact.pinned),
      ...inDomain
        .filter(
          (fact) =>
            !fact.pinned &&
            fact.importance >= CARD_AUTO_MIN_IMPORTANCE &&
            isCurrentAt(fact.validUntil, now, fact.validFrom),
        )
        .slice(0, CARD_AUTO_FACTS_PER_DOMAIN),
    ];
    omitted += inDomain.length - chosen.length;
    if (chosen.length === 0) continue;
    lines.push(`${domain[0]?.toUpperCase()}${domain.slice(1)}:`);
    for (const fact of chosen) {
      const hedge = Number(fact.confidence) < 0.5 ? ' (unconfirmed)' : '';
      lines.push(`- ${fact.content}${validitySuffix(fact, now)}${hedge}`);
    }
  }
  const people = input.people
    .filter(
      (person) =>
        person.relationship ||
        person.factCount >= CARD_PEOPLE_MIN_FACTS ||
        person.pinnedFacts.length > 0,
    )
    .sort(
      (a, b) =>
        (b.pinnedFacts.length > 0 ? 1 : 0) - (a.pinnedFacts.length > 0 ? 1 : 0) ||
        b.factCount - a.factCount,
    )
    .slice(0, CARD_PEOPLE_LIMIT);
  const peopleOmitted = input.people.length - people.length;
  if (people.length > 0) {
    lines.push('People:');
    for (const person of people) {
      lines.push(`- ${person.name}${person.relationship ? ` (${person.relationship})` : ''}`);
      for (const fact of person.pinnedFacts) lines.push(`  - ${fact}`);
    }
  }
  const extras: string[] = [];
  if (omitted > 0) extras.push(`${omitted} more owner facts`);
  if (peopleOmitted > 0) extras.push(`${peopleOmitted} more people`);
  if (extras.length > 0)
    lines.push(`(+${extras.join(' and ')} in memory — use memory.recall to look them up.)`);
  return lines.join('\n');
}

/**
 * Deterministic (model-free) owner-card compile, kept deliberately small:
 * facts the owner PINNED always make the card; beyond those, only a couple
 * of HIGH-IMPORTANCE facts per life domain are auto-selected — ordinary
 * extracted facts (importance 3) never auto-surface. Everything else stays
 * out of the prompt and is reachable on demand via memory.recall — the
 * card's footer tells the model how much that covers.
 * Rebuilt nightly after consolidation and on demand from the Profile page.
 */
export function compileOwnerCard(db: Db, now?: Date): Promise<string>;
export function compileOwnerCard(
  repository: OwnerCardCompilationRepository,
  agentId: string,
  now?: Date,
): Promise<string>;
export async function compileOwnerCard(
  store: Db | OwnerCardCompilationRepository,
  agentIdOrNow: string | Date = new Date(),
  repositoryNow: Date = new Date(),
): Promise<string> {
  if (isOwnerCardCompilationRepository(store)) {
    if (typeof agentIdOrNow !== 'string')
      throw new Error('Owner card compilation repository requires an agent ID');
    return store.compile({
      agentId: agentIdOrNow,
      now: repositoryNow,
      render: (input) => renderOwnerCard(input, repositoryNow),
    });
  }
  const db = store;
  const now = agentIdOrNow instanceof Date ? agentIdOrNow : repositoryNow;
  const configured = await db.select({ id: agents.id }).from(agents).limit(2);
  if (configured.length !== 1 || !configured[0])
    throw new Error('Owner card compilation requires exactly one configured agent');
  return compileOwnerCard(createPostgresOwnerCardCompilationRepository(db), configured[0].id, now);
}

/** The compiled card for prompt injection ('' when never compiled). */
export function getOwnerCard(db: Db): Promise<string>;
export function getOwnerCard(repository: OwnerContextRepository, agentId: string): Promise<string>;
export function getOwnerCard(store: Db | OwnerContextRepository, agentId?: string): Promise<string>;
export async function getOwnerCard(
  store: Db | OwnerContextRepository,
  agentId?: string,
): Promise<string> {
  if (isOwnerContextRepository(store)) {
    if (!agentId) throw new Error('Owner card repository reads require an agent ID');
    return (await store.getOwnerCard(agentId))?.content ?? '';
  }
  const [row] = await store.select().from(ownerCard).where(eq(ownerCard.id, 1)).limit(1);
  return row?.content ?? '';
}
