import {
  contacts,
  createDb,
  type Db,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
  suggestions,
} from '@assistant/db';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgent } from '../chat.js';
import {
  EXPECTED,
  findGraphGaps,
  markGapAsked,
  nextUnaskedGap,
  SATISFIED_BY,
} from './graph-gaps.js';
import { GRAPH_EXTRACTION_VERSION } from './knowledge-graph.js';
import { predicateSpec } from './predicate-vocabulary.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://assistant@localhost:5432/assistant';
const MARKER = `xtest-gaps-${Date.now()}`;

let db: Db;
let dbUp = false;
let agentId: string;
let memoryId: string;
const entityIds: string[] = [];

/** An entity plus `count` outgoing relations, so it clears the "cared about" bar. */
async function addEntity(
  label: string,
  kind: string,
  predicates: string[],
  opts: {
    contactId?: string;
    confidence?: string;
    reviewStatus?: string;
    /** Stated end of validity, per predicate, as the graph stores it: text. */
    validUntil?: Record<string, string>;
  } = {},
) {
  const [entity] = await db
    .insert(knowledgeGraphEntities)
    .values({
      agentId,
      canonicalKey: `${kind}:${MARKER}-${label}`,
      label: `${MARKER} ${label}`,
      kind,
      ...(opts.contactId ? { contactId: opts.contactId } : {}),
    })
    .returning({ id: knowledgeGraphEntities.id });
  const id = (entity as NonNullable<typeof entity>).id;
  entityIds.push(id);

  // Objects for the edges to point at; their own degree stays 0 so they never
  // become candidates themselves.
  for (const [index, predicate] of predicates.entries()) {
    const [object] = await db
      .insert(knowledgeGraphEntities)
      .values({
        agentId,
        canonicalKey: `topic:${MARKER}-${label}-${index}`,
        label: `${MARKER} object ${label} ${index}`,
        kind: 'topic',
      })
      .returning({ id: knowledgeGraphEntities.id });
    const objectId = (object as NonNullable<typeof object>).id;
    entityIds.push(objectId);
    await db.insert(knowledgeGraphRelations).values({
      agentId,
      subjectEntityId: id,
      predicate,
      // This fixture describes an explicitly asserted, usable source fact.
      // The schema defaults omitted assertion qualifiers to `unverified`,
      // which the production recall and curiosity guards correctly exclude.
      assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
      objectEntityId: objectId,
      sourceMemoryId: memoryId,
      sourceFingerprint: `${MARKER}-${label}-${predicate}-${index}`,
      ordinal: index,
      confidence: opts.confidence ?? '0.9',
      reviewStatus: opts.reviewStatus ?? 'unreviewed',
      ...(opts.validUntil?.[predicate] ? { validUntil: opts.validUntil[predicate] } : {}),
      evidenceQuote: `${MARKER} source`,
    });
  }
  return id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;
    dbUp = true;
  } catch {
    console.warn('graph-gaps.test: database unreachable — skipping');
    return;
  }
  const [memory] = await db
    .insert(memories)
    .values({
      agentId,
      category: 'knowledge',
      kind: 'fact',
      content: `${MARKER} source`,
      contentHash: MARKER,
      embedding: Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)),
    })
    .returning({ id: memories.id });
  memoryId = (memory as NonNullable<typeof memory>).id;
  await db.insert(knowledgeGraphSources).values({
    memoryId,
    contentHash: MARKER,
    status: 'ready',
    extractionVersion: GRAPH_EXTRACTION_VERSION,
  });
});

afterAll(async () => {
  if (!dbUp || !memoryId) return;
  await db.delete(suggestions).where(like(suggestions.sourceRef, 'gap:%'));
  if (entityIds.length) {
    await db
      .delete(knowledgeGraphRelations)
      .where(inArray(knowledgeGraphRelations.subjectEntityId, entityIds));
    await db.delete(knowledgeGraphEntities).where(inArray(knowledgeGraphEntities.id, entityIds));
  }
  await db.delete(memories).where(eq(memories.id, memoryId));
  await db.delete(contacts).where(like(contacts.name, `${MARKER}%`));
});

describe('findGraphGaps', () => {
  it('ignores an entity the graph barely mentions', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // One relation only: below the "cared about" bar, so no question about it.
    const id = await addEntity('Peripheral', 'person', ['met']);
    const gaps = await findGraphGaps(db, agentId);
    expect(gaps.some((gap) => gap.key.includes(id))).toBe(false);
  });

  it('asks where a well-connected person lives and works', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const id = await addEntity('Anna', 'person', ['sibling_of', 'met', 'likes']);
    const gaps = await findGraphGaps(db, agentId);
    const mine = gaps.filter((gap) => gap.key.includes(id));
    expect(mine.map((gap) => gap.kind)).toContain('missing-predicate');
    const questions = mine.map((gap) => gap.question).join(' ');
    expect(questions).toContain('where');
    expect(questions).toContain(`${MARKER} Anna`);
  });

  it('does not ask about something a present-tense predicate already covers', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const id = await addEntity('Bjorn', 'person', ['lives_in', 'works_at', 'met']);
    const gaps = await findGraphGaps(db, agentId);
    const asked = gaps.filter((gap) => gap.key.includes(id) && gap.kind === 'missing-predicate');
    expect(asked).toHaveLength(0);
  });

  it('still asks where someone lives when all it knows is where they were born', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // This used to be suppressed: `born_in` counted as knowing `lives_in`. It
    // does not — someone born in Reykjavik may live anywhere — and the case
    // where the assistant has only a birthplace is exactly the one worth
    // asking about. Over-asking is bounded in proactive/curiosity.ts (one
    // question per run, once a day, never re-asked), not by pretending the
    // question is already answered.
    const id = await addEntity('Bjorn Born', 'person', ['born_in', 'works_at', 'met']);
    const gaps = await findGraphGaps(db, agentId);
    const asked = gaps.filter((gap) => gap.key.includes(id) && gap.kind === 'missing-predicate');
    expect(asked.map((gap) => gap.question).join(' ')).toContain('where');
    expect(asked).toHaveLength(1);
  });

  it('still asks where someone works when the job it knows about has ended', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // The same mistake recorded in the validity columns instead of the
    // predicate name: a `works_at` edge the owner dated to a period that has
    // already closed cannot answer what they do now.
    const id = await addEntity('Bjorn Former', 'person', ['works_at', 'lives_in', 'met'], {
      validUntil: { works_at: '2023' },
    });
    const gaps = await findGraphGaps(db, agentId);
    const asked = gaps.filter((gap) => gap.key.includes(id) && gap.kind === 'missing-predicate');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.question).toContain('works');
  });

  it('keeps a job whose stated period has not closed yet', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const id = await addEntity('Bjorn Current', 'person', ['works_at', 'lives_in', 'met'], {
      validUntil: { works_at: '2099' },
    });
    const gaps = await findGraphGaps(db, agentId);
    const asked = gaps.filter((gap) => gap.key.includes(id) && gap.kind === 'missing-predicate');
    expect(asked).toHaveLength(0);
  });

  it('counts a legacy synonym as knowing where someone works', async (ctx) => {
    if (!dbUp) return ctx.skip();
    // Rows written before canonicalization carry the source's own phrasing.
    // Matching the registry id alone would ask a question already answered.
    const id = await addEntity('Bjorn Legacy', 'person', ['employed_by', 'lives_in', 'met']);
    const gaps = await findGraphGaps(db, agentId);
    const asked = gaps.filter((gap) => gap.key.includes(id) && gap.kind === 'missing-predicate');
    expect(asked).toHaveLength(0);
  });

  it('offers to keep contact details for a person it only has notes about', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const id = await addEntity('Unlinked', 'person', ['met', 'likes', 'sibling_of']);
    const gaps = await findGraphGaps(db, agentId);
    expect(gaps.some((gap) => gap.kind === 'unlinked-person' && gap.key.includes(id))).toBe(true);
  });

  it('offers to confirm a relation extraction hedged on', async (ctx) => {
    if (!dbUp) return ctx.skip();
    await addEntity('Unsure', 'person', ['works_at', 'lives_in', 'met'], {
      confidence: '0.3',
      reviewStatus: 'unreviewed',
    });
    const gaps = await findGraphGaps(db, agentId);
    expect(gaps.some((gap) => gap.kind === 'unreviewed-relation')).toBe(true);
    const question = gaps.find((gap) => gap.kind === 'unreviewed-relation')?.question;
    expect(question).toContain('object');
    expect(question).not.toContain('something');
  });

  it('does not build questions on rejected connections', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const id = await addEntity('Rejected', 'person', ['met', 'likes', 'works_at'], {
      reviewStatus: 'rejected',
    });
    expect((await findGraphGaps(db, agentId)).some((gap) => gap.key.includes(id))).toBe(false);
  });

  it('does not build questions on quarantined or outdated sources', async (ctx) => {
    if (!dbUp) return ctx.skip();
    try {
      await db.update(memories).set({ quarantined: true }).where(eq(memories.id, memoryId));
      expect((await findGraphGaps(db, agentId)).some((gap) => gap.question.includes(MARKER))).toBe(
        false,
      );
      await db.update(memories).set({ quarantined: false }).where(eq(memories.id, memoryId));
      await db
        .update(knowledgeGraphSources)
        .set({ contentHash: 'outdated' })
        .where(eq(knowledgeGraphSources.memoryId, memoryId));
      expect((await findGraphGaps(db, agentId)).some((gap) => gap.question.includes(MARKER))).toBe(
        false,
      );
    } finally {
      await db.update(memories).set({ quarantined: false }).where(eq(memories.id, memoryId));
      await db
        .update(knowledgeGraphSources)
        .set({ contentHash: MARKER })
        .where(eq(knowledgeGraphSources.memoryId, memoryId));
    }
  });

  it('ranks the best-connected gaps first', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const gaps = await findGraphGaps(db, agentId);
    const priorities = gaps.map((gap) => gap.priority);
    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities);
  });
});

describe('nextUnaskedGap', () => {
  it('never asks the same question twice, however long it goes unanswered', async (ctx) => {
    if (!dbUp) return ctx.skip();
    const gaps = await findGraphGaps(db, agentId);
    const first = await nextUnaskedGap(db, agentId, gaps);
    expect(first).not.toBeNull();

    expect(await markGapAsked(db, agentId, first as NonNullable<typeof first>)).toBe(true);
    // A second instance racing for the same gap loses the unique index.
    expect(await markGapAsked(db, agentId, first as NonNullable<typeof first>)).toBe(false);

    const second = await nextUnaskedGap(db, agentId, gaps);
    expect(second?.key).not.toBe(first?.key);
  });

  it('returns nothing when there is nothing to ask', async (ctx) => {
    if (!dbUp) return ctx.skip();
    expect(await nextUnaskedGap(db, agentId, [])).toBeNull();
  });
});

/**
 * The gap detector is a fourth consumer of the predicate registry, and it had
 * drifted from it: it expected `based_in` while the registry did not define
 * it, so extraction was never told to produce the predicate and the
 * add-relationship form never suggested it — the assistant could ask where an
 * organization is based and then had no vocabulary to record the answer in.
 * The registry's own header calls itself the source of truth for its
 * consumers; this holds the detector to that.
 */
describe('registry covers what the detector expects', () => {
  it('defines every predicate an expectation names', () => {
    for (const expectations of Object.values(EXPECTED)) {
      for (const expectation of expectations ?? []) {
        expect(predicateSpec(expectation.predicate), expectation.predicate).toBeDefined();
      }
    }
  });

  it('defines every predicate that can satisfy an expectation', () => {
    for (const members of Object.values(SATISFIED_BY)) {
      for (const member of members) {
        expect(predicateSpec(member), member).toBeDefined();
      }
    }
  });
});
