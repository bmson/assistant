import { randomUUID } from 'node:crypto';
import { getAgent } from '@assistant/core/chat';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/core/memory/knowledge-graph';
import {
  agents,
  createDb,
  createPostgresGraphRecallRepository,
  createPostgresMemoryToolRepository,
  type Db,
  knowledgeGraphAssertionEvidence,
  knowledgeGraphAssertions,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
} from '@assistant/db';
import { embeddingSpaceIdentityKey } from '@assistant/persistence';
import { and, eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addOwnerKnowledgeGraphFact,
  correctKnowledgeGraphRelation,
  findDuplicateKnowledgeGraphEntities,
  getKnowledgeGraphMapSummary,
  getKnowledgeGraphNeighborhood,
  getKnowledgeGraphOverview,
  getKnowledgeGraphPaths,
  getKnowledgeGraphRelation,
  retypeKnowledgeGraphEntity,
  reviewKnowledgeGraphRelation,
  searchKnowledgeGraphEntities,
} from './knowledge-graph.js';
import {
  getKnowledgeCleanupFindings,
  getKnowledgeMapSnapshot,
  getKnowledgeSourceImpact,
} from './knowledge-workspace.js';
import { listMemoryLibrary } from './profile/queries.js';

/**
 * The review page used to report the graph as smaller than it is: a 60-row cap
 * with no total, a degree that was really a page size, and a merge list that
 * simply stopped at 200 entities. These assert the counts are the true ones.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-kgview-${Date.now()}`;
// Above the application layer's 80-row relation cap on purpose: these tests
// exist to prove the reported counts are queried rather than taken from the
// page, and a fixture that fits inside the cap cannot show the difference.
const ENTITY_COUNT = 85;

let db: Db;
let dbUp = false;
let agentId: string;
let hubId: string;
let sourceMemoryId: string;

/** A fixed non-null embedding: recall eligibility requires one. */
function unitVector(): number[] {
  const vector = new Array(1536).fill(0);
  vector[3] = 1;
  return vector;
}

const graphRouter = {
  async embeddingSpace() {
    return { provider: 'test', model: 'embedding', dimensions: 1536, revision: '1' };
  },
  async embed() {
    return [unitVector()];
  },
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    // getKnowledgeGraphOverview is deliberately the single owner's view and
    // resolves the agent itself, so the fixture has to hang off that same
    // agent rather than a private one. Seed it only if the database has none.
    let agentId_: string;
    try {
      agentId_ = (await getAgent(db)).id;
    } catch {
      const [created] = await db
        .insert(agents)
        .values({
          name: 'Knowledge Graph View Test',
          email: `${MARKER}@example.com`,
          workspacePrefix: MARKER,
        })
        .returning({ id: agents.id });
      if (!created) throw new Error('test agent was not created');
      agentId_ = created.id;
    }
    agentId = agentId_;

    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} hub relates to everything.`,
        contentHash: `${MARKER}-source`,
        confidence: '0.90',
        embedding: unitVector(),
        embeddingSpaceKey: embeddingSpaceIdentityKey(await graphRouter.embeddingSpace()),
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');
    sourceMemoryId = memory.id;

    // The edges below are recall-eligible only with a ready, current
    // checkpoint whose hash matches the memory — the same contract GraphRAG
    // enforces, which is what the active-count tests now pin.
    await db.insert(knowledgeGraphSources).values({
      memoryId: memory.id,
      contentHash: `${MARKER}-source`,
      status: 'ready',
      extractionVersion: GRAPH_EXTRACTION_VERSION,
    });

    const [hub] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `topic:${MARKER} hub`,
        label: `${MARKER} hub`,
        kind: 'topic',
      })
      .returning({ id: knowledgeGraphEntities.id });
    if (!hub) throw new Error('test hub entity was not created');
    hubId = hub.id;

    // Padded so lexical order matches numeric order, and every spoke is joined
    // to the hub so the hub's degree exceeds the 80-row relation cap.
    const spokes = await db
      .insert(knowledgeGraphEntities)
      .values(
        Array.from({ length: ENTITY_COUNT }, (_, index) => ({
          agentId,
          canonicalKey: `organization:${MARKER} spoke ${String(index).padStart(3, '0')}`,
          label: `${MARKER} spoke ${String(index).padStart(3, '0')}`,
          kind: 'organization',
        })),
      )
      .returning({ id: knowledgeGraphEntities.id });

    await db.insert(knowledgeGraphRelations).values(
      spokes.map((spoke, index) => ({
        agentId,
        subjectEntityId: hubId,
        predicate: 'relates_to',
        objectEntityId: spoke.id,
        sourceMemoryId: memory.id,
        evidenceQuote: `${MARKER} hub relates to everything`,
        sourceFingerprint: `${MARKER}-fp-${index}`,
        ordinal: index + 1,
        confidence: '0.90',
      })),
    );
    dbUp = true;
  } catch {
    console.warn('knowledge-graph.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    // The agent is shared, so only the marked fixtures come out. Relations
    // cascade from their source memory; entities are keyed by marker.
    await db.delete(memories).where(like(memories.content, `${MARKER}%`));
    await db
      .delete(knowledgeGraphEntities)
      .where(like(knowledgeGraphEntities.canonicalKey, `%${MARKER}%`));
    await db.delete(agents).where(eq(agents.email, `${MARKER}@example.com`));
  }
  await (db as unknown as { $client?: { end: () => Promise<void> } }).$client?.end?.();
});

describe('knowledge graph overview (integration)', () => {
  it("reports each library memory's active source-backed connection count", async (ctx) => {
    if (!dbUp) return ctx.skip();
    const library = await listMemoryLibrary(db, {
      state: 'in-use',
      filter: 'all',
      query: MARKER,
      page: 1,
    });
    const row = library.rows.find((item) => item.memory.id === sourceMemoryId);
    expect(row?.connectionCount).toBe(ENTITY_COUNT);
  });

  it('reports the true match count, not the size of the page it returned', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const overview = await getKnowledgeGraphOverview(db, { query: MARKER, pageSize: 20 });
    expect(overview.entities).toHaveLength(20);
    expect(overview.matchingEntities).toBe(ENTITY_COUNT + 1);
    expect(overview.entityPages).toBe(Math.ceil((ENTITY_COUNT + 1) / 20));
    expect(overview.entityPage).toBe(1);
  });

  it('pages through the matches without repeating one', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const first = await getKnowledgeGraphOverview(db, { query: MARKER, pageSize: 20, page: 1 });
    const second = await getKnowledgeGraphOverview(db, { query: MARKER, pageSize: 20, page: 2 });
    const overlap = first.entities.filter((entity) =>
      second.entities.some((other) => other.id === entity.id),
    );
    expect(overlap).toEqual([]);
  });

  it('clamps a page past the end instead of returning nothing', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const overview = await getKnowledgeGraphOverview(db, { query: MARKER, pageSize: 20, page: 99 });
    expect(overview.entityPage).toBe(overview.entityPages);
    expect(overview.entities.length).toBeGreaterThan(0);
  });

  it('reports the full degree even when the relation list is capped', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const overview = await getKnowledgeGraphOverview(db, { query: MARKER, entityId: hubId });
    expect(overview.selected?.id).toBe(hubId);
    expect(overview.selectedRelationTotal).toBe(ENTITY_COUNT);
    // The list itself stays bounded — that it is strictly shorter than the
    // total is what proves the cap is in play and the count is not just the
    // array's length wearing a different name.
    expect(overview.relations.length).toBeLessThan(overview.selectedRelationTotal);
  });

  // The local map draws from the same capped page, so its own length would
  // report the cap as the degree — the exact failure this change exists to fix.
  it('counts active edges from a query, not from the page the map draws', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const before = await getKnowledgeGraphOverview(db, { query: MARKER, entityId: hubId });
    expect(before.selectedActiveRelationTotal).toBe(ENTITY_COUNT);
    expect(before.selectedActiveRelationTotal).toBeGreaterThan(before.relations.length);

    // Marking one stale must drop it from the active count but not the total.
    const [edge] = await db
      .select({ id: knowledgeGraphRelations.id })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.subjectEntityId, hubId))
      .limit(1);
    if (!edge) throw new Error('no relation to reject');
    await db
      .update(knowledgeGraphRelations)
      .set({ reviewStatus: 'rejected' })
      .where(eq(knowledgeGraphRelations.id, edge.id));

    const after = await getKnowledgeGraphOverview(db, { query: MARKER, entityId: hubId });
    expect(after.selectedActiveRelationTotal).toBe(ENTITY_COUNT - 1);
    expect(after.selectedRelationTotal).toBe(ENTITY_COUNT);
  });
});

describe('knowledge workspace map (integration)', () => {
  it('returns both canonical endpoint views for a focused map edge', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const parentId = randomUUID();
    const childId = randomUUID();
    const assertionId = randomUUID();
    const evidenceId = randomUUID();
    const relationId = randomUUID();
    await db.insert(knowledgeGraphEntities).values([
      { id: parentId, agentId, canonicalKey: `${MARKER}:parent`, label: 'Parent', kind: 'person' },
      { id: childId, agentId, canonicalKey: `${MARKER}:child`, label: 'Child', kind: 'person' },
    ]);
    await db.insert(knowledgeGraphAssertions).values({
      id: assertionId,
      agentId,
      semanticKey: `${MARKER}:parent-of-child`,
      subjectEntityId: parentId,
      predicate: 'parent_of',
      objectEntityId: childId,
      assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
      qualifiers: {},
      semanticRevision: 3,
      evidenceRevision: 1,
      lifecycle: 'current',
      reviewStatus: 'confirmed',
      reviewedRevision: 3,
    });
    await db.insert(knowledgeGraphAssertionEvidence).values({
      id: evidenceId,
      agentId,
      assertionId,
      sourceMemoryId,
      sourceFingerprint: `${MARKER}:parent-evidence`,
      sourceContentHash: `${MARKER}:parent-content`,
      evidenceQuote: 'Parent is the parent of Child',
      sourceAuthor: 'owner',
      sourceTrust: 'owner',
      independent: false,
      extractionVersion: GRAPH_EXTRACTION_VERSION,
      evidenceRevision: 1,
      observedAt: new Date(),
    });
    await db.insert(knowledgeGraphRelations).values({
      id: relationId,
      agentId,
      subjectEntityId: parentId,
      predicate: 'parent_of',
      objectEntityId: childId,
      sourceMemoryId,
      sourceFingerprint: `${MARKER}:parent-edge`,
      evidenceQuote: 'Parent is the parent of Child',
      ordinal: 0,
      confidence: '0.95',
      reviewStatus: 'confirmed',
      assertionId,
    });
    try {
      const snapshot = await getKnowledgeMapSnapshot(db, { entityId: childId });
      const edge = snapshot.edges.find((candidate) => candidate.id === relationId);
      expect(edge?.endpointViews).toEqual([
        expect.objectContaining({
          focusEntityId: parentId,
          direction: 'forward',
          text: 'Parent is the parent of Child',
          evidenceCount: 1,
        }),
        expect.objectContaining({
          focusEntityId: childId,
          direction: 'inverse',
          text: 'Child is the child of Parent',
          evidenceCount: 1,
        }),
      ]);
    } finally {
      await db.delete(knowledgeGraphRelations).where(eq(knowledgeGraphRelations.id, relationId));
      await db
        .delete(knowledgeGraphAssertionEvidence)
        .where(eq(knowledgeGraphAssertionEvidence.id, evidenceId));
      await db.delete(knowledgeGraphAssertions).where(eq(knowledgeGraphAssertions.id, assertionId));
      await db
        .delete(knowledgeGraphEntities)
        .where(inArray(knowledgeGraphEntities.id, [parentId, childId]));
    }
  });

  it('fills older bridges between visible items while excluding rejected claims', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const initial = await getKnowledgeMapSnapshot(db, { entityId: hubId });
    const ends = initial.nodes.filter((node) => node.id !== hubId).slice(0, 2);
    if (ends.length !== 2) throw new Error('Missing fixture endpoints');
    const records = await db
      .insert(knowledgeGraphRelations)
      .values([
        {
          agentId,
          subjectEntityId: ends[0]!.id,
          objectEntityId: ends[1]!.id,
          predicate: 'relates_to',
          sourceMemoryId,
          sourceFingerprint: `${MARKER}-old-bridge`,
          evidenceQuote: `${MARKER} recorded bridge`,
          ordinal: 9990,
          confidence: '0.9',
          reviewStatus: 'confirmed',
          createdAt: new Date('2000-01-01'),
        },
        {
          agentId,
          subjectEntityId: ends[1]!.id,
          objectEntityId: ends[0]!.id,
          predicate: 'relates_to',
          sourceMemoryId,
          sourceFingerprint: `${MARKER}-rejected-bridge`,
          evidenceQuote: `${MARKER} rejected bridge`,
          ordinal: 9991,
          confidence: '0.9',
          reviewStatus: 'rejected',
          createdAt: new Date('2000-01-01'),
        },
      ])
      .returning({ id: knowledgeGraphRelations.id });
    const recent = await db
      .insert(knowledgeGraphRelations)
      .values(
        Array.from({ length: 500 }, (_, index) => ({
          agentId,
          subjectEntityId: hubId,
          objectEntityId: ends[index % 2]!.id,
          predicate: 'relates_to',
          sourceMemoryId,
          evidenceQuote: `${MARKER} hub relates to everything`,
          sourceFingerprint: `${MARKER}-recent-${index}`,
          ordinal: 10000 + index,
          confidence: '0.9',
          reviewStatus: 'confirmed' as const,
        })),
      )
      .returning({ id: knowledgeGraphRelations.id });
    try {
      const basic = await getKnowledgeMapSnapshot(db, { entityId: hubId });
      expect(basic.edges).toHaveLength(500);
      expect(basic.truncated).toBe(true);
      const broad = await getKnowledgeMapSnapshot(db, { entityId: hubId, completeOverview: true });
      expect(broad.nodes.length).toBeGreaterThan(basic.nodes.length);
      expect(broad.edges.length).toBeGreaterThan(500);
      expect(broad.truncated).toBe(false);
      expect(basic.edges.some((edge) => edge.id === records[0]!.id)).toBe(false);
      const complete = await getKnowledgeMapSnapshot(db, {
        entityId: hubId,
        includeVisibleConnections: true,
      });
      expect(new Set(complete.nodes.map((node) => node.id))).toEqual(
        new Set(basic.nodes.map((node) => node.id)),
      );
      expect(complete.edges.some((edge) => edge.id === records[0]!.id)).toBe(true);
      expect(complete.edges.some((edge) => edge.id === records[1]!.id)).toBe(false);
      expect(new Set(complete.edges.map((edge) => edge.id)).size).toBe(complete.edges.length);
    } finally {
      await db.delete(knowledgeGraphRelations).where(
        inArray(
          knowledgeGraphRelations.id,
          [...records, ...recent].map((row) => row.id),
        ),
      );
    }
  });

  it('uses owner display names for map search and directed presentation', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const name = `${MARKER} renamed hub`;
    await db
      .update(knowledgeGraphEntities)
      .set({ preferredLabel: name })
      .where(eq(knowledgeGraphEntities.id, hubId));
    try {
      const snapshot = await getKnowledgeMapSnapshot(db, { query: name });
      expect(snapshot.edges.length).toBeGreaterThan(0);
      expect(snapshot.nodes.find((node) => node.id === hubId)?.label).toBe(name);
      expect(snapshot.edges.every((edge) => edge.presentation.sentence.startsWith(name))).toBe(
        true,
      );
      expect(
        snapshot.edges.every(
          (edge) => edge.evidenceQuote === `${MARKER} hub relates to everything`,
        ),
      ).toBe(true);
      // Original names remain searchable after an owner override.
      expect(
        (await getKnowledgeMapSnapshot(db, { query: `${MARKER} hub` })).edges.length,
      ).toBeGreaterThan(0);
    } finally {
      await db
        .update(knowledgeGraphEntities)
        .set({ preferredLabel: null })
        .where(eq(knowledgeGraphEntities.id, hubId));
    }
  });

  it('opens the requested neighborhood rather than the newest unrelated edges', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const snapshot = await getKnowledgeMapSnapshot(db, { sourceMemoryId });
    const spokeId = snapshot.edges[0]?.objectId;
    if (!spokeId) throw new Error('Missing fixture spoke');
    const focused = await getKnowledgeMapSnapshot(db, { entityId: spokeId });
    expect(focused.edges).toHaveLength(1);
    expect(focused.edges[0]?.objectId).toBe(spokeId);
  });

  it('focuses a map on exactly one source memory without exposing other edges', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const snapshot = await getKnowledgeMapSnapshot(db, { sourceMemoryId });
    expect(snapshot.filters.sourceMemoryId).toBe(sourceMemoryId);
    expect(snapshot.edges.length).toBeGreaterThan(0);
    expect(snapshot.edges.every((edge) => edge.sourceMemoryId === sourceMemoryId)).toBe(true);
  });
});

describe('knowledge workspace source truth (integration)', () => {
  it('uses the recall-eligible edge contract for library filters and projection states', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [staleMemory, blockedMemory] = await db
      .insert(memories)
      .values([
        {
          agentId,
          category: 'knowledge',
          kind: 'fact',
          content: `${MARKER} stale source`,
          contentHash: `${MARKER}-stale-current`,
          confidence: '0.80',
          embedding: unitVector(),
        },
        {
          agentId,
          category: 'knowledge',
          kind: 'fact',
          content: `${MARKER} blocked source`,
          contentHash: `${MARKER}-blocked-current`,
          confidence: '0.80',
          quarantined: true,
          embedding: unitVector(),
        },
      ])
      .returning({ id: memories.id, contentHash: memories.contentHash });
    if (!staleMemory || !blockedMemory) throw new Error('test sources were not created');
    const entities = await db
      .insert(knowledgeGraphEntities)
      .values(
        ['stale subject', 'stale object'].map((label) => ({
          agentId,
          canonicalKey: `event:${MARKER} ${label}`,
          label: `${MARKER} ${label}`,
          kind: 'event',
        })),
      )
      .returning({ id: knowledgeGraphEntities.id });
    const [subject, object] = entities;
    if (!subject || !object) throw new Error('test graph entities were not created');
    await db.insert(knowledgeGraphSources).values([
      {
        memoryId: staleMemory.id,
        contentHash: `${MARKER}-stale-old`,
        status: 'ready',
        extractionVersion: GRAPH_EXTRACTION_VERSION,
      },
      {
        memoryId: blockedMemory.id,
        contentHash: blockedMemory.contentHash,
        status: 'quarantined',
        extractionVersion: GRAPH_EXTRACTION_VERSION,
      },
    ]);
    await db.insert(knowledgeGraphRelations).values({
      agentId,
      subjectEntityId: subject.id,
      predicate: 'relates_to',
      objectEntityId: object.id,
      sourceMemoryId: staleMemory.id,
      evidenceQuote: `${MARKER} stale source`,
      sourceFingerprint: `${MARKER}-stale-relation`,
      ordinal: 1,
      confidence: '0.80',
    });

    const [connected, unconnected, review, findings] = await Promise.all([
      listMemoryLibrary(db, {
        state: 'in-use',
        filter: 'all',
        query: MARKER,
        page: 1,
        connectivity: 'connected',
      }),
      listMemoryLibrary(db, {
        state: 'in-use',
        filter: 'all',
        query: MARKER,
        page: 1,
        connectivity: 'unconnected',
      }),
      listMemoryLibrary(db, { state: 'review', filter: 'all', query: MARKER, page: 1 }),
      getKnowledgeCleanupFindings(db),
    ]);
    expect(connected.rows.some((row) => row.memory.id === staleMemory.id)).toBe(false);
    expect(unconnected.rows.find((row) => row.memory.id === staleMemory.id)).toMatchObject({
      connectionCount: 0,
      projectionStatus: 'mapping',
    });
    expect(review.rows.find((row) => row.memory.id === blockedMemory.id)).toMatchObject({
      connectionCount: 0,
      projectionStatus: 'needs_attention',
    });
    const sourceFinding = findings.find((finding) => finding.memoryId === blockedMemory.id);
    expect(sourceFinding).toMatchObject({ kind: 'quarantined' });
    expect(sourceFinding?.relatedKinds).toContain('projection_failed');
    expect(
      findings.some(
        (finding) => finding.memoryId === blockedMemory.id && finding.kind === 'projection_failed',
      ),
    ).toBe(false);
  });

  it('separates active graph effects from retired projections in a forget preview', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} impact source`,
        contentHash: `${MARKER}-impact`,
        confidence: '0.90',
        embedding: unitVector(),
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('impact source was not created');
    const entities = await db
      .insert(knowledgeGraphEntities)
      .values(
        ['impact subject', 'impact active', 'impact retired'].map((label) => ({
          agentId,
          canonicalKey: `event:${MARKER} ${label}`,
          label: `${MARKER} ${label}`,
          kind: 'event',
        })),
      )
      .returning({ id: knowledgeGraphEntities.id });
    const [subject, active, retired] = entities;
    if (!subject || !active || !retired) throw new Error('impact entities were not created');
    await db.insert(knowledgeGraphSources).values({
      memoryId: memory.id,
      contentHash: `${MARKER}-impact`,
      status: 'ready',
      extractionVersion: GRAPH_EXTRACTION_VERSION,
    });
    await db.insert(knowledgeGraphRelations).values([
      {
        agentId,
        subjectEntityId: subject.id,
        predicate: 'relates_to',
        objectEntityId: active.id,
        sourceMemoryId: memory.id,
        evidenceQuote: `${MARKER} impact active`,
        sourceFingerprint: `${MARKER}-impact-active`,
        ordinal: 1,
        confidence: '0.90',
      },
      {
        agentId,
        subjectEntityId: subject.id,
        predicate: 'relates_to',
        objectEntityId: retired.id,
        sourceMemoryId: memory.id,
        evidenceQuote: `${MARKER} impact retired`,
        sourceFingerprint: `${MARKER}-impact-retired`,
        ordinal: 2,
        confidence: '0.90',
        reviewStatus: 'rejected',
      },
    ]);

    const impact = await getKnowledgeSourceImpact(db, memory.id);
    expect(impact).toMatchObject({
      connectionCount: 2,
      activeConnectionCount: 1,
      retiredProjectionCount: 1,
    });
    expect(impact?.orphanedItems).toHaveLength(3);
  });
});

describe('knowledge graph entity search (integration)', () => {
  it('reaches an entity far past where the old fixed list stopped', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const target = `${MARKER} spoke ${String(ENTITY_COUNT - 1).padStart(3, '0')}`;
    const rows = await searchKnowledgeGraphEntities(db, { query: target });
    expect(rows.map((row) => row.label)).toContain(target);
  });

  it('excludes the entity being merged and honours the kind filter', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const rows = await searchKnowledgeGraphEntities(db, {
      query: MARKER,
      excludeId: hubId,
      kind: 'organization',
    });
    expect(rows.map((row) => row.id)).not.toContain(hubId);
    expect(rows.every((row) => row.kind === 'organization')).toBe(true);
  });

  it('offers a shorter name as a duplicate of the longer one it prefixes', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [short] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `person:${MARKER} anna`,
        label: `${MARKER} anna`,
        kind: 'person',
      })
      .returning({ id: knowledgeGraphEntities.id });
    const [long] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `person:${MARKER} anna jonsdottir`,
        label: `${MARKER} anna jonsdottir`,
        kind: 'person',
      })
      .returning({ id: knowledgeGraphEntities.id });
    if (!short || !long) throw new Error('duplicate fixtures were not created');

    const duplicates = await findDuplicateKnowledgeGraphEntities(db, {
      id: short.id,
      label: `${MARKER} anna`,
      kind: 'person',
      canonicalKey: `person:${MARKER} anna`,
    });
    expect(duplicates.map((row) => row.targetId)).toContain(long.id);

    // A different kind is never a merge candidate, however the names look.
    const crossKind = await findDuplicateKnowledgeGraphEntities(db, {
      id: hubId,
      label: `${MARKER} anna`,
      kind: 'topic',
      canonicalKey: `topic:${MARKER} hub`,
    });
    expect(crossKind.map((row) => row.targetId)).not.toContain(long.id);
  });
});

describe('knowledge graph kind filter (integration)', () => {
  it('narrows the true match count and every returned row to the kind', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const overview = await getKnowledgeGraphOverview(db, {
      query: MARKER,
      kind: 'organization',
      pageSize: 100,
    });
    // An earlier owner action rejected one hub edge. The organization at its
    // other end is now disconnected, so the owner-facing graph omits that
    // projection rather than presenting an empty node as knowledge.
    expect(overview.matchingEntities).toBe(ENTITY_COUNT - 1);
    expect(overview.entities).toHaveLength(ENTITY_COUNT - 1);
    expect(overview.entities.every((entity) => entity.kind === 'organization')).toBe(true);

    const topics = await getKnowledgeGraphOverview(db, { query: MARKER, kind: 'topic' });
    expect(topics.matchingEntities).toBe(1);
    expect(topics.entities[0]?.id).toBe(hubId);

    // No place entities exist anywhere in the fixture, so this is zero no
    // matter which other suite has run.
    const none = await getKnowledgeGraphOverview(db, { query: MARKER, kind: 'place' });
    expect(none.matchingEntities).toBe(0);
    expect(none.entities).toHaveLength(0);
  });

  it('pages a filtered list without repeating an item', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const first = await getKnowledgeGraphOverview(db, {
      query: MARKER,
      kind: 'organization',
      pageSize: 20,
      page: 1,
    });
    const second = await getKnowledgeGraphOverview(db, {
      query: MARKER,
      kind: 'organization',
      pageSize: 20,
      page: 2,
    });
    const overlap = first.entities.filter((entity) =>
      second.entities.some((other) => other.id === entity.id),
    );
    expect(overlap).toEqual([]);
    expect(first.entityPages).toBe(Math.ceil(ENTITY_COUNT / 20));
  });

  it('treats an unknown kind as no filter rather than an empty graph', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // Compared against the unfiltered query rather than a hardcoded count:
    // other suites' fixtures legitimately shift the absolute number.
    const filtered = await getKnowledgeGraphOverview(db, { query: MARKER, kind: 'not-a-kind' });
    const unfiltered = await getKnowledgeGraphOverview(db, { query: MARKER });
    expect(filtered.matchingEntities).toBe(unfiltered.matchingEntities);
  });

  it('still selects a deep-linked entity whose kind is filtered out', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // ?kind=place&entity=<the topic hub> must open the hub, not nothing —
    // otherwise switching filters would silently lose a shared link's subject.
    const overview = await getKnowledgeGraphOverview(db, {
      query: MARKER,
      kind: 'place',
      entityId: hubId,
    });
    expect(overview.matchingEntities).toBe(0);
    expect(overview.selected?.id).toBe(hubId);
  });
});

describe('knowledge graph neighborhood (integration)', () => {
  beforeAll(async () => {
    if (!dbUp) return;
    // An earlier test flips one hub edge to rejected; the neighbourhood tests
    // assert exact active counts, so the fixture starts from a known state
    // rather than depending on file order.
    await db
      .update(knowledgeGraphRelations)
      .set({ reviewStatus: 'unreviewed' })
      .where(eq(knowledgeGraphRelations.subjectEntityId, hubId));
  });

  it('returns every active edge of a high-degree hub, past the old 80-row cap', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const neighborhood = await getKnowledgeGraphNeighborhood(db, { entityId: hubId });
    expect(neighborhood.entity?.id).toBe(hubId);
    expect(neighborhood.edges).toHaveLength(ENTITY_COUNT);
    expect(neighborhood.total).toBe(ENTITY_COUNT);
    expect(neighborhood.edges.every((edge) => edge.outbound)).toBe(true);
  });

  it('honours a limit while reporting the true degree', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const neighborhood = await getKnowledgeGraphNeighborhood(db, { entityId: hubId, limit: 10 });
    expect(neighborhood.edges).toHaveLength(10);
    expect(neighborhood.total).toBe(ENTITY_COUNT);
  });

  it('caps focus-map nodes while retaining the complete relationship count', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const summary = await getKnowledgeGraphMapSummary(db, { entityId: hubId });
    expect(summary.neighborhood.total).toBe(ENTITY_COUNT);
    expect(summary.neighborhood.edges).toHaveLength(24);
    expect(summary.predicateCounts).toEqual([{ predicate: 'relates_to', count: ENTITY_COUNT }]);
  });

  it('excludes stale edges from both the page and the count', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [stale] = await db
      .select({ id: knowledgeGraphRelations.id })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.subjectEntityId, hubId))
      .limit(1);
    if (!stale) throw new Error('no relation to mark stale');
    await db
      .update(knowledgeGraphRelations)
      .set({ reviewStatus: 'rejected' })
      .where(eq(knowledgeGraphRelations.id, stale.id));
    try {
      const neighborhood = await getKnowledgeGraphNeighborhood(db, { entityId: hubId });
      expect(neighborhood.total).toBe(ENTITY_COUNT - 1);
      expect(neighborhood.edges.map((edge) => edge.id)).not.toContain(stale.id);
    } finally {
      await db
        .update(knowledgeGraphRelations)
        .set({ reviewStatus: 'unreviewed' })
        .where(eq(knowledgeGraphRelations.id, stale.id));
    }
  });

  it('orders confirmed edges ahead of unreviewed ones', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const confirmed = await db
      .select({ id: knowledgeGraphRelations.id })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.subjectEntityId, hubId))
      .limit(2);
    for (const row of confirmed) {
      await db
        .update(knowledgeGraphRelations)
        .set({ reviewStatus: 'confirmed' })
        .where(eq(knowledgeGraphRelations.id, row.id));
    }
    try {
      const neighborhood = await getKnowledgeGraphNeighborhood(db, { entityId: hubId });
      const firstTwo = neighborhood.edges.slice(0, 2).map((edge) => edge.id);
      expect(new Set(firstTwo)).toEqual(new Set(confirmed.map((row) => row.id)));
      expect(neighborhood.edges[2]?.reviewStatus).toBe('unreviewed');
    } finally {
      for (const row of confirmed) {
        await db
          .update(knowledgeGraphRelations)
          .set({ reviewStatus: 'unreviewed' })
          .where(eq(knowledgeGraphRelations.id, row.id));
      }
    }
  });

  it('reads a spoke as a degree-1 node with the edge pointing at the hub', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [spoke] = await db
      .select({ id: knowledgeGraphEntities.id })
      .from(knowledgeGraphEntities)
      .where(like(knowledgeGraphEntities.canonicalKey, `organization:${MARKER} spoke 000`))
      .limit(1);
    if (!spoke) throw new Error('spoke fixture missing');
    const neighborhood = await getKnowledgeGraphNeighborhood(db, { entityId: spoke.id });
    expect(neighborhood.edges).toHaveLength(1);
    expect(neighborhood.edges[0]?.outbound).toBe(false);
    expect(neighborhood.edges[0]?.other.id).toBe(hubId);
  });

  it('answers empty for an entity id that is not in the graph', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const neighborhood = await getKnowledgeGraphNeighborhood(db, {
      entityId: '00000000-0000-4000-8000-000000000000',
    });
    expect(neighborhood.entity).toBeNull();
    expect(neighborhood.edges).toEqual([]);
    expect(neighborhood.total).toBe(0);
  });

  it('drops edges whose source went stale, while the review list keeps and flags them', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // Simulate a source edit the sync has not processed yet: the memory's hash
    // moves on but the checkpoint does not. GraphRAG cannot traverse those
    // edges, so the map and the active count must agree — and the audit list
    // must say why they vanished rather than hiding the fact.
    await db
      .update(memories)
      .set({ contentHash: `${MARKER}-source-edited` })
      .where(eq(memories.contentHash, `${MARKER}-source`));
    try {
      const neighborhood = await getKnowledgeGraphNeighborhood(db, { entityId: hubId });
      expect(neighborhood.total).toBe(0);
      expect(neighborhood.edges).toEqual([]);

      const overview = await getKnowledgeGraphOverview(db, { entityId: hubId });
      expect(overview.selectedActiveRelationTotal).toBe(0);
      expect(overview.selectedRelationTotal).toBe(ENTITY_COUNT);
      expect(overview.relations.length).toBeGreaterThan(0);
      expect(overview.relations.every((relation) => !relation.inRecall)).toBe(true);
    } finally {
      await db
        .update(memories)
        .set({ contentHash: `${MARKER}-source` })
        .where(eq(memories.contentHash, `${MARKER}-source-edited`));
    }
  });

  it('opens an exact evidence row beyond the browse cap and removes only that claim', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const all = await db
      .select()
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.subjectEntityId, hubId));
    const overview = await getKnowledgeGraphOverview(db, { entityId: hubId });
    const outsidePage = all.find((edge) => !overview.relations.some((row) => row.id === edge.id));
    if (!outsidePage) throw new Error('fixture must exceed the browse cap');
    const sibling = all.find((edge) => edge.id !== outsidePage.id);
    if (!sibling) throw new Error('shared-source fixture missing');
    const detail = await getKnowledgeGraphRelation(db, outsidePage.id);
    expect(detail?.source.memoryId).toBe(sourceMemoryId);
    expect(detail?.subject.id).toBe(hubId);
    expect(detail?.object.id).toBe(outsidePage.objectEntityId);
    try {
      expect(await reviewKnowledgeGraphRelation(db, outsidePage.id, 'rejected')).toBe(true);
      expect((await getKnowledgeGraphRelation(db, outsidePage.id))?.inRecall).toBe(false);
      expect((await getKnowledgeGraphRelation(db, sibling.id))?.reviewStatus).toBe(
        sibling.reviewStatus,
      );
      expect((await getKnowledgeGraphRelation(db, sibling.id))?.source.memoryId).toBe(
        sourceMemoryId,
      );
      const neighborhood = await getKnowledgeGraphNeighborhood(db, { entityId: hubId });
      expect(neighborhood.edges.some((edge) => edge.id === outsidePage.id)).toBe(false);
    } finally {
      await db
        .update(knowledgeGraphRelations)
        .set({ reviewStatus: outsidePage.reviewStatus })
        .where(eq(knowledgeGraphRelations.id, outsidePage.id));
    }
    expect(await getKnowledgeGraphRelation(db, 'not-an-id')).toBeNull();
    expect(await getKnowledgeGraphRelation(db, '00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(
      await reviewKnowledgeGraphRelation(db, '00000000-0000-4000-8000-000000000000', 'rejected'),
    ).toBe(false);
  });

  it('excludes an explicitly retired whole fact from raw and graph retrieval', async () => {
    if (!dbUp) throw new Error('Requires isolated PostgreSQL fixture');
    const first = await addOwnerKnowledgeGraphFact(db, graphRouter, {
      subjectLabel: `${MARKER} whole fact subject`,
      subjectKind: 'topic',
      predicate: 'supports',
      objectLabel: `${MARKER} whole fact target`,
      objectKind: 'topic',
      note: 'Standalone whole fact before correction',
    });
    if (!first.relationId) throw new Error(first.error ?? 'Missing whole fact');
    const [prior] = await db
      .select()
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.id, first.relationId));
    if (!prior) throw new Error('Missing prior whole fact edge');
    const result = await correctKnowledgeGraphRelation(db, graphRouter, first.relationId, {
      subjectLabel: `${MARKER} whole fact subject`,
      subjectKind: 'topic',
      subjectId: prior.subjectEntityId,
      predicate: 'relates_to',
      objectLabel: `${MARKER} whole fact target`,
      objectKind: 'topic',
      objectId: prior.objectEntityId,
      note: 'Standalone whole fact corrected',
      sourceDisposition: 'whole_fact',
    });
    if (!result.memoryId || !result.relationId)
      throw new Error(result.error ?? 'Whole fact correction failed');
    const raw = await createPostgresMemoryToolRepository(db).recall({
      agentId,
      embedding: unitVector(),
      query: 'Standalone whole fact corrected',
      limit: 20,
      embeddingSpaceKey: embeddingSpaceIdentityKey(await graphRouter.embeddingSpace()),
    });
    expect(raw.memories.map((row) => row.id)).toContain(result.memoryId);
    expect(raw.memories.map((row) => row.id)).not.toContain(prior.sourceMemoryId);
    const graph = await createPostgresGraphRecallRepository(db).connected({
      agentId,
      entityIds: [prior.subjectEntityId],
      sourceMemoryIds: [],
      limit: 100,
      extractionVersion: GRAPH_EXTRACTION_VERSION,
    });
    expect(graph.map((row) => row.relationId)).toContain(result.relationId);
    expect(graph.map((row) => row.relationId)).not.toContain(first.relationId);
  });

  it('creates a corrected source-backed edge before retiring the prior edge', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [old] = await db
      .select({
        id: knowledgeGraphRelations.id,
        objectId: knowledgeGraphRelations.objectEntityId,
        reviewStatus: knowledgeGraphRelations.reviewStatus,
        sourceMemoryId: knowledgeGraphRelations.sourceMemoryId,
        correctedByRelationId: knowledgeGraphRelations.correctedByRelationId,
        correctionSourceContentHash: knowledgeGraphRelations.correctionSourceContentHash,
        correctionDisposition: knowledgeGraphRelations.correctionDisposition,
        sourceContentHash: memories.contentHash,
      })
      .from(knowledgeGraphRelations)
      .innerJoin(memories, eq(knowledgeGraphRelations.sourceMemoryId, memories.id))
      .where(eq(knowledgeGraphRelations.subjectEntityId, hubId))
      .limit(1);
    if (!old) throw new Error('fixture relation missing');

    let newRelationId: string | undefined;
    try {
      await expect(
        correctKnowledgeGraphRelation(db, graphRouter, old.id, {
          subjectLabel: `${MARKER} hub`,
          subjectKind: 'topic',
          subjectId: hubId,
          predicate: 'whole_fact_must_be_refused',
          objectLabel: `${MARKER} target`,
          objectKind: 'organization',
          note: 'This shared source also supports other edges.',
          sourceDisposition: 'whole_fact',
        }),
      ).rejects.toThrow(/choose graph-only correction/i);

      await expect(
        correctKnowledgeGraphRelation(
          db,
          {
            ...graphRouter,
            embed: async () => {
              await db
                .update(memories)
                .set({ contentHash: `${MARKER}-changed-during-review` })
                .where(eq(memories.id, old.sourceMemoryId));
              return [unitVector()];
            },
          },
          old.id,
          {
            subjectLabel: `${MARKER} hub`,
            subjectKind: 'topic',
            subjectId: hubId,
            predicate: 'stale_correction',
            objectLabel: `${MARKER} stale target`,
            objectKind: 'organization',
            note: 'Must not apply to a changed source.',
          },
        ),
      ).rejects.toThrow(/source changed/i);
      await db
        .update(memories)
        .set({ contentHash: old.sourceContentHash })
        .where(eq(memories.id, old.sourceMemoryId));
      const unchanged = await db
        .select({ correctedByRelationId: knowledgeGraphRelations.correctedByRelationId })
        .from(knowledgeGraphRelations)
        .where(eq(knowledgeGraphRelations.id, old.id))
        .limit(1);
      expect(unchanged[0]?.correctedByRelationId).toBe(old.correctedByRelationId);

      const result = await correctKnowledgeGraphRelation(db, graphRouter, old.id, {
        subjectLabel: `${MARKER} hub`,
        subjectKind: 'topic',
        subjectId: hubId,
        predicate: 'correctly_relates_to',
        objectLabel: `${MARKER} corrected spoke`,
        objectKind: 'organization',
        objectId: old.objectId,
        note: 'The original relationship wording was inaccurate.',
      });

      expect(result.error).toBeUndefined();
      newRelationId = result.relationId;
      expect(result.sourceDisposition).toBe('graph_only');
      expect(result.alreadyApplied).not.toBe(true);
      expect(newRelationId).toBeTruthy();
      if (!newRelationId) throw new Error('correction did not create a replacement relation');
      const replay = await correctKnowledgeGraphRelation(db, graphRouter, old.id, {
        subjectLabel: `${MARKER} hub`,
        subjectKind: 'topic',
        subjectId: hubId,
        predicate: 'correctly_relates_to',
        objectLabel: `${MARKER} corrected spoke`,
        objectKind: 'organization',
        objectId: old.objectId,
        note: 'The original relationship wording was inaccurate.',
      });
      expect(replay).toMatchObject({
        relationId: newRelationId,
        sourceDisposition: 'graph_only',
        alreadyApplied: true,
      });
      const [oldAfter, newAfter] = await Promise.all([
        db
          .select({
            status: knowledgeGraphRelations.reviewStatus,
            correctedByRelationId: knowledgeGraphRelations.correctedByRelationId,
            correctionDisposition: knowledgeGraphRelations.correctionDisposition,
          })
          .from(knowledgeGraphRelations)
          .where(eq(knowledgeGraphRelations.id, old.id))
          .limit(1),
        db
          .select({
            status: knowledgeGraphRelations.reviewStatus,
            source: memories.content,
          })
          .from(knowledgeGraphRelations)
          .innerJoin(memories, eq(knowledgeGraphRelations.sourceMemoryId, memories.id))
          .where(eq(knowledgeGraphRelations.id, newRelationId))
          .limit(1),
      ]);
      expect(oldAfter[0]).toMatchObject({
        status: 'rejected',
        correctedByRelationId: newRelationId,
        correctionDisposition: 'graph_only',
      });
      const originalSource = await db
        .select({ expiresAt: memories.expiresAt, supersededById: memories.supersededById })
        .from(memories)
        .where(eq(memories.id, old.sourceMemoryId))
        .limit(1);
      expect(originalSource[0]?.expiresAt).toBeNull();
      expect(originalSource[0]?.supersededById).toBeNull();
      expect(newAfter[0]).toMatchObject({ status: 'confirmed' });
      expect(newAfter[0]?.source).toContain('The original relationship wording was inaccurate.');
      const rawRecall = await createPostgresMemoryToolRepository(db).recall({
        agentId,
        embedding: unitVector(),
        query: 'original relationship wording inaccurate',
        limit: 20,
        embeddingSpaceKey: embeddingSpaceIdentityKey(await graphRouter.embeddingSpace()),
      });
      expect(rawRecall.memories.map((row) => row.id)).toContain(old.sourceMemoryId);
      const replacementMemory = await db
        .select({ id: memories.id })
        .from(memories)
        .innerJoin(knowledgeGraphRelations, eq(knowledgeGraphRelations.sourceMemoryId, memories.id))
        .where(eq(knowledgeGraphRelations.id, newRelationId));
      expect(rawRecall.memories.map((row) => row.id)).toContain(replacementMemory[0]?.id);
      const graphRecall = await createPostgresGraphRecallRepository(db).connected({
        agentId,
        entityIds: [old.objectId],
        sourceMemoryIds: [],
        limit: 100,
        extractionVersion: GRAPH_EXTRACTION_VERSION,
      });
      expect(graphRecall.map((row) => row.relationId)).toContain(newRelationId);
      expect(graphRecall.map((row) => row.relationId)).not.toContain(old.id);
    } finally {
      if (newRelationId) {
        const [replacement] = await db
          .select({ sourceMemoryId: knowledgeGraphRelations.sourceMemoryId })
          .from(knowledgeGraphRelations)
          .where(eq(knowledgeGraphRelations.id, newRelationId))
          .limit(1);
        if (replacement) {
          await db.delete(memories).where(eq(memories.id, replacement.sourceMemoryId));
        }
      }
      await db
        .update(knowledgeGraphRelations)
        .set({
          reviewStatus: old.reviewStatus,
          correctedByRelationId: old.correctedByRelationId,
          correctionSourceContentHash: old.correctionSourceContentHash,
          correctionDisposition: old.correctionDisposition,
        })
        .where(eq(knowledgeGraphRelations.id, old.id));
    }
  });
});

describe('knowledge graph retype (integration)', () => {
  it('validates the kind and round-trips an entity through a retype', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // Its own fixture, deleted by id: a retype re-keys the entity, and the
    // normalized key drops the marker's hyphens, so the shared marker cleanup
    // would miss it.
    const [fixture] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `topic:${MARKER} roundtrip`,
        label: `${MARKER} Roundtrip`,
        kind: 'topic',
      })
      .returning({ id: knowledgeGraphEntities.id });
    if (!fixture) throw new Error('retype fixture missing');
    try {
      expect((await retypeKnowledgeGraphEntity(db, fixture.id, 'nonsense')).error).toContain(
        'valid type',
      );

      expect((await retypeKnowledgeGraphEntity(db, fixture.id, 'project')).error).toBeUndefined();
      const [retyped] = await db
        .select({ kind: knowledgeGraphEntities.kind, key: knowledgeGraphEntities.canonicalKey })
        .from(knowledgeGraphEntities)
        .where(eq(knowledgeGraphEntities.id, fixture.id));
      expect(retyped?.kind).toBe('project');
      expect(retyped?.key.startsWith('project:')).toBe(true);
      expect(retyped?.key.endsWith('roundtrip')).toBe(true);

      expect((await retypeKnowledgeGraphEntity(db, fixture.id, 'topic')).error).toBeUndefined();
      const [back] = await db
        .select({ kind: knowledgeGraphEntities.kind, key: knowledgeGraphEntities.canonicalKey })
        .from(knowledgeGraphEntities)
        .where(eq(knowledgeGraphEntities.id, fixture.id));
      expect(back?.kind).toBe('topic');
      expect(back?.key.startsWith('topic:')).toBe(true);
    } finally {
      await db.delete(knowledgeGraphEntities).where(eq(knowledgeGraphEntities.id, fixture.id));
    }
  });
});

describe('knowledge graph paths (integration)', () => {
  let crossEdgeId: string;
  const hubEdgeIds: string[] = [];

  beforeAll(async () => {
    if (!dbUp) return;
    // A spoke-to-spoke edge, so chains through either spoke have a
    // continuation. Both hub edges are confirmed so the two spokes
    // deterministically lead the first hop regardless of insert timestamps.
    const [spokeA] = await db
      .select({ id: knowledgeGraphEntities.id })
      .from(knowledgeGraphEntities)
      .where(like(knowledgeGraphEntities.canonicalKey, `organization:${MARKER} spoke 000`))
      .limit(1);
    const [spokeB] = await db
      .select({ id: knowledgeGraphEntities.id })
      .from(knowledgeGraphEntities)
      .where(like(knowledgeGraphEntities.canonicalKey, `organization:${MARKER} spoke 001`))
      .limit(1);
    const [memory] = await db
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.contentHash, `${MARKER}-source`))
      .limit(1);
    if (!spokeA || !spokeB || !memory) throw new Error('paths fixtures missing');
    const hubEdges = await db
      .update(knowledgeGraphRelations)
      .set({ reviewStatus: 'confirmed' })
      .where(
        and(
          eq(knowledgeGraphRelations.subjectEntityId, hubId),
          inArray(knowledgeGraphRelations.objectEntityId, [spokeA.id, spokeB.id]),
        ),
      )
      .returning({ id: knowledgeGraphRelations.id });
    hubEdgeIds.push(...hubEdges.map((row) => row.id));
    const [edge] = await db
      .insert(knowledgeGraphRelations)
      .values({
        agentId,
        subjectEntityId: spokeA.id,
        predicate: 'partners_with',
        objectEntityId: spokeB.id,
        sourceMemoryId: memory.id,
        evidenceQuote: `${MARKER} hub relates to everything`,
        sourceFingerprint: `${MARKER}-paths-cross`,
        ordinal: 90,
        confidence: '0.95',
        reviewStatus: 'confirmed',
        validFrom: '2024',
        validUntil: '2026',
      })
      .returning({ id: knowledgeGraphRelations.id });
    if (!edge) throw new Error('cross edge was not created');
    crossEdgeId = edge.id;
  });

  afterAll(async () => {
    if (!dbUp) return;
    if (crossEdgeId) {
      await db.delete(knowledgeGraphRelations).where(eq(knowledgeGraphRelations.id, crossEdgeId));
    }
    if (hubEdgeIds.length > 0) {
      await db
        .update(knowledgeGraphRelations)
        .set({ reviewStatus: 'unreviewed' })
        .where(inArray(knowledgeGraphRelations.id, hubEdgeIds));
    }
  });

  it('builds capped, cycle-free chains out from the centre', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await getKnowledgeGraphPaths(db, { entityId: hubId });
    expect(result.entity?.id).toBe(hubId);
    // 85 first-hop edges, capped at 8 chains.
    expect(result.paths).toHaveLength(8);
    for (const path of result.paths) {
      expect(path.steps.length).toBeGreaterThanOrEqual(1);
      expect(path.steps.length).toBeLessThanOrEqual(2);
      // No chain revisits the centre.
      expect(path.steps.every((step) => step.entity.id !== hubId)).toBe(true);
    }
    // The two confirmed spokes lead, and each continues through the cross
    // edge to the other — the span rides along.
    const continued = result.paths.filter((path) => path.steps.length === 2);
    expect(continued).toHaveLength(2);
    for (const path of continued) {
      expect(path.steps[1]?.predicate).toBe('partners_with');
      expect(path.steps[1]?.validFrom).toBe('2024');
      expect(path.steps[1]?.validUntil).toBe('2026');
    }
    // The continuations point at the two spokes, never at the start of the
    // chain itself.
    const destinations = new Set(continued.map((path) => path.steps[1]?.entity.id));
    const starts = new Set(continued.map((path) => path.steps[0]?.entity.id));
    expect(destinations.size).toBe(2);
    for (const id of destinations) expect(starts.has(id)).toBe(true);
    for (const id of starts) expect(destinations.has(id)).toBe(true);
    expect([...destinations].every((id) => id !== hubId)).toBe(true);
  });

  it('answers empty for an unknown entity', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const result = await getKnowledgeGraphPaths(db, {
      entityId: '00000000-0000-4000-8000-000000000000',
    });
    expect(result.entity).toBeNull();
    expect(result.paths).toEqual([]);
  });
});
