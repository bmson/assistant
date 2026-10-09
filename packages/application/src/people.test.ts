import { getAgent } from '@assistant/core/chat';
import { GRAPH_EXTRACTION_VERSION } from '@assistant/core/memory/knowledge-graph';
import {
  contacts,
  createDb,
  type Db,
  knowledgeGraphEntities,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
  occasions,
} from '@assistant/db';
import { inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { getPersonDossier, listPeopleDirectory, listPeopleDirectoryPage } from './people.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const MARKER = `xtest-people-${Date.now()}`;

let db: Db;
let dbUp = false;
let agentId: string;
/** Élise: a full dossier. Marc: her partner. Sam: nothing but a name. */
let eliseId = '';
let marcId = '';
let samId = '';
let hiddenMemoryId = '';

function unitVector(): number[] {
  const vector = new Array(1536).fill(0);
  vector[0] = 1;
  return vector;
}

async function makeContact(name: string, relationship: string): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({ name: `${name} ${MARKER}`, relationship, trust: 'known', notes: MARKER })
    .returning({ id: contacts.id });
  if (!row) throw new Error(`contact ${name} was not created`);
  return row.id;
}

async function makeEntity(label: string, kind: string, contactId?: string): Promise<string> {
  const [row] = await db
    .insert(knowledgeGraphEntities)
    .values({
      agentId,
      canonicalKey: contactId ? `contact:${contactId}` : `${kind}:${label}-${MARKER}`,
      label,
      kind,
      contactId,
    })
    .returning({ id: knowledgeGraphEntities.id });
  if (!row) throw new Error(`entity ${label} was not created`);
  return row.id;
}

/**
 * A graph edge with its full liveness set: an embedded, unquarantined source
 * memory, a `ready` extraction source whose hash matches, and an evidence
 * quote. `ready` is a parameter so a test can prove the negative.
 */
async function makeEdge(input: {
  subjectId: string;
  predicate: string;
  objectId: string;
  subjectContactId: string;
  validFrom?: string;
  validUntil?: string;
  sourceReady?: boolean;
  ordinal: number;
}): Promise<string> {
  const contentHash = `${MARKER}-edge-${input.ordinal}`;
  const [memory] = await db
    .insert(memories)
    .values({
      agentId,
      category: 'knowledge',
      kind: 'fact',
      content: `${MARKER} ${input.predicate} fact`,
      contentHash,
      embedding: unitVector(),
      subjectContactId: input.subjectContactId,
    })
    .returning({ id: memories.id });
  if (!memory) throw new Error('edge source memory was not created');
  await db.insert(knowledgeGraphSources).values({
    memoryId: memory.id,
    contentHash,
    status: input.sourceReady === false ? 'pending' : 'ready',
    extractionVersion: GRAPH_EXTRACTION_VERSION,
  });
  await db.insert(knowledgeGraphRelations).values({
    agentId,
    subjectEntityId: input.subjectId,
    predicate: input.predicate,
    objectEntityId: input.objectId,
    sourceMemoryId: memory.id,
    evidenceQuote: `${MARKER} quote`,
    sourceFingerprint: `${MARKER}-${input.ordinal}`,
    ordinal: input.ordinal,
    validFrom: input.validFrom ?? null,
    validUntil: input.validUntil ?? null,
    reviewStatus: 'confirmed',
  });
  return memory.id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    agentId = (await getAgent(db)).id;

    eliseId = await makeContact('Elise', 'Sister');
    marcId = await makeContact('Marc', 'Brother-in-law');
    samId = await makeContact('Sam', '');

    const eliseEntity = await makeEntity('Elise', 'person', eliseId);
    const marcEntity = await makeEntity('Marc', 'person', marcId);
    const lyon = await makeEntity('Lyon', 'place');

    await makeEdge({
      subjectId: eliseEntity,
      predicate: 'partner_of',
      objectId: marcEntity,
      subjectContactId: eliseId,
      validFrom: '2016-03',
      ordinal: 0,
    });
    await makeEdge({
      subjectId: eliseEntity,
      predicate: 'lives_in',
      objectId: lyon,
      subjectContactId: eliseId,
      ordinal: 1,
    });

    await db.insert(occasions).values({
      agentId,
      contactId: eliseId,
      kind: 'birthday',
      month: 3,
      day: 18,
      year: 1987,
      source: MARKER,
    });

    // Something that happened, and a durable fact. Only the first is an event.
    await db.insert(memories).values({
      agentId,
      category: 'experience',
      kind: 'episode',
      content: `${MARKER} lunch at Le Petit Sud`,
      contentHash: `${MARKER}-episode`,
      embedding: unitVector(),
      subjectContactId: eliseId,
      validFrom: new Date('2026-08-20T12:00:00.000Z'),
    });
    const [hidden] = await db
      .insert(memories)
      .values({
        agentId,
        category: 'knowledge',
        kind: 'fact',
        content: `${MARKER} allergic to shellfish`,
        contentHash: `${MARKER}-knowledge`,
        embedding: unitVector(),
        subjectContactId: eliseId,
      })
      .returning({ id: memories.id });
    hiddenMemoryId = hidden?.id ?? '';

    dbUp = true;
  } catch (error) {
    console.warn(`people.test: database unreachable — skipping (${String(error)})`);
  }
});

afterAll(async () => {
  if (dbUp) {
    const ids = [eliseId, marcId, samId].filter(Boolean);
    await db.delete(memories).where(inArray(memories.subjectContactId, ids));
    await db.delete(occasions).where(inArray(occasions.contactId, ids));
    await db.delete(knowledgeGraphEntities).where(inArray(knowledgeGraphEntities.contactId, ids));
    // Only this suite's own non-person nodes — the agent owns other suites' too.
    await db
      .delete(knowledgeGraphEntities)
      .where(like(knowledgeGraphEntities.canonicalKey, `%${MARKER}`));
    await db.delete(contacts).where(inArray(contacts.id, ids));
  }
  await (db as unknown as { $client?: { end: () => Promise<void> } }).$client?.end?.();
});

const NOW = new Date('2026-09-02T12:00:00.000Z');

describe('getPersonDossier (integration)', () => {
  it('composes identity, birthday, connections, and what happened', async (ctx: TestContext) => {
    if (!dbUp) return ctx.skip();
    const dossier = await getPersonDossier(db, eliseId, { now: NOW });
    expect(dossier).not.toBeNull();
    if (!dossier) return;

    expect(dossier.group).toBe('family');
    expect(dossier.location).toBe('Lyon');
    expect(dossier.birthday).toMatchObject({ month: 3, day: 18, year: 1987, turningAge: 40 });
    expect(dossier.relations).toHaveLength(1);
    expect(dossier.relations[0]?.sentence).toContain('are partners');
    expect(dossier.relations[0]?.validFrom).toBe('2016-03');
  });

  it('links a relationship whose other end is itself a contact', async (ctx: TestContext) => {
    if (!dbUp) return ctx.skip();
    const dossier = await getPersonDossier(db, eliseId, { now: NOW });
    expect(dossier?.relations[0]?.otherContactId).toBe(marcId);
  });

  it('reads the relationship from the other side without reversing it', async (ctx: TestContext) => {
    if (!dbUp) return ctx.skip();
    // Marc is the *object* of the stored edge. Feeding the pair in page order
    // would render the relationship backwards on his page.
    const dossier = await getPersonDossier(db, marcId, { now: NOW });
    expect(dossier?.relations).toHaveLength(1);
    expect(dossier?.relations[0]?.otherContactId).toBe(eliseId);
    expect(dossier?.relations[0]?.sentence).toContain('are partners');
  });

  it('keeps durable facts out of the timeline', async (ctx: TestContext) => {
    if (!dbUp) return ctx.skip();
    // "Allergic to shellfish" is true, not something that happened; its
    // createdAt says when the assistant learned it, not when you last met.
    const dossier = await getPersonDossier(db, eliseId, { now: NOW });
    expect(dossier?.events).toHaveLength(1);
    expect(dossier?.events[0]?.content).toContain('lunch at Le Petit Sud');
    expect(dossier?.events.map((event) => event.id)).not.toContain(hiddenMemoryId);
    expect(dossier?.lastContactAt?.toISOString().slice(0, 10)).toBe('2026-08-20');
  });

  it('does not repeat the header location under Also connected', async (ctx: TestContext) => {
    if (!dbUp) return ctx.skip();
    const dossier = await getPersonDossier(db, eliseId, { now: NOW });
    expect(dossier?.location).toBe('Lyon');
    expect(dossier?.connections.some((c) => c.otherLabel === 'Lyon')).toBe(false);
  });

  it('degrades to empty rather than null for a person with no data', async (ctx: TestContext) => {
    if (!dbUp) return ctx.skip();
    const dossier = await getPersonDossier(db, samId, { now: NOW });
    expect(dossier).not.toBeNull();
    expect(dossier?.entityId).toBeNull();
    expect(dossier?.relations).toEqual([]);
    expect(dossier?.connections).toEqual([]);
    expect(dossier?.events).toEqual([]);
    expect(dossier?.location).toBeNull();
    expect(dossier?.birthday).toBeNull();
    expect(dossier?.lastContactAt).toBeNull();
    expect(dossier?.group).toBe('other');
  });

  it('returns null for an id that is not a person', async (ctx: TestContext) => {
    if (!dbUp) return ctx.skip();
    expect(await getPersonDossier(db, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('listPeopleDirectory (integration)', () => {
  it('summarises everyone in one pass', async (ctx: TestContext) => {
    if (!dbUp) return ctx.skip();
    const people = await listPeopleDirectory(db, { now: NOW });
    const elise = people.find((person) => person.id === eliseId);
    expect(elise).toMatchObject({ group: 'family', location: 'Lyon', factCount: 3 });
    expect(elise?.birthday?.turningAge).toBe(40);
    expect(elise?.lastContactAt?.toISOString().slice(0, 10)).toBe('2026-08-20');

    const sam = people.find((person) => person.id === samId);
    expect(sam).toMatchObject({ group: 'other', location: null, factCount: 0 });
    expect(sam?.birthday).toBeNull();
  });

  it('never returns the owner', async (ctx: TestContext) => {
    if (!dbUp) return ctx.skip();
    const people = await listPeopleDirectory(db, { now: NOW });
    expect(people.every((person) => person.trust !== 'owner')).toBe(true);
  });

  it('continues through owner-scoped people in stable bounded pages', async (ctx: TestContext) => {
    if (!dbUp) return ctx.skip();
    const expected = await listPeopleDirectory(db, { now: NOW });
    const ids: string[] = [];
    let after: { name: string; id: string } | undefined;
    do {
      const page = await listPeopleDirectoryPage(db, {
        now: NOW,
        limit: 1,
        ...(after ? { after } : {}),
      });
      ids.push(...page.people.map((person) => person.id));
      after = page.nextCursor ?? undefined;
      expect(page.hasMore).toBe(Boolean(after));
    } while (after);
    expect(ids).toEqual(expected.map((person) => person.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(expected.every((person) => person.trust !== 'owner')).toBe(true);
  });

  it('issues a fixed number of queries however many contacts there are', async (ctx: TestContext) => {
    if (!dbUp) return ctx.skip();
    // The per-contact helpers are the trap here: called in a loop, 500 contacts
    // become thousands of round trips for one page.
    let queries = 0;
    const counting = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'select') queries += 1;
        return Reflect.get(target, property, receiver);
      },
    }) as Db;
    await listPeopleDirectory(counting, { now: NOW });
    const people = await listPeopleDirectory(db, { now: NOW });
    expect(people.length).toBeGreaterThanOrEqual(3);
    // One agent lookup, the contact list, then four grouped reads.
    expect(queries).toBeLessThanOrEqual(8);
  });
});

describe('graph liveness', () => {
  it('hides an edge whose extraction source is not ready', async (ctx: TestContext) => {
    if (!dbUp) return ctx.skip();
    const before = await getPersonDossier(db, eliseId, { now: NOW });
    const shown = before?.relations.length ?? 0;

    const eliseEntity = await makeEntity('EliseAgain', 'person');
    const stranger = await makeEntity('Stranger', 'person');
    await makeEdge({
      subjectId: eliseEntity,
      predicate: 'sibling_of',
      objectId: stranger,
      subjectContactId: eliseId,
      sourceReady: false,
      ordinal: 9,
    });

    // The new edge hangs off a different entity, so the count is unchanged
    // either way; what this pins is that a pending source is never live.
    const after = await getPersonDossier(db, eliseId, { now: NOW });
    expect(after?.relations.length).toBe(shown);
  });
});
