import { randomUUID } from 'node:crypto';
import {
  agents,
  contacts,
  createDb,
  type Db,
  knowledgeGraphAssertionEvidence,
  knowledgeGraphAssertions,
  knowledgeGraphEntities,
  knowledgeGraphEntityAliases,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
} from '@assistant/db';
import {
  canonicalizeKnowledgeAssertionDirection,
  knowledgeAssertionEvidenceId,
  knowledgeAssertionId,
  knowledgeAssertionSemanticKey,
} from '@assistant/persistence';
import { and, eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelRouter } from '../model-router/router.js';
import { recallKnowledgeGraph } from './graph-recall.js';
import {
  backfillKnowledgeGraphDates,
  countRelativeDateSources,
  createOwnerKnowledgeGraphFact,
  GRAPH_EXTRACTION_VERSION,
  graphRelationshipIsGrounded,
  mergeGraphEntities,
  retryQuarantinedKnowledgeGraphSources,
  retypeGraphEntity,
  syncKnowledgeGraph,
} from './knowledge-graph.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-graph-${Date.now()}`;

/** Mirrors the core normalizer closely enough for fixture key construction. */
function normalizedKey(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function unit(index: number): number[] {
  const vector = new Array(1536).fill(0);
  vector[index] = 1;
  return vector;
}

let db: Db;
let dbUp = false;
let agentId: string;

const router = {
  async object(_: string, input: { prompt?: string }) {
    if (input.prompt?.includes('worked at')) {
      return {
        ok: true,
        object: {
          relationships: [
            {
              subject: { label: `${MARKER} Owner`, kind: 'person' },
              subjectSpan: `${MARKER} Owner`,
              predicate: 'worked_at',
              predicateSpan: 'worked at',
              object: { label: `${MARKER} Acme`, kind: 'organization' },
              objectSpan: `${MARKER} Acme`,
              evidenceQuote: `${MARKER} Owner worked at ${MARKER} Acme from 2019 to March 2023.`,
              confidence: 0.9,
              validFrom: '2019',
              validUntil: 'March 2023',
            },
            {
              subject: { label: `${MARKER} Owner`, kind: 'person' },
              subjectSpan: `${MARKER} Owner`,
              predicate: 'visited',
              predicateSpan: 'visited',
              object: { label: `${MARKER} Acme`, kind: 'organization' },
              objectSpan: `${MARKER} Acme`,
              evidenceQuote: `${MARKER} Owner visited ${MARKER} Acme often.`,
              confidence: 0.9,
              // '1492' is unquoted; 'often' is quoted but names no date.
              // Both must be dropped without taking the edge down.
              validFrom: '1492',
              validUntil: 'often',
            },
          ],
        },
      };
    }
    if (input.prompt?.includes('operates')) {
      return {
        ok: true,
        object: {
          relationships: [
            {
              subject: { label: `${MARKER} Acme`, kind: 'organization' },
              subjectSpan: `${MARKER} Acme`,
              predicate: 'operates',
              predicateSpan: 'operates',
              object: { label: `${MARKER} Project Fox`, kind: 'project' },
              objectSpan: `${MARKER} Project Fox`,
              evidenceQuote: `${MARKER} Acme operates ${MARKER} Project Fox.`,
              confidence: 0.9,
            },
          ],
        },
      };
    }
    const employer = input.prompt?.includes('Replacement')
      ? `${MARKER} Replacement`
      : input.prompt?.includes('Versioned Employer')
        ? `${MARKER} Versioned Employer`
        : `${MARKER} Acme`;
    return {
      ok: true,
      object: {
        relationships: [
          {
            subject: { label: `${MARKER} Owner`, kind: 'person' },
            subjectSpan: `${MARKER} Owner`,
            predicate: 'works_at',
            predicateSpan: 'works at',
            object: { label: employer, kind: 'organization' },
            objectSpan: employer,
            evidenceQuote: `${MARKER} Owner works at ${employer}.`,
            confidence: 0.9,
          },
        ],
      },
    };
  },
} as unknown as ModelRouter;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        name: 'Knowledge Graph Test',
        email: `${MARKER}@example.com`,
        workspacePrefix: MARKER,
      })
      .returning({ id: agents.id });
    if (!agent) throw new Error('test agent was not created');
    agentId = agent.id;
    dbUp = true;
  } catch {
    console.warn('knowledge-graph.test: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (dbUp) {
    await db.delete(memories).where(like(memories.content, `${MARKER}%`));
    await db.delete(contacts).where(like(contacts.name, `${MARKER}%`));
    await db.delete(agents).where(eq(agents.id, agentId));
  }
  await (db as unknown as { $client?: { end: () => Promise<void> } }).$client?.end?.();
});

describe('knowledge graph sync and recall', () => {
  it('rejects a parsed relationship whose endpoints are not in its source fact', () => {
    expect(
      graphRelationshipIsGrounded('Anna works at Acme.', {
        subject: { label: 'Anna' },
        predicate: 'works_at',
        object: { label: 'Project Fox' },
        evidenceQuote: 'Anna works at Project Fox.',
      }),
    ).toBe(false);
    expect(
      graphRelationshipIsGrounded('Anna works at Acme.', {
        subject: { label: 'Anna' },
        predicate: 'works_at',
        object: { label: 'Acme' },
        evidenceQuote: 'Anna works at Acme.',
      }),
    ).toBe(true);
    expect(
      graphRelationshipIsGrounded('Anna visited Acme after working at Orbit.', {
        subject: { label: 'Anna' },
        predicate: 'works_at',
        object: { label: 'Acme' },
        evidenceQuote: 'Anna visited Acme',
      }),
    ).toBe(false);
  });

  it('requires ordered literal spans and rejects polarity or modality that contradicts a positive edge', () => {
    const source = 'Alice is the father of Bob.';
    const base = {
      subject: { label: 'Alice' },
      subjectSpan: 'Alice',
      predicate: 'father_of',
      predicateSpan: 'is the father of',
      object: { label: 'Bob' },
      objectSpan: 'Bob',
      evidenceQuote: source,
    };
    expect(graphRelationshipIsGrounded(source, base)).toBe(true);
    expect(
      graphRelationshipIsGrounded(source, {
        ...base,
        subject: { label: 'Bob' },
        subjectSpan: 'Bob',
        object: { label: 'Alice' },
        objectSpan: 'Alice',
      }),
    ).toBe(false);
    expect(
      graphRelationshipIsGrounded('Alice is not the father of Bob.', {
        ...base,
        evidenceQuote: 'Alice is not the father of Bob.',
      }),
    ).toBe(false);
    expect(
      graphRelationshipIsGrounded('Alice is not the father of Bob.', {
        ...base,
        evidenceQuote: 'Alice is not the father of Bob.',
        predicateSpan: 'the father of',
        assertion: { tense: 'present', polarity: 'negative', modality: 'asserted' },
      }),
    ).toBe(true);
    expect(
      graphRelationshipIsGrounded('Alice might be the father of Bob.', {
        ...base,
        predicateSpan: 'the father of',
        evidenceQuote: 'Alice might be the father of Bob.',
      }),
    ).toBe(false);
    expect(
      graphRelationshipIsGrounded('Alice might be the father of Bob.', {
        ...base,
        predicateSpan: 'the father of',
        evidenceQuote: 'Alice might be the father of Bob.',
        assertion: { tense: 'present', polarity: 'positive', modality: 'possible' },
      }),
    ).toBe(true);
    expect(
      graphRelationshipIsGrounded('If Alice were the father of Bob, they would move.', {
        ...base,
        predicateSpan: 'were the father of',
        evidenceQuote: 'If Alice were the father of Bob',
      }),
    ).toBe(false);
    expect(
      graphRelationshipIsGrounded(source, {
        ...base,
        predicate: 'mother_of',
      }),
    ).toBe(false);
    expect(
      graphRelationshipIsGrounded('Alice was employed by Acme in 2019.', {
        subject: { label: 'Alice' },
        subjectSpan: 'Alice',
        predicate: 'worked_at',
        predicateSpan: 'was employed by',
        object: { label: 'Acme' },
        objectSpan: 'Acme',
        evidenceQuote: 'Alice was employed by Acme',
      }),
    ).toBe(true);
    expect(
      graphRelationshipIsGrounded('Alice was married to Bob.', {
        subject: { label: 'Alice' },
        subjectSpan: 'Alice',
        predicate: 'former_spouse_of',
        predicateSpan: 'was married to',
        object: { label: 'Bob' },
        objectSpan: 'Bob',
        evidenceQuote: 'Alice was married to Bob',
      }),
    ).toBe(true);
    expect(
      graphRelationshipIsGrounded('Alice works at Acme.', {
        subject: { label: 'Alice' },
        subjectSpan: 'She',
        predicate: 'works_at',
        predicateSpan: 'works at',
        object: { label: 'Acme' },
        objectSpan: 'Acme',
        evidenceQuote: 'She works at Acme',
      }),
    ).toBe(false);
    expect(
      graphRelationshipIsGrounded('Alice works for him.', {
        subject: { label: 'Alice' },
        subjectSpan: 'Alice',
        predicate: 'works_at',
        predicateSpan: 'works for',
        object: { label: 'Acme' },
        objectSpan: 'him',
        evidenceQuote: 'Alice works for him.',
      }),
    ).toBe(false);
    expect(
      graphRelationshipIsGrounded('Alice visited Acme and Bob works at Orbit.', {
        subject: { label: 'Alice' },
        subjectSpan: 'Alice',
        predicate: 'works_at',
        predicateSpan: 'works at',
        object: { label: 'Orbit' },
        objectSpan: 'Orbit',
        evidenceQuote: 'Alice visited Acme and Bob works at Orbit',
      }),
    ).toBe(false);
    expect(
      graphRelationshipIsGrounded('Alice visited Acme and Bob works at Orbit.', {
        subject: { label: 'Bob' },
        subjectSpan: 'Bob',
        predicate: 'works_at',
        predicateSpan: 'works at',
        object: { label: 'Orbit' },
        objectSpan: 'Orbit',
        evidenceQuote: 'Alice visited Acme and Bob works at Orbit',
        assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
      }),
    ).toBe(true);
  });

  it('preserves reported and hypothetical scope outside the selected evidence quote', () => {
    const positiveClaim = {
      subject: { label: 'Alice' },
      subjectSpan: 'Alice',
      predicate: 'father_of',
      predicateSpan: 'is the father of',
      object: { label: 'Bob' },
      objectSpan: 'Bob',
      evidenceQuote: 'Alice is the father of Bob.',
    };
    const denialSource = 'Alice denied that Alice is the father of Bob.';
    expect(
      graphRelationshipIsGrounded(denialSource, {
        ...positiveClaim,
        assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
      }),
    ).toBe(false);
    expect(
      graphRelationshipIsGrounded(denialSource, {
        ...positiveClaim,
        assertion: { tense: 'present', polarity: 'positive', modality: 'reported' },
      }),
    ).toBe(true);

    const quotedSource = 'Alice said, “Alice is the father of Bob.”';
    expect(
      graphRelationshipIsGrounded(quotedSource, {
        ...positiveClaim,
        assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
      }),
    ).toBe(false);
    expect(
      graphRelationshipIsGrounded(quotedSource, {
        ...positiveClaim,
        assertion: { tense: 'present', polarity: 'positive', modality: 'reported' },
      }),
    ).toBe(true);

    const hypotheticalSource = 'If Alice was employed by Acme, she might know Bob.';
    expect(
      graphRelationshipIsGrounded(hypotheticalSource, {
        subject: { label: 'Alice' },
        subjectSpan: 'Alice',
        predicate: 'worked_at',
        predicateSpan: 'was employed by',
        object: { label: 'Acme' },
        objectSpan: 'Acme',
        evidenceQuote: 'Alice was employed by Acme',
        assertion: { tense: 'past', polarity: 'positive', modality: 'asserted' },
      }),
    ).toBe(false);
    expect(
      graphRelationshipIsGrounded(hypotheticalSource, {
        subject: { label: 'Alice' },
        subjectSpan: 'Alice',
        predicate: 'worked_at',
        predicateSpan: 'was employed by',
        object: { label: 'Acme' },
        objectSpan: 'Acme',
        evidenceQuote: 'Alice was employed by Acme',
        assertion: { tense: 'past', polarity: 'positive', modality: 'conditional' },
      }),
    ).toBe(true);
  });

  it('keeps an asserted relation in a separate clause from an unrelated denial', () => {
    const source = 'Alice denied that Bob is her father, but Alice works at Acme.';
    expect(
      graphRelationshipIsGrounded(source, {
        subject: { label: 'Alice' },
        subjectSpan: 'Alice',
        predicate: 'works_at',
        predicateSpan: 'works at',
        object: { label: 'Acme' },
        objectSpan: 'Acme',
        evidenceQuote: source,
        assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
      }),
    ).toBe(true);
  });

  it('does not drop coordinated denial or sentence-spanning quotation scope', () => {
    const relation = {
      subject: { label: 'Carol' },
      subjectSpan: 'Carol',
      predicate: 'mother_of',
      predicateSpan: 'the mother of',
      object: { label: 'Dave' },
      objectSpan: 'Dave',
      evidenceQuote: 'Carol is the mother of Dave.',
      assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' } as const,
    };
    const deniedCoordination =
      'Alice denied that Alice is the father of Bob and Carol is the mother of Dave.';
    expect(graphRelationshipIsGrounded(deniedCoordination, relation)).toBe(false);

    const doubleQuoted = 'Alice said "Bob is the father of Eve. Carol is the mother of Dave."';
    expect(graphRelationshipIsGrounded(doubleQuoted, relation)).toBe(false);

    const asciiSingleQuoted = "Alice said 'Bob is the father of Eve. Carol is the mother of Dave.'";
    expect(graphRelationshipIsGrounded(asciiSingleQuoted, relation)).toBe(false);

    const possessiveInsideAsciiQuote =
      "Alice said 'Bob's father is Eve. Carol is the mother of Dave.'";
    expect(graphRelationshipIsGrounded(possessiveInsideAsciiQuote, relation)).toBe(false);

    const curlySingleQuoted = 'Alice said ‘Bob is the father of Eve. Carol is the mother of Dave.’';
    expect(graphRelationshipIsGrounded(curlySingleQuoted, relation)).toBe(false);

    const curlyApostropheInsideQuote =
      'Alice said ‘Bob’s father is Eve. Carol is the mother of Dave.’';
    expect(graphRelationshipIsGrounded(curlyApostropheInsideQuote, relation)).toBe(false);

    const unquotedPossessive = 'Bob’s cousin is Alice. Carol is the mother of Dave.';
    expect(graphRelationshipIsGrounded(unquotedPossessive, relation)).toBe(true);

    const unquotedSeparateSentence = 'Bob is the father of Eve. Carol is the mother of Dave.';
    expect(graphRelationshipIsGrounded(unquotedSeparateSentence, relation)).toBe(true);
  });

  it('fails closed on excessive repeated relation spans without expanding their Cartesian product', () => {
    const source = Array.from({ length: 20 }, () => 'Alice works at Acme.').join(' ');
    const relation = {
      subject: { label: 'Alice' },
      subjectSpan: 'Alice',
      predicate: 'works_at',
      predicateSpan: 'works at',
      object: { label: 'Acme' },
      objectSpan: 'Acme',
      evidenceQuote: source,
      assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' } as const,
    };
    expect(source.length).toBeLessThanOrEqual(500);
    expect(graphRelationshipIsGrounded(source, relation)).toBe(false);
    expect(
      graphRelationshipIsGrounded(source, {
        ...relation,
        evidenceQuote: `${source} ${'x'.repeat(501)}`,
      }),
    ).toBe(false);
    expect(
      graphRelationshipIsGrounded('Alice works at Acme.', {
        ...relation,
        evidenceQuote: 'Alice works at Acme.',
      }),
    ).toBe(true);
    expect(graphRelationshipIsGrounded('Alice works at Acme. '.repeat(12_501), relation)).toBe(
      false,
    );
  });

  it('records why negated model output was rejected instead of storing a positive edge', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const content = `${MARKER} Alice is not the father of ${MARKER} Bob.`;
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content,
        contentHash: `${MARKER}-negated-graph-output`,
        embedding: unit(75),
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('negated graph fixture was not created');
    const negatedRouter = {
      async object() {
        return {
          ok: true,
          object: {
            relationships: [
              {
                subject: { label: `${MARKER} Alice`, kind: 'person' },
                subjectSpan: `${MARKER} Alice`,
                predicate: 'father_of',
                predicateSpan: 'the father of',
                object: { label: `${MARKER} Bob`, kind: 'person' },
                objectSpan: `${MARKER} Bob`,
                evidenceQuote: content,
                assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
                confidence: 0.95,
              },
            ],
          },
        };
      },
    } as unknown as ModelRouter;
    const result = await syncKnowledgeGraph({ db, router: negatedRouter }, { agentId });
    expect(result).toMatchObject({
      processed: 1,
      relationships: 0,
      rejected: 1,
      rejectionReasons: { assertion_mismatch: 1 },
    });
    const [source] = await db
      .select({ lastError: knowledgeGraphSources.lastError })
      .from(knowledgeGraphSources)
      .where(eq(knowledgeGraphSources.memoryId, memory.id));
    expect(source?.lastError).toContain('assertion_mismatch:1');
  });

  it('does not promote a positive substring denied by the surrounding source clause', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const content = `${MARKER} Alice denied that ${MARKER} Alice is the father of ${MARKER} Bob.`;
    const evidenceQuote = `${MARKER} Alice is the father of ${MARKER} Bob.`;
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content,
        contentHash: `${MARKER}-denied-graph-output`,
        embedding: unit(75),
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('denied graph fixture was not created');
    const deniedRouter = {
      async object() {
        return {
          ok: true,
          object: {
            relationships: [
              {
                subject: { label: `${MARKER} Alice`, kind: 'person' },
                subjectSpan: `${MARKER} Alice`,
                predicate: 'father_of',
                predicateSpan: 'is the father of',
                object: { label: `${MARKER} Bob`, kind: 'person' },
                objectSpan: `${MARKER} Bob`,
                evidenceQuote,
                assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
                confidence: 0.95,
              },
            ],
          },
        };
      },
    } as unknown as ModelRouter;
    const result = await syncKnowledgeGraph({ db, router: deniedRouter }, { agentId });
    expect(result).toMatchObject({
      processed: 1,
      relationships: 0,
      rejected: 1,
      rejectionReasons: { assertion_mismatch: 1 },
    });
    const relations = await db
      .select({ id: knowledgeGraphRelations.id })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.sourceMemoryId, memory.id));
    expect(relations).toEqual([]);
  });

  it('requires word-boundary matches, so substrings of real words cannot ground an edge', () => {
    // "Ann" is a substring of "Anna" — substring matching used to accept this.
    expect(
      graphRelationshipIsGrounded('Anna works at Acme.', {
        subject: { label: 'Ann' },
        predicate: 'works_at',
        object: { label: 'Acme' },
        evidenceQuote: 'Anna works at Acme.',
      }),
    ).toBe(false);
    // "Art" is a substring of "artist".
    expect(
      graphRelationshipIsGrounded('Anna visited an artist in Reykjavik.', {
        subject: { label: 'Anna' },
        predicate: 'visited',
        object: { label: 'Art' },
        evidenceQuote: 'Anna visited an artist',
      }),
    ).toBe(false);
    // The predicate word must be a real word too, not a fragment.
    expect(
      graphRelationshipIsGrounded('Anna saw the cat at Acme.', {
        subject: { label: 'Anna' },
        predicate: 'works_at',
        object: { label: 'Acme' },
        evidenceQuote: 'Anna saw the cat at Acme.',
      }),
    ).toBe(false);
    // Possessives and ordinary prose still match.
    expect(
      graphRelationshipIsGrounded("Anna works at Acme's office.", {
        subject: { label: 'Anna' },
        predicate: 'works_at',
        object: { label: 'Acme' },
        evidenceQuote: "Anna works at Acme's office.",
      }),
    ).toBe(true);
  });

  it('backs facts into direct relations and expands a qualified seed by two hops', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [first] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Owner works at ${MARKER} Acme.`,
        contentHash: `${MARKER}-works`,
        embedding: unit(41),
        originTrust: 'owner',
      })
      .returning();
    await db.insert(memories).values({
      agentId,
      category: 'knowledge',
      kind: 'project',
      content: `${MARKER} Acme operates ${MARKER} Project Fox.`,
      contentHash: `${MARKER}-operates`,
      embedding: unit(42),
      originTrust: 'owner',
    });
    expect(first).toBeDefined();

    const synced = await syncKnowledgeGraph({ db, router }, { agentId });
    expect(synced.processed).toBeGreaterThanOrEqual(2);
    expect(synced.relationships).toBeGreaterThanOrEqual(2);

    const recalled = await recallKnowledgeGraph(db, {
      agentId,
      queryText: `${MARKER} where does the owner work`,
      queryEmbedding: unit(41),
    });
    expect(recalled.block).toContain('works at');
    expect(recalled.block).toContain('2 hops');
    expect(recalled.block).toContain(`${MARKER} Project Fox`);
    expect(recalled.sources.some((source) => source.kind === 'knowledge_graph')).toBe(true);
    expect(recalled.sources.some((source) => source.hops === 2)).toBe(true);
  });

  it('bounds graph assertions to historical source columns even when the model omits dates', async () => {
    if (!dbUp) throw new Error('Local PostgreSQL qualification database is required');
    const from = new Date('2019-01-01Z'),
      until = new Date('2023-01-01Z');
    const [source] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Owner works at ${MARKER} Acme.`,
        contentHash: `${MARKER}-source-scope`,
        originTrust: 'owner',
        validFrom: from,
        validUntil: until,
      })
      .returning();
    if (!source) throw new Error('Missing historical source');
    await syncKnowledgeGraph({ db, router }, { agentId });
    const relations = await db
      .select()
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.sourceMemoryId, source.id));
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      validFrom: from.toISOString(),
      validUntil: until.toISOString(),
    });
  });
  it('stores temporal qualifiers only when their wording is quoted and parseable', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Owner worked at ${MARKER} Acme from 2019 to March 2023. ${MARKER} Owner visited ${MARKER} Acme often.`,
        contentHash: `${MARKER}-qualifiers`,
        embedding: unit(44),
        originTrust: 'owner',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');

    const synced = await syncKnowledgeGraph({ db, router }, { agentId });
    expect(synced.relationships).toBeGreaterThanOrEqual(2);

    const relations = await db
      .select({
        predicate: knowledgeGraphRelations.predicate,
        assertion: knowledgeGraphRelations.assertion,
        validFrom: knowledgeGraphRelations.validFrom,
        validUntil: knowledgeGraphRelations.validUntil,
      })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.sourceMemoryId, memory.id));

    const worked = relations.find((row) => row.predicate === 'worked_at');
    expect(worked?.validFrom).toBe('2019');
    expect(worked?.validUntil).toBe('2023-03');
    expect(worked?.assertion).toMatchObject({
      tense: 'past',
      polarity: 'positive',
      modality: 'asserted',
    });

    // The edge survives; its ungrounded qualifiers do not.
    const visited = relations.find((row) => row.predicate === 'visited');
    expect(visited).toBeDefined();
    expect(visited?.validFrom).toBeNull();
    expect(visited?.validUntil).toBeNull();

    // And the span travels into recall, so a time-aware question has the
    // dates to reason over instead of a bare employer name.
    const recalled = await recallKnowledgeGraph(db, {
      agentId,
      queryText: `${MARKER} where did the owner work before`,
      queryEmbedding: unit(44),
    });
    expect(recalled.block).toContain('worked at');
    expect(recalled.block).toContain('[past]');
    expect(recalled.block).toContain('(2019 to 2023-03)');
  });

  it('re-extracts edited source content instead of retaining its old edge', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Owner works at ${MARKER} Original.`,
        contentHash: `${MARKER}-edited-original`,
        embedding: unit(43),
        originTrust: 'owner',
      })
      .returning();
    if (!memory) throw new Error('test memory was not created');
    await syncKnowledgeGraph({ db, router }, { agentId });

    await db
      .update(memories)
      .set({
        content: `${MARKER} Owner works at ${MARKER} Replacement.`,
        contentHash: `${MARKER}-edited-replacement`,
      })
      .where(eq(memories.id, memory.id));
    await syncKnowledgeGraph({ db, router }, { agentId });

    const relations = await db
      .select({ sourceMemoryId: knowledgeGraphRelations.sourceMemoryId })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.sourceMemoryId, memory.id));
    const [source] = await db
      .select({
        contentHash: knowledgeGraphSources.contentHash,
        status: knowledgeGraphSources.status,
      })
      .from(knowledgeGraphSources)
      .where(eq(knowledgeGraphSources.memoryId, memory.id));
    expect(relations).toHaveLength(1);
    expect(source).toEqual({ contentHash: `${MARKER}-edited-replacement`, status: 'ready' });
  });

  it('rebuilds legacy edges with quoted predicate evidence before recall uses them', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Owner works at ${MARKER} Versioned Employer.`,
        contentHash: `${MARKER}-legacy-evidence`,
        embedding: unit(50),
        originTrust: 'owner',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');
    await syncKnowledgeGraph({ db, router }, { agentId });
    await db
      .update(knowledgeGraphSources)
      .set({ extractionVersion: 1 })
      .where(eq(knowledgeGraphSources.memoryId, memory.id));
    await db
      .update(knowledgeGraphRelations)
      .set({ evidenceQuote: null })
      .where(eq(knowledgeGraphRelations.sourceMemoryId, memory.id));

    const legacyRecall = await recallKnowledgeGraph(db, {
      agentId,
      queryText: `${MARKER} versioned employer`,
      queryEmbedding: unit(50),
    });
    expect(legacyRecall.block).toBe('');

    const synced = await syncKnowledgeGraph({ db, router }, { agentId });
    expect(synced.processed).toBeGreaterThanOrEqual(1);
    const [source, relation] = await Promise.all([
      db
        .select({ extractionVersion: knowledgeGraphSources.extractionVersion })
        .from(knowledgeGraphSources)
        .where(eq(knowledgeGraphSources.memoryId, memory.id)),
      db
        .select({ evidenceQuote: knowledgeGraphRelations.evidenceQuote })
        .from(knowledgeGraphRelations)
        .where(eq(knowledgeGraphRelations.sourceMemoryId, memory.id)),
    ]);
    expect(source[0]?.extractionVersion).toBe(GRAPH_EXTRACTION_VERSION);
    expect(relation[0]?.evidenceQuote).toContain(`${MARKER} Owner works at`);

    const recalled = await recallKnowledgeGraph(db, {
      agentId,
      queryText: `${MARKER} versioned employer`,
      queryEmbedding: unit(50),
    });
    expect(recalled.block).toContain(`${MARKER} Versioned Employer`);
  });

  it('recovers a source left pending by an interrupted graph sync', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Owner works at ${MARKER} Recovered Employer.`,
        contentHash: `${MARKER}-recovered-pending`,
        embedding: unit(48),
        originTrust: 'owner',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');
    await db.insert(knowledgeGraphSources).values({
      memoryId: memory.id,
      contentHash: `${MARKER}-recovered-pending`,
      status: 'pending',
      extractionVersion: 2,
      attempts: 1,
      updatedAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    const synced = await syncKnowledgeGraph({ db, router }, { agentId });
    const [source] = await db
      .select({ status: knowledgeGraphSources.status, attempts: knowledgeGraphSources.attempts })
      .from(knowledgeGraphSources)
      .where(eq(knowledgeGraphSources.memoryId, memory.id));
    expect(synced.processed).toBeGreaterThanOrEqual(1);
    expect(source).toEqual({ status: 'ready', attempts: 1 });
  });

  it('backs off transient extraction failures, quarantines a persistent one, and retries after an edit', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Owner works at ${MARKER} Retry Employer.`,
        contentHash: `${MARKER}-retry-backoff-v1`,
        embedding: unit(52),
        originTrust: 'owner',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');

    let calls = 0;
    const failingRouter = {
      async object() {
        calls += 1;
        throw new Error('temporary extraction provider outage');
      },
    } as unknown as ModelRouter;

    const first = await syncKnowledgeGraph({ db, router: failingRouter }, { agentId });
    expect(first.failed).toBe(1);
    let [source] = await db
      .select({
        status: knowledgeGraphSources.status,
        attempts: knowledgeGraphSources.attempts,
        nextRetryAt: knowledgeGraphSources.nextRetryAt,
      })
      .from(knowledgeGraphSources)
      .where(eq(knowledgeGraphSources.memoryId, memory.id));
    expect(source).toMatchObject({ status: 'failed', attempts: 1 });
    expect(source?.nextRetryAt?.getTime()).toBeGreaterThan(Date.now());

    // The scheduler runs frequently, but the provider is not retried until the
    // saved deadline. Force each deadline into the past to test the bounded
    // retry ladder without waiting for real time.
    for (let attempt = 2; attempt <= 4; attempt += 1) {
      await db
        .update(knowledgeGraphSources)
        .set({ nextRetryAt: new Date(Date.now() - 1) })
        .where(eq(knowledgeGraphSources.memoryId, memory.id));
      const result = await syncKnowledgeGraph({ db, router: failingRouter }, { agentId });
      [source] = await db
        .select({
          status: knowledgeGraphSources.status,
          attempts: knowledgeGraphSources.attempts,
          nextRetryAt: knowledgeGraphSources.nextRetryAt,
        })
        .from(knowledgeGraphSources)
        .where(eq(knowledgeGraphSources.memoryId, memory.id));
      expect(source?.attempts).toBe(attempt);
      if (attempt < 4) {
        expect(result.failed).toBe(1);
        expect(source?.status).toBe('failed');
        expect(source?.nextRetryAt?.getTime()).toBeGreaterThan(Date.now());
      } else {
        expect(result.quarantined).toBe(1);
        expect(source).toMatchObject({ status: 'quarantined', nextRetryAt: null });
      }
    }
    expect(calls).toBe(4);
    const paused = await syncKnowledgeGraph({ db, router: failingRouter }, { agentId });
    expect(paused.candidates).toBe(0);
    expect(calls).toBe(4);

    // A source edit is a new fact. It clears the terminal checkpoint and gets
    // one fresh extraction attempt instead of requiring an operator to touch DB.
    await db
      .update(memories)
      .set({
        content: `${MARKER} Owner works at ${MARKER} Retry Employer Updated.`,
        contentHash: `${MARKER}-retry-backoff-v2`,
      })
      .where(eq(memories.id, memory.id));
    const recovered = await syncKnowledgeGraph({ db, router }, { agentId });
    const [recoveredSource] = await db
      .select({ status: knowledgeGraphSources.status, attempts: knowledgeGraphSources.attempts })
      .from(knowledgeGraphSources)
      .where(eq(knowledgeGraphSources.memoryId, memory.id));
    expect(recovered.processed).toBe(1);
    expect(recoveredSource).toEqual({ status: 'ready', attempts: 1 });
  });

  it('lets the owner resume quarantined sources without rewriting the source fact', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Owner works at ${MARKER} Manually Retried Employer.`,
        contentHash: `${MARKER}-manual-retry`,
        embedding: unit(53),
        originTrust: 'owner',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');
    await db.insert(knowledgeGraphSources).values({
      memoryId: memory.id,
      contentHash: `${MARKER}-manual-retry`,
      extractionVersion: 2,
      status: 'quarantined',
      attempts: 4,
      lastError: 'previous provider outage',
    });

    expect(await retryQuarantinedKnowledgeGraphSources(db, agentId)).toBe(1);
    const [requested] = await db
      .select({
        status: knowledgeGraphSources.status,
        attempts: knowledgeGraphSources.attempts,
        nextRetryAt: knowledgeGraphSources.nextRetryAt,
      })
      .from(knowledgeGraphSources)
      .where(eq(knowledgeGraphSources.memoryId, memory.id));
    expect(requested).toMatchObject({ status: 'failed', attempts: 0 });
    expect(requested?.nextRetryAt?.getTime()).toBeLessThanOrEqual(Date.now());

    const synced = await syncKnowledgeGraph({ db, router }, { agentId });
    const [recovered] = await db
      .select({ status: knowledgeGraphSources.status, attempts: knowledgeGraphSources.attempts })
      .from(knowledgeGraphSources)
      .where(eq(knowledgeGraphSources.memoryId, memory.id));
    expect(synced.processed).toBe(1);
    expect(recovered).toEqual({ status: 'ready', attempts: 1 });
  });

  it('lets one overlapping sync claim a source', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Owner works at ${MARKER} Concurrent Employer.`,
        contentHash: `${MARKER}-concurrent-claim`,
        embedding: unit(49),
        originTrust: 'owner',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');

    let calls = 0;
    const slowRouter = {
      async object() {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          ok: true,
          object: {
            relationships: [
              {
                subject: { label: `${MARKER} Owner`, kind: 'person' },
                predicate: 'works_at',
                object: { label: `${MARKER} Concurrent Employer`, kind: 'organization' },
                evidenceQuote: `${MARKER} Owner works at ${MARKER} Concurrent Employer.`,
                confidence: 0.9,
              },
            ],
          },
        };
      },
    } as unknown as ModelRouter;
    const [first, second] = await Promise.all([
      syncKnowledgeGraph({ db, router: slowRouter }, { agentId }),
      syncKnowledgeGraph({ db, router: slowRouter }, { agentId }),
    ]);

    expect(calls).toBe(1);
    expect(first.processed + second.processed).toBe(1);
  });

  it('does not publish an extraction after its PostgreSQL source changes', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const original = `${MARKER} Owner works at ${MARKER} Stale Employer.`;
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: original,
        contentHash: `${MARKER}-stale-extraction-v1`,
        embedding: unit(51),
        originTrust: 'owner',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const called = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slowRouter = {
      async object() {
        started();
        await waiting;
        return {
          ok: true,
          object: {
            relationships: [
              {
                subject: { label: `${MARKER} Owner`, kind: 'person' },
                predicate: 'works_at',
                object: { label: `${MARKER} Stale Employer`, kind: 'organization' },
                evidenceQuote: original,
                confidence: 0.9,
              },
            ],
          },
        };
      },
    } as unknown as ModelRouter;
    const syncing = syncKnowledgeGraph({ db, router: slowRouter }, { agentId });
    await called;
    await db
      .update(memories)
      .set({
        content: `${MARKER} Owner works at ${MARKER} Current Employer.`,
        contentHash: `${MARKER}-stale-extraction-v2`,
      })
      .where(eq(memories.id, memory.id));
    release();

    expect(await syncing).toMatchObject({ processed: 0, relationships: 0, entities: 0 });
    expect(
      await db
        .select({ id: knowledgeGraphRelations.id })
        .from(knowledgeGraphRelations)
        .where(eq(knowledgeGraphRelations.sourceMemoryId, memory.id)),
    ).toEqual([]);
  });

  it('keeps an owner-rejected edge out of recall and writes owner facts with evidence', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const saved = await createOwnerKnowledgeGraphFact(
      {
        db,
        agentId,
        router: {
          async embeddingSpace() {
            return { provider: 'test', model: 'embedding', dimensions: 1536, revision: '1' };
          },
          async embed() {
            return [unit(46)];
          },
        },
      },
      {
        subject: { label: `${MARKER} Owner`, kind: 'person' },
        predicate: 'owns',
        object: { label: `${MARKER} Manual Project`, kind: 'project' },
        note: 'I created this project and want it remembered.',
      },
    );
    expect(saved.error).toBeUndefined();
    if (!saved.memoryId || !saved.relationId) throw new Error('manual graph fact was not saved');

    const [source, relation] = await Promise.all([
      db
        .select({ status: knowledgeGraphSources.status })
        .from(knowledgeGraphSources)
        .where(eq(knowledgeGraphSources.memoryId, saved.memoryId)),
      db
        .select({ reviewStatus: knowledgeGraphRelations.reviewStatus })
        .from(knowledgeGraphRelations)
        .where(eq(knowledgeGraphRelations.id, saved.relationId)),
    ]);
    expect(source[0]?.status).toBe('ready');
    expect(relation[0]?.reviewStatus).toBe('confirmed');

    await db
      .update(knowledgeGraphRelations)
      .set({ reviewStatus: 'rejected' })
      .where(eq(knowledgeGraphRelations.id, saved.relationId));
    const recalled = await recallKnowledgeGraph(db, {
      agentId,
      queryText: `${MARKER} manual project`,
      queryEmbedding: unit(46),
    });
    expect(recalled.block).not.toContain(`${MARKER} Manual Project`);
  });

  /**
   * A typed subject label is resolved against every contact's name *and*
   * aliases, first match wins, with a prefix match as a fallback — so the
   * person page, which offers one specific contact, could have its fact and
   * the memory behind it attached to a different person who happens to hold
   * that name as an alias. The page now names the contact it meant.
   */
  it('binds a pinned subject to the contact named, not to an alias holder', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // Inserted first, so an unpinned label resolution would reach this one.
    const [namesake] = await db
      .insert(contacts)
      .values({
        name: `${MARKER} Bobby Vance`,
        aliases: [`${MARKER} Robert Vance`],
        trust: 'known',
      })
      .returning({ id: contacts.id });
    const [intended] = await db
      .insert(contacts)
      .values({ name: `${MARKER} Robert Vance`, aliases: [], trust: 'known' })
      .returning({ id: contacts.id });
    if (!intended || !namesake) throw new Error('contact fixtures were not created');

    const saved = await createOwnerKnowledgeGraphFact(
      {
        db,
        agentId,
        router: {
          async embeddingSpace() {
            return { provider: 'test', model: 'embedding', dimensions: 1536, revision: '1' };
          },
          async embed() {
            return [unit(52)];
          },
        },
      },
      {
        subject: {
          label: `${MARKER} Robert Vance`,
          kind: 'person',
          contactId: intended.id,
        },
        predicate: 'works_at',
        object: { label: `${MARKER} Vance Consulting`, kind: 'organization' },
        note: 'Told me over lunch.',
      },
    );
    expect(saved.error).toBeUndefined();
    if (!saved.memoryId) throw new Error('pinned owner fact was not saved');

    const [memory] = await db
      .select({ subjectContactId: memories.subjectContactId })
      .from(memories)
      .where(eq(memories.id, saved.memoryId));
    expect(memory?.subjectContactId).toBe(intended.id);
    expect(memory?.subjectContactId).not.toBe(namesake.id);

    // The entity the fact created has to belong to the same person.
    const [entity] = await db
      .select({ contactId: knowledgeGraphEntities.contactId })
      .from(knowledgeGraphEntities)
      .where(
        and(
          eq(knowledgeGraphEntities.agentId, agentId),
          eq(knowledgeGraphEntities.label, `${MARKER} Robert Vance`),
        ),
      );
    expect(entity?.contactId).toBe(intended.id);
  });

  it('links an owner fact to existing entities by id, without retyping names', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [subject, object] = await db
      .insert(knowledgeGraphEntities)
      .values([
        {
          agentId,
          canonicalKey: `person:${MARKER} linked person`,
          label: `${MARKER} Linked Person`,
          kind: 'person',
        },
        {
          agentId,
          canonicalKey: `organization:${MARKER} linked org`,
          label: `${MARKER} Linked Org`,
          kind: 'organization',
        },
      ])
      .returning({ id: knowledgeGraphEntities.id });

    const saved = await createOwnerKnowledgeGraphFact(
      {
        db,
        agentId,
        router: {
          async embeddingSpace() {
            return { provider: 'test', model: 'embedding', dimensions: 1536, revision: '1' };
          },
          async embed() {
            return [unit(45)];
          },
        },
      },
      {
        // Labels deliberately empty: an id-resolved endpoint takes its label
        // and kind from the entity itself.
        subject: { label: '', kind: 'topic', id: subject?.id },
        predicate: 'advises',
        object: { label: '', kind: 'topic', id: object?.id },
        note: 'Board work the owner noted directly.',
      },
    );
    expect(saved.error).toBeUndefined();
    if (!saved.relationId) throw new Error('owner fact was not saved');
    const [relation] = await db
      .select({
        subjectEntityId: knowledgeGraphRelations.subjectEntityId,
        objectEntityId: knowledgeGraphRelations.objectEntityId,
      })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.id, saved.relationId));
    expect(relation?.subjectEntityId).toBe(subject?.id);
    expect(relation?.objectEntityId).toBe(object?.id);

    // A stale id is a clean refusal, not a half-written fact.
    const stale = await createOwnerKnowledgeGraphFact(
      {
        db,
        agentId,
        router: {
          async embeddingSpace() {
            return { provider: 'test', model: 'embedding', dimensions: 1536, revision: '1' };
          },
          async embed() {
            return [unit(45)];
          },
        },
      },
      {
        subject: { label: '', kind: 'person', id: '00000000-0000-4000-8000-000000000000' },
        predicate: 'advises',
        object: { label: '', kind: 'organization', id: object?.id },
        note: 'Board work the owner noted directly.',
      },
    );
    expect(stale.error).toContain('no longer exists');
  });

  it('retypes an entity and records its old identity as an alias', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [entity] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `organization:${MARKER} retype me`,
        label: `${MARKER} Retype Me`,
        kind: 'organization',
      })
      .returning({ id: knowledgeGraphEntities.id });
    if (!entity) throw new Error('retype fixture was not created');

    const result = await retypeGraphEntity(db, agentId, entity.id, 'project');
    expect(result.error).toBeUndefined();

    const [updated] = await db
      .select({
        kind: knowledgeGraphEntities.kind,
        canonicalKey: knowledgeGraphEntities.canonicalKey,
      })
      .from(knowledgeGraphEntities)
      .where(eq(knowledgeGraphEntities.id, entity.id));
    expect(updated).toEqual({
      kind: 'project',
      canonicalKey: `project:${normalizedKey(`${MARKER} retype me`)}`,
    });

    // The old identity resolves to the same node, so a delayed extraction of
    // an older source never recreates it under the previous kind.
    const [aliasRow] = await db
      .select({ entityId: knowledgeGraphEntityAliases.entityId })
      .from(knowledgeGraphEntityAliases)
      .where(
        and(
          eq(knowledgeGraphEntityAliases.agentId, agentId),
          eq(knowledgeGraphEntityAliases.canonicalKey, `organization:${MARKER} retype me`),
        ),
      );
    expect(aliasRow?.entityId).toBe(entity.id);

    // Retyping back is a no-op-succeeds path, and the same kind is a no-op.
    expect((await retypeGraphEntity(db, agentId, entity.id, 'project')).error).toBeUndefined();
  });

  it('declines a retype that would collide with an existing entity', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [entity] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `organization:${MARKER} manual project`,
        label: `${MARKER} Manual Project`,
        kind: 'organization',
      })
      .returning({ id: knowledgeGraphEntities.id });
    if (!entity) throw new Error('collision fixture was not created');

    // The owner-fact test above created `project:${MARKER} manual project`.
    const result = await retypeGraphEntity(db, agentId, entity.id, 'project');
    expect(result.error).toContain('Merge');
  });

  it('refuses to retype a date entity', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [entity] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: 'date:2027-01-15',
        label: '15 January 2027',
        kind: 'date',
      })
      .returning({ id: knowledgeGraphEntities.id });
    if (!entity) throw new Error('date fixture was not created');
    const result = await retypeGraphEntity(db, agentId, entity.id, 'event');
    expect(result.error).toContain('canonical');
  });

  it.for(['confirmed', 'rejected'] as const)(
    'deduplicates edges while preserving the %s owner decision',
    async (reviewStatus, ctx) => {
      if (!dbUp) return ctx.skip();
      const reviewMarker = `${MARKER}-${reviewStatus}`;
      const [memory] = await db
        .insert(memories)
        .values({
          agentId,
          category: 'knowledge',
          kind: 'fact',
          content: `${reviewMarker} dedup source.`,
          contentHash: `${reviewMarker}-dedup-source`,
          embedding: unit(69),
          originTrust: 'owner',
        })
        .returning({ id: memories.id });
      if (!memory) throw new Error('dedup memory was not created');
      const [target, absorbed, other] = await db
        .insert(knowledgeGraphEntities)
        .values([
          {
            agentId,
            canonicalKey: `topic:${reviewMarker} dedup target`,
            label: `${reviewMarker} Dedup Target`,
            kind: 'topic',
          },
          {
            agentId,
            canonicalKey: `topic:${reviewMarker} dedup absorbed`,
            label: `${reviewMarker} Dedup Absorbed`,
            kind: 'topic',
          },
          {
            agentId,
            canonicalKey: `organization:${reviewMarker} dedup other`,
            label: `${reviewMarker} Dedup Other`,
            kind: 'organization',
          },
        ])
        .returning({ id: knowledgeGraphEntities.id });
      if (!target || !absorbed || !other) throw new Error('dedup fixtures were not created');

      await db.insert(knowledgeGraphRelations).values([
        // The confirmed edge on the survivor.
        {
          agentId,
          subjectEntityId: target.id,
          predicate: 'likes',
          objectEntityId: other.id,
          sourceMemoryId: memory.id,
          evidenceQuote: `${reviewMarker} dedup source.`,
          sourceFingerprint: `${reviewMarker}-dedup-a`,
          ordinal: 1,
          confidence: '0.90',
          reviewStatus,
        },
        // The same semantic edge on the absorbed entity, still unreviewed.
        {
          agentId,
          subjectEntityId: absorbed.id,
          predicate: 'likes',
          objectEntityId: other.id,
          sourceMemoryId: memory.id,
          evidenceQuote: `${reviewMarker} dedup source.`,
          sourceFingerprint: `${reviewMarker}-dedup-b`,
          ordinal: 2,
          confidence: '0.95',
          reviewStatus: 'unreviewed' as const,
        },
        // An edge between the two, which becomes a self-loop after the merge.
        {
          agentId,
          subjectEntityId: target.id,
          predicate: 'mentions',
          objectEntityId: absorbed.id,
          sourceMemoryId: memory.id,
          evidenceQuote: `${reviewMarker} dedup source.`,
          sourceFingerprint: `${reviewMarker}-dedup-self`,
          ordinal: 3,
          confidence: '0.80',
        },
      ]);

      await mergeGraphEntities(db, agentId, absorbed.id, target.id);

      const remaining = await db
        .select({
          predicate: knowledgeGraphRelations.predicate,
          reviewStatus: knowledgeGraphRelations.reviewStatus,
          confidence: knowledgeGraphRelations.confidence,
        })
        .from(knowledgeGraphRelations)
        .where(eq(knowledgeGraphRelations.sourceMemoryId, memory.id));
      // One deduplicated edge survives; the self-loop is gone.
      expect(remaining).toEqual([{ predicate: 'likes', reviewStatus, confidence: '0.90' }]);
    },
  );

  it('retains a matching owner decision when its source is re-extracted', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Owner works at ${MARKER} Acme.`,
        contentHash: `${MARKER}-reviewed-source-v1`,
        embedding: unit(47),
        originTrust: 'owner',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('test memory was not created');
    await syncKnowledgeGraph({ db, router }, { agentId });
    const [edge] = await db
      .select({ id: knowledgeGraphRelations.id, assertionId: knowledgeGraphRelations.assertionId })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.sourceMemoryId, memory.id));
    if (!edge) throw new Error('graph relationship was not created');
    await db
      .update(knowledgeGraphRelations)
      .set({ reviewStatus: 'rejected' })
      .where(eq(knowledgeGraphRelations.id, edge.id));
    if (edge.assertionId)
      await db
        .update(knowledgeGraphAssertions)
        .set({ reviewStatus: 'rejected', reviewedRevision: 1 })
        .where(eq(knowledgeGraphAssertions.id, edge.assertionId));

    await db
      .update(memories)
      .set({
        content: `${MARKER} Owner works at ${MARKER} Acme. This is current.`,
        contentHash: `${MARKER}-reviewed-source-v2`,
      })
      .where(eq(memories.id, memory.id));
    await syncKnowledgeGraph({ db, router }, { agentId });
    const [reextracted] = await db
      .select({ reviewStatus: knowledgeGraphRelations.reviewStatus })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.sourceMemoryId, memory.id));
    expect(reextracted?.reviewStatus).toBe('rejected');
  });

  it('keeps owner review on one canonical meaning and does not transfer it after semantic change', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const owner = `${MARKER} CanonicalOwner ${suffix}`;
    const employer = `${MARKER} CanonicalEmployer ${suffix}`;
    let firstText = `${owner} works at ${employer}.`;
    let worked = false;
    const focusedRouter = {
      async object() {
        return {
          ok: true,
          object: {
            relationships: [
              {
                subject: { label: owner, kind: 'person' },
                subjectSpan: owner,
                predicate: worked ? 'worked_at' : 'works_at',
                predicateSpan: worked ? 'worked at' : 'works at',
                object: { label: employer, kind: 'organization' },
                objectSpan: employer,
                evidenceQuote: firstText,
                assertion: {
                  tense: worked ? 'past' : 'present',
                  polarity: 'positive',
                  modality: 'asserted',
                },
                confidence: 0.9,
                ...(worked ? { validFrom: '2019', validUntil: 'March 2023' } : {}),
              },
            ],
          },
        };
      },
    } as unknown as ModelRouter;
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: firstText,
        contentHash: `${MARKER}-assertion-v1`,
        embedding: unit(75),
        originTrust: 'owner',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('canonical assertion fixture was not created');
    await syncKnowledgeGraph({ db, router: focusedRouter }, { agentId });
    const [firstRelation] = await db
      .select({ assertionId: knowledgeGraphRelations.assertionId })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.sourceMemoryId, memory.id));
    if (!firstRelation?.assertionId)
      throw new Error('source relation was not linked to its canonical assertion');
    const [firstAssertion] = await db
      .select({
        semanticKey: knowledgeGraphAssertions.semanticKey,
        semanticRevision: knowledgeGraphAssertions.semanticRevision,
      })
      .from(knowledgeGraphAssertions)
      .where(eq(knowledgeGraphAssertions.id, firstRelation.assertionId));
    if (!firstAssertion) throw new Error('canonical assertion was not created');
    await db
      .update(knowledgeGraphAssertions)
      .set({
        reviewStatus: 'rejected',
        reviewedRevision: firstAssertion.semanticRevision,
        reviewedPayloadHash: firstAssertion.semanticKey,
      })
      .where(eq(knowledgeGraphAssertions.id, firstRelation.assertionId));

    worked = true;
    firstText = `${owner} worked at ${employer} from 2019 to March 2023.`;
    const revisedText = firstText;
    await db
      .update(memories)
      .set({ content: revisedText, contentHash: `${MARKER}-assertion-v2` })
      .where(eq(memories.id, memory.id));
    await syncKnowledgeGraph({ db, router: focusedRouter }, { agentId });
    const [secondRelation] = await db
      .select({ assertionId: knowledgeGraphRelations.assertionId })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.sourceMemoryId, memory.id));
    if (!secondRelation?.assertionId)
      throw new Error('revised relation was not linked to a canonical assertion');
    expect(secondRelation.assertionId).not.toBe(firstRelation.assertionId);
    const [oldAssertion] = await db
      .select({
        lifecycle: knowledgeGraphAssertions.lifecycle,
        reviewStatus: knowledgeGraphAssertions.reviewStatus,
      })
      .from(knowledgeGraphAssertions)
      .where(eq(knowledgeGraphAssertions.id, firstRelation.assertionId));
    const [newAssertion] = await db
      .select({
        lifecycle: knowledgeGraphAssertions.lifecycle,
        reviewStatus: knowledgeGraphAssertions.reviewStatus,
      })
      .from(knowledgeGraphAssertions)
      .where(eq(knowledgeGraphAssertions.id, secondRelation.assertionId));
    expect(oldAssertion).toEqual({ lifecycle: 'retracted', reviewStatus: 'rejected' });
    expect(newAssertion).toEqual({ lifecycle: 'current', reviewStatus: 'unreviewed' });
    expect(
      await db
        .select({ id: knowledgeGraphAssertionEvidence.id })
        .from(knowledgeGraphAssertionEvidence)
        .where(eq(knowledgeGraphAssertionEvidence.assertionId, firstRelation.assertionId)),
    ).toEqual([]);
    expect(
      (
        await db
          .select({ id: knowledgeGraphAssertionEvidence.id })
          .from(knowledgeGraphAssertionEvidence)
          .where(eq(knowledgeGraphAssertionEvidence.assertionId, secondRelation.assertionId))
      ).length,
    ).toBe(1);
  });

  it('preserves a reviewed canonical meaning and both source lineages when merged', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const ownerA = `${MARKER} Merge Owner A ${suffix}`;
    const ownerB = `${MARKER} Merge Owner B ${suffix}`;
    const employerLabel = `${MARKER} Merge Employer ${suffix}`;
    const assertion = {
      tense: 'present' as const,
      polarity: 'positive' as const,
      modality: 'asserted' as const,
    };
    const [ownerSource, ownerTarget, employer] = await db
      .insert(knowledgeGraphEntities)
      .values([
        { agentId, canonicalKey: `person:${normalizedKey(ownerA)}`, label: ownerA, kind: 'person' },
        { agentId, canonicalKey: `person:${normalizedKey(ownerB)}`, label: ownerB, kind: 'person' },
        {
          agentId,
          canonicalKey: `organization:${normalizedKey(employerLabel)}`,
          label: employerLabel,
          kind: 'organization',
        },
      ])
      .returning({ id: knowledgeGraphEntities.id });
    if (!ownerSource || !ownerTarget || !employer)
      throw new Error('canonical merge entities were not created');
    const [memoryA, memoryB] = await db
      .insert(memories)
      .values([
        {
          agentId,
          category: 'knowledge',
          kind: 'fact',
          content: `${ownerA} works at ${employerLabel}.`,
          contentHash: `${MARKER}-merge-a-${suffix}`,
          embedding: unit(79),
          originTrust: 'owner',
        },
        {
          agentId,
          category: 'knowledge',
          kind: 'fact',
          content: `${ownerB} works at ${employerLabel}.`,
          contentHash: `${MARKER}-merge-b-${suffix}`,
          embedding: unit(80),
          originTrust: 'owner',
        },
      ])
      .returning({ id: memories.id, content: memories.content, contentHash: memories.contentHash });
    if (!memoryA || !memoryB) throw new Error('canonical merge memories were not created');
    const meaningFor = (subjectEntityId: string) =>
      canonicalizeKnowledgeAssertionDirection({
        subjectEntityId,
        predicate: 'works_at',
        objectEntityId: employer.id,
        assertion,
        validFrom: null,
        validUntil: null,
        qualifiers: {},
      });
    const sourceMeaning = meaningFor(ownerSource.id);
    const targetMeaning = meaningFor(ownerTarget.id);
    const sourceKey = knowledgeAssertionSemanticKey(agentId, sourceMeaning);
    const targetKey = knowledgeAssertionSemanticKey(agentId, targetMeaning);
    const sourceAssertion = knowledgeAssertionId(agentId, sourceKey);
    const targetAssertion = knowledgeAssertionId(agentId, targetKey);
    const reviewed = (
      subjectEntityId: string,
      semanticKey: string,
      id: string,
      reviewStatus: 'confirmed' | 'unreviewed',
    ) => ({
      id,
      agentId,
      semanticKey,
      subjectEntityId,
      predicate: 'works_at',
      objectEntityId: employer.id,
      assertion,
      qualifiers: {},
      validFrom: null,
      validUntil: null,
      semanticRevision: 1,
      evidenceRevision: 1,
      lifecycle: 'current' as const,
      reviewStatus,
      reviewedRevision: reviewStatus === 'confirmed' ? 1 : null,
      reviewedPayloadHash: reviewStatus === 'confirmed' ? semanticKey : null,
      ownerAuthored: false,
      supersededById: null,
    });
    await db
      .insert(knowledgeGraphAssertions)
      .values([
        reviewed(ownerSource.id, sourceKey, sourceAssertion, 'confirmed'),
        reviewed(ownerTarget.id, targetKey, targetAssertion, 'unreviewed'),
      ]);
    await db.insert(knowledgeGraphRelations).values([
      {
        agentId,
        subjectEntityId: ownerSource.id,
        predicate: 'works_at',
        objectEntityId: employer.id,
        assertion,
        assertionId: sourceAssertion,
        sourceMemoryId: memoryA.id,
        sourceFingerprint: `merge-a-${suffix}`,
        ordinal: 0,
        evidenceQuote: memoryA.content,
        reviewStatus: 'confirmed',
      },
      {
        agentId,
        subjectEntityId: ownerTarget.id,
        predicate: 'works_at',
        objectEntityId: employer.id,
        assertion,
        assertionId: targetAssertion,
        sourceMemoryId: memoryB.id,
        sourceFingerprint: `merge-b-${suffix}`,
        ordinal: 0,
        evidenceQuote: memoryB.content,
        reviewStatus: 'unreviewed',
      },
    ]);
    await db.insert(knowledgeGraphAssertionEvidence).values([
      ...[
        { id: sourceAssertion, memory: memoryA, fingerprint: `merge-a-${suffix}` },
        { id: targetAssertion, memory: memoryB, fingerprint: `merge-b-${suffix}` },
      ].map(({ id, memory, fingerprint }) => ({
        id: knowledgeAssertionEvidenceId(agentId, id, memory.id, fingerprint),
        agentId,
        assertionId: id,
        sourceMemoryId: memory.id,
        sourceFingerprint: fingerprint,
        sourceContentHash: memory.contentHash ?? '',
        evidenceQuote: memory.content,
        sourceAuthor: 'owner',
        sourceTrust: 'owner',
        independent: false,
        spanStart: 0,
        spanEnd: memory.content.length,
        extractionVersion: GRAPH_EXTRACTION_VERSION,
        evidenceRevision: 1,
        observedAt: new Date(),
      })),
    ]);

    await mergeGraphEntities(db, agentId, ownerSource.id, ownerTarget.id);
    const [oldAfterMerge] = await db
      .select({
        lifecycle: knowledgeGraphAssertions.lifecycle,
        supersededById: knowledgeGraphAssertions.supersededById,
      })
      .from(knowledgeGraphAssertions)
      .where(eq(knowledgeGraphAssertions.id, sourceAssertion));
    const [survivorAfterMerge] = await db
      .select({
        lifecycle: knowledgeGraphAssertions.lifecycle,
        reviewStatus: knowledgeGraphAssertions.reviewStatus,
        reviewedPayloadHash: knowledgeGraphAssertions.reviewedPayloadHash,
      })
      .from(knowledgeGraphAssertions)
      .where(eq(knowledgeGraphAssertions.id, targetAssertion));
    // The former assertion points at an absorbed entity. PostgreSQL cascades
    // that row when the entity is removed; its source evidence has already
    // been moved to the surviving canonical assertion below.
    expect(oldAfterMerge).toBeUndefined();
    expect(survivorAfterMerge).toEqual({
      lifecycle: 'current',
      reviewStatus: 'confirmed',
      reviewedPayloadHash: targetKey,
    });
    const projected = await db
      .select({
        assertionId: knowledgeGraphRelations.assertionId,
        reviewStatus: knowledgeGraphRelations.reviewStatus,
      })
      .from(knowledgeGraphRelations)
      .where(inArray(knowledgeGraphRelations.sourceMemoryId, [memoryA.id, memoryB.id]));
    expect(projected).toHaveLength(2);
    expect(projected.map((row) => row.assertionId)).toEqual([targetAssertion, targetAssertion]);
    const lineages = await db
      .select({ sourceMemoryId: knowledgeGraphAssertionEvidence.sourceMemoryId })
      .from(knowledgeGraphAssertionEvidence)
      .where(eq(knowledgeGraphAssertionEvidence.assertionId, targetAssertion));
    expect(lineages.map((row) => row.sourceMemoryId).sort()).toEqual(
      [memoryA.id, memoryB.id].sort(),
    );
  });

  it('does not recall an assertion when its canonical review state rejects a stale projection', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const content = `${MARKER} CanonicalRecallOwner ${suffix} works at ${MARKER} CanonicalRecallOrg ${suffix}.`;
    const focusedRouter = {
      async object() {
        return {
          ok: true,
          object: {
            relationships: [
              {
                subject: { label: `${MARKER} CanonicalRecallOwner ${suffix}`, kind: 'person' },
                subjectSpan: `${MARKER} CanonicalRecallOwner ${suffix}`,
                predicate: 'works_at',
                predicateSpan: 'works at',
                object: { label: `${MARKER} CanonicalRecallOrg ${suffix}`, kind: 'organization' },
                objectSpan: `${MARKER} CanonicalRecallOrg ${suffix}`,
                evidenceQuote: content,
                confidence: 0.9,
              },
            ],
          },
        };
      },
    } as unknown as ModelRouter;
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content,
        contentHash: `${MARKER}-canonical-recall-${suffix}`,
        embedding: unit(79),
        originTrust: 'owner',
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('canonical recall fixture was not created');
    await syncKnowledgeGraph({ db, router: focusedRouter }, { agentId });
    const [edge] = await db
      .select({ assertionId: knowledgeGraphRelations.assertionId })
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.sourceMemoryId, memory.id));
    if (!edge?.assertionId) throw new Error('canonical recall edge has no assertion');
    // Simulate a stale edge projection after a canonical owner decision.
    await db
      .update(knowledgeGraphAssertions)
      .set({ reviewStatus: 'rejected' })
      .where(eq(knowledgeGraphAssertions.id, edge.assertionId));
    const recalled = await recallKnowledgeGraph(db, {
      agentId,
      queryText: `${MARKER} where does canonical recall owner work`,
      queryEmbedding: unit(79),
    });
    expect(recalled.block).not.toContain(`CanonicalRecallOrg ${suffix}`);
  });

  // Date entities used to be whatever the extractor said, so "Friday", "next
  // Friday" and "2026-03-06" were three permanent, unmergeable nodes.
  it('collapses differently worded dates onto one canonical entity', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const recordedAt = new Date('2026-03-04T12:00:00Z');
    const content = `${MARKER} Dana meets the board on Friday.`;
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content,
        contentHash: `${MARKER}-date-1`,
        embedding: unit(60),
        confidence: '0.90',
        createdAt: recordedAt,
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('fixture memory was not created');

    const dateRouter = {
      async object() {
        return {
          ok: true,
          object: {
            relationships: [
              {
                subject: { label: `${MARKER} Dana`, kind: 'person' },
                predicate: 'meets_the_board_on',
                object: { label: '2026-03-06', kind: 'date' },
                subjectSpan: `${MARKER} Dana`,
                predicateSpan: 'meets the board on',
                objectSpan: 'Friday',
                evidenceQuote: `${MARKER} Dana meets the board on Friday`,
                confidence: 0.9,
              },
            ],
          },
        };
      },
    } as unknown as ModelRouter;
    await syncKnowledgeGraph({ db, router: dateRouter }, { agentId, limit: 5 });

    const [dateEntity] = await db
      .select({ key: knowledgeGraphEntities.canonicalKey, label: knowledgeGraphEntities.label })
      .from(knowledgeGraphEntities)
      .where(
        and(eq(knowledgeGraphEntities.agentId, agentId), eq(knowledgeGraphEntities.kind, 'date')),
      );
    // Resolved against the memory's own timestamp, not against "now".
    expect(dateEntity?.key).toBe('date:2026-03-06');
    expect(dateEntity?.label).not.toBe('Friday');
  });

  it('accepts canonical date labels only when their literal surface resolves to the same source date', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const anchor = new Date('2026-10-07T12:00:00Z');
    const cases = [
      { suffix: 'tomorrow', label: '2026-10-08', span: 'tomorrow' },
      { suffix: 'Friday', label: '2026-10-09', span: 'Friday' },
      { suffix: 'next month', label: '2026-11', span: 'next month' },
      { suffix: 'March 6, 2026', label: '2026-03-06', span: 'March 6, 2026' },
      { suffix: '2026-03-06', label: '2026-03-06', span: '2026-03-06' },
    ];
    const sourceIds: string[] = [];
    for (const [index, item] of cases.entries()) {
      const content = `${MARKER} trip ${index} starts ${item.suffix}.`;
      const [memory] = await db
        .insert(memories)
        .values({
          agentId,
          category: 'knowledge',
          kind: 'fact',
          content,
          contentHash: `${MARKER}-surface-date-${index}`,
          embedding: unit(70 + index),
          confidence: '0.90',
          createdAt: anchor,
        })
        .returning({ id: memories.id });
      if (!memory) throw new Error('date surface fixture was not created');
      sourceIds.push(memory.id);
    }
    const router = {
      async object(_operation: string, input: { prompt: string; system: string }) {
        const index = cases.findIndex((item, candidate) =>
          input.prompt.includes(`trip ${candidate} starts ${item.suffix}`),
        );
        const item = cases[index];
        if (!item) throw new Error('date extraction prompt did not match a fixture');
        expect(input.system).toContain('subjectSpan, predicateSpan, and objectSpan');
        return {
          ok: true,
          object: {
            relationships: [
              {
                subject: { label: `trip ${index}`, kind: 'event' },
                subjectSpan: `trip ${index}`,
                predicate: 'starts_on',
                predicateSpan: 'starts',
                object: { label: item.label, kind: 'date' },
                objectSpan: item.span,
                evidenceQuote: `trip ${index} starts ${item.span}`,
                confidence: 0.9,
              },
            ],
          },
        };
      },
    } as unknown as ModelRouter;
    const result = await syncKnowledgeGraph({ db, router }, { agentId, limit: 10 });
    expect(result.relationships).toBe(cases.length);
    expect(result.rejected).toBe(0);
    const dates = await db
      .select({ key: knowledgeGraphEntities.canonicalKey })
      .from(knowledgeGraphEntities)
      .where(
        and(
          eq(knowledgeGraphEntities.agentId, agentId),
          eq(knowledgeGraphEntities.kind, 'date'),
          inArray(knowledgeGraphEntities.canonicalKey, [
            'date:2026-10-08',
            'date:2026-10-09',
            'date:2026-11',
            'date:2026-03-06',
          ]),
        ),
      );
    expect(new Set(dates.map((row) => row.key))).toEqual(
      new Set(['date:2026-10-08', 'date:2026-10-09', 'date:2026-11', 'date:2026-03-06']),
    );
  });

  it('drops an edge whose date cannot be pinned down rather than storing the wording', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const content = `${MARKER} Ezra ships the rewrite eventually.`;
    await db.insert(memories).values({
      agentId,
      category: 'knowledge',
      kind: 'fact',
      content,
      contentHash: `${MARKER}-date-2`,
      embedding: unit(61),
      confidence: '0.90',
    });
    const vagueRouter = {
      async object() {
        return {
          ok: true,
          object: {
            relationships: [
              {
                subject: { label: `${MARKER} Ezra`, kind: 'person' },
                predicate: 'ships_the_rewrite',
                object: { label: 'eventually', kind: 'date' },
                evidenceQuote: `${MARKER} Ezra ships the rewrite eventually`,
                confidence: 0.9,
              },
            ],
          },
        };
      },
    } as unknown as ModelRouter;
    await syncKnowledgeGraph({ db, router: vagueRouter }, { agentId, limit: 5 });

    const stored = await db
      .select({ label: knowledgeGraphEntities.label })
      .from(knowledgeGraphEntities)
      .where(
        and(eq(knowledgeGraphEntities.agentId, agentId), eq(knowledgeGraphEntities.kind, 'date')),
      );
    expect(stored.map((row) => row.label)).not.toContain('eventually');
  });

  // The label was rewritten on every extraction, so the displayed name changed
  // with whichever run happened last while the identity underneath never did.
  it('keeps the better-cased label when a re-extraction spells it differently', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const content = `${MARKER} Fern works at ${MARKER} Northwind.`;
    await db.insert(memories).values({
      agentId,
      category: 'knowledge',
      kind: 'fact',
      content,
      contentHash: `${MARKER}-case-1`,
      embedding: unit(62),
      confidence: '0.90',
    });
    const casedRouter = (label: string) =>
      ({
        async object() {
          return {
            ok: true,
            object: {
              relationships: [
                {
                  subject: { label: `${MARKER} Fern`, kind: 'person' },
                  predicate: 'works_at',
                  object: { label, kind: 'organization' },
                  evidenceQuote: `${MARKER} Fern works at ${MARKER} Northwind`,
                  confidence: 0.9,
                },
              ],
            },
          };
        },
      }) as unknown as ModelRouter;

    await syncKnowledgeGraph({ db, router: casedRouter(`${MARKER} Northwind`) }, { agentId });
    // Force a re-extraction of the same source with a worse spelling.
    const [cased] = await db
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.contentHash, `${MARKER}-case-1`))
      .limit(1);
    if (!cased) throw new Error('fixture memory was not found');
    await db
      .update(knowledgeGraphSources)
      .set({ status: 'failed', nextRetryAt: new Date(), attempts: 0 })
      .where(eq(knowledgeGraphSources.memoryId, cased.id));
    await syncKnowledgeGraph(
      { db, router: casedRouter(`${MARKER.toLowerCase()} northwind`) },
      { agentId },
    );

    const [org] = await db
      .select({ label: knowledgeGraphEntities.label })
      .from(knowledgeGraphEntities)
      .where(
        and(
          eq(knowledgeGraphEntities.agentId, agentId),
          eq(
            knowledgeGraphEntities.canonicalKey,
            `organization:${normalizedKey(MARKER)} northwind`,
          ),
        ),
      );
    expect(org?.label).toBe(`${MARKER} Northwind`);
  });

  it('canonicalizes existing date entities without calling a model', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // backfillKnowledgeGraphDates takes no router at all — being unable to make
    // a model call is a property of its signature, not of this fixture.
    const recordedAt = new Date('2026-03-04T12:00:00Z');
    const [memory] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Gale lands on 2026-03-06.`,
        contentHash: `${MARKER}-backfill-1`,
        embedding: unit(63),
        confidence: '0.90',
        createdAt: recordedAt,
      })
      .returning({ id: memories.id });
    if (!memory) throw new Error('fixture memory was not created');

    // Two spellings of the same day, as the old extractor would have left them.
    const [legacy] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: 'date:friday',
        label: 'Friday',
        kind: 'date',
      })
      .returning({ id: knowledgeGraphEntities.id });
    const [iso] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: 'date:6 march 2026',
        label: '6 March 2026',
        kind: 'date',
      })
      .returning({ id: knowledgeGraphEntities.id });
    const [person] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `person:${MARKER.toLowerCase()} gale`,
        label: `${MARKER} Gale`,
        kind: 'person',
      })
      .returning({ id: knowledgeGraphEntities.id });
    if (!legacy || !iso || !person) throw new Error('fixture entities were not created');

    for (const [index, target] of [legacy, iso].entries()) {
      await db.insert(knowledgeGraphRelations).values({
        agentId,
        subjectEntityId: person.id,
        predicate: 'lands_on',
        objectEntityId: target.id,
        sourceMemoryId: memory.id,
        evidenceQuote: `${MARKER} Gale lands on 2026-03-06`,
        sourceFingerprint: `${MARKER}-backfill-fp-${index}`,
        ordinal: index + 1,
        confidence: '0.90',
      });
    }

    const result = await backfillKnowledgeGraphDates(db, { agentId });
    expect(result.scanned).toBeGreaterThanOrEqual(2);
    expect(result.merged).toBeGreaterThanOrEqual(1);

    const dates = await db
      .select({ key: knowledgeGraphEntities.canonicalKey })
      .from(knowledgeGraphEntities)
      .where(
        and(eq(knowledgeGraphEntities.agentId, agentId), eq(knowledgeGraphEntities.kind, 'date')),
      );
    // Both spellings now point at the same canonical day.
    expect(dates.filter((row) => row.key === 'date:2026-03-06')).toHaveLength(1);
    expect(dates.map((row) => row.key)).not.toContain('date:friday');
  });

  // A relative label means a different day depending on when it was written,
  // and one entity is shared by every memory that used that wording. Resolving
  // it against the earliest citation alone would repoint a later memory's edge
  // to a day that memory never meant.
  it('leaves a shared relative date alone when its sources would disagree', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [early] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Iris presents on Friday.`,
        contentHash: `${MARKER}-shared-1`,
        embedding: unit(65),
        confidence: '0.90',
        createdAt: new Date('2026-03-04T12:00:00Z'),
      })
      .returning({ id: memories.id });
    const [late] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Jonah travels on Friday.`,
        contentHash: `${MARKER}-shared-2`,
        embedding: unit(66),
        confidence: '0.90',
        // Five weeks later — a different Friday entirely.
        createdAt: new Date('2026-04-08T12:00:00Z'),
      })
      .returning({ id: memories.id });
    const [shared] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `date:${MARKER} friday`,
        label: 'Friday',
        kind: 'date',
      })
      .returning({ id: knowledgeGraphEntities.id });
    const [who] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `person:${MARKER} iris`,
        label: `${MARKER} Iris`,
        kind: 'person',
      })
      .returning({ id: knowledgeGraphEntities.id });
    if (!early || !late || !shared || !who) throw new Error('fixtures were not created');

    for (const [index, source] of [early, late].entries()) {
      await db.insert(knowledgeGraphRelations).values({
        agentId,
        subjectEntityId: who.id,
        predicate: 'happens_on',
        objectEntityId: shared.id,
        sourceMemoryId: source.id,
        evidenceQuote: 'on Friday',
        sourceFingerprint: `${MARKER}-shared-fp-${index}`,
        ordinal: index + 1,
        confidence: '0.90',
      });
    }

    await backfillKnowledgeGraphDates(db, { agentId });

    const [after] = await db
      .select({ key: knowledgeGraphEntities.canonicalKey })
      .from(knowledgeGraphEntities)
      .where(eq(knowledgeGraphEntities.id, shared.id));
    // Untouched: no single rewrite is right for both, so it is left for the
    // anchored re-extraction, which resolves per source.
    expect(after?.key).toBe(`date:${MARKER} friday`);
  });

  // An absolute label lands on the same key from either end of the window, so
  // sharing it across memories is harmless and it must still be canonicalized.
  it('still canonicalizes an absolute date shared by memories from different days', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [first] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Kit files on 2026-05-01.`,
        contentHash: `${MARKER}-abs-1`,
        embedding: unit(67),
        confidence: '0.90',
        createdAt: new Date('2026-03-04T12:00:00Z'),
      })
      .returning({ id: memories.id });
    const [second] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Lena reviews on 2026-05-01.`,
        contentHash: `${MARKER}-abs-2`,
        embedding: unit(68),
        confidence: '0.90',
        createdAt: new Date('2026-04-08T12:00:00Z'),
      })
      .returning({ id: memories.id });
    const [absolute] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `date:${MARKER} 1 may 2026`,
        label: '1 May 2026',
        kind: 'date',
      })
      .returning({ id: knowledgeGraphEntities.id });
    const [actor] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `person:${MARKER} kit`,
        label: `${MARKER} Kit`,
        kind: 'person',
      })
      .returning({ id: knowledgeGraphEntities.id });
    if (!first || !second || !absolute || !actor) throw new Error('fixtures were not created');

    for (const [index, source] of [first, second].entries()) {
      await db.insert(knowledgeGraphRelations).values({
        agentId,
        subjectEntityId: actor.id,
        predicate: 'acts_on',
        objectEntityId: absolute.id,
        sourceMemoryId: source.id,
        evidenceQuote: 'on 2026-05-01',
        sourceFingerprint: `${MARKER}-abs-fp-${index}`,
        ordinal: index + 1,
        confidence: '0.90',
      });
    }

    await backfillKnowledgeGraphDates(db, { agentId });

    const [after] = await db
      .select({ key: knowledgeGraphEntities.canonicalKey })
      .from(knowledgeGraphEntities)
      .where(eq(knowledgeGraphEntities.id, absolute.id));
    expect(after?.key).toBe('date:2026-05-01');
  });

  // The paid pass is only worth offering for sources the free one could not
  // fix, so a source that already carries a canonical date must not be counted.
  it('counts only the sources whose dates the free backfill could not fix', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const before = await countRelativeDateSources(db, agentId);

    const [stranded] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} Hana said she would call next week.`,
        contentHash: `${MARKER}-relative-1`,
        embedding: unit(64),
        confidence: '0.90',
      })
      .returning({ id: memories.id });
    if (!stranded) throw new Error('fixture memory was not created');
    // A ready checkpoint with no date entity behind it — exactly the shape the
    // anchored prompt exists to rescue.
    await db.insert(knowledgeGraphSources).values({
      memoryId: stranded.id,
      contentHash: `${MARKER}-relative-1`,
      extractionVersion: GRAPH_EXTRACTION_VERSION,
      status: 'ready',
    });

    expect(await countRelativeDateSources(db, agentId)).toBe(before + 1);
  });
});

describe('cross-agent graph safety (integration)', () => {
  let otherAgentId: string;
  const recordedSystems: string[] = [];

  /** A router stub that records the system prompt of every extraction call. */
  const recordingRouter = {
    async object(_: string, input: { prompt?: string; system?: string }) {
      recordedSystems.push(input.system ?? '');
      return {
        ok: true,
        object: {
          relationships: [
            {
              subject: { label: `${MARKER} timezone`, kind: 'topic' },
              predicate: 'probe',
              object: { label: 'probe', kind: 'topic' },
              evidenceQuote: `${MARKER} timezone probe`,
              confidence: 0.9,
            },
          ],
        },
      };
    },
  } as unknown as ModelRouter;

  beforeAll(async () => {
    if (!dbUp) return;
    const [other] = await db
      .insert(agents)
      .values({
        name: 'Other Agent',
        email: `${MARKER}-other@example.com`,
        workspacePrefix: `${MARKER}-other`,
        timezone: 'Pacific/Auckland',
        locale: 'is',
      })
      .returning({ id: agents.id });
    if (!other) throw new Error('other agent was not created');
    otherAgentId = other.id;
  });

  afterAll(async () => {
    if (!dbUp) return;
    await db.delete(memories).where(eq(memories.agentId, otherAgentId));
    await db.delete(agents).where(eq(agents.id, otherAgentId));
  });

  it('refuses to merge an entity owned by another agent', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const [mine, theirs] = await db
      .insert(knowledgeGraphEntities)
      .values([
        {
          agentId,
          canonicalKey: `topic:${MARKER} mine`,
          label: `${MARKER} Mine`,
          kind: 'topic',
        },
        {
          agentId: otherAgentId,
          canonicalKey: `topic:${MARKER} theirs`,
          label: `${MARKER} Theirs`,
          kind: 'topic',
        },
      ])
      .returning({ id: knowledgeGraphEntities.id });
    if (!mine || !theirs) throw new Error('cross-agent fixtures were not created');

    // Both directions must no-op: theirs as source, theirs as target.
    await mergeGraphEntities(db, agentId, theirs.id, mine.id);
    await mergeGraphEntities(db, agentId, mine.id, theirs.id);

    const rows = await db
      .select({ id: knowledgeGraphEntities.id })
      .from(knowledgeGraphEntities)
      .where(like(knowledgeGraphEntities.canonicalKey, `topic:${MARKER}%`));
    const ids = rows.map((row) => row.id);
    expect(ids).toContain(mine.id);
    expect(ids).toContain(theirs.id);
  });

  it('anchors each source in its own agent’s timezone and locale', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await db.insert(memories).values([
      {
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} timezone probe from the main agent.`,
        contentHash: `${MARKER}-tz-main`,
        embedding: unit(70),
        confidence: '0.90',
      },
      {
        agentId: otherAgentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} timezone probe from the other agent.`,
        contentHash: `${MARKER}-tz-other`,
        embedding: unit(71),
        confidence: '0.90',
      },
    ]);

    const [mainAgent] = await db
      .select({ timezone: agents.timezone })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    const mainZone = mainAgent?.timezone ?? 'UTC';

    recordedSystems.length = 0;
    // Unscoped: one sync run touches both agents.
    await syncKnowledgeGraph({ db, router: recordingRouter });

    // Each extraction must have been prompted in its owner's terms, not the
    // first agent the run happened to load.
    const mainCall = recordedSystems.find((system) => system.includes(`(${mainZone})`));
    const otherCall = recordedSystems.find((system) => system.includes('(Pacific/Auckland)'));
    expect(mainCall).toBeDefined();
    expect(otherCall).toBeDefined();
  });
});
